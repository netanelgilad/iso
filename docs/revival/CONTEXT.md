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

## Plan

0. Baseline: run Layer 1 here on stock workerd (Linux), record peak memory per component.
   **Blocked:** `npm ci` in the demo checkout was denied by the session's permission classifier.
1. Cloud port of Layer 1 without `UnsafeEval` and without the fallback service; deploy to a real
   Cloudflare account; record what breaks. Needs a Cloudflare account/API token from the owner.
2. Dependency externalization + L1 cache (R2/KV). Re-measure memory.
3. L2 transform cache as a Vite plugin; L3 Tailwind decomposition.
4. Import-map output mode; whole-build memo; then the optimized tier.

## Open questions for the owner

- Cloudflare account + API token for deploys (Workers Paid, Dynamic Workers enabled)?
- Is "real Vite, unmodified plugin API" a hard requirement, or is "Vite-compatible output for the
  Base44 template stack" enough for the first milestone? It decides how much arbitrary plugin
  code must run in the isolate.
- Is the fast (import map, unbundled) output acceptable for production deploys, or preview only?

## Recovered history from the Mac transcripts

_(pending — to be filled from `~/iso-revival-context/SUMMARY.md`)_
