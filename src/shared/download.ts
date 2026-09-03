import { createHash } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const MAX_REDIRECTS = 5;
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024; // sanity cap (torch wheels are large)
const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000; // uv + torch can be slow
const PROGRESS_INTERVAL_BYTES = 8 * 1024 * 1024; // 8 MiB threshold

export interface DownloadProgress {
  downloadedBytes: number;
  totalBytes?: number;
}

export interface DownloadOptions {
  url: string;
  /** Only HTTPS URLs are allowed (manifest guarantees this; enforced here). */
  dest: string;
  sha256?: string;
  timeoutMs?: number;
  onProgress?: (progress: DownloadProgress) => void | Promise<void>;
}

/**
 * Stream a download to disk, verifying SHA-256 before returning.
 * Redirects are capped; size is capped; non-HTTPS is rejected. On any
 * failure the destination is removed so a partial file never passes.
 */
export async function downloadVerified(opts: DownloadOptions): Promise<void> {
  const {
    url,
    dest,
    sha256,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onProgress,
  } = opts;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:")
    throw new Error(`refusing non-HTTPS download: ${url}`);

  let redirects = 0;
  let current = url;
  for (;;) {
    const res = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      if (++redirects > MAX_REDIRECTS)
        throw new Error(`too many redirects: ${url}`);
      const location = res.headers.get("location");
      if (!location) throw new Error(`redirect missing location: ${current}`);
      current = new URL(location, current).href;
      if (new URL(current).protocol !== "https:")
        throw new Error(`refusing non-HTTPS redirect: ${current}`);
      continue;
    }
    if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
    if (!res.body) throw new Error(`no response body for ${url}`);

    let totalBytes: number | undefined;
    const clHeader = res.headers.get("content-length");
    if (clHeader) {
      const parsedCl = Number.parseInt(clHeader, 10);
      if (Number.isSafeInteger(parsedCl) && parsedCl >= 0) {
        totalBytes = parsedCl;
      }
    }

    if (onProgress) {
      await onProgress({ downloadedBytes: 0, totalBytes });
    }

    await mkdir(dirname(resolve(dest)), { recursive: true });
    const hash = createHash("sha256");
    let written = 0;
    let lastProgressBytes = 0;
    const handle = await open(dest, "w");
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        written += value.byteLength;
        if (written > MAX_DOWNLOAD_BYTES) {
          throw new Error(
            `download exceeded ${MAX_DOWNLOAD_BYTES} bytes: ${url}`,
          );
        }
        hash.update(value);
        await handle.write(value);

        if (
          onProgress &&
          written - lastProgressBytes >= PROGRESS_INTERVAL_BYTES
        ) {
          lastProgressBytes = written;
          await onProgress({ downloadedBytes: written, totalBytes });
        }
      }
      await handle.sync();
      await handle.close();
    } catch (err) {
      await handle.close().catch(() => {});
      await rm(dest, { force: true });
      throw err instanceof Error ? err : new Error(`download failed: ${url}`);
    }

    if (onProgress) {
      await onProgress({ downloadedBytes: written, totalBytes });
    }

    if (sha256) {
      const digest = hash.digest("hex");
      if (digest !== sha256.toLowerCase()) {
        await rm(dest, { force: true });
        throw new Error(
          `SHA-256 mismatch for ${url}: expected ${sha256}, got ${digest}`,
        );
      }
    }
    return;
  }
}
