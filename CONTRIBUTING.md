# Contributing to iso

Thanks for hacking on iso. It's a Docker-shaped CLI + daemon for V8-isolate machines, running on a
forked workerd. This is the human-facing quickstart; `CLAUDE.md` has the deeper operating manual
(release process, fork pairing, warts) and `docs/` has the design.

## Requirements

- **macOS on Apple Silicon (arm64)** and **Node.js ≥ 22** (v0.1 only supports this target).
- A signed `workerd-vfs` fork binary (see below). The public source-build path is
  [netanelgilad/workerd @ `feat/vfs-module-loading`](https://github.com/netanelgilad/workerd/tree/feat/vfs-module-loading);
  the shipped binary is built from commit `366e8a8`.

## Dev setup

```bash
git clone https://github.com/netanelgilad/iso && cd iso
npm install                       # host + CLI deps; links iso-sdk
# provide a signed workerd binary, EITHER:
cp /path/to/workerd-vfs.bin ./workerd-vfs.bin       # repo root (the CLI signs it into ~/.iso/run)
# …or point at an already-signed one:
export MINIFLARE_WORKERD_PATH=/path/to/signed/workerd

node packages/cli/iso.mjs host start
node packages/cli/iso.mjs run -it base sh           # a shell in a machine
```

macOS note: an unsigned workerd is SIGKILLed. The CLI ad-hoc code-signs the binary
(`xattr -c && codesign -s - -f`) into `~/.iso/run/workerd.bin` on `host start`; if you supply your
own via `MINIFLARE_WORKERD_PATH`, sign it yourself. State lives in `~/.iso/`.

## Running the tests

Fast, no workerd needed (this is exactly what CI runs — `.github/workflows/ci.yml`):

```bash
# parse-check every module
find packages examples scripts -name '*.mjs' -not -path '*/node_modules/*' -print0 | xargs -0 -n1 node --check
node packages/registry/test.mjs        # registry HTTP suite (25 checks)
node scripts/test-node-launcher.mjs    # node -e/-p/--version/unsupported (silent-no-op guard)
node scripts/test-run-flags.mjs        # iso run -i/-t/-it/--rm parsing (+ loud unknown flags)
bash -n install.sh uninstall.sh        # installer syntax
```

End-to-end behavior (needs the workerd binary + a running host) is proven by real transcripts, not
CI — see the verification culture below.

## PR expectations

- **Prove it with a real transcript.** Every behavioral claim in a PR/commit/doc must be backed by
  output you actually produced. "Should work" isn't evidence. README/docs examples must be verbatim.
- **No silent no-ops.** Any unrecognized input must fail loudly (non-zero exit + clear stderr).
- **Keep npm and user code byte-for-byte vanilla.** Fixes go in launchers/overlay/config, never by
  patching npm or user programs.
- **Hit a runtime limitation?** Capture a precise minimal repro in `docs/fork-gaps.md` and work
  around it environmentally; don't patch the fork from this repo. When a fork primitive lands,
  adopt it and delete the workaround.
- **Touching shipped code** (`packages/`, `install.sh`) means a release: follow the release process
  in `CLAUDE.md` (version bump in all 8 locations, tag, reconcile the workflow race, scratch-HOME
  smoke). Docs-only changes just go to `main`.
- Run the test commands above before opening a PR. Keep changes focused; match the terse,
  heavily-commented style of the surrounding code.

## Where things are

`packages/cli` (the CLI), `packages/host` (daemon + `worker/` DOs), `packages/{registry,sdk,base-image}`,
`examples/`, `docs/` (architecture + design + fork-gaps). The backlog is **GitHub issues** on
`netanelgilad/iso`.
