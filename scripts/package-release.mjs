import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import tar from "tar-stream";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const file = (...segments) => join(root, ...segments);

const pkg = JSON.parse(await readFile(file("package.json"), "utf8"));
const version = process.env.VERSION || pkg.version;
const archiveName = `omp-skill-kit-${version}.tar.gz`;
const prefix = `omp-skill-kit-${version}`;

const stagingDir = file(".tmp", "staging", prefix);
await rm(stagingDir, { recursive: true, force: true });
await mkdir(stagingDir, { recursive: true });

const allowlist = [
  "package.json",
  "README.md",
  ...(pkg.files || []),
];

for (const entry of allowlist) {
  const src = file(entry);
  try {
    const st = await stat(src);
    const dest = join(stagingDir, entry);
    if (st.isDirectory()) {
      await mkdir(dest, { recursive: true });
      await cp(src, dest, { recursive: true });
    } else {
      await mkdir(dirname(dest), { recursive: true });
      await cp(src, dest);
    }
  } catch (err) {
    throw new Error(`Required release entry missing: ${entry} (${err.message})`);
  }
}

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

const stagedFiles = (await collectFiles(stagingDir)).sort((a, b) =>
  relative(stagingDir, a).localeCompare(relative(stagingDir, b))
);

const pack = tar.pack();

const packPromise = (async () => {
  for (const fullPath of stagedFiles) {
    const rel = relative(stagingDir, fullPath).split("\\").join("/");
    const content = await readFile(fullPath);
    const st = await stat(fullPath);
    pack.entry(
      {
        name: `${prefix}/${rel}`,
        size: content.length,
        mode: st.mode,
        mtime: new Date(0),
      },
      content
    );
  }
  pack.finalize();
})();

const gzip = createGzip({ level: 9, mtime: 0 });
const hash = createHash("sha256");
const outPath = file(archiveName);
const outStream = createWriteStream(outPath);

gzip.on("data", (chunk) => hash.update(chunk));

await Promise.all([packPromise, pipeline(pack, gzip, outStream)]);

const digest = hash.digest("hex");
await writeFile(file(`${archiveName}.sha256`), `${digest}  ${archiveName}\n`, "utf8");

console.log(`Created ${archiveName} (${digest}) with ${stagedFiles.length} files`);
