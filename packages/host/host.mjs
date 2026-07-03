// iso HOST (the daemon) — miniflare hosting the control-plane Worker + Machine/Registry DOs,
// driven by the forked workerd binary (shared-/tmp feature). Same config shape as
// base-image/run.mjs: a HOST service that serves the image rootfs as a base64 manifest, a
// worker_loaders LOADER binding (sub-isolates), and the UNSAFE_EVAL binding.
//
// Normally launched by `iso host start` (which resolves the forked workerd binary and builds the
// base image if missing). To run directly:
//   MINIFLARE_WORKERD_PATH=/path/to/workerd-vfs.bin node packages/host/host.mjs
//
// Listens on http://127.0.0.1:8787 — the CLI's default context endpoint.
//
// WHY a Node http server in front of mf.dispatchFetch (and not miniflare's own `host`/`port`):
// the forked workerd (workerd-vfs.bin) crashes miniflare's port-mode control channel with a
// `write EPIPE` at `mf.ready`. dispatchFetch (lazy boot, no exposed socket) is rock-solid with
// the fork — exactly what every other spike uses. So we keep miniflare in dispatchFetch mode and
// bridge a plain Node http listener to it. The CLI sees an ordinary HTTP endpoint either way.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { kCurrentWorker, Log, LogLevel, Miniflare, Response as MfResponse } from "miniflare";

// the runtime compat level machines actually run with — stamped into every built/committed
// image manifest (runtime.compatDate); enforcement lives in the control plane's run route.
import { CHILD_COMPAT_DATE } from "./worker/machine-do.mjs";
import { WebSocketServer } from "ws";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // packages/host
const verbose = process.env.VERBOSE === "1";
const PORT = Number(process.env.ISO_PORT || 8787);

// Image registry (local): name → staging rootfs dir. The "base" image rootfs is built once by
// packages/base-image/build.mjs into ~/.iso/base/.staging (overridable via $ISO_BASE_STAGING);
// `iso host start` builds it if missing.
const BASE_STAGING = process.env.ISO_BASE_STAGING || path.join(os.homedir(), ".iso", "base", ".staging");
const IMAGES = {
  base: BASE_STAGING,
};

for (const [name, dir] of Object.entries(IMAGES)) {
  if (!existsSync(dir)) {
    console.error(`image '${name}' rootfs missing: ${dir}`);
    console.error("build it first:  node packages/base-image/build.mjs   (or just run: iso host start)");
    process.exit(2);
  }
}

const manifestCache = new Map();
const HOST_VERSION = "0.1.4";
function buildImageManifest(dir) {
  const files = {};
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files[p.slice(dir.length + 1)] = readFileSync(p).toString("base64");
    }
  })(dir);
  return files;
}

// ---- image store (content-addressed, from `iso commit`/`iso build`) --------------------------
// Layout: ~/.iso/images/index.json           repo:tag → digest
//         ~/.iso/images/sha256-<hex>/iso.json       the manifest
//         ~/.iso/images/sha256-<hex>/snapshot.json  path→base64 file map (what boot() consumes)
// Lives under ~/.iso (not the repo) so images outlive the checkout. The digest is the sha256 of
// the snapshot ARTIFACT BYTES (snapshot.json exactly as stored) — the "sha256 of the tar" from
// the design doc, with snapshot.json as the tar-equivalent artifact. Byte-addressing makes the
// registry contract trivial: the blob IS this file, and the registry can verify
// sha256(uploaded body) == digest with no re-serialization anywhere.
const IMAGE_STORE = path.join(os.homedir(), ".iso", "images");
const INDEX_FILE = path.join(IMAGE_STORE, "index.json");
function loadIndex() { try { return JSON.parse(readFileSync(INDEX_FILE, "utf8")); } catch { return {}; } }
function saveIndex(idx) { mkdirSync(IMAGE_STORE, { recursive: true }); writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2) + "\n"); }
function canonicalDigest(text) {
  return "sha256:" + createHash("sha256").update(text).digest("hex");
}
function storedDigests() {
  try { return readdirSync(IMAGE_STORE).filter((e) => e.startsWith("sha256-")).map((e) => e.replace("sha256-", "sha256:")); }
  catch { return []; }
}
function storeDirOf(digest) { return path.join(IMAGE_STORE, digest.replace(":", "-")); }
function manifestOf(digest) { return JSON.parse(readFileSync(path.join(storeDirOf(digest), "iso.json"), "utf8")); }
function tagsOf(digest) { const idx = loadIndex(); return Object.keys(idx).filter((t) => idx[t] === digest); }

// ---- volume store (docs/volumes.md): ~/.iso/volumes/<name>/{volume.json, live/, snapshots/}
// Checkpoint semantics, honestly labeled: copy-in at boot, copy-out at graceful rm / explicit
// sync. Every checkpoint is content-addressed (digest = sha256 of the artifact bytes — the same
// snapshot-JSON discipline as images). Retention: pinned snapshots + the last 5 automatics.
const VOLUME_STORE = path.join(os.homedir(), ".iso", "volumes");
const RETAIN_AUTO = 5;
function volDir(name) { return path.join(VOLUME_STORE, name); }
function loadVol(name) { try { return JSON.parse(readFileSync(path.join(volDir(name), "volume.json"), "utf8")); } catch { return null; } }
function saveVol(name, v) { mkdirSync(volDir(name), { recursive: true }); writeFileSync(path.join(volDir(name), "volume.json"), JSON.stringify(v, null, 2) + "\n"); }
function vOk(obj) { return new MfResponse(JSON.stringify(obj), { headers: { "content-type": "application/json" } }); }
function vErr(code, msg) { return new MfResponse(JSON.stringify({ error: msg }), { status: code, headers: { "content-type": "application/json" } }); }
// ---- network store (docs/networks.md): ~/.iso/networks/<name>/{network.json, policy.mjs,
// state.json}. The policy module TEXT is stored here; the daemon never executes it — it runs
// SANDBOXED in a per-network policy isolate on the platform (worker/user-module-isolate.mjs's
// sibling mechanism in control-plane.mjs). `token` authenticates policy-isolate callbacks
// (route/state/egress tagging) back to the control plane.
const NETWORK_STORE = path.join(os.homedir(), ".iso", "networks");
const NET_LOG_MAX = 500;
const netLogs = new Map(); // name → [{ts, from, method, url, outcome, status?}] ring (in-memory; docs note this)
function netDir(name) { return path.join(NETWORK_STORE, name); }
function loadNet(name) { try { return JSON.parse(readFileSync(path.join(netDir(name), "network.json"), "utf8")); } catch { return null; } }
function saveNet(name, n) { mkdirSync(netDir(name), { recursive: true }); writeFileSync(path.join(netDir(name), "network.json"), JSON.stringify(n, null, 2) + "\n"); }
// networked machines need the same DO warmth as published ports (a member's serving child lives
// in DO memory); keepalive per machine, on at networked run, off at rm.
const machineKeepalives = new Map(); // machineId → interval
// live/ → artifact (the same path→base64 map the image machinery uses)
function liveArtifact(name) {
  const root = path.join(volDir(name), "live");
  const files = {};
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) files[p.slice(root.length + 1)] = readFileSync(p).toString("base64");
    }
  })(root);
  return JSON.stringify(files);
}
// artifact → live/ (full replace)
function materializeLive(name, artifact) {
  const root = path.join(volDir(name), "live");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (const [rel, b64] of Object.entries(JSON.parse(artifact))) {
    const p = path.join(root, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, Buffer.from(b64, "base64"));
  }
}
// retention: keep every pinned digest + the last RETAIN_AUTO auto digests; delete other files.
function pruneSnapshots(v) {
  const keep = new Set(v.history.filter((h) => h.kind === "pinned").map((h) => h.digest));
  const autos = v.history.filter((h) => h.kind !== "pinned").map((h) => h.digest);
  for (const d of autos.slice(-RETAIN_AUTO)) keep.add(d);
  const snapDir = path.join(volDir(v.name), "snapshots");
  try {
    for (const f of readdirSync(snapDir)) {
      const digest = f.replace("sha256-", "sha256:");
      if (!keep.has(digest)) rmSync(path.join(snapDir, f), { force: true });
    }
  } catch {}
}

// Per-step build cache (docker's model): stepHash → intermediate-image digest. The stepHash is
// the CLI's hash(parentStepHash, descriptor) chain value; intermediates are ordinary untagged
// images in the store. Entries pointing at a deleted digest self-heal to a miss on lookup.
const CACHE_INDEX_FILE = path.join(IMAGE_STORE, "cache-index.json");
function loadCacheIndex() { try { return JSON.parse(readFileSync(CACHE_INDEX_FILE, "utf8")); } catch { return {}; } }
function saveCacheIndex(ci) { mkdirSync(IMAGE_STORE, { recursive: true }); writeFileSync(CACHE_INDEX_FILE, JSON.stringify(ci, null, 2) + "\n"); }

// Compose an image manifest: inherit from the parent, then apply --change-style instructions.
// Shared by /store-image (fresh snapshot) and /image-finalize (fully-cached build re-manifest).
function composeManifest({ digest, parentRef, meta, message, files, size, createdAt }) {
  let parent = null, pm = null;
  try { const p = resolveImage(parentRef); parent = p.digest; pm = p.manifest; } catch {}
  const manifest = {
    schemaVersion: 1, digest,
    entrypoint: pm?.entrypoint || null, cmd: pm?.cmd || null,
    env: { ...(pm?.env || {}) }, workdir: pm?.workdir || "/work",
    ports: [...(pm?.ports || [])], labels: { ...(pm?.labels || {}) },
    parent, parentRef: parentRef || null,
    history: [...(pm?.history || []), ...(meta.history || [])],
    createdAt: createdAt || new Date().toISOString(),
    ...(message ? { message } : {}),
    // runtime compat (docs/architecture.md "What's actually in an image"): what this image
    // REQUIRES of a host — like docker's `platform`, but for API surface. compatDate is stamped
    // fresh with the host's current level; minHost is inherited only if a parent declared it
    // (absent by default — most images don't need a floor on the host version).
    runtime: { compatDate: CHILD_COMPAT_DATE, ...(pm?.runtime?.minHost ? { minHost: pm.runtime.minHost } : {}) },
    files, size,
  };
  for (const ch of meta.changes || []) applyChange(manifest, ch);
  return manifest;
}

// The legacy `base` image stays served from .staging; it gets a REAL digest lazily (computed over
// the same canonical stream its boot manifest uses) so `iso images` shows an ID and commits can
// record it as parent — but it is not copied into the store (documented in the README).
const legacyInfoCache = new Map();
function legacyImageInfo(name) {
  if (!legacyInfoCache.has(name)) {
    const dir = IMAGES[name];
    if (!manifestCache.has(name)) manifestCache.set(name, JSON.stringify(buildImageManifest(dir)));
    const text = manifestCache.get(name);
    const files = JSON.parse(text);
    let size = 0; for (const b64 of Object.values(files)) size += Buffer.from(b64, "base64").length;
    const digest = canonicalDigest(text);
    legacyInfoCache.set(name, {
      digest, files: Object.keys(files).length, size,
      manifest: {
        schemaVersion: 1, digest, legacy: true,
        entrypoint: null, cmd: null, env: {}, workdir: "/work", ports: [], labels: {},
        parent: null, history: [{ createdBy: "(legacy staging rootfs: " + dir + ")" }],
        createdAt: statSync(dir).mtime.toISOString(),
      },
    });
  }
  return legacyInfoCache.get(name);
}

// Resolve an image reference: legacy name | repo (→ repo:latest) | repo:tag | sha256:<hex> |
// unique digest prefix. Throws docker-style errors.
function resolveImage(ref) {
  if (!ref) throw new Error("No such image: " + ref);
  if (IMAGES[ref]) {
    const info = legacyImageInfo(ref);
    return { kind: "legacy", name: ref, dir: IMAGES[ref], digest: info.digest, manifest: info.manifest };
  }
  const idx = loadIndex();
  const tagRef = ref.includes(":") && !ref.startsWith("sha256:") ? ref : ref + ":latest";
  if (idx[tagRef]) {
    const digest = idx[tagRef];
    return { kind: "stored", digest, dir: storeDirOf(digest), manifest: manifestOf(digest), refName: tagRef };
  }
  const hex = ref.startsWith("sha256:") ? ref.slice(7) : (/^[0-9a-f]{4,64}$/.test(ref) ? ref : null);
  if (hex) {
    const matches = storedDigests().filter((d) => d.startsWith("sha256:" + hex));
    if (matches.length === 1) return { kind: "stored", digest: matches[0], dir: storeDirOf(matches[0]), manifest: manifestOf(matches[0]) };
    if (matches.length > 1) throw new Error("Multiple images found with provided prefix: " + ref);
  }
  throw new Error("No such image: " + ref);
}

// Apply a docker-`--change`-style meta instruction to a manifest. Used by `iso commit --change`
// and by `iso build` (the CLI serializes SDK meta steps into these).
function applyChange(m, line) {
  const s = String(line).trim();
  const i = s.search(/\s/);
  const op = (i < 0 ? s : s.slice(0, i)).toUpperCase();
  const rest = i < 0 ? "" : s.slice(i + 1).trim();
  const bad = (msg) => { throw new Error("invalid change '" + line + "': " + msg); };
  const argvOf = (str) => {
    if (str.startsWith("[")) { try { return JSON.parse(str); } catch { bad("malformed JSON array"); } }
    return str.split(/\s+/).filter(Boolean);
  };
  const kvsOf = (str) => {
    if (!str) bad("expected KEY=VAL");
    if (!str.includes("=")) { const j = str.search(/\s/); return j < 0 ? bad("expected KEY=VAL") : [[str.slice(0, j), str.slice(j + 1).trim()]]; }
    return [...str.matchAll(/(\S+?)=("[^"]*"|\S*)/g)].map((mm) => [mm[1], mm[2].replace(/^"|"$/g, "")]);
  };
  if (op === "ENV") for (const [k, v] of kvsOf(rest)) m.env[k] = v;
  else if (op === "WORKDIR") { if (!rest.startsWith("/")) bad("WORKDIR must be absolute"); m.workdir = rest; }
  else if (op === "CMD") m.cmd = argvOf(rest);
  else if (op === "ENTRYPOINT") m.entrypoint = argvOf(rest);
  else if (op === "EXPOSE") m.ports = [...new Set([...(m.ports || []), ...rest.split(/\s+/).map(Number).filter((n) => !isNaN(n))])];
  else if (op === "LABEL") for (const [k, v] of kvsOf(rest)) m.labels[k] = v;
  else bad(op + " is not supported (v1 supports ENV, WORKDIR, CMD, ENTRYPOINT, EXPOSE, LABEL)");
}

async function hostService(request) {
  const url = new URL(request.url);
  if (url.pathname === "/image-manifest") {
    // boot path: serve the path→base64 file map for ANY image (legacy staging dir OR stored).
    const image = url.searchParams.get("image") || "base";
    let r;
    try { r = resolveImage(image); } catch (e) { return new MfResponse(String(e.message), { status: 404 }); }
    if (r.kind === "legacy") {
      if (!manifestCache.has(r.name)) manifestCache.set(r.name, JSON.stringify(buildImageManifest(r.dir)));
      return new MfResponse(manifestCache.get(r.name), { headers: { "content-type": "application/json" } });
    }
    return new MfResponse(readFileSync(path.join(r.dir, "snapshot.json")), { headers: { "content-type": "application/json" } });
  }
  if (url.pathname === "/images") {
    // `iso images`: legacy images + everything in the content-addressed store (tagged or not).
    const out = [];
    for (const name of Object.keys(IMAGES)) {
      const info = legacyImageInfo(name);
      out.push({ repository: name, tag: "latest", digest: info.digest, files: info.files, size: info.size, createdAt: info.manifest.createdAt, legacy: true });
    }
    const idx = loadIndex();
    const tagged = new Set();
    for (const [repoTag, digest] of Object.entries(idx)) {
      tagged.add(digest);
      let m; try { m = manifestOf(digest); } catch { continue; }
      const c = repoTag.lastIndexOf(":");
      out.push({ repository: repoTag.slice(0, c), tag: repoTag.slice(c + 1), digest, files: m.files, size: m.size, createdAt: m.createdAt, runtime: m.runtime || null });
    }
    for (const digest of storedDigests()) {
      if (tagged.has(digest)) continue;
      let m; try { m = manifestOf(digest); } catch { continue; }
      out.push({ repository: "<none>", tag: "<none>", digest, files: m.files, size: m.size, createdAt: m.createdAt, runtime: m.runtime || null });
    }
    return new MfResponse(JSON.stringify(out), { headers: { "content-type": "application/json" } });
  }
  if (url.pathname === "/image-inspect") {
    try {
      const r = resolveImage(url.searchParams.get("ref"));
      return new MfResponse(JSON.stringify({ ...r.manifest, repoTags: r.kind === "legacy" ? [r.name + ":latest"] : tagsOf(r.digest) }), { headers: { "content-type": "application/json" } });
    } catch (e) { return new MfResponse(JSON.stringify({ error: e.message }), { status: 404, headers: { "content-type": "application/json" } }); }
  }
  if (url.pathname === "/image-rm") {
    // docker rmi semantics: a repo:tag ref untags; the blob is deleted when the last tag goes.
    // A digest ref deletes the blob (untagging everything). Legacy images can't be removed.
    const ref = url.searchParams.get("ref");
    let r;
    try { r = resolveImage(ref); } catch (e) { return new MfResponse(JSON.stringify({ error: e.message }), { status: 404, headers: { "content-type": "application/json" } }); }
    if (r.kind === "legacy") return new MfResponse(JSON.stringify({ error: "cannot remove built-in legacy image '" + r.name + "' (it is served from the staging rootfs, not the store)" }), { status: 409, headers: { "content-type": "application/json" } });
    const idx = loadIndex();
    const untagged = [];
    if (r.refName) { delete idx[r.refName]; untagged.push(r.refName); }
    else for (const t of tagsOf(r.digest)) { delete idx[t]; untagged.push(t); }
    saveIndex(idx);
    let deleted = null;
    if (!Object.values(idx).includes(r.digest)) {
      rmSync(storeDirOf(r.digest), { recursive: true, force: true });
      deleted = r.digest;
      // drop dangling build-cache entries pointing at the deleted digest (lookup also self-heals)
      const ci = loadCacheIndex();
      let dirty = false;
      for (const [h, d] of Object.entries(ci)) if (d === deleted) { delete ci[h]; dirty = true; }
      if (dirty) saveCacheIndex(ci);
    }
    return new MfResponse(JSON.stringify({ ok: true, untagged, deleted }), { headers: { "content-type": "application/json" } });
  }
  if (url.pathname === "/image-tag" && request.method === "POST") {
    // `iso tag <src> <ref>` — local re-tag: both names point at the same digest (docker semantics).
    const { src, name } = await request.json();
    let r;
    try { r = resolveImage(src); } catch (e) { return new MfResponse(JSON.stringify({ error: e.message }), { status: 404, headers: { "content-type": "application/json" } }); }
    if (r.kind === "legacy") {
      // materialize the legacy rootfs into the store so the tag points at a real stored image
      const text = manifestCache.get(r.name);
      const dir = storeDirOf(r.digest);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "snapshot.json"), text);
      writeFileSync(path.join(dir, "iso.json"), JSON.stringify(r.manifest, null, 2));
    }
    const idx = loadIndex();
    idx[name] = r.digest;
    saveIndex(idx);
    return new MfResponse(JSON.stringify({ ok: true, name, digest: r.digest }), { headers: { "content-type": "application/json" } });
  }
  if (url.pathname === "/image-push" && request.method === "POST") {
    // push (daemon-side transfer, docker-style): resolve local → HEAD blob (dedupe) → PUT blob
    // (registry verifies sha256(body) == digest) → PUT manifest. The blob is snapshot.json
    // VERBATIM, addressed by sha256 of its bytes (computed here — covers store entries from
    // before byte-addressing); the manifest gains `snapshot: <blobDigest>` per the registry
    // contract (it rejects manifests whose referenced blobs are missing).
    const { ref, host: regHost, repo, tag, token } = await request.json();
    let r;
    try { r = resolveImage(ref); } catch (e) { return new MfResponse(JSON.stringify({ error: e.message }), { status: 404, headers: { "content-type": "application/json" } }); }
    if (r.kind === "legacy") return new MfResponse(JSON.stringify({ error: "tag the legacy image first: iso tag " + r.name + " " + ref }), { status: 409, headers: { "content-type": "application/json" } });
    const base = "http://" + regHost.replace(/^localhost(?=[:/]|$)/, "127.0.0.1"); // dodge IPv6/IPv4 dual-stack shadowing
    const auth = token ? { authorization: "Bearer " + token } : {};
    const authFail = () => new MfResponse(JSON.stringify({ error: "registry: authentication required (401) — pass --token" }), { status: 401, headers: { "content-type": "application/json" } });
    try {
      const blob = readFileSync(path.join(r.dir, "snapshot.json"));
      const blobDigest = canonicalDigest(blob); // sha256 of the UPLOADED bytes — what the registry verifies
      const head = await fetch(base + "/v0/blobs/" + encodeURIComponent(blobDigest), { method: "HEAD", headers: auth });
      if (head.status === 401) return authFail();
      const blobExisted = head.status === 200;
      if (!blobExisted) {
        const put = await fetch(base + "/v0/blobs/" + encodeURIComponent(blobDigest), { method: "PUT", headers: { ...auth, "content-type": "application/json" }, body: blob });
        if (put.status === 401) return authFail();
        if (!put.ok) return new MfResponse(JSON.stringify({ error: "registry: blob upload failed (" + put.status + "): " + (await put.text()).slice(0, 200) }), { status: 502, headers: { "content-type": "application/json" } });
      }
      const manifest = { ...r.manifest, snapshot: blobDigest };
      const man = await fetch(base + "/v0/manifests/" + encodeURIComponent(repo) + "/" + encodeURIComponent(tag), {
        method: "PUT", headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(manifest, null, 2),
      });
      if (man.status === 401) return authFail();
      if (!man.ok) return new MfResponse(JSON.stringify({ error: "registry: manifest push failed (" + man.status + "): " + (await man.text()).slice(0, 200) }), { status: 502, headers: { "content-type": "application/json" } });
      return new MfResponse(JSON.stringify({ ok: true, digest: r.digest, snapshot: blobDigest, size: blob.length, blobExisted, repo, tag }), { headers: { "content-type": "application/json" } });
    } catch (e) {
      return new MfResponse(JSON.stringify({ error: "cannot reach registry at " + base + " (" + (e?.cause?.code || e.message) + ")" }), { status: 502, headers: { "content-type": "application/json" } });
    }
  }
  if (url.pathname === "/image-pull" && request.method === "POST") {
    // pull: GET manifest → fetch the `snapshot` blob if missing locally (verify sha256 of the
    // bytes == blob digest) → store under the image digest + tag locally.
    const { host: regHost, repo, tag, localName, token } = await request.json();
    const base = "http://" + regHost.replace(/^localhost(?=[:/]|$)/, "127.0.0.1"); // dodge IPv6/IPv4 dual-stack shadowing
    const auth = token ? { authorization: "Bearer " + token } : {};
    try {
      const mr = await fetch(base + "/v0/manifests/" + encodeURIComponent(repo) + "/" + encodeURIComponent(tag), { headers: auth });
      if (mr.status === 401) return new MfResponse(JSON.stringify({ error: "registry: authentication required (401) — pass --token" }), { status: 401, headers: { "content-type": "application/json" } });
      if (mr.status === 404) return new MfResponse(JSON.stringify({ error: "manifest for " + repo + ":" + tag + " not found in registry " + regHost }), { status: 404, headers: { "content-type": "application/json" } });
      if (!mr.ok) return new MfResponse(JSON.stringify({ error: "registry: manifest fetch failed (" + mr.status + ")" }), { status: 502, headers: { "content-type": "application/json" } });
      const manifestText = await mr.text();
      const manifest = JSON.parse(manifestText);
      const blobDigest = manifest.snapshot || manifest.digest;
      const imageDigest = manifest.digest || blobDigest;
      if (!blobDigest) return new MfResponse(JSON.stringify({ error: "registry manifest names no snapshot blob" }), { status: 502, headers: { "content-type": "application/json" } });
      const dir = storeDirOf(imageDigest);
      let blobFetched = false;
      if (!existsSync(path.join(dir, "snapshot.json"))) {
        const br = await fetch(base + "/v0/blobs/" + encodeURIComponent(blobDigest), { headers: auth });
        if (!br.ok) return new MfResponse(JSON.stringify({ error: "registry: blob fetch failed (" + br.status + ")" }), { status: 502, headers: { "content-type": "application/json" } });
        const blob = Buffer.from(await br.arrayBuffer());
        const check = canonicalDigest(blob);
        if (check !== blobDigest) return new MfResponse(JSON.stringify({ error: "blob digest mismatch: expected " + blobDigest + " got " + check }), { status: 502, headers: { "content-type": "application/json" } });
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "snapshot.json"), blob);
        blobFetched = true;
      }
      writeFileSync(path.join(dir, "iso.json"), manifestText);
      const idx = loadIndex();
      idx[localName] = imageDigest;
      saveIndex(idx);
      return new MfResponse(JSON.stringify({ ok: true, digest: imageDigest, snapshot: blobDigest, blobFetched, localName }), { headers: { "content-type": "application/json" } });
    } catch (e) {
      return new MfResponse(JSON.stringify({ error: "cannot reach registry at " + base + " (" + (e?.cause?.code || e.message) + ")" }), { status: 502, headers: { "content-type": "application/json" } });
    }
  }
  if (url.pathname === "/store-image" && request.method === "POST") {
    // `iso commit` lands here (via the control plane): body = the Machine DO's snapshot
    // (path→base64), query = repo/tag/message/parent/cacheHash + meta {changes[], history[]}.
    // cacheHash (from `iso build` intermediates) records stepHash→digest in the build cache —
    // written even on --no-cache builds (docker behavior: skip reads, refresh writes).
    const repo = url.searchParams.get("repo") || "";
    const tag = url.searchParams.get("tag") || "latest";
    const message = url.searchParams.get("message") || "";
    const parentRef = url.searchParams.get("parent") || "";
    const cacheHash = url.searchParams.get("cacheHash") || "";
    let meta = {}; try { meta = JSON.parse(url.searchParams.get("meta") || "{}"); } catch {}
    const text = await request.text();
    let files;
    try { files = JSON.parse(text); } catch { return new MfResponse(JSON.stringify({ error: "malformed snapshot payload" }), { status: 400, headers: { "content-type": "application/json" } }); }
    const digest = canonicalDigest(text); // sha256 of the artifact BYTES (what the registry verifies)
    let size = 0; for (const b64 of Object.values(files)) size += Buffer.from(b64, "base64").length;
    let manifest;
    try { manifest = composeManifest({ digest, parentRef, meta, message, files: Object.keys(files).length, size }); }
    catch (e) { return new MfResponse(JSON.stringify({ error: e.message }), { status: 400, headers: { "content-type": "application/json" } }); }
    const dir = storeDirOf(digest);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "snapshot.json"), text);
    writeFileSync(path.join(dir, "iso.json"), JSON.stringify(manifest, null, 2));
    if (repo) { const idx = loadIndex(); idx[repo + ":" + tag] = digest; saveIndex(idx); }
    if (cacheHash) { const ci = loadCacheIndex(); ci[cacheHash] = digest; saveCacheIndex(ci); }
    return new MfResponse(JSON.stringify({ ok: true, digest, repoTag: repo ? repo + ":" + tag : null, files: manifest.files, size }), { headers: { "content-type": "application/json" } });
  }
  if (url.pathname === "/build-cache") {
    // per-step cache lookup: stepHash → digest, self-healing (a stale entry whose image dir is
    // gone — e.g. after `iso rmi` — is dropped and reported as a miss).
    const hash = url.searchParams.get("hash") || "";
    const ci = loadCacheIndex();
    const digest = ci[hash];
    if (digest && existsSync(storeDirOf(digest))) {
      return new MfResponse(JSON.stringify({ digest }), { headers: { "content-type": "application/json" } });
    }
    if (digest) { delete ci[hash]; saveCacheIndex(ci); } // self-heal
    return new MfResponse(JSON.stringify({ error: "cache miss" }), { status: 404, headers: { "content-type": "application/json" } });
  }
  if (url.pathname === "/image-finalize" && request.method === "POST") {
    // fully-cached `iso build`: no machine ran, the final fs IS the last cached digest. Rebuild
    // the manifest (parent + accumulated changes/history) over the existing snapshot and tag it.
    const { digest, repo, tag, message, parent, changes, history } = await request.json();
    if (!digest || !existsSync(storeDirOf(digest))) {
      return new MfResponse(JSON.stringify({ error: "No such image: " + digest }), { status: 404, headers: { "content-type": "application/json" } });
    }
    const existing = manifestOf(digest);
    let manifest;
    try {
      manifest = composeManifest({
        digest, parentRef: parent || "", meta: { changes: changes || [], history: history || [] },
        message, files: existing.files, size: existing.size, createdAt: existing.createdAt,
      });
    } catch (e) { return new MfResponse(JSON.stringify({ error: e.message }), { status: 400, headers: { "content-type": "application/json" } }); }
    writeFileSync(path.join(storeDirOf(digest), "iso.json"), JSON.stringify(manifest, null, 2));
    if (repo) { const idx = loadIndex(); idx[repo + ":" + (tag || "latest")] = digest; saveIndex(idx); }
    return new MfResponse(JSON.stringify({ ok: true, digest, repoTag: repo ? repo + ":" + (tag || "latest") : null }), { headers: { "content-type": "application/json" } });
  }
  // ---- volumes (docs/volumes.md): checkpointed, driver-backed, versioned ----------------
  if (url.pathname === "/volume-create" && request.method === "POST") {
    const { name, driverPath } = await request.json();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name || "")) return vErr(400, `invalid volume name: ${JSON.stringify(name)}`);
    const dir = volDir(name);
    if (existsSync(dir)) return vErr(409, `volume "${name}" already exists`);
    mkdirSync(path.join(dir, "live"), { recursive: true });
    mkdirSync(path.join(dir, "snapshots"), { recursive: true });
    let driver = "local";
    if (driverPath) {
      // copy the user driver module INTO the volume dir (a snapshot of the driver at create
      // time); the daemon only ever reads its TEXT — the code runs sandboxed in an isolate.
      if (!existsSync(driverPath)) return vErr(400, `driver module not found: ${driverPath}`);
      writeFileSync(path.join(dir, "driver.mjs"), readFileSync(driverPath));
      driver = "user";
    }
    saveVol(name, { name, driver, driverPath: driverPath || null, createdAt: new Date().toISOString(), attachedTo: null, history: [] });
    return vOk({ name, driver });
  }
  if (url.pathname === "/volume-ls") {
    const out = [];
    try {
      for (const n of readdirSync(VOLUME_STORE)) {
        const v = loadVol(n);
        if (v) out.push({ name: v.name, driver: v.driver, attachedTo: v.attachedTo, snapshots: v.history.length, createdAt: v.createdAt });
      }
    } catch {}
    return vOk(out);
  }
  if (url.pathname === "/volume-inspect") {
    const v = loadVol(url.searchParams.get("name"));
    if (!v) return vErr(404, `no such volume: ${url.searchParams.get("name")}`);
    return vOk(v);
  }
  if (url.pathname === "/volume-rm" && request.method === "POST") {
    const { name } = await request.json();
    const v = loadVol(name);
    if (!v) return vErr(404, `no such volume: ${name}`);
    rmSync(volDir(name), { recursive: true, force: true });
    return vOk({ removed: name });
  }
  if (url.pathname === "/volume-attach" && request.method === "POST") {
    // exclusive attach + hand back what copy-in needs: the current artifact (local driver) or
    // the driver source (user driver — the CONTROL PLANE invokes it sandboxed; the daemon never
    // runs user JS). attachedTo is the lock; the control plane pre-validates liveness.
    const { name, machineId } = await request.json();
    const v = loadVol(name);
    if (!v) return vErr(404, `no such volume: ${name}`);
    v.attachedTo = machineId;
    saveVol(name, v);
    if (v.driver === "user") return vOk({ mode: "user", source: readFileSync(path.join(volDir(name), "driver.mjs"), "utf8") });
    return vOk({ mode: "local", artifact: liveArtifact(name) });
  }
  if (url.pathname === "/volume-source") {
    const v = loadVol(url.searchParams.get("name"));
    if (!v || v.driver !== "user") return vErr(404, "no user driver for volume");
    return vOk({ source: readFileSync(path.join(volDir(v.name), "driver.mjs"), "utf8") });
  }
  if (url.pathname === "/volume-detach" && request.method === "POST") {
    const { name, machineId } = await request.json();
    const v = loadVol(name);
    if (v && v.attachedTo === machineId) { v.attachedTo = null; saveVol(name, v); }
    return vOk({ ok: true });
  }
  if (url.pathname === "/volume-checkpoint" && request.method === "POST") {
    // a checkpoint = a content-addressed snapshot of the mount tree (the same artifact + digest
    // discipline as images: the bytes ARE the JSON file map; digest = sha256 of the bytes).
    const q = url.searchParams;
    const name = q.get("name"), kind = q.get("kind") || "auto";
    const v = loadVol(name);
    if (!v) return vErr(404, `no such volume: ${name}`);
    const artifact = await request.text();
    const digest = canonicalDigest(artifact);
    const snapFile = path.join(volDir(name), "snapshots", digest.replace(":", "-"));
    if (!existsSync(snapFile)) writeFileSync(snapFile, artifact);
    let files = 0, size = 0;
    try { const m = JSON.parse(artifact); files = Object.keys(m).length; for (const b of Object.values(m)) size += Buffer.from(b, "base64").length; } catch {}
    v.history.push({ digest, at: new Date().toISOString(), kind, files, size });
    if (v.driver !== "user") materializeLive(name, artifact); // local driver: live/ mirrors the checkpoint
    pruneSnapshots(v);
    saveVol(name, v);
    return vOk({ digest, files, size, kind });
  }
  if (url.pathname === "/volume-rollback" && request.method === "POST") {
    const { name, ref } = await request.json();
    const v = loadVol(name);
    if (!v) return vErr(404, `no such volume: ${name}`);
    const want = String(ref || "").replace(/^sha256:/, "");
    const matches = [...new Set(v.history.map((h) => h.digest))].filter((d) => d.replace(/^sha256:/, "").startsWith(want));
    if (!matches.length) return vErr(404, `no snapshot matching "${ref}" in volume ${name}`);
    if (matches.length > 1) return vErr(409, `ambiguous snapshot prefix "${ref}": ${matches.map((d) => d.slice(7, 19)).join(", ")}`);
    const digest = matches[0];
    const snapFile = path.join(volDir(name), "snapshots", digest.replace(":", "-"));
    if (!existsSync(snapFile)) return vErr(410, `snapshot ${digest} was pruned by retention`);
    const artifact = readFileSync(snapFile, "utf8");
    if (v.driver !== "user") materializeLive(name, artifact);
    v.history.push({ digest, at: new Date().toISOString(), kind: "rollback" });
    saveVol(name, v);
    // user-driver volumes: the CONTROL PLANE pushes the artifact into the driver (tarIn).
    return vOk({ digest, artifact: v.driver === "user" ? artifact : undefined, source: v.driver === "user" ? readFileSync(path.join(volDir(name), "driver.mjs"), "utf8") : undefined });
  }

  // ---- networks (docs/networks.md): name resolution + sandboxed egress policy -----------
  if (url.pathname === "/network-create" && request.method === "POST") {
    const { name, policySource } = await request.json();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name || "")) return vErr(400, `invalid network name: ${JSON.stringify(name)}`);
    if (loadNet(name)) return vErr(409, `network "${name}" already exists`);
    mkdirSync(netDir(name), { recursive: true });
    if (policySource) writeFileSync(path.join(netDir(name), "policy.mjs"), policySource);
    saveNet(name, {
      name, createdAt: new Date().toISOString(), hasPolicy: !!policySource,
      // token: authenticates policy-isolate callbacks (x-iso-pol tag) to the control plane.
      token: createHash("sha256").update(name + ":" + Date.now() + ":" + Math.random()).digest("hex").slice(0, 32),
    });
    return vOk({ name, hasPolicy: !!policySource });
  }
  if (url.pathname === "/network-ls") {
    const out = [];
    try {
      for (const n of readdirSync(NETWORK_STORE)) { const net = loadNet(n); if (net) out.push({ name: net.name, hasPolicy: net.hasPolicy, createdAt: net.createdAt }); }
    } catch {}
    return vOk(out);
  }
  if (url.pathname === "/network-inspect") {
    const net = loadNet(url.searchParams.get("name"));
    return net ? vOk(net) : vErr(404, `no such network: ${url.searchParams.get("name")}`);
  }
  if (url.pathname === "/network-rm" && request.method === "POST") {
    const { name } = await request.json();
    if (!loadNet(name)) return vErr(404, `no such network: ${name}`);
    rmSync(netDir(name), { recursive: true, force: true });
    netLogs.delete(name);
    return vOk({ removed: name });
  }
  if (url.pathname === "/network-policy") {
    const name = url.searchParams.get("name");
    const net = loadNet(name);
    if (!net) return vErr(404, `no such network: ${name}`);
    if (!net.hasPolicy) return vOk({ source: null });
    return vOk({ source: readFileSync(path.join(netDir(name), "policy.mjs"), "utf8") });
  }
  if (url.pathname === "/network-log" && request.method === "POST") {
    const { name, entry } = await request.json();
    if (!netLogs.has(name)) netLogs.set(name, []);
    const ring = netLogs.get(name);
    ring.push(entry);
    if (ring.length > NET_LOG_MAX) ring.splice(0, ring.length - NET_LOG_MAX);
    return vOk({ ok: true });
  }
  if (url.pathname === "/network-logs") {
    const ring = netLogs.get(url.searchParams.get("name")) || [];
    const since = Number(url.searchParams.get("since") || 0);
    return vOk({ entries: ring.filter((e) => e.ts > since) });
  }
  if (url.pathname === "/network-state" && request.method === "POST") {
    // ctx.state — the policy KV (experimental). Backed by state.json in the network dir; the
    // policy reaches it ONLY via its tagged callback channel, never the fs.
    const { name, op, key, value } = await request.json();
    if (!loadNet(name)) return vErr(404, `no such network: ${name}`);
    const f = path.join(netDir(name), "state.json");
    let state = {}; try { state = JSON.parse(readFileSync(f, "utf8")); } catch {}
    if (op === "get") return vOk({ value: key in state ? state[key] : null });
    if (op === "set") { state[key] = value; writeFileSync(f, JSON.stringify(state)); return vOk({ ok: true }); }
    return vErr(400, "unknown state op");
  }
  if (url.pathname === "/machine-keepalive" && request.method === "POST") {
    const { machineId, on } = await request.json();
    const cur = machineKeepalives.get(machineId);
    if (cur) { clearInterval(cur); machineKeepalives.delete(machineId); }
    if (on) {
      const ka = setInterval(() => { mf.dispatchFetch("http://iso.local/v0/machines/" + machineId + "/top").catch(() => {}); }, 5000);
      ka.unref?.();
      machineKeepalives.set(machineId, ka);
    }
    return vOk({ ok: true });
  }

  if (url.pathname === "/publish-port" && request.method === "POST") {
    // `iso run -p hostPort[:machinePort]` — the HOST opens a real listener per published port
    // (docker semantics) and forwards every request (any verb, STREAMING bodies — registry blobs
    // are 20MB+) to the machine's serving child via the port-proxy chain.
    const { machineId, hostPort, machinePort } = await request.json();
    if (publishedPorts.has(hostPort)) {
      const cur = publishedPorts.get(hostPort);
      if (cur.machineId === machineId && cur.machinePort === machinePort) return new MfResponse(JSON.stringify({ ok: true, already: true }), { headers: { "content-type": "application/json" } });
      return new MfResponse(JSON.stringify({ error: `Bind for 127.0.0.1:${hostPort} failed: port is already allocated` }), { status: 409, headers: { "content-type": "application/json" } });
    }
    try {
      const server = await openPublishedPort(machineId, hostPort, machinePort);
      publishedPorts.set(hostPort, { server, machineId, machinePort });
      return new MfResponse(JSON.stringify({ ok: true, hostPort, machinePort }), { headers: { "content-type": "application/json" } });
    } catch (e) {
      const msg = e?.code === "EADDRINUSE" ? `Bind for 127.0.0.1:${hostPort} failed: port is already allocated` : String(e?.message || e);
      return new MfResponse(JSON.stringify({ error: msg }), { status: 409, headers: { "content-type": "application/json" } });
    }
  }
  if (url.pathname === "/unpublish-ports" && request.method === "POST") {
    const { machineId } = await request.json();
    let closed = 0;
    for (const [hp, rec] of publishedPorts) {
      if (rec.machineId === machineId) { try { rec.server.close(); } catch {} publishedPorts.delete(hp); closed++; }
    }
    return new MfResponse(JSON.stringify({ ok: true, closed }), { headers: { "content-type": "application/json" } });
  }
  if (url.pathname === "/dev-probe") {
    // M4: serve the (verbatim do-machine-clean) vite-dev probe; the Machine DO writes it into the
    // project dir so its bare imports + DEV_ROOT resolve against <project>/node_modules.
    return new MfResponse(readFileSync(path.join(HERE, "worker/vite-dev-probe.mjs")), { headers: { "content-type": "text/javascript" } });
  }
  return new MfResponse("not found", { status: 404 });
}

// ---- published ports (`iso run -p`) ----------------------------------------------------------
// hostPort → { server, machineId, machinePort }. Requests stream through:
//   host listener → mf.dispatchFetch → control plane /port-proxy → Machine DO → serving child's
//   fetch → cloudflare:node handleAsNodeRequest → the UNMODIFIED node:http server in the machine.
const publishedPorts = new Map();
const HOP_HEADERS = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade",
  "proxy-connection", "te", "trailer", "content-length"]);
function openPublishedPort(machineId, hostPort, machinePort) {
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) if (!HOP_HEADERS.has(k.toLowerCase()) && typeof v === "string") headers[k] = v;
        const hasBody = !(req.method === "GET" || req.method === "HEAD");
        // BUFFER request bodies (fork gap, precisely captured): streaming a 20MB body through
        // dispatchFetch crawls (~400KB/s chunk relay) and, past ~30s, workerd's hang detector
        // cancels the DO request (streamed proxy bodies don't register as I/O progress) and the
        // uncaught cancellation ABORTS the DO — wiping the machine's in-memory /tmp. A buffered
        // body transfers in seconds and never approaches the threshold. Cap 256MB.
        let body;
        if (hasBody) {
          const chunks = [];
          let total = 0;
          for await (const c of req) {
            total += c.length;
            if (total > 256 * 1024 * 1024) { res.writeHead(413); res.end("body too large (256MB cap)"); return; }
            chunks.push(c);
          }
          body = Buffer.concat(chunks);
        }
        const wres = await mf.dispatchFetch(
          "http://iso.local/v0/machines/" + machineId + "/port-proxy?port=" + machinePort + "&p=" + encodeURIComponent(req.url || "/"),
          { method: req.method, headers, ...(hasBody ? { body } : {}) },
        );
        const outHeaders = {};
        for (const [k, v] of wres.headers) if (!HOP_HEADERS.has(k.toLowerCase())) outHeaders[k] = v;
        // one request per connection: HEAD responses crossing the fetch bridges can desync a
        // kept-alive client socket (observed as the NEXT request hanging) — close after each.
        outHeaders.connection = "close";
        res.writeHead(wres.status, outHeaders);
        if (wres.body) { for await (const chunk of wres.body) res.write(chunk); }
        res.end();
      } catch (e) {
        try { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "port proxy: " + String(e?.message || e) })); } catch {}
      }
    });
    server.on("error", reject);
    server.listen(hostPort, "127.0.0.1", () => resolve(server));
    // keep the machine's DO warm while it has a published port (in-memory /tmp is the server's
    // state; DO eviction would drop it). Cheap /info ping; cleared when the port is unpublished.
    const ka = setInterval(() => {
      mf.dispatchFetch("http://iso.local/v0/machines/" + machineId + "/top").catch(() => {});
    }, 5000);
    ka.unref?.();
    server.on("close", () => clearInterval(ka));
  });
}

const mf = new Miniflare({
  log: new Log(verbose ? LogLevel.DEBUG : LogLevel.WARN),
  modulesRoot: HERE,
  modules: [
    { type: "ESModule", path: path.join(HERE, "worker/control-plane.mjs") },
    { type: "ESModule", path: path.join(HERE, "worker/machine-do.mjs") },
    { type: "ESModule", path: path.join(HERE, "worker/user-module-isolate.mjs") },
    { type: "ESModule", path: path.join(HERE, "worker/network-egress.mjs") },
  ],
  compatibilityDate: "2026-06-01",
  compatibilityFlags: ["nodejs_compat", "experimental"],
  unsafeEvalBinding: "UNSAFE_EVAL",
  // HOST serves image/app/dev-probe manifests. SELF = a Fetcher back to THIS worker, so a
  // Worker-Loader child (which can't be handed a LOADER binding) can fetch the DO's
  // /isolate-spawn to run nested bins — the libnpmexec → create-vite spawn bridge (M2).
  serviceBindings: { HOST: hostService, SELF: kCurrentWorker },
  durableObjects: { MACHINE: "Machine", REGISTRY: "Registry" },
  workerLoaders: { LOADER: {} },
  bindings: {
    ISO_TOKEN: process.env.ISO_TOKEN || "",
    // surfaced by GET /v0/version (`iso version`)
    ISO_HOST_INFO: {
      version: HOST_VERSION,
      runtimeCompatDate: CHILD_COMPAT_DATE,
      node: process.version,
      pid: process.pid,
      workerd: process.env.MINIFLARE_WORKERD_PATH || "(miniflare default)",
      endpoint: `http://127.0.0.1:${PORT}`,
      images: Object.keys(IMAGES),
    },
  },
});

// M4 dev-proxy state (host-side): which machine the dedicated dev port routes to.
const DEV_PORT = Number(process.env.ISO_DEV_PORT || PORT + 1);
let activeDevId = null;

// Bridge a plain Node http listener → mf.dispatchFetch. Buffer the request body, forward method/
// url/headers, stream the worker Response back.
const server = createServer(async (req, res) => {
  try {
    // M4 host-side control: point the dev proxy at a machine (set by `iso dev <id>`). Host state,
    // not worker state, so it's handled here on the Engine port rather than in the control plane.
    const u = new URL(req.url, "http://iso.local");
    if (u.pathname === "/__dev") {
      activeDevId = u.searchParams.get("id") || null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, activeDevId, devUrl: `http://127.0.0.1:${DEV_PORT}/` }));
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const wres = await mf.dispatchFetch("http://iso.local" + req.url, {
      method: req.method,
      headers: req.headers,
      body: (req.method === "GET" || req.method === "HEAD") ? undefined : body,
    });
    res.writeHead(wres.status, Object.fromEntries(wres.headers));
    res.end(Buffer.from(await wres.arrayBuffer()));
  } catch (e) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "host bridge: " + String(e?.stack || e) }));
  }
});

// WebSocket bridge for `iso logs -f` (the Track B merge). The external CLI opens a real WS to this
// Node server; we do the WS handshake here (`ws`), then ask miniflare to perform the SAME upgrade
// against the control-plane Worker (dispatchFetch with Upgrade: websocket → 101 + res.webSocket),
// accept() that worker-side socket, and pipe frames both ways. The worker/DO never sees a raw
// socket — only its own WebSocket — exactly like Track B's in-process driver, but for an external
// client. (We bridge at the host because the fork crashes miniflare's own port mode; see above.)
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", async (req, socket, head) => {
  let wres;
  try {
    // Clean upgrade request (NOT the raw Node upgrade headers — undici rejects those). Carry only
    // auth through; miniflare performs the WS upgrade and returns res.webSocket (Track B pattern).
    const headers = { Upgrade: "websocket" };
    if (req.headers.authorization) headers.authorization = req.headers.authorization;
    wres = await mf.dispatchFetch("http://iso.local" + req.url, { headers });
  } catch (e) {
    console.error("[ws-bridge] dispatch error:", String(e?.stack || e)); socket.destroy(); return;
  }
  if (wres.status !== 101 || !wres.webSocket) {
    let b = ""; try { b = await wres.text(); } catch {}
    console.error("[ws-bridge] upgrade not 101: status=" + wres.status + " ws=" + !!wres.webSocket + " body=" + b.slice(0, 200));
    socket.destroy(); return;
  }
  const worker = wres.webSocket;
  worker.accept();
  wss.handleUpgrade(req, socket, head, (client) => {
    // worker → client
    worker.addEventListener("message", (ev) => { try { client.send(ev.data); } catch {} });
    worker.addEventListener("close", () => { try { client.close(); } catch {} });
    worker.addEventListener("error", () => { try { client.close(); } catch {} });
    // client → worker (exec --attach stdin frames)
    client.on("message", (data) => { try { worker.send(data.toString()); } catch {} });
    client.on("close", () => { try { worker.close(); } catch {} });
  });
});

// M4: DEV PROXY. A vite dev machine serves at root (vite's HMR client dials ws://host:DEV_PORT/__hmr
// with base "/"), so we expose ONE dedicated port that forwards every request to the ACTIVE dev
// machine's DO `/proxy?p=<path>` (HTTP) and `/__hmr` (WS). `iso dev <id>` sets the active machine
// (via the internal /__dev route on the Engine port) and warms it. One dev machine at a time —
// matches do-machine-clean. The browser hits http://127.0.0.1:DEV_PORT/.
const origServer = server;
const devProxy = createServer(async (req, res) => {
  if (!activeDevId) { res.writeHead(503); res.end("no active dev machine; run `iso dev <id>`"); return; }
  try {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const inner = req.url || "/";
    const wres = await mf.dispatchFetch("http://iso.local/v0/machines/" + activeDevId + "/proxy?p=" + encodeURIComponent(inner), {
      method: req.method, headers: req.headers,
      body: (req.method === "GET" || req.method === "HEAD") ? undefined : body,
    });
    res.writeHead(wres.status, Object.fromEntries(wres.headers));
    res.end(Buffer.from(await wres.arrayBuffer()));
  } catch (e) { res.writeHead(502); res.end("dev proxy: " + String(e?.stack || e)); }
});
// /__hmr (and any) WS upgrade on the dev port → machine /proxy with the inner path.
const devWss = new WebSocketServer({ noServer: true });
devProxy.on("upgrade", async (req, socket, head) => {
  if (!activeDevId) { socket.destroy(); return; }
  let wres;
  try {
    const headers = { Upgrade: "websocket" };
    const proto = req.headers["sec-websocket-protocol"];
    if (proto) headers["Sec-WebSocket-Protocol"] = proto;
    wres = await mf.dispatchFetch("http://iso.local/v0/machines/" + activeDevId + "/proxy?p=" + encodeURIComponent(req.url || "/__hmr"), { headers });
  } catch (e) { console.error("[dev-ws] dispatch error:", String(e?.stack || e)); socket.destroy(); return; }
  if (wres.status !== 101 || !wres.webSocket) { console.error("[dev-ws] not 101: " + wres.status); socket.destroy(); return; }
  const worker = wres.webSocket; worker.accept();
  devWss.handleUpgrade(req, socket, head, (client) => {
    worker.addEventListener("message", (ev) => { try { client.send(ev.data); } catch {} });
    worker.addEventListener("close", () => { try { client.close(); } catch {} });
    worker.addEventListener("error", () => { try { client.close(); } catch {} });
    client.on("message", (d) => { try { worker.send(d.toString()); } catch {} });
    client.on("close", () => { try { worker.close(); } catch {} });
  });
});
await new Promise((resolve) => devProxy.listen(DEV_PORT, "127.0.0.1", resolve));

await new Promise((resolve) => origServer.listen(PORT, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${PORT}`;
console.log(`# iso dev proxy on http://127.0.0.1:${DEV_PORT}/ (active dev machine routed here)`);
console.log(`# iso host up — Engine API at ${endpoint}`);
console.log(`#   images: ${Object.keys(IMAGES).join(", ")}`);
console.log(`#   try:    iso run base npm install left-pad`);
console.log("# (Ctrl-C to stop)");

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => { server.close(); await mf.dispose().catch(() => {}); process.exit(0); });
}
