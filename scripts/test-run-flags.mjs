// scripts/test-run-flags.mjs — guard `iso run` flag parsing for -i/-t/-it/--rm (v0.1.4) without
// needing a host: with no active context, a PARSE success reaches "no active context" while a
// bad flag dies at "unknown flag". Runs under plain node in CI. `node scripts/test-run-flags.mjs`
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import os from "node:os";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "packages/cli/iso.mjs");
// point state + HOME at an empty scratch dir so there is no active context
const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "iso-runflags-"));
const env = { ...process.env, HOME: SCRATCH, ISO_STATE: path.join(SCRATCH, "nostate.json") };

let pass = 0, fail = 0;
function run(args) {
  const r = spawnSync(process.execPath, [CLI, "run", ...args], { encoding: "utf8", env });
  return { code: r.status, err: (r.stderr || "") + (r.stdout || "") };
}
function check(name, cond, detail) {
  if (cond) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? " — " + detail : "")); }
}

// PARSE OK → reaches host-connection stage (no active context), NOT "unknown flag"
for (const args of [["-it", "base", "sh"], ["-ti", "base", "sh"], ["-i", "-t", "base", "sh"],
                    ["--interactive", "--tty", "base", "sh"], ["--rm", "-it", "base", "sh"],
                    ["--rm", "base", "node", "-e", "1"]]) {
  const r = run(args);
  check("parses: iso run " + args.join(" "), !/unknown flag/.test(r.err) && /no active context|Cannot connect/.test(r.err), JSON.stringify(r));
}

// bad combined short must stay loud + non-zero
let r = run(["-itZ", "base"]);
check("unknown combined flag -itZ is loud + non-zero", r.code !== 0 && /unknown flag/.test(r.err), JSON.stringify(r));
r = run(["--bogus", "base"]);
check("unknown long flag is loud + non-zero", r.code !== 0 && /unknown flag/.test(r.err), JSON.stringify(r));

console.log("\n" + (fail ? "FAILED" : "all " + pass + " run-flag checks passed"));
process.exit(fail ? 1 : 0);
