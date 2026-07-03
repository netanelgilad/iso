// iso `sh` — the machine shell, a REAL JS shell binary (busybox-equivalent for a pure-JS/wasm
// platform). Bundled with just-bash (vercel-labs) at image-build time into usr/bin/sh by
// experiments/iso/build-image.mjs. It is a REPL over the child's REAL process.stdin/stdout:
// prompt → read line → execute over the machine's actual /tmp (NativeFsAdapter over node:fs)
// → loop until EOF (Ctrl-D) or `exit`.
//
// v1 command surface = just-bash BUILTINS (ls/cat/echo/pwd/mkdir/rm/cp/mv/grep/head/tail/…,
// pipes and redirects as just-bash supports) + local `cd` tracking. External-command dispatch
// (routing an unknown command through the machine's bin resolution) is NOT wired in v1 — a
// nested sub-isolate spawn from inside a child needs the spawn-bridge seam; documented.
//
// NOTE: line reading is done over process.stdin 'data'/'end' directly — the runtime's
// node:readline is a no-op stub (see README "Interactive exec"), and stdin itself is a genuine
// Readable, so plain stream consumption is the honest path.
import { Bash, defineCommand } from "just-bash";
import * as fs from "node:fs";
import path from "node:path";

function toStat(s) {
  return {
    isFile: s.isFile(), isDirectory: s.isDirectory(), isSymbolicLink: s.isSymbolicLink(),
    mode: Number(s.mode) & 0o777, size: Number(s.size), mtime: new Date(Number(s.mtimeMs ?? Date.now())),
  };
}

// just-bash IFileSystem adapter over workerd's NATIVE node:fs — the machine's real shared /tmp.
// (Adapted from experiments/npm-in-workerd/do-shell/shims/bash-native.mjs.)
class NativeFsAdapter {
  resolvePath(base, p) { return path.isAbsolute(p) ? path.normalize(p) : path.normalize(path.join(base, p)); }
  async readFile(p, options) { const enc = typeof options === "string" ? options : options?.encoding; return fs.readFileSync(p, enc ?? "utf8"); }
  async readFileBuffer(p) { const b = fs.readFileSync(p); return b instanceof Uint8Array ? b : new TextEncoder().encode(String(b)); }
  async writeFile(p, content, options) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content, typeof options === "string" ? options : options?.encoding ? options.encoding : undefined); }
  async appendFile(p, content, options) { fs.appendFileSync(p, content, typeof options === "string" ? options : undefined); }
  async exists(p) { return fs.existsSync(p); }
  async stat(p) { return toStat(fs.statSync(p)); }
  async lstat(p) { return toStat(fs.lstatSync(p)); }
  async mkdir(p, options) { fs.mkdirSync(p, { recursive: options?.recursive ?? false }); }
  async readdir(p) { return fs.readdirSync(p).map(String); }
  async readdirWithFileTypes(p) {
    return fs.readdirSync(p, { withFileTypes: true }).map((d) => ({
      name: String(d.name), isFile: d.isFile(), isDirectory: d.isDirectory(), isSymbolicLink: d.isSymbolicLink(),
    }));
  }
  async rm(p, options) { fs.rmSync(p, { recursive: options?.recursive ?? false, force: options?.force ?? false }); }
  async cp(src, dest, options) {
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      if (!options?.recursive) throw new Error(`cp: -r not specified; omitting directory '${src}'`);
      fs.mkdirSync(dest, { recursive: true });
      for (const e of fs.readdirSync(src)) await this.cp(path.join(src, String(e)), path.join(dest, String(e)), options);
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, fs.readFileSync(src));
    }
  }
  async mv(src, dest) { fs.renameSync(src, dest); }
  getAllPaths() {
    const out = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, String(e.name)); out.push(p); if (e.isDirectory()) walk(p); } };
    try { walk("/tmp"); } catch {}
    return out;
  }
  async chmod(p, mode) { fs.chmodSync(p, mode); }
  async symlink(target, linkPath) { fs.symlinkSync(target, linkPath); }
  async link(a, b) { fs.linkSync(a, b); }
  async readlink(p) { return String(fs.readlinkSync(p)); }
  async realpath(p) { return String(fs.realpathSync(p)); }
  async utimes(p, atime, mtime) { fs.utimesSync(p, atime, mtime); }
}

// External-command dispatch: bins on PATH (and `node <script>`) run as REAL CHILDREN of this
// shell via workerd's NATIVE child_process.spawn with REAL streaming stdio (fork 83df466):
// stdio:"inherit" forwards the child's stdout/stderr INCREMENTALLY into this shell's stdio
// (→ the session, live) and pumps this shell's stdin into the child — true FOREGROUND
// semantics (an interactive child gets your keystrokes; sh gates its own line reader while
// one runs). Exit codes come back as $?. Externals no longer feed just-bash pipelines
// (inherit bypasses capture — the fork's "pipe" mode is the seam if that's ever wanted).
// Names that are just-bash builtins are never shadowed.
const BUILTIN_DENY = new Set(["ls", "cat", "echo", "pwd", "mkdir", "rm", "cp", "mv", "grep", "head",
  "tail", "sed", "awk", "sort", "tar", "file", "touch", "true", "false", "test", "find", "wc",
  "which", "env", "printenv", "sleep", "date", "basename", "dirname", "xargs", "cut", "tr",
  "uniq", "diff", "chmod", "ln", "readlink", "printf", "sh", "bash", "cd", "export", "exit"]);

export default async function main() {
  const process = (await import("node:process")).default;
  let cwd = "/work";
  try { const c = process.cwd(); if (c && c.startsWith("/")) cwd = c; } catch {}
  try { fs.mkdirSync(cwd, { recursive: true }); } catch {}

  // session state — just-bash exec is stateless per call, so the SHELL BINARY owns cwd, exported
  // vars, and $? (that is a shell's job).
  const sessionEnv = {};
  let lastCode = 0;
  let fgActive = false; // a foreground external is running: session stdin belongs to IT

  const bash = new Bash({ fs: new NativeFsAdapter(), cwd, defenseInDepth: false });

  // one just-bash command per PATH bin (+ node); execute = one NATIVE child_process.spawn.
  const { spawn } = await import("node:child_process");
  const registered = new Set();
  const makeExternal = (name) => defineCommand(name, async (args, ctx) => {
    const envOut = {};
    try { for (const [k, v] of (ctx.env?.entries?.() || [])) if (typeof v === "string") envOut[k] = v; } catch {}
    // the machine's process env must win over just-bash's defaults (its HOME/PATH point at
    // paths that don't exist on the VFS — npm's cache mkdir would EPERM); explicit exports win last.
    envOut.PATH = "/usr/bin:" + (ctx.cwd || cwd) + "/node_modules/.bin:/bin";
    envOut.HOME = "/root";
    Object.assign(envOut, sessionEnv);
    // `node <flag...>` (e.g. -e/-p/--version): the fork's native spawn special-cases `node <arg>`
    // as "run arg as a script", so `node -e` would try to run a file named "-e". Route flag-shaped
    // node invocations through the launcher UNDER A NON-`node` NAME so the fork runs it AS a script
    // and hands it the flags. Plain `node <script>` keeps the native path (unchanged).
    let spawnName = name, spawnArgs = args;
    if (name === "node" && (args.length === 0 || String(args[0]).startsWith("-"))) {
      spawnArgs = ["/usr/lib/iso/node-cli.js", ...args];
    }
    fgActive = true; // the child owns the terminal: output streams live, stdin routes to it
    try {
      return await new Promise((resolve) => {
        let c;
        try { c = spawn(spawnName, spawnArgs, { cwd: ctx.cwd || cwd, env: envOut, stdio: "inherit" }); }
        catch (e) { resolve({ stdout: "", stderr: "sh: " + name + ": spawn failed: " + String((e && e.message) || e) + "\n", exitCode: 126 }); return; }
        c.on("exit", (code) => resolve({ stdout: "", stderr: "", exitCode: code ?? 0 }));
        c.on("error", (e) => resolve({ stdout: "", stderr: "sh: " + name + ": " + String((e && e.message) || e) + "\n", exitCode: 126 }));
      });
    } finally { fgActive = false; }
  });
  const scanExternals = () => {
    const names = new Set(["node", "npm", "npx"]);
    for (const dir of ["/usr/bin", cwd + "/node_modules/.bin"]) {
      try { for (const n of fs.readdirSync(dir)) names.add(n); } catch {}
    }
    for (const n of names) {
      if (registered.has(n) || BUILTIN_DENY.has(n) || n.startsWith(".") || n.startsWith("__")) continue;
      registered.add(n);
      try { bash.registerCommand(makeExternal(n)); } catch (e) { process.stderr.write("sh: register " + n + ": " + String(e && e.message || e) + "\n"); }
    }
  };
  scanExternals();

  const write = (s) => process.stdout.write(s);
  const prompt = () => write(cwd + " $ ");

  // run one command line: session-state interception (exit/$?/export/cd) + just-bash + externals
  const runLine = async (cmd) => {
    if (cmd === "exit" || /^exit\s/.test(cmd)) process.exit(Number(cmd.split(/\s+/)[1] || 0) || 0);
    cmd = cmd.replaceAll("$?", String(lastCode)); // $? expansion (v1: textual; single-quote blind)
    const ex = cmd.match(/^export\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/); // session-scoped export
    if (ex) { sessionEnv[ex[1]] = ex[2].replace(/^["']|["']$/g, ""); lastCode = 0; return; }
    const cdOnly = cmd.match(/^cd(?:\s+(\S+))?$/); // bare cd tracks the prompt; `cd x && …` runs inside just-bash
    if (cdOnly) {
      const target = cdOnly[1] || "/root";
      const dest = path.isAbsolute(target) ? path.normalize(target) : path.normalize(path.join(cwd, target));
      if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) { cwd = dest; lastCode = 0; }
      else { process.stderr.write("sh: cd: " + target + ": No such file or directory\n"); lastCode = 1; }
      return;
    }
    try {
      const r = await bash.exec(cmd, { cwd, env: sessionEnv });
      if (r.stdout) write(r.stdout);
      if (r.stderr) process.stderr.write(r.stderr);
      lastCode = r.exitCode ?? 0;
    } catch (e) {
      process.stderr.write("sh: " + String((e && e.message) || e) + "\n");
      lastCode = 1;
    }
  };

  // `sh -c <script>`: run one command line and exit with its code — npm lifecycle scripts arrive
  // in exactly this shape (child_process shim → spawn syscall → this bin).
  const argv = process.argv || [];
  if (argv[2] === "-c") {
    await runLine(String(argv[3] || "").trim());
    process.exit(lastCode);
  }

  // interactive REPL: plain line reader over the (real) stdin Readable; while a foreground
  // external runs, the runtime pumps session stdin into IT (stdio inherit) and this reader
  // stands down (fgActive).
  let pending = "";
  const lines = [];
  let notify = null, ended = false;
  const wake = () => { if (notify) { const n = notify; notify = null; n(); } };
  process.stdin.on("data", (c) => {
    if (fgActive) return; // foreground child owns stdin (the runtime pumps it there natively)
    pending += c.toString();
    let i;
    while ((i = pending.indexOf("\n")) >= 0) { lines.push(pending.slice(0, i)); pending = pending.slice(i + 1); }
    wake();
  });
  process.stdin.on("end", () => { ended = true; wake(); });
  const nextLine = async () => {
    while (!lines.length) {
      if (ended) return null;
      await new Promise((r) => { notify = r; });
    }
    return lines.shift();
  };

  prompt();
  while (true) {
    const line = await nextLine();
    if (line === null) { write("\n"); break; } // EOF (Ctrl-D / pipe end)
    const cmd = line.trim();
    if (!cmd) { prompt(); continue; }
    await runLine(cmd);
    scanExternals(); // pick up freshly installed node_modules/.bin entries
    prompt();
  }
}
