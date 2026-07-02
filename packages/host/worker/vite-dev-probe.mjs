// VITE DEV SERVER probe -- runs INSIDE a Worker-Loader child of the DO, loading
// vite@8 + @vitejs/plugin-react + the single-threaded rolldown WASM fork + esbuild-wasm
// entirely from the shared /tmp (via the workerd fork's VFS module fallback). The DO
// forwards browser HTTP (and the /__hmr WebSocket) to this entrypoint's fetch() over RPC;
// vite runs in middlewareMode and we adapt workerd Request/Response to vite's connect stack.
//
// This is the do-machine port of harness/worker/driver.mjs's dev path, but with vite
// loaded from native /tmp (not memfs) and rooted at /tmp/proj. It lives UNDER /tmp/proj so
// its bare imports ("vite", "@vitejs/plugin-react") resolve against /tmp/proj/node_modules.
import { Buffer } from "node:buffer";
import * as nodeFs from "node:fs";
import path from "node:path";

import { WorkerEntrypoint } from "cloudflare:workers";

// iso: the project root is THIS probe's own directory (iso scaffolds the probe INTO the project
// dir, e.g. /tmp/proj/myapp), so dev works for any project name — not a hardcoded /tmp/proj.
// import.meta.url is supplied natively by the workerd VFS loader (the fork capability vite needs).
const DEV_ROOT = (() => { try { return path.dirname(new URL(import.meta.url).pathname); } catch { return "/tmp/proj"; } })();

let devServer;
let booted = false;

function installGlobals(env) {
  globalThis.__UNSAFE_EVAL = env.UNSAFE_EVAL;
  globalThis.__wasmCompile = async (b) =>
    env.UNSAFE_EVAL.newWasmModule(b instanceof Uint8Array ? b : new Uint8Array(b));
  globalThis.__safeEval = (c) => env.UNSAFE_EVAL.eval(String(c));
  globalThis.__newFunction = (...a) => {
    const body = a.pop();
    return env.UNSAFE_EVAL.newFunction(String(body), "anonymous", ...a);
  };
  globalThis.__requireResolve = (base, spec) => {
    if (typeof spec === "string" && spec.startsWith("file://")) spec = spec.slice(7);
    return spec;
  };
  const _WA = globalThis.WebAssembly;
  if (!_WA.__patchedForUnsafeEval) {
    const origInstantiate = _WA.instantiate.bind(_WA);
    const toModule = (src) => {
      if (src instanceof _WA.Module) return src;
      const bytes = src instanceof Uint8Array ? src : new Uint8Array(src);
      return env.UNSAFE_EVAL.newWasmModule(bytes);
    };
    _WA.compile = async (src) => toModule(src);
    _WA.instantiate = async (src, imports) => {
      if (src instanceof _WA.Module) return origInstantiate(src, imports);
      const mod = toModule(src);
      const instance = await origInstantiate(mod, imports);
      return { module: mod, instance };
    };
    _WA.__patchedForUnsafeEval = true;
  }
}

// See driver-do.mjs makeEnoentFs: native openSync(missing, O_RDONLY) over workerd does
// not throw ENOENT, breaking rolldown's resolver. Surface ENOENT for read-only ops.
function makeEnoentFs(base) {
  const O_CREAT = 0o100;
  const enoent = (p, syscall) => { const e = new Error("ENOENT: no such file or directory, " + syscall + " '" + p + "'"); e.code = "ENOENT"; e.errno = -2; e.syscall = syscall; e.path = p; throw e; };
  return new Proxy(base, { get(t, k) {
    const v = t[k];
    if (k === "openSync") return (p, flags, ...a) => {
      const wantsCreate = typeof flags === "number" && (flags & O_CREAT) !== 0;
      if (!wantsCreate && !t.existsSync(p)) enoent(p, "open");
      return v.call(t, p, flags, ...a);
    };
    if (k === "readFileSync") return (p, ...a) => { if (!t.existsSync(p)) enoent(p, "open"); return v.call(t, p, ...a); };
    if (k === "statSync") return (p, ...a) => { if (!t.existsSync(p)) enoent(p, "stat"); return v.call(t, p, ...a); };
    if (k === "lstatSync") return (p, ...a) => { if (!t.existsSync(p)) enoent(p, "lstat"); return v.call(t, p, ...a); };
    return typeof v === "function" ? v.bind(t) : v;
  }});
}

async function bootRolldown() {
  if (booted) return;
  globalThis.__WASI_NO_BUSY_SLEEP = true;
  globalThis.__TSFN_LOG = false;
  globalThis.__EMNAPI_SCHED = (cb) => queueMicrotask(cb);
  globalThis.__RD_ENV = { RD_LOG: "", RD_LOG_OUTPUT: "readable" };
  globalThis.__ROLLDOWN_FS = makeEnoentFs(nodeFs);
  // CLEAN: do NOT preset __ROLLDOWN_WASM_BYTES. The installed @netanelgilad/rolldown ships
  // dist/rolldown.wasm and the binding loads it via import.meta.url (workerd VFS loader
  // supplies a correct import.meta.url) -> readFileSync(fileURLToPath(new URL("./rolldown.wasm", ...))).
  await import(DEV_ROOT + "/node_modules/rolldown/dist/rolldown-binding.wasi-browser.js");
  if (globalThis.__ROLLDOWN_ENSURE_READY) await globalThis.__ROLLDOWN_ENSURE_READY();
  await import("rolldown");
  booted = true;
}

// ---- Real Vite HMR transport over workerd WebSocketPair (ported from harness) ----
const hotClients = new Set();
const hotListeners = new Map();
let hotBuffered = null;

function hotEmit(event, data, socket) {
  const set = hotListeners.get(event);
  if (!set || !set.size) return;
  const client = { send: (payload) => { try { socket.send(JSON.stringify(payload)); } catch {} } };
  for (const fn of set) fn(data, client);
}

// iso M4: a SWAPPABLE send sink so applyEdit can capture the exact frame vite broadcasts, no
// matter whether vite holds `hotChannel.send` by reference or by property. Default sink fans out
// to any locally-registered hotClients (none in iso — the DO owns the browser HMR socket now);
// applyEdit swaps __hotSink to capture vite's computed update frame and returns it to the DO.
let __hotSink = (payload) => {
  if ((payload.type === "error" || payload.type === "full-reload") && hotClients.size === 0) { hotBuffered = payload; return; }
  const json = JSON.stringify(payload);
  for (const s of hotClients) { try { s.send(json); } catch {} }
};
const hotChannel = {
  send(payload) { return __hotSink(payload); },
  on(event, fn) { if (!hotListeners.has(event)) hotListeners.set(event, new Set()); hotListeners.get(event).add(fn); },
  off(event, fn) { hotListeners.get(event)?.delete(fn); },
  listen() {},
  close() { hotClients.clear(); hotListeners.clear(); },
};

function hotAddClient(socket) {
  hotClients.add(socket);
  socket.addEventListener("message", (e) => {
    let parsed; try { parsed = JSON.parse(typeof e.data === "string" ? e.data : ""); } catch { return; }
    if (parsed?.type === "custom" && parsed.event) hotEmit(parsed.event, parsed.data, socket);
  });
  socket.addEventListener("close", () => { hotClients.delete(socket); hotEmit("vite:client:disconnect", undefined, socket); });
  hotEmit("vite:client:connect", undefined, socket);
  try { socket.send(JSON.stringify({ type: "connected" })); } catch {}
  if (hotBuffered) { try { socket.send(JSON.stringify(hotBuffered)); } catch {} hotBuffered = null; }
}

async function inlineConfig(devPort) {
  const { default: react } = await import("@vitejs/plugin-react");
  const { DevEnvironment } = await import("vite");
  const { EventEmitter } = await import("node:events");
  // Tell vite's HMR client to dial the browser-facing miniflare port (not vite's default
  // 5173) at /__hmr. The transport is the WebSocketPair-backed HotChannel below; the DO
  // proxies the /__hmr upgrade to this child.
  const clientPort = devPort ? Number(devPort) : undefined;
  return {
    root: DEV_ROOT,
    configFile: false,
    envFile: false,
    mode: "development",
    logLevel: "info",
    plugins: [react()],
    server: {
      middlewareMode: true,
      hmr: { server: new EventEmitter(), path: "/__hmr", protocol: "ws", clientPort, host: "127.0.0.1" },
      watch: null,
      host: "127.0.0.1",
      allowedHosts: true,
    },
    environments: {
      client: {
        dev: {
          createEnvironment: (name, config) =>
            new DevEnvironment(name, config, { hot: true, transport: hotChannel, disableFetchModule: true }),
        },
      },
    },
  };
}

async function ensureDevServer(devPort) {
  if (devServer) return devServer;
  await bootRolldown();
  const vite = await import("vite");
  devServer = await vite.createServer(await inlineConfig(devPort));
  return devServer;
}

// Adapt a workerd fetch Request to vite's connect middleware stack (ported from harness).
async function dispatchToConnect(middlewares, request) {
  const { Readable, Writable } = await import("node:stream");
  const url = new URL(request.url);
  const bodyBuf = request.body ? Buffer.from(await request.arrayBuffer()) : null;

  const req = new Readable({ read() {} });
  if (bodyBuf) req.push(bodyBuf);
  req.push(null);
  req.url = url.pathname + url.search;
  req.method = request.method;
  req.headers = Object.fromEntries([...request.headers].map(([k, v]) => [k.toLowerCase(), v]));
  req.headers.host = url.host;
  if (["document", "iframe", "frame", "fencedframe"].includes(req.headers["sec-fetch-dest"])) {
    delete req.headers["sec-fetch-dest"];
  }
  req.socket = { remoteAddress: "127.0.0.1", encrypted: false };
  req.connection = req.socket;
  req.httpVersion = "1.1";
  req.originalUrl = req.url;

  return await new Promise((resolve, reject) => {
    const chunks = [];
    let statusCode = 200;
    const headers = {};
    const res = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
    res.setHeader = (k, v) => { headers[k.toLowerCase()] = v; return res; };
    res.getHeader = (k) => headers[k.toLowerCase()];
    res.getHeaderNames = () => Object.keys(headers);
    res.removeHeader = (k) => { delete headers[k.toLowerCase()]; };
    res.hasHeader = (k) => k.toLowerCase() in headers;
    res.writeHead = (code, reasonOrHeaders, maybeHeaders) => {
      statusCode = code;
      const h = typeof reasonOrHeaders === "object" ? reasonOrHeaders : maybeHeaders;
      if (h) for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
      return res;
    };
    Object.defineProperty(res, "statusCode", { get: () => statusCode, set: (v) => { statusCode = v; } });
    res.headersSent = false;
    const origEnd = res.end.bind(res);
    res.end = (chunk, enc, cb) => {
      if (chunk && typeof chunk !== "function") chunks.push(Buffer.from(chunk, enc));
      origEnd(() => {});
      const body = Buffer.concat(chunks);
      const h = new Headers();
      for (const [k, v] of Object.entries(headers)) {
        if (Array.isArray(v)) for (const vv of v) h.append(k, String(vv));
        else h.set(k, String(v));
      }
      resolve(new Response(body.length ? body : null, { status: statusCode, headers: h }));
      if (typeof cb === "function") cb();
      return res;
    };
    middlewares(req, res, (err) => {
      if (err) reject(err);
      else resolve(new Response("vite middleware did not handle: " + req.url, { status: 404 }));
    });
  });
}

export default class extends WorkerEntrypoint {
  // iso M4: trigger HMR for a file the host just wrote, and RETURN the vite-computed update frame
  // for the DO to push to the (DO-owned) HMR socket. The dev server runs with `watch: null`
  // (workerd has no fs watcher) so a write doesn't auto-trigger HMR; we drive vite's own update
  // pipeline and CAPTURE the frame it produces (so it's react-refresh-correct), rather than
  // hand-rolling the payload. The DO does the actual socket.send (its context owns the socket).
  async applyEdit(file) {
    installGlobals(this.env);
    globalThis.__WAIT_UNTIL = (p) => { try { this.ctx.waitUntil(p); } catch {} };
    const out = { file };
    try {
      const server = await ensureDevServer(this.env.DEV_PORT);
      const env = server.environments?.client;
      const mg = env?.moduleGraph || server.moduleGraph;
      // Invalidate the module(s) for this file so vite re-transforms from disk (not cache).
      const mods = mg?.getModulesByFile?.(file) || new Set();
      for (const m of mods) { try { mg.invalidateModule(m); } catch {} }
      out.invalidated = mods.size;

      // CAPTURE vite's own update frame: temporarily intercept hotChannel.send (the transport vite
      // broadcasts through) while we drive the update, then return the captured payload. This gives
      // the exact {type:"update",updates:[…]} (or full-reload) vite would emit — including the
      // correct acceptedPath/boundaries that make @vitejs/plugin-react do a state-preserving update.
      const captured = [];
      const origSink = __hotSink;
      __hotSink = (payload) => { captured.push(payload); };
      try {
        const mod = [...mods][0];
        if (server.reloadModule && mod) { await server.reloadModule(mod); out.reloaded = true; }
      } catch (e) { out.reloadErr = String(e); }
      __hotSink = origSink;

      // Prefer vite's captured update frame; else synthesize a js-update from the module URL; else
      // full-reload as a last resort (still proves the edit reaches the browser).
      let frame = captured.find((p) => p && p.type === "update") || captured.find((p) => p && p.type === "full-reload") || captured[0];
      if (!frame) {
        const now = Date.now();
        const updates = [];
        for (const m of mods) { const p = m.url || m.id || file; updates.push({ type: "js-update", timestamp: now, path: p, acceptedPath: p, explicitImportRequired: false, isWithinCircularImport: false }); }
        frame = updates.length ? { type: "update", updates } : { type: "full-reload", path: "*" };
        out.synthesized = true;
      }
      out.frame = frame;
      out.captured = captured.length;
      out.ok = true;
    } catch (e) { out.ok = false; out.error = String(e && e.stack || e); }
    return out;
  }

  // Control op: boot the dev server + warm the dep optimizer to completion inside ONE
  // request (workerd cancels pending I/O when a request context dies, so esbuild wasm
  // init + dep prebundle must finish here). Returns when the app's main module + its
  // prebundled deps are transformable.
  async warmup() {
    installGlobals(this.env);
    globalThis.__WAIT_UNTIL = (p) => { try { this.ctx.waitUntil(p); } catch {} };
    const out = {};
    try {
      const t0 = Date.now();
      out.stage = "createServer";
      const server = await ensureDevServer(this.env.DEV_PORT);
      out.stage = "esbuild-init";
      // CLEAN: esbuild is the workerd-wasm shim bundled inside @netanelgilad/vite
      // (node_modules/vite/node_modules/esbuild-wasm/esm/workerd-shim.mjs). Warm it directly
      // (vite's own dist import("esbuild") was baked to this same shim path).
      const esb = await import(DEV_ROOT + "/node_modules/vite/node_modules/esbuild-wasm/esm/workerd-shim.mjs");
      await esb.transform("let x = 1", { loader: "ts" });
      out.stage = "transform-main";
      const tr = await server.transformRequest("/src/main.tsx");
      out.stage = "idle";
      if (server.waitForRequestsIdle) await server.waitForRequestsIdle();
      // Drive the client dep optimizer to a committed state. In middleware mode the
      // optimizer prebundles at crawl-end in the background; workerd kills pending I/O when
      // the request ends, so we must force it to finish (esbuild run + write deps + commit
      // _metadata.json) inside THIS request. Awaiting the depsOptimizer's scan + processing
      // promises does that; then crawling the dep URLs both verifies and warms them.
      const optimizer = server.environments?.client?.depsOptimizer;
      out.hasOptimizer = !!optimizer;
      if (optimizer) {
        try { if (optimizer.scanProcessing) await optimizer.scanProcessing; } catch {}
        // run() (if present) kicks discovery; then the optimizer exposes a processing promise.
        for (let i = 0; i < 40; i++) {
          const md = optimizer.metadata;
          const proc = md?.processing || optimizer.processing;
          if (proc) { try { await proc; } catch {} }
          if (md && md.depInfoList && md.depInfoList.every((d) => d.processing == null || d.file)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      const depUrls = [...(tr?.code ?? "").matchAll(/["'](\/node_modules\/\.vite\/deps\/[^"']+)["']/g)].map((m) => m[1]);
      const depResults = {};
      out.stage = "deps";
      for (const dep of depUrls) {
        let status;
        for (let attempt = 0; attempt < 30; attempt++) {
          const res = await dispatchToConnect(server.middlewares, new Request(new URL(dep, "http://vite.local")));
          status = res.status;
          if (status !== 504) break;
          await new Promise((r) => setTimeout(r, 200)); // optimizer still committing
        }
        depResults[dep] = status;
      }
      await new Promise((r) => setTimeout(r, 200));
      out.ok = true;
      out.ms = Date.now() - t0;
      out.mainLen = tr?.code?.length ?? null;
      out.deps = Object.keys(depResults).length;
      out.depStatuses = depResults;
      out.root = server.config.root;
    } catch (e) {
      out.ok = false;
      out.error = e && e.stack ? String(e.stack).split("\n").slice(0, 20).join(" | ") : String(e);
    }
    return out;
  }

  // Browser-facing dev server. The DO forwards every browser HTTP request (and the
  // /__hmr WebSocket upgrade) here. Non-control paths go to vite's connect middleware.
  async fetch(request) {
    installGlobals(this.env);
    globalThis.__WAIT_UNTIL = (p) => { try { this.ctx.waitUntil(p); } catch {} };
    const url = new URL(request.url);
    try {
      await ensureDevServer(this.env.DEV_PORT);
      if (request.headers.get("Upgrade") === "websocket") {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        server.accept();
        hotAddClient(server);
        const offered = request.headers.get("Sec-WebSocket-Protocol");
        const headers = {};
        if (offered) headers["Sec-WebSocket-Protocol"] = offered.split(",")[0].trim();
        return new Response(null, { status: 101, webSocket: client, headers });
      }
      const server = await ensureDevServer(this.env.DEV_PORT);
      const inner = new Request(new URL(url.pathname + url.search, "http://vite.local"), request);
      return await dispatchToConnect(server.middlewares, inner);
    } catch (e) {
      return Response.json({ ok: false, error: String(e), stack: (e?.stack ?? "").split("\n").slice(0, 16) }, { status: 500 });
    }
  }
}
