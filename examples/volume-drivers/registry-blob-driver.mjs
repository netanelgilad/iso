// DEMO user volume driver — checkpoints stored as blobs in an iso registry (pleasingly
// circular). Implements the bulk driver interface: tarOut()/tarIn(bytes) — the "bytes" are the
// platform's snapshot artifact (the path→base64 JSON map, the same artifact images use), moved
// as base64 strings over the sandbox RPC.
//
// This module runs SANDBOXED in a user-module isolate: no fs, no machine /tmp, no daemon
// access — its ONE capability is egress fetch (which is the point of a driver).
const REGISTRY = "http://127.0.0.1:5077";
const REPO = "volumes/demo";

async function sha256(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return "sha256:" + [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const b64encode = (bytes) => btoa(String.fromCharCode(...bytes));
const b64decode = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export default {
  // → base64 of the current checkpoint artifact, or null when none exists yet
  async tarOut() {
    const m = await fetch(`${REGISTRY}/v0/manifests/${REPO}/latest`);
    if (m.status === 404) return null;
    if (!m.ok) throw new Error("registry manifest fetch failed: " + m.status);
    const { snapshot } = await m.json();
    const b = await fetch(`${REGISTRY}/v0/blobs/${snapshot}`);
    if (!b.ok) throw new Error("registry blob fetch failed: " + b.status);
    return b64encode(new Uint8Array(await b.arrayBuffer()));
  },
  // ← base64 of a checkpoint artifact: store as a content-addressed blob + tag it
  async tarIn(b64) {
    const bytes = b64decode(b64);
    const digest = await sha256(bytes);
    const put = await fetch(`${REGISTRY}/v0/blobs/${digest}`, { method: "PUT", body: bytes });
    if (!put.ok) throw new Error("registry blob put failed: " + put.status);
    const man = await fetch(`${REGISTRY}/v0/manifests/${REPO}/latest`, {
      method: "PUT", body: JSON.stringify({ snapshot: digest, digest }),
    });
    if (!man.ok) throw new Error("registry manifest put failed: " + man.status);
    return { stored: digest };
  },
};
