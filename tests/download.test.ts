import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DownloadProgress,
  downloadVerified,
} from "../src/shared/download.js";
import { pathExists } from "../src/shared/fsx.js";

describe("downloadVerified", () => {
  let tempDir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "omp-download-test-"));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  });

  function createReadableStream(
    chunks: Uint8Array[],
  ): ReadableStream<Uint8Array> {
    let index = 0;
    return new ReadableStream({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(chunks[index++]);
        } else {
          controller.close();
        }
      },
    });
  }

  it("rejects non-HTTPS URLs before network request", async () => {
    const dest = join(tempDir, "file.bin");
    await expect(
      downloadVerified({
        url: "http://example.com/file.tar.gz",
        dest,
      }),
    ).rejects.toThrow("refusing non-HTTPS download");
  });

  it("tracks progress with known Content-Length and verifies final SHA-256", async () => {
    const dest = join(tempDir, "output.bin");
    const chunk1 = Buffer.from("Hello, ");
    const chunk2 = Buffer.from("world! This is a download test.");
    const fullContent = Buffer.concat([chunk1, chunk2]);
    const expectedSha256 = createHash("sha256")
      .update(fullContent)
      .digest("hex");

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        "content-length": String(fullContent.length),
      }),
      body: createReadableStream([chunk1, chunk2]),
    } as unknown as Response);

    const progressReports: DownloadProgress[] = [];
    await downloadVerified({
      url: "https://mock.omp.local/archive.tar.gz",
      dest,
      sha256: expectedSha256,
      onProgress: (p) => {
        progressReports.push({ ...p });
      },
    });

    expect(progressReports.length).toBeGreaterThanOrEqual(2);
    // Initial callback at 0 bytes with totalBytes
    expect(progressReports[0]).toEqual({
      downloadedBytes: 0,
      totalBytes: fullContent.length,
    });
    // Final callback at full length
    expect(progressReports[progressReports.length - 1]).toEqual({
      downloadedBytes: fullContent.length,
      totalBytes: fullContent.length,
    });

    const fileBytes = await readFile(dest);
    expect(fileBytes.equals(fullContent)).toBe(true);
  });

  it("tracks progress with unknown Content-Length", async () => {
    const dest = join(tempDir, "no-cl.bin");
    const content = Buffer.from(
      "arbitrary streamed content without content-length",
    );
    const expectedSha256 = createHash("sha256").update(content).digest("hex");

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(), // No content-length header
      body: createReadableStream([content]),
    } as unknown as Response);

    const progressReports: DownloadProgress[] = [];
    await downloadVerified({
      url: "https://mock.omp.local/no-length.bin",
      dest,
      sha256: expectedSha256,
      onProgress: (p) => {
        progressReports.push({ ...p });
      },
    });

    expect(progressReports[0]).toEqual({
      downloadedBytes: 0,
      totalBytes: undefined,
    });
    expect(progressReports[progressReports.length - 1]).toEqual({
      downloadedBytes: content.length,
      totalBytes: undefined,
    });
  });

  it("triggers intermediate callbacks after exceeding 8 MiB thresholds", async () => {
    const dest = join(tempDir, "large.bin");
    // Create 3 chunks of 9 MiB each = 27 MiB total
    const CHUNK_SIZE = 9 * 1024 * 1024;
    const chunkA = Buffer.alloc(CHUNK_SIZE, 0x41);
    const chunkB = Buffer.alloc(CHUNK_SIZE, 0x42);
    const chunkC = Buffer.alloc(CHUNK_SIZE, 0x43);
    const totalLength = CHUNK_SIZE * 3;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({
        "content-length": String(totalLength),
      }),
      body: createReadableStream([chunkA, chunkB, chunkC]),
    } as unknown as Response);

    const progressReports: DownloadProgress[] = [];
    await downloadVerified({
      url: "https://mock.omp.local/large.tar.gz",
      dest,
      onProgress: (p) => {
        progressReports.push({ ...p });
      },
    });

    // Start (0), after chunkA (9MB), after chunkB (18MB), after chunkC (27MB), and final
    expect(progressReports.length).toBeGreaterThanOrEqual(4);
    const downloadedSteps = progressReports.map((p) => p.downloadedBytes);
    expect(downloadedSteps).toContain(0);
    expect(downloadedSteps[downloadedSteps.length - 1]).toBe(totalLength);
  });

  it("deletes partial destination file on SHA-256 mismatch", async () => {
    const dest = join(tempDir, "corrupted.bin");
    const content = Buffer.from("authentic content");

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": String(content.length) }),
      body: createReadableStream([content]),
    } as unknown as Response);

    await expect(
      downloadVerified({
        url: "https://mock.omp.local/corrupted.bin",
        dest,
        sha256:
          "0000000000000000000000000000000000000000000000000000000000000000",
      }),
    ).rejects.toThrow("SHA-256 mismatch");

    // File MUST be deleted on failure
    const exists = await pathExists(dest);
    expect(exists).toBe(false);
  });

  it("deletes partial destination file when stream fails mid-download", async () => {
    const dest = join(tempDir, "aborted.bin");
    const brokenStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("partial data"));
        controller.error(new Error("Connection reset by peer"));
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: brokenStream,
    } as unknown as Response);

    await expect(
      downloadVerified({
        url: "https://mock.omp.local/aborted.bin",
        dest,
      }),
    ).rejects.toThrow("Connection reset by peer");

    const exists = await pathExists(dest);
    expect(exists).toBe(false);
  });
});
