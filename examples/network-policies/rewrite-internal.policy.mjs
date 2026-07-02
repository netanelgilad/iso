// rewrite-internal.policy.mjs — L7 rewrite: `http://api.internal/...` is a virtual name; the
// policy maps it onto the network's `echo` member and injects an auth-ish header on the way.
// ctx.route(name, req) is the capability that delivers INTO a member machine.
export default {
  proxy: async (request, ctx) => {
    if (ctx.to.host === "api.internal") {
      const u = new URL(request.url);
      const target = new Request("http://echo:6000" + u.pathname + u.search, request);
      const h = new Headers(target.headers);
      h.set("x-injected-by", ctx.net + "-policy");
      return ctx.route("echo", new Request(target, { headers: h }));
    }
    if (ctx.to.host === "echo") return ctx.route("echo", request); // plain member routing stays available
    return new Response(`blocked by ${ctx.net} policy\n`, { status: 403 });
  },
};
