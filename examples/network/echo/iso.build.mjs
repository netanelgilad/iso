import { from } from "iso-sdk";

export default from("base")
  .workdir("/srv")
  .copy("./echo.mjs", "echo.mjs")
  .cmd("node", ["echo.mjs"])
  .expose(6000);
