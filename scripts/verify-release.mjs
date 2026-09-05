import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import tar from "tar-stream";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const file = (...segments) => join(root, ...segments);

const pkg = JSON.parse(await readFile(file("package.json"), "utf8"));
if (pkg.private !== true) throw new Error("package must remain private; distribution is not npm");
const version = process.env.VERSION || pkg.version;

// Verify marketplace version parity
const mkt = JSON.parse(await readFile(file(".omp-plugin", "marketplace.json"), "utf8"));
if (mkt.metadata?.version !== pkg.version) {
  throw new Error(`marketplace metadata.version (${mkt.metadata?.version}) does not match package.json (${pkg.version})`);
}
if (mkt.plugins?.[0]?.version !== pkg.version) {
  throw new Error(`marketplace plugins[0].version (${mkt.plugins?.[0]?.version}) does not match package.json (${pkg.version})`);
}

// Verify source release tree dependencies
await stat(file("tests", "e2e", "lifecycle.ts"));

const archiveName = `omp-skill-kit-${version}.tar.gz`;
const archivePath = file(archiveName);
const shaPath = file(`${archiveName}.sha256`);

const manifest = JSON.parse(await readFile(file("runtime-manifest.json"), "utf8"));

async function collectFiles(dir) {
  const results = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectFiles(full)));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

async function computeSkillOptTreeSha(dir) {
  const all = await collectFiles(dir);
  const pyFiles = all
    .filter((f) => f.endsWith(".py"))
    .map((f) => relative(dir, f).split("\\").join("/"))
    .sort();
  const hash = createHash("sha256");
  for (const rel of pyFiles) {
    const raw = await readFile(join(dir, rel));
    // Normalize CRLF working-copy bytes to LF so the digest matches
    // the LF-normalized git blob bytes on every OS (see .gitattributes).
    const normalized = Buffer.from(
      raw.toString("utf8").replace(/\r\n/g, "\n"),
      "utf8",
    );
    hash.update(rel);
    hash.update(normalized);
  }
  return hash.digest("hex");
}

if (manifest.megaTron.commit !== "0ed290a1df1739af5cf4291d0ad8155afc7af16b") {
  throw new Error("mega-tron pin drift");
}
if (manifest.skillOptSleep?.sourceCommit !== "db46cd9ae7ce12f1dbd73c945185816aa738751d") {
  throw new Error("skillopt-sleep pin drift");
}
const localSkillOptSha = await computeSkillOptTreeSha(file("python", "skillopt_sleep"));
if (localSkillOptSha !== manifest.skillOptSleep.treeSha256) {
  throw new Error(`skillopt-sleep treeSha256 drift: ${localSkillOptSha} !== ${manifest.skillOptSleep.treeSha256}`);
}

for (const [target, spec] of Object.entries(manifest.targets)) {
  const path = file("runtime-locks", spec.lockFile);
  await stat(path);
  const digest = createHash("sha256").update(await readFile(path)).digest("hex");
  if (digest !== spec.lockSha256) throw new Error(`${target} lock digest mismatch`);
}

for (const required of [
  "dist/extension.js",
  "dist/installer.js",
  "dist/proposal-worker.js",
  "python/omp_skill_kit_bridge.py",
  "skills/mega-tron-dashboard/SKILL.md",
]) {
  await stat(file(required));
}

// Verify release archive
await stat(archivePath);
await stat(shaPath);

const archiveBytes = await readFile(archivePath);
const archiveDigest = createHash("sha256").update(archiveBytes).digest("hex");
const shaExpected = (await readFile(shaPath, "utf8")).trim().split(/\s+/)[0];
if (archiveDigest !== shaExpected) {
  throw new Error(`Archive digest mismatch: calculated ${archiveDigest}, expected ${shaExpected}`);
}

// Unpack and inspect archive contents
const tempExtract = file(".tmp", `verify-unpack-${Date.now()}`);
await rm(tempExtract, { recursive: true, force: true });
await mkdir(tempExtract, { recursive: true });

const extract = tar.extract();
const extractedFiles = [];

extract.on("entry", async (header, stream, next) => {
  try {
    const relName = header.name;
    extractedFiles.push(relName);
    const dest = join(tempExtract, relName);
    if (header.type === "directory") {
      await mkdir(dest, { recursive: true });
      stream.resume();
      next();
    } else {
      await mkdir(dirname(dest), { recursive: true });
      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", async () => {
        await writeFile(dest, Buffer.concat(chunks));
        next();
      });
      stream.on("error", next);
    }
  } catch (err) {
    next(err);
  }
});

await pipeline(createReadStream(archivePath), createGunzip(), extract);

const prefix = `omp-skill-kit-${version}/`;
const requiredArchiveEntries = [
  `${prefix}package.json`,
  `${prefix}README.md`,
  `${prefix}LICENSE`,
  `${prefix}dist/extension.js`,
  `${prefix}dist/installer.js`,
  `${prefix}dist/proposal-worker.js`,
  `${prefix}python/omp_skill_kit_bridge.py`,
  `${prefix}skills/mega-tron-dashboard/SKILL.md`,
  `${prefix}runtime-manifest.json`,
  `${prefix}THIRD_PARTY_NOTICES`,
  `${prefix}python/skillopt_sleep/__init__.py`,
  `${prefix}python/skillopt_sleep/__main__.py`,
];

for (const req of requiredArchiveEntries) {
  if (!extractedFiles.includes(req)) {
    throw new Error(`Missing required archive entry: ${req}`);
  }
}

const forbiddenPrefixes = [
  `${prefix}src/`,
  `${prefix}node_modules/`,
  `${prefix}tests/`,
  `${prefix}.git/`,
  `${prefix}.github/`,
  `${prefix}.tmp/`,
];

for (const f of extractedFiles) {
  for (const forb of forbiddenPrefixes) {
    if (f.startsWith(forb)) {
      throw new Error(`Forbidden entry in release archive: ${f}`);
    }
  }
}

// Verify dist/extension.js in archive has no pi_natives
const extContent = await readFile(join(tempExtract, prefix, "dist", "extension.js"), "utf8");
if (extContent.includes("pi_natives")) {
  throw new Error("Archived dist/extension.js inlined pi_natives host addon!");
}

// Verify unpacked skillopt_sleep treeSha256
const unpackedSkillOptSha = await computeSkillOptTreeSha(join(tempExtract, prefix, "python", "skillopt_sleep"));
if (unpackedSkillOptSha !== manifest.skillOptSleep.treeSha256) {
  throw new Error(`Archived skillopt-sleep treeSha256 mismatch: ${unpackedSkillOptSha} !== ${manifest.skillOptSleep.treeSha256}`);
}
const noticesText = await readFile(join(tempExtract, prefix, "THIRD_PARTY_NOTICES"), "utf8");
if (!noticesText.includes("SkillOpt-Sleep")) {
  throw new Error("Archived THIRD_PARTY_NOTICES missing SkillOpt-Sleep notice");
}

// Verify unpacked package.json
const unpackedPkg = JSON.parse(await readFile(join(tempExtract, prefix, "package.json"), "utf8"));
if (unpackedPkg.version !== pkg.version) {
  throw new Error(`Archived version ${unpackedPkg.version} does not match ${pkg.version}`);
}

await rm(tempExtract, { recursive: true, force: true });

console.log(`release ${pkg.version} verified: archive ${archiveName} is valid (${archiveDigest}) with ${extractedFiles.length} entries`);
