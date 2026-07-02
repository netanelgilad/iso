// deny-all.policy.mjs — the simplest network policy: NOTHING leaves. Every member egress
// (machine-to-machine and internet) gets the policy's own 403. Runs SANDBOXED in the
// per-network policy isolate; `iso network logs` shows every request it refused.
export default {
  proxy: async (request, ctx) => {
    return new Response(
      `blocked by ${ctx.net} policy: ${ctx.from.name} -> ${ctx.to.host}:${ctx.to.port} is not allowed\n`,
      { status: 403 },
    );
  },
};
