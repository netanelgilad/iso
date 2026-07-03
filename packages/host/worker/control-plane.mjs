// iso CONTROL PLANE WORKER — the daemon's front door (the "iso Engine API", v0).
// The iso CLI is a thin client; ALL state and execution live behind this Worker.
//
// Routes (subset of docs/design.md §"iso Engine API"):
//   POST   /v0/machines           {image, cmd, args, env} → run: boot a Machine DO, run cmd, register
//   GET    /v0/machines           ps: list machines from the registry
//   POST   /v0/machines/{id}/exec {cmd, args, env}        → run another cmd in the SAME machine
//   DELETE /v0/machines/{id}      rm: drop the machine from the registry (DO storage is ephemeral here)
//   WS     /v0/machines/{id}/logs?follow=1  → proxy to Machine DO LogStream (replay + live)
//
// The machine registry is a singleton Registry DO (id → {image, status, createdAt, lastCmd}).
// A machine id maps 1:1 to a Machine DO name (idFromName), so the control plane can re-address a
// machine on exec/rm without storing the DO stub. Auth: optional bearer token (per-context).
import { Buffer } from "node:buffer";
import { Machine, CHILD_COMPAT_DATE } from "./machine-do.mjs";
import { invokeUserModule } from "./user-module-isolate.mjs";
import { governEgress, handlePolicyTagged } from "./network-egress.mjs";

export { Machine };

function newId() {
  // docker-style 64-hex machine id; the CLI displays the first 12 chars, any unique prefix resolves.
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// docker-style auto-names (adjective_noun). Kept short; collisions re-roll against the registry.
const NAME_ADJ = ["admiring", "adoring", "agitated", "amazing", "angry", "awesome", "blissful", "bold",
  "brave", "busy", "charming", "clever", "cool", "compassionate", "competent", "confident", "dazzling",
  "determined", "distracted", "dreamy", "eager", "ecstatic", "elastic", "elated", "elegant", "epic",
  "exciting", "festive", "flamboyant", "focused", "friendly", "frosty", "funny", "gallant", "gifted",
  "goofy", "gracious", "great", "happy", "hopeful", "hungry", "infallible", "inspiring", "intelligent",
  "jolly", "jovial", "keen", "kind", "laughing", "loving", "lucid", "magical", "mystifying", "modest",
  "musing", "naughty", "nervous", "nice", "nifty", "nostalgic", "objective", "optimistic", "peaceful",
  "pedantic", "pensive", "practical", "priceless", "quirky", "quizzical", "recursing", "relaxed",
  "reverent", "romantic", "sad", "serene", "sharp", "silly", "sleepy", "stoic", "strange", "sweet",
  "tender", "thirsty", "trusting", "unruffled", "upbeat", "vibrant", "vigilant", "vigorous", "wizardly",
  "wonderful", "xenodochial", "youthful", "zealous", "zen"];
const NAME_NOUN = ["albattani", "allen", "almeida", "antonelli", "agnesi", "archimedes", "ardinghelli",
  "aryabhata", "austin", "babbage", "banach", "banzai", "bardeen", "bartik", "bassi", "beaver", "bell",
  "benz", "bhabha", "bhaskara", "black", "blackburn", "blackwell", "bohr", "booth", "borg", "bose",
  "bouman", "boyd", "brahmagupta", "brattain", "brown", "buck", "burnell", "cannon", "carson", "cartwright",
  "carver", "cerf", "chandrasekhar", "chaplygin", "chatelet", "chatterjee", "chebyshev", "cohen", "chaum",
  "clarke", "colden", "cori", "cray", "curie", "darwin", "davinci", "dewdney", "dhawan", "diffie",
  "dijkstra", "dirac", "driscoll", "dubinsky", "easley", "edison", "einstein", "elbakyan", "elgamal",
  "elion", "ellis", "engelbart", "euclid", "euler", "faraday", "feistel", "fermat", "fermi", "feynman",
  "franklin", "gagarin", "galileo", "galois", "ganguly", "gates", "gauss", "germain", "goldberg",
  "goldstine", "goldwasser", "golick", "goodall", "gould", "greider", "grothendieck", "haibt", "hamilton",
  "haslett", "hawking", "hellman", "heisenberg", "hermann", "herschel", "hertz", "heyrovsky", "hodgkin",
  "hofstadter", "hoover", "hopper", "hugle", "hypatia", "ishizaka", "jackson", "jang", "jemison",
  "jennings", "jepsen", "johnson", "joliot", "jones", "kalam", "kapitsa", "kare", "keldysh", "keller",
  "kepler", "khayyam", "khorana", "kilby", "kirch", "knuth", "kowalevski", "lalande", "lamarr",
  "lamport", "leakey", "leavitt", "lederberg", "lehmann", "lewin", "lichterman", "liskov", "lovelace",
  "lumiere", "mahavira", "margulis", "matsumoto", "maxwell", "mayer", "mccarthy", "mcclintock", "mclaren",
  "mclean", "mcnulty", "mendel", "mendeleev", "meitner", "meninsky", "merkle", "mestorf", "mirzakhani",
  "montalcini", "moore", "morse", "murdock", "moser", "napier", "nash", "neumann", "newton", "nightingale",
  "nobel", "noether", "northcutt", "noyce", "panini", "pare", "pascal", "pasteur", "payne", "perlman",
  "pike", "poincare", "poitras", "proskuriakova", "ptolemy", "raman", "ramanujan", "ride", "ritchie",
  "rhodes", "robinson", "roentgen", "rosalind", "rubin", "saha", "sammet", "sanderson", "satoshi",
  "shamir", "shannon", "shaw", "shirley", "shockley", "shtern", "sinoussi", "snyder", "solomon",
  "spence", "stonebraker", "sutherland", "swanson", "swartz", "swirles", "taussig", "tereshkova",
  "tesla", "tharp", "thompson", "torvalds", "tu", "turing", "varahamihira", "vaughan", "villani",
  "visvesvaraya", "volhard", "wescoff", "wilbur", "wiles", "williams", "williamson", "wilson", "wing",
  "wozniak", "wright", "wu", "yalow", "yonath", "zhukovsky"];
function genName(taken) {
  for (let i = 0; i < 100; i++) {
    const n = NAME_ADJ[Math.floor(Math.random() * NAME_ADJ.length)] + "_" +
      NAME_NOUN[Math.floor(Math.random() * NAME_NOUN.length)];
    if (!taken.has(n)) return n;
  }
  return "machine_" + Date.now().toString(36);
}

// ---- Registry DO: the `ps` table. Singleton, in-DO-memory + storage for durability. ----
export class Registry {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    const url = new URL(request.url);
    const machines = (await this.state.storage.get("machines")) || {};
    if (url.pathname === "/list") return Response.json(Object.values(machines));
    if (url.pathname === "/get") {
      const id = url.searchParams.get("id");
      return Response.json(machines[id] || null);
    }
    // /resolve?ref= — docker-style addressing: exact id, then exact name, then unique id PREFIX.
    // 200 {…rec}, 404 {error}, 409 {error, matches:[{id,name}]} on an ambiguous prefix.
    if (url.pathname === "/resolve") {
      const ref = url.searchParams.get("ref") || "";
      if (machines[ref]) return Response.json(machines[ref]);
      const byName = Object.values(machines).find((m) => m.name === ref);
      if (byName) return Response.json(byName);
      const pref = ref ? Object.values(machines).filter((m) => m.id.startsWith(ref)) : [];
      if (pref.length === 1) return Response.json(pref[0]);
      if (pref.length > 1) {
        return Response.json({
          error: "Multiple machines found with provided prefix: " + ref,
          matches: pref.map((m) => ({ id: m.id, name: m.name })),
        }, { status: 409 });
      }
      return Response.json({ error: "No such machine: " + ref }, { status: 404 });
    }
    if (url.pathname === "/put") {
      const rec = await request.json();
      machines[rec.id] = rec;
      await this.state.storage.put("machines", machines);
      return Response.json(rec);
    }
    if (url.pathname === "/patch") {
      const { id, ...patch } = await request.json();
      if (!machines[id]) return new Response("no such machine", { status: 404 });
      // docker-style lifecycle timestamps for `ps` ("Up 2 minutes" / "Exited (0) 3 minutes ago"):
      // maintained here so the Machine DO's setStatus callers need no changes.
      if (patch.status === "running" || patch.status === "serving") {
        if (patch.startedAt === undefined) patch.startedAt = new Date().toISOString();
        if (patch.exitedAt === undefined) patch.exitedAt = null;
      }
      if (patch.status === "exited" && patch.exitedAt === undefined) patch.exitedAt = new Date().toISOString();
      machines[id] = { ...machines[id], ...patch };
      await this.state.storage.put("machines", machines);
      return Response.json(machines[id]);
    }
    if (url.pathname === "/delete") {
      const id = url.searchParams.get("id");
      const had = !!machines[id];
      delete machines[id];
      await this.state.storage.put("machines", machines);
      return Response.json({ deleted: had });
    }
    return new Response("registry ops", { status: 404 });
  }
}

function registry(env) { return env.REGISTRY.get(env.REGISTRY.idFromName("singleton")); }
function machineStub(env, id) { return env.MACHINE.get(env.MACHINE.idFromName(id)); }

async function reg(env, path, init) {
  return registry(env).fetch(new Request("http://reg" + path, init));
}

// ---- volumes (docs/volumes.md) --------------------------------------------------------
// mount-path validation: absolute, and NOT under the trees the image snapshot excludes (a
// mount hidden under /tmp or /root would silently vanish from commits) nor over the rootfs.
const FORBIDDEN_MOUNT_PREFIXES = ["/tmp", "/root", "/usr", "/bundle", "/dev", "/proc", "/etc"];
function validMountPath(p) {
  if (!p || !p.startsWith("/") || p === "/") return false;
  return !FORBIDDEN_MOUNT_PREFIXES.some((f) => p === f || p.startsWith(f + "/"));
}
async function hostVol(env, route, body) {
  const r = await env.HOST.fetch("http://host" + route, body === undefined ? undefined : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, json: await r.json().catch(() => ({})) };
}
// checkpoint a volume FROM its attached machine's live tree (the /snapshot walk scoped to the
// mount path). Returns {digest} or {skipped} when the machine's fs is gone (eviction — the
// previous checkpoint stands; crash-lossy is the documented v1 semantic).
async function checkpointVolume(env, vol, machineId, mountPath, kind) {
  const snap = await machineStub(env, machineId).fetch(new Request("http://m/snapshot?scope=" + encodeURIComponent(mountPath)));
  if (!snap.ok) return { skipped: true, reason: (await snap.json().catch(() => ({}))).error || ("HTTP " + snap.status) };
  const artifact = await snap.text();
  const q = new URLSearchParams({ name: vol.name, kind });
  const r = await env.HOST.fetch("http://host/volume-checkpoint?" + q, { method: "POST", body: artifact });
  const res = await r.json().catch(() => ({}));
  if (!r.ok) return { skipped: true, reason: res.error };
  // user-driver volumes: push the checkpoint into the driver (tarIn), SANDBOXED.
  if (vol.driver === "user") {
    const src = await hostVol(env, "/volume-source?name=" + encodeURIComponent(vol.name));
    if (src.ok) await invokeUserModule(env, "volume-driver-" + vol.name, src.json.source, "tarIn", [Buffer.from(artifact).toString("base64")]);
  }
  return { digest: res.digest, files: res.files, size: res.size };
}

// Parse a docker-style image ref: [registry-host/]repo[:tag]. The first path component is a
// HOST iff it contains ":" or "." or is "localhost" (docker's heuristic). localName is the
// full local index key (host-qualified when a host is present), default tag latest.
function parseImageRef(s) {
  let host = null, rest = String(s || "");
  const slash = rest.indexOf("/");
  if (slash > 0) {
    const first = rest.slice(0, slash);
    if (first.includes(":") || first.includes(".") || first === "localhost") { host = first; rest = rest.slice(slash + 1); }
  }
  const c = rest.lastIndexOf(":");
  const repo = c === -1 ? rest : rest.slice(0, c);
  const tag = c === -1 ? "latest" : rest.slice(c + 1);
  return { host, repo, tag, localName: (host ? host + "/" + repo : repo) + ":" + tag };
}

// Resolve a machine reference (full id | unique id prefix | name) against the registry.
// Returns {rec} on success, or {response} carrying the docker-style 404/409 straight to the client.
async function resolveRef(env, ref) {
  const r = await reg(env, "/resolve?ref=" + encodeURIComponent(ref));
  if (r.ok) return { rec: await r.json() };
  return { response: new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } }) };
}

// auth: if ISO_TOKEN is set in the worker env, require a matching bearer token.
function authed(request, env) {
  const want = env.ISO_TOKEN;
  if (!want) return true;
  const got = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return got === want;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean); // ["v0","machines",...]

    // NETWORKS (docs/networks.md) — the egress seams, checked FIRST (a member's target URL
    // may legitimately contain /v0 paths, e.g. an iso registry member's API):
    // 1) policy-originated traffic — the policy isolate's fetch-shadow tags every request.
    if (request.headers.get("x-iso-pol")) return handlePolicyTagged(env, request);
    // 2) a networked machine's child egress — its DO stamped the caller's machine identity.
    const netFrom = request.headers.get("x-iso-net-from");
    if (netFrom) return governEgress(env, netFrom, request);

    // globalOutbound PASS-THROUGH (kept as a seam): any non-Engine-API request through this
    // worker is real egress. (Non-networked children inherit the DO's outbound directly.)
    if (url.hostname !== "self" && !url.pathname.startsWith("/v0")) {
      return fetch(request);
    }

    if (parts[0] !== "v0") return new Response("iso Engine API. Try GET /v0/machines", { status: 404 });
    if (!authed(request, env)) return new Response("unauthorized", { status: 401 });

    try {
      // GET /v0/version — engine info for `iso version`. ISO_HOST_INFO is injected by host.mjs.
      if (parts[1] === "version" && request.method === "GET") {
        const info = env.ISO_HOST_INFO || {};
        return Response.json({ name: "iso-host", apiVersion: "v0", ...info });
      }

      // GET /v0/images — `iso images`: the host owns the image map; proxy its /images route.
      if (parts[1] === "images" && parts.length === 2 && request.method === "GET") {
        const r = await env.HOST.fetch("http://host/images");
        return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
      }

      // GET /v0/build-cache/{stepHash} — per-step build cache lookup (self-healing on the host).
      if (parts[1] === "build-cache" && parts.length === 3 && request.method === "GET") {
        const r = await env.HOST.fetch("http://host/build-cache?hash=" + encodeURIComponent(decodeURIComponent(parts[2])));
        return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
      }

      // POST /v0/images/finalize — fully-cached `iso build`: re-manifest + tag an existing digest.
      if (parts[1] === "images" && parts.length === 3 && parts[2] === "finalize" && request.method === "POST") {
        const r = await env.HOST.fetch("http://host/image-finalize", {
          method: "POST", headers: { "content-type": "application/json" }, body: await request.text(),
        });
        return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
      }

      // POST /v0/images/tag {src, name} — local re-tag (docker semantics: same digest, new name).
      if (parts[1] === "images" && parts.length === 3 && parts[2] === "tag" && request.method === "POST") {
        const r = await env.HOST.fetch("http://host/image-tag", {
          method: "POST", headers: { "content-type": "application/json" }, body: await request.text(),
        });
        return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
      }

      // POST /v0/images/pull {ref, token?} — the DAEMON transfers (docker-style).
      if (parts[1] === "images" && parts.length === 3 && parts[2] === "pull" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const p = parseImageRef(body.ref || "");
        if (!p.host) return Response.json({ error: "pull requires a registry-qualified ref (e.g. localhost:5000/hello:v1)" }, { status: 400 });
        const r = await env.HOST.fetch("http://host/image-pull", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ host: p.host, repo: p.repo, tag: p.tag, localName: p.localName, token: body.token || "" }),
        });
        return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
      }

      // POST /v0/images/{ref}/push {token?} — resolve the local ref, transfer to its registry host.
      if (parts[1] === "images" && parts.length === 4 && parts[3] === "push" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const p = parseImageRef(decodeURIComponent(parts[2]));
        if (!p.host) return Response.json({ error: "push requires a registry-qualified ref (e.g. localhost:5000/hello:v1) — use `iso tag` first" }, { status: 400 });
        const r = await env.HOST.fetch("http://host/image-push", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ ref: p.localName, host: p.host, repo: p.repo, tag: p.tag, token: body.token || "" }),
        });
        return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
      }

      // GET/DELETE /v0/images/{ref} — `iso inspect` (image fallback) / `iso rmi`. {ref} is a
      // legacy name, repo[:tag], sha256:<hex>, or a unique digest prefix (resolved by the host).
      if (parts[1] === "images" && parts.length === 3) {
        const ref = decodeURIComponent(parts[2]);
        if (request.method === "GET") {
          const r = await env.HOST.fetch("http://host/image-inspect?ref=" + encodeURIComponent(ref));
          return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
        }
        if (request.method === "DELETE") {
          const r = await env.HOST.fetch("http://host/image-rm?ref=" + encodeURIComponent(ref));
          return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
        }
      }

      // ---- /v0/volumes — docs/volumes.md (checkpointed, driver-backed, versioned) ----
      if (parts[1] === "volumes") {
        // POST /v0/volumes {name, driverPath?}
        if (parts.length === 2 && request.method === "POST") {
          const r = await hostVol(env, "/volume-create", await request.json());
          return Response.json(r.json, { status: r.status });
        }
        // GET /v0/volumes — ls
        if (parts.length === 2 && request.method === "GET") {
          const r = await hostVol(env, "/volume-ls");
          return Response.json(r.json, { status: r.status });
        }
        if (parts.length >= 3) {
          const name = decodeURIComponent(parts[2]);
          const vol = (await hostVol(env, "/volume-inspect?name=" + encodeURIComponent(name))).json;
          if (vol.error) return Response.json(vol, { status: 404 });
          // liveness of the attach lock: self-heal when the holder is gone/not running.
          let holder = null;
          if (vol.attachedTo) {
            holder = await reg(env, "/get?id=" + encodeURIComponent(vol.attachedTo)).then((r) => r.json()).catch(() => null);
            if (!holder || (holder.status !== "running" && holder.status !== "serving" && holder.status !== "created")) {
              await hostVol(env, "/volume-detach", { name, machineId: vol.attachedTo });
              vol.attachedTo = null; holder = null;
            }
          }
          // GET /v0/volumes/{name} — inspect
          if (parts.length === 3 && request.method === "GET") return Response.json(vol);
          // DELETE /v0/volumes/{name} — rm (refuse while attached to a live machine)
          if (parts.length === 3 && request.method === "DELETE") {
            if (vol.attachedTo) return Response.json({ error: `volume "${name}" is in use by machine ${vol.attachedTo.slice(0, 12)}` }, { status: 409 });
            const r = await hostVol(env, "/volume-rm", { name });
            return Response.json(r.json, { status: r.status });
          }
          // POST /v0/volumes/{name}/sync — checkpoint from the attached RUNNING machine
          if (parts[3] === "sync" && request.method === "POST") {
            if (!vol.attachedTo) return Response.json({ error: `volume "${name}" is not attached to a machine — nothing to sync` }, { status: 409 });
            const mount = (holder?.volumes || []).find((m) => m.name === name)?.path;
            if (!mount) return Response.json({ error: "attached machine record carries no mount path" }, { status: 500 });
            const res = await checkpointVolume(env, vol, vol.attachedTo, mount, "auto");
            if (res.skipped) return Response.json({ error: "sync skipped: " + res.reason }, { status: 409 });
            return Response.json(res);
          }
          // POST /v0/volumes/{name}/snapshot — pin the current state
          if (parts[3] === "snapshot" && request.method === "POST") {
            if (vol.attachedTo) {
              const mount = (holder?.volumes || []).find((m) => m.name === name)?.path;
              if (mount) {
                const res = await checkpointVolume(env, vol, vol.attachedTo, mount, "pinned");
                if (!res.skipped) return Response.json(res);
              }
            }
            // not attached (or machine fs gone): pin the current live tree
            const art = (await hostVol(env, "/volume-attach", { name, machineId: vol.attachedTo || "" })).json; // local: returns artifact
            await hostVol(env, "/volume-detach", { name, machineId: vol.attachedTo || "" });
            if (art.mode === "user") {
              const src = (await hostVol(env, "/volume-source?name=" + encodeURIComponent(name))).json.source;
              const b64 = await invokeUserModule(env, "volume-driver-" + name, src, "tarOut", []);
              const artifact = b64 ? Buffer.from(b64, "base64").toString("utf8") : "{}";
              const q = new URLSearchParams({ name, kind: "pinned" });
              const r = await env.HOST.fetch("http://host/volume-checkpoint?" + q, { method: "POST", body: artifact });
              return Response.json(await r.json(), { status: r.status });
            }
            const q = new URLSearchParams({ name, kind: "pinned" });
            const r = await env.HOST.fetch("http://host/volume-checkpoint?" + q, { method: "POST", body: art.artifact || "{}" });
            return Response.json(await r.json(), { status: r.status });
          }
          // POST /v0/volumes/{name}/rollback {ref} — refuse while attached to a live machine
          if (parts[3] === "rollback" && request.method === "POST") {
            if (vol.attachedTo) return Response.json({ error: `cannot roll back volume "${name}" while it is attached to machine ${vol.attachedTo.slice(0, 12)} — stop it first` }, { status: 409 });
            const body = await request.json();
            const r = await hostVol(env, "/volume-rollback", { name, ref: body.ref });
            if (r.ok && r.json.source) {
              // user driver: push the restored artifact into the driver (sandboxed tarIn)
              await invokeUserModule(env, "volume-driver-" + name, r.json.source, "tarIn", [Buffer.from(r.json.artifact).toString("base64")]);
            }
            return Response.json({ digest: r.json.digest, error: r.json.error }, { status: r.status });
          }
        }
        return Response.json({ error: "unhandled volumes route" }, { status: 404 });
      }

      // ---- /v0/networks — docs/networks.md ("the network is a JS function") ----
      if (parts[1] === "networks") {
        // POST /v0/networks {name, policySource?}
        if (parts.length === 2 && request.method === "POST") {
          const r = await hostVol(env, "/network-create", await request.json());
          return Response.json(r.json, { status: r.status });
        }
        // GET /v0/networks — ls (member counts from the registry)
        if (parts.length === 2 && request.method === "GET") {
          const r = await hostVol(env, "/network-ls");
          if (!r.ok) return Response.json(r.json, { status: r.status });
          const machines = await reg(env, "/list").then((x) => x.json()).catch(() => []);
          const out = (r.json || []).map((n) => ({
            ...n,
            members: machines.filter((m) => m.network === n.name && ["created", "running", "serving"].includes(m.status)).length,
          }));
          return Response.json(out);
        }
        if (parts.length >= 3) {
          const name = decodeURIComponent(parts[2]);
          const net = (await hostVol(env, "/network-inspect?name=" + encodeURIComponent(name))).json;
          if (net.error) return Response.json({ error: "No such network: " + name }, { status: 404 });
          const machines = await reg(env, "/list").then((x) => x.json()).catch(() => []);
          const members = machines.filter((m) => m.network === name)
            .map((m) => ({ id: m.id, name: m.name, status: m.status }));
          // GET /v0/networks/{name} — inspect (the token never leaves the engine)
          if (parts.length === 3 && request.method === "GET") {
            const { token, ...pub } = net;
            return Response.json({ ...pub, members });
          }
          // DELETE /v0/networks/{name} — rm (refuse while live members exist, docker-style)
          if (parts.length === 3 && request.method === "DELETE") {
            const live = members.filter((m) => ["created", "running", "serving"].includes(m.status));
            if (live.length) {
              return Response.json({ error: `network "${name}" has active members (${live.map((m) => m.name).join(", ")}) — remove them first` }, { status: 409 });
            }
            const r = await hostVol(env, "/network-rm", { name });
            return Response.json(r.json, { status: r.status });
          }
          // GET /v0/networks/{name}/logs?since= — the observability seam docker doesn't have
          if (parts.length === 4 && parts[3] === "logs" && request.method === "GET") {
            const r = await hostVol(env, "/network-logs?name=" + encodeURIComponent(name) + "&since=" + encodeURIComponent(url.searchParams.get("since") || "0"));
            return Response.json(r.json, { status: r.status });
          }
        }
        return Response.json({ error: "unhandled networks route" }, { status: 404 });
      }

      // GET /v0/machines  — ps
      if (parts[1] === "machines" && parts.length === 2 && request.method === "GET") {
        const r = await reg(env, "/list");
        return new Response(await r.text(), { headers: { "content-type": "application/json" } });
      }

      // POST /v0/machines  — run: {image, cmd, args, env, cwd, name, detach}
      // detach=true (`iso run -d`) returns immediately with {id, streamId}; chunks stream to the
      // WS /logs route. Otherwise the run settles and {run:{code,stdout,stderr}} is returned.
      if (parts[1] === "machines" && parts.length === 2 && request.method === "POST") {
        const body = await request.json();
        const image = body.image || "base";
        const id = newId();
        // docker-style names: honor --name (unique) or auto-generate adjective_noun.
        const existing = await reg(env, "/list").then((r) => r.json());
        const taken = new Set(existing.map((m) => m.name).filter(Boolean));
        let name = body.name;
        if (name) {
          const holder = existing.find((m) => m.name === name);
          if (holder) {
            return Response.json({
              error: `Conflict. The machine name "${name}" is already in use by machine "${holder.id.slice(0, 12)}". You have to remove (or rename) that machine to be able to reuse that name.`,
            }, { status: 409 });
          }
        } else name = genName(taken);

        // Image manifest (iso.json): pre-flight the image exists, and apply its defaults —
        // docker semantics: argv = ENTRYPOINT + (user cmd || CMD); -e overrides ENV; -w overrides
        // WORKDIR. Legacy images (base) have a synthesized manifest with no cmd/entrypoint.
        const mr = await env.HOST.fetch("http://host/image-inspect?ref=" + encodeURIComponent(image));
        if (mr.status === 404) return Response.json({ error: `Unable to find image '${image}' locally` }, { status: 404 });
        const manifest = mr.ok ? await mr.json() : {};
        // RUNTIME COMPAT enforcement (docs/architecture.md "What's actually in an image"): the
        // manifest's runtime field declares what the image REQUIRES; refuse what this host can't
        // faithfully run — docker-style, like an image built for another platform. An absent
        // field (legacy manifests) is unconstrained and runs fine.
        if (manifest.runtime) {
          const want = manifest.runtime.compatDate;
          if (want && want > CHILD_COMPAT_DATE) {
            return Response.json({ error: `image '${image}' requires runtime compat ${want}; this host provides ${CHILD_COMPAT_DATE} — run 'iso update'` }, { status: 400 });
          }
          const minHost = manifest.runtime.minHost;
          const hostVer = env.ISO_HOST_INFO?.version || "0.0.0";
          const older = (a, b) => { // semver-ish: is a < b
            const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
            for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d < 0; }
            return false;
          };
          if (minHost && older(hostVer, minHost)) {
            return Response.json({ error: `image '${image}' requires iso host >= ${minHost}; this host is ${hostVer} — run 'iso update'` }, { status: 400 });
          }
        }
        const userCmd = [body.cmd, ...(body.args || [])].filter((x) => x !== undefined && x !== null && x !== "");
        const entry = Array.isArray(manifest.entrypoint) ? manifest.entrypoint : [];
        const argv = [...entry, ...(userCmd.length ? userCmd : (Array.isArray(manifest.cmd) ? manifest.cmd : []))];
        const mergedEnv = { ...(manifest.env || {}), ...(body.env || {}) };
        const cwd = body.cwd || manifest.workdir || "/work";

        // ---- validate EVERYTHING before claiming anything ----------------------------------
        // A refused run must leave zero residue: no listener, no attach lock, no ps record.
        // Volume/network validation is a pure read pass here; ports are claimed only after it
        // passes, and every claim from this point on is covered by the rollback guard below.
        const netName = body.network || null; // v1: one network per machine
        if (netName) {
          const net = (await hostVol(env, "/network-inspect?name=" + encodeURIComponent(netName))).json;
          if (net.error) return Response.json({ error: "No such network: " + netName }, { status: 404 });
        }
        for (const v of body.volumes || []) {
          if (!validMountPath(v.path)) {
            return Response.json({ error: `invalid mount path ${JSON.stringify(v.path)}: must be absolute and not under ${FORBIDDEN_MOUNT_PREFIXES.join(", ")} (excluded/rootfs trees)` }, { status: 400 });
          }
          const vol = (await hostVol(env, "/volume-inspect?name=" + encodeURIComponent(v.name))).json;
          if (vol.error) return Response.json({ error: "No such volume: " + v.name }, { status: 404 });
          if (vol.attachedTo) {
            const holder = await reg(env, "/get?id=" + encodeURIComponent(vol.attachedTo)).then((r) => r.json()).catch(() => null);
            if (holder && ["running", "serving", "created"].includes(holder.status)) {
              return Response.json({ error: `volume "${v.name}" is already attached to machine ${vol.attachedTo.slice(0, 12)} (${holder.name}) — volumes are exclusive in v1` }, { status: 409 });
            }
            await hostVol(env, "/volume-detach", { name: v.name, machineId: vol.attachedTo }); // stale lock: self-heal
          }
        }

        // rollback guard: releases every claim made for this (never-registered) machine id.
        const attachedVols = [];
        const rollback = async () => {
          try {
            await env.HOST.fetch("http://host/unpublish-ports", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ machineId: id }),
            });
          } catch {}
          for (const n of attachedVols) {
            try { await hostVol(env, "/volume-detach", { name: n, machineId: id }); } catch {}
          }
        };
        const refuse = async (resp) => { await rollback(); return resp; };

        // published ports (`-p hostPort[:machinePort]`, repeatable): bare -p uses the manifest's
        // first EXPOSE as the machine port. The HOST opens the listeners (docker semantics).
        const ports = (body.ports || []).map((p) => ({
          host: p.host,
          machine: p.machine || (Array.isArray(manifest.ports) && manifest.ports[0]) || p.host,
        }));
        for (const p of ports) {
          const r = await env.HOST.fetch("http://host/publish-port", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ machineId: id, hostPort: p.host, machinePort: p.machine }),
          });
          if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            return refuse(Response.json({ error: err.error || `Bind for 127.0.0.1:${p.host} failed: port is already allocated` }, { status: 500 }));
          }
        }

        // volumes (`-v name:/path`, repeatable): EXCLUSIVE-attach (validated above) and collect
        // the copy-in artifacts (local: the live tree; user driver: sandboxed tarOut).
        const volumes = [];
        const volArtifacts = [];
        for (const v of body.volumes || []) {
          const att = (await hostVol(env, "/volume-attach", { name: v.name, machineId: id })).json;
          if (att.error) return refuse(Response.json({ error: att.error }, { status: 409 }));
          attachedVols.push(v.name);
          let artifact = "{}";
          try {
            if (att.mode === "user") {
              const b64 = await invokeUserModule(env, "volume-driver-" + v.name, att.source, "tarOut", []);
              artifact = b64 ? Buffer.from(b64, "base64").toString("utf8") : "{}";
            } else artifact = att.artifact || "{}";
          } catch (e) {
            return refuse(Response.json({ error: `volume "${v.name}" driver tarOut failed: ${String(e?.message || e)}` }, { status: 500 }));
          }
          volumes.push({ name: v.name, path: v.path });
          volArtifacts.push({ path: v.path, artifact });
        }

        // M1: register FIRST (status created) so the Machine DO's setStatus patches land on an
        // existing record; the DO then owns running→exited transitions via the REGISTRY binding.
        const rec = {
          id, name, image, imageDigest: manifest.digest || null, status: "created",
          command: argv.join(" ") || "(boot only)",
          createdAt: new Date().toISOString(), startedAt: null, exitedAt: null,
          env: mergedEnv, workdir: cwd, ports, volumes, network: netName,
          url: url.origin + "/v0/machines/" + id,
          lastStream: null, lastExit: null,
        };
        try {
          await reg(env, "/put", { method: "POST", body: JSON.stringify(rec) });
          const stub = machineStub(env, id);
          if (netName) {
            // a networked member's serving child lives in DO memory — same warmth requirement
            // as a published port (host pings until rm).
            await env.HOST.fetch("http://host/machine-keepalive", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ machineId: id, on: true }),
            });
          }
          if (volArtifacts.length) {
            // copy-in BEFORE the command runs: boot the rootfs, then materialize each mount.
            await stub.fetch(new Request("http://m/boot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image }) }));
            for (const va of volArtifacts) {
              await stub.fetch(new Request("http://m/volume-in", {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ path: va.path, files: JSON.parse(va.artifact) }),
              }));
            }
          }
          if (!argv.length) {
            // boot-only (`iso run -d <image>` with no cmd and no manifest CMD): unpack the rootfs,
            // leave the machine "Created" — don't send a bogus /run.
            const bootRes = await stub.fetch(new Request("http://m/boot", {
              method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image }),
            })).then((r) => r.json());
            return Response.json({ id, name, url: rec.url, boot: bootRes });
          }
          const runRes = await stub.fetch(new Request("http://m/run", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ machineId: id, image, cmd: argv[0], args: argv.slice(1), env: mergedEnv, cwd, detach: !!body.detach,
              // a networked machine whose IMAGE declares a server (EXPOSE) is SERVING at
              // quiescence even with no published ports — members reach it by name. (A plain
              // networked command with no EXPOSE exits normally; name-resolution targets
              // should EXPOSE their port — documented.)
              serving: ports.length > 0 || (!!netName && Array.isArray(manifest.ports) && manifest.ports.length > 0),
              network: netName ? { name: netName, member: name } : undefined }),
          })).then((r) => r.json());
          return Response.json({ id, name, url: rec.url, streamId: runRes.streamId, detached: !!runRes.detached, run: body.detach ? undefined : runRes });
        } catch (e) {
          // machine failed to boot/start: release claims and drop the record — a failed `iso run`
          // must not leave a phantom `ps` entry holding ports and volume locks.
          await rollback();
          if (netName) await env.HOST.fetch("http://host/machine-keepalive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ machineId: id, on: false }) }).catch(() => {});
          try { await reg(env, "/delete?id=" + encodeURIComponent(id)); } catch {}
          return Response.json({ error: `failed to start machine: ${String(e?.message || e)}` }, { status: 500 });
        }
      }

      // routes under /v0/machines/{ref}/... — {ref} is a full id, unique id prefix, or name.
      if (parts[1] === "machines" && parts.length >= 3) {
        const resolved = await resolveRef(env, parts[2]);
        if (resolved.response) return resolved.response;
        const rec = resolved.rec;
        const id = rec.id;

        // GET /v0/machines/{ref} — inspect: the registry record + what the Machine DO cheaply reports.
        if (parts.length === 3 && request.method === "GET") {
          let machine = null;
          try {
            machine = await machineStub(env, id).fetch(new Request("http://m/info")).then((r) => r.json());
          } catch (e) { machine = { error: String(e) }; }
          return Response.json({ ...rec, machine });
        }

        // POST /v0/machines/{id}/exec  — run another cmd in the SAME machine (shared /tmp).
        // detach supported here too; either way records lastStream for `iso logs <id>`.
        // attach:true (`iso exec -i`) → returns {execId}; frames flow over the attach WS below.
        if (parts[3] === "exec" && parts.length === 4 && request.method === "POST") {
          const body = await request.json();
          // docker parity: exec NEVER touches the machine record — no command overwrite, and
          // exec:true tells the DO to skip its registry status patches (the main command owns
          // the `ps` row; an exec finishing must not flip a running machine to Exited).
          const stub = machineStub(env, id);
          const runRes = await stub.fetch(new Request("http://m/run", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ machineId: id, image: rec.image, cmd: body.cmd, args: body.args || [], env: { ...(rec.env || {}), ...(body.env || {}) }, cwd: body.cwd || rec.workdir || "/work", detach: !!body.detach, attach: !!body.attach, exec: true,
              network: rec.network ? { name: rec.network, member: rec.name } : undefined }),
          })).then((r) => r.json());
          if (body.attach) return Response.json({ id, execId: runRes.streamId, attached: true });
          return Response.json({ id, streamId: runRes.streamId, detached: !!runRes.detached, run: body.detach ? undefined : runRes });
        }

        // WS /v0/machines/{ref}/exec/{execId}/attach — the bidirectional interactive channel
        // (`iso exec -i`). Forward the upgrade to the Machine DO, which OWNS the socket.
        if (parts[3] === "exec" && parts.length === 6 && parts[5] === "attach") {
          if (request.headers.get("upgrade") !== "websocket") {
            return new Response("attach is a WebSocket endpoint: connect with Upgrade: websocket.", { status: 426 });
          }
          return machineStub(env, id).fetch(new Request("http://m/attach?id=" + encodeURIComponent(parts[4]), {
            headers: { upgrade: "websocket" },
          }));
        }

        // GET /v0/machines/{ref}/top — the process table (docker top equivalent).
        if (parts[3] === "top" && request.method === "GET") {
          const r = await machineStub(env, id).fetch(new Request("http://m/top"));
          return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
        }

        // POST /v0/machines/{ref}/commit {repo, tag, message, changes[], history[]} → {digest}.
        // The primitive behind `iso commit` AND `iso build`: snapshot the machine's whole /tmp
        // from the Machine DO, hand it to the host's content-addressed image store.
        if (parts[3] === "commit" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          if (body.repo && !/^[a-z0-9][a-z0-9_.-]*$/.test(body.repo)) {
            return Response.json({ error: `invalid reference format: repository name '${body.repo}' must match [a-z0-9][a-z0-9_.-]*` }, { status: 400 });
          }
          const tag = body.tag || "latest";
          if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/.test(tag)) {
            return Response.json({ error: `invalid reference format: tag '${tag}'` }, { status: 400 });
          }
          const snap = await machineStub(env, id).fetch(new Request("http://m/snapshot"));
          if (!snap.ok) return new Response(await snap.text(), { status: snap.status, headers: { "content-type": "application/json" } });
          const q = new URLSearchParams({
            repo: body.repo || "", tag, message: body.message || "", parent: body.parent || rec.image || "",
            cacheHash: body.cacheHash || "", // `iso build` intermediates: stepHash → digest cache entry
            meta: JSON.stringify({ changes: body.changes || [], history: body.history || [] }),
          });
          const r = await env.HOST.fetch("http://host/store-image?" + q, { method: "POST", body: snap.body });
          return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
        }

        // POST /v0/machines/{id}/use-fork {project,cwd}  — M3: repin a scaffold's deps to the
        // published workerd vite/rolldown forks before install.
        if (parts[3] === "use-fork" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const r = await machineStub(env, id).fetch(new Request("http://m/use-fork", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ project: body.project || "myapp", cwd: body.cwd || "/work" }),
          }));
          return new Response(await r.text(), { headers: { "content-type": "application/json" } });
        }

        // POST /v0/machines/{id}/dev {project,devPort}  — M4: boot+warm the vite dev server.
        if (parts[3] === "dev" && request.method === "POST") {
          const body = await request.json().catch(() => ({}));
          const projDir = body.projDir || "/tmp/proj/" + (body.project || "myapp");
          const r = await machineStub(env, id).fetch(new Request("http://m/dev-warmup", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ projDir, devPort: body.devPort }),
          }));
          await reg(env, "/patch", { method: "POST", body: JSON.stringify({ id, status: "serving", lastStream: rec.lastStream }) }).catch(() => {});
          return new Response(await r.text(), { headers: { "content-type": "application/json" } });
        }

        // GET /v0/machines/{id}/proxy?p=<path>  — M4: forward browser HTTP / __hmr WS to vite-dev.
        if (parts[3] === "proxy") {
          if (request.headers.get("upgrade") === "websocket") {
            return machineStub(env, id).fetch(new Request("http://m/proxy?p=" + encodeURIComponent(url.searchParams.get("p") || "/__hmr"), { headers: { upgrade: "websocket", ...(request.headers.get("sec-websocket-protocol") ? { "sec-websocket-protocol": request.headers.get("sec-websocket-protocol") } : {}) } }));
          }
          return machineStub(env, id).fetch(new Request("http://m/proxy?p=" + encodeURIComponent(url.searchParams.get("p") || "/"), request));
        }

        // ANY /v0/machines/{ref}/port-proxy?port=&p= — published-port forwarding (streaming body).
        if (parts[3] === "port-proxy") {
          return machineStub(env, id).fetch(new Request(
            "http://m/port-proxy?port=" + encodeURIComponent(url.searchParams.get("port") || "") +
            "&p=" + encodeURIComponent(url.searchParams.get("p") || "/"), request));
        }

        // POST /v0/machines/{id}/fs {op,path,content}  — read/write/exists/ls the machine's /tmp.
        if (parts[3] === "fs" && request.method === "POST") {
          const r = await machineStub(env, id).fetch(new Request("http://m/fs", {
            method: "POST", headers: { "content-type": "application/json" }, body: await request.text(),
          }));
          return new Response(await r.text(), { headers: { "content-type": "application/json" } });
        }

        // WS /v0/machines/{id}/logs[?follow=1]  — Track B streaming, MERGED.
        // Proxy the WebSocket upgrade through to the Machine DO's LogStream subscriber. The DO
        // replays the ring then (follow=1) fans out live frames. ?stream= picks a specific run;
        // default is the machine's last stream.
        if (parts[3] === "logs") {
          if (request.headers.get("upgrade") !== "websocket") {
            return new Response("logs is a WebSocket endpoint: connect with Upgrade: websocket (?follow=1 to tail).", { status: 426 });
          }
          const streamId = url.searchParams.get("stream") || rec.lastStream;
          if (!streamId) return new Response("machine has no stream yet", { status: 404 });
          const follow = url.searchParams.get("follow") === "1" ? "1" : "0";
          const stub = machineStub(env, id);
          // forward the upgrade to the DO; return its 101 + webSocket straight back to the client.
          return stub.fetch(new Request("http://m/logs?id=" + encodeURIComponent(streamId) + "&follow=" + follow, {
            headers: { upgrade: "websocket" },
          }));
        }

        // DELETE /v0/machines/{ref}[?force=1]  — rm. Like docker: refuse a running machine unless forced.
        if (request.method === "DELETE") {
          const force = url.searchParams.get("force") === "1";
          if (!force && (rec.status === "running" || rec.status === "serving")) {
            return Response.json({
              error: `You cannot remove a running machine ${id.slice(0, 12)}. Stop the machine before attempting removal or force remove`,
            }, { status: 409 });
          }
          // volumes: checkpoint-out (best-effort — an evicted machine's fs is gone; the previous
          // checkpoint stands, crash-lossy is the documented v1 semantic) then release the lock.
          const volNotes = [];
          for (const m of rec.volumes || []) {
            const vol = (await hostVol(env, "/volume-inspect?name=" + encodeURIComponent(m.name))).json;
            if (!vol.error) {
              const res = await checkpointVolume(env, vol, id, m.path, "auto");
              volNotes.push({ name: m.name, ...(res.skipped ? { skipped: res.reason } : { checkpoint: res.digest }) });
            }
            await hostVol(env, "/volume-detach", { name: m.name, machineId: id });
          }
          await reg(env, "/delete?id=" + encodeURIComponent(id));
          // release any published host ports this machine held
          await env.HOST.fetch("http://host/unpublish-ports", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ machineId: id }),
          }).catch(() => {});
          // stop the networked-member keepalive (no-op for non-networked machines)
          await env.HOST.fetch("http://host/machine-keepalive", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ machineId: id, on: false }),
          }).catch(() => {});
          return Response.json({ removed: id, name: rec.name, ...(volNotes.length ? { volumes: volNotes } : {}) });
        }
      }

      return new Response("unhandled route: " + request.method + " " + url.pathname, { status: 404 });
    } catch (e) {
      return Response.json({ error: String(e), stack: (e?.stack ?? "").split("\n").slice(0, 20) }, { status: 500 });
    }
  },
};
