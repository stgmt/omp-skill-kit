import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  CompletedSession,
  ProposalRun,
  SessionOutcomeRecord,
} from "../../src/proposals/domain.js";
import { ProposalRepository } from "../../src/proposals/repository.js";

const tmpDir = resolve(".tmp", "test-proposals-repo");

describe("ProposalRepository", () => {
  beforeEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates and retrieves baseline idempotently", async () => {
    const repo = new ProposalRepository(tmpDir);
    const projectId = "test-proj-1";

    expect(await repo.getBaseline(projectId)).toBeUndefined();

    const created = await repo.ensureBaseline(projectId);
    expect(created.schemaVersion).toBe(1);
    expect(created.baselineAt).toBeDefined();

    const fetched = await repo.getBaseline(projectId);
    expect(fetched?.baselineAt).toBe(created.baselineAt);

    const secondEnsure = await repo.ensureBaseline(projectId);
    expect(secondEnsure.baselineAt).toBe(created.baselineAt);
  });

  it("records completed sessions immutably", async () => {
    const repo = new ProposalRepository(tmpDir);
    const projectId = "test-proj-2";
    await repo.ensureBaseline(projectId);

    const session: CompletedSession = {
      sessionId: "sess-1",
      sessionHash: "hash-sess-1",
      sessionFile: "/path/to/sess-1.jsonl",
      projectId,
      projectRoot: "/path/to/project",
      profileRoot: "/path/to/profile",
      startedAt: "2026-09-05T01:00:00.000Z",
      completedAt: "2026-09-05T01:10:00.000Z",
    };

    const first = await repo.recordCompletedSession(session);
    expect(first).toBe(true);

    // Duplicate session completion / resume must not overwrite or error; returns false
    const duplicate = await repo.recordCompletedSession({
      ...session,
      completedAt: "2026-09-05T02:00:00.000Z", // attempt to mutate completedAt
    });
    expect(duplicate).toBe(false);

    const stored = await repo.getCompletedSession(projectId, "sess-1");
    expect(stored?.completedAt).toBe("2026-09-05T01:10:00.000Z");
  });

  it("includes pre-baseline history and excludes only decided sessions", async () => {
    const repo = new ProposalRepository(tmpDir);
    const projectId = "test-proj-3";

    // First-seen marker only; start time no longer filters the queue.
    await repo.ensureBaseline(projectId);

    // Session 1: started long before first-seen -> still eligible (backfilled history)
    await repo.recordCompletedSession({
      sessionId: "s-old",
      sessionHash: "hash-s-old",
      sessionFile: "/path/to/s-old.jsonl",
      projectId,
      projectRoot: "/path/to/project",
      profileRoot: "/path/to/profile",
      startedAt: "2026-09-05T01:30:00.000Z",
      completedAt: "2026-09-05T02:05:00.000Z",
    });

    // Session 2: completed at 02:20:00 -> eligible
    await repo.recordCompletedSession({
      sessionId: "s-new-1",
      sessionHash: "hash-s-new-1",
      sessionFile: "/path/to/s-new-1.jsonl",
      projectId,
      projectRoot: "/path/to/project",
      profileRoot: "/path/to/profile",
      startedAt: "2026-09-05T02:10:00.000Z",
      completedAt: "2026-09-05T02:20:00.000Z",
    });

    // Session 3: completed at 02:40:00 -> eligible (newer)
    await repo.recordCompletedSession({
      sessionId: "s-new-2",
      sessionHash: "hash-s-new-2",
      sessionFile: "/path/to/s-new-2.jsonl",
      projectId,
      projectRoot: "/path/to/project",
      profileRoot: "/path/to/profile",
      startedAt: "2026-09-05T02:30:00.000Z",
      completedAt: "2026-09-05T02:40:00.000Z",
    });

    // Session 4: has outcome recorded -> permanently excluded
    await repo.recordCompletedSession({
      sessionId: "s-with-outcome",
      sessionHash: "hash-s-with-outcome",
      sessionFile: "/path/to/s-with-outcome.jsonl",
      projectId,
      projectRoot: "/path/to/project",
      profileRoot: "/path/to/profile",
      startedAt: "2026-09-05T02:50:00.000Z",
      completedAt: "2026-09-05T03:00:00.000Z",
    });
    const outcome: SessionOutcomeRecord = {
      sessionId: "s-with-outcome",
      sessionHash: "hash-s-with-outcome",
      runId: "run-1",
      outcome: "analyzed",
      recordedAt: "2026-09-05T03:05:00.000Z",
    };
    await repo.recordOutcome(projectId, outcome);

    const pending = await repo.getPendingSessions(projectId);
    expect(pending.length).toBe(3);
    // Newest first by completedAt: s-new-2 (02:40), s-new-1 (02:20), s-old (02:05)
    expect(pending[0].sessionId).toBe("s-new-2");
    expect(pending[1].sessionId).toBe("s-new-1");
    expect(pending[2].sessionId).toBe("s-old");
  });

  it("handles runs, schedule, and resolutions", async () => {
    const repo = new ProposalRepository(tmpDir);
    const projectId = "test-proj-4";

    const run: ProposalRun = {
      runId: "run-123",
      projectId,
      projectRoot: "/proj",
      profileRoot: "/prof",
      model: "test-model",
      sessionIds: ["s1", "s2", "s3", "s4", "s5"],
      sessionPaths: ["/p1", "/p2", "/p3", "/p4", "/p5"],
      startedAt: "2026-09-05T04:00:00.000Z",
      pid: 9999,
      status: "running",
    };
    await repo.recordRun(projectId, run);
    const fetchedRun = await repo.getRun(projectId, "run-123");
    expect(fetchedRun?.status).toBe("running");

    // Schedule
    expect(await repo.getSchedule(projectId)).toBeUndefined();
    await repo.updateSchedule(projectId, {
      schemaVersion: 1,
      lastRunAt: "2026-09-05T04:00:00.000Z",
      lastRunId: "run-123",
      lastStatus: "running",
    });
    const schedule = await repo.getSchedule(projectId);
    expect(schedule?.lastRunId).toBe("run-123");

    // Resolutions
    await repo.recordResolution(projectId, {
      proposalId: "prop-1",
      decision: "discarded",
      resolvedAt: "2026-09-05T04:30:00.000Z",
      reason: "Not relevant",
    });
    const resolution = await repo.getResolution(projectId, "prop-1");
    expect(resolution?.decision).toBe("discarded");
  });
});
