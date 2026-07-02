# iso Networks — "the network is a JS function"

> Companion to `design.md`. Status: **✅ implemented (with notes)**. All four
> scoping decisions below were RESOLVED and are live; the proof ladder ran green
> (see `the README` §NETWORKS). Notes on what deviates from the
> sketch and the one fork-gap it surfaced are in "Implementation reality" below.

## The idea

Docker networking is plumbing you *configure* (bridges, iptables, embedded
DNS, CNI plugins). On this platform every byte a machine sends already
transits one seam — `globalOutbound`, a fetch handler — so a network can be
behavior you *write*. Same move as `iso.build.mjs` vs Dockerfile: keep the
docker concept, express it in the platform's native language.

```js
// appnet.network.mjs
import { network } from "iso-sdk";

export default network({
  proxy: async (request, ctx) => {
    // ctx.from  = { machine, name }          — who is calling
    // ctx.to    = { host, port }             — parsed destination
    // ctx.route = (name, req) => Response    — deliver to a member machine
    if (ctx.to.host === "db") return ctx.route("db", request);        // service discovery
    if (ctx.to.host.endsWith("npmjs.org")) return fetch(request);      // allowed egress
    if (ctx.to.host === "api.internal") {                              // L7 rewrite
      return fetch("https://api.prod.example.com" + new URL(request.url).pathname,
        new Request(request, { headers: withAuth(request) }));
    }
    return new Response("blocked by appnet policy", { status: 403 });  // default deny
  },
});
```

What the fn model buys that Docker needs a service mesh for: allow/deny,
rewriting, header/auth injection, canary routing, per-network observability
(`iso network logs` = every fetch the policy saw), rate limiting, and
mock-the-internet-for-tests. Policies are ordinary modules → composable and
shareable as npm packages (`import { corporateEgress } from "@iso/policies"`),
the same recipe idiom as the build SDK.

## Docker-parity floor (works with NO policy fn)

```
iso network create appnet [--policy ./appnet.network.mjs]
iso network ls | rm | inspect
iso run --network appnet --name db -p … image
iso network connect|disconnect appnet <machine>     (v1.1)
```

- Members resolve each other by machine name: `http://db:5000/…` from any
  member routes into machine `db`'s serving child at port 5000 (EXPOSE'd).
  Host-header routing — no DNS, no NAT.
- Cross-network names don't resolve: isolation by construction.
- No policy fn ⇒ default behavior: resolve members, allow internet egress.
- A machine not on any network keeps today's behavior (direct egress).

## Decisions (RESOLVED by user, 2026-07-03)

1. **Scope: the policy governs ALL egress** — machine-to-machine AND internet.
   One mental model, and the headline capability. (Rejected: Docker-style
   split where egress is ungoverned.)
2. **Execution: SANDBOXED ISOLATE FROM DAY ONE** (user overrode the
   host-process-v1 default). The policy module never loads into the daemon —
   it runs in its own isolate on the platform, recursively: the network policy
   is itself isolate-hosted. Mechanism:
   - The policy module is loaded into a dedicated **policy isolate** per
     network (Worker-Loader child); its fetch handler IS the proxy fn —
     requests arrive with `ctx` metadata (from-machine, parsed destination).
   - Capabilities are explicit: the policy isolate's own `globalOutbound` is
     real egress (that's how `fetch(request)` in a policy allows traffic), and
     `ctx.route(name, req)` is a service-binding capability back to the
     control plane that delivers into a member machine. No ambient fs, no
     daemon access.
   - Local and hosted mode are therefore THE SAME execution model — no v2
     migration, no trust-boundary rewrite later.
   - This "user-JS-in-a-sandboxed-isolate, invoked via RPC/fetch" mechanism is
     a platform building block shared with volume drivers
     (`volumes.md`): **user-supplied JS runs on the platform, never in
     the daemon.**

## Implementation notes (the seams exist)

- Children's outbound already flows through `globalOutbound` → the control
  plane (the M2-era pass-through seam). Add: look up the caller's machine →
  its network → invoke policy (or default) → `ctx.route` delivers via the
  existing `/port-proxy` path into the target machine's serving child.
- Caller identity: the machine's children get their outbound bound to the
  machine id (the DO knows which machine every child belongs to).
- Registry of networks: host-side store (`~/.iso/networks/…`), records
  {name, policyPath?, members}. `ps`/`inspect` gain network fields.
- HTTP(S)-only v1 — that mostly *is* the platform; workerd's TCP socket API
  is the noted extension path for raw TCP later.
- Perf note: policy adds one function call on the existing proxy path — the
  fork-gap #10/#11 streaming mitigations apply unchanged.

## Proof plan (when implemented)

1. `iso network create appnet && iso run -d --network appnet --name reg registry`
   → another member pulls `http://reg:5000/...` **by name, no published
   ports** — the machine-to-machine registry pull.
2. A deny policy blocks `fetch("https://example.com")` from a member with 403;
   an allow-list admits npmjs.org (real `npm install` still works through it).
3. A rewrite policy proxies `api.internal` → a real host with an injected
   header, verified end-to-end.
4. `iso network logs appnet` shows the fetches the policy saw.

## Implementation reality (what landed, 2026-07-02)

The seams were exactly where the design said. Concretely:

- **Interception point.** A networked machine's `Machine` DO passes its OWN
  stub as each child's `globalOutbound` (`childCfg(probeSrc, this.childOutbound())`).
  Every child fetch lands on the DO's `fetch` (machine ops always use
  `http://m/...`, so anything else is egress); the DO stamps `x-iso-net-from:
  <machineId>` and forwards to `SELF` (the control plane). `control-plane.mjs`
  checks the egress headers FIRST and calls `governEgress()`
  (`worker/network-egress.mjs`).
- **Grandchild egress — PROBED, no leak.** Native-spawned grandchildren
  (`sh` → `node`, npm's workers) are loaded WITHOUT an explicit `globalOutbound`,
  and workerd's worker-loader then *inherits the calling worker's outbound
  channel* (`worker-loader.c++`: "Inherit the calling worker's global outbound").
  So a grandchild's `fetch` transits the SAME governor as its parent — verified
  live (`sh -c "node fetch-url.mjs http://reg:5000/..."` was logged and routed).
  There is no policy-escape hole through native spawn.
- **Policy isolate.** Per network, cached by `(name, createdAt)` LOADER key — the
  module is compiled once, not per request. It reuses the volume-driver sandbox
  posture (no `shareParentTmp`, no fs flag, no `vfsModuleFallback`, no
  `allowSpawn`, no LOADER). Its ONE capability is egress, and even that is
  `globalOutbound: SELF` behind a `fetch`-shadow that tags every request with the
  network token — so policy traffic is logged, the engine API is fenced off
  (a hostile policy calling `http://127.0.0.1:8787/v0/...` gets 403), and
  `ctx.route`/`ctx.state` are real capabilities, not ambient authority.
- **`ctx.state` shipped** (experimental): a tiny per-network KV
  (`get`/`set`) reached only through the tagged callback channel → host store
  `~/.iso/networks/<name>/state.json`. Proven with a rate-limit policy.
- **Deviations from the sketch.** (1) The policy exports `{ proxy }` (the doc's
  `network({ proxy })` SDK wrapper is sugar we didn't need — a bare object works
  and is one less import). (2) Name-resolution targets must `EXPOSE` their port
  (the image manifest's port) so the member stays a live serving child; a plain
  networked command with no server exits normally. (3) `iso network logs` is an
  in-memory ring (500 entries) — matches LogStream; not persisted across host
  restart (documented). (4) One fork gap surfaced: a child whose ONLY pending
  work is a *slow-failing* governed egress (unresolvable bare hostname) can be
  declared drain-quiescent before the 502 returns — the governor's log stays
  authoritative, but the in-machine client sees empty output. Captured as
  `docs/fork-gaps.md` #18. Fast egress (success / conn-refused / policy deny)
  round-trips fully.

## Open questions (status)

- Multiple networks per machine (docker allows) — **v1: one** (enforced), revisit.
- Policy versioning/reload — **v1: `iso network rm` + recreate** (a fresh
  `createdAt` mints a fresh isolate key). No hot `--policy` update yet.
- `ctx.state` per-network KV — **✅ shipped, experimental** (small, host-backed).
