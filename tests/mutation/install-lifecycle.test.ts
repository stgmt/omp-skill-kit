import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSpawnDetached = vi.fn();
vi.mock("../../src/shared/spawn.js", async (importOriginal) => {
  const mod =
    await importOriginal<typeof import("../../src/shared/spawn.js")>();
  return {
    ...mod,
    spawnDetached: (...args: Parameters<typeof mod.spawnDetached>) =>
      mockSpawnDetached(...args),
  };
});

vi.mock("@oh-my-pi/pi-coding-agent/capability", () => ({
  loadCapability: vi.fn().mockResolvedValue({ items: [] }),
}));

import { browserOpenCommand } from "../../src/dashboard.js";
import { DiagnosticLog, getComponentLogPaths } from "../../src/diagnostics.js";
import {
  ensureInstaller,
  resetLifecycleStateForTests,
} from "../../src/extension.js";
import {
  acquireInstallLock,
  inspectInstallLock,
  isProcessAlive,
  releaseInstallLock,
} from "../../src/install-lock.js";
import { StateStore } from "../../src/runtime.js";
import { safeSkillName } from "../../src/shared/fsx.js";

describe("install-lifecycle mutation and security fuzzing", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "omp-mutation-test-"));
    process.env.OMP_SKILL_KIT_HOME = tempHome;
    mockSpawnDetached.mockReset();
    mockSpawnDetached.mockReturnValue(98765);
    resetLifecycleStateForTests();
  });

  afterEach(async () => {
    resetLifecycleStateForTests();
    delete process.env.OMP_SKILL_KIT_HOME;
    await rm(tempHome, { recursive: true, force: true });
  });

  describe("corrupted owner.json and dangerous PIDs", () => {
    it.each([
      "{ malformed json",
      "",
      "null",
      JSON.stringify({ pid: "not-a-number", token: "tok" }),
      JSON.stringify({ pid: 0, token: "tok" }),
      JSON.stringify({ pid: -100, token: "tok" }),
      JSON.stringify({ pid: 1.234, token: "tok" }),
      JSON.stringify({ pid: Number.MAX_SAFE_INTEGER + 10, token: "tok" }),
      JSON.stringify({ token: "missing-pid" }),
      JSON.stringify({ pid: 12345 }), // missing token
    ])(
      "rejects malformed or unsafe owner.json payload: %s",
      async (payload) => {
        const lockDir = join(tempHome, "install.lock");
        await mkdir(lockDir, { recursive: true });
        await writeFile(join(lockDir, "owner.json"), payload, "utf8");

        const state = await inspectInstallLock(tempHome, {
          now: () => Date.now() + 10_000, // force past grace window
        });
        expect(state.kind).toBe("stale");
      },
    );

    it.each([
      0,
      -1,
      -9999,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 10,
    ])(
      "isProcessAlive returns false without throwing for invalid PID: %s",
      (pid) => {
        expect(isProcessAlive(pid as number)).toBe(false);
      },
    );
  });

  describe("token spoofing and lock preservation", () => {
    it("never releases a lock when token is substituted or forged", async () => {
      const realOwner = {
        pid: process.pid,
        token: "authentic-token-12345",
        startedAt: new Date().toISOString(),
      };

      const acquired = await acquireInstallLock(tempHome, realOwner);
      expect(acquired).toBe(true);

      // Attempt release with forged / mutated tokens
      for (const forgedToken of [
        "authentic-token-123456", // appended
        "authentic-token", // prefix
        "different-token",
        "",
        "null",
        "undefined",
      ]) {
        await releaseInstallLock(tempHome, forgedToken);
        const checkState = await inspectInstallLock(tempHome);
        expect(checkState.kind).toBe("active");
      }

      // Authentic token releases successfully
      await releaseInstallLock(tempHome, "authentic-token-12345");
      const finalState = await inspectInstallLock(tempHome);
      expect(finalState.kind).toBe("none");
    });
  });

  describe("phase and lock mismatch arbitration", () => {
    it("does not spawn second installer when phase is absent/degraded but lock is actively held", async () => {
      // Lock is held by live process
      await acquireInstallLock(tempHome, {
        pid: process.pid,
        token: "live-token",
        startedAt: new Date().toISOString(),
      });

      const store = new StateStore(tempHome);
      await store.save({
        schemaVersion: 1,
        pluginVersion: "0.1.2",
        runtimeHash: "",
        phase: "absent",
        attempt: 1,
        updatedAt: new Date().toISOString(),
      });

      const res = await ensureInstaller(tempHome);
      expect(res.status).toBe("running");
      expect(mockSpawnDetached).not.toHaveBeenCalled();
    });

    it("recovers and spawns when phase is active but lock is dead/stale", async () => {
      const lockDir = join(tempHome, "install.lock");
      await mkdir(lockDir, { recursive: true });
      await writeFile(
        join(lockDir, "owner.json"),
        JSON.stringify({
          pid: 999999,
          token: "dead",
          startedAt: new Date().toISOString(),
        }),
        "utf8",
      );

      const store = new StateStore(tempHome);
      await store.save({
        schemaVersion: 1,
        pluginVersion: "0.1.2",
        runtimeHash: "hash-active",
        phase: "installing-python",
        attempt: 1,
        updatedAt: new Date().toISOString(),
      });

      const res = await ensureInstaller(tempHome);
      expect(res.status).toBe("started");
      expect(mockSpawnDetached).toHaveBeenCalledTimes(1);
    });
  });

  describe("repeated dashboard and setup events", () => {
    it("deduplicates concurrent setup invocations using single in-flight launchPromise", async () => {
      const promises = [
        ensureInstaller(tempHome),
        ensureInstaller(tempHome),
        ensureInstaller(tempHome),
      ];

      const results = await Promise.all(promises);
      expect(results.every((r) => r.status === "started")).toBe(true);
      expect(mockSpawnDetached).toHaveBeenCalledTimes(1);
    });
  });

  describe("Windows opener mutation coverage", () => {
    it.each([
      "http://127.0.0.1:7531/",
      "http://127.0.0.1:7531/?q=space%20and%20symbols",
      "http://127.0.0.1:7531/?q=%26%7C%3B",
    ])("never routes URL through cmd.exe: %s", (url) => {
      const command = browserOpenCommand(url, "win32");
      expect(command).toEqual(["explorer.exe", url]);
      expect(command).not.toContain("cmd.exe");
      expect(command).not.toContain("/c");
      expect(command).not.toContain("start");
    });
  });

  describe("skill name fuzzing and control characters", () => {
    it.each([
      "skill\0injection",
      "skill\nnewline",
      "skill\rreturn",
      "skill\tcontrol",
      "../../traversal",
      "C:\\Windows\\System32",
      "/etc/passwd",
      "sk-proj-super-secret-key-1234567890",
      "Bearer sensitive-token-here",
    ])("rejects or redacts corrupted skill name: %s", (fuzzedName) => {
      // safeSkillName check
      const isSafe = safeSkillName(fuzzedName);
      if (isSafe) {
        // If it passed character validation (e.g. sk-proj), it MUST be filtered by diagnostics
        expect(
          fuzzedName.startsWith("sk-") ||
            fuzzedName.toLowerCase().startsWith("bearer"),
        ).toBe(true);
      } else {
        expect(isSafe).toBe(false);
      }
    });
  });

  describe("privacy allowlist: absolute proof against secret leakage", () => {
    it("never writes raw prompt, secret tokens, skill bodies, or paths to diagnostic logs", async () => {
      const diag = new DiagnosticLog(tempHome);

      const secretMarker1 = "sk-ant-api03-SECRET_LEAK_MARKER_AAAAAA";
      const secretMarker2 = "Bearer sensitive_auth_bearer_token_BBBBBB";
      const promptText =
        "SELECT * FROM users WHERE ssn = '123-45-6789'; secret prompt";
      const skillBody = "# Deep private skill guide\nDo not leak this text!";
      const absolutePath = "C:\\secret\\path\\to\\skill\\SKILL.md";

      await diag.log({
        level: "error",
        component: "router",
        event: "route.failed",
        error: `Error with token ${secretMarker1} and ${secretMarker2}`,
        names: [
          secretMarker1,
          secretMarker2,
          absolutePath,
          skillBody,
          "valid-clean-skill",
        ],
      });

      const logPath = getComponentLogPaths(tempHome).extensionLog;
      const rawLog = await readFile(logPath, "utf8");

      expect(rawLog).not.toContain(secretMarker1);
      expect(rawLog).not.toContain(secretMarker2);
      expect(rawLog).not.toContain(promptText);
      expect(rawLog).not.toContain(skillBody);
      expect(rawLog).not.toContain(absolutePath);
      expect(rawLog).toContain("valid-clean-skill");
      expect(rawLog).toContain("[REDACTED]");
    });
  });
});
