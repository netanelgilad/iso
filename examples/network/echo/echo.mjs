// header-echo server — the rewrite proof's target member (answers with what it received)
import http from "node:http";
http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ path: req.url, headers: req.headers }, null, 2) + "\n");
}).listen(6000);
console.log("echo listening on 6000");
