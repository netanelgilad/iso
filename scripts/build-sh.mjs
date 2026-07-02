// scripts/build-sh.mjs — prebuild the sh shell bundle into packages/base-image/prebuilt/sh.mjs.
// Run this from a full dev checkout (node_modules present) BEFORE packaging a release; the
// prebuilt artifact ships in the tarball so no user install has to resolve just-bash's optional
// command deps. `node scripts/build-sh.mjs`
import esbuild from "esbuild-wasm";
import path from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const r = await esbuild.build({
  entryPoints: [path.join(ROOT, "packages/base-image/sh/sh-entry.mjs")],
  bundle: true, format: "esm", platform: "node",
  nodePaths: [path.join(ROOT, "node_modules")],
  external: ["@mongodb-js/zstd", "ai", "bash-tool"],
  write: false, logLevel: "info",
});
mkdirSync(path.join(ROOT, "packages/base-image/prebuilt"), { recursive: true });
const out = path.join(ROOT, "packages/base-image/prebuilt/sh.mjs");
writeFileSync(out, r.outputFiles[0].text);
console.log("wrote " + path.relative(ROOT, out) + " (" + Math.round(r.outputFiles[0].text.length / 1024) + "kB)");
esbuild.stop?.();
process.exit(0);
