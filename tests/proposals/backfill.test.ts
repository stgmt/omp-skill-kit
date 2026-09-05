import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backfillProjectSessions,
  maybeBackfillProjectSessions,
  resolveProfileSessionsRoot,
} from "../../src/proposals/backfill.js";
import { ProposalRepository } from "../../src/proposals/repository.js";
import { projectIdentity } from "../../src/telemetry.js";

const tmpDir = resolve(".tmp", "test-proposals-backfill");

function sessionLine(entry: object): string {
  return `${JSON.stringify(entry)}\n`;
}

describe("backfillProjectSessions", () => {
  let projectDir: string;
  let sessionsRoot: string;
  let slugDir: string;

  beforeEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    projectDir = join(tmpDir, "my-project");
    sessionsRoot = join(tmpDir, "profile", "agent", "sessions");
    slugDir = join(sessionsRoot, "my-project-slug");
    await mkdir(slugDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function writeMain(
    name: string,
    id: string,
    cwd: string,
    preamble = false,
  ) {
    const lines = [];
    if (preamble) {
      lines.push(sessionLine({ type: "title", title: "preamble", v: 1 }));
    }
    lines.push(
      sessionLine({
        type: "session",
        id,
        cwd,
        timestamp: "2026-08-01T01:00:00.000Z",
      }),
    );
    lines.push(
      sessionLine({
        type: "message",
        message: { role: "user", content: "hi" },
      }),
    );
    await writeFile(join(slugDir, name), lines.join(""), "utf8");
  }

  it("records old main sessions and skips sidecars, foreign and corrupt files", async () => {
    await writeMain("old-1.jsonl", "sess-old-1", projectDir);
    await writeMain("old-2.jsonl", "sess-old-2", projectDir, true);

    // Nested advisor sidecar: same valid header but too deep.
    const nested = join(slugDir, "live-session");
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(nested, "__advisor.default.jsonl"),
      sessionLine({
        type: "session",
        id: "sess-sidecar",
        cwd: projectDir,
        timestamp: "2026-08-01T01:00:00.000Z",
      }),
      "utf8",
    );

    // Foreign project transcript: valid shape, wrong cwd.
    await writeMain(
      "foreign.jsonl",
      "sess-foreign",
      join(tmpDir, "other-project"),
    );

    // Corrupt file.
    await writeFile(
      join(slugDir, "corrupt.jsonl"),
      "NOT JSON AT ALL\n",
      "utf8",
    );

    const repo = new ProposalRepository(tmpDir);
    const result = await backfillProjectSessions(
      repo,
      sessionsRoot,
      projectDir,
    );

    expect(result.recorded).toBe(2);
    expect(result.scanned).toBe(4);

    const pending = await repo.getPendingSessions(
      projectIdentity(projectDir).id,
    );
    expect(pending.map((s) => s.sessionId).sort()).toEqual(
      ["sess-old-1", "sess-old-2"].sort(),
    );
  });

  it("never records the same session twice", async () => {
    await writeMain("old-1.jsonl", "sess-old-1", projectDir);

    const repo = new ProposalRepository(tmpDir);
    const first = await backfillProjectSessions(repo, sessionsRoot, projectDir);
    expect(first.recorded).toBe(1);

    const second = await backfillProjectSessions(
      repo,
      sessionsRoot,
      projectDir,
    );
    expect(second.recorded).toBe(0);
    expect(second.scanned).toBe(1);
  });

  it("respects the file cap, newest first", async () => {
    await writeMain("a.jsonl", "sess-a", projectDir);
    await writeMain("b.jsonl", "sess-b", projectDir);
    await writeMain("c.jsonl", "sess-c", projectDir);

    const repo = new ProposalRepository(tmpDir);
    const result = await backfillProjectSessions(
      repo,
      sessionsRoot,
      projectDir,
      {
        limit: 2,
      },
    );
    expect(result.scanned).toBe(2);
    expect(result.recorded).toBe(2);
  });

  it("gates rescans behind a 24h marker", async () => {
    await writeMain("old-1.jsonl", "sess-old-1", projectDir);

    const repo = new ProposalRepository(tmpDir);
    const projectId = projectIdentity(projectDir).id;

    const first = await maybeBackfillProjectSessions(
      repo,
      projectId,
      sessionsRoot,
      projectDir,
    );
    expect(first?.recorded).toBe(1);

    const second = await maybeBackfillProjectSessions(
      repo,
      projectId,
      sessionsRoot,
      projectDir,
    );
    expect(second).toBeUndefined();
  });

  it("resolves the sessions root from the live session directory", () => {
    const sessionDir = join(tmpDir, "profile", "agent", "sessions", "slug");
    expect(resolveProfileSessionsRoot(sessionDir)).toBe(
      join(tmpDir, "profile", "agent", "sessions"),
    );
    expect(resolveProfileSessionsRoot(undefined).endsWith("sessions")).toBe(
      true,
    );
  });
});
