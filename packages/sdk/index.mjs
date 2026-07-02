// iso-sdk — the `iso build` frontend. A build file (iso.build.mjs) is a plain JS module that
// default-exports a step graph built with `from(image)`. Each method call appends ONE discrete
// step and returns a NEW builder (immutable chain) — the calls ARE the layer boundaries, so
// ordinary JS control flow composes builds:
//
//   import { from } from "../../sdk/index.mjs";   // (or the npm-linked "iso-sdk")
//   let img = from("base").workdir("/tmp/proj").copy("./app.js", "app.js");
//   for (const p of ["left-pad", "is-odd"]) img = img.run("npm", ["install", p]);
//   export default img.cmd("node", ["app.js"]);
//
// The SDK holds NO execution logic: each op serializes to a plain descriptor {op, ...params};
// the iso CLI walks the graph and executes it against a build machine over the Engine API.
// RUN is exec-form only — there is no shell in a machine, so `.run("npm install x")` is an
// error, not a convenience.

const isStr = (x) => typeof x === "string" && x.length > 0;

function execForm(what, cmd, args) {
  if (!isStr(cmd)) throw new TypeError(`${what}(cmd, args?): cmd must be a non-empty string`);
  if (/\s/.test(cmd)) {
    throw new TypeError(
      `${what}("${cmd}"): cmd must be a single executable name — there is no shell in a machine. ` +
      `Pass arguments as an array: ${what}("${cmd.split(/\s+/)[0]}", ${JSON.stringify(cmd.split(/\s+/).slice(1))})`);
  }
  if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== "string"))) {
    throw new TypeError(`${what}(cmd, args?): args must be an array of strings`);
  }
  return [cmd, ...(args || [])];
}

function strMap(what, obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new TypeError(`${what}(obj): expected an object of string values`);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== "string" && typeof v !== "number") throw new TypeError(`${what}(obj): value of "${k}" must be a string`);
    out[k] = String(v);
  }
  return out;
}

class Builder {
  constructor(steps) {
    this.steps = Object.freeze(steps);
    Object.freeze(this);
  }
  #add(step) { return new Builder([...this.steps, Object.freeze(step)]); }

  /** Execute a command in the build machine (exec-form only — no shell). */
  run(cmd, args) { return this.#add({ op: "run", argv: execForm(".run", cmd, args) }); }

  /** Copy a file or directory from the build context into the machine.
   *  dest may be relative (resolved against the current workdir). */
  copy(src, dest) {
    if (!isStr(src) || !isStr(dest)) throw new TypeError(".copy(src, dest): both must be non-empty strings");
    return this.#add({ op: "copy", src, dest });
  }

  /** Set environment variables — applied to subsequent .run() steps and recorded in the manifest. */
  env(obj) { return this.#add({ op: "env", env: strMap(".env", obj) }); }

  /** Set the working directory — applied to subsequent steps and recorded in the manifest. */
  workdir(dir) {
    if (!isStr(dir) || !dir.startsWith("/")) throw new TypeError(".workdir(dir): dir must be an absolute path");
    return this.#add({ op: "workdir", dir });
  }

  /** Default command for `iso run <image>` (manifest CMD). */
  cmd(cmd, args) { return this.#add({ op: "cmd", argv: execForm(".cmd", cmd, args) }); }

  /** Manifest ENTRYPOINT — prepended to the (user or CMD) argv at `iso run`. */
  entrypoint(cmd, args) { return this.#add({ op: "entrypoint", argv: execForm(".entrypoint", cmd, args) }); }

  /** Record a port the image serves (manifest ports). */
  expose(...ports) {
    if (!ports.length || ports.some((p) => !Number.isInteger(p) || p <= 0)) throw new TypeError(".expose(...ports): expected positive integers");
    return this.#add({ op: "expose", ports });
  }

  /** Attach metadata labels (manifest labels). */
  label(obj) { return this.#add({ op: "label", labels: strMap(".label", obj) }); }
}

/** Start a build graph from a parent image reference (name, repo[:tag], or digest). */
export function from(image) {
  if (!isStr(image)) throw new TypeError("from(image): image must be a non-empty string");
  return new Builder([Object.freeze({ op: "from", image })]);
}
