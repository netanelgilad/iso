// npm-only.policy.mjs — an allow-list: members may talk to the npm registry, nothing else.
// `fetch(request)` IS the allow — the policy's own egress capability performs the fetch
// (tagged + logged by the control plane). Everything else gets a 403.
export default {
  proxy: async (request, ctx) => {
    const h = ctx.to.host;
    if (h === "registry.npmjs.org" || h.endsWith(".npmjs.org")) return fetch(request);
    return new Response(`blocked by ${ctx.net} policy: ${h} is not on the allow-list\n`, { status: 403 });
  },
};
