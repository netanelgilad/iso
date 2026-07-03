// iso `node` launcher — installed at /usr/bin/node in the base image.
//
// In a machine there is no node BINARY: the isolate runtime IS node. Script paths
// (`node app.js`) are special-cased by the runner and the fork's native spawn BEFORE this
// launcher runs — what reaches this file is the rest of the node CLI surface:
//
//   node -e/--eval <code>    run <code> as a CJS module body (require/process/__dirname in scope)
//   node -p/--print <code>   evaluate <code> as an expression and print its value
//   node --version | -v      print the runtime's node version
//   node <bare-name>         require() it relative to cwd (a script path without ./ or extension)
//
// SEMANTICS / DIVERGENCE (honest): the isolate blocks `eval`/`new Function` (workerd disallows
// code generation from strings), so `-e`/`-p` are implemented by materializing the code as a
// scratch CJS module and require()-ing it — the SAME in-context loader a `node <script>` uses.
// This gives node's DEFAULT CommonJS eval semantics (`--input-type=module` is NOT supported).
// `-p` wraps the code as a single expression (`( <code> )`); a statement body under `-p` is a
// SyntaxError, as it is a corner even in node.
//
// Anything else fails LOUDLY (exit 9 — node's invalid-argument code). The one hard rule:
// NEVER exit 0 having silently done nothing.
const __isoFs = require("node:fs");
const __isoPath = require("node:path");
const __isoUtil = require("node:util");

let __isoAv = process.argv.slice(1);
// the runner/spawn may bake the launcher's own path as argv[0] — drop it if present. This file
// is installed at BOTH /usr/bin/node (resolveProbe/PATH) and /usr/lib/iso/node-cli.js (the name
// `sh` spawns it under, so the fork's `node <script>` special-case runs it as a script).
if (__isoAv.length && /(^|\/)node(-launcher\.cjs|-cli\.js)?$/.test(String(__isoAv[0]))) __isoAv = __isoAv.slice(1);

const __isoSupported = "supported: script paths, -e/-p, --eval/--print, --version";
function __isoFail(msg, code) { console.error(msg); process.exit(code == null ? 9 : code); }

function __isoRunModule(source, argvRest, printResult) {
  // materialize the code as a scratch CJS module and require it (no eval).
  const dir = "/tmp/.iso-eval-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6);
  __isoFs.mkdirSync(dir, { recursive: true });
  const file = dir + "/eval.js";
  const body = printResult
    ? 'module.exports.__isoVal = (\n' + source + '\n);'
    : source;
  __isoFs.writeFileSync(file, body);
  // node's -e argv semantics: the code is NOT in argv; remaining args become argv[1..].
  process.argv = ["node", ...argvRest];
  let mod;
  try {
    mod = require(file);
  } catch (err) {
    console.error((err && err.stack) || String(err));
    process.exit(1);
  } finally {
    try { __isoFs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  if (printResult) {
    const v = mod.__isoVal;
    console.log(typeof v === "string" ? v : __isoUtil.inspect(v));
  }
}

if (__isoAv.length === 0) {
  __isoFail("iso: node: the interactive REPL is not supported in a machine (" + __isoSupported + ")");
} else if (__isoAv[0] === "--version" || __isoAv[0] === "-v") {
  console.log(process.version);
} else if (__isoAv[0] === "-e" || __isoAv[0] === "--eval" || __isoAv[0] === "-p" || __isoAv[0] === "--print") {
  const printResult = __isoAv[0] === "-p" || __isoAv[0] === "--print";
  const code = __isoAv[1];
  if (code === undefined) __isoFail("iso: node: " + __isoAv[0] + " requires an argument");
  __isoRunModule(code, __isoAv.slice(2), printResult);
} else if (String(__isoAv[0]).startsWith("-")) {
  __isoFail("iso: node: unsupported flag '" + __isoAv[0] + "' (" + __isoSupported + ")");
} else {
  // a script name the runner didn't special-case (no ./ and no extension): run it like node would.
  process.argv = ["node", ...__isoAv];
  require(__isoPath.resolve(process.cwd(), __isoAv[0]));
}
