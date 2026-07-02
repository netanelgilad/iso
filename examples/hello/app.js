// Runs via the image manifest CMD (`iso run hello`): proves node_modules got baked at build time.
// Machine scripts are ES modules that export a default main() — the runtime convention: module
// top-level output is dropped (no I/O context at module scope), and CJS `require` scripts fail
// loudly. See the README's honest-limits section.
import leftPad from "left-pad";
import { readFileSync } from "node:fs";

export default async function main() {
  console.log(leftPad(process.env.GREETING || "hello", 40, "*"));
  console.log("left-pad version:", JSON.parse(readFileSync(process.cwd() + "/node_modules/left-pad/package.json", "utf8")).version);
}
