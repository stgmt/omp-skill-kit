import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

const MAX_ENTRY_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;

export class UnsafeArchiveError extends Error {}
interface Options {
  root: string;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
}
interface State {
  seen: Set<string>;
  total: number;
}

function safeRel(raw: string, state: State): string {
  const cleaned = raw.replace(/\\/g, "/");
  if (
    /^[A-Za-z]:/.test(cleaned) ||
    cleaned.startsWith("/") ||
    cleaned.startsWith("//")
  )
    throw new UnsafeArchiveError(`unsafe archive path: ${raw}`);
  const parts = cleaned.split("/").filter((part) => part && part !== ".");
  if (
    !parts.length ||
    parts.some((part) => part === ".." || part.includes("\0"))
  )
    throw new UnsafeArchiveError(`unsafe archive path: ${raw}`);
  const normalized = parts.join(sep);
  const key = normalized.toLowerCase();
  if (state.seen.has(key))
    throw new UnsafeArchiveError(`duplicate archive path: ${raw}`);
  state.seen.add(key);
  return normalized;
}

function target(raw: string, options: Options, state: State): string {
  const rel = safeRel(raw, state);
  const root = resolve(options.root);
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep))
    throw new UnsafeArchiveError(`archive path escapes root: ${raw}`);
  return abs;
}

function sizeCheck(
  raw: string,
  size: number,
  options: Options,
  state: State,
): void {
  const entryLimit = options.maxEntryBytes ?? MAX_ENTRY_BYTES;
  const totalLimit = options.maxTotalBytes ?? MAX_TOTAL_BYTES;
  if (!Number.isFinite(size) || size < 0 || size > entryLimit)
    throw new UnsafeArchiveError(`archive entry too large: ${raw}`);
  state.total += size;
  if (state.total > totalLimit)
    throw new UnsafeArchiveError("archive exceeds total size bound");
}

export async function extractTarGzHardened(
  archive: string,
  dest: string,
  options?: Partial<Options>,
): Promise<void> {
  const guard: Options = { root: dest, ...options };
  const state: State = { seen: new Set(), total: 0 };
  await mkdir(dest, { recursive: true });
  const tarModule: any = await import("tar-stream");
  const extract = (tarModule.default ?? tarModule).extract();
  let violation: unknown;
  extract.on(
    "entry",
    (header: any, stream: NodeJS.ReadableStream, next: () => void) => {
      void (async () => {
        try {
          if (header.type === "symlink" || header.type === "link")
            throw new UnsafeArchiveError(`link entry rejected: ${header.name}`);
          sizeCheck(header.name, Number(header.size ?? 0), guard, state);
          const abs = target(header.name, guard, state);
          if (header.type === "directory") {
            await mkdir(abs, { recursive: true });
            stream.resume();
            next();
            return;
          }
          if (header.type !== "file" && header.type !== undefined)
            throw new UnsafeArchiveError(`entry type rejected: ${header.type}`);
          await mkdir(dirname(abs), { recursive: true });
          await pipeline(stream, createWriteStream(abs));
          next();
        } catch (error) {
          violation = error;
          stream.resume();
          extract.destroy();
        }
      })();
    },
  );
  try {
    await pipeline(createReadStream(archive), createGunzip(), extract);
  } catch (error) {
    throw violation ?? error;
  }
  if (violation) throw violation;
}

export async function extractZipHardened(
  archive: string,
  dest: string,
  options?: Partial<Options>,
): Promise<void> {
  const guard: Options = { root: dest, ...options };
  const state: State = { seen: new Set(), total: 0 };
  await mkdir(dest, { recursive: true });
  // @ts-expect-error unzip-stream has no bundled declaration in some hosts.
  const unzipModule: any = await import("unzip-stream");
  const parseFn =
    typeof unzipModule.Parse === "function"
      ? unzipModule.Parse
      : typeof unzipModule.default?.Parse === "function"
        ? unzipModule.default.Parse
        : undefined;
  if (!parseFn) {
    const { run } = await import("./shared/spawn.js");
    const res = await run(["tar", "-xf", archive, "-C", dest]);
    if (res.code !== 0)
      throw new UnsafeArchiveError(`tar zip extract failed: ${res.stderr}`);
    return;
  }
  const parser = parseFn();
  const pending: Promise<void>[] = [];
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const source = createReadStream(archive);
    let settled = false;
    const fail = (error: unknown) => {
      if (!settled) {
        settled = true;
        source.destroy();
        rejectPromise(error);
      }
    };
    parser.on("entry", (entry: any) => {
      try {
        sizeCheck(entry.path, Number(entry.size ?? 0), guard, state);
        if (entry.type === "Directory") {
          entry.autodrain();
          return;
        }
        if (entry.type !== "File") {
          entry.autodrain();
          throw new UnsafeArchiveError(
            `non-file entry rejected: ${entry.path}`,
          );
        }
        const abs = target(entry.path, guard, state);
        const task = mkdir(dirname(abs), { recursive: true }).then(() =>
          pipeline(entry, createWriteStream(abs)),
        );
        pending.push(task);
        task.catch(fail);
      } catch (error) {
        try {
          entry.autodrain();
        } catch {}
        fail(error);
      }
    });
    parser.on("error", fail);
    source.on("error", fail);
    parser.on("close", () => {
      if (!settled) {
        settled = true;
        Promise.all(pending).then(() => resolvePromise(), rejectPromise);
      }
    });
    source.pipe(parser);
  });
}
