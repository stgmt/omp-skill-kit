import { randomUUID } from "node:crypto";
import { argv } from "node:process";
import type { ProposalRun } from "./proposals/domain.js";
import { SkillOptProcess } from "./proposals/process.js";
import { ProposalRepository } from "./proposals/repository.js";
import { sha256Hex } from "./shared/fsx.js";
import {
  acquireProcessLock,
  isProcessAlive,
  type ProcessLockOwner,
  releaseProcessLock,
} from "./shared/process-lock.js";

function parseArgs(): {
  home: string;
  pluginRoot: string;
  python: string;
  projectId: string;
  projectRoot: string;
  profileRoot: string;
  model: string;
  fallbackModels: string[];
} {
  const args = argv.slice(2);
  const flags: Record<string, string> = {};
  const fallbackModels: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--fallback-model" && i + 1 < args.length) {
      fallbackModels.push(args[++i]);
      continue;
    }
    if (arg.startsWith("--") && i + 1 < args.length) {
      flags[arg.slice(2)] = args[++i];
    }
  }

  const home = flags.home;
  const pluginRoot = flags["plugin-root"];
  const python = flags.python;
  const projectId = flags["project-id"];
  const projectRoot = flags["project-root"];
  const profileRoot = flags["profile-root"];
  const model = flags.model;

  if (
    !home ||
    !pluginRoot ||
    !python ||
    !projectId ||
    !projectRoot ||
    !profileRoot ||
    !model
  ) {
    throw new Error(
      "Missing required flags: --home, --plugin-root, --python, --project-id, --project-root, --profile-root, --model",
    );
  }

  return {
    home,
    pluginRoot,
    python,
    projectId,
    projectRoot,
    profileRoot,
    model,
    fallbackModels,
  };
}

export async function runProposalWorker(): Promise<void> {
  const options = parseArgs();
  const repo = new ProposalRepository(options.home);
  const lockDir = repo.runLockDir(options.projectId);
  const token = randomUUID();
  const owner: ProcessLockOwner = {
    pid: process.pid,
    token,
    startedAt: new Date().toISOString(),
  };

  const acquired = await acquireProcessLock(lockDir, owner);
  if (!acquired) {
    return;
  }

  try {
    // 1. Stale-run reconciliation: find running runs with dead PID
    try {
      const runs = await repo.listRuns(options.projectId);
      for (const r of runs) {
        if (r.status === "running" && !isProcessAlive(r.pid)) {
          r.status = "failed";
          r.completedAt = new Date().toISOString();
          r.error = "Worker process died unexpectedly";
          await repo.recordRun(options.projectId, r);

          for (const sId of r.sessionIds) {
            await repo.recordOutcome(options.projectId, {
              sessionId: sId,
              sessionHash: sha256Hex(sId),
              runId: r.runId,
              outcome: "failed",
              recordedAt: r.completedAt,
              error: "Worker process died unexpectedly",
            });
          }

          await repo.updateSchedule(options.projectId, {
            schemaVersion: 1,
            lastRunAt: r.startedAt,
            lastRunId: r.runId,
            lastStatus: "failed",
          });
        }
      }
    } catch (reconcileErr) {
      console.error("[proposal-worker] Reconciliation error:", reconcileErr);
    }

    // 2. Re-check execution conditions
    const config = await repo.getUserConfig();
    if (!config.enabled) {
      return;
    }

    const schedule = await repo.getSchedule(options.projectId);
    if (schedule?.lastRunAt) {
      const elapsed = Date.now() - Date.parse(schedule.lastRunAt);
      const minIntervalMs = (config.minimumIntervalHours || 24) * 3600 * 1000;
      if (elapsed < minIntervalMs) {
        return;
      }
    }

    const batchSize = Math.max(1, config.batchSize ?? 1);
    const pending = await repo.getPendingSessions(
      options.projectId,
      options.profileRoot,
    );
    if (pending.length < batchSize) {
      return;
    }

    // 3. Authoritative selection: take newest sessions up to batchSize
    const batch = pending.slice(0, batchSize);

    // 4. Create run record with status running before model call
    const runId = randomUUID();
    const startedAt = new Date().toISOString();
    const runRecord: ProposalRun = {
      runId,
      projectId: options.projectId,
      projectRoot: options.projectRoot,
      profileRoot: options.profileRoot,
      model: options.model,
      sessionIds: batch.map((s) => s.sessionId),
      sessionPaths: batch.map((s) => s.sessionFile),
      startedAt,
      pid: process.pid,
      status: "running",
    };

    await repo.recordRun(options.projectId, runRecord);
    await repo.updateSchedule(options.projectId, {
      schemaVersion: 1,
      lastRunAt: startedAt,
      lastRunId: runId,
      lastStatus: "running",
    });

    // 5. Execute SkillOpt
    const proc = new SkillOptProcess({
      home: options.home,
      pluginRoot: options.pluginRoot,
      python: options.python,
    });

    const result = await proc.run(
      {
        projectId: options.projectId,
        projectRoot: options.projectRoot,
        profileRoot: options.profileRoot,
        model: options.model,
        sessions: batch,
      },
      options.fallbackModels,
    );
    runRecord.model = result.model ?? runRecord.model;

    // 6. Record final outcomes and update schedule
    const completedAt = new Date().toISOString();
    runRecord.completedAt = completedAt;
    runRecord.status = result.outcome;
    runRecord.error = result.error;
    await repo.recordRun(options.projectId, runRecord);

    for (const session of batch) {
      await repo.recordOutcome(options.projectId, {
        sessionId: session.sessionId,
        sessionHash: session.sessionHash,
        runId,
        outcome: result.outcome,
        recordedAt: completedAt,
        error: result.error,
      });
    }

    await repo.updateSchedule(options.projectId, {
      schemaVersion: 1,
      lastRunAt: startedAt,
      lastRunId: runId,
      lastStatus: result.outcome,
    });
  } finally {
    await releaseProcessLock(lockDir, token);
  }
}

if (process.argv[1]?.endsWith("proposal-worker.js")) {
  runProposalWorker().catch((err) => {
    console.error("[proposal-worker] Fatal error:", err);
    process.exit(1);
  });
}
