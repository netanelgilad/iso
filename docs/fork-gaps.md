# Fork gaps — handoff from the iso workstream to the runtime workstream

Precisely-captured workerd-fork gaps hit while integrating iso (the Docker-shaped
CLI/host, `packages/`) onto the native primitives (vanilla rootfs,
`drainProcess`, `allowSpawn`). Current binary: the combined re-root + POSIX +
spawn-stdio build (`c30f5022`, fork mainline `83df466`). Open items below are
**mitigated environmentally** in iso (launcher/coreutils overlay, drain-children
workaround, probe re-chunking) — npm and all user code stay byte-for-byte
vanilla — but each mitigation should become unnecessary as these land as fork
primitives.

Longer prose + transcripts: `the README` §"Fork gaps hit" and the
capstone/adoption sections.

## LANDED (verified on 83df466 / c30f5022 — iso mitigations deleted)

### ~~1. Spawn stdio streams (stdin + incremental output)~~ — landed in 83df466

Real `child.stdin` (writable), incremental `stdout`/`stderr`, and inherit stdin
pumping. Verified: sh externals stream LIVE (~300ms tick cadence in-session),
`child.stdin.write + end` → child `'end'`, and the foreground-stdin flow
(interactive `node ask.mjs` inside sh) is re-enabled. See #16 for a residual
exit-latency edge.

### ~~6. `stdio: "inherit"` is capture-only~~ — landed in 83df466

Child output forwards natively to the parent's (patched) streams, incrementally.
iso's launcher inherit-forwarding adapter is **deleted** (proven redundant).

### ~~7. Native spawn's probe drops write callbacks~~ — landed in 83df466

Verified: a RAW `npm-cli.js` failing install exits **1** with no adapter. iso's
launcher write-callback adapter is **deleted**.

### ~~9. Early-failure events emit synchronously inside `spawn()`~~ — landed in 83df466

Verified: spawning an unresolvable bin delivers exit code 127 via the `exit`
event after listeners attach.

## P1 — correctness sharp edges (iso has workarounds, they're load-bearing)

### 5. Cross-isolate in-place `writeFileSync` → "internal error" — RE-VERIFIED OPEN on c30f5022

Minimal repro (re-run on the POSIX build): isolate A (the DO) writes `/work/x`;
isolate B (a child) does `writeFileSync("/work/x", …)` →
`internal error; reference = …`. A read→rm→write re-own **in the writer's
isolate** succeeds.

Real-world hit: npm's `PackageJson.save` rewrites `package.json` in place → any
install over a pre-existing `package.json` failed and npm's error rollback
**deleted the file**. iso's mitigation (still load-bearing): the overlay
`usr/bin/npm`/`npx` launchers pre-own
`package.json`/`package-lock.json`/`node_modules/.package-lock.json` before npm
loads.

### 10. node:http-server bridge body pump costs ~10ms PER CHUNK

`handleAsNodeRequest` delivers request bodies to the node server in 4KB chunks
at ~10ms each regardless of chunk size: a 20MB body takes **~50s**; the same
body enqueued as 1MB chunks arrives in **~6ms** (both measured in-child,
capstone probes). iso's mitigation: the machine probe's fetch
surface re-chunks request bodies to 1MB before bridging. The per-pump-iteration
cost (a ~10ms yield?) is the bug.

### 11. Long streaming proxy requests trip the hang detector and ABORT the DO

A request streaming >~30s through a DO (the pre-re-chunk 20MB PUT) gets
"the Workers runtime canceled this request because … hung"; the cancellation
escapes as an uncaught exception and the **DO instance aborts**, wiping its
in-memory /tmp (a machine's entire world). Streamed proxy bodies should count
as I/O progress; a canceled request must not take the DO down.

### 16. Child `process.exit` doesn't end the drain while stdin is flowing (NEW, on 83df466)

A spawned child that consumed its (inherited/pumped) stdin and then calls
`process.exit(0)` does not quiesce — the flowing stdin counts as pending work —
so waitpid (and the parent shell's prompt) stalls until the hang detector
(~40s) kills the child; the recorded exit code does survive. Children that
never touch stdin exit instantly. Expected: `process.exit` tears the process
down immediately, per node semantics.

## P2 — worth knowing / smaller

### 18. A child's only-pending-work is a SLOW-failing governed egress → drain declares it quiescent early (NEW, networks)

When a NETWORKED machine's child fetch is routed through the egress governor
(child → DO-stub `globalOutbound` → control plane → `fetch()`), and that egress
is a SLOW failure (an unresolvable bare hostname takes seconds to fail DNS),
the child can be declared quiescent by `drainProcess` and its `run()` resolve
with EMPTY output + exit 0 BEFORE the 502 arrives back — the governor still
logs the 502 (so routing/isolation decisions are authoritative and correct),
but the in-machine client sees nothing. FAST egress (success, connection-
refused, or a policy 403/deny) round-trips fully and prints normally — this
only bites the slow-DNS-failure corner. Likely the reentrant subrequest (child
→ same DO's outbound → CP) isn't counted by the drain heuristic while it's
parked in DNS. iso does not mask it: `iso network logs` is the authoritative
record of what the governor decided. Suggested: count an in-flight
`globalOutbound` subrequest as pending drain work (mirror of the spawn-waitpid
bracket #16/#7 already do for RPC).

### 8. `sh -c '<line>'` is tokenized unconditionally, no builtins — still open

Even with a real `usr/bin/sh` on PATH, `sh -c` lines are tokenized (no shell
pass) and there are no builtins — `echo`/`true`/… ship as coreutils bins in the
iso overlay (still load-bearing on c30f5022). Compound lines (`a && b`, pipes)
unsupported at that layer. Suggested: if PATH resolves a real `sh`, delegate.

### 12. Piped node:http responses truncate at the first 64KB chunk

`createReadStream(file).pipe(res)` through the server bridge delivers exactly
one chunk (65536 bytes) then ends — a 20MB blob GET returned 64KB (deterministic;
capstone probes). A single `res.end(buffer)` delivers 20MB intact in ~100ms.
iso's mitigation: the registry's blob GET buffers (in-file comment).

### 13. VFS `rename()` onto an existing path throws — RE-VERIFIED OPEN on c30f5022 (POSIX build)

`renameSync(a, b)` with `b` existing → `Error: file already exists` (POSIX
rename replaces atomically). Probed again on the re-root+POSIX binary: still
broken. Uncaught inside an async handler it also manifested as a hung request.
iso's mitigation: the registry's `atomicWrite` falls back to rm+rename.

### 14. `localhost` dual-stack shadowing (environment, not fork)

`fetch("http://localhost:PORT")` resolves `::1` first on macOS; an unrelated
IPv6 listener on the same port silently hijacks traffic meant for an
IPv4-bound listener. iso's daemon normalizes registry hosts to `127.0.0.1`.
Noted for anyone binding published ports.

### 2. Native spawn observability

No parentage, no lifecycle events; the `.spawn-*` scratch dir is removed at exit
and `status.json` appears only on explicit `process.exit` (clean quiescence
leaves nothing). Consequence: `iso top` shows native processes only while
running, ppid `-`, and exited natives vanish. Wanted eventually: pid/ppid + an
observable process table or event stream (iso would render a full `pstree`).

### 3. Nested spawn from a non-`drainProcess` child hits EPERM on VFS writes

Registry fetch → cacache `mkdir` fails when the spawner is a non-drain child.
iso's workaround: every generic child is a drain child. The drain/non-drain
asymmetry is a sharp edge.

### 4. `require(ESM-with-default)` returns the default export itself

Not a namespace object. iso now relies on this behavior (in-context-require
loader for exec'd scripts) — worth a fork-side regression test so it doesn't
silently change.

### 17. `readdir("/")` exposes the runtime's `bundle/` dir; writes to it fail (NEW, re-root)

On the re-rooted VFS, walking `/` includes `bundle/` (workerd's module bundle);
writing those paths back (image boot) throws. iso excludes `bundle` from
snapshots and boots tolerantly. If `bundle/` isn't meant to be user-visible fs,
consider hiding it from readdir.

## P1 — requested primitive (not a bug)

### 15. Bind mounts: map a host directory at a VFS path per-DO

Volumes need it (see `docs/volumes.md`). The machine's `/tmp` is already a
host directory the fork maps into the VFS — the ask is the same mechanism,
pointed at a second directory: "map host dir X at VFS path Y for this DO
(read-write)". With it, iso volumes upgrade from checkpoint semantics
(copy-in/copy-out, crash-lossy) to true live mounts with no CLI change.
