import { join } from "node:path";
import {
  type AcquireProcessLockOptions,
  acquireProcessLock,
  type InspectProcessLockOptions,
  inspectProcessLock,
  PROCESS_LOCK_OWNER_GRACE_MS,
  type ProcessLockOwner,
  type ProcessLockState,
  releaseProcessLock,
  isProcessAlive as sharedIsProcessAlive,
} from "./shared/process-lock.js";

export const INSTALL_LOCK_OWNER_GRACE_MS = PROCESS_LOCK_OWNER_GRACE_MS;

export type InstallLockOwner = ProcessLockOwner;
export type InstallLockState = ProcessLockState;
export type InspectInstallLockOptions = InspectProcessLockOptions;
export type AcquireInstallLockOptions = AcquireProcessLockOptions;

export const isProcessAlive = sharedIsProcessAlive;

export async function inspectInstallLock(
  home: string,
  options?: InspectInstallLockOptions,
): Promise<InstallLockState> {
  return inspectProcessLock(join(home, "install.lock"), options);
}

export async function acquireInstallLock(
  home: string,
  owner: InstallLockOwner,
  options?: AcquireInstallLockOptions,
): Promise<boolean> {
  return acquireProcessLock(join(home, "install.lock"), owner, options);
}

export async function releaseInstallLock(
  home: string,
  token: string,
): Promise<void> {
  return releaseProcessLock(join(home, "install.lock"), token);
}
