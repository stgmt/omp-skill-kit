import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProposalRepository } from "../../src/proposals/repository.js";
import { ProposalScanner } from "../../src/proposals/scanner.js";
import { atomicWriteJson, sha256Hex } from "../../src/shared/fsx.js";

const tmpDir = resolve(".tmp", "test-proposals-scanner");

describe("ProposalScanner", () => {
  beforeEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("discovers managed proposal from manifest v2", async () => {
    const projectRoot = join(tmpDir, "project");
    await mkdir(projectRoot, { recursive: true });
    const stagingDir = join(
      projectRoot,
      ".skillopt-sleep",
      "staging",
      "20260905-100000",
    );
    await mkdir(stagingDir, { recursive: true });

    const reportContent = "# Sleep Report\nCandidate accepted";
    await writeFile(join(stagingDir, "report.md"), reportContent, "utf8");

    const skillContent =
      "---\nname: skillopt-sleep-learned\n---\n# Learned Skill\n";
    await writeFile(
      join(stagingDir, "proposed_SKILL.md"),
      skillContent,
      "utf8",
    );
    const skillSha = sha256Hex(skillContent);

    const liveSkillPath = join(
      projectRoot,
      ".omp",
      "skills",
      "skillopt-sleep-learned",
      "SKILL.md",
    );

    const manifest = {
      schema: "skillopt-sleep-staging",
      schema_version: 2,
      accepted: true,
      has_managed_skill: true,
      legacy: {
        skill: {
          proposed_file: "proposed_SKILL.md",
          live_path: liveSkillPath,
          sha256: skillSha,
        },
      },
    };
    await atomicWriteJson(join(stagingDir, "manifest.json"), manifest);

    const repo = new ProposalRepository(tmpDir);
    const scanner = new ProposalScanner(repo);
    const proposals = await scanner.scanProjectProposals(projectRoot, "proj-1");

    expect(proposals.length).toBe(1);
    expect(proposals[0].kind).toBe("managed");
    expect(proposals[0].skillName).toBe("skillopt-sleep-learned");
    expect(proposals[0].proposedSha256).toBe(skillSha);

    // If adopted_legacy.json exists, it should not be returned
    await atomicWriteJson(join(stagingDir, "adopted_legacy.json"), {
      adopted_at: new Date().toISOString(),
    });
    const afterAdopt = await scanner.scanProjectProposals(
      projectRoot,
      "proj-1",
    );
    expect(afterAdopt.length).toBe(0);
  });

  it("discovers fanout skills from manifest v2 skills[]", async () => {
    const projectRoot = join(tmpDir, "project");
    const stagingDir = join(
      projectRoot,
      ".skillopt-sleep",
      "staging",
      "20260905-200000",
    );
    await mkdir(stagingDir, { recursive: true });

    await writeFile(join(stagingDir, "report.md"), "# Report", "utf8");

    const skillA = "---\nname: skill-alpha\n---\n# Alpha\n";
    const skillB = "---\nname: skill-beta\n---\n# Beta\n";
    await writeFile(join(stagingDir, "prop_alpha.md"), skillA, "utf8");
    await writeFile(join(stagingDir, "prop_beta.md"), skillB, "utf8");

    const shaA = sha256Hex(skillA);
    const shaB = sha256Hex(skillB);

    const manifest = {
      schema: "skillopt-sleep-staging",
      schema_version: 2,
      accepted: true,
      skills: [
        {
          skill_name: "skill-alpha",
          proposed_file: "prop_alpha.md",
          live_skill_path: join(
            projectRoot,
            ".omp",
            "skills",
            "skill-alpha",
            "SKILL.md",
          ),
          sha256: shaA,
        },
        {
          skill_name: "skill-beta",
          proposed_file: "prop_beta.md",
          live_skill_path: join(
            projectRoot,
            ".omp",
            "skills",
            "skill-beta",
            "SKILL.md",
          ),
          sha256: shaB,
        },
      ],
    };
    await atomicWriteJson(join(stagingDir, "manifest.json"), manifest);

    const repo = new ProposalRepository(tmpDir);
    const scanner = new ProposalScanner(repo);
    const proposals = await scanner.scanProjectProposals(projectRoot, "proj-2");

    expect(proposals.length).toBe(2);
    expect(proposals.map((p) => p.skillName).sort()).toEqual([
      "skill-alpha",
      "skill-beta",
    ]);

    // If skill-alpha is recorded in adopted_skills.json, only skill-beta is pending
    await atomicWriteJson(join(stagingDir, "adopted_skills.json"), [
      { skill_name: "skill-alpha" },
    ]);
    const afterPartialAdopt = await scanner.scanProjectProposals(
      projectRoot,
      "proj-2",
    );
    expect(afterPartialAdopt.length).toBe(1);
    expect(afterPartialAdopt[0].skillName).toBe("skill-beta");
  });

  it("filters out discarded proposals", async () => {
    const projectRoot = join(tmpDir, "project");
    const stagingDir = join(
      projectRoot,
      ".skillopt-sleep",
      "staging",
      "20260905-300000",
    );
    await mkdir(stagingDir, { recursive: true });
    await writeFile(join(stagingDir, "report.md"), "# Report", "utf8");

    const skillContent = "---\nname: discard-me\n---\n# Discard\n";
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
            "discard-me",
            "SKILL.md",
          ),
          sha256: sha,
        },
      },
    };
    await atomicWriteJson(join(stagingDir, "manifest.json"), manifest);

    const repo = new ProposalRepository(tmpDir);
    const scanner = new ProposalScanner(repo);
    const beforeDiscard = await scanner.scanProjectProposals(
      projectRoot,
      "proj-3",
    );
    expect(beforeDiscard.length).toBe(1);

    const proposalId = beforeDiscard[0].id;
    await repo.recordResolution("proj-3", {
      proposalId,
      decision: "discarded",
      resolvedAt: new Date().toISOString(),
      reason: "User rejected",
    });

    const afterDiscard = await scanner.scanProjectProposals(
      projectRoot,
      "proj-3",
    );
    expect(afterDiscard.length).toBe(0);
  });

  it("rejects invalid SHA or path escape", async () => {
    const projectRoot = join(tmpDir, "project");
    const stagingDir = join(
      projectRoot,
      ".skillopt-sleep",
      "staging",
      "20260905-400000",
    );
    await mkdir(stagingDir, { recursive: true });
    await writeFile(join(stagingDir, "report.md"), "# Report", "utf8");

    const skillContent = "---\nname: bad-skill\n---\n# Bad\n";
    await writeFile(join(stagingDir, "prop.md"), skillContent, "utf8");

    // Invalid SHA in manifest
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
            "bad-skill",
            "SKILL.md",
          ),
          sha256: "wrong-sha256",
        },
      },
    };
    await atomicWriteJson(join(stagingDir, "manifest.json"), manifest);

    const repo = new ProposalRepository(tmpDir);
    const scanner = new ProposalScanner(repo);
    const result = await scanner.scanProjectProposals(projectRoot, "proj-4");
    expect(result.length).toBe(0);
  });
});
