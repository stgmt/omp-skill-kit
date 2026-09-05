import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProposalRepository } from "../../src/proposals/repository.js";
import { ProposalScanner } from "../../src/proposals/scanner.js";
import { validateAndParseSessionFile } from "../../src/proposals/session-source.js";
import { atomicWriteJson, sha256Hex } from "../../src/shared/fsx.js";

const tmpDir = resolve(".tmp", "test-proposals-mutation");

describe("Proposals security and mutation guards", () => {
  beforeEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects path traversal attempting to escape session root", async () => {
    const projectDir = join(tmpDir, "target-project");
    await mkdir(projectDir, { recursive: true });

    // Try path traversal: profile/agent/sessions/dir/../../outside.jsonl
    const traversalPath = join(
      tmpDir,
      "profile",
      "agent",
      "sessions",
      "proj-slug",
      "..",
      "..",
      "escaped.jsonl",
    );
    const res = await validateAndParseSessionFile(traversalPath, projectDir);
    expect(res.valid).toBe(false);
  });

  it("rejects session files whose cwd does not match target project", async () => {
    const projectDir = join(tmpDir, "target-project");
    const otherDir = join(tmpDir, "foreign-project");
    await mkdir(projectDir, { recursive: true });
    await mkdir(otherDir, { recursive: true });

    const sessionsDir = join(
      tmpDir,
      "profile",
      "agent",
      "sessions",
      "target-project-slug",
    );
    await mkdir(sessionsDir, { recursive: true });
    const sessionFile = join(sessionsDir, "foreign.jsonl");

    await writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        id: "sess-foreign",
        cwd: otherDir,
        timestamp: "2026-09-05T01:00:00Z",
      })}\n`,
      "utf8",
    );

    const res = await validateAndParseSessionFile(sessionFile, projectDir);
    expect(res.valid).toBe(false);
    if (!res.valid) {
      expect(res.reason).toBe("mismatched_project_cwd");
    }
  });

  it("rejects proposal with SHA-256 tampering", async () => {
    const projectRoot = join(tmpDir, "project");
    const stagingDir = join(
      projectRoot,
      ".skillopt-sleep",
      "staging",
      "20260905-555555",
    );
    await mkdir(stagingDir, { recursive: true });
    await writeFile(join(stagingDir, "report.md"), "# Report", "utf8");

    // Real content has hash X, but manifest asserts hash Y
    const realContent = "---\nname: tampered\n---\n# Real Content";
    await writeFile(join(stagingDir, "prop.md"), realContent, "utf8");

    const manifest = {
      schema: "skillopt-sleep-staging",
      schema_version: 2,
      accepted: true,
      has_managed_skill: true,
      legacy: {
        skill: {
          proposed_file: "prop.md",
          live_path: join(
            projectRoot,
            ".omp",
            "skills",
            "tampered",
            "SKILL.md",
          ),
          sha256:
            "0000000000000000000000000000000000000000000000000000000000000000",
        },
      },
    };
    await atomicWriteJson(join(stagingDir, "manifest.json"), manifest);

    const repo = new ProposalRepository(tmpDir);
    const scanner = new ProposalScanner(repo);
    const proposals = await scanner.scanProjectProposals(
      projectRoot,
      "p-tamper",
    );
    expect(proposals.length).toBe(0);
  });

  it("rejects proposal targeting a path outside .omp/skills", async () => {
    const projectRoot = join(tmpDir, "project");
    const stagingDir = join(
      projectRoot,
      ".skillopt-sleep",
      "staging",
      "20260905-666666",
    );
    await mkdir(stagingDir, { recursive: true });
    await writeFile(join(stagingDir, "report.md"), "# Report", "utf8");

    const skillContent = "---\nname: escaped\n---\n# Escaped";
    await writeFile(join(stagingDir, "prop.md"), skillContent, "utf8");
    const sha = sha256Hex(skillContent);

    // Live path attempts to escape .omp/skills into system or project root
    const manifest = {
      schema: "skillopt-sleep-staging",
      schema_version: 2,
      accepted: true,
      has_managed_skill: true,
      legacy: {
        skill: {
          proposed_file: "prop.md",
          live_path: join(projectRoot, "src", "SKILL.md"),
          sha256: sha,
        },
      },
    };
    await atomicWriteJson(join(stagingDir, "manifest.json"), manifest);

    const repo = new ProposalRepository(tmpDir);
    const scanner = new ProposalScanner(repo);
    const proposals = await scanner.scanProjectProposals(
      projectRoot,
      "p-escape",
    );
    expect(proposals.length).toBe(0);
  });

  it("rejects oversized report (>1 MiB) or oversized skill (>256 KiB)", async () => {
    const projectRoot = join(tmpDir, "project");
    const stagingDir = join(
      projectRoot,
      ".skillopt-sleep",
      "staging",
      "20260905-777777",
    );
    await mkdir(stagingDir, { recursive: true });

    // 1. Oversized report (> 1 MiB)
    const largeReport = "A".repeat(1024 * 1024 + 10);
    await writeFile(join(stagingDir, "report.md"), largeReport, "utf8");

    const skillContent = "---\nname: oversized\n---\n# Normal";
    await writeFile(join(stagingDir, "prop.md"), skillContent, "utf8");
    const sha = sha256Hex(skillContent);

    const manifest = {
      schema: "skillopt-sleep-staging",
      schema_version: 2,
      accepted: true,
      has_managed_skill: true,
      legacy: {
        skill: {
          proposed_file: "prop.md",
          live_path: join(
            projectRoot,
            ".omp",
            "skills",
            "oversized",
            "SKILL.md",
          ),
          sha256: sha,
        },
      },
    };
    await atomicWriteJson(join(stagingDir, "manifest.json"), manifest);

    const repo = new ProposalRepository(tmpDir);
    const scanner = new ProposalScanner(repo);
    const proposals1 = await scanner.scanProjectProposals(
      projectRoot,
      "p-oversized",
    );
    expect(proposals1.length).toBe(0);

    // 2. Normal report, but oversized skill (> 256 KiB)
    await writeFile(join(stagingDir, "report.md"), "# Small Report", "utf8");
    const largeSkill = "B".repeat(256 * 1024 + 10);
    await writeFile(join(stagingDir, "prop.md"), largeSkill, "utf8");
    manifest.legacy.skill.sha256 = sha256Hex(largeSkill);
    await atomicWriteJson(join(stagingDir, "manifest.json"), manifest);

    const proposals2 = await scanner.scanProjectProposals(
      projectRoot,
      "p-oversized",
    );
    expect(proposals2.length).toBe(0);
  });

  it("rejects symlinked staging directory", async () => {
    const projectRoot = join(tmpDir, "project");
    const realStaging = join(tmpDir, "real-staging", "20260905-888888");
    await mkdir(realStaging, { recursive: true });
    await writeFile(join(realStaging, "report.md"), "# Report", "utf8");

    const stagingRoot = join(projectRoot, ".skillopt-sleep", "staging");
    await mkdir(stagingRoot, { recursive: true });

    try {
      await symlink(realStaging, join(stagingRoot, "symlinked-staging"));
    } catch {
      // Windows non-admin symlink skip
      return;
    }

    const repo = new ProposalRepository(tmpDir);
    const scanner = new ProposalScanner(repo);
    const proposals = await scanner.scanProjectProposals(projectRoot, "p-sym");
    expect(proposals.length).toBe(0);
  });
});
