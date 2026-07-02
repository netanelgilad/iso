// loop — the reason the build file is JS: ordinary control flow emits discrete steps.
// Each .run() in the loop is its own step (its own layer boundary once per-step caching lands).
import { from } from "iso-sdk";

let img = from("base")
  .workdir("/work")
  .copy("./app.js", "app.js");

for (const pkg of ["left-pad", "is-odd"]) {
  img = img.run("npm", ["install", pkg]);
}

export default img.cmd("node", ["app.js"]);
