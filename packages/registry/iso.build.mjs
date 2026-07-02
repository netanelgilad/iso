// The iso Registry AS AN ISO IMAGE — the capstone: the registry runs ON the isolates cloud,
// exactly like docker's `registry:2` is a docker image. serve.mjs runs UNMODIFIED in the
// machine (the fork's node:http server compat: createServer().listen() + the published-port
// bridge). Data lives in the machine's /tmp — ephemeral (no volumes on this platform yet).
//
//   iso build -t registry experiments/iso/registry
//   iso run -d --name reg -p 5055:5000 registry
//   curl http://127.0.0.1:5055/v0/ping
import { from } from "iso-sdk";

export default from("base")
  .workdir("/registry")
  .copy("./serve.mjs", "serve.mjs")
  .cmd("node", ["serve.mjs", "--port", "5000", "--data", "/var/registry-data"])
  .expose(5000);
