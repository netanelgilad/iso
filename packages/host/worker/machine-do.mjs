// iso MACHINE DO — the generalized "container". This is `NpmBaseImage` from
// base-image/worker/driver-do.mjs promoted into a reusable Machine, with Track B's STREAMING
// logs merged in (see experiments/iso-streaming/). The batch tail of runNodeChild (the old
// probeSrc `out.push` buffer + QUIET/MAX settle loop) is replaced by:
//
//   sub-isolate stdout/stderr  -- framed per line -->  RPC WritableStream  -->  per-stream
//   LogStream (bounded ring + WS fan-out + replay)  -->  `iso logs -f` subscribers.
//
//   boot(image)                 unpack a rootfs manifest into native /tmp via SYNC writes (idempotent)
//   run(cmd, args, env, cwd, o)  resolveBinToJs → run JS entry as a SUB-ISOLATE, streaming output.
//                                o.detach → return immediately (`iso run -d`); else settle + return
//                                {code, stdout, stderr} reconstructed from the stream ring.
//
// workerd-isms that are load-bearing:
//   - Heavy toolchains (npm) run in a child with `vfsModuleFallback` (CHILD-ONLY flag); the DO
//     itself has no module fallback (do-shell finding). npm's stdout still streams via the sink.
//   - workerd forbids async I/O / timers in a module's GLOBAL scope → the child probe does its
//     async work INSIDE run(), not at module top level (Track B finding).
//   - process.report.getReport() segfaults workerd → stubbed.
//   - CHILD->DO transport: a WritableStream handed in over RPC streams chunks incrementally
//     (Track B probe case "a"); globalOutbound fetch does NOT route here.
import { Buffer } from "node:buffer";
import * as nodeFs from "node:fs";

const CHILD_FLAGS = ["nodejs_compat", "nodejs_compat_v2", "experimental", "enable_nodejs_fs_module",
  // node:http SERVER compat: an unmodified `createServer().listen(port)` works in a child, and
  // requests route in via cloudflare:node's handleAsNodeRequest({port}, request) — how published
  // ports (-p) reach a machine's serving process (the registry-on-the-platform capstone).
  "enable_nodejs_http_modules", "enable_nodejs_http_server_modules"];
// The runtime compat level every machine's children run with. Exported: the host stamps it
// into image manifests (runtime.compatDate) and the control plane enforces it at `iso run`.
export const CHILD_COMPAT_DATE = "2026-06-01";
// Per-stream ring bound. Sized for a prototype; a real host sizes to memory budget + spills the
// tail to DO storage (Track B notes the spill is stubbed — `dropped` is counted, not persisted).
const RING_MAX = 2000;

function installGlobals(env) {
  globalThis.__UNSAFE_EVAL = env.UNSAFE_EVAL;
  globalThis.__wasmCompile = async (b) => env.UNSAFE_EVAL.newWasmModule(b instanceof Uint8Array ? b : new Uint8Array(b));
  globalThis.__safeEval = (c) => env.UNSAFE_EVAL.eval(String(c));
  globalThis.__newFunction = (...a) => { const body = a.pop(); return env.UNSAFE_EVAL.newFunction(String(body), "anonymous", ...a); };
}

async function patchProcessReport() {
  const stub = { excludeNetwork: true, getReport: () => ({ header: {}, sharedObjects: [] }) };
  const targets = new Set([process, globalThis.process]);
  try { const m = await import("node:process"); targets.add(m.default); targets.add(m); } catch {}
  for (const t of targets) { if (!t) continue; try { Object.defineProperty(t, "report", { configurable: true, value: stub }); } catch {} }
}

// Child cfg: a streaming probe whose run(writable, stdinReadable, ctx) frames output into the
// WritableStream. vfsModuleFallback lets the child import() absolute /tmp paths (the entries we
// wrote to the shared fs); shareParentTmp shares the DO's /tmp.
function childCfg(probeSrc, outbound) {
  return {
    compatibilityDate: CHILD_COMPAT_DATE, compatibilityFlags: CHILD_FLAGS, allowExperimental: true,
    shareParentTmp: true, vfsModuleFallback: true,
    allowSpawn: true,    // fork primitive: the child's NATIVE child_process.spawn launches sub-isolates (recursively)
    drainProcess: true,  // fork primitive: run to event-loop quiescence; the parent's await is waitpid.
    // NOTE: drainProcess on EVERY generic child, not just fire-and-forget bins — nested native
    // spawns from a NON-drain child hit EPERM on VFS writes (verified live; fork behavior), and
    // drain semantics are compatible with awaited-main sessions (the DO closes the stdin pipe
    // before awaiting waitpid, so quiescence is reachable).
    //
    // NETWORKS (docs/networks.md): a NETWORKED machine's children get this machine's DO as
    // their globalOutbound — every fetch arrives at the DO (identity intact) and is forwarded
    // to the control plane's egress governor. Native-spawned grandchildren spawn WITHOUT an
    // explicit globalOutbound, and workerd's worker-loader then INHERITS the calling worker's
    // outbound channel (worker-loader.c++, "Inherit the calling worker's global outbound") — so
    // the whole process tree transits the governor; there is no grandchild escape (probed live).
    // Non-networked machines: no override → direct egress, today's behavior byte for byte.
    ...(outbound ? { globalOutbound: outbound } : {}),
    mainModule: "main.js", modules: { "main.js": probeSrc },
  };
}

// M4: the vite-dev child. mainModule must CONSTRUCT even when the loader recreates the child (its
// Worker-Loader instance can be evicted between requests), so it's a tiny WorkerEntrypoint that
// DYNAMICALLY imports the probe from the VFS on first use — construction never touches the VFS.
// (Ported VERBATIM from do-machine-clean/worker/driver-do.mjs viteDevChild; devRoot = the project
// dir so the probe's bare imports resolve against <project>/node_modules.) DEV_ROOT/probe path are
// the project dir, not /tmp/proj — iso scaffolds the probe into the project.
function viteDevChild(devPort, probePath) {
  return {
    compatibilityDate: CHILD_COMPAT_DATE,
    compatibilityFlags: CHILD_FLAGS,
    allowExperimental: true,
    shareParentTmp: true,
    vfsModuleFallback: true,
    env: { DEV_PORT: String(devPort ?? "") },
    mainModule: "main.js",
    modules: {
      "main.js": `
        import { WorkerEntrypoint } from "cloudflare:workers";
        let _impl;
        async function impl() {
          if (!_impl) _impl = (await import(${JSON.stringify(probePath)})).default;
          return _impl;
        }
        export default class extends WorkerEntrypoint {
          async #inst() {
            const I = await impl();
            const ctx = this.ctx ?? { waitUntil() {}, passThroughOnException() {} };
            if (!ctx.waitUntil) ctx.waitUntil = () => {};
            const inst = new I(ctx, this.env);
            inst.ctx = ctx; inst.env = this.env;
            return inst;
          }
          async warmup() { return (await this.#inst()).warmup(); }
          async fetch(request) { return (await this.#inst()).fetch(request); }
          async applyEdit(file) { return (await this.#inst()).applyEdit(file); }
        }
      `,
    },
  };
}

// REBASED onto fork primitives (allowSpawn / drainProcess): npm — including `npm create` —
// runs as the LITERAL bin in a drainProcess child; its own child_process.spawn is workerd-NATIVE
// (allowSpawn) and recursive. The old routes this replaced (programmatic npm entry, the Arborist
// create path, the DO spawn RPC syscall, the SELF-fetch spawn bridge) are deleted.

function tokenize(line) {
  const out = []; let cur = "", q = null, has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === q) q = null; else if (q === '"' && ch === "\\" && i + 1 < line.length) cur += line[++i]; else cur += ch; }
    else if (ch === "'" || ch === '"') { q = ch; has = true; }
    else if (ch === "\\" && i + 1 < line.length) { cur += line[++i]; has = true; }
    else if (ch === " " || ch === "\t" || ch === "\n") { if (has || cur) { out.push(cur); cur = ""; has = false; } }
    else { cur += ch; has = true; }
  }
  if (has || cur) out.push(cur);
  return out;
}
function resolveArgv(file, args = []) {
  const base = String(file || "").split("/").pop();
  if ((base === "sh" || base === "bash" || base === "zsh") && args[0] === "-c") return tokenize(args[1] || "");
  return [file, ...args];
}
function realOrSelf(fs, p) { try { return fs.realpathSync(p); } catch { return p; } }
function walkDir(fs, dir, base) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = dir + "/" + e.name;
    if (e.isDirectory()) out.push(...walkDir(fs, p, base)); else out.push(p.slice(base.length + 1));
  }
  return out;
}
function scanNmForBin(fs, nm, cmd) {
  let names = []; try { names = fs.readdirSync(nm); } catch { return null; }
  const dirs = [];
  for (const n of names) { if (n.startsWith("@")) { try { for (const s of fs.readdirSync(nm + "/" + n)) dirs.push(n + "/" + s); } catch {} } else dirs.push(n); }
  for (const d of dirs) {
    let pkg; try { pkg = JSON.parse(fs.readFileSync(nm + "/" + d + "/package.json", "utf8")); } catch { continue; }
    const bin = pkg.bin, short = String(pkg.name || "").split("/").pop();
    if (typeof bin === "string" && (pkg.name === cmd || short === cmd)) return nm + "/" + d + "/" + bin.replace(/^\.\//, "");
    if (bin && typeof bin === "object" && bin[cmd]) return nm + "/" + d + "/" + String(bin[cmd]).replace(/^\.\//, "");
  }
  return null;
}
function resolveBinToJs(fs, cmd, options) {
  if (cmd.startsWith("/") && fs.existsSync(cmd)) return realOrSelf(fs, cmd);
  const dirs = String((options.env || {}).PATH || "").split(":").filter(Boolean);
  for (const dir of dirs) { const cand = dir + "/" + cmd; try { if (fs.existsSync(cand)) return realOrSelf(fs, cand); } catch {} }
  for (const dir of dirs) { if (dir.endsWith("/.bin")) { const hit = scanNmForBin(fs, dir.slice(0, -5), cmd); if (hit) return hit; } }
  return null;
}

// ---- STREAMING child probes (replace the old batch probeSrc). Both write framed lines to the
// WritableStream handed in over RPC; the DO reads them live and pushes to the LogStream ring. ----

// Shared prologue: fake process state, line-buffer stdout/stderr into JSON frames on `writable`.
// (Copied/adapted from iso-streaming/worker/stream-do.mjs streamingProbeSrc.)
function streamPrologue() {
  return `
      const w = writable.getWriter();
      const enc = new TextEncoder();
      let seq = 0;
      const frame = (stream, data, partial) => { try { return w.write(enc.encode(JSON.stringify({ stream, data, seq: seq++, t: Date.now(), ...(partial ? { partial: true } : {}) }) + "\\n")).catch(() => {}); } catch { return Promise.resolve(); } };
      const np = await import("node:process");
      const { Readable } = await import("node:stream");
      // REAL child stdin: a genuine Readable (paused + flowing modes both behave normally,
      // isTTY:false) fed by the RPC stream from the DO, which owns the attach socket. EOF
      // propagates: DO-side writer close → push(null) → 'end' in the child.
      const nodeStdin = new Readable({ read() {} });
      nodeStdin.isTTY = false;
      (async () => {
        try {
          const rr = stdinReadable.getReader();
          while (true) { const { value, done } = await rr.read(); if (done) break; nodeStdin.push(Buffer.from(value)); }
        } catch {}
        try { nodeStdin.push(null); } catch {}
      })();
      const stub = { excludeNetwork: true, getReport: () => ({ header: {}, sharedObjects: [] }) };
      for (const proc of new Set([np.default, np, globalThis.process].filter(Boolean))) {
        try { proc.argv = ARGV.slice(); } catch {}
        try { proc.cwd = () => CWD; } catch { try { Object.defineProperty(proc, "cwd", { configurable: true, value: () => CWD }); } catch {} }
        try { proc.env = Object.assign(proc.env || {}, ENV); } catch {}
        try { Object.defineProperty(proc, "stdin", { configurable: true, get: () => nodeStdin }); } catch {}
        try { Object.defineProperty(proc, "report", { configurable: true, value: stub }); } catch {}
      }
      let exitCode = null;
      try { np.default.exit = (c) => { exitCode = (c == null ? 0 : c); throw { __ISOLATE_EXIT__: exitCode }; }; } catch {}
      const buf = { stdout: "", stderr: "" };
      // Line framing + a partial flush: a chunk with no newline (an interactive PROMPT) is framed
      // after 40ms with partial:true so it reaches the attach client instead of sitting buffered.
      const flushT = { stdout: null, stderr: null };
      const flushPartial = (stream) => { flushT[stream] = null; if (buf[stream]) { frame(stream, buf[stream], true); buf[stream] = ""; } };
      const emit = (stream, s) => {
        buf[stream] += s;
        let nl; while ((nl = buf[stream].indexOf("\\n")) >= 0) { frame(stream, buf[stream].slice(0, nl)); buf[stream] = buf[stream].slice(nl + 1); }
        if (buf[stream] && flushT[stream] == null) flushT[stream] = setTimeout(() => flushPartial(stream), 40);
      };
      const enc2 = (a) => a.map((x) => typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()).join(" ");
      console.log = (...a) => emit("stdout", enc2(a) + "\\n");
      console.info = (...a) => emit("stdout", enc2(a) + "\\n");
      console.warn = (...a) => emit("stderr", enc2(a) + "\\n");
      console.error = (...a) => emit("stderr", enc2(a) + "\\n");
      try { np.default.stdout.write = (s) => { emit("stdout", typeof s === "string" ? s : String(s)); return true; }; } catch {}
      try { np.default.stderr.write = (s) => { emit("stderr", typeof s === "string" ? s : String(s)); return true; }; } catch {}`;
}
function streamEpilogue() {
  return `
      for (const k of ["stdout", "stderr"]) { if (flushT[k] != null) { clearTimeout(flushT[k]); flushT[k] = null; } }
      if (buf.stdout) frame("stdout", buf.stdout, true);
      if (buf.stderr) frame("stderr", buf.stderr, true);
      await frame("meta", JSON.stringify({ event: "exited", code: exitCode == null ? 0 : exitCode, importErr }));
      await w.close();
      return { code: exitCode == null ? 0 : exitCode, importErr };`;
}

// Generic bin probe: import the resolved bin entry INSIDE run() (workerd bans top-level async),
// streaming whatever it writes. argv/cwd/env are baked. Settles when import resolves or exit traps.
function streamingProbeSrc(entry, args, cwd, envObj) {
  return `
  import { WorkerEntrypoint } from "cloudflare:workers";
  export default class extends WorkerEntrypoint {
    // published-port bridge: the process may run an UNMODIFIED node:http server
    // (createServer().listen(port)); the DO forwards published-port requests here, and
    // cloudflare:node's handleAsNodeRequest routes them into the listening server by port.
    // Request bodies are RE-CHUNKED to 1MB pieces first: the fork's http-server body pump
    // costs ~10ms PER CHUNK regardless of size (a 20MB body at the default 4KB chunking takes
    // ~50s and trips the hang detector; at 1MB chunks it takes ~6ms — measured; fork gap).
    async fetch(request) {
      const port = Number(request.headers.get("x-iso-port") || "0");
      try {
        const { handleAsNodeRequest } = await import("cloudflare:node");
        let req = request;
        if (request.body && request.method !== "GET" && request.method !== "HEAD") {
          const buf = new Uint8Array(await request.arrayBuffer());
          const CS = 1 << 20;
          const body = new ReadableStream({
            start(c) { for (let i = 0; i < buf.length; i += CS) c.enqueue(buf.slice(i, i + CS)); c.close(); },
          });
          req = new Request(request.url, { method: request.method, headers: request.headers, body, duplex: "half" });
        }
        return await handleAsNodeRequest({ port }, req);
      } catch (e) {
        return new Response(JSON.stringify({ error: "no server listening on port " + port + " in this process: " + String(e && e.message || e) }), { status: 502, headers: { "content-type": "application/json" } });
      }
    }
    async run(writable, stdinReadable, ctx) {
      const ENTRY = ${JSON.stringify(entry)};
      const ARGV = ${JSON.stringify(["node", entry, ...args])};
      const CWD = ${JSON.stringify(cwd)};
      const ENV = ${JSON.stringify(envObj)};
      ${streamPrologue()}
      let importErr = null, hadDefault = false, lastWrite = Date.now();
      const _emit0 = emit;            // wrap emit to track last-output time for the settle poll
      const trackEmit = (s, x) => { lastWrite = Date.now(); return _emit0(s, x); };
      console.log = (...a) => trackEmit("stdout", enc2(a) + "\\n");
      console.info = (...a) => trackEmit("stdout", enc2(a) + "\\n");
      console.warn = (...a) => trackEmit("stderr", enc2(a) + "\\n");
      console.error = (...a) => trackEmit("stderr", enc2(a) + "\\n");
      try { np.default.stdout.write = (s) => { trackEmit("stdout", typeof s === "string" ? s : String(s)); return true; }; } catch {}
      try { np.default.stderr.write = (s) => { trackEmit("stderr", typeof s === "string" ? s : String(s)); return true; }; } catch {}
      await frame("meta", JSON.stringify({ event: "started", entry: ENTRY }));
      try {
        // Load the entry via synchronous IN-CONTEXT require (the fork's process model: a dynamic
        // import()'s microtask checkpoint would drop the IoContext, killing top-level I/O) — so
        // REAL node-style scripts (top-level code) run as written, with drainProcess owning their
        // async tail. A module that instead exposes a default async main() (the older machine
        // convention; iso-tick, sh) is awaited directly. import() remains the fallback.
        const modns = await import("node:module");
        const req = modns.createRequire(CWD + "/__iso__.js");
        let mod = null;
        try { mod = req(ENTRY); }
        catch (e) { if (e && typeof e === "object" && "__ISOLATE_EXIT__" in e) throw e; mod = await import(ENTRY); }
        // require(ESM-with-default) returns the default FUNCTION itself; import() nests it.
        const mainFn = (mod && typeof mod.default === "function") ? mod.default : (typeof mod === "function" ? mod : null);
        if (mainFn) { hadDefault = true; await mainFn(); }
      }
      catch (e) { if (e && typeof e === "object" && "__ISOLATE_EXIT__" in e) exitCode = e.__ISOLATE_EXIT__; else importErr = String(e && e.stack || e); }
      // Side-effect bins (no awaited default) kick off async work un-awaited; settle on
      // process.exit, else on output quiescence, capped. (create-vite-spike's proven poll.)
      if (!hadDefault && exitCode === null) {
        const QUIET = 1200, MAX = 60000, t0s = Date.now();
        while (exitCode === null && (Date.now() - t0s) < MAX) {
          if (Date.now() - lastWrite > QUIET) break;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      ${streamEpilogue()}
    }
  }`;
}

// LITERAL-BIN drain probe (the fork's process model, streaming sink): synchronous
// `require(entry)` IN-CONTEXT (a dynamic import()'s microtask checkpoint would drop the
// IoContext), fire-and-forget — `drainProcess: true` then runs the isolate to true event-loop
// quiescence and the parent's `await run()` is waitpid. Unlike the fork's own spawn probe
// (which logs to VFS files), output flows LIVE through the RPC WritableStream into the
// LogStream. process.exit records + emits the exit meta frame WITHOUT throwing (npm's
// exit-handler calls it from a write-callback chain during the drain — the fork driver's
// non-throwing pattern); write callbacks are honored for the same reason.
function streamingDrainBinProbeSrc(entry, argv, cwd, envObj) {
  return `
  import { WorkerEntrypoint } from "cloudflare:workers";
  export default class extends WorkerEntrypoint {
    async run(writable, stdinReadable, ctx) {
      const w = writable.getWriter();
      const enc = new TextEncoder();
      let seq = 0;
      const frame = (stream, data, partial) => { try { return w.write(enc.encode(JSON.stringify({ stream, data, seq: seq++, t: Date.now(), ...(partial ? { partial: true } : {}) }) + "\\n")).catch(() => {}); } catch { return Promise.resolve(); } };
      const np = await import("node:process");
      const mod = await import("node:module");
      const { Readable } = await import("node:stream");
      const nodeStdin = new Readable({ read() {} });
      nodeStdin.isTTY = false;
      (async () => {
        try {
          const rr = stdinReadable.getReader();
          while (true) { const { value, done } = await rr.read(); if (done) break; nodeStdin.push(Buffer.from(value)); }
        } catch {}
        try { nodeStdin.push(null); } catch {}
      })();
      const reportStub = { excludeNetwork: true, getReport: () => ({ header: {}, sharedObjects: [] }) };
      let exitCode = null;
      let exitCodeShadow = null; // mirrors process.exitCode assignments (node's implicit exit code)
      const exitFn = (c) => {
        // node semantics: process.exit() with no arg uses process.exitCode.
        const val = c == null ? (exitCodeShadow == null ? 0 : exitCodeShadow) : c;
        if (exitCode === null) { exitCode = val; flushAll(); frame("meta", JSON.stringify({ event: "exited", code: exitCode })); }
      };
      for (const p of new Set([np.default, np, globalThis.process].filter(Boolean))) {
        try { p.argv = ${JSON.stringify(argv)}.slice(); } catch {}
        try { p.cwd = () => ${JSON.stringify(cwd)}; } catch { try { Object.defineProperty(p, "cwd", { configurable: true, value: () => ${JSON.stringify(cwd)} }); } catch {} }
        try { p.env = Object.assign(p.env || {}, ${JSON.stringify(envObj)}); } catch {}
        try { Object.defineProperty(p, "stdin", { configurable: true, get: () => nodeStdin }); } catch {}
        try { Object.defineProperty(p, "report", { configurable: true, value: reportStub }); } catch {}
        try { Object.defineProperty(p, "exitCode", { configurable: true, get: () => exitCodeShadow, set: (v) => { exitCodeShadow = v; } }); } catch {}
        try { p.exit = exitFn; } catch {}
      }
      const buf = { stdout: "", stderr: "" };
      const flushT = { stdout: null, stderr: null };
      const flushPartial = (stream) => { flushT[stream] = null; if (buf[stream]) { frame(stream, buf[stream], true); buf[stream] = ""; } };
      const flushAll = () => { for (const k of ["stdout", "stderr"]) { if (flushT[k] != null) { clearTimeout(flushT[k]); } flushPartial(k); } };
      const emit = (stream, s) => {
        buf[stream] += s;
        let nl; while ((nl = buf[stream].indexOf("\\n")) >= 0) { frame(stream, buf[stream].slice(0, nl)); buf[stream] = buf[stream].slice(nl + 1); }
        if (buf[stream] && flushT[stream] == null) flushT[stream] = setTimeout(() => flushPartial(stream), 40);
      };
      // honor write(chunk, [enc], cb): npm's exit-handler flushes via the callback chain.
      const writeFn = (stream) => (s, e2, cb) => { emit(stream, typeof s === "string" ? s : String(s)); const f = typeof e2 === "function" ? e2 : cb; if (typeof f === "function") queueMicrotask(f); return true; };
      try { np.default.stdout.write = writeFn("stdout"); } catch {}
      try { np.default.stderr.write = writeFn("stderr"); } catch {}
      const enc2 = (a) => a.map((x) => typeof x === "string" ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })()).join(" ");
      console.log = (...a) => emit("stdout", enc2(a) + "\\n");
      console.info = (...a) => emit("stdout", enc2(a) + "\\n");
      console.warn = (...a) => emit("stderr", enc2(a) + "\\n");
      console.error = (...a) => emit("stderr", enc2(a) + "\\n");
      const logReason = (tag) => (r) => emit("stderr", "[" + tag + "] " + (r && (r.stack || (r.reason && (r.reason.stack || r.reason)) || r)) + "\\n");
      try { globalThis.addEventListener("unhandledrejection", logReason("unhandledrejection")); } catch {}
      try { np.default.on && np.default.on("unhandledRejection", logReason("unhandledRejection")); } catch {}
      const require = mod.createRequire(${JSON.stringify(cwd + "/__iso__.js")});
      try { require(${JSON.stringify(entry)}); }
      catch (e) { emit("stderr", "[require threw] " + (e && e.stack || e) + "\\n"); if (exitCode === null) exitFn(1); }
      return { started: true }; // drainProcess owns the rest; the parent's await is waitpid
    }
  }`;
}

// ---- per-stream log buffer: bounded ring + live subscriber fan-out + replay ----
// (Copied self-contained from iso-streaming/worker/stream-do.mjs — iso/ stands alone.)
class LogStream {
  constructor(id, max = RING_MAX) {
    this.id = id; this.max = max;
    this.ring = [];               // recent frames (objects)
    this.dropped = 0;             // lines evicted from the ring (for the "… N dropped" marker)
    this.subscribers = new Set(); // WebSocket server-ends
    this.closed = false;
    this.stdout = "";             // full stdout/stderr accumulation for the synchronous settle path
    this.stderr = "";
    this.exit = null;
  }
  push(frame) {
    this.ring.push(frame);
    if (this.ring.length > this.max) { this.ring.shift(); this.dropped++; }
    if (frame.stream === "stdout") this.stdout += frame.data + (frame.partial ? "" : "\n");
    else if (frame.stream === "stderr") this.stderr += frame.data + (frame.partial ? "" : "\n");
    else if (frame.stream === "meta") { try { const m = JSON.parse(frame.data); if (m.event === "exited") this.exit = m.code; } catch {} }
    for (const ws of this.subscribers) { try { ws.send(JSON.stringify(frame)); } catch {} }
  }
  replayInto(ws) {
    if (this.dropped > 0) ws.send(JSON.stringify({ stream: "meta", data: JSON.stringify({ event: "dropped", n: this.dropped }), seq: -1, t: Date.now() }));
    for (const f of this.ring) { try { ws.send(JSON.stringify(f)); } catch {} }
  }
  subscribe(ws) { this.subscribers.add(ws); }
  unsubscribe(ws) { this.subscribers.delete(ws); }
}

export class Machine {
  constructor(state, env) { this.state = state; this.env = env; this.streams = new Map(); this._n = 0; this.machineId = null; this.hmrSockets = new Set(); this.procs = new Map(); this._pid = 0; this.network = null; }

  // NETWORKS: children of a networked machine get THIS DO as globalOutbound (see childCfg).
  // A DO stub is a Fetcher, and passing our own stub binds every child fetch — and every
  // native-spawned grandchild's, by channel inheritance — to this machine's identity.
  childOutbound() {
    return this.network ? this.env.MACHINE.get(this.state.id) : undefined;
  }

  getStream(id, max) { let s = this.streams.get(id); if (!s) { s = new LogStream(id, max || RING_MAX); this.streams.set(id, s); } return s; }

  // M1: notify the Registry DO of this machine's status. The control plane tells the Machine its
  // own id (body.machineId on /run); we patch running/exited+code straight into the shared
  // REGISTRY namespace (DOs in miniflare share the worker env, so this.env.REGISTRY is available).
  async setStatus(patch) {
    if (!this.machineId || !this.env.REGISTRY) return;
    try {
      const reg = this.env.REGISTRY.get(this.env.REGISTRY.idFromName("singleton"));
      await reg.fetch(new Request("http://reg/patch", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: this.machineId, ...patch }),
      }));
    } catch {}
  }

  async boot(image = "base") {
    const fs = nodeFs;
    const NPM_BIN = "/usr/lib/node_modules/npm/bin/npm-cli.js";
    if (fs.existsSync(NPM_BIN)) { this.image = image; return { ok: true, cached: true, image }; }
    const res = await this.env.HOST.fetch("http://host/image-manifest?image=" + encodeURIComponent(image));
    if (!res.ok) throw new Error("boot: image '" + image + "' not found (HTTP " + res.status + ")");
    const manifest = await res.json();
    let files = 0;
    let skipped = 0;
    for (const [rel, b64] of Object.entries(manifest)) {
      const p = "/" + rel; // re-rooted fork: the writable VFS root is "/" — rootfs lands at /usr
      try {
        fs.mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
        fs.writeFileSync(p, Buffer.from(b64, "base64"));
        files++;
      } catch { skipped++; } // tolerate unwritable paths (e.g. runtime artifacts in old snapshots)
    }
    this.image = image;
    return { ok: true, files, image, npm: fs.existsSync(NPM_BIN) };
  }

  defaultEnv(cwd) {
    return { PATH: "/usr/bin:" + cwd + "/node_modules/.bin:/bin", HOME: "/root" };
  }

  // ---- process table: the Machine DO is the KERNEL. Isolates never create isolates — they make
  // supervised by the DO (exec sessions and their bins); NATIVE spawns (allowSpawn children)
  // parentage, exactly like Unix. `iso top` renders this table.
  allocPid(info) {
    const pid = ++this._pid;
    this.procs.set(pid, {
      pid, ppid: info.ppid ?? 0, argv: info.argv || [], state: "running", exitCode: null,
      startedAt: Date.now(), endedAt: null, streamId: info.streamId || null, cwd: info.cwd || null,
    });
    if (this.procs.size > 64) { // bound growth: prune exited entries older than 5 minutes
      for (const [k, p] of this.procs) if (p.state === "exited" && Date.now() - (p.endedAt || 0) > 300_000) this.procs.delete(k);
    }
    return pid;
  }
  markExit(pid, code) {
    const p = this.procs.get(pid);
    if (p && p.state !== "exited") { p.state = "exited"; p.exitCode = code ?? 0; p.endedAt = Date.now(); }
  }

  // Spawn a sub-isolate over `probeSrc`, STREAMING its framed stdout/stderr into a LogStream
  // (ring + live subscribers) as it runs. Returns the child's settle value AFTER the stream
  // closes (chunks have already fanned out live). This is Track B's spawnStreaming, generalized:
  //   opts.sinkId       stream the frames land in (default: the child's own streamId; a syscall
  //                     child with stdio:"inherit" passes its PARENT's session stream)
  //   opts.sessionStdin wire the sink's stdinWriter/stdinEnd (top-level exec sessions only)
  //   opts.stdin        an RPC ReadableStream to pump into the child's stdin (syscall children —
  //                     the PARENT feeds it, e.g. sh routing its session stdin to the foreground
  //                     child); absent → immediate EOF
  //   opts.suppressMeta drop meta frames (an inherit child's "exited" must not close the session)
  //   opts.pid          the child's pid — baked into ctx so the child's own spawn syscalls chain
  async spawnStreaming(streamId, probeSrc, opts = {}) {
    const sink = this.getStream(opts.sinkId || streamId);
    const child = this.env.LOADER.get("machine-" + streamId, () => childCfg(probeSrc, this.childOutbound()));
    if (opts.sessionStdin !== false) {
      // the most recent session process is the machine's SERVING process — published-port
      // requests (/port-proxy) route into it (its node:http servers, via the probe's fetch).
      this.serveChild = { key: "machine-" + streamId, probeSrc };
    }
    const ts = new TransformStream();
    const reader = ts.readable.getReader();
    const dec = new TextDecoder();
    let pending = "";
    const stdinTs = new TransformStream();
    const sw = stdinTs.writable.getWriter();
    const senc = new TextEncoder();
    if (opts.sessionStdin !== false) {
      // top-level exec session: the attach WS feeds stdin via the sink's writer hooks.
      sink.stdinWriter = (data) => { try { sw.write(senc.encode(String(data))); } catch {} };
      sink.stdinEnd = () => { try { sw.close().catch(() => {}); } catch {} };
    } else if (opts.stdin) {
      // syscall child with a parent-fed stdin stream (foreground routing).
      (async () => {
        try {
          const r = opts.stdin.getReader();
          while (true) {
            const { value, done } = await r.read();
            if (done) break;
            await sw.write(typeof value === "string" ? senc.encode(value) : value);
          }
        } catch {}
        try { sw.close().catch(() => {}); } catch {}
      })();
    } else {
      try { sw.close().catch(() => {}); } catch {} // no -i / no pipe: immediate EOF
    }
    const ctx = { streamId, pid: opts.pid ?? null };
    const runP = child.getEntrypoint().run(ts.writable, stdinTs.readable, ctx);
    const pump = (async () => {
      while (true) {
        let r;
        try { r = await reader.read(); } catch { break; }
        const { value, done } = r;
        if (done) break;
        pending += dec.decode(value, { stream: true });
        let nl;
        while ((nl = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, nl); pending = pending.slice(nl + 1);
          if (!line) continue;
          let frame; try { frame = JSON.parse(line); } catch { frame = { stream: "stdout", data: line, t: Date.now() }; }
          if (opts.suppressMeta && frame.stream === "meta") continue;
          sink.push(frame);
        }
      }
      if (pending.trim() && !opts.suppressMeta) { try { sink.push(JSON.parse(pending)); } catch {} }
    })();
    if (opts.drain) {
      // fork process model: run() returns {started:true} immediately; the isolate keeps running
      // (drainProcess) and THIS await is waitpid — it resolves at true event-loop quiescence.
      // Frames keep flowing over the RPC stream during the drain; after waitpid, give the pump a
      // short grace for trailing frames, then release the reader (the probe never closes it).
      const settle = await runP;
      await new Promise((r) => setTimeout(r, 120));
      try { await reader.cancel(); } catch {}
      await pump.catch(() => {});
      const code = sink.exit ?? 0; // the probe's process.exit emits the exited meta frame
      if (opts.sessionStdin !== false) {
        if (sink.exit == null) sink.push({ stream: "meta", data: JSON.stringify({ event: "exited", code }), t: Date.now() });
        sink.closed = true;
        sink.stdinEnd?.();
      }
      return { ...settle, code };
    }
    await pump;
    if (opts.sessionStdin !== false) {
      sink.closed = true;
      sink.stdinEnd?.(); // child settled: release the stdin pipe
    }
    return await runP;
  }

  // Resolve (cmd, args) to a runnable probe — shared by run() (exec sessions) and sysSpawn (the
  // kernel's spawn syscall), so a child spawned from sh resolves EXACTLY like `iso exec`.
  resolveProbe(cmd, args, cwd, env) {
    const fs = nodeFs;
    // ALL npm commands run the LITERAL npm bin — `node npm-cli.js <argv>` fire-and-forget in a
    // drainProcess child (the fork's process model; the base-image driver's literal-bin runner),
    // with our streaming sink wrapped around it. The programmatic-entry route (new Npm();
    // load(); exec()) and the Arborist npm-create path are DELETED — vanilla bin, no hackarounds.
    if (cmd === "npm" && args[0]) {
      fs.mkdirSync("/root/.npm", { recursive: true });
      const isInstall = ["install", "i", "add", "ci"].includes(args[0]);
      const isCreate = ["create", "init", "exec"].includes(args[0]);
      const NPM_CONFIG_FLAGS = ["--ignore-scripts", "--no-audit", "--no-fund", "--no-update-notifier",
        "--legacy-peer-deps", "--cache=/root/.npm", "--registry=https://registry.npmjs.org/",
        "--userconfig=/root/.npmrc-u", "--globalconfig=/root/.npmrc-g"];
      // spawn-shaped npm commands (create/exec/run/…) get the driver's accommodations
      // (npmCreateViteBin): --yes answers the install-confirm prompt; --script-shell=sh keeps
      // promise-spawn on the sh -c path native spawn tokenizes; --node-gyp pins the config
      // default. Args after `--` pass through verbatim.
      const spawnShaped = isCreate || ["run", "run-script", "start", "test", "restart", "stop"].includes(args[0]);
      const createFlags = spawnShaped
        ? ["--yes", "--script-shell=sh", "--node-gyp=/usr/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js"]
        : [];
      // run npm through the overlay LAUNCHER (usr/bin/npm) — it pre-owns the package files
      // (shared-VFS cross-isolate in-place-write guard) and adapts write-callbacks; the fork's
      // native spawn resolves the SAME launcher, so both paths share the environmental fixes.
      const entry = "/usr/bin/npm";
      // keep flags BEFORE any `--` separator (everything after it goes verbatim to a spawned bin)
      const dd = args.indexOf("--");
      const pre = dd === -1 ? args : args.slice(0, dd);
      const post = dd === -1 ? [] : args.slice(dd);
      const npmArgv = ["node", "npm", ...pre, ...createFlags, ...NPM_CONFIG_FLAGS, ...post];
      return { probeSrc: streamingDrainBinProbeSrc(entry, npmArgv, cwd, { PATH: "/usr/bin:/bin", HOME: "/root" }), isNpm: isInstall, drain: true };
    }
    let argv = resolveArgv(cmd, args);
    // real-bin-first: `sh -c <script>` used to be tokenized (no shell existed). The image now
    // ships a REAL usr/bin/sh — if the literal cmd resolves to a bin, prefer it over tokenizing.
    if (argv[0] !== cmd && resolveBinToJs(fs, cmd, { env })) argv = [cmd, ...args];
    // `node <script>`: no node binary in a machine — the script is the entry (same special-case
    // the fork's native spawn makes). The probe's in-context require() runs CJS and ESM scripts
    // alike (the old .js→.mjs shadow copy is deleted — it broke CJS-using-require).
    if (String(argv[0] || "").split("/").pop() === "node" && argv[1] && /[./]/.test(argv[1])) {
      argv = [argv[1].startsWith("/") ? argv[1] : cwd + "/" + argv[1], ...argv.slice(2)];
    }
    const entry = resolveBinToJs(fs, argv[0], { env });
    if (!entry) return { notFound: argv[0] };
    let realEntry = entry;
    try {
      const head = fs.readFileSync(entry, "utf8");
      if (head.startsWith("#!")) { const s = entry.lastIndexOf("/"); realEntry = entry.slice(0, s + 1) + "__nosheb_" + entry.slice(s + 1); fs.writeFileSync(realEntry, head.replace(/^#![^\n]*\n/, "//\n")); }
    } catch {}
    return { probeSrc: streamingProbeSrc(realEntry, argv.slice(1), cwd, env) };
  }

  // The npm-install landed-check (carried from Track A): a 2nd install in a warm machine
  // completes the reify but npm's exit-handler throws — judge by whether the packages landed.
  npmVerdict(cwd, args, settle) {
    const fs = nodeFs;
    let installed = []; try { installed = fs.readdirSync(cwd + "/node_modules").filter((n) => !n.startsWith(".")); } catch {}
    const specs = args.slice(1).filter((a) => !a.startsWith("-"));
    const wantNames = specs.map((s) => s.replace(/@[^@/]*$/, "")).filter(Boolean);
    const landed = wantNames.length === 0 || wantNames.every((n) => installed.includes(n.replace(/^@[^/]+\//, "").split("/")[0]) || installed.includes(n));
    return { landed, installed, warned: !!(settle?.importErr && landed) };
  }

  // run(cmd, args, env, cwd, opts): the generic `iso run`/`iso exec` path. Always streams into a
  // LogStream keyed by opts.streamId. opts.detach → fire-and-forget (return immediately); else
  // await the settle and return {code, stdout, stderr} reconstructed from the stream.
  async run(cmd, args = [], env = {}, cwd = "/work", opts = {}) {
    const fs = nodeFs;
    // docker parity: an EXEC session must not touch the machine's lifecycle record — the main
    // command owns status/command in `ps`. opts.exec suppresses all registry patches.
    const patchStatus = (p) => (opts.exec ? Promise.resolve() : this.setStatus(p));
    fs.mkdirSync(cwd, { recursive: true });
    const mergedEnv = { ...this.defaultEnv(cwd), ...env };
    const streamId = opts.streamId || ("s" + (++this._n) + Date.now().toString(36));
    this.getStream(streamId);

    // resolve to a probe (npm literal bin incl. create/exec/run, real-bin-first sh -c,
    // node-script mapping, shebang strip).
    const resolved = this.resolveProbe(cmd, args, cwd, mergedEnv);
    const isNpm = !!resolved.isNpm;
    if (resolved.notFound) {
      const stream = this.getStream(streamId);
      stream.push({ stream: "stderr", data: "iso: " + resolved.notFound + ": not found (PATH=" + mergedEnv.PATH + ")", t: Date.now() });
      stream.push({ stream: "meta", data: JSON.stringify({ event: "exited", code: 127 }), t: Date.now() });
      stream.closed = true;
      await patchStatus({ status: "exited", lastExit: 127 }); // registry: docker-style "Exited (127)"
      return { streamId, code: 127, signal: null, stdout: "", stderr: "iso: " + resolved.notFound + ": not found\n" };
    }
    const probeSrc = resolved.probeSrc;

    // process table: the exec session is a process; the bin runs as its child (Unix bookkeeping).
    const sessionPid = this.allocPid({ ppid: 0, argv: ["<session>", streamId], streamId, cwd });
    const binPid = this.allocPid({ ppid: sessionPid, argv: [cmd, ...args], streamId, cwd });
    const exitBoth = (code) => { this.markExit(binPid, code); this.markExit(sessionPid, code); };

    // M1: mark running while the op is in flight.
    await patchStatus({ status: "running", lastStream: streamId, lastExit: null });

    if (opts.detach || opts.attach) {
      // `iso run -d` / `iso exec -i` (attach): stream in the background, return immediately. The
      // /logs WS (detach) or the /attach WS (interactive) picks up chunks; attach also feeds stdin.
      // M1: when the background run settles (or errors), flip the registry status to exited+code.
      const p = this.spawnStreaming(streamId, probeSrc, { pid: binPid, drain: !!resolved.drain });
      const stream = this.getStream(streamId);
      if (!opts.attach) stream.stdinEnd?.(); // docker semantics: stdin is open only for -i
      p.then(
        (settle) => {
          const c = settle?.code ?? this.getStream(streamId).exit ?? 0;
          // a run with published ports whose process reached quiescence WITHOUT failing is a
          // SERVER: drainProcess doesn't count a listening node:http server as pending work
          // (the portMapper keeps serving through the child's fetch surface), so waitpid
          // resolves while the machine genuinely still serves — status "serving", not "exited".
          if (opts.serving && c === 0) { patchStatus({ status: "serving", lastExit: null }); return; }
          exitBoth(c); patchStatus({ status: "exited", lastExit: c });
        },
        (e) => { const s = this.getStream(streamId); s.push({ stream: "meta", data: JSON.stringify({ event: "error", err: String(e) }), t: Date.now() }); s.closed = true; exitBoth(1); patchStatus({ status: "exited", lastExit: 1 }); }
      );
      return { streamId, detached: !!opts.detach, attached: !!opts.attach };
    }

    // synchronous settle (the preserved batch contract): await, then reconstruct {code,stdout,stderr}.
    const settleP = this.spawnStreaming(streamId, probeSrc, { pid: binPid, drain: !!resolved.drain });
    this.getStream(streamId).stdinEnd?.(); // non-interactive: immediate EOF on the child's stdin
    const settle = await settleP;
    const stream = this.getStream(streamId);
    let code = settle?.code ?? stream.exit ?? 0;
    let stdout = stream.stdout, stderr = stream.stderr;
    if (settle?.importErr) stderr += settle.importErr + "\n";
    if (isNpm) {
      const v = this.npmVerdict(cwd, args, settle);
      stdout += "\nnode_modules: " + v.installed.join(", ") + "\n";
      // trust npm's REAL exit code (post-launcher-fix it is honest); landed-check is only the
      // fallback when the child never reported one.
      code = (settle?.code != null || stream.exit != null) ? code : (v.landed ? 0 : 1);
      exitBoth(code);
      await patchStatus({ status: "exited", lastExit: code });
      return { streamId, code, signal: null, stdout, stderr, installed: v.installed };
    }
    exitBoth(code);
    await patchStatus({ status: "exited", lastExit: code });
    return { streamId, code, signal: null, stdout, stderr };
  }

  // M3: rewrite a scaffolded project's package.json to the PUBLISHED workerd forks. create-vite
  // writes STOCK vite/@vitejs/plugin-react (which won't run in workerd); do-machine-clean proved
  // the published @netanelgilad/vite + @netanelgilad/rolldown forks run from /tmp in a child. We
  // repin exactly those (versions from do-machine-clean/proof/build-result.json), add the bare
  // `rolldown` alias the probes import directly, and pin react/plugin to the versions the fork app
  // uses. After this, `iso exec <id> npm install` (cwd=the project) installs a workerd-ready tree.
  useFork(project, cwd) {
    const fs = nodeFs;
    const dir = (project && project.startsWith("/")) ? project : (cwd || "/work") + "/" + (project || "myapp");
    const pjPath = dir + "/package.json";
    if (!fs.existsSync(pjPath)) return { ok: false, error: "no package.json at " + dir };
    const pkg = JSON.parse(fs.readFileSync(pjPath, "utf8"));
    pkg.dependencies = pkg.dependencies || {};
    pkg.devDependencies = pkg.devDependencies || {};
    const VITE = "npm:@netanelgilad/vite@8.0.16-workerd.0";
    const ROLLDOWN = "npm:@netanelgilad/rolldown@1.0.3-workerd.0";
    // vite is in devDependencies in a create-vite scaffold → repin there; drop any stock vite dep.
    delete pkg.dependencies.vite;
    pkg.devDependencies.vite = VITE;
    pkg.devDependencies.rolldown = ROLLDOWN;                 // bare alias the probes import directly
    pkg.devDependencies["@vitejs/plugin-react"] = "^6";
    pkg.dependencies.react = "^19";
    pkg.dependencies["react-dom"] = "^19";
    // read→rm→write to dodge the shared-VFS in-place-rewrite assertion for scaffold-owned files.
    const out = JSON.stringify(pkg, null, 2) + "\n";
    try { fs.rmSync(pjPath); } catch {}
    fs.writeFileSync(pjPath, out);
    return { ok: true, dir, dependencies: pkg.dependencies, devDependencies: pkg.devDependencies };
  }

  // M4: write the (verbatim do-machine-clean) vite-dev probe INTO the project dir, so its bare
  // imports ("vite","@vitejs/plugin-react") + DEV_ROOT resolve against <project>/node_modules.
  async scaffoldDevProbe(projDir) {
    const fs = nodeFs;
    const res = await this.env.HOST.fetch("http://host/dev-probe");
    const src = await res.text();
    const p = projDir + "/vite-dev-probe.mjs";
    try { fs.rmSync(p); } catch {}
    fs.writeFileSync(p, src);
    return p;
  }

  // M4: boot vite's createServer (middleware mode) in a child over the project's /tmp and warm the
  // dep optimizer to completion inside ONE request (workerd cancels pending I/O when a request ends,
  // so esbuild-wasm init + prebundle must finish here). Keyed by project so the right /tmp root.
  async devWarmup(projDir, devPort) {
    const fs = nodeFs;
    if (!fs.existsSync(projDir + "/node_modules/vite")) return { ok: false, error: "vite not installed in " + projDir + " (run use-fork + npm install first)" };
    const probePath = await this.scaffoldDevProbe(projDir);
    this.devProjDir = projDir; this.devPort = devPort;
    const child = this.env.LOADER.get("vite-dev", () => viteDevChild(devPort, probePath));
    const result = await child.getEntrypoint().warmup();
    if (result?.ok) { this.devReady = true; this.devChildKey = "vite-dev"; }
    return result;
  }

  // M4 HMR-PUSH FIX: send a frame to every open HMR socket. These sockets are accepted+owned BY
  // THIS DO (not the dev child), so a send from ANY later request context in this same persistent
  // DO isolate reaches them — exactly the Track-B LogStream model that already streams live. (A
  // socket accepted in the dev child's fetch could NOT be sent to from the child's separate
  // applyEdit RPC — different I/O context; that was the gap.)
  pushHmr(payload) {
    const json = JSON.stringify(payload);
    let sent = 0;
    for (const ws of this.hmrSockets) { try { ws.send(json); sent++; } catch { this.hmrSockets.delete(ws); } }
    return sent;
  }

  // M4: serve path — browser HTTP → vite-dev child; /__hmr WS → terminated HERE in the DO.
  // The DO owns the HMR socket so HMR pushes (driven by applyEdit on a file edit) deliver live.
  async devServe(request, innerPath) {
    const fs = nodeFs;
    if (!this.devReady) {
      // self-heal: a cold DO instance can receive the serve request; re-warm if the tree is present.
      const projDir = this.devProjDir || "/tmp/proj/myapp";
      if (fs.existsSync(projDir + "/node_modules/vite")) await this.devWarmup(projDir, this.devPort);
      if (!this.devReady) return new Response("dev server not ready (run `iso dev <id>` first)", { status: 503 });
    }
    // The /__hmr WebSocket: accept + own it in the DO. vite's browser client (/@vite/client) dials
    // this; we speak vite's wire protocol directly (it only needs {type:"connected"} then
    // {type:"update",...}/{type:"full-reload"} frames — the child's vite computes WHAT changed).
    if (innerPath.startsWith("/__hmr") && request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      server.accept();
      this.hmrSockets.add(server);
      server.addEventListener("close", () => this.hmrSockets.delete(server));
      server.addEventListener("error", () => this.hmrSockets.delete(server));
      try { server.send(JSON.stringify({ type: "connected" })); } catch {}
      const offered = request.headers.get("Sec-WebSocket-Protocol");
      const headers = {};
      if (offered) headers["Sec-WebSocket-Protocol"] = offered.split(",")[0].trim();
      return new Response(null, { status: 101, webSocket: client, headers });
    }
    const child = this.env.LOADER.get("vite-dev", () => viteDevChild(this.devPort, this.devProjDir + "/vite-dev-probe.mjs"));
    const fwd = new Request(new URL(innerPath, "http://vite.local"), request);
    return await child.getEntrypoint().fetch(fwd);
  }

  // Re-materialize files under dir from THIS isolate (files a spawn sub-isolate wrote carry that
  // isolate's VFS node; an in-place parent open-for-write trips a shared-VFS assertion). read→rm→write.
  reownTree(fs, dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = dir + "/" + e.name;
      if (e.isDirectory()) this.reownTree(fs, p);
      else if (e.isFile()) { const buf = fs.readFileSync(p); fs.rmSync(p); fs.writeFileSync(p, buf); }
    }
  }

  // HTTP/WS front door. /boot, /run (detach|wait), WS /logs[?id=&follow=1], WS /attach, /top, /fs.
  async fetch(request) {
    installGlobals(this.env);
    await patchProcessReport();
    const url = new URL(request.url);
    try {
      // NETWORK EGRESS (docs/networks.md): a NETWORKED machine's children have this DO as
      // globalOutbound, so any request that is not a machine op (ops always use http://m/...)
      // is a child's outbound fetch. Stamp the caller's identity and hand it to the control
      // plane's egress governor (member-name resolution, policy isolate, `iso network logs`).
      if (url.hostname !== "m") {
        const h = new Headers(request.headers);
        h.set("x-iso-net-from", this.machineId || "");
        h.set("x-iso-net-name", this.network?.name || "");
        return this.env.SELF.fetch(new Request(request, { headers: h }));
      }
      // ---- WS subscriber: logs [--follow] (Track B). Replay the ring; follow=1 → live subscribe. ----
      if (url.pathname === "/logs") {
        const id = url.searchParams.get("id");
        const follow = url.searchParams.get("follow") === "1";
        const stream = id ? this.streams.get(id) : null;
        if (!stream) return new Response("no such stream: " + id, { status: 404 });
        const pair = new WebSocketPair();
        const [client, server] = [pair[0], pair[1]];
        server.accept();
        stream.replayInto(server);
        if (follow && !stream.closed) {
          stream.subscribe(server);
          server.addEventListener("close", () => stream.unsubscribe(server));
          // NOTE: /logs is output-only. stdin belongs to the exec-attach socket (/attach) only.
        } else {
          try { server.close(1000, "replay-complete"); } catch {}
        }
        return new Response(null, { status: 101, webSocket: client });
      }

      // ---- WS attach: `iso exec -i` (bidirectional). The DO OWNS the socket (the HMR/LogStream
      // lesson: all sends happen from this DO's live context, never from a child RPC context).
      // Outbound: the exec's LogStream frames translated to the attach vocabulary
      //   {type:"stdout"|"stderr",data,partial?} / {type:"exit",code} / {type:"meta",...}.
      // Inbound: {type:"stdin",data} → raw bytes into the child's real process.stdin Readable;
      //   {type:"stdin-eof"} → close the pipe → 'end' in the child.
      if (url.pathname === "/attach") {
        const id = url.searchParams.get("id");
        const stream = id ? this.streams.get(id) : null;
        if (!stream) return Response.json({ error: "no such exec: " + id }, { status: 404 });
        const pair = new WebSocketPair();
        const [client, server] = [pair[0], pair[1]];
        server.accept();
        // translate LogStream frames onto the attach socket; LogStream only calls .send().
        const sock = {
          send: (json) => {
            try {
              const f = JSON.parse(json);
              let out;
              if (f.stream === "meta") {
                const m = JSON.parse(f.data);
                out = m.event === "exited" ? { type: "exit", code: m.code ?? 0 } : { type: "meta", ...m };
              } else out = { type: f.stream, data: f.data, ...(f.partial ? { partial: true } : {}) };
              server.send(JSON.stringify(out));
            } catch {}
          },
        };
        stream.replayInto(sock);
        if (!stream.closed) {
          stream.subscribe(sock);
          server.addEventListener("close", () => stream.unsubscribe(sock));
          server.addEventListener("message", (ev) => {
            try {
              const m = JSON.parse(ev.data);
              if (m.type === "stdin" && stream.stdinWriter) stream.stdinWriter(m.data);
              else if (m.type === "stdin-eof") stream.stdinEnd?.();
            } catch {}
          });
          // Client gone without stdin-eof = DETACH: leave stdin open, the command keeps running
          // (documented Ctrl-C semantics; `iso logs -f` can re-tail the stream).
        } else {
          try { server.close(1000, "exec-complete"); } catch {}
        }
        return new Response(null, { status: 101, webSocket: client });
      }

      // Snapshot the machine's whole world (its VFS /tmp) for `iso commit`. No overlayfs, no layer
      // diff — one filesystem walk, EXCLUDING ephemera (npm cache, spawn/npx probe scratch,
      // shebang-stripped bin copies). Returns the same path→base64 map shape boot() consumes, so
      // committed images boot through the identical /image-manifest path.
      if (url.pathname === "/snapshot") {
        const fs = nodeFs;
        // ?scope=/some/path — a SCOPED walk (volume checkpoints): keys relative to the scope,
        // no image-level exclusions (it's the volume's own tree).
        const scope = url.searchParams.get("scope");
        if (scope) {
          if (!scope.startsWith("/")) return Response.json({ error: "scope must be absolute" }, { status: 400 });
          const files = {};
          let bytes = 0;
          try {
            (function walk(d, rel) {
              for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const r = rel ? rel + "/" + e.name : e.name;
                if (e.isDirectory()) walk(d + "/" + e.name, r);
                else if (e.isFile()) { const buf = fs.readFileSync(d + "/" + e.name); bytes += buf.length; files[r] = buf.toString("base64"); }
              }
            })(scope, "");
          } catch (e) {
            return Response.json({ error: "scope walk failed (machine evicted or path missing): " + String(e && e.message || e) }, { status: 409 });
          }
          return Response.json(files, { headers: { "x-iso-files": String(Object.keys(files).length), "x-iso-bytes": String(bytes) } });
        }
        if (!fs.existsSync("/usr")) return Response.json({ error: "machine has no filesystem to snapshot (not booted)" }, { status: 409 });
        // tmpfs semantics on the re-rooted VFS: /tmp (scratch, spawn dirs, probes) and
        // /root (npm cache/config state) stay out of images — like a real container commit
        // excludes tmpfs mounts. /usr, /work, /etc and anything else is the image.
        const SKIP_DIR = new Set(["tmp", "root", "dev", "proc", "bundle"]); // bundle = workerd runtime artifact at /
        const skipName = (n) => n.startsWith("__nosheb_") || n.startsWith("__spawn_probe") || n.startsWith("__npm_probe") || n.endsWith(".__iso.mjs");
        const files = {};
        let bytes = 0;
        (function walk(d, rel) {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const r = rel ? rel + "/" + e.name : e.name;
            if (e.isDirectory()) {
              if (!rel && SKIP_DIR.has(e.name)) continue;
              if (!rel && e.name.startsWith(".spawn-")) continue; // the fork's native-spawn scratch dirs
              if (e.name.startsWith("__npx_") || e.name.startsWith("__spawn_probe")) continue;
              walk(d + "/" + e.name, r);
            } else if (e.isFile()) {
              if (skipName(e.name)) continue;
              const buf = fs.readFileSync(d + "/" + e.name);
              bytes += buf.length;
              files[r] = buf.toString("base64");
            }
          }
        })("/", "");
        return Response.json(files, { headers: { "x-iso-files": String(Object.keys(files).length), "x-iso-bytes": String(bytes) } });
      }
      // Process table (`iso top`): DO-supervised processes (exec sessions + their bins) MERGED
      // with the fork's NATIVE-spawn records — each native child_process.spawn materializes a
      // /tmp/.spawn-<n>-<ts>/ dir ({probe.mjs, out.log, err.log, status.json}); that IS the
      // fork-level source of truth for processes that bypass the DO. Parentage between native
      // spawns lives inside the fork and is not surfaced (documented); status.json appears only
      // when the child calls process.exit — a clean-quiescence exit leaves none (fork handoff).
      if (url.pathname === "/top") {
        const procs = [...this.procs.values()].map(({ streamId, ...p }) => p);
        try {
          const fs = nodeFs;
          for (const e of fs.readdirSync("/tmp")) {
            if (!e.startsWith(".spawn-")) continue;
            const dir = "/tmp/" + e;
            const m = e.match(/^\.spawn-(\d+)-([a-z0-9]+)$/);
            const startedAt = m ? parseInt(m[2], 36) : null;
            let argv = [];
            try {
              const am = fs.readFileSync(dir + "/probe.mjs", "utf8").match(/p\.argv = (\[[^\n]*?\])\.slice\(\)/);
              if (am) argv = JSON.parse(am[1]);
            } catch {}
            if (argv[0] === "node" && argv[1]) argv = [String(argv[1]).split("/").pop().replace(/^__nosheb_/, ""), ...argv.slice(2)];
            let status = null;
            try { status = JSON.parse(fs.readFileSync(dir + "/status.json", "utf8")); } catch {}
            if (status && startedAt && Date.now() - startedAt > 300_000) continue; // prune old exited
            procs.push({
              pid: "n" + (m ? m[1] : e), ppid: "-", argv,
              state: status ? "exited" : "running", exitCode: status ? (status.code ?? 0) : null,
              startedAt, endedAt: null, native: true,
            });
          }
        } catch {}
        return Response.json({ procs });
      }
      // Cheap metadata for `iso inspect` (no boot, no spawn — just what this DO instance knows).
      if (url.pathname === "/info") {
        return Response.json({
          image: this.image || null,
          booted: nodeFs.existsSync("/usr/lib/node_modules/npm"),
          streams: [...this.streams.keys()],
          devReady: !!this.devReady,
          devProjDir: this.devProjDir || null,
          hmrSockets: this.hmrSockets ? this.hmrSockets.size : 0,
        });
      }
      // volume copy-in: materialize a checkpoint artifact at the mount path (DO-side writes —
      // the same write path boot uses, so the files are DO-owned).
      if (url.pathname === "/volume-in" && request.method === "POST") {
        const { path: mount, files } = await request.json();
        const fs = nodeFs;
        let n = 0;
        fs.mkdirSync(mount, { recursive: true });
        for (const [rel, b64] of Object.entries(files || {})) {
          const p = mount + "/" + rel;
          try {
            fs.mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
            fs.writeFileSync(p, Buffer.from(b64, "base64"));
            n++;
          } catch {}
        }
        return Response.json({ ok: true, mounted: mount, files: n });
      }
      if (url.pathname === "/boot") {
        const body = await request.json().catch(() => ({}));
        return Response.json(await this.boot(body.image || "base"));
      }
      if (url.pathname === "/use-fork") {
        const body = await request.json().catch(() => ({}));
        return Response.json(this.useFork(body.project || "myapp", body.cwd || "/work"));
      }
      // M4: boot + warm the vite dev server for a project.
      if (url.pathname === "/dev-warmup") {
        const body = await request.json().catch(() => ({}));
        const projDir = body.projDir || "/work/" + (body.project || "myapp");
        return Response.json(await this.devWarmup(projDir, body.devPort));
      }
      // M4: serve path — browser HTTP + /__hmr WS, forwarded to the vite-dev child. The control
      // plane rewrites the public URL to /proxy/<innerPath> (innerPath in ?p=).
      if (url.pathname === "/proxy") {
        const inner = url.searchParams.get("p") || "/";
        return await this.devServe(request, inner);
      }
      // Published-port proxy (`iso run -p`): forward an HTTP request (any verb, STREAMING body)
      // into the machine's serving process. The child's probe bridges by port via
      // cloudflare:node handleAsNodeRequest — an unmodified node:http server just works.
      if (url.pathname === "/port-proxy") {
        const port = url.searchParams.get("port") || "0";
        const inner = url.searchParams.get("p") || "/";
        if (!this.serveChild) {
          return Response.json({ error: "machine has no serving process (its child may have been evicted — re-run the server)" }, { status: 503 });
        }
        const child = this.env.LOADER.get(this.serveChild.key, () => childCfg(this.serveChild.probeSrc, this.childOutbound()));
        const h = new Headers(request.headers);
        h.set("x-iso-port", port);
        const fwd = new Request(new URL(inner, "http://machine.local"), {
          method: request.method, headers: h,
          body: (request.method === "GET" || request.method === "HEAD") ? undefined : request.body,
        });
        return await child.getEntrypoint().fetch(fwd);
      }
      // Diag/file ops over the machine's /tmp (proofs + M4 source edits). read/exists/write/ls.
      if (url.pathname === "/fs") {
        const body = await request.json().catch(() => ({}));
        const fs = nodeFs;
        try {
          // enc:"base64" on read/write makes the ops binary-safe (used by `iso cp`).
          if (body.op === "read") {
            const buf = fs.readFileSync(body.path);
            return Response.json({ ok: true, content: body.enc === "base64" ? buf.toString("base64") : buf.toString("utf8") });
          }
          if (body.op === "exists") return Response.json({ ok: true, exists: fs.existsSync(body.path) });
          if (body.op === "mkdir") { fs.mkdirSync(body.path, { recursive: true }); return Response.json({ ok: true, made: body.path }); }
          if (body.op === "ls") return Response.json({ ok: true, entries: fs.readdirSync(body.path) });
          if (body.op === "write") {
            const p = body.path; fs.mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
            try { fs.rmSync(p); } catch {}   // read→rm→write to dodge shared-VFS in-place assertion
            const data = body.enc === "base64" ? Buffer.from(body.content ?? "", "base64") : (body.content ?? "");
            fs.writeFileSync(p, data);
            // M4: if the dev server is up and this file is under its project, trigger vite HMR
            // (watch:null means no auto-trigger). applyEdit runs in the dev child (invalidates the
            // module + COMPUTES the vite update frame); we then push that frame to the DO-OWNED HMR
            // sockets — the fix: the send happens in THIS DO isolate that owns the socket, not from
            // the child's separate RPC. hmr=false opts out.
            let hmr = null;
            if (this.devReady && this.devProjDir && p.startsWith(this.devProjDir + "/") && body.hmr !== false) {
              try {
                const child = this.env.LOADER.get("vite-dev", () => viteDevChild(this.devPort, this.devProjDir + "/vite-dev-probe.mjs"));
                hmr = await child.getEntrypoint().applyEdit(p);
                if (hmr && hmr.frame) hmr.pushed = this.pushHmr(hmr.frame);
              } catch (e) { hmr = { ok: false, error: String(e) }; }
            }
            return Response.json({ ok: true, wrote: p, bytes: data.length, hmr });
          }
          return Response.json({ ok: false, error: "unknown fs op" });
        } catch (e) { return Response.json({ ok: false, error: String(e) }); }
      }
      if (url.pathname === "/run") {
        const body = await request.json();
        if (body.machineId) this.machineId = body.machineId; // M1: learn our registry id
        if (body.network) this.network = body.network;       // networks: {name, member} → children get governed outbound
        await this.boot(body.image || this.image || "base");
        const res = await this.run(body.cmd, body.args || [], body.env || {}, body.cwd || "/work",
          { detach: !!body.detach, attach: !!body.attach, streamId: body.streamId, serving: !!body.serving, exec: !!body.exec });
        return Response.json(res);
      }
      return new Response("machine ops: POST /boot {image}, POST /run {cmd,args,env,cwd,detach,streamId}, WS /logs?id=&follow=1", { status: 404 });
    } catch (e) {
      return Response.json({ error: String(e), stack: (e?.stack ?? "").split("\n").slice(0, 30) }, { status: 500 });
    }
  }
}
