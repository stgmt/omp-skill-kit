import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson } from "./fsx.js";

export const PROCESS_LOCK_OWNER_GRACE_MS = 5_000;

export interface ProcessLockOwner {
  pid: number;
  token: string;
  startedAt: string;
}

export type ProcessLockState =
  | { kind: "none" }
  | { kind: "initializing"; ageMs: number }
  | { kind: "active"; owner: ProcessLockOwner }
  | { kind: "stale"; owner?: ProcessLockOwner };

export function isProcessAlive(pid: number): boolean {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface PromiseResolver<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function defer<T = void>(): PromiseResolver<T> {
  const ctor = Promise as unknown as {
    withResolvers?: <U>() => PromiseResolver<U>;
  };
  if (typeof ctor.withResolvers === "function") {
    return ctor.withResolvers<T>();
  }
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export interface InspectProcessLockOptions {
  now?: () => number;
  isAlive?: (pid: number) => boolean;
}

export async function inspectProcessLock(
  lockDir: string,
  options?: InspectProcessLockOptions,
): Promise<ProcessLockState> {
  const ownerFile = join(lockDir, "owner.json");
  const nowFn = options?.now ?? (() => Date.now());
  const isAliveFn = options?.isAlive ?? isProcessAlive;

  let dirMtimeMs: number;
  try {
    const dirStat = await stat(lockDir);
    dirMtimeMs = dirStat.mtimeMs;
  } catch {
    return { kind: "none" };
  }

  const ageMs = Math.max(0, nowFn() - dirMtimeMs);

  try {
    const raw = await readFile(ownerFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<ProcessLockOwner>;
    if (
      parsed &&
      typeof parsed.pid === "number" &&
      Number.isSafeInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.token === "string" &&
      typeof parsed.startedAt === "string"
    ) {
      const owner: ProcessLockOwner = {
        pid: parsed.pid,
        token: parsed.token,
        startedAt: parsed.startedAt,
      };
      if (isAliveFn(owner.pid)) {
        return { kind: "active", owner };
      }
      return { kind: "stale", owner };
    }

    if (ageMs < PROCESS_LOCK_OWNER_GRACE_MS) {
      return { kind: "initializing", ageMs };
    }
    return { kind: "stale" };
  } catch {
    if (ageMs < PROCESS_LOCK_OWNER_GRACE_MS) {
      return { kind: "initializing", ageMs };
    }
    return { kind: "stale" };
  }
}

export interface AcquireProcessLockOptions extends InspectProcessLockOptions {
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

export async function acquireProcessLock(
  lockDir: string,
  owner: ProcessLockOwner,
  options?: AcquireProcessLockOptions,
): Promise<boolean> {
  const ownerFile = join(lockDir, "owner.json");
  const nowFn = options?.now ?? (() => Date.now());
  const isAliveFn = options?.isAlive ?? isProcessAlive;
  const sleepFn =
    options?.sleep ??
    ((ms) => {
      const { promise, resolve } = defer<void>();
      setTimeout(resolve, ms);
      return promise;
    });
  const maxAttempts = options?.maxAttempts ?? 10;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await mkdir(lockDir);
      await atomicWriteJson(ownerFile, owner);
      return true;
    } catch {
      // lock directory already exists
    }

    const state = await inspectProcessLock(lockDir, {
      now: nowFn,
      isAlive: isAliveFn,
    });

    if (state.kind === "active") {
      return false;
    }
    if (state.kind === "initializing") {
      await sleepFn(150);
    } else if (state.kind === "stale") {
      await rm(lockDir, { recursive: true, force: true });
    }
  }

  return false;
}

export async function releaseProcessLock(
  lockDir: string,
  token: string,
): Promise<void> {
  const ownerFile = join(lockDir, "owner.json");
  try {
    const raw = await readFile(ownerFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<ProcessLockOwner>;
    if (parsed && typeof parsed.token === "string" && parsed.token === token) {
      await rm(lockDir, { recursive: true, force: true });
    }
  } catch {
    // Missing, corrupted, or already released lock directory
  }
}
