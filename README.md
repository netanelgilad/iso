# iso

**Docker's developer experience, for V8-isolate machines.**

`iso` gives you `run`, `exec`, `build`, `commit`, images, a registry, volumes, and networks —
the whole Docker mental model — but a "machine" is a **V8 isolate** (a workerd Durable Object),
not a Linux container. Machines cold-start in **milliseconds**, the world inside is **pure
JavaScript + WebAssembly**, and the network layer is a **JavaScript function you write** instead
of iptables you configure.

```console
$ iso run -it base sh                    # drop into a shell in a fresh machine
$ iso run base npm install left-pad     # real npm, real registry fetch, inside an isolate
$ iso build -t myapp ./myproj            # build an image from a JS build graph
$ iso run -d --network appnet --name db registry   # machines reach each other by name
```

> **Status: v0.1, macOS on Apple Silicon (arm64).** iso runs on a [forked workerd](#built-on-a-workerd-fork)
> that adds a filesystem, `child_process.spawn`, and process-drain semantics to isolates. It is a
> real, working system — everything shown in this README is a verified command — but it is young:
> read [Requirements & limits](#requirements--limits) before you rely on it.

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/netanelgilad/iso/main/install.sh | bash
```

The installer downloads the JS dist + the workerd runtime binary from the latest release,
installs host dependencies, **ad-hoc code-signs** the binary (required on macOS, or the runtime is
SIGKILLed), and links `iso` onto your `PATH`. Re-running upgrades in place.

Requires **Node.js ≥ 22** and **macOS on Apple Silicon**. If `iso` isn't found afterward, add the
printed bin dir to your `PATH` (usually `~/.local/bin`).

### Updating

```bash
iso update            # check + install the latest release (then: iso host stop && iso host start)
iso update --check    # just report whether an update is available
```

`iso update` installs side-by-side under `~/.iso/dist/<version>` and flips the `iso` symlink —
re-running the install one-liner does exactly the same thing. **Privacy note:** the check is a
single GitHub API call (`releases/latest`); it happens only during `iso update`/`--check`, or at
most once per 24 hours from `iso version` (cached in `~/.iso/update-check.json`). No other
command phones home.

### Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/netanelgilad/iso/main/uninstall.sh | bash
# ...or, if you still have the installer: iso ... then  install.sh --uninstall
```

This stops the host, removes the installed code (`~/.iso/dist`, `~/.iso/run`) and the `iso` symlink,
and **preserves your data** (`~/.iso/images`, `volumes`, `networks`, `state.json`). To remove
everything including data, add `--purge`:

```bash
curl -fsSL https://raw.githubusercontent.com/netanelgilad/iso/main/uninstall.sh | bash -s -- --purge
```

---

## 60-second quickstart

```console
$ iso host start                         # boot the local daemon (first run builds the base image, ~30s)
iso host started
  Engine API:  http://127.0.0.1:8787   (pid 82711)

$ iso run base node -e 'console.log("hello world")'   # run code in a fresh isolate
hello world

$ iso run base node -p '2 ** 10'         # -p prints the expression value
1024

$ iso run base npm install left-pad      # a machine runs REAL npm against the REAL registry

added 1 package in 721ms

node_modules: left-pad
npm warn deprecated left-pad@1.3.0: use String.prototype.padStart()

$ iso run --rm -it base sh                # drop into a shell in a fresh machine (--rm: auto-clean on exit)
iso: no default command; starting sh
/work $ echo "hi from $(pwd)"
hi from /work
/work $ echo one && echo two              # real shell grammar (pipes, &&, quoting)
one
two
/work $ exit
$ iso ps -a                              # --rm left nothing behind
MACHINE ID   IMAGE   COMMAND   CREATED   STATUS   PORTS   NAMES   NETWORK
```

That's it: an isolate booted, ran the real npm CLI (fetching from `registry.npmjs.org`), gave you
an interactive shell with `iso run -it base sh`, and — with `--rm` — cleaned itself up. No
container image pull, no VM.

---

> **Where the examples live.** The `examples/` and `packages/` used below ship with iso. After a
> `curl | bash` install they're under `~/.iso/dist/current/` — e.g.
> `iso build -t hello ~/.iso/dist/current/examples/hello`. From a git clone, use `./examples/hello`.
> The commands below use the clone-relative form; substitute the dist path if you installed via the
> one-liner (`export EX=~/.iso/dist/current/examples` and use `$EX/...`).

## Images & JS build graphs

An iso image is a content-addressed filesystem snapshot. You build one from an **`iso.build.mjs`**
file — a build graph written in JavaScript with the `iso-sdk`, where each call is a layer:

```js
// examples/hello/iso.build.mjs
import { from } from "iso-sdk";

export default from("base")
  .workdir("/work")
  .copy("./app.js", "app.js")
  .run("npm", ["install", "left-pad"])   // runs at build time, cached per-step
  .cmd("node", ["app.js"]);
```

```console
$ iso build -t hello ./examples/hello
 ---> committed sha256:19c53e443904…
Successfully tagged hello:latest

$ iso run hello
*****************hello from an iso image
left-pad version: 1.3.0

$ iso images
REPOSITORY   TAG      IMAGE ID       CREATED   SIZE
hello        latest   19c53e443904   …         15.2MB
base         latest   3c992755f8fe   …         15.2MB
```

Builds are cached per step (Docker semantics): change a later layer and earlier layers are reused.
You can also snapshot a running machine into an image with **`iso commit <machine> <name>`**.

---

## Registry — including running the registry *on* iso

`iso tag` / `push` / `pull` speak to a content-addressed registry. The registry is itself an iso
image (`packages/registry`), so you can **run the registry as a machine** and push into it:

```console
$ iso build -t registry ./packages/registry
$ iso run -d --name reg -p 5099:5000 registry node serve.mjs --port 5000 --data /var/registry-data
$ iso tag hello localhost:5099/hello:v1
$ iso push localhost:5099/hello:v1
v1: digest: sha256:19c53e443904… size: 20364504
$ curl -s localhost:5099/v0/repos
[ { "repo": "hello", "tags": ["v1"] } ]
```

`-p 5099:5000` publishes a machine port on the host (Docker-style). Pair it with a volume (below)
to keep the pushed images across restarts.

---

## Volumes — persistent, checkpointed storage

Volumes give a machine a persistent tree that outlives it. Semantics are **honest checkpoints**:
copied in at boot, copied out on graceful `iso rm` and explicit `iso volume sync`.

```console
$ iso volume create data
$ id=$(iso run -d --name w -v data:/vol base iso-tick 300 500)
$ iso exec w sh -c "echo persisted > /vol/note.txt"
$ iso rm -f w                                   # controlled teardown -> checkpoints the volume out
volume data: checkpointed sha256:4133a9c8da5e

$ iso run -d --name w2 -v data:/vol base iso-tick 60 500
$ iso exec w2 cat /vol/note.txt
persisted                                        # survived its machine
```

Volumes are versioned (`iso volume snapshot` / `rollback`, retention = pinned + last 5) and can be
backed by **sandboxed user driver modules**. See [docs/volumes.md](docs/volumes.md).

---

## Networks — "the network is a JS function"

Docker networking is plumbing you configure. In iso, a network is **behavior you write**: every
byte a member machine sends transits one seam, so a network policy is a JavaScript function.

Members resolve each other **by machine name** (no published ports, no DNS). With a `--policy`
module, **all** egress — machine-to-machine and internet — passes through your function, running
**sandboxed** in its own isolate (no filesystem, no spawn, no daemon access; egress-only).

```js
// examples/network-policies/deny-all.policy.mjs
export default {
  proxy: async (request, ctx) => {
    // ctx.from = {machine, name}; ctx.to = {host, port}; ctx.route(name, req) delivers to a member
    return new Response(`blocked by ${ctx.net} policy: ${ctx.from.name} -> ${ctx.to.host}`, { status: 403 });
  },
};
```

```console
$ iso network create locked --policy ./examples/network-policies/deny-all.policy.mjs
$ id=$(iso run -d --network locked --name app base iso-tick 120 500)
$ iso cp ./examples/network/fetch-url.mjs app:/work/fetch-url.mjs
$ iso exec app node fetch-url.mjs https://example.com/
status: 403
blocked by locked policy: app -> example.com:443

$ iso network logs locked                        # every fetch the network saw
2026-…Z app  GET  https://example.com/ → policy (403)
```

The bundled policies show the range: `npm-only` (an allow-list that lets a **real `npm install`**
through while blocking everything else), `rewrite-internal` (map `api.internal` → a real member,
inject a header), `ratelimit` (a stateful policy using `ctx.state`), and `poisoned` (a hostile
policy proving the sandbox boundary). See [docs/networks.md](docs/networks.md).

---

## Command reference

| | |
|---|---|
| **Machines** | `run` (incl. `-it`, `--rm`), `exec`, `ps`, `logs`, `inspect`, `top`, `cp`, `rm`, `commit` |
| **Images** | `build`, `images`, `tag`, `push`, `pull`, `rmi` |
| **Volumes** | `volume create\|ls\|rm\|inspect\|sync\|snapshot\|rollback` |
| **Networks** | `network create\|ls\|rm\|inspect\|logs` |
| **Daemon / config** | `host start\|stop\|status`, `context`, `version`, `update` |

Flags may appear anywhere; machines resolve by id, id-prefix, or name. `iso run -it <image>` gives
you a shell (or the image's default command); add `--rm` to auto-clean throwaway sessions. Run
`iso --help` or `iso <command> --help` for the full surface.

---

## Architecture

```
┌────────────┐   HTTP/WS (Engine API, :8787)   ┌───────────────────────────────────────┐
│  iso CLI   │ ──────────────────────────────▶ │  iso host (daemon)                     │
│ (thin      │                                  │  Node http ⇄ miniflare ⇄ forked workerd│
│  client)   │                                  │                                        │
└────────────┘                                  │   control-plane Worker (the router)    │
    state in ~/.iso/state.json                  │     ├─ Registry DO   (machine records) │
                                                 │     ├─ Machine DO ×N (one per machine) │
                                                 │     │    └─ child isolates (your code, │
                                                 │     │        npm, sh, spawned procs)   │
                                                 │     └─ policy / driver isolates        │
                                                 │        (sandboxed user JS)             │
                                                 └───────────────────────────────────────┘
                                                    images/volumes/networks in ~/.iso/
```

A **machine** is a Machine Durable Object owning a writable VFS. Running your command loads a
**child isolate** over that VFS; `child_process.spawn` inside it launches further sub-isolates
(so `npm` → `node` → … is a real process tree). Ports, volumes, and network egress are all
mediated by the control plane. Full write-up: [docs/architecture.md](docs/architecture.md).

**Install layout.** The CLI, daemon, and runtime live under `~/.iso/dist/<version>/`
(`~/.iso/dist/current` → active version); `iso` is symlinked from your bin dir to
`packages/cli/iso.mjs` there. All runtime state (images, volumes, networks, contexts) lives in
`~/.iso/`. The workerd binary is code-signed once into `~/.iso/run/workerd.bin`. No environment
variables are required; `$MINIFLARE_WORKERD_PATH` overrides the binary for development.

---

## Requirements & limits

Honest constraints for v0.1 — none of this is hidden:

- **Platform:** macOS on Apple Silicon (arm64) only. The runtime is a specific workerd build; other
  targets need their own fork build (roadmap). Node.js ≥ 22 required.
- **Pure JS/Wasm world.** A machine's world is JavaScript + WebAssembly running on workerd — not a
  Linux userland. There is no libc, no native binaries, no `/bin/bash`. `npm` works because npm is
  JS; native addons and posix-only tools do not.
- **Interactive sessions are line-oriented, no PTY.** `iso run -it` and `iso exec -i` attach real
  stdin/stdout, but there is no pseudo-terminal (`-t` prints a warning and is otherwise ignored);
  full-screen TUIs won't render. `Ctrl-C` detaches (the command keeps running).
- **Volumes are checkpoints, not live block devices.** Data is copied in at boot and out on
  *controlled* teardown — that includes `iso rm` **and `iso rm -f`** (both checkpoint), plus explicit
  `iso volume sync`. What loses writes since the last checkpoint is an *uncontrolled* loss: the host
  daemon crashing, being `kill -9`'d, or a machine getting evicted from memory before its checkpoint.
- **Two shell layers, two different limits.** The bundled interactive `sh` (`iso exec -i … sh`) is
  [just-bash](https://github.com/vercel-labs/just-bash) and *does* handle real shell grammar —
  pipes, `&&`/`||`, quoting, globs. The separate limit is npm's own **lifecycle/run scripts**: the
  fork tokenizes `sh -c '<line>'` into argv with no shell pass, so a package's `"scripts"` that rely
  on compound shell lines or shell builtins won't run as a POSIX shell would. iso ships coreutils
  bins (`echo`, `cat`, …) so common scripts still work.
- **Known runtime edges** are tracked precisely in [docs/fork-gaps.md](docs/fork-gaps.md) (a
  provenance ledger of what iso works around and what has landed upstream in the fork).

---

## Built on a workerd fork

iso runs on a fork of Cloudflare's [workerd](https://github.com/cloudflare/workerd) that adds the
primitives isolates need to behave like machines: a writable VFS rooted at `/`, VFS-backed module
loading, `child_process.spawn` backed by sub-isolates, and `drainProcess` (run-to-quiescence)
semantics.

- Fork branch: **[netanelgilad/workerd @ `feat/vfs-module-loading`](https://github.com/netanelgilad/workerd/tree/feat/vfs-module-loading)**.
- **Exact provenance:** the shipped runtime binary
  `workerd-vfs-darwin-arm64.bin` (`sha256 e01ebcc46de052bb6bd4f707bd5ea4db33d47ee146ffc69c873cd1e2b0ac5d9d`)
  was built from commit [`366e8a8`](https://github.com/netanelgilad/workerd/commit/366e8a86cdcf2841fef5fc6cb5416d0722405f1f).
  It ships as a release asset, ad-hoc code-signed by the installer.
- **Building the fork yourself:** clone that branch at `366e8a8`, build with Bazel per workerd's
  instructions, then point iso at it with `MINIFLARE_WORKERD_PATH=/path/to/workerd`. CI-built fork
  binaries (and additional platforms) are a roadmap item.

---

## Development

```bash
git clone https://github.com/netanelgilad/iso && cd iso
npm install                       # host + CLI deps, links iso-sdk
# place a signed workerd-vfs.bin at the repo root (or export MINIFLARE_WORKERD_PATH)
node packages/cli/iso.mjs host start
node packages/cli/iso.mjs run base npm install left-pad
```

The repo layout is the install layout: `packages/{cli,host,registry,sdk,base-image}`, `examples/`,
`docs/`. `iso` resolves the daemon relative to its own location, so a checkout works exactly like an
install.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for dev setup + tests, [`CLAUDE.md`](CLAUDE.md) for the
full operating manual (fork pairing, release process, warts), and the
[issue backlog](https://github.com/netanelgilad/iso/issues) for the work queue.

## License

[MIT](LICENSE).
