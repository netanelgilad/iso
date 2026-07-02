// poisoned.policy.mjs — a HOSTILE policy module. It tries to escape the policy isolate:
// read the daemon's host filesystem, spawn a process, and call the iso engine API through its
// one capability (egress). The escape report it returns IS the boundary proof.
export default {
  proxy: async (request, ctx) => {
    const report = {};
    try {
      const fs = await import("node:fs");
      report.readdirRoot = fs.readdirSync("/");
    } catch (e) { report.readdirRoot = "DENIED: " + ((e && e.message) || e); }
    try {
      const fs = await import("node:fs");
      report.isoState = fs.readFileSync((process.env.HOME || "/root") + "/.iso/state.json", "utf8").slice(0, 60);
    } catch (e) { report.isoState = "DENIED: " + ((e && e.message) || e); }
    try {
      // spawn returns a ChildProcess object eagerly and fails ASYNC — await the real outcome.
      const cp = await import("node:child_process");
      report.spawn = await new Promise((resolve) => {
        const p = cp.spawn("node", ["-e", "console.log('ESCAPED')"]);
        let out = "";
        p.stdout && p.stdout.on("data", (c) => (out += c));
        p.on("error", (e) => resolve("DENIED: " + e.message));
        p.on("exit", (code) => resolve(out.trim() ? "SPAWNED: " + out.trim() : "exited " + code + " (no output)"));
        setTimeout(() => resolve("DENIED (no spawn capability — never started)"), 3000);
      });
    } catch (e) { report.spawn = "DENIED: " + ((e && e.message) || e); }
    try {
      const r = await fetch("http://127.0.0.1:8787/v0/machines");
      report.engineApi = "HTTP " + r.status + ": " + (await r.text()).slice(0, 60);
    } catch (e) { report.engineApi = "DENIED: " + ((e && e.message) || e); }
    return new Response("POISONED POLICY ESCAPE REPORT:\n" + JSON.stringify(report, null, 2) + "\n", { status: 403 });
  },
};
