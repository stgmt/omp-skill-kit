import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAndParseSessionFile } from "../../src/proposals/session-source.js";

const tmpDir = resolve(".tmp", "test-session-source");

describe("session-source", () => {
  beforeEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("accepts a valid main OMP session with title preamble", async () => {
    const projectDir = join(tmpDir, "my-project");
    await mkdir(projectDir, { recursive: true });
    const sessionsDir = join(
      tmpDir,
      "profile",
      "agent",
      "sessions",
      "my-project-slug",
    );
    await mkdir(sessionsDir, { recursive: true });
    const sessionFile = join(sessionsDir, "valid-session.jsonl");

    const content = [
      JSON.stringify({
        type: "title",
        title: "Non-semantic OMP title preamble",
        v: 1,
      }),
      JSON.stringify({
        type: "session",
        id: "session-123",
        cwd: projectDir,
        timestamp: "2026-09-05T01:00:00.000Z",
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "hello" },
      }),
    ].join("\n");

    await writeFile(sessionFile, content, "utf8");

    const result = await validateAndParseSessionFile(sessionFile, projectDir);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.sessionId).toBe("session-123");
      expect(result.startedAt).toBe("2026-09-05T01:00:00.000Z");
      expect(result.projectRoot).toBe(
        projectDir.replaceAll("\\", "/").toLowerCase(),
      );
      expect(result.profileRoot).toBe(resolve(tmpDir, "profile"));
    }
  });

  it("rejects nested advisor / scout sidecar files", async () => {
    const projectDir = join(tmpDir, "my-project");
    const nestedDir = join(
      tmpDir,
      "profile",
      "agent",
      "sessions",
      "my-project-slug",
      "session-123",
    );
    await mkdir(nestedDir, { recursive: true });
    const sidecarFile = join(nestedDir, "__advisor.default.jsonl");

    const content = JSON.stringify({
      type: "session",
      id: "advisor-sub",
      cwd: projectDir,
      timestamp: "2026-09-05T01:00:00.000Z",
    });
    await writeFile(sidecarFile, content, "utf8");

    const result = await validateAndParseSessionFile(sidecarFile, projectDir);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("nested_sidecar_or_invalid_depth");
    }
  });

  it("rejects symlinked session files", async () => {
    const projectDir = join(tmpDir, "my-project");
    await mkdir(projectDir, { recursive: true });
    const realDir = join(tmpDir, "real");
    await mkdir(realDir, { recursive: true });
    const realFile = join(realDir, "real.jsonl");
    await writeFile(
      realFile,
      JSON.stringify({
        type: "session",
        id: "s-sym",
        cwd: projectDir,
        timestamp: "2026-09-05T01:00:00.000Z",
      }),
      "utf8",
    );

    const sessionsDir = join(
      tmpDir,
      "profile",
      "agent",
      "sessions",
      "my-project-slug",
    );
    await mkdir(sessionsDir, { recursive: true });
    const symlinkFile = join(sessionsDir, "symlink.jsonl");

    try {
      await symlink(realFile, symlinkFile);
    } catch {
      // Symlink creation might fail without admin on Windows; skip if not supported
      return;
    }

    const result = await validateAndParseSessionFile(symlinkFile, projectDir);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("symlink_not_allowed");
    }
  });

  it("rejects session file with missing or ambiguous session header", async () => {
    const projectDir = join(tmpDir, "my-project");
    const sessionsDir = join(
      tmpDir,
      "profile",
      "agent",
      "sessions",
      "my-project-slug",
    );
    await mkdir(sessionsDir, { recursive: true });

    // Missing header
    const noHeaderFile = join(sessionsDir, "no-header.jsonl");
    await writeFile(
      noHeaderFile,
      JSON.stringify({ type: "message", role: "user" }),
      "utf8",
    );
    const r1 = await validateAndParseSessionFile(noHeaderFile, projectDir);
    expect(r1.valid).toBe(false);
    if (!r1.valid) expect(r1.reason).toBe("missing_session_header");

    // Ambiguous header (2 session headers)
    const multiHeaderFile = join(sessionsDir, "multi-header.jsonl");
    await writeFile(
      multiHeaderFile,
      [
        JSON.stringify({
          type: "session",
          id: "s1",
          cwd: projectDir,
          timestamp: "2026-09-05T01:00:00Z",
        }),
        JSON.stringify({
          type: "session",
          id: "s2",
          cwd: projectDir,
          timestamp: "2026-09-05T01:00:00Z",
        }),
      ].join("\n"),
      "utf8",
    );
    const r2 = await validateAndParseSessionFile(multiHeaderFile, projectDir);
    expect(r2.valid).toBe(false);
    if (!r2.valid) expect(r2.reason).toBe("ambiguous_session_header");
  });

  it("rejects session file from a different project", async () => {
    const projectDir = join(tmpDir, "my-project");
    const otherProjectDir = join(tmpDir, "other-project");
    const sessionsDir = join(
      tmpDir,
      "profile",
      "agent",
      "sessions",
      "my-project-slug",
    );
    await mkdir(sessionsDir, { recursive: true });

    const otherProjectFile = join(sessionsDir, "other.jsonl");
    await writeFile(
      otherProjectFile,
      JSON.stringify({
        type: "session",
        id: "s-other",
        cwd: otherProjectDir,
        timestamp: "2026-09-05T01:00:00Z",
      }),
      "utf8",
    );

    const result = await validateAndParseSessionFile(
      otherProjectFile,
      projectDir,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("mismatched_project_cwd");
    }
  });
});
