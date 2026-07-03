#!/usr/bin/env node
// iso CLI — the thin client. Holds NO runtime state beyond the active context (host endpoint +
// optional bearer token), stored in ~/.iso/state.json. ALL real work happens via Engine API
// HTTP/WS calls to an iso host. This file is the whole point: prove the CLI↔host wire boundary,
// with docker-parity DX (flags anywhere, names + id prefixes, docker-formatted ps, cp, images,
// inspect, version, and `iso host start|stop|status` for the local daemon).
//
// Run `iso --help` (or `iso COMMAND --help`) for the full surface.
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // packages/cli
const INSTALL_ROOT = path.resolve(HERE, "..", ".."); // the install/repo dir (contains packages/)
const CLI_VERSION = JSON.parse(readFileSync(path.join(HERE, "package.json"), "utf8")).version;
const ISO_DIR = path.join(os.homedir(), ".iso");
const PID_FILE = path.join(ISO_DIR, "host.pid");
const LOG_FILE = path.join(ISO_DIR, "host.log");
// The daemon + base-image builder live next to the CLI in the install layout (packages/host,
// packages/base-image). $ISO_HOST_MJS overrides the daemon path (tests / side-by-side installs).
const HOST_MJS = process.env.ISO_HOST_MJS || path.join(INSTALL_ROOT, "packages", "host", "host.mjs");
const BASE_BUILD_MJS = path.join(INSTALL_ROOT, "packages", "base-image", "build.mjs");
// The forked workerd binary ships in the install dir; a signed runtime copy lives under ~/.iso.
const BUNDLED_WORKERD = path.join(INSTALL_ROOT, "workerd-vfs.bin");
const SIGNED_WORKERD = path.join(ISO_DIR, "run", "workerd.bin");

// ---------------------------------------------------------------------------- state / contexts
// State lives in ~/.iso/state.json (docker-style: ~/.docker) so the globally-linked `iso` works
// from any cwd. $ISO_STATE overrides.
const STATE_FILE = process.env.ISO_STATE || path.join(ISO_DIR, "state.json");

function loadState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return { active: null, contexts: {} }; }
}
function saveState(s) {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n");
}
function activeContext(s) {
  if (!s.active || !s.contexts[s.active]) {
    die("Error: no active context. Start a local host with `iso host start`, or point the CLI at one:\n" +
      "  iso context create <name> --host <url> && iso context use <name>");
  }
  return s.contexts[s.active];
}
function die(msg, code = 1) { console.error(msg); process.exit(code); }

// ---------------------------------------------------------------------------- Engine API client
async function apiRaw(ctx, method, route, body) {
  const headers = { "content-type": "application/json" };
  if (ctx.token) headers.authorization = "Bearer " + ctx.token;
  let res;
  try {
    res = await fetch(ctx.host.replace(/\/$/, "") + route, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    die(`Error: Cannot connect to the iso host at ${ctx.host}. Is the host running? Try: iso host start  (${e.message})`);
  }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json };
}
function apiErr(r) { return "Error: " + (r.json.error || r.json.raw || "HTTP " + r.status); }
async function api(ctx, method, route, body) {
  const r = await apiRaw(ctx, method, route, body);
  if (!r.ok) die(apiErr(r));
  return r.json;
}

// ---------------------------------------------------------------------------- output helpers
function printRun(run) {
  if (!run) return;
  if (run.error) { process.stderr.write("Error: " + run.error + "\n"); process.exitCode = 1; return; }
  if (run.stdout) process.stdout.write(run.stdout.endsWith("\n") ? run.stdout : run.stdout + "\n");
  if (run.stderr) process.stderr.write(run.stderr.endsWith("\n") ? run.stderr : run.stderr + "\n");
  if (run.importErr) process.stderr.write(run.importErr + "\n");
}
function shortId(id) { return String(id ?? "").slice(0, 12); }
function printTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? "").length)));
  const line = (cells) => cells.map((c, i) => String(c ?? "").padEnd(widths[i])).join("   ").replace(/\s+$/, "");
  console.log(line(headers));
  for (const r of rows) console.log(line(r));
}
// docker-style relative durations: "Less than a second", "About a minute", "2 hours", "3 days"
function dur(t) {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(t)) / 1000));
  if (s < 1) return "Less than a second";
  if (s === 1) return "1 second";
  if (s < 60) return s + " seconds";
  const m = Math.floor(s / 60);
  if (m < 2) return "About a minute";
  if (m < 60) return m + " minutes";
  const h = Math.floor(m / 60);
  if (h < 2) return "About an hour";
  if (h < 24) return h + " hours";
  const d = Math.floor(h / 24);
  return d === 1 ? "1 day" : d + " days";
}
function ago(t) { return t ? dur(t) + " ago" : ""; }
function machineStatus(m) {
  if (m.status === "running") return "Up " + (m.startedAt ? dur(m.startedAt) : "");
  if (m.status === "serving") return "Serving";
  if (m.status === "exited") return `Exited (${m.lastExit ?? "?"}) ${ago(m.exitedAt || m.createdAt)}`;
  return "Created";
}
function fmtCommand(c, max = 20) {
  const s = String(c ?? "");
  return '"' + (s.length > max ? s.slice(0, max - 1) + "…" : s) + '"';
}
function humanSize(n) {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let u = 0, v = Number(n) || 0;
  while (v >= 1000 && u < units.length - 1) { v /= 1000; u++; }
  return (u === 0 ? String(v) : v.toPrecision(3)) + units[u];
}

// ---------------------------------------------------------------------------- flag parsing
// Real flag parsing, flags anywhere. Each command declares its flags; known flags are consumed
// wherever they appear. For run/exec, once the machine COMMAND starts (verbatimAfter positionals
// seen), everything else — including dashes and `--` — is passed through untouched, so
// `npm create vite@latest myapp -- --template react-ts` survives verbatim.
function parseFlags(cmdName, argv, spec, verbatimAfter = Infinity) {
  const flags = {}, positional = [];
  const byToken = new Map();
  for (const [key, def] of Object.entries(spec || {})) for (const t of def.flags) byToken.set(t, { key, def });
  let verbatim = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (verbatim) { positional.push(a); continue; }
    if (a === "--help" || a === "-h") return { help: true };
    let tok = a, inline;
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    if (eq > 0) { tok = a.slice(0, eq); inline = a.slice(eq + 1); }
    const hit = byToken.get(tok);
    if (hit) {
      let val = true;
      if (hit.def.value) {
        if (inline !== undefined) val = inline;
        else if (i + 1 < argv.length) val = argv[++i];
        else die(`flag needs an argument: ${tok}\nSee 'iso ${cmdName} --help'.`);
      }
      if (hit.def.repeat) (flags[hit.key] ??= []).push(val);
      else flags[hit.key] = val;
      continue;
    }
    if (a === "--") { verbatim = true; continue; }
    // combined short bool flags, docker-style: `iso ps -aq` == `-a -q`
    if (/^-[a-zA-Z]{2,}$/.test(a)) {
      const hits = [...a.slice(1)].map((ch) => byToken.get("-" + ch));
      if (hits.every((h) => h && !h.def.value)) {
        for (const h of hits) flags[h.key] = true;
        continue;
      }
    }
    if (a.startsWith("-") && a !== "-") die(`unknown flag: ${tok}\nSee 'iso ${cmdName} --help'.`);
    positional.push(a);
    if (positional.length >= verbatimAfter) verbatim = true;
  }
  return { flags, positional };
}
function parseEnvList(list) {
  const env = {};
  for (const kv of list || []) {
    const i = kv.indexOf("=");
    if (i <= 0) die(`Error: invalid environment variable: ${kv} (expected KEY=VAL)`);
    env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return env;
}
function usageError(name, msg) {
  const c = COMMANDS[name];
  die(`"iso ${name}" ${msg}.\nSee 'iso ${name} --help'.\n\nUsage:  ${c.usage}\n\n${c.summary}`);
}
function helpFor(name) {
  const c = COMMANDS[name];
  let out = `\nUsage:  ${c.usage}\n\n${c.summary}\n`;
  if (c.extra) out += "\n" + c.extra.trim() + "\n";
  const defs = Object.values(c.flags || {});
  if (defs.length) {
    const rows = defs.map((d) => {
      const shorts = d.flags.filter((f) => !f.startsWith("--"));
      const longs = d.flags.filter((f) => f.startsWith("--"));
      const left = (shorts.length ? shorts[0] + ", " : "    ") + longs[0] + (d.meta ? " " + d.meta : "");
      const desc = d.desc + (longs.length > 1 ? ` (alias: ${longs.slice(1).join(", ")})` : "");
      return [left, desc];
    });
    const w = Math.max(...rows.map((r) => r[0].length));
    out += "\nOptions:\n" + rows.map(([l, d]) => `  ${l.padEnd(w)}   ${d}`).join("\n") + "\n";
  }
  return out;
}
function topHelp() {
  const group = (g) => Object.entries(COMMANDS)
    .filter(([, c]) => c.group === g)
    .map(([n, c]) => `  ${n.padEnd(11)} ${c.summary}`).join("\n");
  console.log(`
Usage:  iso COMMAND

A Docker-shaped CLI for V8-isolate machines

Common Commands:
${group("common")}

Management Commands:
${group("mgmt")}

Experimental Commands:
${group("experimental")}

Global Options:
      --help   Print usage

Run 'iso COMMAND --help' for more information on a command.
`);
}

// ---------------------------------------------------------------------------- commands

async function cmdRun({ flags, positional }) {
  if (!positional.length) usageError("run", "requires at least 1 argument");
  const ctx = activeContext(loadState());
  const image = positional[0];
  const [command, ...args] = positional.slice(1);
  const body = { image, cmd: command, args, env: parseEnvList(flags.env), detach: !!flags.detach };
  if (flags.name) body.name = flags.name;
  if (flags.workdir) body.cwd = flags.workdir;
  if (flags.network) body.network = flags.network;
  if (flags.volume) {
    body.volumes = flags.volume.map((spec) => {
      const i = String(spec).indexOf(":");
      if (i <= 0) die("Error: invalid volume spec: " + spec + " (want name:/mount/path)");
      return { name: spec.slice(0, i), path: spec.slice(i + 1) };
    });
  }
  if (flags.publish) {
    body.ports = flags.publish.map((s) => {
      const [h, m] = String(s).split(":");
      const hostPort = Number(h), machinePort = m ? Number(m) : null;
      if (!Number.isInteger(hostPort) || hostPort <= 0 || (m && !Number.isInteger(machinePort))) {
        die("Error: invalid publish spec: " + s + " (want hostPort[:machinePort])");
      }
      return { host: hostPort, machine: machinePort };
    });
  }
  const res = await api(ctx, "POST", "/v0/machines", body);
  if (flags.detach) { console.log(res.id); return; } // docker parity: -d prints the full id
  printRun(res.run);
  process.exitCode = res.run?.code ?? 0; // exit with the machine command's exit code
}

async function cmdExec({ flags, positional }) {
  if (positional.length < 2) usageError("exec", "requires at least 2 arguments");
  const ctx = activeContext(loadState());
  const [ref, command, ...args] = positional;
  if (flags.tty) process.stderr.write("iso: the platform has no PTY; -t ignored, session is line-oriented\n");
  const body = { cmd: command, args, env: parseEnvList(flags.env), detach: !!flags.detach };
  if (flags.workdir) body.cwd = flags.workdir;
  if (flags.interactive) {
    body.attach = true;
    body.detach = false;
    const res = await api(ctx, "POST", "/v0/machines/" + encodeURIComponent(ref) + "/exec", body);
    if (!res.execId) die("Error: host did not return an execId for the attach");
    await attachSession(ctx, ref, res.execId);
    return;
  }
  const res = await api(ctx, "POST", "/v0/machines/" + encodeURIComponent(ref) + "/exec", body);
  if (flags.detach) { process.stderr.write("(detached; stream with: iso logs -f " + ref + ")\n"); return; }
  printRun(res.run);
  process.exitCode = res.run?.code ?? 0;
}

// Interactive attach (`iso exec -i`): local stdin → {type:"stdin"} frames (raw passthrough as it
// arrives — works for terminals and pipes); local EOF (Ctrl-D / pipe end) → {type:"stdin-eof"};
// stdout/stderr frames printed live (partial frames = prompts, written without a newline); exits
// with the remote command's exit code. Ctrl-C DETACHES (socket closes, the remote command keeps
// running — docker's -i-without-t behavior); exit code 130.
async function attachSession(ctx, ref, execId) {
  const { WebSocket } = await import("ws");
  const wsUrl = ctx.host.replace(/^http/, "ws").replace(/\/$/, "")
    + "/v0/machines/" + encodeURIComponent(ref) + "/exec/" + encodeURIComponent(execId) + "/attach";
  const headers = {};
  if (ctx.token) headers.authorization = "Bearer " + ctx.token;
  const exitCode = await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { headers });
    let code = 0;
    const onStdin = (chunk) => { try { ws.send(JSON.stringify({ type: "stdin", data: chunk.toString("utf8") })); } catch {} };
    const onStdinEnd = () => { try { ws.send(JSON.stringify({ type: "stdin-eof" })); } catch {} };
    ws.on("open", () => {
      process.stdin.on("data", onStdin);
      process.stdin.on("end", onStdinEnd);
    });
    ws.on("message", (raw) => {
      let f; try { f = JSON.parse(raw.toString()); } catch { return; }
      if (f.type === "stdout") process.stdout.write(f.partial ? f.data : f.data + "\n");
      else if (f.type === "stderr") process.stderr.write(f.partial ? f.data : f.data + "\n");
      else if (f.type === "exit") { code = f.code || 0; try { ws.close(); } catch {} }
      else if (f.type === "meta" && f.event === "dropped") process.stderr.write(`… ${f.n} lines dropped\n`);
    });
    ws.on("close", () => resolve(code));
    ws.on("error", (e) => { process.stderr.write("Error: attach: " + e.message + "\n"); resolve(1); });
    process.on("SIGINT", () => {
      process.stderr.write("\n(detached; the command keeps running — tail with: iso logs -f " + ref + ")\n");
      try { ws.close(); } catch {}
      resolve(130);
    });
  });
  process.exit(exitCode); // stdin listeners keep the loop alive — exit explicitly with the remote code
}

async function cmdPs({ flags }) {
  const ctx = activeContext(loadState());
  const list = await api(ctx, "GET", "/v0/machines");
  let rows = Array.isArray(list) ? [...list] : [];
  rows.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  if (!flags.all) rows = rows.filter((m) => m.status !== "exited");
  if (flags.quiet) { for (const m of rows) console.log(shortId(m.id)); return; }
  printTable(
    ["MACHINE ID", "IMAGE", "COMMAND", "CREATED", "STATUS", "PORTS", "NAMES", "NETWORK"],
    rows.map((m) => [shortId(m.id), m.image, fmtCommand(m.command), ago(m.createdAt), machineStatus(m),
      (m.ports || []).map((p) => `127.0.0.1:${p.host}->${p.machine}/tcp`).join(", "), m.name || "", m.network || ""]),
  );
}

async function cmdImages({ flags }) {
  const ctx = activeContext(loadState());
  const list = await api(ctx, "GET", "/v0/images");
  // docker parity: hide untagged/dangling images (build-cache intermediates) unless -a.
  let rows = list || [];
  if (!flags.all) rows = rows.filter((i) => i.repository !== "<none>");
  rows.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  printTable(
    ["REPOSITORY", "TAG", "IMAGE ID", "CREATED", "SIZE", "RUNTIME"],
    rows.map((i) => [i.repository, i.tag || "latest", (i.digest || "").replace(/^sha256:/, "").slice(0, 12) || "?", ago(i.createdAt), humanSize(i.size),
      i.runtime?.compatDate ? i.runtime.compatDate + (i.runtime.minHost ? " (host>=" + i.runtime.minHost + ")" : "") : ""]),
  );
}

// inspect precedence (documented): machine refs first, then image refs — like `docker inspect`.
async function cmdInspect({ positional }) {
  if (!positional.length) usageError("inspect", "requires at least 1 argument");
  const ctx = activeContext(loadState());
  const out = [];
  for (const ref of positional) {
    const r = await apiRaw(ctx, "GET", "/v0/machines/" + encodeURIComponent(ref));
    if (r.ok) { out.push(r.json); continue; }
    if (r.status === 404) {
      const ir = await apiRaw(ctx, "GET", "/v0/images/" + encodeURIComponent(ref));
      if (ir.ok) { out.push(ir.json); continue; }
      process.exitCode = 1; console.error("Error: No such machine or image: " + ref); continue;
    }
    process.exitCode = 1; console.error(apiErr(r));
  }
  console.log(JSON.stringify(out, null, 4));
}

async function cmdRm({ flags, positional }) {
  if (!positional.length) usageError("rm", "requires at least 1 argument");
  const ctx = activeContext(loadState());
  for (const ref of positional) {
    const r = await apiRaw(ctx, "DELETE", "/v0/machines/" + encodeURIComponent(ref) + (flags.force ? "?force=1" : ""));
    if (r.ok) {
      console.log(ref); // docker parity: echo what you asked to remove
      for (const v of r.json.volumes || []) {
        if (v.checkpoint) process.stderr.write(`volume ${v.name}: checkpointed ${v.checkpoint.slice(0, 19)}\n`);
        else process.stderr.write(`volume ${v.name}: checkpoint skipped (${v.skipped}) — previous checkpoint stands\n`);
      }
    }
    else { process.exitCode = 1; console.error(apiErr(r)); }
  }
}

async function cmdLogs({ flags, positional }) {
  if (positional.length !== 1) usageError("logs", "requires exactly 1 argument");
  const ctx = activeContext(loadState());
  await streamLogs(ctx, positional[0], !!flags.follow);
}

// iso top — docker top equivalent, rendered from the Machine DO's process table (the "kernel"
// books every isolate it spawns: exec sessions, their bins, and any children spawned via the
// spawn syscall — sh externals, npm lifecycle scripts, …).
async function cmdTop({ positional }) {
  if (positional.length !== 1) usageError("top", "requires exactly 1 argument");
  const ctx = activeContext(loadState());
  const res = await api(ctx, "GET", "/v0/machines/" + encodeURIComponent(positional[0]) + "/top");
  const procs = res.procs || [];
  const mmss = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  };
  printTable(
    ["PID", "PPID", "STATE", "TIME", "CMD"],
    procs.map((p) => [
      p.pid, p.ppid,
      p.state === "exited" ? `exited(${p.exitCode ?? "?"})` : p.state,
      p.startedAt ? mmss((p.endedAt || Date.now()) - p.startedAt) : "--:--",
      (p.native ? "[native] " : "") + p.argv.join(" ").slice(0, 60),
    ]),
  );
}

// iso cp MACHINE:SRC_PATH DEST_PATH | iso cp SRC_PATH MACHINE:DEST_PATH — over the /fs ops
// (base64-encoded, so binaries survive). Single files; directories are not supported.
async function cmdCp({ positional }) {
  if (positional.length !== 2) usageError("cp", "requires exactly 2 arguments");
  const ctx = activeContext(loadState());
  const asMachine = (p) => {
    const i = p.indexOf(":");
    if (i <= 0) return null;
    const ref = p.slice(0, i);
    return ref.includes("/") ? null : { ref, path: p.slice(i + 1) };
  };
  const [src, dst] = positional;
  const ms = asMachine(src), md = asMachine(dst);
  if (ms && md) die("Error: copying between machines is not supported");
  if (!ms && !md) die('Error: must specify at least one machine source ("MACHINE:PATH")');
  const fsOp = async (ref, body) => {
    const r = await api(ctx, "POST", "/v0/machines/" + encodeURIComponent(ref) + "/fs", body);
    if (!r.ok) die("Error: " + (r.error || "fs op failed"));
    return r;
  };
  if (ms) { // machine → local
    if (!ms.path.startsWith("/")) die("Error: machine path must be absolute: " + ms.path);
    const r = await fsOp(ms.ref, { op: "read", path: ms.path, enc: "base64" });
    let out = dst;
    try { if (statSync(dst).isDirectory()) out = path.join(dst, path.basename(ms.path)); } catch {}
    mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    writeFileSync(out, Buffer.from(r.content, "base64"));
  } else { // local → machine
    let st; try { st = statSync(src); } catch { die("Error: no such file or directory: " + src); }
    if (st.isDirectory()) die("Error: directory copy is not supported (single files only)");
    let mp = md.path;
    if (!mp.startsWith("/")) die("Error: machine path must be absolute: " + mp);
    if (mp.endsWith("/")) mp += path.basename(src);
    await fsOp(md.ref, { op: "write", path: mp, content: readFileSync(src).toString("base64"), enc: "base64" });
  }
}

// -------- image building: commit (the primitive) + build (a loop over it) --------
function parseRepoTag(s) {
  const i = s.lastIndexOf(":");
  if (i < 0) return { repo: s, tag: "latest" };
  return { repo: s.slice(0, i), tag: s.slice(i + 1) };
}

// docker-style image ref: [registry-host/]repo[:tag]. The first path component is a HOST iff it
// contains ":" or "." or is "localhost" (docker's heuristic); default tag latest. localName is
// the host-qualified local index key.
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

// iso tag SRC_IMAGE NEW_REF — local re-tag (docker semantics: both names → same digest).
async function cmdTag({ positional }) {
  if (positional.length !== 2) usageError("tag", "requires exactly 2 arguments");
  const ctx = activeContext(loadState());
  const [src, ref] = positional;
  const p = parseImageRef(ref);
  await api(ctx, "POST", "/v0/images/tag", { src, name: p.localName });
  // docker tag is silent on success
}

// iso push REF — the daemon does the transfer; the CLI renders docker-style progress.
async function cmdPush({ flags, positional }) {
  if (positional.length !== 1) usageError("push", "requires exactly 1 argument");
  const ctx = activeContext(loadState());
  const p = parseImageRef(positional[0]);
  if (!p.host) die("Error: push requires a registry-qualified ref (e.g. localhost:5000/hello:v1) — use `iso tag` first");
  console.log(`The push refers to repository [${p.host}/${p.repo}]`);
  const res = await api(ctx, "POST", "/v0/images/" + encodeURIComponent(p.localName) + "/push", { token: flags.token });
  const short = (d) => (d || "").replace(/^sha256:/, "").slice(0, 12);
  console.log(`${short(res.snapshot)}: ${res.blobExisted ? "Layer already exists" : "Pushed"}`);
  console.log(`${p.tag}: digest: ${res.digest} size: ${res.size}`);
}

// iso pull REF — GET manifest → fetch the missing blob → store + tag locally.
async function cmdPull({ flags, positional }) {
  if (positional.length !== 1) usageError("pull", "requires exactly 1 argument");
  const ctx = activeContext(loadState());
  const ref = positional[0];
  const p = parseImageRef(ref);
  if (!p.host) die("Error: pull requires a registry-qualified ref (e.g. localhost:5000/hello:v1)");
  console.log(`${p.tag}: Pulling from ${p.host}/${p.repo}`);
  const res = await api(ctx, "POST", "/v0/images/pull", { ref, token: flags.token });
  const short = (d) => (d || "").replace(/^sha256:/, "").slice(0, 12);
  console.log(`${short(res.snapshot)}: ${res.blobFetched ? "Pull complete" : "Already exists"}`);
  console.log(`Digest: ${res.digest}`);
  console.log(`Status: Downloaded ${res.blobFetched ? "newer" : "up-to-date"} image for ${p.localName}`);
}

async function cmdCommit({ flags, positional }) {
  if (positional.length < 1 || positional.length > 2) usageError("commit", "requires 1 or 2 arguments");
  const ctx = activeContext(loadState());
  const [ref, repoTag] = positional;
  const body = { message: flags.message, changes: flags.change || [] };
  if (repoTag) Object.assign(body, parseRepoTag(repoTag));
  const res = await api(ctx, "POST", "/v0/machines/" + encodeURIComponent(ref) + "/commit", body);
  console.log(res.digest); // docker parity: print the full digest
}

async function cmdRmi({ positional }) {
  if (!positional.length) usageError("rmi", "requires at least 1 argument");
  const ctx = activeContext(loadState());
  for (const ref of positional) {
    const r = await apiRaw(ctx, "DELETE", "/v0/images/" + encodeURIComponent(ref));
    if (!r.ok) { process.exitCode = 1; console.error(apiErr(r)); continue; }
    for (const t of r.json.untagged || []) console.log("Untagged: " + t);
    if (r.json.deleted) console.log("Deleted: " + r.json.deleted);
  }
}

// One-line rendering of an SDK step descriptor (progress lines + history + error messages).
function renderStep(s) {
  const kv = (o) => Object.entries(o).map(([k, v]) => k + "=" + v).join(" ");
  switch (s.op) {
    case "from": return "from " + s.image;
    case "run": return "run " + s.argv.join(" ");
    case "copy": return "copy " + s.src + " " + s.dest;
    case "env": return "env " + kv(s.env);
    case "workdir": return "workdir " + s.dir;
    case "cmd": return "cmd " + s.argv.join(" ");
    case "entrypoint": return "entrypoint " + s.argv.join(" ");
    case "expose": return "expose " + s.ports.join(" ");
    case "label": return "label " + kv(s.labels);
    default: return JSON.stringify(s);
  }
}

// iso build: import the JS build file (iso.build.mjs — a step graph made with the iso-sdk's
// from()), then execute it with docker's per-step cache semantics:
//   pass 1  compute the chain hash for every step — hash(parentStepHash, descriptor). COPY
//           descriptors embed a content hash of the actual context files (content-addressed,
//           not mtime), and meta steps participate in the chain (they shift descendants).
//   pass 2  while each RUN/COPY hash hits the cache → " ---> Using cache" + carry the cached
//           digest forward; FIRST miss → boot a build machine from the last cached digest (or
//           FROM) and execute that step and everything after, committing an untagged
//           INTERMEDIATE image (cacheHash → digest) per RUN/COPY. Meta steps never execute —
//           they only accumulate manifest changes.
// A fully-cached build boots NO machine: the last cached digest is re-manifested + tagged
// (/v0/images/finalize). --no-cache skips reads but still writes fresh entries (docker behavior).
async function cmdBuild({ flags, positional }) {
  if (positional.length !== 1) usageError("build", "requires exactly 1 argument");
  const ctx = activeContext(loadState());
  const context = path.resolve(positional[0]);
  let cst; try { cst = statSync(context); } catch { die("Error: build context not found: " + context); }
  if (!cst.isDirectory()) die("Error: build context must be a directory: " + context);
  const buildFile = path.resolve(flags.file || path.join(context, "iso.build.mjs"));
  if (!existsSync(buildFile)) {
    die("Error: no build file at " + buildFile + (flags.file ? "" : " (expected iso.build.mjs in the context dir; -f overrides)"));
  }
  let repo = null, tag = "latest";
  if (flags.tag) ({ repo, tag } = parseRepoTag(flags.tag));

  let mod;
  try { mod = await import(pathToFileURL(buildFile).href); }
  catch (e) { die("Error: failed to evaluate " + buildFile + ":\n" + (e?.stack || e)); }
  const graph = mod.default;
  const steps = graph && Array.isArray(graph.steps) ? [...graph.steps] : null;
  if (!steps || !steps.length || steps[0].op !== "from") {
    die("Error: " + path.basename(buildFile) + " must default-export a builder created with from(...)" +
      (graph === undefined ? " (the module has no default export)" : ""));
  }
  const total = steps.length;
  const errText = (r) => r.json.error || r.json.raw || ("HTTP " + r.status);

  // ---- pass 1: descriptors + chain hashes (COPY file lists + content hashes computed NOW) ----
  const plan = [];
  {
    let prevHash = null, wd = null;
    for (const step of steps) {
      const desc = { ...step };
      if (step.op === "from") {
        // hash the RESOLVED base digest, not just the name — a rebuilt base image must bust
        // every downstream cache entry (verified live when the vanilla rootfs landed).
        const ir = await apiRaw(ctx, "GET", "/v0/images/" + encodeURIComponent(step.image));
        if (!ir.ok) die("Error: Unable to find image '" + step.image + "' locally");
        desc.imageDigest = ir.json.digest || null;
      }
      let copyFiles = null, destAbs = null;
      if (step.op === "workdir") wd = step.dir;
      if (step.op === "copy") {
        const src = path.resolve(context, step.src);
        if (src !== context && !src.startsWith(context + path.sep)) die("Error: COPY " + step.src + ": forbidden path outside build context");
        let sst; try { sst = statSync(src); } catch { die("Error: COPY " + step.src + ": no such file or directory in build context"); }
        destAbs = step.dest.startsWith("/") ? step.dest : (wd || "/tmp/proj") + "/" + step.dest;
        copyFiles = []; // [localAbs, machinePath]
        if (sst.isDirectory()) {
          (function walk(d, rel) {
            for (const e of readdirSync(d, { withFileTypes: true })) {
              const r2 = rel ? rel + "/" + e.name : e.name;
              if (e.isDirectory()) walk(path.join(d, e.name), r2);
              else if (e.isFile()) copyFiles.push([path.join(d, e.name), destAbs + "/" + r2]);
            }
          })(src, "");
        } else copyFiles.push([src, destAbs.endsWith("/") ? destAbs + path.basename(src) : destAbs]);
        copyFiles.sort((a, b) => (a[1] < b[1] ? -1 : 1)); // canonical order → stable content hash
        const h = createHash("sha256");
        for (const [local, mpath] of copyFiles) { h.update(mpath); h.update("\0"); h.update(readFileSync(local)); }
        desc.contentHash = "sha256:" + h.digest("hex");
      }
      const hash = "sha256:" + createHash("sha256").update(prevHash || "").update(JSON.stringify(desc)).digest("hex");
      plan.push({ step, desc, hash, parent: prevHash, copyFiles, destAbs });
      prevHash = hash;
    }
  }

  // ---- pass 2: cache walk + execution ----
  const noCache = !!flags.nocache;
  let machine = null;
  let baseImage = steps[0].image;   // the FROM ref
  let lastDigest = null;            // most recent cached/committed intermediate digest
  let missed = false;
  const envAcc = {};
  let workdir = null;
  const changes = [], history = [];
  const cleanup = async () => {
    if (machine && !flags.keep) await apiRaw(ctx, "DELETE", "/v0/machines/" + machine.id + "?force=1");
  };
  const fail = async (i, step, msg) => {
    await cleanup();
    die(`Error: build step ${i + 1}/${total} (${renderStep(step)}) failed: ${msg}`);
  };
  const ensureMachine = async () => {
    if (machine) return;
    const bootRef = lastDigest || baseImage;
    const r = await apiRaw(ctx, "POST", "/v0/machines", { image: bootRef });
    if (!r.ok) throw new Error(errText(r));
    machine = r.json;
    console.log(" ---> booted build machine " + shortId(machine.id) + " from " +
      (lastDigest ? lastDigest.replace(/^sha256:/, "").slice(0, 12) + " (cache)" : bootRef));
  };

  for (let i = 0; i < total; i++) {
    const { step, desc, hash, parent, copyFiles, destAbs } = plan[i];
    console.log(`Step ${i + 1}/${total} : ${renderStep(step)}`);
    try {
      if (step.op === "from") {
        baseImage = step.image; // machine boots lazily — at the first cache miss
      } else if (step.op === "run" || step.op === "copy") {
        // docker cache semantics: consecutive prefix only — once one step misses, all rerun.
        if (!missed && !noCache) {
          const c = await apiRaw(ctx, "GET", "/v0/build-cache/" + encodeURIComponent(hash));
          if (c.ok && c.json.digest) {
            lastDigest = c.json.digest;
            console.log(" ---> Using cache");
            console.log(" ---> " + lastDigest.replace(/^sha256:/, "").slice(0, 12));
            history.push({ step: renderStep(step), descriptor: desc, hash, parent });
            continue;
          }
        }
        missed = true;
        await ensureMachine();
        if (step.op === "run") {
          console.log(" ---> Running in " + shortId(machine.id));
          const r = await apiRaw(ctx, "POST", "/v0/machines/" + machine.id + "/exec",
            { cmd: step.argv[0], args: step.argv.slice(1), env: envAcc, cwd: workdir || undefined });
          if (!r.ok) throw new Error(errText(r));
          printRun(r.json.run);
          const code = r.json.run?.code ?? 1;
          if (code !== 0) throw new Error(`The command '${step.argv.join(" ")}' returned a non-zero code: ${code}`);
        } else {
          for (const [local, mpath] of copyFiles) {
            const buf = readFileSync(local);
            const r = await apiRaw(ctx, "POST", "/v0/machines/" + machine.id + "/fs",
              { op: "write", path: mpath, content: buf.toString("base64"), enc: "base64", hmr: false });
            if (!r.ok || !r.json.ok) throw new Error("failed writing " + mpath + ": " + (r.json.error || errText(r)));
          }
          console.log(" ---> copied " + copyFiles.length + " file(s) to " + destAbs);
        }
        // commit the INTERMEDIATE image (untagged, parent-chained) + record stepHash → digest.
        const ic = await apiRaw(ctx, "POST", "/v0/machines/" + machine.id + "/commit", {
          cacheHash: hash, parent: lastDigest || baseImage,
          message: "build step: " + renderStep(step),
          history: [{ step: renderStep(step), descriptor: desc, hash, parent }],
        });
        if (!ic.ok) throw new Error(errText(ic));
        lastDigest = ic.json.digest;
        console.log(" ---> " + lastDigest.replace(/^sha256:/, "").slice(0, 12));
        history.push({ step: renderStep(step), descriptor: desc, hash, parent });
      } else if (step.op === "env") {
        Object.assign(envAcc, step.env);
        for (const [k, v] of Object.entries(step.env)) changes.push(`ENV ${k}="${v}"`); // quoted: values may contain spaces
      } else if (step.op === "workdir") {
        workdir = step.dir;
        changes.push("WORKDIR " + step.dir);
        if (machine) await apiRaw(ctx, "POST", "/v0/machines/" + machine.id + "/fs", { op: "mkdir", path: step.dir });
      } else if (step.op === "cmd") changes.push("CMD " + JSON.stringify(step.argv));
      else if (step.op === "entrypoint") changes.push("ENTRYPOINT " + JSON.stringify(step.argv));
      else if (step.op === "expose") { for (const p of step.ports) changes.push("EXPOSE " + p); }
      else if (step.op === "label") { for (const [k, v] of Object.entries(step.labels)) changes.push(`LABEL ${k}="${v}"`); }
      else throw new Error("unknown step op: " + step.op);
      if (step.op !== "run" && step.op !== "copy") {
        history.push({ step: renderStep(step), descriptor: desc, hash, parent });
      }
    } catch (e) { await fail(i, step, e.message); }
  }

  // ---- finalize ----
  const message = "iso build (" + path.basename(buildFile) + ")";
  let finalDigest;
  if (machine) {
    // a machine ran (≥1 miss): final commit = full manifest (changes/history) over the same fs.
    const commit = await apiRaw(ctx, "POST", "/v0/machines/" + machine.id + "/commit",
      { repo, tag, message, changes, history, parent: baseImage });
    if (!commit.ok) { await cleanup(); die(apiErr(commit)); }
    finalDigest = commit.json.digest;
    console.log(" ---> committed " + finalDigest);
    if (flags.keep) console.log(" ---> keeping build machine " + shortId(machine.id) + " (--keep)");
    else await apiRaw(ctx, "DELETE", "/v0/machines/" + machine.id + "?force=1"); // docker removes intermediates
  } else if (lastDigest) {
    // fully cached: no machine — re-manifest + tag the last cached digest.
    const fin = await apiRaw(ctx, "POST", "/v0/images/finalize",
      { digest: lastDigest, repo, tag, message, changes, history, parent: baseImage });
    if (!fin.ok) die(apiErr(fin));
    finalDigest = lastDigest;
    console.log(" ---> committed " + finalDigest + " (fully cached — no machine booted)");
  } else {
    // no RUN/COPY steps at all (meta-only build): boot + commit once.
    await ensureMachine();
    const commit = await apiRaw(ctx, "POST", "/v0/machines/" + machine.id + "/commit",
      { repo, tag, message, changes, history, parent: baseImage });
    if (!commit.ok) { await cleanup(); die(apiErr(commit)); }
    finalDigest = commit.json.digest;
    await cleanup();
  }
  console.log("Successfully built " + finalDigest.replace(/^sha256:/, "").slice(0, 12));
  if (repo) console.log("Successfully tagged " + repo + ":" + tag);
}

// iso volume — checkpointed, driver-backed, versioned volumes (docs/volumes.md).
async function cmdVolume({ positional }) {
  const ctx = activeContext(loadState());
  const sub = positional[0];
  const rest = positional.slice(1);
  if (sub === "create") {
    const { flags, positional: pos } = parseFlags("volume", rest, {
      driver: { flags: ["--driver"], value: true, meta: "path", desc: "User driver module (.mjs) — runs SANDBOXED in an isolate" },
    });
    const name = pos[0] || die("usage: iso volume create <name> [--driver <module.mjs>]");
    const body = { name };
    if (flags.driver) body.driverPath = path.resolve(flags.driver);
    const r = await api(ctx, "POST", "/v0/volumes", body);
    console.log(r.name);
    return;
  }
  if (sub === "ls" || sub === "list" || !sub) {
    const list = await api(ctx, "GET", "/v0/volumes");
    printTable(["NAME", "DRIVER", "ATTACHED", "SNAPSHOTS", "CREATED"],
      (list || []).map((v) => [v.name, v.driver, v.attachedTo ? v.attachedTo.slice(0, 12) : "", v.snapshots, ago(v.createdAt)]));
    return;
  }
  const name = rest[0] || die("usage: iso volume " + sub + " <name>");
  if (sub === "rm") {
    const r = await api(ctx, "DELETE", "/v0/volumes/" + encodeURIComponent(name));
    console.log(r.removed || name);
    return;
  }
  if (sub === "inspect") {
    const r = await api(ctx, "GET", "/v0/volumes/" + encodeURIComponent(name));
    console.log(JSON.stringify([r], null, 4));
    return;
  }
  if (sub === "sync") {
    const r = await api(ctx, "POST", "/v0/volumes/" + encodeURIComponent(name) + "/sync");
    console.log("checkpointed " + r.digest + " (" + r.files + " files, " + r.size + " bytes)");
    return;
  }
  if (sub === "snapshot") {
    const r = await api(ctx, "POST", "/v0/volumes/" + encodeURIComponent(name) + "/snapshot");
    console.log("pinned " + r.digest);
    return;
  }
  if (sub === "rollback") {
    // ref syntax: name@digest-prefix
    const at = name.indexOf("@");
    if (at <= 0) die("usage: iso volume rollback <name>@<digest-prefix>");
    const r = await api(ctx, "POST", "/v0/volumes/" + encodeURIComponent(name.slice(0, at)) + "/rollback", { ref: name.slice(at + 1) });
    console.log("rolled back to " + r.digest);
    return;
  }
  die("Error: unknown volume subcommand: " + sub + "\nSee 'iso volume --help'.");
}

async function cmdNetwork({ positional }) {
  const ctx = activeContext(loadState());
  const sub = positional[0];
  const rest = positional.slice(1);
  if (sub === "create") {
    const { flags, positional: pos } = parseFlags("network", rest, {
      policy: { flags: ["--policy"], value: true, meta: "path", desc: "Egress policy module (.mjs) — governs ALL member egress, runs SANDBOXED in an isolate" },
    });
    const name = pos[0] || die("usage: iso network create <name> [--policy <module.mjs>]");
    const body = { name };
    if (flags.policy) {
      const p = path.resolve(flags.policy);
      if (!existsSync(p)) die("Error: policy module not found: " + p);
      body.policySource = readFileSync(p, "utf8");
    }
    const r = await api(ctx, "POST", "/v0/networks", body);
    console.log(r.name);
    return;
  }
  if (sub === "ls" || sub === "list" || !sub) {
    const list = await api(ctx, "GET", "/v0/networks");
    printTable(["NAME", "POLICY", "MEMBERS", "CREATED"],
      (list || []).map((n) => [n.name, n.hasPolicy ? "yes" : "(default: resolve members, allow egress)", String(n.members ?? 0), ago(n.createdAt)]));
    return;
  }
  const name = rest[0] || die("usage: iso network " + sub + " <name>");
  if (sub === "rm") {
    const r = await api(ctx, "DELETE", "/v0/networks/" + encodeURIComponent(name));
    console.log(r.removed || name);
    return;
  }
  if (sub === "inspect") {
    const r = await api(ctx, "GET", "/v0/networks/" + encodeURIComponent(name));
    console.log(JSON.stringify([r], null, 4));
    return;
  }
  if (sub === "logs") {
    // every fetch through the network — member egress, name-routes, policy verdicts.
    const { flags } = parseFlags("network", rest.slice(1), {
      follow: { flags: ["-f", "--follow"], desc: "Keep polling for new entries" },
    });
    let since = 0;
    const dump = async () => {
      const r = await api(ctx, "GET", "/v0/networks/" + encodeURIComponent(name) + "/logs?since=" + since);
      for (const e of r.entries || []) {
        since = Math.max(since, e.ts);
        console.log(`${new Date(e.ts).toISOString()} ${e.from.padEnd(12)} ${e.method.padEnd(6)} ${e.url} → ${e.outcome}${e.status !== undefined ? " (" + e.status + ")" : ""}`);
      }
    };
    await dump();
    if (flags.follow) { for (;;) { await new Promise((res) => setTimeout(res, 1000)); await dump(); } }
    return;
  }
  die("Error: unknown network subcommand: " + sub + "\nSee 'iso network --help'.");
}

// -------- iso update (self-update from GitHub releases) --------
// Privacy: the version check is ONE GitHub API call (api.github.com/…/releases/latest). It runs
// only during `iso update`/`iso update --check`, or opportunistically from `iso version` at most
// once per 24h; the result is cached in ~/.iso/update-check.json. No other command phones home.
const UPDATE_REPO = "netanelgilad/iso";
const UPDATE_CACHE = path.join(ISO_DIR, "update-check.json");
function semverLess(a, b) { // a < b
  const pa = String(a).replace(/^v/, "").split(".").map(Number), pb = String(b).replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d < 0; }
  return false;
}
async function fetchLatestRelease() {
  const res = await fetch("https://api.github.com/repos/" + UPDATE_REPO + "/releases/latest", {
    headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error("GitHub API: HTTP " + res.status);
  const j = await res.json();
  return { tag: j.tag_name, url: j.html_url, publishedAt: j.published_at };
}
function readUpdateCache() { try { return JSON.parse(readFileSync(UPDATE_CACHE, "utf8")); } catch { return null; } }
function writeUpdateCache(c) { try { mkdirSync(ISO_DIR, { recursive: true }); writeFileSync(UPDATE_CACHE, JSON.stringify(c, null, 2) + "\n"); } catch {} }
// opportunistic check used by `iso version`: live at most once per 24h, cached otherwise.
async function cachedUpdateCheck() {
  const c = readUpdateCache();
  if (c && Date.now() - (c.checkedAt || 0) < 24 * 3600 * 1000) return c;
  try {
    const latest = await fetchLatestRelease();
    const fresh = { checkedAt: Date.now(), latest: latest.tag, url: latest.url };
    writeUpdateCache(fresh);
    return fresh;
  } catch { return c; } // offline → stale cache (or nothing); never an error
}

async function cmdUpdate({ flags }) {
  let latest;
  try { latest = await fetchLatestRelease(); }
  catch (e) { die("Error: cannot check for updates (" + e.message + ") — are you online?"); }
  writeUpdateCache({ checkedAt: Date.now(), latest: latest.tag, url: latest.url });
  const cur = "v" + CLI_VERSION;
  if (!semverLess(cur, latest.tag)) {
    console.log("iso is up to date (" + cur + (latest.tag !== cur ? "; latest release is " + latest.tag : "") + ")");
    return;
  }
  console.log("update available: " + cur + " -> " + latest.tag + "   (" + latest.url + ")");
  if (flags.check) { console.log("run `iso update` to install it."); return; }
  // install by fetching + running the published installer — it is idempotent, installs
  // side-by-side under ~/.iso/dist/<version>, and flips the `current` symlink (so the running
  // `iso` on PATH points at the new version when it exits). Downgrades never happen: we only
  // get here when latest > current.
  console.log("installing " + latest.tag + " via the published installer…");
  const r = spawnSync("bash", ["-c",
    "curl -fsSL https://raw.githubusercontent.com/" + UPDATE_REPO + "/main/install.sh | ISO_VERSION=" + latest.tag + " bash"],
    { stdio: "inherit" });
  if (r.status !== 0) die("Error: update failed (installer exit " + r.status + "). You can retry with:\n  curl -fsSL https://raw.githubusercontent.com/" + UPDATE_REPO + "/main/install.sh | bash");
  console.log("");
  console.log("iso " + latest.tag + " installed.");
  const s = loadState();
  const endpoint = (s.active && s.contexts[s.active]?.host) || "http://127.0.0.1:8787";
  if (await pingHost(endpoint)) {
    console.log("the iso host is still running " + cur + " — restart it to finish the update:");
    console.log("  iso host stop && iso host start");
  } else {
    console.log("start the host to finish the update:  iso host start");
  }
}

async function cmdVersion() {
  console.log("Client:");
  console.log(" Version:    " + CLI_VERSION);
  console.log(" Node:       " + process.version);
  const s = loadState();
  const ctx = s.active && s.contexts[s.active];
  if (!ctx) { console.error("\n(no active context — no host to query; try `iso host start`)"); return; }
  console.log("\nServer: " + ctx.host);
  let r;
  try {
    const res = await fetch(ctx.host.replace(/\/$/, "") + "/v0/version", {
      headers: ctx.token ? { authorization: "Bearer " + ctx.token } : {}, signal: AbortSignal.timeout(30_000),
    });
    r = res.ok ? await res.json() : null;
  } catch { r = null; }
  if (!r) { console.error("Error: Cannot connect to the iso host at " + ctx.host + ". Is the host running? Try: iso host start"); process.exitCode = 1; return; }
  console.log(" Engine:");
  console.log("  Version:      " + r.version);
  console.log("  API version:  " + r.apiVersion);
  console.log("  Node:         " + r.node);
  console.log("  Workerd:      " + r.workerd);
  console.log("  PID:          " + r.pid);
  console.log("  Images:       " + (r.images || []).join(", "));
  // opportunistic update hint (cached, at most one API call per 24h — see cmdUpdate notes)
  const uc = await cachedUpdateCheck();
  if (uc?.latest && semverLess("v" + CLI_VERSION, uc.latest)) {
    console.log("\nupdate available: " + uc.latest + " — run 'iso update'");
  }
}

// -------- contexts (which iso host the CLI talks to) --------
async function cmdContext({ positional }) {
  const s = loadState();
  const sub = positional[0];
  if (sub === "create") {
    const { flags, positional: pos } = parseFlags("context", positional.slice(1), {
      host: { flags: ["--host"], value: true, meta: "url", desc: "Engine API endpoint" },
      token: { flags: ["--token"], value: true, meta: "string", desc: "Bearer token" },
    });
    const name = pos[0] || die("usage: iso context create <name> --host <url> [--token <t>]");
    if (!flags.host) die("Error: --host <url> is required");
    s.contexts[name] = { name, host: flags.host, token: flags.token };
    if (!s.active) s.active = name;
    saveState(s);
    console.log(`context '${name}' → ${flags.host}${s.active === name ? " (active)" : ""}`);
    return;
  }
  if (sub === "use") {
    const name = positional[1] || die("usage: iso context use <name>");
    if (!s.contexts[name]) die("Error: no such context: " + name);
    s.active = name; saveState(s);
    console.log(`active context: ${name} → ${s.contexts[name].host}`);
    return;
  }
  if (sub === "ls" || sub === "list" || !sub) {
    const names = Object.keys(s.contexts);
    if (!names.length) { console.log("(no contexts)"); return; }
    printTable(["NAME", "HOST"], names.map((n) => [(n === s.active ? "* " : "  ") + n, s.contexts[n].host]));
    return;
  }
  die("Error: unknown context subcommand: " + sub + "\nSee 'iso context --help'.");
}

// -------- local daemon management: iso host start|stop|status --------
function readPidFile() { try { return JSON.parse(readFileSync(PID_FILE, "utf8")); } catch { return null; } }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function pingHost(endpoint, timeoutMs = 2000) {
  try {
    const r = await fetch(endpoint + "/v0/version", { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
// Locate the daemon (packages/host/host.mjs) in the install layout.
function hostMjs() {
  if (existsSync(HOST_MJS)) return HOST_MJS;
  die("Error: cannot locate the iso host (" + HOST_MJS + ").\n" +
    "Reinstall iso, or set $ISO_HOST_MJS to packages/host/host.mjs.");
}
// Resolve the forked workerd binary and ensure it's ad-hoc code-signed (the release binary's
// signature is stripped on download; an unsigned/foreign-signed workerd is SIGKILLed on macOS).
// $MINIFLARE_WORKERD_PATH wins (already-signed, e.g. a dev build); otherwise re-sign the bundled
// binary into ~/.iso/run/workerd.bin, refreshing when the source is newer.
function resolveWorkerd() {
  if (process.env.MINIFLARE_WORKERD_PATH) return process.env.MINIFLARE_WORKERD_PATH;
  if (!existsSync(BUNDLED_WORKERD)) {
    die("Error: forked workerd binary not found at " + BUNDLED_WORKERD +
      "\n(reinstall iso, or set $MINIFLARE_WORKERD_PATH to a signed workerd-vfs binary)");
  }
  const stale = existsSync(SIGNED_WORKERD) && statSync(BUNDLED_WORKERD).mtimeMs > statSync(SIGNED_WORKERD).mtimeMs;
  if (!existsSync(SIGNED_WORKERD) || stale) {
    mkdirSync(path.dirname(SIGNED_WORKERD), { recursive: true });
    process.stderr.write((stale ? "refreshing" : "preparing") + " workerd runtime (ad-hoc code-sign)…\n");
    execSync(`cp "${BUNDLED_WORKERD}" "${SIGNED_WORKERD}" && chmod u+w "${SIGNED_WORKERD}" && xattr -c "${SIGNED_WORKERD}" && codesign -s - -f "${SIGNED_WORKERD}" && chmod +x "${SIGNED_WORKERD}"`, { stdio: "inherit" });
  }
  return SIGNED_WORKERD;
}
function ensureLocalContext(s, endpoint) {
  let name = Object.keys(s.contexts).find((n) => s.contexts[n].host === endpoint);
  if (!name) {
    name = s.contexts.local ? "local-" + new URL(endpoint).port : "local";
    s.contexts[name] = { name, host: endpoint };
  }
  if (!s.active || !s.contexts[s.active]) s.active = name;
  return name;
}
async function cmdHost({ flags, positional }) {
  const sub = positional[0];
  const s = loadState();
  const port = Number(flags.port || process.env.ISO_PORT || 8787);
  const endpoint = `http://127.0.0.1:${port}`;

  if (sub === "start") {
    if (await pingHost(endpoint)) {
      ensureLocalContext(s, endpoint); saveState(s);
      console.log("iso host is already running at " + endpoint);
      return;
    }
    const host = hostMjs();
    const workerd = resolveWorkerd();
    // first boot needs the base image rootfs — build it once into ~/.iso/base/.staging.
    // The staging is version-stamped (…/base/version): a mismatch after an upgrade triggers a
    // rebuild so overlay changes (launchers, coreutils, sh) actually land.
    const baseStaging = process.env.ISO_BASE_STAGING || path.join(ISO_DIR, "base", ".staging");
    const baseStamp = (() => { try { return readFileSync(path.join(path.dirname(baseStaging), "version"), "utf8").trim(); } catch { return null; } })();
    if (!existsSync(baseStaging) || baseStamp !== CLI_VERSION) {
      process.stderr.write((existsSync(baseStaging) ? "base image is from another iso version — rebuilding" : "base image rootfs missing — building it (one-time, ~30s)") + "…\n");
      const r = spawnSync(process.execPath, [BASE_BUILD_MJS], { stdio: "inherit", env: { ...process.env } });
      if (r.status !== 0) die("Error: base image build failed: node " + BASE_BUILD_MJS);
    }
    mkdirSync(ISO_DIR, { recursive: true });
    const fd = openSync(LOG_FILE, "a");
    const child = spawn(process.execPath, [host], {
      cwd: INSTALL_ROOT, detached: true, stdio: ["ignore", fd, fd],
      env: { ...process.env, MINIFLARE_WORKERD_PATH: workerd, ISO_PORT: String(port) },
    });
    child.unref();
    writeFileSync(PID_FILE, JSON.stringify({
      pid: child.pid, port, endpoint, host, workerd, startedAt: new Date().toISOString(),
    }, null, 2) + "\n");
    process.stderr.write(`starting iso host (pid ${child.pid}, logs: ${LOG_FILE})… waiting for the Engine API…\n`);
    const deadline = Date.now() + 120_000;
    let up = null;
    while (Date.now() < deadline) {
      if (!alive(child.pid)) {
        let tail = ""; try { tail = readFileSync(LOG_FILE, "utf8").split("\n").slice(-15).join("\n"); } catch {}
        die("Error: iso host exited during startup. Last log lines:\n" + tail);
      }
      up = await pingHost(endpoint, 15_000);
      if (up) break;
      await sleep(400);
    }
    if (!up) die("Error: iso host did not answer at " + endpoint + " within 120s (logs: " + LOG_FILE + ")");
    const ctxName = ensureLocalContext(s, endpoint);
    saveState(s);
    console.log("iso host started");
    console.log("  Engine API:  " + endpoint + "   (pid " + child.pid + ")");
    console.log("  dev proxy:   http://127.0.0.1:" + (port + 1) + "/");
    console.log("  context:     " + ctxName + (s.active === ctxName ? " (active)" : ""));
    return;
  }

  if (sub === "stop") {
    const rec = readPidFile();
    let stopped = false;
    if (rec && alive(rec.pid)) {
      try { process.kill(rec.pid, "SIGTERM"); } catch {}
      const deadline = Date.now() + 5000;
      while (alive(rec.pid) && Date.now() < deadline) await sleep(150);
      if (alive(rec.pid)) { try { process.kill(rec.pid, "SIGKILL"); } catch {} }
      console.log("stopped iso host (pid " + rec.pid + ")");
      stopped = true;
    }
    // stale-process fallback (README gotcha): orphaned forked-workerd procs wedge later runs.
    spawnSync("pkill", ["-9", "-f", "workerd-vfs|wd-test"], { stdio: "ignore" });
    let cleaned = 0;
    try {
      for (const e of readdirSync(os.tmpdir())) {
        if (e.startsWith("miniflare-")) { rmSync(path.join(os.tmpdir(), e), { recursive: true, force: true }); cleaned++; }
      }
    } catch {}
    try { rmSync(PID_FILE); } catch {}
    if (!stopped) console.log("no iso host pidfile" + (rec ? " process" : "") + " found; killed stray workerd processes" +
      (cleaned ? ` and removed ${cleaned} stale miniflare tmp dir(s)` : ""));
    else if (cleaned) console.log("removed " + cleaned + " stale miniflare tmp dir(s)");
    return;
  }

  if (sub === "status") {
    const rec = readPidFile();
    const ep = rec?.endpoint || endpoint;
    const up = await pingHost(ep, 10_000);
    if (up) {
      console.log("iso host is running");
      console.log("  Engine API:  " + ep + (rec ? "   (pid " + rec.pid + ", since " + rec.startedAt + ")" : ""));
      console.log("  version:     " + up.version + " (api " + up.apiVersion + ", node " + up.node + ")");
      console.log("  images:      " + (up.images || []).join(", "));
    } else {
      console.log("iso host is not running at " + ep + (rec && !alive(rec.pid) ? " (stale pidfile: " + PID_FILE + ")" : ""));
      process.exitCode = 1;
    }
    return;
  }

  die("Error: unknown host subcommand: " + (sub || "(none)") + "\nSee 'iso host --help'.");
}

// -------- the M3/M4 vite-flow verbs (kept as-is, now with name/prefix addressing) --------
async function cmdUseFork({ positional }) {
  const ref = positional[0] || usageError("use-fork", "requires at least 1 argument");
  const project = positional[1] || "myapp";
  const ctx = activeContext(loadState());
  const res = await api(ctx, "POST", "/v0/machines/" + encodeURIComponent(ref) + "/use-fork", { project });
  if (!res.ok) die("Error: " + (res.error || "use-fork failed"));
  console.log("repinned " + res.dir + " to the workerd forks:");
  console.log("  devDependencies.vite     = " + res.devDependencies.vite);
  console.log("  devDependencies.rolldown = " + res.devDependencies.rolldown);
}
async function cmdDev({ positional }) {
  const ref = positional[0] || usageError("dev", "requires at least 1 argument");
  const project = positional[1] || "myapp";
  const ctx = activeContext(loadState());
  const host = ctx.host.replace(/\/$/, "");
  const devPort = Number(new URL(ctx.host).port || 8787) + 1;
  process.stderr.write("warming vite dev server (this installs/boots vite+rolldown; ~30-90s cold)…\n");
  const warm = await api(ctx, "POST", "/v0/machines/" + encodeURIComponent(ref) + "/dev", { project, devPort });
  if (!warm.ok) die("Error: dev warmup failed: " + (warm.error || JSON.stringify(warm).slice(0, 300)));
  const set = await fetch(host + "/__dev?id=" + encodeURIComponent(ref)).then((r) => r.json())
    .catch((e) => die("Error: set-dev failed: " + e.message));
  console.log("vite dev server ready:");
  console.log("  open  " + set.devUrl);
  console.log("  (warmup: ms=" + (warm.ms ?? "?") + " deps=" + (warm.deps ?? "?") + ")");
}

// Thin WS client: open /v0/machines/{ref}/logs[?follow=1], print stdout/stderr frames live,
// surface meta lifecycle (started/exited/dropped) on stderr.
async function streamLogs(ctx, ref, follow) {
  const { WebSocket } = await import("ws");
  const wsUrl = ctx.host.replace(/^http/, "ws").replace(/\/$/, "") + "/v0/machines/" + encodeURIComponent(ref) + "/logs" + (follow ? "?follow=1" : "");
  const headers = {};
  if (ctx.token) headers.authorization = "Bearer " + ctx.token;
  await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { headers });
    let exitCode = 0;
    ws.on("message", (raw) => {
      let f; try { f = JSON.parse(raw.toString()); } catch { process.stdout.write(raw.toString()); return; }
      if (f.stream === "stdout") process.stdout.write(f.partial ? f.data : f.data + "\n");
      else if (f.stream === "stderr") process.stderr.write(f.partial ? f.data : f.data + "\n");
      else if (f.stream === "meta") {
        let m; try { m = JSON.parse(f.data); } catch { return; }
        if (m.event === "dropped") process.stderr.write(`… ${m.n} lines dropped\n`);
        else if (m.event === "exited") { exitCode = m.code || 0; if (follow) ws.close(); }
        else if (m.event === "error") process.stderr.write("Error: stream error: " + m.err + "\n");
      }
    });
    ws.on("close", () => { process.exitCode = exitCode; resolve(); });
    ws.on("error", (e) => { process.stderr.write("Error: iso logs: " + e.message + "\n"); process.exitCode = 1; resolve(); });
  });
}

// ---------------------------------------------------------------------------- command table
const MACHINE_REF = "MACHINE is a full id, a unique id prefix, or a name.";
const COMMANDS = {
  run: {
    group: "common", summary: "Create and run a command in a new machine",
    usage: "iso run [OPTIONS] IMAGE [COMMAND] [ARG...]", verbatimAfter: 2, fn: cmdRun,
    extra: "Flags may appear anywhere before COMMAND (before or after IMAGE). Everything from\n" +
      "COMMAND on is passed to the machine verbatim. With no COMMAND, the image manifest's\n" +
      "ENTRYPOINT/CMD run (-e and -w override manifest ENV/WORKDIR).",
    flags: {
      detach: { flags: ["-d", "--detach"], desc: "Run machine in background and print machine ID" },
      env: { flags: ["-e", "--env"], value: true, repeat: true, meta: "list", desc: "Set environment variables (KEY=VAL, repeatable)" },
      name: { flags: ["--name"], value: true, meta: "string", desc: "Assign a name to the machine (auto-generated if absent)" },
      publish: { flags: ["-p", "--publish"], value: true, repeat: true, meta: "list", desc: "Publish a machine port: hostPort[:machinePort] (bare hostPort uses the manifest EXPOSE)" },
      volume: { flags: ["-v", "--volume"], value: true, repeat: true, meta: "list", desc: "Attach a volume: name:/mount/path (checkpoint semantics; exclusive)" },
      network: { flags: ["--network", "--net"], value: true, meta: "string", desc: "Connect the machine to a network (members resolve each other by --name; egress transits the network policy)" },
      workdir: { flags: ["-w", "--workdir", "--cwd"], value: true, meta: "string", desc: "Working directory inside the machine" },
    },
  },
  exec: {
    group: "common", summary: "Execute a command in an existing machine (shared /tmp)",
    usage: "iso exec [OPTIONS] MACHINE COMMAND [ARG...]", verbatimAfter: 2, fn: cmdExec,
    extra: MACHINE_REF + "\nWith -i, local stdin is attached to the command's REAL process.stdin (line-oriented,\n" +
      "no PTY); EOF (Ctrl-D / pipe end) propagates; Ctrl-C detaches (the command keeps running).",
    flags: {
      detach: { flags: ["-d", "--detach"], desc: "Detached mode: run in the background" },
      interactive: { flags: ["-i", "--interactive"], desc: "Keep stdin open and attached (bidirectional session)" },
      tty: { flags: ["-t", "--tty"], desc: "Ignored with a warning — the platform has no PTY" },
      env: { flags: ["-e", "--env"], value: true, repeat: true, meta: "list", desc: "Set environment variables (KEY=VAL, repeatable)" },
      workdir: { flags: ["-w", "--workdir", "--cwd"], value: true, meta: "string", desc: "Working directory inside the machine" },
    },
  },
  ps: {
    group: "common", summary: "List machines",
    usage: "iso ps [OPTIONS]", fn: cmdPs,
    flags: {
      all: { flags: ["-a", "--all"], desc: "Show all machines (default hides exited)" },
      quiet: { flags: ["-q", "--quiet"], desc: "Only display machine IDs" },
    },
  },
  logs: {
    group: "common", summary: "Fetch the output of a machine (replay; -f follows live)",
    usage: "iso logs [OPTIONS] MACHINE", fn: cmdLogs, extra: MACHINE_REF,
    flags: { follow: { flags: ["-f", "--follow"], desc: "Follow log output live" } },
  },
  volume: {
    group: "mgmt", summary: "Manage volumes (checkpointed persistent trees; docs/volumes.md)",
    usage: "iso volume create <name> [--driver m.mjs] | ls | rm <n> | inspect <n> | sync <n> | snapshot <n> | rollback <n>@<digest>",
    fn: cmdVolume, verbatimAfter: 1, flags: {},
    extra: "CHECKPOINT semantics, honestly labeled: copy-in at machine boot, copy-out on graceful\n" +
      "`iso rm` and explicit `sync`. A crashed/evicted machine loses writes since the last\n" +
      "checkpoint. Attach is EXCLUSIVE (one live machine per volume). Every checkpoint is a\n" +
      "content-addressed snapshot; retention keeps pinned + the last 5 automatics. User driver\n" +
      "modules run SANDBOXED in an isolate (no fs, no daemon access — egress fetch only).",
  },
  network: {
    group: "mgmt", summary: "Manage networks (the network is a JS function; docs/networks.md)",
    usage: "iso network create <name> [--policy m.mjs] | ls | rm <n> | inspect <n> | logs <n> [-f]",
    fn: cmdNetwork, verbatimAfter: 1, flags: {},
    extra: "Members resolve each other BY MACHINE NAME (http://<name>:<port>/... routes into that\n" +
      "member's serving process — no DNS, no published ports). With --policy, EVERY member\n" +
      "egress (machine-to-machine AND internet, grandchildren included) transits the policy's\n" +
      "proxy(request, ctx) — user JS running SANDBOXED in a per-network isolate. No policy =\n" +
      "resolve members, allow egress. `logs` shows every fetch the network saw. v1: one\n" +
      "network per machine; policy reload = rm + recreate.",
  },
  top: {
    group: "common", summary: "Display the process tree of a machine",
    usage: "iso top MACHINE", fn: cmdTop,
    extra: "PID/PPID come from the Machine DO's process table (the kernel model): exec sessions,\n" +
      "their commands, and every child spawned via the spawn syscall. Exited entries stay\n" +
      "visible briefly, marked exited(code). " + MACHINE_REF, flags: {},
  },
  build: {
    group: "common", summary: "Build an image from an iso.build.mjs step graph",
    usage: "iso build [OPTIONS] CONTEXT", fn: cmdBuild,
    extra: "CONTEXT is a directory; its iso.build.mjs (a JS module default-exporting a step graph\n" +
      "built with the iso-sdk's from(...)) is imported and executed with docker cache semantics:\n" +
      "each RUN/COPY step commits an untagged intermediate image keyed by its chain hash; on\n" +
      "rebuild, consecutive hits print ' ---> Using cache' and skip execution (COPY is content-\n" +
      "addressed). The build program runs in the CLI's own node process (classic-builder tradeoff).",
    flags: {
      tag: { flags: ["-t", "--tag"], value: true, meta: "repo[:tag]", desc: "Name (and optionally tag) the built image" },
      file: { flags: ["-f", "--file"], value: true, meta: "path", desc: "Build file (default: <context>/iso.build.mjs)" },
      nocache: { flags: ["--no-cache"], desc: "Do not use the per-step cache when building (fresh entries are still written)" },
      keep: { flags: ["--keep"], desc: "Keep the build machine instead of removing it" },
    },
  },
  commit: {
    group: "common", summary: "Create a new image from a machine's filesystem",
    usage: "iso commit [OPTIONS] MACHINE [REPOSITORY[:TAG]]", fn: cmdCommit,
    extra: "Snapshots the machine's whole /tmp (excluding npm cache + probe scratch) into a\n" +
      "content-addressed image (digest = sha256 of the snapshot). " + MACHINE_REF,
    flags: {
      message: { flags: ["-m", "--message"], value: true, meta: "string", desc: "Commit message (recorded in the manifest)" },
      change: { flags: ["--change"], value: true, repeat: true, meta: "list", desc: 'Apply a manifest instruction (ENV/WORKDIR/CMD/ENTRYPOINT/EXPOSE/LABEL), e.g. --change "CMD node app.js"' },
    },
  },
  images: {
    group: "common", summary: "List images available on the active host",
    usage: "iso images [OPTIONS]", fn: cmdImages,
    flags: { all: { flags: ["-a", "--all"], desc: "Show all images (default hides untagged build-cache intermediates)" } },
  },
  tag: {
    group: "common", summary: "Create a new name for an image (same digest)",
    usage: "iso tag SRC_IMAGE [REGISTRY-HOST/]REPO[:TAG]", fn: cmdTag,
    extra: "Docker ref syntax: the first path component is a registry HOST iff it contains ':'\n" +
      "or '.' or is 'localhost' (e.g. localhost:5000/hello:v1). Default tag: latest.", flags: {},
  },
  push: {
    group: "common", summary: "Push an image to an iso registry",
    usage: "iso push [OPTIONS] REGISTRY-HOST/REPO[:TAG]", fn: cmdPush,
    extra: "The DAEMON transfers (docker-style): HEAD blob (dedupe) → PUT blob (sha256-verified\n" +
      "server-side) → PUT manifest. Tag the image with the registry-qualified name first.",
    flags: { token: { flags: ["--token", "-u"], value: true, meta: "string", desc: "Registry bearer token" } },
  },
  pull: {
    group: "common", summary: "Pull an image from an iso registry",
    usage: "iso pull [OPTIONS] REGISTRY-HOST/REPO[:TAG]", fn: cmdPull,
    extra: "GET manifest → fetch the snapshot blob if missing locally → store + tag under the\n" +
      "registry-qualified name.",
    flags: { token: { flags: ["--token", "-u"], value: true, meta: "string", desc: "Registry bearer token" } },
  },
  rmi: {
    group: "common", summary: "Remove one or more images",
    usage: "iso rmi IMAGE [IMAGE...]", fn: cmdRmi,
    extra: "IMAGE is a repo[:tag], sha256:<digest>, or a unique digest prefix. A repo:tag ref\n" +
      "untags; the image blob is deleted when its last tag goes. A digest ref deletes outright.",
    flags: {},
  },
  inspect: {
    group: "common", summary: "Display detailed information on machines or images",
    usage: "iso inspect NAME [NAME...]", fn: cmdInspect,
    extra: "Precedence: machine refs first (id | id prefix | name), then image refs\n(repo[:tag] | digest | digest prefix).", flags: {},
  },
  cp: {
    group: "common", summary: "Copy a file between a machine and the local filesystem",
    usage: "iso cp MACHINE:SRC_PATH DEST_PATH\n\tiso cp SRC_PATH MACHINE:DEST_PATH", fn: cmdCp,
    extra: "Single files only (machine paths must be absolute). " + MACHINE_REF, flags: {},
  },
  rm: {
    group: "common", summary: "Remove one or more machines",
    usage: "iso rm [OPTIONS] MACHINE [MACHINE...]", fn: cmdRm, extra: MACHINE_REF,
    flags: { force: { flags: ["-f", "--force"], desc: "Force the removal of a running machine" } },
  },
  host: {
    group: "mgmt", summary: "Manage the LOCAL iso host daemon",
    usage: "iso host start|stop|status [--port N]", fn: cmdHost,
    extra: "start:  spawn the iso host daemon detached (resolves + ad-hoc-signs the forked\n" +
      "        workerd binary, builds the base image on first boot, writes ~/.iso/host.pid,\n" +
      "        waits for the Engine API, and points a 'local' context at it)\n" +
      "stop:   kill via the pidfile, then clean stray workerd procs + $TMPDIR/miniflare-*\n" +
      "status: ping the Engine API",
    flags: { port: { flags: ["--port"], value: true, meta: "N", desc: "Engine API port (default 8787; dev proxy is port+1)" } },
  },
  context: {
    group: "mgmt", summary: "Manage contexts (which iso host the CLI talks to)",
    usage: "iso context create <name> --host <url> [--token <t>] | use <name> | ls", fn: cmdContext,
    verbatimAfter: 1, flags: {}, // subcommand flags (--host/--token) are parsed by the subcommand
  },
  "use-fork": {
    group: "experimental", summary: "Repin a scaffolded project's deps to the workerd-compatible vite fork",
    usage: "iso use-fork MACHINE [PROJECT]", fn: cmdUseFork,
    extra: MACHINE_REF + "\nExperimental. Rewrites a scaffolded project's package.json to the published\nworkerd-compatible @netanelgilad/vite + rolldown forks so it runs under iso.", flags: {},
  },
  dev: {
    group: "experimental", summary: "Boot a vite dev server for a project inside a machine",
    usage: "iso dev MACHINE [PROJECT]", fn: cmdDev,
    extra: MACHINE_REF + "\nExperimental. Warms a vite dev server in the machine and routes it through the\nhost dev proxy (pair with `iso use-fork`).", flags: {},
  },
  update: {
    group: "mgmt", summary: "Update iso to the latest release",
    usage: "iso update [--check]", fn: cmdUpdate,
    extra: "Checks the latest GitHub release and, if newer, installs it via the published\n" +
      "installer (side-by-side under ~/.iso/dist/<version>; the `iso` symlink flips on\n" +
      "success). Restart the host afterwards: iso host stop && iso host start.\n" +
      "Privacy: this is one GitHub API call; only `update`, `update --check`, and a >=24h\n" +
      "cached check from `iso version` ever phone home.",
    flags: { check: { flags: ["--check"], desc: "Only report whether an update is available (dry run)" } },
  },
  version: {
    group: "mgmt", summary: "Show the iso client and host version information",
    usage: "iso version", fn: cmdVersion, flags: {},
  },
};

// ---------------------------------------------------------------------------- main
async function main() {
  const [, , cmdName, ...rest] = process.argv;
  if (!cmdName || cmdName === "help" || cmdName === "-h" || cmdName === "--help") { topHelp(); return; }
  const c = COMMANDS[cmdName];
  if (!c) die(`iso: '${cmdName}' is not an iso command.\nSee 'iso --help'`);
  const parsed = parseFlags(cmdName, rest, c.flags, c.verbatimAfter ?? Infinity);
  if (parsed.help) { console.log(helpFor(cmdName)); return; }
  await c.fn(parsed);
}

main().catch((e) => die("Error: " + (e?.stack || String(e))));
