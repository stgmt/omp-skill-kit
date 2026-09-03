import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson } from "./shared/fsx.js";

export const INSTALL_LOCK_OWNER_GRACE_MS = 5_000;

export interface InstallLockOwner {
  pid: number;
  token: string;
  startedAt: string;
}

export type InstallLockState =
  | { kind: "none" }
  | { kind: "initializing"; ageMs: number }
  | { kind: "active"; owner: InstallLockOwner }
  | { kind: "stale"; owner?: InstallLockOwner };

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

export interface InspectInstallLockOptions {
  now?: () => number;
  isAlive?: (pid: number) => boolean;
}

export async function inspectInstallLock(
  home: string,
  options?: InspectInstallLockOptions,
): Promise<InstallLockState> {
  const lockDir = join(home, "install.lock");
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
    const parsed = JSON.parse(raw) as Partial<InstallLockOwner>;
    if (
      parsed &&
      typeof parsed.pid === "number" &&
      Number.isSafeInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.token === "string" &&
      typeof parsed.startedAt === "string"
    ) {
      const owner: InstallLockOwner = {
        pid: parsed.pid,
        token: parsed.token,
        startedAt: parsed.startedAt,
      };
      if (isAliveFn(owner.pid)) {
        return { kind: "active", owner };
      }
      return { kind: "stale", owner };
    }

    if (ageMs < INSTALL_LOCK_OWNER_GRACE_MS) {
      return { kind: "initializing", ageMs };
    }
    return { kind: "stale" };
  } catch {
    if (ageMs < INSTALL_LOCK_OWNER_GRACE_MS) {
      return { kind: "initializing", ageMs };
    }
    return { kind: "stale" };
  }
}

export interface AcquireInstallLockOptions extends InspectInstallLockOptions {
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

export async function acquireInstallLock(
  home: string,
  owner: InstallLockOwner,
  options?: AcquireInstallLockOptions,
): Promise<boolean> {
  const lockDir = join(home, "install.lock");
  const ownerFile = join(lockDir, "owner.json");
  const nowFn = options?.now ?? (() => Date.now());
  const isAliveFn = options?.isAlive ?? isProcessAlive;
  const sleepFn =
    options?.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = options?.maxAttempts ?? 10;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await mkdir(lockDir);
      await atomicWriteJson(ownerFile, owner);
      return true;
    } catch {
      // lock directory already exists
    }

    const state = await inspectInstallLock(home, {
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

export async function releaseInstallLock(
  home: string,
  token: string,
): Promise<void> {
  const lockDir = join(home, "install.lock");
  const ownerFile = join(lockDir, "owner.json");
  try {
    const raw = await readFile(ownerFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<InstallLockOwner>;
    if (parsed && typeof parsed.token === "string" && parsed.token === token) {
      await rm(lockDir, { recursive: true, force: true });
    }
  } catch {
    // Missing, corrupted, or already released lock directory
  }
}
