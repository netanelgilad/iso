// iso REGISTRY — standalone self-hosted docker-registry analog (docs/design.md §"iso Registry").
// Content-addressed blob store + tag→manifest mapping; the transfer protocol is deliberately dumb.
// Plain Node, zero deps.
//
//   node experiments/iso/registry/serve.mjs [--port 5000] [--data ~/.iso-registry] [--token s3cret]
//
// Registry HTTP API v0:
//   GET    /v0/ping                    → {ok, service:"iso-registry", version}
//   HEAD   /v0/blobs/{digest}          → 200 | 404              (dedupe check)
//   GET    /v0/blobs/{digest}          → blob bytes (streamed)
//   PUT    /v0/blobs/{digest}          → upload; server VERIFIES sha256(body) == digest
//   GET    /v0/manifests/{repo}/{tag}  → iso.json manifest + X-Iso-Digest header
//   PUT    /v0/manifests/{repo}/{tag}  → push manifest; server verifies referenced blobs exist
//   DELETE /v0/manifests/{repo}/{tag}  → untag
//   GET    /v0/repos                   → [{repo, tags:[…]}]
//
// Auth: optional bearer token (--token / ISO_REGISTRY_TOKEN); when set, every route except
// /v0/ping requires `Authorization: Bearer <token>`.
//
// Storage layout (under --data):
//   blobs/sha256-<64hex>     content-addressed blobs — snapshots AND manifests (a manifest is
//                            just a blob whose digest is the sha256 of its stored bytes)
//   repos/<repo>/<tag>       text file: the manifest digest ("sha256:<hex>\n")
// All writes are atomic (tmp file in the data dir + rename): a killed upload never leaves a
// corrupt blob, and digest verification happens before the rename.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, renameSync, rmdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const VERSION = "0.1.3";

// --- flags/env -------------------------------------------------------------
function arg(flag, envName, dflt) {
  const i = process.argv.indexOf(flag);
  if (i !== -1 && process.argv[i + 1] != null) return process.argv[i + 1];
  return process.env[envName] ?? dflt;
}
const PORT = Number(arg("--port", "ISO_REGISTRY_PORT", 5000));
const DATA = path.resolve(String(arg("--data", "ISO_REGISTRY_DATA", path.join(os.homedir(), ".iso-registry"))).replace(/^~(?=\/|$)/, os.homedir()));
const TOKEN = arg("--token", "ISO_REGISTRY_TOKEN", "") || null;

const BLOBS = path.join(DATA, "blobs");
const REPOS = path.join(DATA, "repos");
const TMP = path.join(DATA, "tmp"); // same fs as blobs/ so rename() is atomic
for (const d of [BLOBS, REPOS, TMP]) mkdirSync(d, { recursive: true });

// --- helpers ---------------------------------------------------------------
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
// docker-ish name grammar: lowercase path segments for repos, tags allow [A-Za-z0-9_][\w.-]*
const REPO_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function blobPath(digest) { return path.join(BLOBS, digest.replace(":", "-")); }
function tagPath(repo, tag) { return path.join(REPOS, ...repo.split("/"), tag); }
function sha256(buf) { return "sha256:" + createHash("sha256").update(buf).digest("hex"); }
let tmpSeq = 0;
function tmpPath() { return path.join(TMP, `${process.pid}-${Date.now()}-${tmpSeq++}`); }

function sendJson(res, code, obj, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(obj, null, 2) + "\n");
  res.writeHead(code, { "content-type": "application/json", "content-length": body.length, ...extraHeaders });
  res.end(body);
}
function sendErr(res, code, message) { sendJson(res, code, { error: message }); }

// atomic write of a small buffer (tag files, buffered manifests)
function atomicWrite(dest, buf) {
  const t = tmpPath();
  writeFileSync(t, buf);
  mkdirSync(path.dirname(dest), { recursive: true });
  try { renameSync(t, dest); }
  catch {
    // workerd-VFS accommodation (running the registry AS an iso machine): the fork's VFS
    // rejects rename() onto an existing path ("file already exists" — POSIX rename replaces
    // atomically; captured as a fork gap). rm+rename loses atomicity for the microseconds
    // between the two calls; on real node the atomic rename above always succeeds.
    rmSync(dest, { force: true });
    renameSync(t, dest);
  }
}

// --- request handling --------------------------------------------------------
const server = createServer((req, res) => {
  try { route(req, res); }
  catch (e) { if (!res.headersSent) sendErr(res, 500, String(e?.message || e)); else res.destroy(); }
});

function route(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (req.method === "GET" && p === "/v0/ping")
    return sendJson(res, 200, { ok: true, service: "iso-registry", version: VERSION });

  // everything below is auth-gated when a token is configured
  if (TOKEN) {
    const got = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (got !== TOKEN) return sendErr(res, 401, "unauthorized: bearer token required");
  }

  let m;
  if ((m = p.match(/^\/v0\/blobs\/([^/]+)$/))) return handleBlob(req, res, decodeURIComponent(m[1]));
  if ((m = p.match(/^\/v0\/manifests\/(.+)\/([^/]+)$/))) {
    const repo = decodeURIComponent(m[1]), tag = decodeURIComponent(m[2]);
    if (!REPO_RE.test(repo)) return sendErr(res, 400, `invalid repository name: ${JSON.stringify(repo)}`);
    if (!TAG_RE.test(tag)) return sendErr(res, 400, `invalid tag: ${JSON.stringify(tag)}`);
    return handleManifest(req, res, repo, tag);
  }
  if (req.method === "GET" && p === "/v0/repos") return handleRepos(res);

  sendErr(res, 404, `no such route: ${req.method} ${p}`);
}

// --- blobs -------------------------------------------------------------------
function handleBlob(req, res, digest) {
  if (!DIGEST_RE.test(digest)) return sendErr(res, 400, `invalid digest (want sha256:<64 hex>): ${digest}`);
  const file = blobPath(digest);

  if (req.method === "HEAD") {
    if (!existsSync(file)) { res.writeHead(404); return res.end(); }
    const st = statSync(file);
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": st.size, "x-iso-digest": digest });
    return res.end();
  }

  if (req.method === "GET") {
    if (!existsSync(file)) return sendErr(res, 404, `blob not found: ${digest}`);
    const st = statSync(file);
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": st.size, "x-iso-digest": digest });
    // Buffered single-write instead of createReadStream().pipe(res): under the workerd fork's
    // node:http server bridge, a PIPED response truncates at the first 64KB chunk (fork gap,
    // captured) while a single end(buffer) delivers 20MB intact in ~100ms. Registry blobs are
    // snapshot-sized (tens of MB) — the buffered read is an acceptable tradeoff on real node too.
    return res.end(readFileSync(file));
  }

  if (req.method === "PUT") {
    if (existsSync(file)) { // content-addressed: identical by definition, drain and ack
      req.resume();
      return req.on("end", () => sendJson(res, 200, { ok: true, digest, existed: true }));
    }
    // stream body → tmp file while hashing; verify BEFORE the rename into blobs/
    const t = tmpPath();
    const hash = createHash("sha256");
    const out = createWriteStream(t, { flags: "wx" });
    let size = 0, failed = false;
    const fail = (code, msg) => { if (failed) return; failed = true; out.destroy(); rmSync(t, { force: true }); sendErr(res, code, msg); };
    req.on("data", (chunk) => { hash.update(chunk); size += chunk.length; });
    req.on("error", () => fail(400, "upload aborted"));
    out.on("error", (e) => fail(500, `write failed: ${e.message}`));
    req.pipe(out);
    out.on("finish", () => {
      if (failed) return;
      const actual = "sha256:" + hash.digest("hex");
      if (actual !== digest) return fail(400, `digest mismatch: body is ${actual}, url says ${digest}`);
      renameSync(t, file); // atomic: the blob appears fully-formed or not at all
      sendJson(res, 201, { ok: true, digest, size });
    });
    return;
  }

  sendErr(res, 405, `method not allowed: ${req.method}`);
}

// --- manifests -----------------------------------------------------------------
// The manifest's referenced blobs: `blobs` (array of digests) and/or `snapshot` (single digest).
// At least one reference is required — a manifest that points at nothing can't be pulled.
function referencedBlobs(manifest) {
  const refs = [];
  if (typeof manifest.snapshot === "string") refs.push(manifest.snapshot);
  if (Array.isArray(manifest.blobs)) refs.push(...manifest.blobs);
  return refs;
}

function handleManifest(req, res, repo, tag) {
  const tfile = tagPath(repo, tag);

  if (req.method === "GET") {
    if (!existsSync(tfile)) return sendErr(res, 404, `manifest not found: ${repo}:${tag}`);
    const digest = readFileSync(tfile, "utf8").trim();
    const bfile = blobPath(digest);
    if (!existsSync(bfile)) return sendErr(res, 404, `dangling tag ${repo}:${tag} → ${digest}`);
    const body = readFileSync(bfile);
    res.writeHead(200, { "content-type": "application/json", "content-length": body.length, "x-iso-digest": digest });
    return res.end(body);
  }

  if (req.method === "PUT") {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size > 8 * 1024 * 1024) { req.destroy(); } else chunks.push(c); });
    req.on("error", () => { if (!res.headersSent) sendErr(res, 400, "upload aborted (manifest too large? 8MB cap)"); });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      let manifest;
      try { manifest = JSON.parse(body.toString("utf8")); } catch { return sendErr(res, 400, "manifest is not valid JSON"); }
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return sendErr(res, 400, "manifest must be a JSON object");
      const refs = referencedBlobs(manifest);
      if (refs.length === 0) return sendErr(res, 400, "manifest references no blobs (want `snapshot: \"sha256:…\"` or `blobs: […]`)");
      for (const d of refs) {
        if (!DIGEST_RE.test(d)) return sendErr(res, 400, `manifest references invalid digest: ${d}`);
        if (!existsSync(blobPath(d))) return sendErr(res, 400, `manifest references missing blob: ${d} (push blobs before the manifest)`);
      }
      // the manifest is itself a blob; its digest is the sha256 of the exact bytes we store
      const digest = sha256(body);
      if (!existsSync(blobPath(digest))) atomicWrite(blobPath(digest), body);
      atomicWrite(tfile, digest + "\n"); // tag flip is a single rename — never half-written
      sendJson(res, 201, { ok: true, repo, tag, digest }, { "x-iso-digest": digest });
    });
    return;
  }

  if (req.method === "DELETE") {
    if (!existsSync(tfile)) return sendErr(res, 404, `manifest not found: ${repo}:${tag}`);
    rmSync(tfile);
    // prune now-empty repo dirs so /v0/repos doesn't list ghosts (manifest/snapshot blobs stay — no GC in v1)
    let d = path.dirname(tfile);
    while (d !== REPOS && readdirSync(d).length === 0) { rmdirSync(d); d = path.dirname(d); }
    return sendJson(res, 200, { ok: true, untagged: `${repo}:${tag}` });
  }

  sendErr(res, 405, `method not allowed: ${req.method}`);
}

// --- repos ---------------------------------------------------------------------
function handleRepos(res) {
  const out = [];
  (function walk(dir, prefix) {
    if (!existsSync(dir)) return;
    const tags = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name), prefix ? `${prefix}/${e.name}` : e.name);
      else if (e.isFile()) tags.push(e.name);
    }
    if (tags.length) out.push({ repo: prefix, tags: tags.sort() });
  })(REPOS, "");
  out.sort((a, b) => a.repo.localeCompare(b.repo));
  sendJson(res, 200, out);
}

server.listen(PORT, () => {
  console.log(`iso-registry v${VERSION} listening on http://127.0.0.1:${PORT}`);
  console.log(`  data:  ${DATA}`);
  console.log(`  auth:  ${TOKEN ? "bearer token required (except /v0/ping)" : "none"}`);
});
