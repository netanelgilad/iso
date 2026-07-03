// scripts/test-node-launcher.mjs — lock the `node -e` silent-no-op regression (v0.1.2).
// The base-image `node` launcher is plain CJS, so it runs directly under real node — we exercise
// its CLI surface here without needing workerd. `node scripts/test-node-launcher.mjs`
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = path.join(ROOT, "packages/base-image/node-launcher.cjs");

let pass = 0, fail = 0;
function run(args) {
  const r = spawnSync(process.execPath, [LAUNCHER, ...args], { encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? " — " + detail : "")); }
}

// the reported bug: `-e` must PRINT and exit 0 (never a silent no-op reporting success)
let r = run(["-e", 'console.log("hello world")']);
check("-e prints and exits 0", r.code === 0 && r.out === "hello world", JSON.stringify(r));

r = run(["--eval", 'console.log(1+1)']);
check("--eval works", r.code === 0 && r.out === "2", JSON.stringify(r));

r = run(["-p", "1+1"]);
check("-p prints completion value", r.code === 0 && r.out === "2", JSON.stringify(r));

r = run(["--print", 'JSON.stringify({a:1})']);
check("--print works", r.code === 0 && r.out === '{"a":1}', JSON.stringify(r));

r = run(["-e", 'throw new Error("boom")']);
check("failing -e exits non-zero with stack", r.code !== 0 && /Error: boom/.test(r.err), JSON.stringify(r));

r = run(["-e", "require('node:os')"]);
check("-e has require in scope (CJS)", r.code === 0, JSON.stringify(r));

r = run(["-e", "console.log(JSON.stringify(process.argv))", "a", "b"]);
check("-e argv is [node, ...rest] (code not in argv)", r.code === 0 && r.out === '["node","a","b"]', JSON.stringify(r));

r = run(["--version"]);
check("--version prints a version, exit 0", r.code === 0 && /^v\d+\./.test(r.out), JSON.stringify(r));

r = run(["--frobnicate"]);
check("unsupported flag exits non-zero + loud stderr", r.code !== 0 && /unsupported flag/.test(r.err), JSON.stringify(r));

r = run([]);
check("no args (REPL) exits non-zero, never silent", r.code !== 0 && /REPL is not supported/.test(r.err), JSON.stringify(r));

console.log("\n" + (fail ? "FAILED" : "all " + pass + " node-launcher checks passed"));
process.exit(fail ? 1 : 0);
