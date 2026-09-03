import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DiagnosticEntry,
  DiagnosticLog,
  getComponentLogPaths,
} from "../src/diagnostics.js";

describe("DiagnosticLog", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "omp-diag-test-"));
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  it("creates logs directory and writes valid JSONL entries in sequential order", async () => {
    const diag = new DiagnosticLog(tempHome);
    const count = 20;

    const promises: Promise<void>[] = [];
    for (let i = 0; i < count; i++) {
      promises.push(
        diag.log({
          level: "info",
          component: "extension",
          event: "installer.ensure.started",
          step: `step-${i}`,
          pid: i + 100,
        }),
      );
    }
    await Promise.all(promises);

    const logPath = getComponentLogPaths(tempHome).extensionLog;
    const content = await readFile(logPath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(count);

    for (let i = 0; i < count; i++) {
      const entry = JSON.parse(lines[i]) as DiagnosticEntry;
      expect(entry.component).toBe("extension");
      expect(entry.event).toBe("installer.ensure.started");
      expect(entry.step).toBe(`step-${i}`);
      expect(entry.pid).toBe(i + 100);
      expect(typeof entry.ts).toBe("string");
    }
  });

  it("truncates error messages exceeding 500 characters", async () => {
    const diag = new DiagnosticLog(tempHome);
    const longError = "x".repeat(1200);

    await diag.log({
      level: "error",
      component: "installer",
      event: "installer.phase.failed",
      error: longError,
    });

    const logPath = getComponentLogPaths(tempHome).extensionLog;
    const content = await readFile(logPath, "utf8");
    const entry = JSON.parse(content.trim()) as DiagnosticEntry;
    expect(entry.error).toBeDefined();
    expect(entry.error?.length).toBe(500);
    expect(entry.error).toBe("x".repeat(500));
  });

  it("filters out invalid skill names preserving privacy allowlist", async () => {
    const diag = new DiagnosticLog(tempHome);

    await diag.log({
      level: "info",
      component: "router",
      event: "route.matched",
      names: [
        "good_skill-1",
        "../../escape",
        "Bearer secret-token",
        "sk-ant-api-key",
        "valid-skill",
      ],
    });

    const logPath = getComponentLogPaths(tempHome).extensionLog;
    const content = await readFile(logPath, "utf8");
    const entry = JSON.parse(content.trim()) as DiagnosticEntry;
    expect(entry.names).toEqual(["good_skill-1", "valid-skill"]);
  });

  it("swallows write errors fail-open and reports through warnFn", async () => {
    const warnFn = vi.fn();
    // Use an illegal path character on Windows or non-directory file to trigger write failure
    const badHome = join(tempHome, "not-a-dir");
    const { writeFile } = await import("node:fs/promises");
    // Create a regular file where logs directory would need to be created
    await writeFile(badHome, "regular file", "utf8");

    const diag = new DiagnosticLog(badHome, { warnFn });
    await expect(
      diag.log({
        level: "info",
        component: "extension",
        event: "installer.ensure.started",
      }),
    ).resolves.toBeUndefined();

    expect(warnFn).toHaveBeenCalled();
  });
});
