// iso BASE IMAGE BUILD — assemble the workerd-ready "base" rootfs, self-contained.
//
//   node packages/base-image/build.mjs            # → $ISO_BASE_STAGING (default ~/.iso/base/.staging)
//
// This is the product-repo build: it depends ONLY on this repo's installed node_modules
// (npm, esbuild-wasm, just-bash) — no reference to any external checkout. `iso host start`
// runs it automatically the first time if the base image is missing.
//
// The rootfs is VANILLA npm copied byte-for-byte (zero source rewrites — every gap that once
// needed a shim is now a workerd-fork primitive), plus a thin environmental overlay:
//   usr/lib/node_modules/npm/   seed npm 11, verbatim
//   usr/bin/npm, usr/bin/npx    launchers (import the real bin from the VFS; pre-own package files)
//   usr/bin/{echo,pwd,true,false,cat,ls,node}   coreutils bins (native spawn has no shell pass)
//   usr/bin/iso-tick            streaming-logs demo bin
//   usr/bin/sh + usr/lib/iso/sh.mjs   a real shell (just-bash) bundled to one ESM file
//   etc/npmrc                   registry / cache / ignore-scripts defaults
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // packages/base-image
const require = createRequire(import.meta.url);
const OUT = process.env.ISO_BASE_STAGING || path.join(os.homedir(), ".iso", "base", ".staging");

// The install/repo node_modules (two up from packages/base-image) holds the seed npm, esbuild-wasm,
// and just-bash. Resolving package dirs by directory (not `require.resolve(pkg/package.json)`,
// which some packages' "exports" forbid) is robust.
const NODE_MODULES = path.resolve(HERE, "..", "..", "node_modules");
function resolvePkgDir(name) {
  const dir = path.join(NODE_MODULES, name);
  if (!existsSync(dir)) throw new Error("dependency not installed: " + name + " (expected at " + dir + ")");
  return dir;
}
const NPM_SRC = resolvePkgDir("npm");

console.log("# building iso 'base' image → " + OUT);
rmSync(OUT, { recursive: true, force: true });
const NPM_DEST = path.join(OUT, "usr/lib/node_modules/npm");
mkdirSync(NPM_DEST, { recursive: true });
console.log("  copying npm (verbatim) from " + NPM_SRC);
cpSync(NPM_SRC, NPM_DEST, { recursive: true });

// npm/npx LAUNCHERS (environmental adaptation, ZERO npm rewrites): pre-own the package files
// so npm's in-place PackageJson.save is same-isolate (the fork's shared-VFS assertion rejects a
// cross-isolate in-place write; read→rm→write re-owns), then require the real bin.
const npmLauncher = (bin) => `// iso overlay launcher — environmental adaptation, zero npm rewrites
const fs = require("node:fs");
const cwd = process.cwd();
for (const f of ["package.json", "package-lock.json", "node_modules/.package-lock.json"]) {
  const p = cwd + "/" + f;
  try { const b = fs.readFileSync(p); fs.rmSync(p); fs.writeFileSync(p, b); } catch {}
}
require(${JSON.stringify(bin)});
`;
mkdirSync(path.join(OUT, "usr/bin"), { recursive: true });
writeFileSync(path.join(OUT, "usr/bin/npm"), npmLauncher("/usr/lib/node_modules/npm/bin/npm-cli.js"));
writeFileSync(path.join(OUT, "usr/bin/npx"), npmLauncher("/usr/lib/node_modules/npm/bin/npx-cli.js"));

mkdirSync(path.join(OUT, "etc"), { recursive: true });
writeFileSync(path.join(OUT, "etc/npmrc"),
  "cache=/root/.npm\nregistry=https://registry.npmjs.org/\nignore-scripts=true\naudit=false\nfund=false\nupdate-notifier=false\nlegacy-peer-deps=true\n");

// iso-tick: emit `count` lines `gap` ms apart, then exit — proves streaming logs (line-by-line
// wall-clock arrival under `iso logs -f`). A real node-style script: top-level code, async work
// in an IIFE (the platform runs required scripts' top level in-context; drainProcess owns the tail).
writeFileSync(path.join(OUT, "usr/bin/iso-tick"), `// iso-tick demo bin — proves streaming logs (line every <gap> ms).
(async () => {
  const count = parseInt(process.argv[2] || "8", 10);
  const gap = parseInt(process.argv[3] || "250", 10);
  console.log("iso-tick: emitting " + count + " lines, " + gap + "ms apart");
  for (let i = 1; i <= count; i++) {
    console.log("tick " + i + "/" + count + " @ " + new Date().toISOString());
    await new Promise((r) => setTimeout(r, gap));
  }
  console.log("iso-tick: done");
})();
`);

// CORE UTILITY BINS (busybox-style, real top-level CJS programs): the fork's native spawn
// tokenizes `sh -c '<line>'` into argv and resolves argv[0] as a bin — npm lifecycle/run scripts
// therefore need actual echo/true/… executables on PATH (there is no shell pass at that layer).
const COREUTILS = {
  echo: `console.log(process.argv.slice(2).join(" "));\n`,
  pwd: `console.log(process.cwd());\n`,
  true: `process.exit(0);\n`,
  false: `process.exit(1);\n`,
  cat: `const fs = require("node:fs");
const cwd = process.cwd();
for (const f of process.argv.slice(2)) {
  try { process.stdout.write(fs.readFileSync(f.startsWith("/") ? f : cwd + "/" + f, "utf8")); }
  catch (e) { console.error("cat: " + f + ": No such file or directory"); process.exitCode = 1; }
}
`,
  ls: `const fs = require("node:fs");
const cwd = process.cwd();
const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
for (const d of (args.length ? args : ["."])) {
  try { console.log(fs.readdirSync(d.startsWith("/") ? d : cwd + "/" + d).join("\\n")); }
  catch (e) { console.error("ls: " + d + ": No such file or directory"); process.exitCode = 1; }
}
`,
};
for (const [name, src] of Object.entries(COREUTILS)) writeFileSync(path.join(OUT, "usr/bin", name), src);
// usr/bin/node — a PATH marker: just-bash (custom-fs mode) only dispatches commands that exist
// as files on PATH; sh's registered `node` external then runs it via the fork's native spawn,
// which special-cases `node <script>` at resolution (this file's content is never executed).
writeFileSync(path.join(OUT, "usr/bin/node"), "// node = the isolate runtime itself; `node <script>` is resolved natively by spawn\n");

// usr/bin/sh — a REAL shell: just-bash + a native-node:fs adapter + a REPL over stdin/stdout,
// bundled to ONE self-contained ESM file. sh-entry.mjs resolves bare "just-bash" from our
// node_modules at bundle time; native @mongodb-js/zstd (reached only by just-bash's lazy
// tar/file chunks) stays external to keep the bundle pure-JS.
{
  const esbuild = require("esbuild-wasm");
  resolvePkgDir("just-bash"); // ensure present; sh-entry.mjs imports it bare
  // just-bash lazily references optional/native deps for its heavy command chunks (compression,
  // sqlite, AI, a JS engine, its own test harness). The iso shell only needs the core REPL +
  // spawn dispatch, so we keep those chunks EXTERNAL — the bundle stays pure-JS; those specific
  // commands (e.g. a zstd/xz `tar`, `sqlite3`) error if invoked, which is fine and documented.
  const external = [
    "@mongodb-js/zstd", "node-liblzma", "seek-bzip", // compression backends
    "sql.js",                                          // sqlite command
    "ai", "turndown", "bash-tool",                     // AI/agent command chunks
    "quickjs-emscripten",                              // embedded JS engine
    "vitest",                                          // just-bash's own test harness
  ];
  const r = await esbuild.build({
    entryPoints: [path.join(HERE, "sh/sh-entry.mjs")],
    bundle: true, format: "esm", platform: "node",
    nodePaths: [NODE_MODULES],
    external,
    write: false, logLevel: "silent",
  });
  mkdirSync(path.join(OUT, "usr/lib/iso"), { recursive: true });
  writeFileSync(path.join(OUT, "usr/lib/iso/sh.mjs"), r.outputFiles[0].text);
  writeFileSync(path.join(OUT, "usr/bin/sh"), `// iso sh launcher — impl bundled at usr/lib/iso/sh.mjs (just-bash + REPL)
export default async function main() {
  const mod = await import("/usr/lib/iso/sh.mjs");
  return mod.default();
}
`);
  console.log("  bundled sh (" + Math.round(r.outputFiles[0].text.length / 1024) + "kB, just-bash)");
  try { esbuild.stop?.(); } catch {}
}

let files = 0, bytes = 0;
(function count(d) { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) count(p); else { files++; bytes += statSync(p).size; } } })(OUT);
console.log(`  staged ${files} files (${(bytes / 1e6).toFixed(1)} MB)`);
// esbuild-wasm keeps the event loop alive; we're done — exit cleanly.
process.exit(0);
