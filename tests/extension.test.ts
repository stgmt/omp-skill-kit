import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockSpawnDetached = vi.fn();
vi.mock("../src/shared/spawn.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/shared/spawn.js")>();
  return {
    ...mod,
    spawnDetached: (...args: Parameters<typeof mod.spawnDetached>) =>
      mockSpawnDetached(...args),
  };
});

vi.mock("@oh-my-pi/pi-coding-agent/capability", () => ({
  loadCapability: vi.fn().mockResolvedValue({ items: [] }),
}));

import extension, { resetLifecycleStateForTests } from "../src/extension.js";
import { acquireInstallLock } from "../src/install-lock.js";
import { StateStore } from "../src/runtime.js";

type EventHandler = (...args: unknown[]) => unknown;

interface CommandSpec {
  description: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

describe("native extension lifecycle and commands", () => {
  let tempHome: string;
  let savedHomeEnv: string | undefined;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "omp-ext-test-"));
    savedHomeEnv = process.env.OMP_SKILL_KIT_HOME;
    process.env.OMP_SKILL_KIT_HOME = tempHome;
    mockSpawnDetached.mockReset();
    mockSpawnDetached.mockReturnValue(54321);
    resetLifecycleStateForTests();
  });

  afterEach(async () => {
    resetLifecycleStateForTests();
    if (savedHomeEnv !== undefined) {
      process.env.OMP_SKILL_KIT_HOME = savedHomeEnv;
    } else {
      delete process.env.OMP_SKILL_KIT_HOME;
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(tempHome, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 60));
      }
    }
  });

  function createMockApi() {
    const handlers = new Map<string, EventHandler[]>();
    const commands = new Map<string, CommandSpec>();

    const api = {
      on: (name: string, handler: EventHandler) => {
        const list = handlers.get(name) ?? [];
        list.push(handler);
        handlers.set(name, list);
      },
      registerCommand: (name: string, spec: CommandSpec) => {
        commands.set(name, spec);
      },
    } as unknown as ExtensionAPI;

    return { api, handlers, commands };
  }

  function createMockContext() {
    const statusMap = new Map<string, string | undefined>();
    const notifications: { message: string; type?: string }[] = [];
    const timers: (() => Promise<void> | void)[] = [];

    const ctx = {
      hasUI: true,
      cwd: process.cwd(),
      ui: {
        setStatus: (key: string, text: string | undefined) => {
          statusMap.set(key, text);
        },
        notify: (message: string, type?: "info" | "warning" | "error") => {
          notifications.push({ message, type });
        },
      },
      setInterval: (callback: () => Promise<void> | void) => {
        timers.push(callback);
        return {} as unknown as Parameters<ExtensionContext["clearTimer"]>[0];
      },
      clearTimer: () => {},
    } as unknown as ExtensionContext;

    return {
      ctx,
      statusMap,
      notifications,
      timers,
      async triggerTimer() {
        for (const t of timers) {
          await t();
        }
      },
    };
  }

  it("registers exactly two lifecycle events and exactly six commands", () => {
    const { api, handlers, commands } = createMockApi();
    extension(api);

    expect(Array.from(handlers.keys())).toEqual([
      "session_start",
      "before_agent_start",
    ]);

    expect(Array.from(commands.keys())).toEqual([
      "omp-skill-kit:status",
      "omp-skill-kit:setup",
      "omp-skill-kit:doctor",
      "omp-skill-kit:purge",
      "omp-skill-kit:dashboard",
      "omp-skill-kit:help",
    ]);
  });

  it("autostarts installer from absent state on session_start without prompt popups", async () => {
    const { api, handlers } = createMockApi();
    extension(api);

    const { ctx, statusMap, notifications } = createMockContext();
    const sessionStart = handlers.get("session_start")?.[0];
    expect(sessionStart).toBeDefined();

    await sessionStart?.({ type: "session_start" }, ctx);

    // Spawn was called once
    expect(mockSpawnDetached).toHaveBeenCalledTimes(1);
    // Footer status set immediately
    expect(statusMap.get("omp-skill-kit-install")).toContain(
      "omp-skill-kit: setup",
    );
    // No intrusive popups created on start
    expect(notifications.length).toBe(0);
  });

  it("does not spawn second installer when active lock exists", async () => {
    // Simulate active lock
    await acquireInstallLock(tempHome, {
      pid: process.pid,
      token: "existing-lock",
      startedAt: new Date().toISOString(),
    });

    const { api, handlers } = createMockApi();
    extension(api);

    const { ctx } = createMockContext();
    const sessionStart = handlers.get("session_start")?.[0];
    await sessionStart?.({ type: "session_start" }, ctx);

    expect(mockSpawnDetached).not.toHaveBeenCalled();
  });

  it("restarts installer when orphaned active state exists without live lock", async () => {
    const store = new StateStore(tempHome);
    await store.save({
      schemaVersion: 1,
      pluginVersion: "0.1.1",
      runtimeHash: "hash-123",
      phase: "installing-mega-tron",
      attempt: 1,
      updatedAt: new Date().toISOString(),
    });

    const { api, handlers } = createMockApi();
    extension(api);

    const { ctx, statusMap } = createMockContext();
    const sessionStart = handlers.get("session_start")?.[0];
    await sessionStart?.({ type: "session_start" }, ctx);

    // Interrupted install automatically restarted
    expect(mockSpawnDetached).toHaveBeenCalledTimes(1);
    expect(statusMap.get("omp-skill-kit-install")).toBeDefined();
  });

  it("handles ready transition in observer: clears status and notifies once", async () => {
    const { api, handlers } = createMockApi();
    extension(api);

    const { ctx, statusMap, notifications, triggerTimer } = createMockContext();
    const sessionStart = handlers.get("session_start")?.[0];
    await sessionStart?.({ type: "session_start" }, ctx);

    expect(statusMap.get("omp-skill-kit-install")).toBeDefined();

    // Now state flips to ready
    const store = new StateStore(tempHome);
    await store.save({
      schemaVersion: 1,
      pluginVersion: "0.1.2",
      runtimeHash: "verified-hash",
      phase: "ready",
      attempt: 1,
      updatedAt: new Date().toISOString(),
    });

    // Run poll iteration
    await triggerTimer();

    expect(statusMap.get("omp-skill-kit-install")).toBeUndefined();
    expect(
      notifications.some((n) => n.message.includes("automatic setup complete")),
    ).toBe(true);

    // Second poll iteration does not notify again
    notifications.length = 0;
    await triggerTimer();
    expect(notifications.length).toBe(0);
  });

  it("handles degraded transition in observer: clears status and notifies with log path", async () => {
    const { api, handlers } = createMockApi();
    extension(api);

    const { ctx, statusMap, notifications, triggerTimer } = createMockContext();
    const sessionStart = handlers.get("session_start")?.[0];
    await sessionStart?.({ type: "session_start" }, ctx);

    // State flips to degraded
    const store = new StateStore(tempHome);
    await store.save({
      schemaVersion: 1,
      pluginVersion: "0.1.2",
      runtimeHash: "",
      phase: "degraded",
      attempt: 2,
      errorCode: "uv binary missing",
      updatedAt: new Date().toISOString(),
    });

    await triggerTimer();

    expect(statusMap.get("omp-skill-kit-install")).toBeUndefined();
    const failNotice = notifications.find((n) => n.type === "error");
    expect(failNotice).toBeDefined();
    expect(failNotice?.message).toContain("uv binary missing");
    expect(failNotice?.message).toContain("installer.log");
  });

  it("queues dashboard command when runtime is not ready and opens once ready", async () => {
    const { api, commands } = createMockApi();
    extension(api);

    const { ctx, notifications, triggerTimer } = createMockContext();
    const dashboardCmd = commands.get("omp-skill-kit:dashboard");
    expect(dashboardCmd).toBeDefined();

    await dashboardCmd?.handler("", ctx as unknown as ExtensionCommandContext);

    expect(
      notifications.some((n) =>
        n.message.includes("dashboard will open automatically when ready"),
      ),
    ).toBe(true);

    // Flips to ready
    const store = new StateStore(tempHome);
    await store.save({
      schemaVersion: 1,
      pluginVersion: "0.1.2",
      runtimeHash: "verified-hash",
      phase: "ready",
      attempt: 1,
      updatedAt: new Date().toISOString(),
    });

    // Polling triggers dashboard
    await triggerTimer();
    expect(
      notifications.some((n) => n.message.includes("automatic setup complete")),
    ).toBe(true);
  });

  it("clears omp-skill-kit-route on before_agent_start and leaves it clear when not ready", async () => {
    const { api, handlers } = createMockApi();
    extension(api);

    const { ctx, statusMap } = createMockContext();
    statusMap.set("omp-skill-kit-route", "old-route-status");

    const beforeAgentStart = handlers.get("before_agent_start")?.[0];
    const event: BeforeAgentStartEvent = {
      type: "before_agent_start",
      prompt: "test prompt",
      systemPrompt: ["base prompt"],
    };

    const res = (await beforeAgentStart?.(event, ctx)) as unknown;
    expect(res).toBeUndefined();
    // Route status cleared
    expect(statusMap.get("omp-skill-kit-route")).toBeUndefined();
  });

  it("outputs complete help with all 6 commands and 4 log paths", async () => {
    const { api, commands } = createMockApi();
    extension(api);

    const { ctx, notifications } = createMockContext();
    const helpCmd = commands.get("omp-skill-kit:help");
    expect(helpCmd).toBeDefined();

    await helpCmd?.handler("", ctx as unknown as ExtensionCommandContext);

    expect(notifications.length).toBe(1);
    const text = notifications[0].message;

    expect(text).toContain("/omp-skill-kit:status");
    expect(text).toContain("/omp-skill-kit:setup");
    expect(text).toContain("/omp-skill-kit:doctor");
    expect(text).toContain("/omp-skill-kit:dashboard");
    expect(text).toContain("/omp-skill-kit:purge");
    expect(text).toContain("/omp-skill-kit:help");
    expect(text).toContain("extension.log");
    expect(text).toContain("installer.log");
    expect(text).toContain("bridge.log");
    expect(text).toContain("dashboard.log");
    expect(text).toContain("Start with /omp-skill-kit:doctor");
  });
});
