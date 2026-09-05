import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adoptProposal,
  discardProposal,
} from "../../src/proposals/adoption.js";
import type { Proposal } from "../../src/proposals/domain.js";
import { ProposalRepository } from "../../src/proposals/repository.js";

const tmpDir = resolve(".tmp", "test-proposals-adoption");

describe("Proposal adoption and discard", () => {
  beforeEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("discards proposal and records resolution", async () => {
    const repo = new ProposalRepository(tmpDir);
    const projectId = "proj-discard";
    const proposalId = "prop-123";

    await discardProposal(repo, projectId, proposalId, "Not useful");

    const resolution = await repo.getResolution(projectId, proposalId);
    expect(resolution).toBeDefined();
    expect(resolution?.decision).toBe("discarded");
    expect(resolution?.reason).toBe("Not useful");
  });

  it("invokes CLI with correct args for managed proposal", async () => {
    const proposal: Proposal = {
      id: "prop-managed",
      kind: "managed",
      skillName: "skillopt-sleep-learned",
      stagingDir: "/staging/dir",
      manifestPath: "/staging/dir/manifest.json",
      reportPath: "/staging/dir/report.md",
      proposedSkillPath: "/staging/dir/proposed_SKILL.md",
      proposedSha256: "sha-1",
      targetSkillPath: "/project/.omp/skills/skillopt-sleep-learned/SKILL.md",
      accepted: true,
      hasManagedSkill: true,
    };

    const spawnMod = await import("../../src/shared/spawn.js");
    vi.spyOn(spawnMod, "run").mockImplementation(async (argv) => {
      expect(argv).toContain("--legacy");
      expect(argv).toContain("--staging");
      expect(argv).toContain("/staging/dir");
      expect(argv).toContain("--json");
      return { code: 0, stdout: "{}", stderr: "" };
    });

    const res = await adoptProposal({
      home: tmpDir,
      pluginRoot: resolve("."),
      python: "python",
      projectRoot: "/project",
      proposal,
    });

    expect(res.success).toBe(true);
  });

  it("invokes CLI with correct args for skill-row proposal", async () => {
    const proposal: Proposal = {
      id: "prop-skill",
      kind: "skill",
      skillName: "my-skill",
      stagingDir: "/staging/dir",
      manifestPath: "/staging/dir/manifest.json",
      reportPath: "/staging/dir/report.md",
      proposedSkillPath: "/staging/dir/proposed_SKILL_my_skill.md",
      proposedSha256: "sha-2",
      targetSkillPath: "/project/.omp/skills/my-skill/SKILL.md",
      accepted: true,
      hasManagedSkill: false,
    };

    const spawnMod = await import("../../src/shared/spawn.js");
    vi.spyOn(spawnMod, "run").mockImplementation(async (argv) => {
      expect(argv).toContain("--skill");
      expect(argv).toContain("my-skill");
      expect(argv).toContain("--staging");
      expect(argv).toContain("/staging/dir");
      expect(argv).toContain("--json");
      expect(argv).not.toContain("--legacy");
      return { code: 0, stdout: "{}", stderr: "" };
    });

    const res = await adoptProposal({
      home: tmpDir,
      pluginRoot: resolve("."),
      python: "python",
      projectRoot: "/project",
      proposal,
    });

    expect(res.success).toBe(true);
  });
});
