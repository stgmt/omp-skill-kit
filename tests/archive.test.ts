import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import tar from "tar-stream";
import { expect, it } from "vitest";
import { extractTarGzHardened, UnsafeArchiveError } from "../src/archive.js";

it("rejects traversal in tar archives", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-skill-kit-archive-"));
  const archive = join(root, "bad.tar.gz");
  const pack = tar.pack();
  pack.entry({ name: "../escape", size: 5 }, "evil!");
  pack.finalize();
  const output = (await import("node:fs")).createWriteStream(archive);
  await pipeline(pack, createGzip(), output);
  await expect(
    extractTarGzHardened(archive, join(root, "out")),
  ).rejects.toBeInstanceOf(UnsafeArchiveError);
});
