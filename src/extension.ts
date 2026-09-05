import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionStopEvent,
  ToolResultEvent,
} from "@oh-my-pi/pi-coding-agent";
import { CatalogStore, loadEligibleCatalog } from "./catalog.js";
import { DiagnosticLog, getComponentLogPaths } from "./diagnostics.js";
import {
  type InstallLockOwner,
  type InstallLockState,
  inspectInstallLock,
} from "./install-lock.js";
import { adoptProposal, discardProposal } from "./proposals/adoption.js";
import {
  maybeBackfillProjectSessions,
  resolveProfileSessionsRoot,
} from "./proposals/backfill.js";
import type { CompletedSession, Proposal } from "./proposals/domain.js";
import { ProposalRepository } from "./proposals/repository.js";
import { ProposalScanner } from "./proposals/scanner.js";
import { ProposalService } from "./proposals/service.js";
import { validateAndParseSessionFile } from "./proposals/session-source.js";
import { promptHash, RouterClient } from "./router-client.js";
import {
  formatInstallProgress,
  type RuntimeState,
  StateStore,
} from "./runtime.js";
import { BRIDGE_IDLE_SHUTDOWN_MS, PLUGIN_NAME } from "./shared/constants.js";
import { pathExists } from "./shared/fsx.js";
import { spawnDetached } from "./shared/spawn.js";
import {
  type FeedbackVerdict,
  parseFeedbackMarkers,
  projectIdentity,
  skillWasRead,
  TelemetryStore,
} from "./telemetry.js";

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
let proposalsTimer: ManagedTimer | undefined;
let observingInstallation = false;
let dashboardPending = false;
let isPollRunning = false;
let lastReportedPhase: string | undefined;
let lastReportedStep: string | undefined;

type PendingRoute = {
  routeId: string;
  projectId: string;
  projectName: string;
  sessionId: string;
  turnId: string;
  catalogRevision: string;
  selected: string[];
  used: Set<string>;
  toolErrors: number;
};

const pendingRoutes = new Map<string, PendingRoute>();

export function resetLifecycleStateForTests(): void {
  launchPromise = undefined;
  activeContext = undefined;
  observerTimer = undefined;
  observingInstallation = false;
  dashboardPending = false;
  isPollRunning = false;
  lastReportedPhase = undefined;
  lastReportedStep = undefined;
  pendingRoutes.clear();
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

export async function updateProposalsStatusline(
  ctx: ExtensionContext | ExtensionCommandContext,
  home: string,
  diag?: DiagnosticLog,
): Promise<Proposal[]> {
  if (!ctx.cwd) return [];
  const project = projectIdentity(ctx.cwd);
  const repo = new ProposalRepository(home);
  const scanner = new ProposalScanner(repo);

  try {
    const proposals = await scanner.scanProjectProposals(ctx.cwd, project.id);
    const count = proposals.length;

    if (ctx.hasUI) {
      if (count > 0) {
        ctx.ui.setStatus("omp-skill-kit-proposals", `proposals: ${count}`);
      } else {
        ctx.ui.setStatus("omp-skill-kit-proposals", undefined);
      }
    }

    if (count > 0 && ctx.hasUI) {
      const ledger = await repo.getNotificationLedger(project.id);
      let updatedLedger = false;
      for (const p of proposals) {
        if (!ledger.notifiedProposalIds[p.id]) {
          ledger.notifiedProposalIds[p.id] = new Date().toISOString();
          updatedLedger = true;
          ctx.ui.notify(
            `New skill proposal available: ${p.skillName} (not automatically adopted; review with /${PLUGIN_NAME}:proposals)`,
            "info",
          );
          if (diag) {
            await diag.log({
              level: "info",
              component: "proposals",
              event: "proposal.notified",
              proposalId: p.id,
              skillName: p.skillName,
            });
          }
        }
      }
      if (updatedLedger) {
        await repo.updateNotificationLedger(project.id, ledger);
      }
    }

    return proposals;
  } catch (err) {
    logFailOpen(err);
    return [];
  }
}

export function startProposalsTimer(
  ctx: ExtensionContext,
  home: string,
  diag: DiagnosticLog,
): void {
  if (proposalsTimer) return;
  proposalsTimer = ctx.setInterval(async () => {
    if (activeContext) {
      await updateProposalsStatusline(activeContext, home, diag);
    }
  }, 10_000);
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
    `  /${PLUGIN_NAME}:proposals  Review and adopt or discard SkillOpt proposals`,
    `  /${PLUGIN_NAME}:purge      Remove runtime data and stop background processes (--confirm required)`,
    `  /${PLUGIN_NAME}:help       Show command overview, runtime paths, and troubleshooting`,
    "",
    `Runtime home: ${home}`,
    "Diagnostic logs:",
    `  extension: ${paths.extensionLog}`,
    `  installer: ${paths.installerLog}`,
    `  bridge:    ${paths.bridgeLog}`,
    `  dashboard: ${paths.dashboardLog}`,
    `  worker:    ${paths.proposalWorkerLog}`,
    "",
    `Start with /${PLUGIN_NAME}:doctor`,
  ].join("\n");
}

export async function statusText(
  home: string,
  client: RouterClient,
  cwd?: string,
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

  let proposalSummary = "";
  if (cwd) {
    try {
      const repo = new ProposalRepository(home);
      const projectId = projectIdentity(cwd).id;
      const pendingSessions = await repo.getPendingSessions(projectId);
      const scanner = new ProposalScanner(repo);
      const proposals = await scanner.scanProjectProposals(cwd, projectId);
      const schedule = await repo.getSchedule(projectId);
      const lastOutcome = schedule?.lastStatus ?? "none";
      const config = await repo.getUserConfig();
      const batchSize = Math.max(1, config.batchSize ?? 1);
      proposalSummary = `; proposals=${proposals.length}; sessions=${pendingSessions.length}/${batchSize}; lastRun=${lastOutcome}; workerLog=${paths.proposalWorkerLog}`;
    } catch {
      // ignore
    }
  }

  return `${PLUGIN_NAME}: phase=${state.phase}; lock=${lockDesc}; runtime=${state.runtimeHash || "none"}; bridge=${bridge ? "up" : "down"}; idle=${BRIDGE_IDLE_SHUTDOWN_MS / 60000}m${progress}${proposalSummary}; logs=${paths.logsDir}; help=/${PLUGIN_NAME}:help`;
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

  const proposalsConfig = await pathExists(
    join(home, "proposals", "config.json"),
  );
  return `${PLUGIN_NAME}: phase=${state.phase}; lock=${lockDesc}; bridge=${bridge ? "up" : "down"}; catalogEntries=${catalog?.size ?? 0}; skilloptConfig=${proposalsConfig ? "ok" : "missing"}; lastError=${lastErr}${progress}; logs=${paths.logsDir}; help=/${PLUGIN_NAME}:help`;
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
    if (activeContext) {
      const service = new ProposalService({ home, pluginRoot: pluginRoot() });
      await service
        .schedule({
          cwd: activeContext.cwd,
          model: activeContext.model?.id || "",
        })
        .catch(logFailOpen);
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
    await statusText(home, new RouterClient(home, pluginRoot()), ctx.cwd),
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

async function commandProposals(
  home: string,
  ctx: ExtensionCommandContext,
  diag: DiagnosticLog,
): Promise<void> {
  const repo = new ProposalRepository(home);
  const scanner = new ProposalScanner(repo);
  const projectId = projectIdentity(ctx.cwd).id;

  const proposals = await scanner.scanProjectProposals(ctx.cwd, projectId);
  if (proposals.length === 0) {
    ctx.ui.notify("No proposals available", "info");
    return;
  }

  const options = proposals.map(
    (p) => `${p.skillName} (${p.kind}) [id:${p.id.slice(0, 8)}]`,
  );
  const chosen = await ctx.ui.select("Select a proposal to review:", options);
  if (!chosen) return;

  const selected = proposals.find((p) => chosen.includes(p.id.slice(0, 8)));
  if (!selected) return;

  const reportContent = await readFile(selected.reportPath, "utf8").catch(
    () => "No report available",
  );
  const skillContent = await readFile(selected.proposedSkillPath, "utf8").catch(
    () => "No skill content available",
  );

  const reviewText = `# Proposal: ${selected.skillName} (${selected.kind})\nTarget: ${selected.targetSkillPath}\n\n## Report\n\n${reportContent}\n\n## Proposed SKILL.md\n\n${skillContent}`;

  await ctx.ui.editor("Review proposal — edits are ignored", reviewText);

  const action = await ctx.ui.select(
    `Action for proposal ${selected.skillName}:`,
    ["Adopt", "Discard", "Back"],
  );

  if (action === "Adopt") {
    const confirmed = await ctx.ui.confirm(
      `Adopt ${selected.skillName}`,
      `Target path: ${selected.targetSkillPath}`,
    );
    if (!confirmed) return;

    const service = new ProposalService({
      home,
      pluginRoot: pluginRoot(),
      repo,
    });
    const python = await service.resolveActivePython();
    if (!python) {
      ctx.ui.notify(
        "Managed python runtime not found; run /omp-skill-kit:setup first",
        "error",
      );
      return;
    }

    const adoptRes = await adoptProposal({
      home,
      pluginRoot: pluginRoot(),
      python,
      projectRoot: ctx.cwd,
      proposal: selected,
    });

    if (adoptRes.success) {
      ctx.ui.notify(`Adopted ${selected.skillName} successfully`, "info");
      await diag.log({
        level: "info",
        component: "proposals",
        event: "proposal.adopted",
        proposalId: selected.id,
        skillName: selected.skillName,
      });
      await updateProposalsStatusline(ctx, home, diag);
    } else {
      ctx.ui.notify(`Adoption failed: ${adoptRes.error}`, "error");
      await diag.log({
        level: "error",
        component: "proposals",
        event: "proposal.adopt_failed",
        proposalId: selected.id,
        skillName: selected.skillName,
        error: adoptRes.error,
      });
    }
  } else if (action === "Discard") {
    const confirmed = await ctx.ui.confirm(
      `Discard proposal`,
      `Are you sure you want to discard proposal for ${selected.skillName}?`,
    );
    if (!confirmed) return;

    await discardProposal(
      repo,
      projectId,
      selected.id,
      "User discarded via command",
    );
    ctx.ui.notify(`Proposal ${selected.skillName} discarded`, "info");
    await diag.log({
      level: "info",
      component: "proposals",
      event: "proposal.discarded",
      proposalId: selected.id,
      skillName: selected.skillName,
    });
    await updateProposalsStatusline(ctx, home, diag);
  }
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
  await startOrObserveInstallation(ctx, home, diag).catch((err) => {
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

function currentSessionId(ctx: ExtensionContext): string {
  const manager = ctx.sessionManager as
    | { getSessionId?: () => string }
    | undefined;
  return manager && typeof manager.getSessionId === "function"
    ? manager.getSessionId()
    : "ephemeral";
}

function routeStatus(
  unavailable: boolean,
  names: string[],
  error?: string,
): "matched" | "empty" | "unavailable" | "timeout" {
  if (!unavailable) return names.length ? "matched" : "empty";
  return error?.toLowerCase().includes("timeout") ? "timeout" : "unavailable";
}

async function settleRoute(
  route: PendingRoute,
  messages: unknown[],
  telemetry: TelemetryStore,
  client: RouterClient,
): Promise<void> {
  const markers = parseFeedbackMarkers(messages);
  const used = [...route.used];
  const verdict: FeedbackVerdict =
    used.map((name) => markers.get(name)).find(Boolean) ?? "neutral";
  const outcome = route.toolErrors
    ? "failed"
    : used.length
      ? "completed"
      : "unknown";
  const usage = {
    schemaVersion: 1 as const,
    type: "usage" as const,
    eventId: randomUUID(),
    routeId: route.routeId,
    ts: new Date().toISOString(),
    host: "omp" as const,
    projectId: route.projectId,
    projectName: route.projectName,
    sessionId: route.sessionId,
    turnId: route.turnId,
    catalogRevision: route.catalogRevision,
    used,
    toolErrors: route.toolErrors,
    outcome: outcome as "completed" | "failed" | "unknown",
  };
  await telemetry.append(usage);
  if (used.length === 0) return;
  await telemetry.append({
    ...usage,
    type: "feedback",
    verdict,
    accepted: verdict === "helpful",
  });
  await client.recordFeedback({
    routeId: route.routeId,
    projectId: route.projectId,
    skillNames: used,
    verdict,
  });
}

export default function extension(pi: ExtensionAPI): void {
  const home = homePath();
  const diag = new DiagnosticLog(home);
  const client = new RouterClient(home, pluginRoot());
  const catalogs = new CatalogStore(join(home, "catalogs"));

  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx;
    await startOrObserveInstallation(ctx, home, diag).catch(logFailOpen);
    try {
      const repo = new ProposalRepository(home);
      const projectId = projectIdentity(ctx.cwd).id;
      await repo.ensureBaseline(projectId);
      await maybeBackfillProjectSessions(
        repo,
        projectId,
        resolveProfileSessionsRoot(ctx.sessionManager?.getSessionDir?.()),
        ctx.cwd,
      );
      await updateProposalsStatusline(ctx, home, diag);
      startProposalsTimer(ctx, home, diag);

      const service = new ProposalService({
        home,
        pluginRoot: pluginRoot(),
        repo,
      });
      const currentModel = ctx.model?.id || "";
      await service
        .schedule({
          cwd: ctx.cwd,
          model: currentModel,
        })
        .catch(logFailOpen);
    } catch (err) {
      logFailOpen(err);
    }
  });

  pi.on("session_switch", async (_event, ctx) => {
    activeContext = ctx;
    try {
      const repo = new ProposalRepository(home);
      const projectId = projectIdentity(ctx.cwd).id;
      await repo.ensureBaseline(projectId);
      await maybeBackfillProjectSessions(
        repo,
        projectId,
        resolveProfileSessionsRoot(ctx.sessionManager?.getSessionDir?.()),
        ctx.cwd,
      );
      await updateProposalsStatusline(ctx, home, diag);
      startProposalsTimer(ctx, home, diag);

      const service = new ProposalService({
        home,
        pluginRoot: pluginRoot(),
        repo,
      });
      const currentModel = ctx.model?.id || "";
      await service
        .schedule({
          cwd: ctx.cwd,
          model: currentModel,
        })
        .catch(logFailOpen);
    } catch (err) {
      logFailOpen(err);
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (proposalsTimer && typeof ctx?.clearTimer === "function") {
      ctx.clearTimer(proposalsTimer);
      proposalsTimer = undefined;
    }
    if (ctx.hasUI) {
      ctx.ui.setStatus("omp-skill-kit-proposals", undefined);
    }

    try {
      if (!ctx.sessionManager) return;
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) return;

      const parseResult = await validateAndParseSessionFile(
        sessionFile,
        ctx.cwd,
      );
      if (!parseResult.valid) {
        await diag.log({
          level: "info",
          component: "proposals",
          event: "session.rejected",
          reason: parseResult.reason,
          file: parseResult.sessionFile,
        });
        return;
      }

      const repo = new ProposalRepository(home);
      const completedSession: CompletedSession = {
        sessionId: parseResult.sessionId,
        sessionHash: parseResult.sessionHash,
        sessionFile: parseResult.sessionFile,
        projectId: parseResult.projectId,
        projectRoot: parseResult.projectRoot,
        profileRoot: parseResult.profileRoot,
        startedAt: parseResult.startedAt,
        completedAt: new Date().toISOString(),
      };

      const recorded = await repo.recordCompletedSession(completedSession);
      if (recorded) {
        await diag.log({
          level: "info",
          component: "proposals",
          event: "session.recorded",
          sessionId: parseResult.sessionId,
          projectId: parseResult.projectId,
        });
      }
    } catch (err) {
      logFailOpen(err);
    }
  });

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus("omp-skill-kit-route", undefined);
    const telemetry = new TelemetryStore(home);
    const routeId = randomUUID();
    const sessionId = currentSessionId(ctx);
    const project = projectIdentity(ctx.cwd);
    const startedAt = Date.now();
    try {
      const store = new StateStore(home);
      const state = await store.load();
      if (state.phase !== "ready") {
        await startOrObserveInstallation(ctx, home, diag).catch(logFailOpen);
        await telemetry.append({
          schemaVersion: 1,
          type: "route",
          eventId: randomUUID(),
          routeId,
          ts: new Date().toISOString(),
          host: "omp",
          projectId: project.id,
          projectName: project.name,
          sessionId,
          turnId: routeId,
          catalogRevision: "",
          promptHash: promptHash(event.prompt),
          status: "unavailable",
          reason: state.phase,
          latencyMs: Date.now() - startedAt,
          candidates: [],
          selected: [],
        });
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
        sessionId,
        routeId,
        projectId: project.id,
        projectName: project.name,
      });
      const error = client.lastRouteError();
      await telemetry.append({
        schemaVersion: 1,
        type: "route",
        eventId: randomUUID(),
        routeId,
        ts: new Date().toISOString(),
        host: "omp",
        projectId: project.id,
        projectName: project.name,
        sessionId,
        turnId: routeId,
        catalogRevision: snapshot.revision,
        promptHash: pHash,
        status: routeStatus(result.unavailable, result.names, error),
        reason: error,
        latencyMs: Date.now() - startedAt,
        candidates: result.candidates,
        selected: result.names,
      });

      if (result.unavailable) {
        await diag.log({
          level: "warn",
          component: "router",
          event: "route.unavailable",
          promptHash: pHash,
          error: error ?? "router unavailable",
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
      pendingRoutes.set(sessionId, {
        routeId,
        projectId: project.id,
        projectName: project.name,
        sessionId,
        turnId: routeId,
        catalogRevision: snapshot.revision,
        selected: result.names,
        used: new Set(),
        toolErrors: 0,
      });
      await diag.log({
        level: "info",
        component: "router",
        event: "route.matched",
        promptHash: pHash,
        names: result.names,
      });
      if (ctx.hasUI)
        ctx.ui.setStatus(
          "omp-skill-kit-route",
          `omp-skill-kit: skills ${result.names.join(", ")}`,
        );
      return { systemPrompt: appendHints(event.systemPrompt, result.names) };
    } catch (e) {
      await telemetry.append({
        schemaVersion: 1,
        type: "route",
        eventId: randomUUID(),
        routeId,
        ts: new Date().toISOString(),
        host: "omp",
        projectId: project.id,
        projectName: project.name,
        sessionId,
        turnId: routeId,
        catalogRevision: "",
        promptHash: promptHash(event.prompt),
        status: "failed",
        reason: e instanceof Error ? e.message : String(e),
        latencyMs: Date.now() - startedAt,
        candidates: [],
        selected: [],
      });
      await diag.log({
        level: "error",
        component: "router",
        event: "route.failed",
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }
  });

  pi.on("tool_result", async (event: ToolResultEvent, ctx) => {
    const route = pendingRoutes.get(currentSessionId(ctx));
    if (!route) return;
    if (event.isError) route.toolErrors += 1;
    if (event.toolName !== "read") return;
    const path = typeof event.input.path === "string" ? event.input.path : "";
    for (const name of route.selected)
      if (skillWasRead(path, name)) route.used.add(name);
  });

  pi.on("session_stop", async (event: SessionStopEvent) => {
    try {
      const route = pendingRoutes.get(event.session_id);
      if (!route) return;
      pendingRoutes.delete(event.session_id);
      await settleRoute(
        route,
        event.messages,
        new TelemetryStore(home),
        client,
      );
    } catch (err) {
      logFailOpen(err);
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
  pi.registerCommand("omp-skill-kit:proposals", {
    description: "Review and adopt or discard SkillOpt proposals",
    handler: (_args, ctx) => commandProposals(home, ctx, diag),
  });
  pi.registerCommand("omp-skill-kit:help", {
    description: "Show command overview and diagnostic log paths",
    handler: (_args, ctx) => commandHelp(home, ctx),
  });
}
