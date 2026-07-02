// ratelimit.policy.mjs — a STATEFUL policy using ctx.state (EXPERIMENTAL): each member gets
// 2 egress requests, then 429. The counter lives in the network's host-store KV, reached only
// through the policy's tagged callback channel — never the filesystem.
export default {
  proxy: async (request, ctx) => {
    const key = "count:" + ctx.from.name;
    const n = (await ctx.state.get(key)) || 0;
    if (n >= 2) return new Response(`rate limited: ${ctx.from.name} used its ${n} requests\n`, { status: 429 });
    await ctx.state.set(key, n + 1);
    return fetch(request);
  },
};
