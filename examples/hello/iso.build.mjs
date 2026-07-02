// hello — the canonical iso build file. Each chained call is one discrete build step.
import { from } from "iso-sdk";

export default from("base")
  .workdir("/work")
  .copy("./app.js", "app.js")
  .run("npm", ["install", "left-pad"])
  .env({ GREETING: "hello from an iso image" })
  .cmd("node", ["app.js"]);
