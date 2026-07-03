# iso Registry

Standalone, self-hosted docker-registry analog for iso images
(docs/iso-design.md §"iso Registry"). **Not** part of the iso host — the same
relationship `docker registry` (distribution) has to `dockerd`. Content-addressed
blob store + tag→manifest mapping; the transfer protocol is deliberately dumb.
Plain Node, **zero npm dependencies** (`node:http`, `node:crypto`, `node:fs`).

## Run

```sh
node experiments/iso/registry/serve.mjs                       # http://127.0.0.1:5000, data in ~/.iso-registry
node experiments/iso/registry/serve.mjs --port 5001 --data /srv/iso-registry --token s3cret
```

| flag      | env                  | default           |                                                        |
|-----------|----------------------|-------------------|--------------------------------------------------------|
| `--port`  | `ISO_REGISTRY_PORT`  | `5000`            | listen port                                            |
| `--data`  | `ISO_REGISTRY_DATA`  | `~/.iso-registry` | data dir                                               |
| `--token` | `ISO_REGISTRY_TOKEN` | *(none)*          | when set, all routes except `/v0/ping` require `Authorization: Bearer <token>` (401 otherwise) |

## API v0

| method   | path                        | →                                                                                  |
|----------|-----------------------------|------------------------------------------------------------------------------------|
| `GET`    | `/v0/ping`                  | `200 {ok, service:"iso-registry", version}` — never auth-gated                      |
| `HEAD`   | `/v0/blobs/{digest}`        | `200` (+ `Content-Length`) \| `404` — dedupe check before upload                    |
| `GET`    | `/v0/blobs/{digest}`        | blob bytes, streamed (`application/octet-stream`, `Content-Length`)                 |
| `PUT`    | `/v0/blobs/{digest}`        | `201` on upload; server **verifies** sha256(body) == digest, else `400` and nothing is stored; `200 {existed:true}` if already present |
| `GET`    | `/v0/manifests/{repo}/{tag}`| manifest bytes (`application/json`) + `X-Iso-Digest: sha256:<hex of those bytes>`   |
| `PUT`    | `/v0/manifests/{repo}/{tag}`| `201 {digest}`; server verifies every referenced blob exists, else `400`            |
| `DELETE` | `/v0/manifests/{repo}/{tag}`| `200` untag \| `404`                                                                |
| `GET`    | `/v0/repos`                 | `[{repo, tags:[…]}]`                                                                |

Digests are always `sha256:<64 hex>`. Repo names are docker-ish lowercase path
segments (`neta/tools` works); tags are `[A-Za-z0-9_][A-Za-z0-9._-]*`.

**How a manifest references blobs** (push order: blobs first, then manifest):
the registry reads `snapshot: "sha256:…"` (the snapshot blob's digest, i.e. the
sha256 of the uploaded snapshot bytes) and/or `blobs: ["sha256:…", …]` from the
manifest JSON. At least one reference is required, and all must already be in
the store, or the PUT is rejected with 400. Note this is *not* the manifest's
`digest` field — that is the image id (a canonical digest over the file map),
not the hash of the snapshot bytes, so the pushing side adds `snapshot` when it
uploads.

## Storage layout

```
<data>/
  blobs/sha256-<64hex>    content-addressed blobs — snapshots AND manifests
                          (a manifest is stored as a blob; its digest = sha256 of its bytes,
                           which is what X-Iso-Digest reports)
  repos/<repo>/<tag>      text file containing the manifest digest ("sha256:<hex>\n")
  tmp/                    in-flight uploads (same filesystem, so rename() is atomic)
```

All writes are atomic: uploads stream into `tmp/` while being hashed, digest is
verified, **then** a single `rename()` moves the file into `blobs/`. A killed or
mismatched upload never leaves a corrupt blob; a tag flip is one rename.

## Smoke test

`node experiments/iso/registry/test.mjs` boots the server on a scratch port +
scratch data dir (twice: once open, once with `--token`) and exercises the whole
surface. Real output:

```
  ok  ping → {ok, service:iso-registry}
  ok  HEAD unknown blob → 404
  ok  PUT blob (5MB) → 201
  ok  HEAD blob → 200 + content-length
  ok  GET blob → content-identical roundtrip
  ok  re-PUT existing blob → 200 existed:true (dedupe)
  ok  PUT blob with wrong digest → 400
  ok  …and the mismatched blob was NOT stored
  ok  PUT with malformed digest → 400
  ok  PUT manifest referencing missing blob → 400
  ok  PUT manifest referencing NO blobs → 400
  ok  PUT manifest → 201 + manifest digest
  ok  PUT manifest sets X-Iso-Digest
  ok  GET manifest → byte-identical roundtrip
  ok  GET manifest carries X-Iso-Digest
  ok  GET manifest content-type: application/json
  ok  GET /v0/repos → [{repo, tags:[…]}] (nested repo names work)
  ok  DELETE manifest (untag) → 200
  ok  GET untagged manifest → 404
  ok  DELETE unknown tag → 404
  ok  untagged tag gone from /v0/repos
  ok  auth: /v0/ping open without token
  ok  auth: no token → 401
  ok  auth: wrong token → 401
  ok  auth: correct token → 200

all 25 checks passed
```

## Deliberately out of scope in v1

- **Multi-tenancy** — one token, one namespace; per-user repos are a v2 concern.
- **Garbage collection** — untag removes the tag file only; unreferenced blobs stay on disk.
- **Chunked/resumable uploads** — one PUT per blob; a dropped connection means re-upload.
- **TLS** — plain HTTP; front it with a reverse proxy if it leaves localhost.
