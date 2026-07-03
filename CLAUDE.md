# CLAUDE.md — operating manual for agents working on iso

You are working in **the iso repo** (`github.com/netanelgilad/iso`), the product's single source of
truth. Assume no memory of prior sessions: this file + `docs/` carry all context. Read this fully
before making changes.

## What iso is

Docker's developer experience for **V8-isolate machines**. A "machine" is a workerd Durable Object
with a writable filesystem, not a Linux container. `iso run/exec/build/commit`, images, a
content-addressed registry, checkpointed volumes, and JS-function networks — the Docker mental
model, but the world inside is pure JavaScript + WebAssembly and the "kernel" is the Node/web API
surface the host runtime provides. Read `docs/architecture.md` first — especially "What's actually
in an image" (the kernel/userland line: `node` is the substrate, not shipped; `npm` is userland).

## Repo map

```
packages/cli/         the `iso` CLI (thin client; iso.mjs is the whole surface)
packages/host/        the daemon: host.mjs (Node http ⇄ miniflare ⇄ forked workerd)
  worker/             the Workers/DOs run inside workerd:
    control-plane.mjs   Engine API router; run/exec/volume/network routes; runtime-compat enforce
    machine-do.mjs      one Machine DO per machine; boot + run + probe builders; exports CHILD_COMPAT_DATE
    network-egress.mjs  egress governor + sandboxed policy isolates
    user-module-isolate.mjs  reusable "user JS runs sandboxed" mechanism (volume drivers)
    vite-dev-probe.mjs  the experimental `iso dev` vite child
packages/registry/    standalone content-addressed registry (also runs AS an iso image)
packages/sdk/         iso-sdk — from() build-graph builder used by iso.build.mjs files
packages/base-image/  builds the base rootfs; node-launcher.cjs; sh/sh-entry.mjs; prebuilt/sh.mjs
examples/             hello, loop, interactive, network(-policies), volume-drivers
scripts/              package.mjs, build-sh.mjs, upload-binary.sh, test-*.mjs
docs/                 architecture.md, design.md, volumes.md, networks.md, fork-gaps.md
install.sh / uninstall.sh   the curl|bash (un)installer
```

## Running from source

The repo layout **is** the install layout (`packages/{cli,host,...}`), so a checkout runs like an
install. You need a signed workerd binary (see fork pairing below).

- **Dev mode:** place a signed `workerd-vfs.bin` at the repo root (or `export
  MINIFLARE_WORKERD_PATH=/path/to/signed/workerd`), then
  `node packages/cli/iso.mjs host start` → `node packages/cli/iso.mjs run -it base sh`.
  The CLI resolves the daemon relative to its own location; `$ISO_HOST_MJS` overrides the daemon
  path.
- **Installed mode:** `curl … install.sh | bash` puts everything under `~/.iso/dist/<version>/`
  (`dist/current` → active), symlinks `iso` onto PATH, code-signs the binary into
  `~/.iso/run/workerd.bin`. All state lives in `~/.iso/` (`images/volumes/networks/state.json`).
- First `iso host start` builds the base rootfs into `~/.iso/base/.staging` (version-stamped;
  rebuilds on version change). `npm install` at the repo root installs host+CLI deps and links
  `iso-sdk`.

## The fork pairing discipline (READ THIS — it's the #1 source of breakage)

iso runs on a **forked workerd** ([netanelgilad/workerd @ `feat/vfs-module-loading`](https://github.com/netanelgilad/workerd/tree/feat/vfs-module-loading)).
Three things must stay in lockstep:

- **binary ↔ rootfs ↔ compat date.** The base image's launchers/overlay assume specific fork
  primitives; `CHILD_COMPAT_DATE` (exported from `machine-do.mjs`, currently `2026-06-01`) is the
  compat level machines run with and is stamped into every image's `runtime.compatDate`.
- **Where the binary comes from.** Built from the fork by the runtime workstream (NOT this repo —
  do not modify `~/Development/workerd` beyond `git push`). The shipped
  `workerd-vfs-darwin-arm64.bin` = `sha256 e01ebcc46de052bb6bd4f707bd5ea4db33d47ee146ffc69c873cd1e2b0ac5d9d`
  = commit `366e8a8`. It's a release asset; the installer downloads + signs it.
- **The re-sign/SIGKILL gotcha.** On macOS an unsigned/foreign-signed workerd is **SIGKILLed
  instantly**. Every path that uses the binary does `xattr -c && codesign -s - -f` first (the CLI
  signs into `~/.iso/run/workerd.bin`; the installer signs in place). Symptom of a missing/broken
  sign: the host dies immediately at boot, often surfaced downstream as a miniflare write EPIPE.
- **The EPIPE=port-mode gotcha.** The fork trips miniflare's **port-mode** control channel with
  `write EPIPE` at `mf.ready`. The host therefore runs miniflare in **`dispatchFetch` mode** behind
  a plain Node http listener — never switch it to miniflare's own host/port.

## Release process (EXACT)

1. **Bump the version in all 8 places** (keep them identical): the 6 `package.json`
   (`package.json`, `packages/{cli,host,sdk,registry,base-image}/package.json`), `HOST_VERSION` in
   `packages/host/host.mjs`, and `const VERSION` in `packages/registry/serve.mjs`. Then
   `npm install --package-lock-only --omit=dev` to refresh the lockfile.
2. **Validate locally:** `node --check` every `.mjs`; run all `scripts/test-*.mjs` +
   `packages/registry/test.mjs`; `bash -n install.sh uninstall.sh`.
3. **Commit + push main.** `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. **Package:** `node scripts/package.mjs` → `dist-release/iso-vX.Y.Z.tar.gz` (+ its checksum).
   Write a combined `dist-release/checksums.txt` with BOTH the tarball hash and the binary hash
   (`e01ebcc4…` while the binary is unchanged).
5. **Reconcile the release-workflow race.** Pushing the tag triggers `.github/workflows/release.yml`,
   which creates the release with ITS OWN tarball build (byte-differs from yours — tar mtimes).
   Wait for the release to exist, then **`gh release upload vX.Y.Z <tarball> checksums.txt
   <binary> --clobber`** to overwrite all three with your canonical set, and `gh release edit` the
   notes. Then verify: `gh release download` the tarball and confirm its sha256 matches
   `checksums.txt` (the browser-download CDN may lag a few minutes — poll it before the smoke test).
6. **Binary:** unchanged releases reuse the v0.1.0 asset (`gh release download v0.1.0 -p
   'workerd-vfs-darwin-arm64.bin'` then re-upload). A NEW binary is uploaded from a machine that
   built the fork via `scripts/upload-binary.sh <tag> [binary-path]`.
7. **Scratch-HOME smoke (REQUIRED, non-negotiable):** fresh `HOME`, clean PATH, run the ACTUAL
   published `curl … install.sh | bash`, then walk the quickstart (host start → run -it base sh →
   run base npm install → the feature you shipped). Only "done" once this passes from the published
   release. Fix-and-re-release (patch bump) if it doesn't.

## Verification culture (the thing that makes iso trustworthy)

- **Every claim is proven by a real transcript.** README/docs show only commands actually run.
  "Should work" is not evidence — run it.
- **Silent no-ops are the enemy.** Any unrecognized input must fail loudly (non-zero + clear
  stderr), never exit 0 having done nothing. (This class caused the `node -e` bug: a marker file
  that silently succeeded. See git history / issue backlog.)
- **Independently re-verify subagent claims.** If you delegate, reproduce the key result yourself
  before reporting it as done.
- **Honest limits over polish.** Document warts; never overstate. The README's "Requirements &
  limits" and `docs/fork-gaps.md` are load-bearing.

## The fork-gaps process

When you hit a runtime limitation: capture a **precise minimal repro** in `docs/fork-gaps.md` (what
you did, what happened, what's expected) → the runtime workstream lands it as a fork primitive →
you **adopt it and DELETE the workaround**. Never let a workaround outlive its gap silently. Three
primitives are **shipped in the current binary but NOT yet adopted** (issues labeled
`runtime-adoption`): #2 native pid/ppid + lifecycle stream, #8 real-`sh` shell delegation, #3
nested-spawn VFS-write drain-independence — see fork-gaps.md's top section.

## Known warts (don't rediscover these)

- **Tarball not byte-reproducible** — `scripts/package.mjs` tars with mtimes, so CI's build ≠ local
  build. That's why step 5 clobbers with the canonical local tarball. (issue: reproducibility)
- **Network logs are in-memory** (500-entry ring, not persisted across host restart). (issue)
- **Release-workflow race** — the workflow and manual release both create the release; step 5's
  clobber is the current reconcile. A proper fix (workflow owns it, or manual-only) is an issue.
- **npm-install-at-install-time** — the installer runs `npm install` for host deps; a prebuilt base
  rootfs / bundled deps as a release asset would remove it. (issue)
- **`node`/`sh` corner:** `/usr/bin/node` is a launcher (`node-launcher.cjs`); `sh` routes flag-shaped
  `node` through a non-`node` name so the fork's `node <script>` special-case runs the launcher as a
  script. See the file headers.

## Pointers

`docs/architecture.md` (how it all fits + the image model), `docs/design.md` (CLI surface + the
client-host / hosted-mode north star), `docs/volumes.md`, `docs/networks.md`, `docs/fork-gaps.md`.
The backlog lives in **GitHub issues** on `netanelgilad/iso` — check open issues for the work queue.
