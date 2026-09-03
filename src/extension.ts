import { mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { CatalogStore, loadEligibleCatalog } from "./catalog.js";
import { DiagnosticLog, getComponentLogPaths } from "./diagnostics.js";
import {
  type InstallLockOwner,
  type InstallLockState,
  inspectInstallLock,
} from "./install-lock.js";
import { promptHash, RouterClient } from "./router-client.js";
import {
  formatInstallProgress,
  type RuntimeState,
  StateStore,
} from "./runtime.js";
import { BRIDGE_IDLE_SHUTDOWN_MS, PLUGIN_NAME } from "./shared/constants.js";
import { pathExists } from "./shared/fsx.js";
import { spawnDetached } from "./shared/spawn.js";

const HOME_ENV = "OMP_SKILL_KIT_HOME";

type ManagedTimer = Parameters<ExtensionContext["clearTimer"]>[0];

function homePath(): string {
  return process.env[HOME_ENV] || join(homedir(), ".omp", "skill-kit");
}

function pluginRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function installerPath(root: string = pluginRoot()): string {
  return join(root, "dist", "installer.js");
}

export function launchInstaller(
  home: string,
  root: string = pluginRoot(),
): number {
  const instPath = installerPath(root);
  return spawnDetached([process.execPath, instPath, "--home", home], {
    env: {
      ...process.env,
      BUN_BE_BUN: "1",
      OMP_SKILL_KIT_INSTALLER: "1",
      OMP_SKILL_KIT_HOME: home,
    },
    logFile: join(home, "logs", "installer.log"),
  });
}

export type EnsureInstallerResult =
  | { status: "ready"; state: RuntimeState }
  | { status: "running"; state: RuntimeState; lock: InstallLockState }
  | { status: "started"; state: RuntimeState; pid: number }
  | { status: "unavailable"; state: RuntimeState; reason: string };

let launchPromise: Promise<EnsureInstallerResult> | undefined;
let activeContext: ExtensionContext | undefined;
let observerTimer: ManagedTimer | undefined;
let observingInstallation = false;
let dashboardPending = false;
let isPollRunning = false;
let lastReportedPhase: string | undefined;
let lastReportedStep: string | undefined;

export function resetLifecycleStateForTests(): void {
  launchPromise = undefined;
  activeContext = undefined;
  observerTimer = undefined;
  observingInstallation = false;
  dashboardPending = false;
  isPollRunning = false;
  lastReportedPhase = undefined;
  lastReportedStep = undefined;
}

export function getLifecycleStateForTests(): {
  observingInstallation: boolean;
  dashboardPending: boolean;
  isPollRunning: boolean;
  hasObserverTimer: boolean;
} {
  return {
    observingInstallation,
    dashboardPending,
    isPollRunning,
    hasObserverTimer: observerTimer !== undefined,
  };
}

export async function ensureInstaller(
  home: string,
  options?: {
    pluginRoot?: string;
    diagnostics?: DiagnosticLog;
  },
): Promise<EnsureInstallerResult> {
  if (launchPromise) {
    return launchPromise;
  }

  const root = options?.pluginRoot ?? pluginRoot();
  const diag = options?.diagnostics ?? new DiagnosticLog(home);

  launchPromise = (async () => {
    try {
      const store = new StateStore(home);
      const state = await store.load();
      const lock = await inspectInstallLock(home);

      if (state.phase === "ready") {
        return { status: "ready", state };
      }

      if (lock.kind === "active" || lock.kind === "initializing") {
        await diag.log({
          level: "info",
          component: "extension",
          event: "installer.ensure.running",
          phase: state.phase,
          step: state.install?.step,
          pid: lock.kind === "active" ? lock.owner.pid : undefined,
        });
        return { status: "running", state, lock };
      }

      const instPath = installerPath(root);
      if (!(await pathExists(instPath))) {
        const reason = `installer script missing at ${instPath}`;
        await diag.log({
          level: "error",
          component: "extension",
          event: "installer.ensure.unavailable",
          phase: state.phase,
          error: reason,
        });
        return { status: "unavailable", state, reason };
      }

      const isInterrupted =
        state.phase === "downloading" ||
        state.phase === "installing-python" ||
        state.phase === "installing-mega-tron" ||
        state.phase === "warming";

      await mkdir(join(home, "logs"), { recursive: true });
      const pid = launchInstaller(home, root);
      if (!pid) {
        const reason = "failed to spawn installer process";
        await diag.log({
          level: "error",
          component: "extension",
          event: "installer.ensure.unavailable",
          phase: state.phase,
          error: reason,
        });
        return { status: "unavailable", state, reason };
      }

      const event = isInterrupted
        ? "installer.ensure.restarted"
        : "installer.ensure.started";
      await diag.log({
        level: "info",
        component: "extension",
        event,
        phase: state.phase,
        step: state.install?.step,
        pid,
      });

      return { status: "started", state, pid };
    } finally {
      launchPromise = undefined;
    }
  })();

  return launchPromise;
}

function appendHints(systemPrompt: string[], names: string[]): string[] {
  if (!names.length) return systemPrompt;
  return [
    ...systemPrompt,
    `<omp-skill-kit>Relevant skills: ${names.join(", ")}</omp-skill-kit>`,
  ];
}

export function helpText(home: string): string {
  const paths = getComponentLogPaths(home);
  return [
    `${PLUGIN_NAME} — Background Semantic Skill Routing`,
    "",
    "Commands:",
    `  /${PLUGIN_NAME}:status     Show runtime status, install lock, and bridge connectivity`,
    `  /${PLUGIN_NAME}:setup      Install or repair the local routing runtime`,
    `  /${PLUGIN_NAME}:doctor     Check runtime, bridge, lock, and catalog health`,
    `  /${PLUGIN_NAME}:dashboard  Open local routing dashboard (auto-queued during setup)`,
    `  /${PLUGIN_NAME}:purge      Remove runtime data and stop background processes (--confirm required)`,
    `  /${PLUGIN_NAME}:help       Show command overview, runtime paths, and troubleshooting`,
    "",
    `Runtime home: ${home}`,
    "Diagnostic logs:",
    `  extension: ${paths.extensionLog}`,
    `  installer: ${paths.installerLog}`,
    `  bridge:    ${paths.bridgeLog}`,
    `  dashboard: ${paths.dashboardLog}`,
    "",
    `Start with /${PLUGIN_NAME}:doctor`,
  ].join("\n");
}

export async function statusText(
  home: string,
  client: RouterClient,
): Promise<string> {
  const store = new StateStore(home);
  const state = await store.load();
  const lock = await inspectInstallLock(home);
  const bridge = state.phase === "ready" && (await client.ping(1500));
  const paths = getComponentLogPaths(home);

  const lockDesc =
    lock.kind === "active"
      ? `active(pid=${lock.owner.pid})`
      : lock.kind === "initializing"
        ? `initializing(${lock.ageMs}ms)`
        : lock.kind;

  const progress =
    state.phase !== "ready"
      ? `; progress=${formatInstallProgress(state, lock.kind === "active" ? lock.owner : undefined)}`
      : "";

  return `${PLUGIN_NAME}: phase=${state.phase}; lock=${lockDesc}; runtime=${state.runtimeHash || "none"}; bridge=${bridge ? "up" : "down"}; idle=${BRIDGE_IDLE_SHUTDOWN_MS / 60000}m${progress}; logs=${paths.logsDir}; help=/${PLUGIN_NAME}:help`;
}

export async function doctorText(
  home: string,
  client: RouterClient,
): Promise<string> {
  const store = new StateStore(home);
  const state = await store.load();
  const lock = await inspectInstallLock(home);
  const bridge = await client.ping(1500);
  const catalog = await new CatalogStore(join(home, "catalogs")).readCatalog(
    state.runtimeHash,
  );
  const paths = getComponentLogPaths(home);

  const lockDesc =
    lock.kind === "active"
      ? `active(pid=${lock.owner.pid})`
      : lock.kind === "initializing"
        ? `initializing(${lock.ageMs}ms)`
        : lock.kind;

  const lastErr = client.lastRouteError() ?? state.errorCode ?? "none";
  const progress =
    state.phase !== "ready"
      ? `; progress=${formatInstallProgress(state, lock.kind === "active" ? lock.owner : undefined)}`
      : "";

  return `${PLUGIN_NAME}: phase=${state.phase}; lock=${lockDesc}; bridge=${bridge ? "up" : "down"}; catalogEntries=${catalog?.size ?? 0}; lastError=${lastErr}${progress}; logs=${paths.logsDir}; help=/${PLUGIN_NAME}:help`;
}

async function openDashboard(
  ctx: ExtensionContext,
  home: string,
  diag: DiagnosticLog,
): Promise<void> {
  try {
    const { ensureDashboard } = await import("./dashboard.js");
    const info = await ensureDashboard(home, pluginRoot(), {
      openBrowser: true,
    });
    if (ctx.hasUI) {
      ctx.ui.notify(
        `${PLUGIN_NAME}: dashboard ${info.reused ? "reused" : "started"} at ${info.url}`,
        "info",
      );
    }
    await diag.log({
      level: "info",
      component: "dashboard",
      event: info.reused ? "dashboard.reused" : "dashboard.started",
      pid: info.pid,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (ctx.hasUI) {
      const logFile = getComponentLogPaths(home).dashboardLog;
      ctx.ui.notify(
        `${PLUGIN_NAME}: dashboard failed: ${msg}; see ${logFile}`,
        "error",
      );
    }
    await diag.log({
      level: "error",
      component: "dashboard",
      event: "dashboard.failed",
      error: msg,
    });
  }
}

export function startObserverTimer(
  ctx: ExtensionContext,
  home: string,
  diag: DiagnosticLog,
): void {
  activeContext = ctx;
  if (observerTimer) {
    ctx.clearTimer(observerTimer);
    observerTimer = undefined;
  }

  const poll = async () => {
    if (isPollRunning) return;
    isPollRunning = true;
    try {
      const store = new StateStore(home);
      const state = await store.load();
      const lock = await inspectInstallLock(home);

      if (
        state.phase !== lastReportedPhase ||
        state.install?.step !== lastReportedStep
      ) {
        lastReportedPhase = state.phase;
        lastReportedStep = state.install?.step;
        await diag.log({
          level: "info",
          component: "extension",
          event: "installer.phase.changed",
          phase: state.phase,
          step: state.install?.step,
        });
      }

      if (state.phase === "ready") {
        if (observerTimer && activeContext) {
          activeContext.clearTimer(observerTimer);
          observerTimer = undefined;
        }
        if (ctx.hasUI) {
          ctx.ui.setStatus("omp-skill-kit-install", undefined);
          if (observingInstallation) {
            ctx.ui.notify(`${PLUGIN_NAME}: automatic setup complete`, "info");
          }
        }
        await diag.log({
          level: "info",
          component: "extension",
          event: "installer.phase.ready",
          phase: "ready",
          pid: state.pid,
        });
        observingInstallation = false;
        if (dashboardPending) {
          dashboardPending = false;
          await openDashboard(ctx, home, diag);
        }
        return;
      }

      if (state.phase === "degraded") {
        if (observerTimer && activeContext) {
          activeContext.clearTimer(observerTimer);
          observerTimer = undefined;
        }
        if (ctx.hasUI) {
          ctx.ui.setStatus("omp-skill-kit-install", undefined);
          const err = state.errorCode || "unknown error";
          const logFile = getComponentLogPaths(home).installerLog;
          ctx.ui.notify(
            `${PLUGIN_NAME}: automatic setup failed: ${err}; see ${logFile}`,
            "error",
          );
        }
        await diag.log({
          level: "error",
          component: "extension",
          event: "installer.phase.failed",
          phase: "degraded",
          error: state.errorCode,
        });
        observingInstallation = false;
        dashboardPending = false;
        return;
      }

      if (lock.kind === "active" || lock.kind === "initializing") {
        observingInstallation = true;
        if (ctx.hasUI) {
          const owner = lock.kind === "active" ? lock.owner : undefined;
          const progressText = formatInstallProgress(state, owner);
          ctx.ui.setStatus("omp-skill-kit-install", progressText);
        }
        return;
      }

      const isInterrupted =
        state.phase === "downloading" ||
        state.phase === "installing-python" ||
        state.phase === "installing-mega-tron" ||
        state.phase === "warming";

      if (isInterrupted) {
        const launchRes = await ensureInstaller(home, { diagnostics: diag });
        if (launchRes.status === "started") {
          observingInstallation = true;
          if (ctx.hasUI) {
            ctx.ui.notify(
              `${PLUGIN_NAME}: interrupted setup restarted automatically`,
              "warning",
            );
            const progressText = formatInstallProgress(launchRes.state);
            ctx.ui.setStatus("omp-skill-kit-install", progressText);
          }
        } else if (launchRes.status === "unavailable") {
          if (observerTimer && activeContext) {
            activeContext.clearTimer(observerTimer);
            observerTimer = undefined;
          }
          if (ctx.hasUI) {
            ctx.ui.setStatus("omp-skill-kit-install", undefined);
            ctx.ui.notify(
              `${PLUGIN_NAME}: setup unavailable: ${launchRes.reason}; see ${getComponentLogPaths(home).extensionLog}`,
              "error",
            );
          }
          observingInstallation = false;
          dashboardPending = false;
        }
      }
    } catch (err) {
      console.error("[omp-skill-kit] Observer poll error:", err);
    } finally {
      isPollRunning = false;
    }
  };

  observerTimer = ctx.setInterval(async () => {
    await poll();
  }, 2_000);
}

export async function startOrObserveInstallation(
  ctx: ExtensionContext,
  home: string,
  diag: DiagnosticLog = new DiagnosticLog(home),
): Promise<void> {
  const res = await ensureInstaller(home, { diagnostics: diag });

  if (res.status === "ready") {
    if (observerTimer && activeContext) {
      activeContext.clearTimer(observerTimer);
      observerTimer = undefined;
    }
    if (ctx.hasUI) {
      ctx.ui.setStatus("omp-skill-kit-install", undefined);
    }
    if (dashboardPending) {
      dashboardPending = false;
      await openDashboard(ctx, home, diag);
    }
    return;
  }

  if (res.status === "started" || res.status === "running") {
    observingInstallation = true;
    if (ctx.hasUI) {
      const lockOwner: InstallLockOwner | undefined =
        res.status === "running" && res.lock.kind === "active"
          ? res.lock.owner
          : undefined;
      const progressText = formatInstallProgress(res.state, lockOwner);
      ctx.ui.setStatus("omp-skill-kit-install", progressText);
    }
    startObserverTimer(ctx, home, diag);
    return;
  }

  if (res.status === "unavailable") {
    if (observerTimer && activeContext) {
      activeContext.clearTimer(observerTimer);
      observerTimer = undefined;
    }
    if (ctx.hasUI) {
      ctx.ui.setStatus("omp-skill-kit-install", undefined);
      ctx.ui.notify(
        `${PLUGIN_NAME}: setup unavailable: ${res.reason}; see ${getComponentLogPaths(home).extensionLog}`,
        "error",
      );
    }
    observingInstallation = false;
    dashboardPending = false;
  }
}

async function commandStatus(
  home: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  ctx.ui.notify(
    await statusText(home, new RouterClient(home, pluginRoot())),
    "info",
  );
}

async function commandSetup(
  home: string,
  ctx: ExtensionCommandContext,
  diag: DiagnosticLog,
): Promise<void> {
  const res = await ensureInstaller(home, { diagnostics: diag });
  if (res.status === "ready") {
    ctx.ui.notify(`${PLUGIN_NAME}: runtime is already ready`, "info");
    return;
  }
  if (res.status === "running") {
    const owner = res.lock.kind === "active" ? res.lock.owner : undefined;
    const progress = formatInstallProgress(res.state, owner);
    ctx.ui.notify(
      `${PLUGIN_NAME}: automatic setup is already running (${progress})`,
      "info",
    );
    startObserverTimer(ctx, home, diag);
    return;
  }
  if (res.status === "started") {
    ctx.ui.notify(
      `${PLUGIN_NAME}: automatic setup started (${res.pid})`,
      "info",
    );
    startObserverTimer(ctx, home, diag);
    return;
  }
  if (res.status === "unavailable") {
    const logPath = getComponentLogPaths(home).extensionLog;
    ctx.ui.notify(
      `${PLUGIN_NAME}: setup unavailable: ${res.reason}; see ${logPath}`,
      "error",
    );
  }
}

async function commandDoctor(
  home: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const client = new RouterClient(home, pluginRoot());
  const bridge = await client.ping(1500);
  ctx.ui.notify(await doctorText(home, client), bridge ? "info" : "warning");
}

async function commandPurge(
  args: string,
  home: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!args.split(/\s+/).includes("--confirm")) {
    ctx.ui.notify(
      `${PLUGIN_NAME}: use /${PLUGIN_NAME}:purge --confirm`,
      "warning",
    );
    return;
  }
  if (observerTimer && activeContext) {
    activeContext.clearTimer(observerTimer);
    observerTimer = undefined;
  }
  observingInstallation = false;
  dashboardPending = false;

  const client = new RouterClient(home, pluginRoot());
  try {
    await client.shutdown();
  } catch {}
  try {
    const { stopDashboard } = await import("./dashboard.js");
    await stopDashboard(home);
  } catch {}
  await new Promise((r) => setTimeout(r, 600));
  await rm(home, { recursive: true, force: true });
  ctx.ui.notify(`${PLUGIN_NAME}: runtime data removed`, "info");
}

async function commandDashboard(
  home: string,
  ctx: ExtensionCommandContext,
  diag: DiagnosticLog,
): Promise<void> {
  const store = new StateStore(home);
  const state = await store.load();
  if (state.phase === "ready") {
    await openDashboard(ctx, home, diag);
    return;
  }

  dashboardPending = true;
  void startOrObserveInstallation(ctx, home, diag).catch((err) => {
    console.error(
      "[omp-skill-kit] Failed to start installation for dashboard:",
      err,
    );
  });

  const lock = await inspectInstallLock(home);
  const progress = formatInstallProgress(
    state,
    lock.kind === "active" ? lock.owner : undefined,
  );
  ctx.ui.notify(
    `${progress}; dashboard will open automatically when ready`,
    "info",
  );
  await diag.log({
    level: "info",
    component: "dashboard",
    event: "dashboard.queued",
    phase: state.phase,
  });
}

async function commandHelp(
  home: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  ctx.ui.notify(helpText(home), "info");
}

function logFailOpen(err: unknown): void {
  console.error("[omp-skill-kit] Lifecycle background error:", err);
}

export default function extension(pi: ExtensionAPI): void {
  const home = homePath();
  const diag = new DiagnosticLog(home);
  const client = new RouterClient(home, pluginRoot());
  const catalogs = new CatalogStore(join(home, "catalogs"));

  pi.on("session_start", async (_event, ctx) => {
    await startOrObserveInstallation(ctx, home, diag).catch(logFailOpen);
  });

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setStatus("omp-skill-kit-route", undefined);
    }
    try {
      const store = new StateStore(home);
      const state = await store.load();
      if (state.phase !== "ready") {
        await startOrObserveInstallation(ctx, home, diag).catch(logFailOpen);
        await diag.log({
          level: "info",
          component: "router",
          event: "route.unavailable",
          phase: state.phase,
        });
        return;
      }

      const entries = await loadEligibleCatalog(ctx.cwd);
      const snapshot = await catalogs.publish(entries);
      const pHash = promptHash(event.prompt);
      const result = await client.rank({
        prompt: event.prompt,
        promptHash: pHash,
        catalogHash: snapshot.revision,
        catalogPath: join(home, "catalogs", snapshot.revision, "catalog.json"),
        topK: 3,
        sessionId:
          ctx.sessionManager &&
          typeof ctx.sessionManager.getSessionId === "function"
            ? ctx.sessionManager.getSessionId()
            : "ephemeral",
      });

      if (result.unavailable) {
        await diag.log({
          level: "warn",
          component: "router",
          event: "route.unavailable",
          promptHash: pHash,
          error: client.lastRouteError() ?? "router unavailable",
        });
        return;
      }

      if (!result.names.length) {
        await diag.log({
          level: "info",
          component: "router",
          event: "route.empty",
          promptHash: pHash,
        });
        return;
      }

      await diag.log({
        level: "info",
        component: "router",
        event: "route.matched",
        promptHash: pHash,
        names: result.names,
      });

      if (ctx.hasUI) {
        ctx.ui.setStatus(
          "omp-skill-kit-route",
          `omp-skill-kit: skills ${result.names.join(", ")}`,
        );
      }

      return { systemPrompt: appendHints(event.systemPrompt, result.names) };
    } catch (e) {
      await diag.log({
        level: "error",
        component: "router",
        event: "route.failed",
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
  });

  pi.registerCommand("omp-skill-kit:status", {
    description: "Show omp-skill-kit runtime status",
    handler: (_args, ctx) => commandStatus(home, ctx),
  });
  pi.registerCommand("omp-skill-kit:setup", {
    description: "Install or repair the local routing runtime",
    handler: (_args, ctx) => commandSetup(home, ctx, diag),
  });
  pi.registerCommand("omp-skill-kit:doctor", {
    description: "Check runtime, bridge, and catalog health",
    handler: (_args, ctx) => commandDoctor(home, ctx),
  });
  pi.registerCommand("omp-skill-kit:purge", {
    description: "Remove runtime data (requires --confirm)",
    handler: (args, ctx) => commandPurge(args, home, ctx),
  });
  pi.registerCommand("omp-skill-kit:dashboard", {
    description: "Open local routing dashboard",
    handler: (_args, ctx) => commandDashboard(home, ctx, diag),
  });
  pi.registerCommand("omp-skill-kit:help", {
    description: "Show command overview and diagnostic log paths",
    handler: (_args, ctx) => commandHelp(home, ctx),
  });
}
