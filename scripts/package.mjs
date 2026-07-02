// scripts/package.mjs — build the release JS dist tarball: iso-<version>.tar.gz containing the
// repo's JS (packages/, examples/, package.json, README, LICENSE) but NOT node_modules and NOT
// the workerd binary (those are installed / downloaded separately). Also writes checksums.txt.
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const version = "v" + JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const OUT = path.join(ROOT, "dist-release");
mkdirSync(OUT, { recursive: true });
const tarball = path.join(OUT, `iso-${version}.tar.gz`);

// include exactly the runtime JS + manifests + examples/docs; exclude node_modules, the binary,
// git, and the release output itself.
const includes = ["package.json", "package-lock.json", "packages", "examples", "README.md", "LICENSE"].filter((p) => existsSync(path.join(ROOT, p)));
const excludes = ["--exclude=./**/node_modules", "--exclude=./**/*.bin", "--exclude=./.git"];
console.log("# packaging " + version + " → " + path.relative(ROOT, tarball));
execSync(`tar czf ${JSON.stringify(tarball)} ${excludes.join(" ")} -C ${JSON.stringify(ROOT)} ${includes.join(" ")}`, { stdio: "inherit" });

// checksums (tarball now; the binary is appended by upload-binary.sh / release.yml)
const sum = execSync(`shasum -a 256 ${JSON.stringify(tarball)}`).toString().trim().split(/\s+/)[0];
writeFileSync(path.join(OUT, "checksums.txt"), `${sum}  iso-${version}.tar.gz\n`);
console.log("  sha256(tarball) = " + sum);
console.log("  wrote " + path.relative(ROOT, path.join(OUT, "checksums.txt")));
