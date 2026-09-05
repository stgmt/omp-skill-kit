import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { StateStore } from "../runtime.js";
import { buildXdgEnv } from "../shared/env.js";
import { pathExists } from "../shared/fsx.js";
import { inspectProcessLock, isProcessAlive } from "../shared/process-lock.js";
import { spawnDetached } from "../shared/spawn.js";
import { projectIdentity } from "../telemetry.js";
import { ProposalRepository } from "./repository.js";
import { normalizeProjectPath } from "./session-source.js";

export function launchProposalWorker(
  home: string,
  options: {
    pluginRoot: string;
    python: string;
    projectId: string;
    projectRoot: string;
    profileRoot: string;
    model: string;
  },
): number {
  const logsDir = join(home, "logs");
  mkdirSync(logsDir, { recursive: true });
  const workerPath = join(options.pluginRoot, "dist", "proposal-worker.js");
  const xdgEnv = buildXdgEnv(home);
  return spawnDetached(
    [
      process.execPath,
      workerPath,
      "--home",
      home,
      "--plugin-root",
      options.pluginRoot,
      "--python",
      options.python,
      "--project-id",
      options.projectId,
      "--project-root",
      options.projectRoot,
      "--profile-root",
      options.profileRoot,
      "--model",
      options.model,
    ],
    {
      env: {
        ...(process.env as Record<string, string>),
        ...xdgEnv,
        BUN_BE_BUN: "1",
        OMP_SKILL_KIT_HOME: home,
      },
      logFile: join(logsDir, "proposal-worker.log"),
    },
  );
}

export class ProposalService {
  readonly home: string;
  readonly pluginRoot: string;
  readonly repo: ProposalRepository;

  constructor(options: {
    home: string;
    pluginRoot: string;
    repo?: ProposalRepository;
  }) {
    this.home = options.home;
    this.pluginRoot = options.pluginRoot;
    this.repo = options.repo ?? new ProposalRepository(options.home);
  }

  async resolveActivePython(): Promise<string | undefined> {
    const activePath = join(this.home, "runtime", "active.json");
    if (!(await pathExists(activePath))) {
      return undefined;
    }
    try {
      const active = JSON.parse(await readFile(activePath, "utf8")) as {
        venv?: string;
      };
      if (active.venv && (await pathExists(active.venv))) {
        return active.venv;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  async schedule(params: {
    cwd: string;
    model?: string;
    profileRoot?: string;
  }): Promise<{ scheduled: boolean; pid?: number; reason?: string }> {
    const store = new StateStore(this.home);
    const state = await store.load();
    if (state.phase !== "ready") {
      return { scheduled: false, reason: "runtime_not_ready" };
    }

    const python = await this.resolveActivePython();
    if (!python) {
      return { scheduled: false, reason: "python_not_found" };
    }

    const model = params.model?.trim();
    if (!model) {
      return { scheduled: false, reason: "no_model_selected" };
    }

    const project = projectIdentity(params.cwd);
    const projectRoot = normalizeProjectPath(params.cwd);
    const profileRoot = params.profileRoot || "";

    const config = await this.repo.getUserConfig();
    if (!config.enabled) {
      return { scheduled: false, reason: "proposals_disabled" };
    }

    // Check for reconciliation: running run with dead PID or stale lock
    const runs = await this.repo.listRuns(project.id);
    const hasDeadRunning = runs.some(
      (r) => r.status === "running" && !isProcessAlive(r.pid),
    );
    const lockDir = this.repo.runLockDir(project.id);
    const lockState = await inspectProcessLock(lockDir);
    const hasStaleLock = lockState.kind === "stale";

    if (hasDeadRunning || hasStaleLock) {
      const pid = launchProposalWorker(this.home, {
        pluginRoot: this.pluginRoot,
        python,
        projectId: project.id,
        projectRoot,
        profileRoot,
        model,
      });
      return { scheduled: true, pid, reason: "reconciliation" };
    }

    if (lockState.kind === "active") {
      return { scheduled: false, reason: "worker_already_running" };
    }

    // Check 24-hour interval
    const schedule = await this.repo.getSchedule(project.id);
    if (schedule?.lastRunAt) {
      const elapsed = Date.now() - Date.parse(schedule.lastRunAt);
      const minIntervalMs = (config.minimumIntervalHours || 24) * 3600 * 1000;
      if (elapsed < minIntervalMs) {
        return { scheduled: false, reason: "interval_not_elapsed" };
      }
    }

    // Check pending count >= batchSize
    const batchSize = Math.max(1, config.batchSize ?? 1);
    const pending = await this.repo.getPendingSessions(project.id, profileRoot);
    if (pending.length < batchSize) {
      return { scheduled: false, reason: "insufficient_sessions" };
    }

    const pid = launchProposalWorker(this.home, {
      pluginRoot: this.pluginRoot,
      python,
      projectId: project.id,
      projectRoot,
      profileRoot,
      model,
    });
    return { scheduled: true, pid };
  }
}
