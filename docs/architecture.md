# iso architecture

iso is a thin CLI talking to a local daemon over an HTTP/WS "Engine API", exactly like the Docker
CLI talks to dockerd. The difference is what a machine *is*: a **V8 isolate** (a workerd Durable
Object with a writable filesystem), not a Linux container.

## The pieces

```
packages/
  cli/          the `iso` CLI — a thin client, holds no runtime state beyond the active context
  host/         the daemon: host.mjs (Node http ⇄ miniflare) + worker/ (the Workers/DOs)
  registry/     the standalone image registry (also runnable AS an iso image)
  sdk/          iso-sdk — from() build-graph builder used by iso.build.mjs files
  base-image/   builds the "base" image rootfs (vanilla npm + a thin overlay)
```

### CLI (`packages/cli/iso.mjs`)

Stateless except for `~/.iso/state.json` (which host endpoint + token the CLI targets — a
"context", Docker-style). Every command is an Engine API call. `iso host start` is the one command
that reaches into the filesystem: it resolves + code-signs the workerd binary, builds the base
image if missing, and spawns the daemon detached.

### Host daemon (`packages/host/host.mjs`)

A Node `http` server bridged to **miniflare** running the **forked workerd** binary. (We use
miniflare's `dispatchFetch` mode, not its port mode: the fork trips miniflare's port-mode control
channel with `write EPIPE`, while `dispatchFetch` is rock-solid.) The daemon owns the on-disk
stores under `~/.iso/`: `images/`, `volumes/`, `networks/`, plus published-port listeners.

### Control plane Worker (`packages/host/worker/control-plane.mjs`)

The Engine API router, running inside workerd. It owns two Durable Object classes:

- **Registry DO** — the machine table (`ps` records: id, name, image, status, ports, network…).
- **Machine DO** (`machine-do.mjs`) — one instance per machine, owning that machine's writable VFS.
  It boots the image rootfs into the VFS, then runs your command by loading a **child isolate** over
  it. `child_process.spawn` inside the child launches further sub-isolates natively, so `npm` →
  `node` → your script is a genuine process tree (surfaced by `iso top`).

### Sandboxed user-JS isolates

Volume drivers and network policies are **user-supplied JavaScript** that must never run in the
daemon. They run in dedicated child isolates with **no ambient authority**: no shared filesystem,
no `node:fs`, no `child_process`, no ability to create further isolates. Their only capability is
egress `fetch` — and for network policies even that is routed back through the control plane so it
can be logged and fenced off from the Engine API. `packages/host/worker/user-module-isolate.mjs`
(drivers) and `network-egress.mjs` (policies) implement this.

## How a request flows

`iso run base npm install left-pad`:

1. CLI → `POST /v0/machines` on the Engine API.
2. Control plane registers a machine record, gets the Machine DO for its id.
3. Machine DO boots the `base` rootfs into its VFS, resolves `npm` to the real
   `/usr/lib/node_modules/npm/bin/npm-cli.js`, and loads a child isolate to run it.
4. npm's own `fetch` to `registry.npmjs.org` goes out through the isolate's outbound path.
5. stdout/stderr stream back through the DO to the CLI (or to `iso logs`).

For a **networked** machine, step 4 is different: the child's outbound is bound to the machine's DO,
which forwards every fetch to the control plane's egress governor — which resolves member names or
invokes the network's sandboxed policy isolate. See [networks.md](networks.md).

## Storage & install layout

```
~/.iso/
  dist/<version>/       the installed tree (packages/ + node_modules + workerd-vfs.bin)
  dist/current          → the active version
  run/workerd.bin       the ad-hoc code-signed runtime binary
  base/.staging         the built base-image rootfs
  images/               content-addressed image store (index.json + sha256-… dirs)
  volumes/<name>/       volume.json + live/ + snapshots/
  networks/<name>/      network.json + policy.mjs + state.json
  state.json            CLI contexts
  host.pid, host.log    daemon pidfile + log
```

Digest discipline: an image digest is the `sha256` of its snapshot artifact bytes, so the registry
blob *is* that artifact and verification is a plain hash — no re-serialization. Volumes reuse the
same content-addressing for checkpoints.

## What's actually in an image (and what isn't)

Every containerization technology is defined by where it draws the
"provided by the host vs. shipped in the image" line:

| | Interface (host provides) | Ships in the image |
|---|---|---|
| VM | virtual hardware | kernel + libc + userland + runtime + app |
| Docker | the kernel (syscall ABI) | libc + userland + the `node` binary + app |
| **iso** | **the JS runtime — Node's API surface + web APIs** | pure-JS/wasm userland + app |

So: **`node` is to an iso machine what the Linux kernel is to a Docker
container.** It isn't installed anywhere — it's the substrate every machine
runs on. A Docker image doesn't contain a kernel; an iso image doesn't contain
node. `npm`, by contrast, is genuinely installed — it's userland, a JS program
at `/usr/lib/node_modules/npm`, byte-for-byte as published.

Read the base image as a *userland-as-JS* distro:

- `sh` (just-bash) ↔ bash
- `echo`, `cat`, `ls`, … ↔ coreutils
- `npm` ↔ apt/apk
- `node` ↔ *not present, because the kernel never is*

`/usr/bin/node` is a **launcher shim**, not a runtime: it implements node's CLI
surface (`-e`, `-p`, `--version`, script dispatch) on top of the runtime the
host already provides. (Historical note: in v0.1.0–v0.1.1 it was a bare marker
file with no entry points, which made `node -e` a silent no-op — the bug that
motivated writing this section. The file-shaped name for a runtime primitive
needs a real body.)

This is why images are ~15 MB instead of ~150 MB and why machines boot in
milliseconds: there is no OS userland to ship and no kernel to boot — the
"OS" (V8 + the Node API + the process model) is already resident in the host
process and shared by every machine, the way containers share one kernel,
except the shared layer here extends up through the language runtime and
standard library.

Two consequences:

1. **Images can't pin a node version** — the API surface is a property of the
   host runtime, exactly like Docker containers can't pin kernels. The
   ecosystem answer is workerd's own idiom: **compatibility dates**. An image
   manifest declaring its required runtime level (so a host can refuse an
   image it can't faithfully run) is the roadmap item — Docker's
   `platform: linux/arm64`, but for API surface instead of CPU architecture.
2. **wasm-or-bust is the libc line.** Native binaries would need a syscall
   layer that doesn't exist; wasm modules bring their world compiled in — the
   moral equivalent of static binaries in a `FROM scratch` container.

Spiritually this is closer to a unikernel / library OS than to Docker — the
app links directly against the platform, no kernel boundary shipped — with the
classic unikernel flaw fixed: the "library OS" isn't bespoke per app, it's the
most widely known API surface in the world, shared and resident.

## The runtime fork

Everything rests on a workerd fork
([netanelgilad/workerd @ `feat/vfs-module-loading`](https://github.com/netanelgilad/workerd/tree/feat/vfs-module-loading))
that adds: a writable VFS rooted at `/`, VFS-backed module loading, native `child_process.spawn`
(sub-isolates), `drainProcess` run-to-quiescence, and streaming spawn stdio. The gaps iso still
works around (and the ones already landed upstream) are logged precisely in
[fork-gaps.md](fork-gaps.md).
