// Smoke test for the iso registry — boots serve.mjs on a scratch port + scratch data dir and
// exercises the whole API v0 surface. Plain node, zero deps:
//   node experiments/iso/registry/test.mjs
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVE = path.join(HERE, "serve.mjs");

let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`FAIL: ${label}`);
  passed++;
  console.log(`  ok  ${label}`);
}
const sha256 = (buf) => "sha256:" + createHash("sha256").update(buf).digest("hex");

async function boot(port, dataDir, token) {
  const args = [SERVE, "--port", String(port), "--data", dataDir];
  if (token) args.push("--token", token);
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { // wait for the listener
    try { const r = await fetch(`${base}/v0/ping`); if (r.ok) return { child, base }; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  child.kill();
  throw new Error("server did not come up");
}

async function main() {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "iso-registry-test-"));
  const { child, base } = await boot(15999, path.join(scratch, "data"), null);
  try {
    // ping
    let r = await fetch(`${base}/v0/ping`);
    let j = await r.json();
    ok(r.status === 200 && j.ok && j.service === "iso-registry", "ping → {ok, service:iso-registry}");

    // blob PUT + HEAD + GET roundtrip (multi-MB so streaming actually streams)
    const blob = randomBytes(5 * 1024 * 1024);
    const digest = sha256(blob);
    r = await fetch(`${base}/v0/blobs/${digest}`, { method: "HEAD" });
    ok(r.status === 404, "HEAD unknown blob → 404");
    r = await fetch(`${base}/v0/blobs/${digest}`, { method: "PUT", body: blob });
    ok(r.status === 201, "PUT blob (5MB) → 201");
    r = await fetch(`${base}/v0/blobs/${digest}`, { method: "HEAD" });
    ok(r.status === 200 && Number(r.headers.get("content-length")) === blob.length, "HEAD blob → 200 + content-length");
    r = await fetch(`${base}/v0/blobs/${digest}`);
    const back = Buffer.from(await r.arrayBuffer());
    ok(r.status === 200 && back.equals(blob), "GET blob → content-identical roundtrip");
    r = await fetch(`${base}/v0/blobs/${digest}`, { method: "PUT", body: blob });
    ok(r.status === 200 && (await r.json()).existed === true, "re-PUT existing blob → 200 existed:true (dedupe)");

    // PUT with WRONG digest rejected + no corrupt blob left behind
    const wrong = sha256(Buffer.from("something else entirely"));
    r = await fetch(`${base}/v0/blobs/${wrong}`, { method: "PUT", body: blob });
    ok(r.status === 400, "PUT blob with wrong digest → 400");
    r = await fetch(`${base}/v0/blobs/${wrong}`, { method: "HEAD" });
    ok(r.status === 404, "…and the mismatched blob was NOT stored");
    r = await fetch(`${base}/v0/blobs/not-a-digest`, { method: "PUT", body: "x" });
    ok(r.status === 400, "PUT with malformed digest → 400");

    // manifest referencing a MISSING blob rejected
    const missing = sha256(Buffer.from("never uploaded"));
    r = await fetch(`${base}/v0/manifests/hello/v1`, { method: "PUT", body: JSON.stringify({ schemaVersion: 1, snapshot: missing }) });
    ok(r.status === 400 && /missing blob/.test((await r.json()).error), "PUT manifest referencing missing blob → 400");
    r = await fetch(`${base}/v0/manifests/hello/v1`, { method: "PUT", body: JSON.stringify({ schemaVersion: 1 }) });
    ok(r.status === 400, "PUT manifest referencing NO blobs → 400");

    // manifest PUT + GET roundtrip with X-Iso-Digest
    const manifest = { schemaVersion: 1, digest: "sha256:" + "0".repeat(64), snapshot: digest, entrypoint: ["node", "app.js"], history: [] };
    const mbody = Buffer.from(JSON.stringify(manifest));
    r = await fetch(`${base}/v0/manifests/hello/v1`, { method: "PUT", body: mbody });
    j = await r.json();
    ok(r.status === 201 && j.digest === sha256(mbody), "PUT manifest → 201 + manifest digest");
    ok(r.headers.get("x-iso-digest") === sha256(mbody), "PUT manifest sets X-Iso-Digest");
    r = await fetch(`${base}/v0/manifests/hello/v1`);
    const mback = Buffer.from(await r.arrayBuffer());
    ok(r.status === 200 && mback.equals(mbody), "GET manifest → byte-identical roundtrip");
    ok(r.headers.get("x-iso-digest") === sha256(mbody), "GET manifest carries X-Iso-Digest");
    ok(r.headers.get("content-type") === "application/json", "GET manifest content-type: application/json");

    // repos listing (incl. a nested repo name)
    await fetch(`${base}/v0/manifests/hello/v2`, { method: "PUT", body: mbody });
    await fetch(`${base}/v0/manifests/neta/tools/latest`, { method: "PUT", body: mbody });
    r = await fetch(`${base}/v0/repos`);
    j = await r.json();
    ok(r.status === 200
      && JSON.stringify(j) === JSON.stringify([{ repo: "hello", tags: ["v1", "v2"] }, { repo: "neta/tools", tags: ["latest"] }]),
      "GET /v0/repos → [{repo, tags:[…]}] (nested repo names work)");

    // untag
    r = await fetch(`${base}/v0/manifests/hello/v2`, { method: "DELETE" });
    ok(r.status === 200, "DELETE manifest (untag) → 200");
    r = await fetch(`${base}/v0/manifests/hello/v2`);
    ok(r.status === 404, "GET untagged manifest → 404");
    r = await fetch(`${base}/v0/manifests/hello/v2`, { method: "DELETE" });
    ok(r.status === 404, "DELETE unknown tag → 404");
    r = await fetch(`${base}/v0/repos`);
    j = await r.json();
    ok(!j.some((e) => e.repo === "hello" && e.tags.includes("v2")), "untagged tag gone from /v0/repos");
  } finally {
    child.kill();
  }

  // auth: token set → 401 without, 200 with; ping stays open
  const auth = await boot(16000, path.join(scratch, "data-auth"), "s3cret");
  try {
    let r = await fetch(`${auth.base}/v0/ping`);
    ok(r.status === 200, "auth: /v0/ping open without token");
    r = await fetch(`${auth.base}/v0/repos`);
    ok(r.status === 401, "auth: no token → 401");
    r = await fetch(`${auth.base}/v0/repos`, { headers: { authorization: "Bearer wrong" } });
    ok(r.status === 401, "auth: wrong token → 401");
    r = await fetch(`${auth.base}/v0/repos`, { headers: { authorization: "Bearer s3cret" } });
    ok(r.status === 200, "auth: correct token → 200");
  } finally {
    auth.child.kill();
    rmSync(scratch, { recursive: true, force: true });
  }

  console.log(`\nall ${passed} checks passed`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
