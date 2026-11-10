# Revival context — Vite on Cloudflare's cloud in 128 MB, with a global build cache

Working notes for the agent reviving this project (started 2026-11-10). Read this first after a
context reset. Facts are marked **[verified]** (read in a repo or in Cloudflare docs on
2026-11-10) or **[unverified]** (inference, must be tested before relying on it).

## The ask (owner's words, condensed)

1. Get **Vite running inside Cloudflare Workers on Cloudflare's real cloud** (not local workerd).
2. Solve the **threading** issue there.
3. Make a Vite build fit the **128 MB** isolate memory limit.
4. Lean heavily on **caching between code changes**: "a single character change in the source
   should become a single character change in the build output"; a **content-addressable
   distributed cache**; **never compile the same piece of code more than once across all users**.

## Where everything lives

| Thing | Location | Notes |
|---|---|---|
| iso (product repo, this one) | `netanelgilad/iso`, v0.1.4 | Docker-like CLI for V8-isolate machines; needs the workerd fork |
| Research spike + everything sent to Cloudflare | `netanelgilad/vite-workerd-demo` (public) | README is the main writeup; `docs/rolldown-fork-findings.md`; `harness/` |
| workerd fork | `netanelgilad/workerd` @ `feat/vfs-module-loading`, binary from `366e8a8` | darwin-arm64 binary only is published (iso release asset) |
| Rolldown fork | npm `@netanelgilad/rolldown@1.0.3-workerd.1`; patches in demo `harness/rolldown-fork/patches/` | single-threaded `wasm32-wasip1`, 12.5 MB wasm |
| Vite fork | npm `@netanelgilad/vite@8.0.16-workerd.1`; recipe in demo `harness/vite-fork/BUILD.md` | esbuild → esbuild-wasm shim, code-gen rewrites baked in |
| GitHub forks | `netanelgilad/vite`, `netanelgilad/rolldown` | last pushed 2026-07-02/03 |
| Old transcripts | owner's Mac (`~/.claude/projects`), being collected into `~/iso-revival-context/` by session `session_01DxaWH7FobUdxRJ98S8ifQM` | summary to be appended below |

Work branch in every repo: `claude/ecstatic-thompson-esm17j`. This session has push access to
`iso` only; `vite-workerd-demo` is cloned read-only at `/home/user/vite-workerd-demo`.

## What was already proven (July 2026) [verified from the demo README]

- **Layer 1, stock workerd:** `vite build` and `vite dev` (Vite 8, Rolldown, Tailwind 3, React
  Router, React Query, ~90 modules) run inside one isolate. Build output is **byte-identical** to
  host Node. Warm rebuild ~370 ms (react-ts) / ~840 ms (modern app).
- **Layer 2, stock workerd:** real `@npmcli/arborist` install from the live registry into memfs.
- **Layer 3, forked workerd:** a Durable Object does `npm install` → `vite build`/`dev` from
  `/tmp` in Worker-Loader sub-isolates; `npm create vite` → live HMR in a browser.
- **Threading is already solved locally:** Rolldown runs with zero threads through a cooperative
  tokio pump (`pump_async_runtime`, driven from JS), with a guard that throws on thread spawn.
  esbuild runs as `esbuild-wasm` with `worker:false`.

## What the local demo relies on that Cloudflare's cloud does not have

| Local crutch | Why it is used | Cloud replacement |
|---|---|---|
| `unsafeEvalBinding` (`newWasmModule`, `eval`, `newFunction`) | runtime wasm compile and code generation are forbidden in workerd | **Dynamic Workers** (`env.LOADER.load/get`): `modules` accepts JS/CJS strings and `{wasm: ArrayBuffer}` **[verified in docs]**. Statically import wasm in the deployed Worker where possible |
| `unsafeModuleFallbackService` (host resolves every import) | module resolution from `node_modules` | pre-bundle Vite + plugins into the Worker; user config/plugins become a Dynamic Worker `modules` map (that map *is* a virtual module filesystem) |
| forked workerd (VFS loader, `shareParentTmp`, spawn) | Layer 3 only | not available in the cloud, so the cloud design must be Layer-1-shaped, not Layer-3-shaped |
| host process (manifest, file watcher) | ships files in, watches disk | R2/KV/DO storage + our own content-addressed fs shim |

## Cloudflare limits that shape the design [verified 2026-11-10]

- **128 MB per isolate**, JS heap + wasm together. On overflow: in-flight requests finish, new
  isolate started, error 1102 / `exceededMemory`.
- CPU: paid default 30 s, configurable up to **5 min** per invocation. Startup (global scope) 1 s.
- Worker size: 64 MiB uncompressed.
- Dynamic Workers: **Workers Paid only**; billed per unique worker/day + requests + CPU ms.
  Concurrency: **4** distinct in-flight Dynamic Workers per Worker request, **10** from a Durable
  Object. `get(id, cb)` caches a warm isolate by id.
- `@cloudflare/worker-bundler` exists and bundles TypeScript + npm deps **inside a Worker**:
  precedent that Cloudflare itself runs a bundler in an isolate. Read its source before building.
- **[unverified]** each Dynamic Worker is its own isolate with its own 128 MB. If true, splitting
  the build across isolates multiplies the memory budget. Test this first on the real cloud.
- **[unverified]** whether a Dynamic Worker can hold its own loader binding (nesting).

## Design thesis

Memory and time have the same root cause: the bundler re-reads and re-processes code whose result
is already known. Fix the caching and the 128 MB problem mostly disappears.

**Memory side (128 MB)**
1. Measure first: peak heap of Layer 1 split into Rolldown wasm memory, esbuild-wasm (Go
   runtime), Vite JS heap, memfs contents. No number exists yet in the repos; the README only says
   RSS "ratchets up" and can SIGKILL workerd.
2. **Never put `node_modules` in the isolate.** No `npm install` at build time; resolve against
   cached registry metadata and fetch file contents lazily by hash.
3. **Take dependencies out of the bundler.** Each `package@version` is immutable, so pre-bundle it
   once globally and treat it as external. Rolldown then only sees user code (tens to hundreds of
   small modules), which is small in both memory and time.
4. Drop esbuild-wasm if Vite 8 can do everything through Rolldown/Oxc (check; the Go wasm runtime
   is a large fixed cost).
5. Split across isolates (orchestrator Durable Object + Rolldown isolate + CSS isolate) and
   recycle isolates, since wasm memory never shrinks.
6. Stream outputs to storage; never buffer the whole `dist`.

**Threading side:** keep the single-threaded pump. Parallelism in the cloud comes from fanning
per-module work out to several isolates, not from threads.

**Caching side (content-addressed, global across users)**
- L0 whole build: `hash(source tree + lockfile + config + toolchain version)` → dist manifest.
- L1 dependency: `package@version` (+ resolution closure) → pre-bundled ESM chunk. Stable hashed
  URL, so browsers share it across deploys and apps too.
- L2 module transform: `hash(source bytes + transform pipeline id + relevant config)` →
  transformed code, import list, sourcemap. A Vite plugin wrapping `load`/`transform`.
- L3 Tailwind/CSS (the non-local step): per file → candidate class set (cached by file hash);
  class → CSS rule (cached by Tailwind config hash); final CSS = ordered union. A one-character
  edit re-scans one file and usually yields identical CSS.
- L4 linking: the step that turns a local edit into a global rewrite, because content hashes
  cascade through importers. Two output modes:
  - **fast tier:** unbundled user modules at content-addressed URLs + an **import map**, vendor
    chunks from L1. One edit → one module file + one import-map entry. This is the literal
    "one character in, one character out" result.
  - **optimized tier:** full Rolldown bundle (tree-shaking, scope hoisting) produced in the
    background and swapped in when ready, like JIT tiers.
- Correctness rule: a cache key must contain everything the output depends on (plugin versions,
  config, env/define values, target). Verify with the existing byte-compare harness
  (`verify:build`) against an uncached build. Poisoning risk: only trusted builders may write
  shared entries; untrusted plugin output must be keyed per tenant.

## Measurements (2026-11-10)

### Local baseline: Layer 1 on stock workerd, Linux x64, demo `app/` (74 modules, 270 kB JS out)

`verify:build` passes here: 4/4 files byte-identical to host Node. Cold build ~2.8 s, warm ~0.45–0.7 s.

| What | Value | How measured |
|---|---|---|
| workerd process RSS | 79 MB boot → ~650–710 MB after build 1 → ~850–900 MB peak after build 2 | `/proc/<pid>/status` |
| JS heap used (after GC) | 63–66 MB after build 1, **~47–49 MB** steady | inspector `Runtime.getHeapUsage` |
| ArrayBuffer backing store | 51–68 MB, of which **36 MB is `node_modules` in memfs** (1188 files) | same + walking memfs |
| Rolldown wasm memory, as shipped | **152–155 MB** (created with `initial: 2048` pages = 128 MB, then grows) | `memory.buffer.byteLength` |
| Rolldown wasm, started at its declared minimum (1005 pages = 63 MB) | 87 → 90 MB over 3 builds, i.e. **+24–27 MB** of real working memory | same |
| Same, with all bare-specifier deps `external` | 65.3 → 65.9 MB, i.e. **~3 MB** of working memory | same |

Countable against the 128 MB limit today: ~48 (JS) + ~52–68 (buffers) + ~155 (wasm) ≈ **270–290 MB**.

Reading: (1) the 128 MB wasm `initial` in `rolldown-binding.wasi-browser.js` is an arbitrary
loader constant; (2) the 63 MB declared minimum is a link-time setting of the wasm build, not real
data — rebuild with a small initial memory; (3) copying `node_modules` into the isolate costs
36 MB; (4) bundling dependencies costs Rolldown ~25 MB, user code alone ~3 MB.
Projection if 1–3 are fixed: ~48 JS + ~15 buffers + ~10–35 wasm ≈ **75–100 MB**, even with full
production bundling of dependencies. First-build JS peak (63–92 MB before GC settles) is the
remaining risk. **[unverified until rebuilt and rerun]**

Local instrumentation (uncommitted edits in `/home/user/vite-workerd-demo/harness`): `INSPECT`
env → inspector port in `host.mjs`; `/mem` route and `?external=1` on `/build` in
`worker/driver.mjs`; scripts in the session scratchpad `measure/heap.mjs`, `measure/mem.mjs`.
Gotcha: Node `fetch` to the inspector fails in this container; use the `ws` package directly on
`ws://127.0.0.1:<port>/core:user:`.

### Real Cloudflare cloud: probe worker `iso-vite-probe-limits` (Base44 account, workers.dev)

Source in the session scratchpad `wr/probe/`; routes are behind a random path token. Delete it when done.

| Question | Result |
|---|---|
| `eval` / `new Function` | **disallowed** in both the static Worker and a Dynamic Worker (`EvalError: Code generation from strings disallowed`) |
| `WebAssembly.compile` / `new WebAssembly.Module` at runtime | **disallowed** in both (`Wasm code generation disallowed by embedder`) |
| wasm passed as `{wasm: ArrayBuffer}` in a Dynamic Worker's `modules` | **works** (`import wasm from "./tiny.wasm"` is a `WebAssembly.Module`) |
| `import("data:...")` | no such module |
| `import.meta.url` in a Dynamic Worker | `undefined` |
| `node:fs` writes to `/tmp` | work (root shows `bundle,tmp,dev`); persistence across requests not tested |
| `WebAssembly.Memory({initial: 2048})` (128 MB reserve) | succeeds; shared memory constructs too |
| Does a Dynamic Worker inherit the loader binding | no (`env.LOADER` absent unless passed) — passing it explicitly not tested |
| Separate memory budget per isolate | parent holding 100 MB while two Dynamic Workers each filled 200 MB concurrently: all succeeded → budgets are **per isolate** |
| Where the limit actually bites | filling in 16 MB steps: stream cut after **240 MB** of buffers; `Memory.grow` failed at **256 MB**. A single 150 MB typed array throws `RangeError`. Enforcement is lazy and far above 128 MB in short bursts. Do **not** design against this slack; treat 128 MB as the budget |

Consequences: every piece of runtime code generation in Vite and its plugins (config loading,
`new Function` in deps, wasm instantiation) must go through `env.LOADER` or be pre-bundled as a
static module. "Any Vite plugin" therefore means: plugin code is loaded as Dynamic Worker modules.

## Owner decisions (2026-11-10)

- Scope: **any Vite project and plugin, as far as possible** (not just the Base44 template stack).
- The unbundled import-map output is **not acceptable for production deploys**. Production must be
  a real bundle, so incremental/cached *bundling* is the problem to solve; import maps stay at most
  a dev/preview aid.
- Cloudflare access: wrangler OAuth login done in this container against the **Base44** account
  (token in `~/.config/.wrangler`, dies with the container). Only create `iso-vite-probe-*` workers.

## Plan

0. ~~Baseline~~ done, see Measurements.
1. Cloud port of Layer 1 without `UnsafeEval` and without the fallback service: Vite + Rolldown
   wasm as modules of a Dynamic Worker (or a static Worker), files from a content-addressed store
   instead of memfs-from-host; deploy and record what breaks. Shrink Rolldown's initial memory.
2. Dependency externalization + L1 cache (R2/KV). Re-measure memory.
3. L2 transform cache as a Vite plugin; L3 Tailwind decomposition.
4. Import-map output mode; whole-build memo; then the optimized tier.

## Recovered history from the Mac (2026-11-10)

Full text: [`mac-history-summary.md`](mac-history-summary.md) (written by a session on the owner's
Mac; the files also sit in `~/iso-revival-context/` there, including all 127 owner prompts verbatim).
What matters for this revival:

- **The Claude Code transcripts are gone.** Only the owner's typed prompts (`~/.claude/history.jsonl`)
  and the old agent's memory file (`memory/iso-cli-design.md`, 24 KB, not relayed) survive.
- **What was sent to the Cloudflare team is not on the Mac.** The prepared artifact is the public
  `vite-workerd-demo` README (2026-06-25), written for "the workerd team, Evan You from Vite etc".
  Channel, recipients and any reply are unknown — ask the owner. Standing instruction from then:
  no upstream issues until the owner says so.
- **Origin of the project** is an apper branch, `claude/vid-isolates-no-sandbox-e4t1pj`:
  `docs/plans/vite-in-isolates.md`, `docs/plans/isolate-sandbox-service.md`, `spikes/vite-in-workerd/`.
  The service doc already holds a CAS design (blob store + manifest, three-tier cache, "precompute,
  don't install", recorded hot-set, build as a pure function). Read it before designing the cache.
- **Nothing was ever run on Cloudflare's network** before today. 128 MB was flagged as "the #1
  go/no-go number" and never met: older figures were 453–532 MB RSS (Vite 7) and 250/450/900 MB
  (Vite 8), all process RSS on the Mac.
- **Sync-over-async is impossible in workerd** (old ADR): no second thread to park on, so no lazy
  demand-paged filesystem behind sync `fs` calls. A content-addressed fs must be populated eagerly
  from a known file set (the "recorded hot-set" idea), or reads must be made async.
- Owner's realness rule: run the real tools, smallest possible patches, fix primitives instead of
  working around them; no timer-based hacks.
- Where work stopped (2026-07-03): fold everything into iso, bun-compiled binaries, Linux build;
  iso issues #1–#14 are the backlog, #14 (hosted mode / iso.host) is "the north star".
