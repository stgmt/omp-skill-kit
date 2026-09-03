import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireInstallLock,
  INSTALL_LOCK_OWNER_GRACE_MS,
  type InstallLockOwner,
  inspectInstallLock,
  isProcessAlive,
  releaseInstallLock,
} from "../src/install-lock.js";

describe("install-lock", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "omp-lock-test-"));
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  describe("isProcessAlive", () => {
    it("rejects non-positive, fractional, and unsafe integer PIDs", () => {
      expect(isProcessAlive(0)).toBe(false);
      expect(isProcessAlive(-1)).toBe(false);
      expect(isProcessAlive(-999)).toBe(false);
      expect(isProcessAlive(1.5)).toBe(false);
      expect(isProcessAlive(Number.NaN)).toBe(false);
      expect(isProcessAlive(Number.POSITIVE_INFINITY)).toBe(false);
      expect(isProcessAlive(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    });

    it("detects the current process as alive", () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it("returns false for non-existent dead PID", () => {
      // 99999999 is extraordinarily unlikely to exist
      expect(isProcessAlive(99999999)).toBe(false);
    });
  });

  describe("inspectInstallLock", () => {
    it("returns none when lock directory does not exist", async () => {
      const state = await inspectInstallLock(tempHome);
      expect(state).toEqual({ kind: "none" });
    });

    it("returns initializing when lock directory is freshly created without owner.json (< 5000ms)", async () => {
      const lockDir = join(tempHome, "install.lock");
      await mkdir(lockDir);

      const fakeNow = Date.now();
      const state = await inspectInstallLock(tempHome, { now: () => fakeNow });
      expect(state.kind).toBe("initializing");
      if (state.kind === "initializing") {
        expect(state.ageMs).toBeGreaterThanOrEqual(0);
      }
    });

    it("returns stale when lock directory without owner.json is older than grace window", async () => {
      const lockDir = join(tempHome, "install.lock");
      await mkdir(lockDir);

      const dirStat = await stat(lockDir);
      const fakeNow = dirStat.mtimeMs + INSTALL_LOCK_OWNER_GRACE_MS + 1000;

      const state = await inspectInstallLock(tempHome, { now: () => fakeNow });
      expect(state.kind).toBe("stale");
    });

    it("returns initializing for fresh lock with malformed owner.json", async () => {
      const lockDir = join(tempHome, "install.lock");
      await mkdir(lockDir);
      await writeFile(join(lockDir, "owner.json"), "{ invalid json", "utf8");

      const fakeNow = Date.now();
      const state = await inspectInstallLock(tempHome, { now: () => fakeNow });
      expect(state.kind).toBe("initializing");
    });

    it("returns stale for old lock with malformed owner.json", async () => {
      const lockDir = join(tempHome, "install.lock");
      await mkdir(lockDir);
      await writeFile(join(lockDir, "owner.json"), "{ invalid json", "utf8");

      const dirStat = await stat(lockDir);
      const fakeNow = dirStat.mtimeMs + INSTALL_LOCK_OWNER_GRACE_MS + 500;

      const state = await inspectInstallLock(tempHome, { now: () => fakeNow });
      expect(state.kind).toBe("stale");
    });

    it("returns active when owner process is alive", async () => {
      const lockDir = join(tempHome, "install.lock");
      await mkdir(lockDir);
      const owner: InstallLockOwner = {
        pid: 12345,
        token: "test-token-123",
        startedAt: new Date().toISOString(),
      };
      await writeFile(
        join(lockDir, "owner.json"),
        JSON.stringify(owner),
        "utf8",
      );

      const state = await inspectInstallLock(tempHome, { isAlive: () => true });
      expect(state.kind).toBe("active");
      if (state.kind === "active") {
        expect(state.owner).toEqual(owner);
      }
    });

    it("returns stale when owner process is dead", async () => {
      const lockDir = join(tempHome, "install.lock");
      await mkdir(lockDir);
      const owner: InstallLockOwner = {
        pid: 99999,
        token: "dead-token",
        startedAt: new Date().toISOString(),
      };
      await writeFile(
        join(lockDir, "owner.json"),
        JSON.stringify(owner),
        "utf8",
      );

      const state = await inspectInstallLock(tempHome, {
        isAlive: () => false,
      });
      expect(state.kind).toBe("stale");
      if (state.kind === "stale") {
        expect(state.owner).toEqual(owner);
      }
    });
  });

  describe("acquireInstallLock", () => {
    it("acquires lock atomically and writes owner.json", async () => {
      const owner: InstallLockOwner = {
        pid: process.pid,
        token: "owner-token-abc",
        startedAt: new Date().toISOString(),
      };

      const acquired = await acquireInstallLock(tempHome, owner);
      expect(acquired).toBe(true);

      const ownerRaw = await readFile(
        join(tempHome, "install.lock", "owner.json"),
        "utf8",
      );
      const stored = JSON.parse(ownerRaw) as InstallLockOwner;
      expect(stored.pid).toBe(process.pid);
      expect(stored.token).toBe("owner-token-abc");
    });

    it("refuses second acquisition when active owner holds lock", async () => {
      const owner1: InstallLockOwner = {
        pid: process.pid,
        token: "owner-1",
        startedAt: new Date().toISOString(),
      };
      const owner2: InstallLockOwner = {
        pid: process.pid,
        token: "owner-2",
        startedAt: new Date().toISOString(),
      };

      const first = await acquireInstallLock(tempHome, owner1);
      expect(first).toBe(true);

      const second = await acquireInstallLock(tempHome, owner2);
      expect(second).toBe(false);

      // Verify owner 1 still holds the lock
      const ownerRaw = await readFile(
        join(tempHome, "install.lock", "owner.json"),
        "utf8",
      );
      const stored = JSON.parse(ownerRaw) as InstallLockOwner;
      expect(stored.token).toBe("owner-1");
    });

    it("recovers and acquires when prior lock is stale", async () => {
      const lockDir = join(tempHome, "install.lock");
      await mkdir(lockDir);
      const deadOwner: InstallLockOwner = {
        pid: 99999,
        token: "dead-owner",
        startedAt: new Date().toISOString(),
      };
      await writeFile(
        join(lockDir, "owner.json"),
        JSON.stringify(deadOwner),
        "utf8",
      );

      const newOwner: InstallLockOwner = {
        pid: process.pid,
        token: "new-owner",
        startedAt: new Date().toISOString(),
      };

      const acquired = await acquireInstallLock(tempHome, newOwner, {
        isAlive: (pid) => pid === process.pid,
      });
      expect(acquired).toBe(true);

      const ownerRaw = await readFile(join(lockDir, "owner.json"), "utf8");
      const stored = JSON.parse(ownerRaw) as InstallLockOwner;
      expect(stored.token).toBe("new-owner");
    });
  });

  describe("releaseInstallLock", () => {
    it("releases lock only when token matches", async () => {
      const owner: InstallLockOwner = {
        pid: process.pid,
        token: "secret-token",
        startedAt: new Date().toISOString(),
      };

      await acquireInstallLock(tempHome, owner);

      // Wrong token does not release
      await releaseInstallLock(tempHome, "wrong-token");
      let state = await inspectInstallLock(tempHome);
      expect(state.kind).toBe("active");

      // Correct token releases
      await releaseInstallLock(tempHome, "secret-token");
      state = await inspectInstallLock(tempHome);
      expect(state.kind).toBe("none");
    });
  });
});
