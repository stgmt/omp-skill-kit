import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname.replace(/^\/+([A-Za-z]):/, "$1:");
const file = (name) => join(root, name);
const pkg = JSON.parse(await readFile(file("package.json"), "utf8"));
if (pkg.private !== true) throw new Error("package must remain private; distribution is not npm");
const manifest = JSON.parse(await readFile(file("runtime-manifest.json"), "utf8"));
if (pkg.version !== "0.1.0") throw new Error(`unexpected release version ${pkg.version}`);
if (manifest.megaTron.commit !== "0ed290a1df1739af5cf4291d0ad8155afc7af16b") throw new Error("mega-tron pin drift");
for (const [target, spec] of Object.entries(manifest.targets)) {
  const path = file(join("runtime-locks", spec.lockFile));
  await stat(path);
  const digest = createHash("sha256").update(await readFile(path)).digest("hex");
  if (digest !== spec.lockSha256) throw new Error(`${target} lock digest mismatch`);
}
for (const required of ["dist/extension.js", "dist/installer.js", "python/omp_skill_kit_bridge.py", "skills/mega-tron-dashboard/SKILL.md"]) await stat(file(required));
console.log(`release ${pkg.version} verified: ${Object.keys(manifest.targets).length} targets`);
