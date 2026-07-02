// NETWORK EGRESS GOVERNOR + SANDBOXED POLICY ISOLATES (docs/networks.md)
//
// "The network is a JS function." Every byte a NETWORKED machine's children (and, by outbound-
// channel inheritance, their native-spawned grandchildren) send arrives here:
//
//   child fetch → globalOutbound = the machine's own DO → DO stamps x-iso-net-from → SELF →
//   control-plane fetch → governEgress()
//
// governEgress resolves member names (the docker-parity floor) and, when the network has a
// policy module, delivers the request INTO a per-network POLICY ISOLATE — user JS running
// sandboxed on the platform (same posture as volume drivers: no fs, no spawn, no machine VFS,
// no LOADER). The policy's ONE capability is egress — and even that is pointed back at the
// control plane (globalOutbound = SELF) through a fetch-shadow that tags every request with the
// network token, so policy traffic is observable (`iso network logs`), the iso engine API is
// fenced off, and ctx.route/ctx.state are real capabilities rather than ambient authority.
//
// Non-networked machines never enter this file: their children have no globalOutbound override
// and keep direct egress (today's behavior, byte for byte).

// ---- small env-bound helpers (kept local: this module must not import control-plane.mjs) ----
function regStub(env) { return env.REGISTRY.get(env.REGISTRY.idFromName("singleton")); }
async function regGet(env, id) {
  try { return await regStub(env).fetch("http://reg/get?id=" + encodeURIComponent(id)).then((r) => r.json()); } catch { return null; }
}
async function regList(env) {
  try { return await regStub(env).fetch("http://reg/list").then((r) => r.json()); } catch { return []; }
}
function machineStub(env, id) { return env.MACHINE.get(env.MACHINE.idFromName(id)); }
async function hostJson(env, pathAndQuery, body) {
  const r = await env.HOST.fetch("http://host" + pathAndQuery, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return r.json().catch(() => ({}));
}

export const NET_MAGIC_HOST = "iso-net.internal";
const LIVE = new Set(["created", "running", "serving"]);

export async function netLog(env, name, entry) {
  try { await hostJson(env, "/network-log", { name, entry }); } catch {}
}

// members of a network: live machines whose registry record carries rec.network === name.
async function memberMap(env, netName) {
  const out = {};
  for (const m of await regList(env)) {
    if (m.network === netName && m.name && LIVE.has(m.status)) out[m.name] = { id: m.id, status: m.status };
  }
  return out;
}

// deliver a request INTO a member machine's serving child at `port` — the existing
// /port-proxy chain (DO → x-iso-port → serving child's fetch → handleAsNodeRequest →
// the member's unmodified node:http server). No DNS, no NAT: Host-header routing.
function deliverToMember(env, memberId, port, request) {
  const url = new URL(request.url);
  return machineStub(env, memberId).fetch(new Request(
    "http://m/port-proxy?port=" + encodeURIComponent(port) + "&p=" + encodeURIComponent(url.pathname + url.search),
    request));
}

function stripIsoHeaders(request) {
  const h = new Headers(request.headers);
  for (const k of ["x-iso-net-from", "x-iso-net-name", "x-iso-net-ctx", "x-iso-pol", "x-iso-route"]) h.delete(k);
  return new Request(request, { headers: h });
}

function engineHostPort(env) {
  try {
    const u = new URL(env.ISO_HOST_INFO.endpoint);
    return { host: u.hostname, port: u.port || "80" };
  } catch { return null; }
}
function isEngineTarget(env, url) {
  const engine = engineHostPort(env);
  if (!engine) return false;
  const localHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]", engine.host]);
  return localHosts.has(url.hostname) && (url.port || (url.protocol === "https:" ? "443" : "80")) === engine.port;
}

// ---- the per-network POLICY ISOLATE ---------------------------------------------------------
const POLICY_FLAGS = ["nodejs_compat", "nodejs_compat_v2", "experimental"];
const POLICY_COMPAT_DATE = "2026-06-01";
const policySources = new Map(); // "name:createdAt" → source (the isolate itself is cached by LOADER key)

// The harness shadows global fetch BEFORE dynamically importing the user's policy module, so
// every egress the policy performs (including top-level captures of `fetch`) carries the
// network tag — that is what makes policy traffic observable and engine-fenced. ctx.route and
// ctx.state ride the same tagged channel; they are capabilities handed to proxy(), not globals.
function policyHarnessSrc() {
  return `
import { WorkerEntrypoint } from "cloudflare:workers";
let USER = null;
export default class extends WorkerEntrypoint {
  async fetch(request) {
    const env = this.env;
    if (!globalThis.__isoRawFetch) {
      const raw = globalThis.fetch.bind(globalThis);
      globalThis.__isoRawFetch = raw;
      globalThis.fetch = (input, init) => {
        const req = new Request(input, init);
        const h = new Headers(req.headers);
        h.set("x-iso-pol", env.NET + ":" + env.TOKEN);
        return raw(new Request(req, { headers: h }));
      };
    }
    if (!USER) USER = await import("./user.js");
    const impl = USER.default || USER;
    const meta = JSON.parse(request.headers.get("x-iso-net-ctx") || "{}");
    const ctx = {
      from: meta.from, to: meta.to, net: meta.net,
      route: (name, req) => {
        const r = new Request(req);
        const h = new Headers(r.headers);
        h.set("x-iso-pol", env.NET + ":" + env.TOKEN);
        h.set("x-iso-route", name);
        return globalThis.__isoRawFetch(new Request(r, { headers: h }));
      },
      // experimental: tiny per-network KV for stateful policies (rate limits, counters)
      state: {
        get: async (k) => (await (await globalThis.fetch("http://iso-net.internal/state?op=get&k=" + encodeURIComponent(k))).json()).value,
        set: async (k, v) => { await globalThis.fetch("http://iso-net.internal/state?op=set&k=" + encodeURIComponent(k), { method: "POST", body: JSON.stringify(v === undefined ? null : v) }); },
      },
    };
    const h = new Headers(request.headers);
    h.delete("x-iso-net-ctx"); h.delete("x-iso-net-from"); h.delete("x-iso-net-name");
    const clean = new Request(request, { headers: h });
    try {
      if (!impl || typeof impl.proxy !== "function") return new Response("network policy module does not export { proxy }", { status: 502 });
      const resp = await impl.proxy(clean, ctx);
      return (resp && typeof resp.status === "number") ? resp : new Response("policy returned a non-Response", { status: 502 });
    } catch (e) {
      return new Response("policy error: " + String((e && e.stack) || e), { status: 502 });
    }
  }
}`;
}

async function policyIsolate(env, net) {
  const key = "net-policy:" + net.name + ":" + net.createdAt;
  if (!policySources.has(key)) {
    const r = await hostJson(env, "/network-policy?name=" + encodeURIComponent(net.name));
    policySources.set(key, r.source || "export default {}");
  }
  const source = policySources.get(key);
  // cached per (name, createdAt): LOADER.get reuses the live isolate under the same key —
  // the module is NOT reloaded per request. Reload semantics v1 (per the design doc):
  // `iso network rm` + recreate → fresh createdAt → fresh key → fresh isolate.
  return env.LOADER.get(key, () => ({
    compatibilityDate: POLICY_COMPAT_DATE, compatibilityFlags: POLICY_FLAGS, allowExperimental: true,
    // SANDBOX (the user-module-isolate posture): no shareParentTmp, no fs flag, no
    // vfsModuleFallback, no allowSpawn, no LOADER. Egress is the one capability — and it is
    // pointed back at the control plane so it is tagged, logged, and engine-API-fenced.
    globalOutbound: env.SELF,
    env: { NET: net.name, TOKEN: net.token },
    mainModule: "main.js",
    modules: { "main.js": policyHarnessSrc(), "user.js": source },
  }));
}

// ---- machine egress (x-iso-net-from) --------------------------------------------------------
export async function governEgress(env, fromId, request) {
  const rec = await regGet(env, fromId);
  const netName = rec && rec.network;
  const clean = stripIsoHeaders(request); // NEVER let identity headers escape (or loop back)
  if (!netName) return fetch(clean); // shouldn't happen: only networked machines stamp egress
  const net = await hostJson(env, "/network-inspect?name=" + encodeURIComponent(netName));
  if (net.error) return new Response("network gone: " + netName, { status: 502 });
  const url = new URL(request.url);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const from = { machine: fromId, name: rec.name || "" };
  const to = { host: url.hostname, port: Number(port) };
  const logFrom = from.name || fromId.slice(0, 12);

  if (net.hasPolicy) {
    // ALL egress transits the policy (resolved decision #1) — member routing included.
    const stub = await policyIsolate(env, net);
    const h = new Headers(clean.headers);
    h.set("x-iso-net-ctx", JSON.stringify({ from, to, net: netName }));
    let resp;
    try { resp = await stub.getEntrypoint().fetch(new Request(clean, { headers: h })); }
    catch (e) { resp = new Response("policy isolate error: " + String(e?.message || e), { status: 502 }); }
    await netLog(env, netName, { ts: Date.now(), from: logFrom, method: request.method, url: request.url, outcome: "policy", status: resp.status });
    return resp;
  }

  // default (docker-parity floor): resolve member names; everything else is allowed egress.
  const members = await memberMap(env, netName);
  const member = members[to.host];
  if (member) {
    const resp = await deliverToMember(env, member.id, port, clean);
    await netLog(env, netName, { ts: Date.now(), from: logFrom, method: request.method, url: request.url, outcome: "route:" + to.host, status: resp.status });
    return resp;
  }
  let resp;
  try { resp = await fetch(clean); }
  catch (e) { resp = new Response("egress failed: " + String(e?.message || e), { status: 502 }); }
  await netLog(env, netName, { ts: Date.now(), from: logFrom, method: request.method, url: request.url, outcome: "egress", status: resp.status });
  return resp;
}

// ---- policy-originated traffic (x-iso-pol tag) ----------------------------------------------
export async function handlePolicyTagged(env, request) {
  const tag = request.headers.get("x-iso-pol") || "";
  const i = tag.indexOf(":");
  const netName = tag.slice(0, i), token = tag.slice(i + 1);
  const net = netName ? await hostJson(env, "/network-inspect?name=" + encodeURIComponent(netName)) : { error: true };
  if (net.error || !token || net.token !== token) return new Response("invalid network policy tag", { status: 403 });
  const url = new URL(request.url);
  const routeName = request.headers.get("x-iso-route");

  // ctx.route — deliver into a member of THIS network (the capability is scoped by the token).
  if (routeName) {
    const members = await memberMap(env, netName);
    const m = members[routeName];
    if (!m) {
      await netLog(env, netName, { ts: Date.now(), from: "policy", method: request.method, url: request.url, outcome: "route:" + routeName + " (no such member)", status: 502 });
      return new Response('no member "' + routeName + '" on network ' + netName, { status: 502 });
    }
    const port = url.port || "80";
    const resp = await deliverToMember(env, m.id, port, stripIsoHeaders(request));
    await netLog(env, netName, { ts: Date.now(), from: "policy", method: request.method, url: request.url, outcome: "route:" + routeName, status: resp.status });
    return resp;
  }

  // ctx.state — the experimental per-network KV (host-store-backed; never direct fs).
  if (url.hostname === NET_MAGIC_HOST) {
    if (url.pathname === "/state") {
      const op = url.searchParams.get("op"), key = url.searchParams.get("k");
      const value = op === "set" ? JSON.parse((await request.text()) || "null") : undefined;
      const out = await hostJson(env, "/network-state", { name: netName, op, key, value });
      return Response.json(out);
    }
    return new Response("unknown iso-net op", { status: 404 });
  }

  // ENGINE-API FENCE: the policy's egress capability must not reach the iso engine itself.
  if (isEngineTarget(env, url)) {
    await netLog(env, netName, { ts: Date.now(), from: "policy", method: request.method, url: request.url, outcome: "ESCAPE-BLOCKED (engine API)", status: 403 });
    return new Response("network policy may not call the iso engine API", { status: 403 });
  }

  // plain policy egress (an allow / rewrite): perform it, log it.
  let resp;
  try { resp = await fetch(stripIsoHeaders(request)); }
  catch (e) { resp = new Response("egress failed: " + String(e?.message || e), { status: 502 }); }
  await netLog(env, netName, { ts: Date.now(), from: "policy", method: request.method, url: request.url, outcome: "egress", status: resp.status });
  return resp;
}
