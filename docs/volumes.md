# iso Volumes — checkpointed, driver-backed, versioned

> Companion to `design.md`. Status: **✅ implemented** (`packages/`,
> checkpoint semantics). Closes `design.md` open question #0 — the registry
> machine's data now survives its machine via a `-v regdata:/data` volume
> (proof transcript in `the README` §Volumes). The live-mount
> upgrade (bind mounts) remains fork-gap #15.

## Docker-parity floor

```
iso volume create regdata [--driver <module>]
iso volume ls | rm | inspect
iso run -v regdata:/tmp/registry-data image        (repeatable)
iso volume sync <name>                              (explicit checkpoint)
iso volume snapshot <name> | rollback <name>@<digest>
```

## Semantics v1: CHECKPOINT, honestly labeled

A volume is a named persistent tree owned by the host (`~/.iso/volumes/<name>/`
by default). Machine boot **copies in** the tree at the mount path; graceful
stop/`rm` (and explicit `iso volume sync`) **copy out**. This is *checkpoint*
semantics, not a live mount — a crashed or evicted machine loses writes since
the last checkpoint. Shipped labeled as such; no pretending.

- Attach policy v1: **exclusive** — one running machine per volume (Docker has
  the same shared-write hazards; we refuse instead of corrupting).
- Copy-out excludes the same ephemera the image snapshot excludes.

### The upgrade path is a fork primitive: bind mounts

The machine's `/tmp` is *already* a host directory the fork maps into the VFS
(the shared-`/tmp` design). A **bind mount** — "map host dir X at VFS path Y
for this DO" — is the same mechanism pointed at a second directory. When the
fork lands it, volumes silently upgrade from checkpoint to live-mount semantics
with the same CLI. → Captured as a P1 ask in `fork-gaps.md` (#15).

## JS-native twists (RESOLVED by user, 2026-07-03: both in v1)

3. **Driver interface in v1.** Docker's volume plugins are Go binaries behind
   a socket; ours is a JS module implementing a tiny interface. Because v1 is
   checkpoint semantics anyway, drivers are nearly free — copy-in/copy-out
   calls the driver instead of the local dir.

   **Execution rule (mirrors the networks decision):** the built-in `local`
   driver is trusted platform code and runs in the daemon; **user driver
   modules run SANDBOXED in an isolate on the platform** — same
   user-JS-isolate mechanism as network policies (`networks.md` §2),
   invoked at checkpoint boundaries (tarIn/tarOut over RPC). User JS never
   loads into the daemon.

   ```js
   // iso volume driver interface (v1)
   export default volumeDriver({
     // EITHER granular:
     list(),            // → [{path, size, mtime}]
     read(path),        // → bytes
     write(path, bytes),
     delete(path),
     // OR bulk (simpler drivers implement just these):
     tarOut(),          // → tar bytes of the whole tree   (checkpoint source)
     tarIn(tarBytes),   // ← replace tree                   (checkpoint sink)
   });
   ```

   `local` is just the default driver. Ship ONE non-local demo driver to prove
   the sandboxed-user-driver seam (candidates: a plain HTTP tarIn/tarOut
   driver against any endpoint, or — pleasingly circular — checkpoints stored
   as blobs in an iso registry; implementer's choice, must run sandboxed).

4. **Snapshot-lite versioning in v1.** Every checkpoint is content-addressed
   (we have the machinery — same digests as images). Volumes therefore get
   *history* nearly free: `iso volume snapshot data` pins the current
   checkpoint; `iso volume rollback data@sha256:…` restores it;
   `iso volume inspect` lists history. Retention: keep pinned snapshots + last
   N automatic checkpoints (N small, configurable). Docker doesn't have this.

## Implementation notes

- Store layout: `~/.iso/volumes/<name>/{volume.json, live/, snapshots/sha256-…}`
  — volume.json: {name, driver, mounts?, history[]}.
- Machine DO already has the snapshot/materialize machinery (boot manifest
  write-in, `/snapshot` walk-out); volumes reuse both, scoped to the mount
  path.
- `iso ps`/`inspect` show mounts; `rm` of a machine with a volume checkpoint-
  syncs first (graceful path).
- Registry proof plan: `iso run -d --name reg -p 5055:5000 -v regdata:/tmp/registry-data registry`
  → push images → `iso rm reg` → run a NEW registry machine with the same
  volume → the pushed images are still there (`/v0/repos` non-empty, pull
  works). That closes design question #0.

## Open questions

- Anonymous volumes (`-v /path` with generated name) — v1: named only.
- Volume size limits / quota — deferred.
- Checkpoint cadence beyond stop/sync (periodic timer?) — deferred until the
  bind-mount primitive makes it moot or someone hits it.
