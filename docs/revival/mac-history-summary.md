# iso / Vite-in-workerd — revival context (what is NOT in the repos)

Compiled 2026-11-10 on the owner's Mac (read-only research). Companion file: `~/iso-revival-context/transcripts-digest.md` (all 127 owner prompts, verbatim, chronological).

## 0. Read this first — what survived and what did not

- **The Claude Code transcripts are gone.** `~/.claude/projects/-Users-netanelg-Development-vite-workerd-demo/` contains only `memory/` (3 files). The apper project dir's oldest transcript is from Oct 2026. Grepping every `~/.claude/projects/**/*.jsonl` for `vite-workerd-demo`, `feat/vfs-module-loading`, `drainProcess`, `rolldown-fork`, `isolate cloud` matched only the research session itself. `~/.codex/sessions` had one incidental hit (a directory listing, 2026-10-25, unrelated). `~/.cursor`: none.
- **So no assistant messages are recoverable.** Sources actually used:
  1. `~/.claude/history.jsonl` — every human-typed prompt, verbatim, with timestamp/cwd/session id (127 relevant prompts).
  2. `~/.claude/projects/-Users-netanelg-Development-vite-workerd-demo/memory/iso-cli-design.md` (24 KB, last written 2026-07-03 11:45) — the iso agent's running log. The single richest surviving assistant-side record. Not relayed verbatim (the send tool was not approved); its substance is in §3, §9, §10 and the file is still at that path.
  3. `memory/workerd-fork-codesign-epipe.md` (reproduced in §12).
  4. apper branch `claude/vid-isolates-no-sandbox-e4t1pj` (local + origin): `docs/plans/vite-in-isolates.md`, `docs/plans/isolate-sandbox-service.md`, `spikes/vite-in-workerd/` — the ORIGIN of the whole project (June 12–17), not in the demo/iso repos.
  5. Gitignored investigation logs in the demo checkout, `~/.iso/`, the built binaries, git state, public GitHub/npm metadata.
- **Consequence for the questions asked:** memory figures and Cloudflare-cloud analysis below are from docs/logs, not from conversation. Anything marked "not found" was looked for and is not on this machine.

## 1. Sessions (from history.jsonl; times local IDT = UTC+3)

| Session id | cwd | Span | Prompts | Role |
|---|---|---|---|---|
| (cloud, author "Claude") | apper branch `claude/vid-isolates-no-sandbox-e4t1pj` | 2026-06-12 → 06-17 | n/a (cloud session, no local history) | Design doc + Phase-0 spike + Vite 8 single-threaded Rolldown + isolate service + `IsolateSandboxProvider` |
| `d9a1dbce-…` | `~/Development/apper` | 2026-06-17 07:19 → 07-03 10:41 | 72 | **"Runtime workstream"**: extract demo repo, npm in workerd, workerd fork, vite/rolldown forks, publishing |
| `607db1c6-…` | tmp `vite-project` | 2026-06-23 | 5 | Checked whether `@netanelgilad/vite` really pulls the single-threaded rolldown fork |
| `4b269dc7-…` | `~/Development/vite-workerd-demo` | 2026-06-25 → 07-02 | 6 | Skeptical audit + README "presentable to the workerd team, Evan You" |
| `820c2c70-…` | `~/Development/vite-workerd-demo` | 2026-06-26 21:13 → 07-03 11:59 | 36 | **"iso workstream"**: Docker-like CLI, host, registry, volumes, networks, productized repo |
| `5bf7f382-…` | `~/Development/vite-workerd-demo` | 2026-07-02 | 4 | Side session (keep Mac awake with lid closed) |

Last prompt of the whole project (2026-07-03 11:59): **"everything pushed? I can work with cloud agents?"** — nothing after that on this Mac. No prompts in `~/Development/iso` at all (the owner intended to continue there with new/cloud agents).

## 2. Timeline

- **2026-06-11/13** (Base44 Community Edition session): first mention — owner asks what runs published apps: "we need a serverless solution… a docker image of a service that has the js built code of apps and then serves them with warm isolated or cold and is a router… it can maybe use workerd, or deno, or bun". Later: "didnt we say we go workerd?"
- **06-12** (apper branch, cloud agent): `docs/plans/vite-in-isolates.md` written; Phase-0 spike: Vite 7.3.5 build + dev server inside self-hosted workerd (miniflare). Same day: Vite 8 solved via single-threaded Rolldown wasm fork; isolate sandbox primitives (just-bash, WS HMR, npm-less installs); service design doc; "production dev-session orchestration (the Durable Object) — implemented, 11/11 green".
- **06-16/17**: CAS persistence model + sync-read ADR; `IsolateSandboxProvider` (Base44 backend client) + review fixes.
- **06-17** (`d9a1dbce`): "extract this to a private repo on my account that demonstrate how we are running a vite 9 app with tailwind on workerd" → `vite-workerd-demo`. Got the app rendering in a browser. Then: "I want to be able to run npm inside workerd… go through npm create vite -> npm install -> vite dev entirely in workerd over a new virtual file system, this is the final goal". Evening: owner proposes Dynamic Workers as the process model and a shared FS below the isolates (§8 quotes).
- **06-18/19**: investigated `node:fs` in Durable Objects ("is the fs still specific to each request?").
- **06-20**: workerd fork started (`feat/shared-tmp-vfs`, `fix/native-fs-async-callbacks`). "don't file issues to the upstream workerd repo… before we file issues to the upstream I need to see the fixes in the forked repo clearly". Later: "leave the whole upstream for now, dont suggest it anymore". Overnight directive: "DO as a real machine - a JS based machine".
- **06-21**: `feat/vfs-module-loading` (VFS-backed module fallback for Worker-Loader children, exports maps, CJS/ESM classification, `import.meta.url`). Forks published to npm under `@netanelgilad`. Install-instability investigation (the SIGKILL story, §5). Owner asks for "workerd-bash".
- **06-22/23**: push for realness — real `npm create vite`, real vite bin, no hardwired `/tmp/proj`. HMR watch primitive. Fork: `file://` specifier resolution.
- **06-25**: audit + README rewrite for the workerd/Vite audience; repo pushed (originally requested as a private repo on 06-17; public today — when it was flipped is not recorded). Owner catches a fake: `npm install` worked without `cd myapp` → "something is lying… you are not running the real npm cli bin".
- **06-26**: base-image idea ("npm is just files, we are missing an apt-get like equivalent?"). Fork: `drainProcess` + `IoContext::runToQuiescence`, `v8.getHeapStatistics` heap limit. **21:13: iso is born** ("what if we had the equivalent of the docker cli for this v8 isolates based machines?"). Client/host split + "isolates cloud" stated 21:45.
- **06-27 → 07-01**: iso M1–M4 (ps, `npm create vite`, fork pinning, `iso dev`); HMR over-claim found and corrected 07-01.
- **07-02** (huge day, both workstreams, lid-closed overnight): fork gets native `child_process.spawn` → sub-isolates (`allowSpawn`), exact in-flight I/O quiescence, native `require.resolve`, VFS re-rooted at `/` with POSIX errors, streaming spawn stdio, cross-isolate in-place writes. iso: interactive exec, `iso.build.mjs` + `iso commit`, kernel/process-table model, rebase onto zero-shim stack, push/pull + registry, registry-on-the-platform capstone, volumes, networks. `@netanelgilad/rolldown@1.0.3-workerd.1` published. iso repo created; **v0.1.0 and v0.1.1 released** (19:24, 19:52 UTC).
- **07-03**: `@netanelgilad/vite@8.0.16-workerd.1`, `@netanelgilad/create-vite@9.1.1-workerd.0` published. iso v0.1.2 (`node -e` silent no-op fix), v0.1.3 (runtime compat field + `iso update`), v0.1.4 (`iso run -it`). "make sure everything is folded into the iso repo… I'll continue working with new agents on that repo". Work stops 11:59.

## 3. Built and proven vs. only attempted

### Proven (with evidence on disk or in repos)
- Vite 7.3.5 `vite build` in workerd: **8/8 dist files byte-identical** to host Node; warm rebuild 1.16 s vs 1.20 s host.
- Vite dev server in workerd (middleware mode): full module graph 200; warm transform 8 ms; edit→invalidate→fresh module 21 ms; cold isolate → dev ready 2.9 s.
- Modern app (tailwind v3 + react-router 7 + tanstack-query 5, 90 modules): 4/4 byte-identical; cold build 5.0 s (host 2.0–2.6 s), warm 1.83 s; dev warmup 4.0–4.7 s.
- **Vite 8 / Rolldown in workerd** via single-threaded Rolldown wasm fork: 8/8 and 4/4 byte-identical, "0 thread spawns". Fork size "rolldown +39 lines, napi-rs single-thread mode, emnapi scheduler, WASI clock" (four patches to upstream).
- npm-less package install (registry tarball → `DecompressionStream` → ustar → memfs): clsx in 85 ms.
- Self-hosted dev-session orchestration (`spikes/vite-in-workerd/service/`, 639 lines): 11/11 tests — affinity, HMR sockets owned by supervisor, idle + RSS-watermark eviction, overlay replay, SIGTERM drain.
- Real npm (Arborist) install inside a DO over shared VFS on the fork: full fork-vite tree, 84 packages / 193 registry requests in ~60–78 s (logs, §5). Staged installs: react+react-dom 3 pkgs 9.7 s; tailwind+autoprefixer+postcss 18 pkgs 10 s.
- Full flow in a DO (create → install → vite dev → browser ToDo app): proven 2026-06-21 (`experiments/npm-in-workerd/do-machine-clean/proof/browser-proof.json`, committed).
- Literal `npm-cli.js` as a `drainProcess` child; native `child_process.spawn` → sub-isolate, recursive (`session→sh→npm run hello→sh -c echo`); streaming stdio; VFS at `/`.
- iso full Docker surface: run/exec/-i/-it, ps, logs -f, images, inspect, cp, commit, build (`iso.build.mjs`), tag/push/pull, standalone registry, port publishing, volumes (checkpoint + snapshots + user drivers), networks (JS policy fn), `iso update`. Registry runs on the platform and can serve its own image. Clean-room "stranger test" passed on v0.1.0→v0.1.1.

### Attempted / partial / known-false
- **Live applied HMR was over-claimed, then corrected.** Transport works (`[vite] hot updated` logged, no reload), edits visible on reload, but the component did NOT re-render: `server.reloadModule(mod)` throws `Cannot read properties of undefined (reading 'environment')` (Vite 8 environments API not wired), and the hand-synthesized js-update lacks react-refresh boundary metadata. Memory says the runtime agent was "currently doing verification on HMR flows" on 07-02 17:20; **no surviving record that applied HMR was finally proven** — verify before claiming.
- PTY: none ("the platform has no PTY; -t ignored, session is line-oriented"). `node:readline` is a no-op stub in workerd.
- `--input-type=module` for `node -e` unsupported; child isolates block eval (CJS materialize-and-require instead).
- Bun-compiled iso binaries: probe started ("miniflare-under-bun is THE unknown"), no result recorded (iso issue #4).
- Linux / x64: nothing built. macOS arm64 only (iso issues #6, #7).
- Upstreaming: deliberately not done. Zero issues/PRs by `netanelgilad` on cloudflare/*, rolldown/*, vitejs/* (GitHub search, 2026-11-10).
- Running on Cloudflare's real cloud: **never attempted** (§6).
- Base44 integration (`IsolateSandboxProvider`): implemented on the apper branch with review fixes; branch last commit 2026-06-17, not merged as far as local git shows (PR state not checkable: gh blocked by org SAML).

## 4. Memory measurements (every figure found)

All on self-hosted workerd on the owner's Mac (arm64), RSS of the workerd process unless stated.

| What | Figure | Source |
|---|---|---|
| Vite 7 build only (esbuild-wasm + @rollup/wasm-node) | **453 MB RSS** | spike README |
| Vite 7 build + dev + dep optimizer | **532 MB RSS** | spike README |
| Attribution | "dominated by the Go-runtime esbuild wasm heap (Go's wasm port reserves aggressively) plus the 15 MB wasm modules and an 8 MB project tree in memfs" | spike README |
| Vite 8 path, after VFS populate | **~250 MB** | isolate-sandbox-service.md |
| Vite 8 path, dev session live | **~450 MB** | same |
| Vite 8 path, after repeated builds | **~900 MB high-water** ("wasm memory never shrinks") → recycle every ~3–4 builds | same |
| Rolldown wasm initial reserve | cut **1 GB → 128 MB** initial (max 4 GB), still 8/8 byte-identical | spike README / service doc |
| `rolldown.wasm` size | **12 MB**, injected as precompiled `CompiledWasm` ("workerd won't runtime-compile a 12 MB module") | rolldown-fork-findings |
| Project tree in memfs | 8 MB (stock app manifest); modern app 1188 files / ~21 MB | spike README |
| Template layer manifest | ~20 MB | service doc |
| iso base image | **15.2 MB** ("images are ~15 MB instead of ~150 MB") | iso README/architecture |
| `process.memoryUsage().rss` inside workerd | **0** (supervisor reads child RSS from `/proc` instead) | service doc |
| `v8.getHeapStatistics().heap_size_limit` | fork reports fixed **2 GiB** (commit 3cebd19; npm needs non-zero) | fork log |
| workerd fork binary | ~300 MB Mach-O arm64 (302 MB release asset) | disk |

Not found anywhere: a per-phase heap number for `npm install` itself, or for vite dev/build under the forked (zero-shim) stack. The 128 MB go/no-go measurement the design doc called "the #1 go/no-go number" was only ever answered as "453–532 MB… needs work before any 128 MB-class hosted variant; drops substantially once Rolldown replaces esbuild" — and the Rolldown path then measured 250/450/900 MB, i.e. **no configuration measured came near 128 MB**.

## 5. The SIGKILL / install-instability investigation (2026-06-21, redone 06-25)

Two distinct causes got conflated; both are real.

**(a) Broken code signature (deterministic).** The fork binary had an invalid signature; macOS kills it (`--version` → exit 137), surfacing as miniflare `write EPIPE` at `mf.ready`. Fix: `cp … /tmp/wd-test.bin && xattr -c && codesign -s - -f`. The iso installer does this "codesign dance" (so `~/.iso/dist/*/workerd-vfs.bin` hashes differ from the source binary). Also orphaned `workerd-vfs` processes wedge runs: `pkill -9 -f workerd-vfs && rm -rf $TMPDIR/miniflare-*`.

**(b) Memory pressure on the host (environmental).** Verbatim from `workerd-bash/proof/session-transcript.json`: "The full @netanelgilad/vite + @netanelgilad/rolldown tree install SIGKILLed the fork workerd within seconds on every attempt (manifests as miniflare 'fetch failed' = workerd connection reset). Reproduced identically on the UNTOUCHED reference do-machine-clean runner. The machine was under heavy memory pressure during this session (swap ~15.7/17GB used, free RAM dipping to 284MB). The same do-machine-clean full flow… was proven working ~2h earlier today." Advice recorded: idle machine with >4 GB free, serial heavy runs, retry. Owner's skepticism at the time (06-21 15:56): "if I run a third workerd instance, it isnt totally decoupled from the others? its a new process, why would I be sigkilled?" — the day's logs show many agents running concurrently (`battery.log`: `[wait_clear] busy=5…6` for 7 minutes before a baseline run could start).

**(c) A genuine fork bug found by the same investigation.** Owner asked (06-21 15:40) for a subagent to decide whether there is "a conceptual problem here with the approach that makes it unstable to run in a v8 isolate, or it's just specific bugs… I cant think of why (in theory) this process shouldnt work". Gitignored logs in `experiments/npm-in-workerd/scratch-investigate/` and `zzz-install-probe/` show:
- Small install (1 dep): always completes in ~1.7–1.9 s (`small-x1..x5`).
- Full install (9 deps): early runs hang — `full-1` TIMEOUT 600 000 ms; `solo-2` stalls at `reqStart=102 reqDone=102` with `inflight=0` forever (metadata phase done, tarball phase never starts); others die with `fetch failed` / "status poll lost worker (20x)" at 0.3–65 s (`c5`, `crashfull`, `vdbg`, `wderr2`).
- After fixes (`rsfix`, `rtfix`, `rel-1..5`, `fin-1..5`): **completes every time**, 84 packages, 193 requests, `inflightMax=91`, 59–78 s wall. Run names + same-day fork commits identify the fixes: `a88a06b fs: async read() must accept null/undefined position` and `0083b54 fs: honor O_TRUNC on open`, plus the 06-20 `writev/readv drop callback when position is undefined` ("Bug B (tar Unpack hang) is a manifestation of Bug A"). Binary of that state: `workerd-readfix.bin` (06-21 16:46). (The mapping of run names to those commits is inferred from timestamps, not a recorded statement.)
- Conclusion as recorded: specific node:fs bugs in workerd, not a conceptual limit. A later "warm-DO npm quirk" was also root-caused and retired on 07-02 (cross-isolate in-place-write assertion + dropped `write(cb)` callbacks).

## 6. Cloudflare's real cloud vs local workerd — everything recorded

**Nothing was ever run on Cloudflare's network.** All work is self-hosted workerd (miniflare) + a fork. What the docs say:

- **128 MB limit**: flagged from day one as risk #1 ("Isolate memory ceiling (Workers: 128 MB class) vs Vite module graph + VFS… the #1 go/no-go number"). Result: "Not a blocker for self-hosting; real work to do before any Cloudflare-hosted variant".
- **CPU limits**: no analysis found for this project. (Unrelated apper commit: "raise user worker CPU limit from 2 to 5 minutes".)
- **Dynamic Workers / Worker Loader** (open beta April 2026): the intended process primitive. Listed open questions, never answered: "max isolate lifetime (dev sessions need minutes–hours), WebSocket support, VFS size caps, pricing at our op volume." Useful confirmed fact from fork C++: "worker-loader inherits caller's outbound… no escape" (egress governance holds for grandchildren).
- **Durable Objects**: the machine = a DO. Stock-workerd facts found: `/tmp` (node:fs VFS) is **per-request** — "Writes vanish between requests"; "an accepted WebSocket is usable only from its creating request context"; "Pending I/O dies with its request context"; ">30s streaming requests trip the hang detector and ABORT THE DO (wipes /tmp)"; miniflare in-memory DO storage loses the registry DO on idle eviction.
- **UnsafeEval**: required (runtime wasm compile, `(0,eval)` in es-module-lexer, `new Function`). It is a local/self-hosted binding; the docs justify it only for self-hosting ("acceptable for a self-hosted build isolate"). No evidence it is available on hosted Workers — treat as a blocker to check.
- **Wasm compile restrictions**: runtime `WebAssembly.compile` / `new WebAssembly.Module` forbidden → rewritten to `UnsafeEval.newWasmModule`, or wasm shipped as a precompiled `CompiledWasm` module (the Rolldown route — this one IS compatible with hosted Workers in principle).
- **Threads**: `worker_threads.Worker` is a stub even with `enable_nodejs_worker_threads_module`; SAB/shared wasm memory/Atomics exist. Hence the single-threaded Rolldown fork.
- **Sync-over-async is impossible in workerd** (ADR): no second thread to park on → no lazy demand-paged FS; eager populate only. Escape hatch noted: `isolated-vm` `applySync` — "a pivot off workerd".
- **Containers**: Cloudflare container sandbox is what Base44 already uses and what this aims to replace; no analysis of running iso on Cloudflare Containers.
- **The hard truth for a hosted variant**: iso depends on a **forked workerd** (48 commits: shared writable VFS across isolates, VFS module loading, `drainProcess`, `allowSpawn`, re-rooted `/`, streaming spawn stdio). None of that exists on Cloudflare's cloud. Hosted mode as designed (iso issue #14, "the north star") means running iso hosts on own infrastructure, not on Workers.
- Security stance recorded: bare isolate "is not by itself a sufficient security boundary for hostile code"; Phase 1 = one workerd process per app + seccomp/netns; self-hosting "transfers the patch-cadence obligation to us".

## 7. What was sent to the Cloudflare team

**Not recoverable from this machine.** Evidence found:
- Prompt 2026-06-25 15:18 (session `4b269dc7`), with three pasted screenshots that no longer exist: "I want to make the repo presentable to the workerd team, Evan you from Vite etc as you can see in the images. I want it to have a clear README that can explain what goes on in the repo and in the demo cohesively… if there are hacks or workarounds, state them clearly". Also: "do not mention anything from my instructions… show dont tell."
- The artifact prepared for them is therefore the **public repo `github.com/netanelgilad/vite-workerd-demo` and its README** (pushed 06-25 ~18:20; public as of 2026-11-10; 1 star; sole collaborator is the owner; no pending invitations). Fork provenance: `netanelgilad/workerd@feat/vfs-module-loading`.
- The screenshots imply an existing conversation with workerd-team people and Evan You, but channel (X, Discord, Slack, email), recipients, message text and any reply are **not on disk**: no draft, no issue, no PR, nothing in history beyond that prompt. Not searched: the owner's Slack, Gmail, X/Discord (outside the scope given). Ask the owner.
- Explicit standing instruction: no upstream issues until the owner says so (§2, 06-20).

## 8. The owner's vision, in their own words

(Spelling normalised for readability; the untouched originals are in `transcripts-digest.md`.)

- Goal (06-17): "go through npm create vite -> npm install -> vite dev entirely in workerd over a new virtual file system, this is the final goal".
- Process model (06-17): "if an isolate can spawn another sub-isolate… then it creates the equivalent of an isolation and maybe resolves all this need for bundling? and if the sub isolates works on the same memfs as its parent… is very similar to a process spawning another process over the same filesystem as in regular linux".
- Kernel metaphor (06-17): "can we move the virtual filesystem solution into some lower level primitive, the isolates orchestrator or something… if the parent wont be the one owning the FS but something more core… does the processes and kernel metaphor still hold here?"
- (06-20): "this would be our ultimate goal! DO as a real machine - a JS based machine."
- (07-01): "what we are basically doing is replacing "node" inside our v8 isolate based sandbox with a dynamic loader new sub-isolate kind of architecture… it doesn't matter what the bin script does, it should all work because what we are doing is shimming "node" with a sub-isolate".
- Realness rule (06-22): "I want as little as possible mocking of these packages. we should run the real stuff, and if needed just create a fork of the thing with the smallest patches… replacing npm create vite with an entirely different script is a no-no". (06-23): "I need you to not workaround anything, I need you to fix primitives that get it to work."
- Process exit (07-02): "no timer based solutions make sense here, it should match the behavior of real node".
- FS (07-02): "I dont want each process that is spawned to get its own isolated fs… the only isolation we care about is from the host, not from in-isolate processes"; "full-OS-faithful-first… real POSIX ENOENT… put everything into the fork".
- iso (06-26): "what if we had the equivalent of the docker cli for this v8 isolates based machines? we create images (basically just tar gz files with the filesystem that is loaded to the VFS of the durable object) and we run images, we can shell into running instances, get logs etc… and it was just not containers, but v8 isolate based machines". "I agree that its wasm-or-bust, we live in a pure js wasm world."
- Isolates cloud (06-26): "a hosted solution that just supplies this "isolates clouds" which are basically just iso hosts, you basically get a subdomain like neta.iso.host or whatever and you have a cloud runtime of sandboxes/DO/machine… you can run stuff on, exec into etc, so the client server separation done by the docker cli is very valuable and important".
- Idiom (07-02): "I want to have equivalent DX to docker and follow same concepts, but not adopt stuff if its not idiomatic for our new runtime/platform… what do you think if isofile was actually a JS file with some initialized SDK for creating the layers".
- Networks (07-02): "control an isolate outbound traffic with a js function, kinda like a proxy fn".
- Product bar (07-02): "the repo should be something that makes this into a real product on-par with docker"; install via `curl | bash`, GitHub releases, binaries.
- Image model (07-03): "the node isnt really part of the image right? it's something much more core than that" → documented as node ≈ kernel, npm = userland.
- Base44 motive (design doc): replace "200 MB containers with 1–12 h lifetimes, snapshot pipelines, warm pools" for vite dev/build with isolates that start in ms.

## 9. Caching / memoization / content-addressed / incremental ideas

From `isolate-sandbox-service.md` (apper branch):
- **"Dependencies: precompute, don't install."** Per template version, CI runs real `npm ci` once, prunes, runs Vite dep optimization, publishes an immutable content-addressed VFS layer mounted read-only by every app isolate; "a pre-warmed Vite optimizeDeps/Rolldown cache".
- **Machine state = its filesystem; persist by CAS, not tarballs.** Blob store `sha256(content) → bytes`, idempotent put; manifest `path → {hash, mode, size}` whose own hash is the snapshot id. Dedup across revisions, across apps, within a snapshot. "Blobs are immutable… nothing downstream ever needs cache invalidation."
- **Dirty-path tracking from the fs shim** → snapshot cost proportional to what changed; "we never re-hash an unchanged node_modules".
- **Three-tier cache**: remote CAS → per-instance local LRU disk cache on the host side ("zero coherency logic", self-warming; "The popular template becomes the warm set organically") → per-isolate memfs. Replaced the earlier "baked template layer".
- **Recorded hot-set** (the lever for heap, not built): "from a prior run we know which files Vite/Rolldown actually read, so the manifest can annotate the working set and we populate only those". "Design the manifest to carry that annotation now even if unused."
- **Build = pure function** `(layer, overlay, mode) → dist`; warm pool of pre-populated build isolates; recycle after K builds or RSS watermark.
- GC cost of dedup: refcount or mark-and-sweep against live manifests.

From iso (memory file / design docs):
- Build graph in `iso.build.mjs`: each chained call is a layer boundary; "hash = parent digest + op descriptor + content hash for copies — Docker's cache model, declared in JS". **Per-step layer cache is a "v2 direction" — not built**; today `iso build` walks the graph and commits a whole-VFS snapshot (no overlayfs diffing).
- Image digest = sha256 of snapshot artifact bytes, so local and registry digests are identical; registry dedupes (`Layer already exists`).
- Volumes: content-addressed history (pinned + last 5), snapshot/rollback.
- Open: tarball byte-reproducibility (iso #9), registry GC + chunked uploads (#12), sandboxed server-side builds (#13).
- No discussion found of memoizing transforms/bundles across apps beyond the above.

## 10. Open problems and stated next steps when work stopped

Owner's last directions (07-03 11:41): fold everything into the iso repo; "are we using the latest workerd fork? is it published correctly?"; make iso a **bun-compiled binary** per arch so install needs no Node; then continue with cloud agents; "try it on a whole new computer".

iso GitHub issues (all OPEN, the backlog the agent wrote for successors): #1 adopt fork gap #2 (process tree in `iso top`); #2 adopt gap #8 (simplify `sh -c`); #3 adopt gap #3 (drop everyone-is-a-drain-child workaround); #4 bun-compiled binaries (spike in progress); #5 prebuilt base rootfs as release asset; #6 CI-built fork binaries; #7 Linux/x64; #8 PTY primitive; #9 tarball reproducibility; #10 persist network logs; #11 release-workflow race; #12 registry GC + chunked uploads; #13 sandboxed server-side builds; #14 hosted mode / iso.host ("the north star").

Other open items from the memory log: applied HMR unproven (§3); fork gaps still open — #5 package-file pre-own, #10 http body pump ~10 ms/chunk (20 MB = ~50 s unless re-chunked to 1 MB), #11 hang detector aborts DO on >30 s streams, #12 piped `node:http` responses truncate at 64 KB, #13 rename-onto-existing throws, #15 bind mounts, #16 stdin child `process.exit` doesn't quiesce (~40 s), #17 `readdir("/")` leaks `bundle/`, #18 slow governed egress can drain-quiesce before the 502; failed `iso run` leaks its port allocation (fix was dispatched; outcome unrecorded); registry DO not durable in miniflare; release assets uploaded by hand from this Mac; LICENSE MIT "(assumed)".

Lessons the agent recorded for itself: "subagent proof claims need independent re-verification"; "automated walkthroughs… missed run -it… the USER found it instantly by typing what a human types first"; "check the fork's latest work before building JS plumbing".

## 11. Local checkouts, binaries, git state (2026-11-10)

| Path | Branch @ HEAD | Remote state |
|---|---|---|
| `~/Development/iso` | `main` @ `fca5f15` | clean, == origin/main. Public, releases v0.1.0–v0.1.4 |
| `~/Development/vite-workerd-demo` | `main` @ `80d9f35` | clean, == origin/main. Public |
| `~/Development/workerd` | `feat/vfs-module-loading` @ `366e8a8` (48 commits over upstream `main` c2ff0e1 "Release 2026-06-20") | **pushed** (ls-remote: origin has 366e8a8). No local tracking config. Local-only branch names `feat/gaps-2-8`, `feat/gaps-3-4`, `feat/xisolate-write`, `spike/vfs-root-mount` are all contained in it. `validate/combined` has 2 unpushed commits (a merge + `836e7ac`, superseded) |
| `~/Development/workerd-vfs` | `feat/shared-tmp-vfs` @ `b938f12` | older second clone of the fork (06-20/21); origin's branch is at `1640fb9` (newer, from the other clone). Stale; ignore |
| `~/Development/rolldown` | `workerd` @ `37486bbad` | clean, == origin/workerd (`netanelgilad/rolldown`; upstream remote = rolldown/rolldown) |
| `~/Development/vite` | `workerd-create-vite` @ `97decc9` | pushed (origin has `workerd` 1c9ac8c and `workerd-create-vite` 97decc9). Untracked: `packages/create-vite/netanelgilad-create-vite-9.1.1-workerd.0.tgz` |
| `~/Development/apper` | branch `claude/vid-isolates-no-sandbox-e4t1pj` @ `e3e4ef3b2c2` (2026-06-17) | exists on origin; holds `docs/plans/*`, `spikes/vite-in-workerd/`, `backend/app/user_apps/sandbox/providers/isolate/` |

No stashes anywhere. npm: `@netanelgilad/vite` 8.0.16-workerd.0/.1; `@netanelgilad/rolldown` 1.0.3-workerd.0/.1; `@netanelgilad/create-vite` 9.1.1-workerd.0.

Binaries in `~/Development/` (all Mach-O arm64, ~300 MB; sha256 prefix; mtime):
- `workerd-vfs.bin` = `workerd-gaps28.bin` — `e01ebcc46de0`, 07-02 21:11. **Canonical**: built from fork HEAD 366e8a8; equals the v0.1.x release asset `workerd-vfs-darwin-arm64.bin`.
- `workerd-gaps34.bin` = `workerd-xwrite.bin` — `7b61f4b8754c` (07-02 19:33/20:45)
- `workerd-spawn-stdio.bin` — `c30f5022274f` (07-02 18:29; fork 83df466, re-root + POSIX + spawn-stdio)
- `workerd-rootfs.bin` `161e46a272bd` (15:22) · `workerd-quiesce.bin` `c93d40c92b86` (12:51) · `workerd-spawn.bin` `4aa16ee0c15d` (12:09) · `workerd-drainproc.bin` `ca18e2b6b90b` (10:25)
- `workerd-stable.bin` `444dcb9c21a8` (06-26) · `workerd-readfix.bin` `c661f08695f7` (06-21)
- Installed: `~/.iso/dist/{v0.1.1,v0.1.3,v0.1.4,current}/workerd-vfs.bin` — `a9fabca92af5` (ad-hoc re-signed copy).
- Bazel output: `~/Development/workerd/bazel-bin/src/workerd/server/workerd` (darwin_arm64-fastbuild).
- **No Linux build exists** (only upstream's empty `npm/workerd-linux-*` package dirs). A cloud/Linux session must build the fork itself with Bazel from `netanelgilad/workerd@feat/vfs-module-loading`.
- `~/.iso/`: state.json (context `local` → `http://127.0.0.1:8787`, `repoPath` still pointing at vite-workerd-demo), 22 image blobs, host.log (last write 07-03 11:45), `~/Development/iso/dist-release/iso-v0.1.4.tar.gz`.

## 12. Notes / memory files

- `memory/MEMORY.md` — index of the two files below.
- `memory/workerd-fork-codesign-epipe.md` (2026-06-26): "The forked workerd binary… has an invalid/broken code signature on this macOS machine. The kernel SIGKILLs it (`--version` → exit 137), which surfaces deep in miniflare as `write EPIPE` at `mf.ready` — a misleading error that looks like a networking bug." Workarounds: ad-hoc re-sign a copy and point `MINIFLARE_WORKERD_PATH` at it; or front `mf.dispatchFetch` with a plain Node `http` listener ("the fork crashes host/port mode regardless of signing").
- `memory/iso-cli-design.md` — not relayed verbatim; summarised in §3, §9, §10. Note it is written newest-first within the body and contains superseded sections (programmatic npm, `__ISOLATE_SPAWN` RPC syscall, `/tmp`-rooted VFS) explicitly marked historical.
- No uncommitted NOTES/HANDOFF/TODO/plan markdown in any checkout (all clean). The plan docs live only on the apper branch: `docs/plans/vite-in-isolates.md` (331 lines), `docs/plans/isolate-sandbox-service.md` (452 lines), `spikes/vite-in-workerd/README.md` (255 lines). Copies: `~/iso-revival-context/work/`.
