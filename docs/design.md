# `iso` — a Docker-shaped CLI for V8-isolate machines

> Working name: **`iso`** (the CLI) over **isolate-machines** (the runtime). Rename freely.

Docker's surface (`build` / `run` / `exec` / `logs` / `ps` / `push` / `pull`) but
the unit of isolation is a **V8 isolate inside a Durable Object**, not an OS
container. No kernel, no namespaces, no overlayfs — a "machine" is a rootfs
unpacked into a DO's VFS, and "processes" are sub-isolates over that one shared
filesystem.

This doc turns the scattered `experiments/npm-in-workerd/*` spikes into one named
architecture. It is a design, not a status report; ✅/⚠️/⏭ mark what is already
proven in those spikes vs. what remains.

## The one hard constraint: pure-JS / wasm world

There is **no real `spawn`** and **no native process** (see
`experiments/npm-in-workerd/do-native-fs/README.md`, "the hard wall", and
`do-shell/README.md`, the module-fallback finding). We accept this fully:

- An **image may only contain JS and wasm.** Anything that would shell out to a
  native binary (`node-gyp`, `make`, `python`, `prebuild-install`, an
  `esbuild`/`rolldown` native `.node`) must be replaced by a wasm build at image
  *build* time — exactly what the Vite harness already does (`docs/rolldown-fork-findings.md`).
- No fork/IPC, no signals, no TTY. "Processes" are cooperative sub-isolates with
  faked `process.argv`/`cwd`/`env` and a trapped `process.exit`.
- This is **not** "Docker for arbitrary Linux images." It is "Docker for pure-JS/wasm
  machines" — and at that scope it is coherent, fast (ms cold start), and largely
  already built.

If a future need forces a native binary, the answer is "compile it to wasm or it
doesn't ship," never "add a syscall."

## Vocabulary map

| Docker | `iso` | Backed by |
|---|---|---|
| image | content-addressed rootfs tarball (`sha256:…`) | `base-image/build.mjs` ✅ |
| `Dockerfile` | `iso.build.mjs` — a JS step graph (§1b) | `iso build` + `iso-sdk` ✅ |
| registry | a blob store of tarballs keyed by digest | local: `~/.iso/images` ✅ · remote ⏭ |
| container / running instance | a **Durable Object** owning one VFS `/tmp` | `NpmBaseImage` DO ✅ |
| volume | a host-owned checkpointed tree, `-v name:/mount` | `iso volume` + `~/.iso/volumes` ✅ |
| network | a JS egress policy fn (+ name resolution), `--network net` | `iso network` + a sandboxed policy isolate ✅ |
| process in a container | a Worker-Loader sub-isolate over shared `/tmp` | `__ISOLATE_SPAWN` ✅ |
| `docker build` / `docker commit` | `iso build` / `iso commit` | DO `/snapshot` → content-addressed store ✅ |
| `docker run` | `iso run` | `boot()` + resolve + run ✅ |
| `docker exec` | `iso exec` | second `do-shell` session ✅ core |
| `docker logs -f` | `iso logs` | ⚠️ needs streaming (today: batch) |
| `docker ps` | `iso ps` | ⏭ needs a machine registry |
| `docker push/pull` | `iso push/pull` | standalone iso Registry + daemon-side transfers ✅ |

## Client / host separation (the keystone)

Docker's most valuable structural decision is that the **CLI is a thin client
talking to a daemon (`dockerd`) over a REST API**. We copy this exactly, because
it is what makes a *hosted* product possible:

- The **`iso` CLI is local and stateless.** It holds no machines, runs no
  isolates. It serializes commands to an **iso host** over HTTP/WS — the "iso
  Engine API."
- An **iso host** is the daemon: the control-plane Worker + the Machine DOs
  behind it. It is the thing that actually owns the isolates cloud.
- The CLI selects a host via **contexts** (mirrors `docker context`):
  ```
  iso context create neta --host https://neta.iso.host --token …
  iso context use neta
  iso run vite-react …            # runs in neta's isolates cloud, not locally
  ```
- A **hosted offering falls straight out of this**: sign up → you get
  `neta.iso.host`, which *is* your private iso host — a cloud runtime of
  machines (DOs / sandboxes) you `run`, `exec` into, and `logs -f`, all from the
  same CLI. Self-hosting and the managed cloud are the *same* protocol; only the
  context endpoint differs. (Same as `docker` against local vs. a remote engine.)

This means the boundary that must be designed first and kept stable is the **iso
Engine API** — the wire contract between CLI and host. Everything behind it
(which DO, which Worker) is an implementation detail the CLI never sees.

### iso Engine API (v0 sketch)

REST for control, WebSocket for streams. All under `/v0`.

```
POST /v0/images/build            multipart rootfs → {digest}
POST /v0/images                  push tarball by digest
GET  /v0/images                  list
POST /v0/machines                {image, cmd, env, detach} → {id, url}      # run
GET  /v0/machines                ps
DELETE /v0/machines/{id}                                                    # rm
POST /v0/machines/{id}/exec      {cmd, args} → {execId}                     # exec
WS   /v0/machines/{id}/logs?follow=1                                        # logs -f
WS   /v0/machines/{id}/exec/{execId}/attach   (stdin/stdout/stderr frames)   # ✅ implemented:
     # exec {attach:true} → {execId}; frames {type:"stdin"|"stdin-eof"} in,
     # {type:"stdout"|"stderr",data,partial?} / {type:"exit",code} out. The Machine DO owns the
     # socket; the child's process.stdin is a REAL Readable (EOF propagates). /logs is output-only.
```

Auth: bearer token per context. Multi-tenant hosts namespace machines by
account; `neta.iso.host` is just an iso host whose machine namespace is `neta`'s.

### iso Registry (its own component — the self-hosted docker-registry analog)

The registry is **not** part of the iso host. It is a standalone service
(`packages/registry/`) any party can run — the same relationship as
`docker registry` (distribution) has to `dockerd`. Content-addressed blob store
+ tag→manifest mapping; the transfer protocol is deliberately dumb.

**Registry HTTP API v0** (modeled on Docker Registry v2, simplified for our
single-snapshot image model):

```
GET    /v0/ping                      → {ok, service:"iso-registry", version}
HEAD   /v0/blobs/{digest}            → 200 | 404          (dedupe check)
GET    /v0/blobs/{digest}            → blob bytes
PUT    /v0/blobs/{digest}            → upload; server VERIFIES sha256(body) == digest
GET    /v0/manifests/{repo}/{tag}    → iso.json manifest + X-Iso-Digest header
PUT    /v0/manifests/{repo}/{tag}    → push manifest; server verifies referenced blobs exist
DELETE /v0/manifests/{repo}/{tag}    → untag
GET    /v0/repos                     → [{repo, tags:[…]}]
```

Auth: optional bearer token. Storage: a data dir (`blobs/sha256-…`,
`repos/<repo>/<tag>`). v1 is a plain Node service with zero deps; deploying the
registry itself onto the isolates cloud is the natural v2 (the registry is just
an app). ✅ implemented: `packages/registry/serve.mjs` (+ test.mjs, README).
✅ **and the v2 happened: the registry RUNS AS AN ISO MACHINE** — `registry/iso.build.mjs`
builds it as an image; `iso run -d -p 5055:5000 registry` serves it (unmodified serve.mjs on
the fork's node:http server compat + published ports); proven recursively (the registry image
pushed into the registry running from it, pulled back, and booted as a second registry). Its
data dir lives in the machine's ephemeral /tmp — see "volumes" under Open questions.
Clarification reality forced: a pushed manifest names its blobs via
`snapshot: "sha256:…"` (sha256 of the uploaded snapshot bytes) and/or
`blobs: […]` — the manifest's `digest` field is the image id (canonical digest
over the file map), NOT the snapshot blob's hash, so the push side adds
`snapshot` at upload time. `X-Iso-Digest` = sha256 of the stored manifest bytes.

**Image refs, docker-style:** `[registry-host/]repo[:tag]` —
`localhost:5000/hello:v1`. A ref with a host part routes push/pull at that
registry; `iso tag <src> <ref>` re-names locally first (docker semantics).

**Push** (host-side; the CLI only issues the command — the daemon does
transfers, like docker): resolve image → `HEAD` blob (skip upload if the
registry already has the digest) → `PUT` blob → `PUT` manifest.
**Pull**: `GET` manifest → fetch blobs not in the local store → tag locally.
Snapshots are self-contained (full fs), so a pulled image runs without its
parent chain; `history[]` rides the manifest for provenance.

## Architecture

Four layers. The CLI is deliberately the thinnest, and the Engine API is the
only contract that must stay stable.

```
  iso CLI         ── iso Engine API (HTTP/WS) ──▶   iso HOST  (the "daemon")
 (local, thin,                                      ┌─────────────────────────────┐
  context-aware)                                    │ Control Plane Worker        │
                                                    │  router · auth · registry   │
                                                    │      │ DO stub               │
                                                    │      ▼                       │
                                                    │ Machine DO (one per instance)│
                                                    │  owns VFS /tmp ·             │
                                                    │  spawns sub-isolates         │
                                                    └─────────────────────────────┘
   one CLI, many hosts:  local dev host  ·  neta.iso.host  ·  self-hosted
```

### 1. Image (the tarball)

- Content of `base-image.tar.gz`: a rootfs (`usr/lib/node_modules/...`, `usr/bin/*`
  launchers, `etc/npmrc`, `usr/lib/workerd-shims/*`). Already produced by `build.mjs`.
- Add a **manifest** `iso.json` at the root of the tarball:
  ```jsonc
  {
    "schemaVersion": 1,
    "digest": "sha256:…",          // of the tar before gzip; the image id
    "entrypoint": ["npm"],          // default cmd for `iso run`
    "env": { "PATH": "/tmp/usr/bin:/tmp/proj/node_modules/.bin" },
    "workdir": "/tmp/proj",
    "wasmified": ["esbuild", "rolldown"], // native deps replaced by wasm at build
    "ports": [5173]                 // dev-server style HTTP the machine will serve
  }
  ```
- **Layering** is optional v2: tarball-per-layer, digests in `iso.json`, unpack in
  order into the VFS. Content-addressing is enough to dedupe + cache from day one.

### 1b. Building images: a JS build graph + `commit` (commit is the primitive) — ✅ implemented

**The build file is a JS module, not a Dockerfile.** (A Dockerfile-subset
parser ("Isofile") was considered and rejected: adopting another platform's
syntax is unidiomatic for a JS-native platform, and a parsed text format buys
nothing a JS module doesn't already give.) The frontend is **`iso.build.mjs`**
— found by convention in the build context, `-f` overrides — using a tiny SDK
(`iso-sdk`, one file, `packages/sdk/`) where **each call appends a
discrete step to an immutable graph**; the calls ARE the layer boundaries, and
ordinary JS control flow composes builds:

```js
// iso.build.mjs
import { from } from "iso-sdk";   // repo-local: imported by relative path
let img = from("base")
  .workdir("/tmp/proj")
  .copy("./app.js", "app.js");
for (const p of ["left-pad", "is-odd"]) img = img.run("npm", ["install", p]); // 2 discrete steps
export default img.env({ NODE_ENV: "production" }).cmd("node", ["app.js"]);
```

SDK ops (v1): `.run(cmd, args?)` (**exec-form only** — `.run("a && b")` is a
loud TypeError, there is no shell in a machine), `.copy(src, dest)` (file or
directory from the context; relative dest resolves against the current
workdir), `.env(obj)`, `.workdir(dir)`, `.cmd(...)`, `.entrypoint(...)`,
`.expose(...ports)`, `.label(obj)`. Each op serializes to a plain descriptor
`{op, …params}` — the SDK holds **no execution logic**. A `.run` that needs a
native binary **fails the build** — wasm-or-bust is enforced by execution, not
by lint. This is the BuildKit framing: the SDK is one *frontend* over the
commit engine; others can exist.

**`iso commit <machine> [repo[:tag]]`** is the primitive, and it is *more*
natural here than in Docker: a machine's whole world is one VFS `/tmp` — no
overlayfs, no layer diff. The Machine DO walks its own filesystem (excluding
ephemera: npm cache, probe scratch, shadow copies), the host registers it as a
content-addressed image under `~/.iso/images/` (digest = sha256 of the
canonical snapshot serialization — sorted path + bytes; the "sha256 of the
tar" from the sketch above, minus inventing a tar writer — reproducible:
same tree ⇒ same digest). Docker-parity options: `-m <message>`,
`--change "ENV K=V"` / `--change "CMD …"` to amend the manifest.

**`iso build [-t repo[:tag]] [-f file] <context>` is a loop over commit**: the
CLI imports the build module, walks the graph — `run`→exec, `copy`→fs-write,
meta→manifest — committing an untagged INTERMEDIATE image after each executed
RUN/COPY and a final tagged one, removing the build machine (`--keep` keeps it).

**Per-step build cache — ✅ implemented (docker semantics).** Step identity is
`hash(parentStepHash, descriptor)`: meta steps participate in the chain (they
shift descendants) but need no snapshot; COPY descriptors embed a content hash
of the actual context files. `stepHash → digest` lives in
`~/.iso/images/cache-index.json`; on rebuild, consecutive prefix hits print
` ---> Using cache`, the first miss boots the machine from the last cached
digest and everything downstream re-runs. A fully-cached build boots no
machine (the last digest is re-manifested + tagged). `--no-cache` skips reads,
still writes. `iso rmi` purges entries for deleted digests; stale entries
self-heal to a miss. Dangling intermediates show under `iso images -a` only.
Proven: cold 2.2s → cached 0.44s with the identical final digest; a
`--no-cache` re-execution reproduced the same digest (true determinism).

**Remaining v2 tradeoff:** the build program runs in the CLI's own node
process — running it in a sandboxed machine on the host restores strict
thin-client.

`history` in `iso.json` records the step descriptors + parent digest, so
`iso inspect <image>` shows provenance (`docker history` equivalent).

### 2. Machine DO (the "container" — and the KERNEL)

**The kernel model — rebased onto RUNTIME primitives.** Spawn is no longer a DO syscall: it is
a **fork primitive**. Every generic child is loaded with `allowSpawn` (its native
`child_process.spawn()` launches sub-isolate processes directly, recursively — no DO round-trip)
and `drainProcess` (the isolate runs to true event-loop quiescence; the parent's await is
waitpid). The literal npm bin, `npm create`'s recursive create-vite spawn, sh's external
dispatch, and real top-level node scripts (CJS `require()` included) all run on those two
primitives — the earlier DO-side spawn RPC (`ctx.spawn`/`__ISOLATE_SPAWN`) is deleted.

**The DO's role shrinks to supervision + streaming**: it boots the rootfs, launches top-level
processes (exec sessions and their bins) with the streaming sink (frames flow over the RPC
stream even during the drain phase — verified), owns the attach/logs sockets and session stdin,
and keeps the **process table** for what it supervises. `iso top` merges that table with the
runtime's native-spawn records (the `/tmp/.spawn-<n>-<ts>/` dirs the fork materializes per
spawn) — **scoping decision**: native processes are visible while running (marked `[native]`,
ppid unknown — the fork surfaces no parentage and cleans the dir at exit); DO-supervised
processes keep full history. Known fork gaps handed back: spawn stdio has no stdin and no
incremental output (MVP), and no observability events.

Generalize `NpmBaseImage` into `Machine`:

- `boot(imageDigest)` — pull the tarball (from the registry / control plane),
  unpack into native `/tmp` via **sync** writes (the async-tar bug is why; see
  `boot()` today). Idempotent: skip if rootfs marker exists.
- `run(cmd, args, opts)` — `resolveBinToJs` (PATH + `.bin` scan, already written)
  → run the entry as a sub-isolate (`runNodeChild`) → return `{code, stdout, stderr}`.
- Heavy toolchains (npm, vite) run **in the DO itself**, not the child, because a
  child has no module fallback (`do-shell` milestone). The child runs only
  bundle-to-CJS-then-`UnsafeEval`-able code. This split is load-bearing — the CLI
  must never promise "run npm in a child."
- Long-lived: the DO is the instance. It has an id, storage, and an HTTP/WS front
  door. `iso run -d` just means "return the DO URL and don't block."
- A machine that serves a port (vite dev) keeps the DO warm and routes
  `https://<id>.<zone>/…` straight into the in-isolate dev server.

### 3. Control plane Worker

- Routes `iso` CLI calls to the right DO by machine id.
- Holds the **machine registry** (`ps`): a DO (or KV) mapping `id → {image, status,
  createdAt, ports}`. `iso run` inserts; the Machine DO updates status.
- Holds the **image registry** (`push`/`pull`): digest → tarball blob (R2/bucket).

## CLI surface (implemented in `packages/` unless marked ⏭)

Machine-addressing is docker's: every `MACHINE` below accepts a full 64-hex id, a **unique id
prefix**, or a **name** (auto-generated `adjective_noun` when `--name` is absent), resolved
server-side in the registry. Flags parse anywhere before the machine COMMAND (before/after the
image); from COMMAND on, argv is passed verbatim. Non-detached `run`/`exec` exit with the
machine command's exit code.

```
iso run [-d] [--name n] [-e K=V]… [-w dir] [-p host[:machine]]… <image> [cmd...]
                                     # boot a Machine DO, run cmd (-d: print id; -p publishes a
                                     # REAL host port to the machine's node:http server, docker
                                     # semantics — bare -p uses the manifest EXPOSE; ps shows PORTS)
iso exec [-d] [-i] [-t] [-e K=V]… [-w dir] MACHINE <cmd...>   # another cmd in the SAME machine (shared /tmp)
                                     # -i: attach local stdin to the command's REAL process.stdin over
                                     #     the exec-attach WS (EOF propagates; Ctrl-C detaches, exit 130)
                                     # -t: warns — the platform has no PTY; sessions are line-oriented
iso ps [-a] [-q]                     # docker-formatted: MACHINE ID/IMAGE/COMMAND/CREATED/STATUS/NAMES
iso logs [-f] MACHINE                # replay the ring; -f = live tail
iso top MACHINE                      # the kernel's process table: PID/PPID/STATE/TIME/CMD
iso images                           # list the host's images (repository/tag/files/size)
iso inspect MACHINE...               # registry record + the Machine DO's cheap report (JSON)
iso cp MACHINE:PATH LOCAL | LOCAL MACHINE:PATH   # single-file copy over /v0/machines/{ref}/fs
iso rm [-f] MACHINE...               # refuse a running machine unless -f (docker semantics)
iso version                          # client + GET /v0/version engine info
iso host start|stop|status           # manage the LOCAL daemon (pidfile ~/.iso/, auto image build,
                                     #   workerd-fork resolution/re-sign — no env-var incantation)
iso context create <name> --host <url> [--token …] | use | ls  # point the CLI at an iso host
iso commit [-m msg] [--change "CMD …"]… MACHINE [repo[:tag]]  # snapshot a machine → content-addressed image
iso build [-t repo[:tag]] [-f file] [--keep] CONTEXT   # walk CONTEXT/iso.build.mjs (§1b), commit once
iso rmi IMAGE...                     # untag; blob deleted with its last tag (legacy images refuse)
iso volume create|ls|rm|inspect|sync|snapshot|rollback   # ✅ checkpointed persistent trees (volumes.md)
iso run … -v <name>:/mount           # ✅ attach a volume (checkpoint semantics, exclusive; -v repeatable)
iso network create|ls|rm|inspect|logs   # ✅ "the network is a JS function" (networks.md; --policy runs SANDBOXED)
iso run … --network <net> --name <n>     # ✅ join a network; members resolve each other by name; egress transits the policy
iso tag SRC [host/]repo[:tag]        # local re-tag (docker ref syntax; same digest, new name)
iso push [--token t] host/repo[:tag] # daemon-side transfer to an iso registry (dedupe via HEAD)
iso pull [--token t] host/repo[:tag] # manifest → missing blob → store + tag locally
```

**`push`/`pull` — ✅ implemented** against the standalone iso Registry (§"iso Registry"): proven
end-to-end (tag → push → dedupe re-push → local rmi → pull → `iso run` of the pulled image
executes its manifest CMD; bearer auth 401/success both surfaced). Image digests are the sha256
of the snapshot artifact bytes, so local and registry addressing are identical. The Engine API
grew `POST /v0/images/tag`, `POST /v0/images/{ref}/push`, `POST /v0/images/pull`,
`GET /v0/images`, `GET|DELETE
/v0/images/{ref}`, `POST /v0/machines/{ref}/commit`, `GET /v0/version`, `GET /v0/machines/{ref}`
(inspect), and `DELETE …?force=1` alongside the v0 sketch above; machine-`{ref}` resolution lives
in the Registry DO, image refs resolve host-side (repo[:tag] | digest | unique digest prefix).
`iso run` honors the image manifest (ENTRYPOINT/CMD/ENV/WORKDIR; `-e`/`-w` override).

## The streaming-logs / interactive-exec protocol (the real gap)

Today a run **buffers stdout into an array and returns it when the run settles**
(the `QUIET`/`MAX` poll loop in `probeSrc`). That cannot back `logs -f` or an
interactive `exec`. Design:

- Each sub-isolate gets a **stream id**. Instead of `out.push(...)`, its
  `stdout/stderr.write` hooks post chunks back to the Machine DO (Worker-Loader
  RPC, or a `WritableStream` passed in).
- The Machine DO keeps a **per-stream ring buffer** in memory + spills to DO
  storage for replay (`logs` without `-f` = replay; `-f` = subscribe).
- The CLI connects over **WebSocket**; the DO fans out new chunks to subscribers.
  `exec -it` is the same channel plus a stdin pipe — but **no TTY**, so it is
  line-oriented, not a pty. Document that limit loudly.
- Backpressure: bounded ring buffer; if a slow client can't keep up, drop with a
  visible `… N lines dropped` marker (the "no silent truncation" rule).

This is the single most valuable piece of new engineering before the CLI feels
like Docker rather than a batch runner.

## What stays honest (the README of limits, promoted to product copy)

- **wasm-or-bust**: native binaries must be wasm-ified at build time or the image
  is rejected. `iso build` should *fail loudly* if it detects an unshimmed native
  dep, not silently `--ignore-scripts` past it.
- **No TTY / non-interactive**: scaffolders and tools must run with all flags; no
  prompts. `exec` is line-oriented.
- **One filesystem, faked process state**: sequential steps are fine; true
  concurrent processes share globals/module cache. Don't promise process isolation.
- **Children can't load arbitrary modules**: heavy toolchains run in the DO. The
  child runs bundled-CJS-via-`UnsafeEval` only.

## Killer demo (the thing to build toward)

`iso run vite-react npm create vite@latest myapp -- --template react-ts` →
`iso exec <id> npm install` → `iso exec <id> npm run dev` → open
`https://<id>.<zone>/` and get **live HMR** — a full Vite dev machine that
cold-starts in milliseconds, is globally addressable, and runs thousands-per-host
because it's an isolate, not a VM. Docker cannot do that at this density or speed.
Every piece of this path is already proven in isolation (`README.md`,
`docs/rolldown-fork-findings.md`, the `base-image` + `do-shell` spikes); `iso` is
the layer that makes it one command.

## Open questions

0. ~~**Volumes / persistent machine storage**~~ — ✅ RESOLVED by volumes
   (`volumes.md`, implemented): checkpoint semantics (copy-in at boot,
   copy-out at graceful stop/sync), content-addressed history, exclusive
   attach, sandboxed user drivers. The registry-on-platform now persists via
   `-v regdata:/data`. Live-mount upgrade = fork-gap #15 (bind mounts). Original
   wound below, for the record: a machine's /tmp is in-memory and dies with its
   DO (eviction or abort). Long-lived stateful services (the registry-on-platform's data dir)
   need a `-v`-analog: DO storage-backed mounts, or snapshot-on-eviction. Undesigned.
1. **Registry/blob store** — R2? a DO? out of scope for the local MVP (filesystem
   cache of tarballs by digest is enough to start).
2. **Layering vs. single tarball** — single is simpler and fine until image reuse
   hurts. Defer.
3. ~~**Multi-machine networking**~~ — ✅ RESOLVED by networks (`networks.md`,
   implemented): members resolve each other BY NAME (Host-header routing through
   the port-proxy path, no DNS), and ALL egress transits a sandboxed per-network
   policy fn. `iso network create|ls|rm|inspect|logs`, `iso run --network`.
4. **Resource limits / eviction** — DO hibernation gives us idle-eviction for
   free; map `iso run --rm` and TTLs onto it.
5. **Build recipe format** — is the "Dockerfile" just `build.mjs` config, or a
   declarative `iso.recipe.json`? Start with config; formalize if users write many.
```
