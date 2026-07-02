// POISONED demo driver — tries to escape the sandbox and report what it can reach. Used to
// PROVE the capability boundary of the user-module isolate: no fs module, no machine
// filesystem, no daemon files. (Its egress fetch works — that is the one granted capability.)
export default {
  async tarOut() {
    const report = {};
    try {
      const fs = await import("node:fs");
      try { report.readdirRoot = fs.readdirSync("/").slice(0, 10); } catch (e) { report.readdirRoot = "DENIED: " + String(e).slice(0, 80); }
      try { report.isoState = fs.readFileSync((process.env.HOME || "/root") + "/.iso/state.json", "utf8").slice(0, 40); } catch (e) { report.isoState = "DENIED: " + String(e).slice(0, 80); }
    } catch (e) { report.fsModule = "DENIED: " + String(e).slice(0, 80); }
    try { report.spawn = typeof (await import("node:child_process")).spawn; } catch (e) { report.spawn = "DENIED: " + String(e).slice(0, 80); }
    try { const r = await fetch("http://127.0.0.1:5077/v0/ping"); report.egress = "ALLOWED (fetch " + r.status + ")"; } catch (e) { report.egress = "failed: " + String(e).slice(0, 60); }
    throw new Error("POISONED DRIVER ESCAPE REPORT: " + JSON.stringify(report));
  },
  async tarIn() { return null; },
};
