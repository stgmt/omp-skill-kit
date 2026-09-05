import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletedSession } from "../../src/proposals/domain.js";
import { SkillOptProcess } from "../../src/proposals/process.js";
import { resolveModelChain } from "../../src/proposals/service.js";

const tmpDir = resolve(".tmp", "test-model-fallback");

describe("resolveModelChain", () => {
  const resolveSpec = (spec: string): string | undefined => {
    if (spec === "@smol") return "test-provider/test-smol";
    if (spec === "@slow") return "test-provider/test-slow";
    return undefined;
  };

  it("resolves current, roles and explicit ids in order", () => {
    const chain = resolveModelChain(
      ["@smol", "explicit/model", "current"],
      "test-provider/session-model",
      resolveSpec,
    );
    expect(chain).toEqual([
      "test-provider/test-smol",
      "explicit/model",
      "test-provider/session-model",
    ]);
  });

  it("drops unresolvable roles, blanks and duplicates", () => {
    const chain = resolveModelChain(
      ["@missing", "  ", "current", "dup/model", "dup/model", "@smol", "@smol"],
      "  ",
      resolveSpec,
    );
    expect(chain).toEqual(["dup/model", "test-provider/test-smol"]);
  });

  it("returns an empty chain when nothing resolves", () => {
    expect(resolveModelChain(["@missing"], undefined, resolveSpec)).toEqual([]);
    expect(resolveModelChain([], "some/model", resolveSpec)).toEqual([]);
  });
});

describe("SkillOptProcess fallback models", () => {
  beforeEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function batch(): CompletedSession[] {
    return [
      {
        sessionId: "s-1",
        sessionHash: "h-1",
        sessionFile: "/sessions/s-1.jsonl",
        projectId: "proj-1",
        projectRoot: "/proj",
        profileRoot: "/prof",
        startedAt: "2026-09-05T01:00:00.000Z",
        completedAt: "2026-09-05T01:10:00.000Z",
      },
    ];
  }

  function proc() {
    return new SkillOptProcess({
      home: tmpDir,
      pluginRoot: resolve("."),
      python: "python",
    });
  }

  it("retries the fallback model after a transport failure", async () => {
    const spawnMod = await import("../../src/shared/spawn.js");
    const runSpy = vi
      .spyOn(spawnMod, "run")
      .mockImplementation(async (argv) => {
        if (argv.includes("primary/model")) {
          return { code: 1, stdout: "", stderr: "429 quota exhausted" };
        }
        expect(argv).toContain("fallback/model");
        return {
          code: 0,
          stdout: JSON.stringify({ accepted: true, n_tasks: 2 }),
          stderr: "",
        };
      });

    const res = await proc().run(
      {
        projectId: "proj-1",
        projectRoot: "/proj",
        profileRoot: "/prof",
        model: "primary/model",
        sessions: batch(),
      },
      ["fallback/model"],
    );

    expect(res.outcome).toBe("analyzed");
    expect(res.model).toBe("fallback/model");
    expect(runSpy).toHaveBeenCalledTimes(2);
  });

  it("does not retry after a gate verdict", async () => {
    const spawnMod = await import("../../src/shared/spawn.js");
    const runSpy = vi.spyOn(spawnMod, "run").mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({
        accepted: false,
        gate_action: "reject",
        n_tasks: 3,
      }),
      stderr: "",
    });

    const res = await proc().run(
      {
        projectId: "proj-1",
        projectRoot: "/proj",
        profileRoot: "/prof",
        model: "primary/model",
        sessions: batch(),
      },
      ["fallback/model"],
    );

    expect(res.outcome).toBe("rejected");
    expect(res.model).toBe("primary/model");
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it("reports the last error when every model fails", async () => {
    const spawnMod = await import("../../src/shared/spawn.js");
    vi.spyOn(spawnMod, "run").mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "boom",
    });

    const res = await proc().run(
      {
        projectId: "proj-1",
        projectRoot: "/proj",
        profileRoot: "/prof",
        model: "primary/model",
        sessions: batch(),
      },
      ["fallback/model"],
    );

    expect(res.outcome).toBe("failed");
    expect(res.model).toBe("fallback/model");
    expect(res.error).toContain("boom");
  });
});
