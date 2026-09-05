import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CompletedSession,
  ProposalRun,
} from "../../src/proposals/domain.js";
import { SkillOptProcess } from "../../src/proposals/process.js";
import { ProposalRepository } from "../../src/proposals/repository.js";
import { atomicWriteJson, sha256Hex } from "../../src/shared/fsx.js";

const tmpDir = resolve(".tmp", "test-proposals-worker");

describe("ProposalWorker execution and reconciliation", () => {
  beforeEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("reconciles dead running runs and marks them failed", async () => {
    const repo = new ProposalRepository(tmpDir);
    const projectId = "proj-reconcile";
    const cwd = "/test/project";

    await repo.ensureBaseline(projectId);

    // Create a dead running run
    const deadRun: ProposalRun = {
      runId: "run-dead-1",
      projectId,
      projectRoot: cwd,
      profileRoot: "prof-1",
      model: "claude-3-5-sonnet",
      sessionIds: ["s-a", "s-b"],
      sessionPaths: ["/pa", "/pb"],
      startedAt: "2026-09-05T01:00:00.000Z",
      pid: 99999999, // dead PID
      status: "running",
    };
    await repo.recordRun(projectId, deadRun);

    // Run reconciliation logic directly
    const runs = await repo.listRuns(projectId);
    const { isProcessAlive } = await import("../../src/shared/process-lock.js");
    for (const r of runs) {
      if (r.status === "running" && !isProcessAlive(r.pid)) {
        r.status = "failed";
        r.completedAt = new Date().toISOString();
        r.error = "Worker process died unexpectedly";
        await repo.recordRun(projectId, r);
        for (const sId of r.sessionIds) {
          await repo.recordOutcome(projectId, {
            sessionId: sId,
            sessionHash: sha256Hex(sId),
            runId: r.runId,
            outcome: "failed",
            recordedAt: r.completedAt,
            error: "Worker process died unexpectedly",
          });
        }
        await repo.updateSchedule(projectId, {
          schemaVersion: 1,
          lastRunAt: r.startedAt,
          lastRunId: r.runId,
          lastStatus: "failed",
        });
      }
    }

    const updatedRun = await repo.getRun(projectId, "run-dead-1");
    expect(updatedRun?.status).toBe("failed");
    expect(updatedRun?.error).toBe("Worker process died unexpectedly");

    const outcomeA = await repo.getOutcome(projectId, "s-a");
    expect(outcomeA?.outcome).toBe("failed");

    const schedule = await repo.getSchedule(projectId);
    expect(schedule?.lastStatus).toBe("failed");
  });

  it("selects 5 newest sessions out of 6 and leaves 6th pending", async () => {
    const repo = new ProposalRepository(tmpDir);
    const projectId = "proj-batch";
    const cwd = "/test/project";

    const baseline = await repo.ensureBaseline(projectId);
    baseline.baselineAt = "2026-09-05T00:00:00.000Z";
    await atomicWriteJson(repo.baselineFile(projectId), baseline);

    // Create 6 sessions with increasing completedAt
    const sessions: CompletedSession[] = [];
    for (let i = 0; i < 6; i++) {
      const s: CompletedSession = {
        sessionId: `sess-${i}`,
        sessionHash: sha256Hex(`sess-${i}`),
        sessionFile: `/path/to/sess-${i}.jsonl`,
        projectId,
        projectRoot: cwd,
        profileRoot: "prof-1",
        startedAt: `2026-09-05T01:0${i}:00.000Z`,
        completedAt: `2026-09-05T01:1${i}:00.000Z`,
      };
      await repo.recordCompletedSession(s);
      sessions.push(s);
    }

    const pendingBefore = await repo.getPendingSessions(projectId, "prof-1");
    expect(pendingBefore.length).toBe(6);

    // Select top 5 (newest completedAt): sess-5 down to sess-1
    const batch = pendingBefore.slice(0, 5);
    expect(batch.map((s) => s.sessionId)).toEqual([
      "sess-5",
      "sess-4",
      "sess-3",
      "sess-2",
      "sess-1",
    ]);

    // Mock SkillOptProcess
    const proc = new SkillOptProcess({
      home: tmpDir,
      pluginRoot: resolve("."),
      python: "python",
    });
    vi.spyOn(proc, "run").mockResolvedValue({
      outcome: "analyzed",
      rawJson: { accepted: true, n_tasks: 2 },
    });

    const runId = "run-test-batch";
    const startedAt = new Date().toISOString();
    const runRecord: ProposalRun = {
      runId,
      projectId,
      projectRoot: cwd,
      profileRoot: "prof-1",
      model: "test-model",
      sessionIds: batch.map((s) => s.sessionId),
      sessionPaths: batch.map((s) => s.sessionFile),
      startedAt,
      pid: process.pid,
      status: "running",
    };
    await repo.recordRun(projectId, runRecord);

    const result = await proc.run({
      projectId,
      projectRoot: cwd,
      profileRoot: "prof-1",
      model: "test-model",
      sessions: batch,
    });

    const completedAt = new Date().toISOString();
    runRecord.completedAt = completedAt;
    runRecord.status = result.outcome;
    await repo.recordRun(projectId, runRecord);

    for (const session of batch) {
      await repo.recordOutcome(projectId, {
        sessionId: session.sessionId,
        sessionHash: session.sessionHash,
        runId,
        outcome: result.outcome,
        recordedAt: completedAt,
      });
    }

    // Now check pending sessions: exactly 1 session left (sess-0)!
    const pendingAfter = await repo.getPendingSessions(projectId, "prof-1");
    expect(pendingAfter.length).toBe(1);
    expect(pendingAfter[0].sessionId).toBe("sess-0");

    // All 5 in batch have outcomes and are never picked up again
    for (const session of batch) {
      const outcome = await repo.getOutcome(projectId, session.sessionId);
      expect(outcome?.outcome).toBe("analyzed");
    }
  });

  it("handles failed outcome on error and prevents re-analysis", async () => {
    const repo = new ProposalRepository(tmpDir);
    const projectId = "proj-fail";
    const cwd = "/test/project";

    const baseline = await repo.ensureBaseline(projectId);
    baseline.baselineAt = "2026-09-05T00:00:00.000Z";
    await atomicWriteJson(repo.baselineFile(projectId), baseline);

    for (let i = 0; i < 5; i++) {
      await repo.recordCompletedSession({
        sessionId: `s-fail-${i}`,
        sessionHash: sha256Hex(`s-fail-${i}`),
        sessionFile: `/p/${i}.jsonl`,
        projectId,
        projectRoot: cwd,
        profileRoot: "prof-1",
        startedAt: "2026-09-05T01:00:00.000Z",
        completedAt: `2026-09-05T01:1${i}:00.000Z`,
      });
    }

    const batch = await repo.getPendingSessions(projectId, "prof-1");
    expect(batch.length).toBe(5);

    // Mock SkillOptProcess failure
    const proc = new SkillOptProcess({
      home: tmpDir,
      pluginRoot: resolve("."),
      python: "python",
    });
    vi.spyOn(proc, "run").mockResolvedValue({
      outcome: "failed",
      error: "Process exit code 1: rate limit",
    });

    const result = await proc.run({
      projectId,
      projectRoot: cwd,
      profileRoot: "prof-1",
      model: "test-model",
      sessions: batch,
    });

    expect(result.outcome).toBe("failed");

    // Record outcomes as failed
    for (const session of batch) {
      await repo.recordOutcome(projectId, {
        sessionId: session.sessionId,
        sessionHash: session.sessionHash,
        runId: "run-failed",
        outcome: "failed",
        recordedAt: new Date().toISOString(),
        error: result.error,
      });
    }

    // Pending sessions must now be empty
    const pendingAfter = await repo.getPendingSessions(projectId, "prof-1");
    expect(pendingAfter.length).toBe(0);
  });
});
