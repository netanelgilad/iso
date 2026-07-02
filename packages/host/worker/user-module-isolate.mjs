// USER-MODULE ISOLATE — the platform's reusable "user-supplied JS runs SANDBOXED on the
// platform, never in the daemon" mechanism (shared by volume drivers today and network policies
// next; see docs/iso-volumes.md §3 and docs/iso-networks.md §2).
//
// The user's module SOURCE is inlined into a dedicated Worker-Loader child with NO ambient
// authority:
//   - no shareParentTmp        → it cannot see any machine's filesystem
//   - no fs module flag        → node:fs isn't even enabled in its isolate
//   - no vfsModuleFallback     → it can import nothing beyond itself + its inline harness
//   - no allowSpawn, no LOADER → it cannot create isolates
//   - default globalOutbound   → real EGRESS fetch is its ONE capability (drivers/policies
//                                talk to the network; that is the point)
// The daemon's host filesystem (~/.iso, the image store, volume store) is a different world
// entirely — the isolate's VFS is its own empty /tmp.
//
// Invocation: `call(method, argsJson)` over RPC. Byte payloads cross as base64 strings.
const USER_FLAGS = ["nodejs_compat", "nodejs_compat_v2", "experimental"];
const USER_COMPAT_DATE = "2026-06-01";

function harnessSrc() {
  return `
  import { WorkerEntrypoint } from "cloudflare:workers";
  import * as userModule from "./user.js";
  export default class extends WorkerEntrypoint {
    async call(method, argsJson) {
      const impl = userModule.default || userModule;
      const args = JSON.parse(argsJson || "[]");
      if (!impl || typeof impl[method] !== "function") {
        return JSON.stringify({ error: "user module does not implement " + method + "()" });
      }
      try {
        const result = await impl[method](...args);
        return JSON.stringify({ ok: true, result: result === undefined ? null : result });
      } catch (e) {
        return JSON.stringify({ error: String((e && e.stack) || e) });
      }
    }
  }`;
}

// key: a stable identity for the child (e.g. "volume-driver-<name>"); source: the user module's
// text (read host-side and shipped in — the isolate has no way to read files itself).
export async function invokeUserModule(env, key, source, method, args = []) {
  const child = env.LOADER.get("user-module-" + key, () => ({
    compatibilityDate: USER_COMPAT_DATE,
    compatibilityFlags: USER_FLAGS,
    allowExperimental: true,
    // deliberately ABSENT: shareParentTmp, vfsModuleFallback, enable_nodejs_fs_module,
    // allowSpawn, drainProcess — see the authority table above.
    mainModule: "main.js",
    modules: { "main.js": harnessSrc(), "user.js": source },
  }));
  const raw = await child.getEntrypoint().call(method, JSON.stringify(args));
  const res = JSON.parse(raw);
  if (res.error) throw new Error("user module [" + key + "]." + method + ": " + res.error);
  return res.result;
}
