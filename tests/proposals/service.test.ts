import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  CompletedSession,
  ProposalRun,
  ProposalSchedule,
} from "../../src/proposals/domain.js";
import { ProposalService } from "../../src/proposals/service.js";
import { atomicWriteJson } from "../../src/shared/fsx.js";

const tmpDir = resolve(".tmp", "test-proposals-service");

describe("ProposalService", () => {
  beforeEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("does not schedule when runtime state is not ready", async () => {
    const service = new ProposalService({
      home: tmpDir,
      pluginRoot: resolve("."),
    });

    const res = await service.schedule({
      cwd: "/test/project",
      model: "claude-3-5-sonnet",
    });
    expect(res.scheduled).toBe(false);
    expect(res.reason).toBe("runtime_not_ready");
  });

  it("does not schedule when active python is missing", async () => {
    const service = new ProposalService({
      home: tmpDir,
      pluginRoot: resolve("."),
    });

    // Write ready state
    await atomicWriteJson(join(tmpDir, "state.json"), {
      schemaVersion: 1,
      phase: "ready",
      attempts: 0,
      generation: 1,
      updatedAt: new Date().toISOString(),
    });

    const res = await service.schedule({
      cwd: "/test/project",
      model: "claude-3-5-sonnet",
    });
    expect(res.scheduled).toBe(false);
    expect(res.reason).toBe("python_not_found");
  });

  it("does not schedule when no model is selected", async () => {
    const service = new ProposalService({
      home: tmpDir,
      pluginRoot: resolve("."),
    });

    await atomicWriteJson(join(tmpDir, "state.json"), {
      schemaVersion: 1,
      phase: "ready",
      attempts: 0,
      generation: 1,
      updatedAt: new Date().toISOString(),
    });

    // Fake active.json pointing to an existing file
    const fakePython = join(tmpDir, "fake-python.exe");
    await writeFile(fakePython, "", "utf8");
    await mkdir(join(tmpDir, "runtime"), { recursive: true });
    await atomicWriteJson(join(tmpDir, "runtime", "active.json"), {
      venv: fakePython,
    });

    const res = await service.schedule({
      cwd: "/test/project",
      model: "",
    });
    expect(res.scheduled).toBe(false);
    expect(res.reason).toBe("no_model_selected");
  });

  it("does not schedule when proposals are disabled in config", async () => {
    const service = new ProposalService({
      home: tmpDir,
      pluginRoot: resolve("."),
    });

    await atomicWriteJson(join(tmpDir, "state.json"), {
      schemaVersion: 1,
      phase: "ready",
      attempts: 0,
      generation: 1,
      updatedAt: new Date().toISOString(),
    });

    const fakePython = join(tmpDir, "fake-python.exe");
    await writeFile(fakePython, "", "utf8");
    await mkdir(join(tmpDir, "runtime"), { recursive: true });
    await atomicWriteJson(join(tmpDir, "runtime", "active.json"), {
      venv: fakePython,
    });

    await mkdir(join(tmpDir, "proposals"), { recursive: true });
    await atomicWriteJson(join(tmpDir, "proposals", "config.json"), {
      schemaVersion: 1,
      enabled: false,
      batchSize: 5,
      minimumIntervalHours: 24,
      model: "current",
      autoAdopt: false,
    });

    const res = await service.schedule({
      cwd: "/test/project",
      model: "claude-3-5-sonnet",
    });
    expect(res.scheduled).toBe(false);
    expect(res.reason).toBe("proposals_disabled");
  });

  it("does not schedule when no pending sessions exist", async () => {
    const service = new ProposalService({
      home: tmpDir,
      pluginRoot: resolve("."),
    });
    const repo = service.repo;
    const cwd = "/test/project";
    const { projectIdentity } = await import("../../src/telemetry.js");
    const projectId = projectIdentity(cwd).id;

    await atomicWriteJson(join(tmpDir, "state.json"), {
      schemaVersion: 1,
      phase: "ready",
      attempts: 0,
      generation: 1,
      updatedAt: new Date().toISOString(),
    });

    const fakePython = join(tmpDir, "fake-python.exe");
    await writeFile(fakePython, "", "utf8");
    await mkdir(join(tmpDir, "runtime"), { recursive: true });
    await atomicWriteJson(join(tmpDir, "runtime", "active.json"), {
      venv: fakePython,
    });

    await mkdir(join(tmpDir, "proposals"), { recursive: true });
    await atomicWriteJson(join(tmpDir, "proposals", "config.json"), {
      schemaVersion: 1,
      enabled: true,
      batchSize: 5,
      minimumIntervalHours: 24,
      model: "current",
      autoAdopt: false,
    });

    const baseline = await repo.ensureBaseline(projectId);
    baseline.baselineAt = "2026-09-05T00:00:00.000Z";
    await atomicWriteJson(repo.baselineFile(projectId), baseline);

    // Record zero sessions: an empty queue must not spawn a worker.
    for (let i = 0; i < 0; i++) {
      const s: CompletedSession = {
        sessionId: `s-${i}`,
        sessionHash: `h-${i}`,
        sessionFile: `/path/${i}.jsonl`,
        projectId,
        projectRoot: cwd,
        profileRoot: "profile-1",
        startedAt: "2026-09-05T01:00:00.000Z",
        completedAt: `2026-09-05T01:0${i}:00.000Z`,
      };
      await repo.recordCompletedSession(s);
    }

    const res = await service.schedule({
      cwd,
      model: "claude-3-5-sonnet",
      profileRoot: "profile-1",
    });
    expect(res.scheduled).toBe(false);
    expect(res.reason).toBe("insufficient_sessions");
  });

  it("schedules when a single pending session exists", async () => {
    const service = new ProposalService({
      home: tmpDir,
      pluginRoot: resolve("."),
    });
    const repo = service.repo;
    const cwd = "/test/project";
    const { projectIdentity } = await import("../../src/telemetry.js");
    const projectId = projectIdentity(cwd).id;

    await atomicWriteJson(join(tmpDir, "state.json"), {
      schemaVersion: 1,
      phase: "ready",
      attempts: 0,
      generation: 1,
      updatedAt: new Date().toISOString(),
    });

    const fakePython = join(tmpDir, "fake-python.exe");
    await writeFile(fakePython, "", "utf8");
    await mkdir(join(tmpDir, "runtime"), { recursive: true });
    await atomicWriteJson(join(tmpDir, "runtime", "active.json"), {
      venv: fakePython,
    });

    // Per-run batch stays 5, but a single waiting session already triggers.
    await mkdir(join(tmpDir, "proposals"), { recursive: true });
    await atomicWriteJson(join(tmpDir, "proposals", "config.json"), {
      schemaVersion: 1,
      enabled: true,
      batchSize: 5,
      minimumIntervalHours: 24,
      model: "current",
      autoAdopt: false,
    });

    await repo.ensureBaseline(projectId);
    await repo.recordCompletedSession({
      sessionId: "s-lone",
      sessionHash: "h-lone",
      sessionFile: "/path/lone.jsonl",
      projectId,
      projectRoot: cwd,
      profileRoot: "profile-1",
      startedAt: "2026-09-05T01:00:00.000Z",
      completedAt: "2026-09-05T01:10:00.000Z",
    });

    const res = await service.schedule({
      cwd,
      model: "claude-3-5-sonnet",
      profileRoot: "profile-1",
    });
    expect(res.scheduled).toBe(true);
    expect(res.pid).toBeDefined();
  });

  it("does not schedule if 24-hour interval has not elapsed", async () => {
    const service = new ProposalService({
      home: tmpDir,
      pluginRoot: resolve("."),
    });
    const repo = service.repo;
    const cwd = "/test/project";
    const { projectIdentity } = await import("../../src/telemetry.js");
    const projectId = projectIdentity(cwd).id;

    await atomicWriteJson(join(tmpDir, "state.json"), {
      schemaVersion: 1,
      phase: "ready",
      attempts: 0,
      generation: 1,
      updatedAt: new Date().toISOString(),
    });

    const fakePython = join(tmpDir, "fake-python.exe");
    await writeFile(fakePython, "", "utf8");
    await mkdir(join(tmpDir, "runtime"), { recursive: true });
    await atomicWriteJson(join(tmpDir, "runtime", "active.json"), {
      venv: fakePython,
    });

    const baseline = await repo.ensureBaseline(projectId);
    baseline.baselineAt = "2026-09-05T00:00:00.000Z";
    await atomicWriteJson(repo.baselineFile(projectId), baseline);

    // Record 5 sessions
    for (let i = 0; i < 5; i++) {
      const s: CompletedSession = {
        sessionId: `s-${i}`,
        sessionHash: `h-${i}`,
        sessionFile: `/path/${i}.jsonl`,
        projectId,
        projectRoot: cwd,
        profileRoot: "profile-1",
        startedAt: "2026-09-05T01:00:00.000Z",
        completedAt: `2026-09-05T01:0${i}:00.000Z`,
      };
      await repo.recordCompletedSession(s);
    }

    // Set schedule lastRunAt to 1 hour ago
    const schedule: ProposalSchedule = {
      schemaVersion: 1,
      lastRunAt: new Date(Date.now() - 3600 * 1000).toISOString(),
      lastRunId: "run-recent",
      lastStatus: "analyzed",
    };
    await repo.updateSchedule(projectId, schedule);

    const res = await service.schedule({
      cwd,
      model: "claude-3-5-sonnet",
      profileRoot: "profile-1",
    });
    expect(res.scheduled).toBe(false);
    expect(res.reason).toBe("interval_not_elapsed");
  });

  it("schedules reconciliation immediately when dead running run is detected", async () => {
    const service = new ProposalService({
      home: tmpDir,
      pluginRoot: resolve("."),
    });
    const repo = service.repo;
    const cwd = "/test/project";
    const { projectIdentity } = await import("../../src/telemetry.js");
    const projectId = projectIdentity(cwd).id;

    await atomicWriteJson(join(tmpDir, "state.json"), {
      schemaVersion: 1,
      phase: "ready",
      attempts: 0,
      generation: 1,
      updatedAt: new Date().toISOString(),
    });

    const fakePython = join(tmpDir, "fake-python.exe");
    await writeFile(fakePython, "", "utf8");
    await mkdir(join(tmpDir, "runtime"), { recursive: true });
    await atomicWriteJson(join(tmpDir, "runtime", "active.json"), {
      venv: fakePython,
    });

    // Record dead running run (PID 99999999 is dead)
    const deadRun: ProposalRun = {
      runId: "run-dead",
      projectId,
      projectRoot: cwd,
      profileRoot: "profile-1",
      model: "claude-3-5-sonnet",
      sessionIds: ["s1"],
      sessionPaths: ["/p1"],
      startedAt: new Date().toISOString(),
      pid: 99999999,
      status: "running",
    };
    await repo.recordRun(projectId, deadRun);

    const res = await service.schedule({
      cwd,
      model: "claude-3-5-sonnet",
      profileRoot: "profile-1",
    });

    expect(res.scheduled).toBe(true);
    expect(res.reason).toBe("reconciliation");
    expect(res.pid).toBeDefined();
  });
});
