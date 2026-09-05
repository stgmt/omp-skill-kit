import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  isWithin,
  pathExists,
  readJson,
  safeSkillName,
  sha256File,
  sha256Hex,
} from "../shared/fsx.js";
import type { Proposal } from "./domain.js";
import type { ProposalRepository } from "./repository.js";

const MAX_REPORT_BYTES = 1024 * 1024; // 1 MiB
const MAX_PROPOSED_SKILL_BYTES = 256 * 1024; // 256 KiB

interface ManifestLegacySkill {
  proposed_file?: string;
  live_path?: string;
  sha256?: string;
}

interface ManifestSkillRow {
  skill_name?: string;
  proposed_file?: string;
  live_skill_path?: string;
  sha256?: string;
}

interface StagingManifest {
  schema?: string;
  schema_version?: number;
  accepted?: boolean;
  has_managed_skill?: boolean;
  legacy?: {
    skill?: ManifestLegacySkill;
  };
  skills?: ManifestSkillRow[];
}

export class ProposalScanner {
  readonly repo: ProposalRepository;

  constructor(repo: ProposalRepository) {
    this.repo = repo;
  }

  async scanProjectProposals(
    projectRoot: string,
    projectId: string,
  ): Promise<Proposal[]> {
    const stagingRoot = join(projectRoot, ".skillopt-sleep", "staging");
    if (!(await pathExists(stagingRoot))) {
      return [];
    }

    // Must not be a symlink
    try {
      const st = await lstat(stagingRoot);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        return [];
      }
    } catch {
      return [];
    }

    let realStagingRoot: string;
    try {
      realStagingRoot = await realpath(stagingRoot);
    } catch {
      return [];
    }

    const entries = await readdir(stagingRoot);
    const proposals: Proposal[] = [];

    const expectedSkillRoot = resolve(projectRoot, ".omp", "skills");

    for (const sub of entries) {
      if (sub === ".latest" || sub.startsWith(".")) continue;
      const stagingDir = join(stagingRoot, sub);

      try {
        const subStat = await lstat(stagingDir);
        if (subStat.isSymbolicLink() || !subStat.isDirectory()) continue;

        const realStagingDir = await realpath(stagingDir);
        if (!isWithin(realStagingRoot, realStagingDir)) continue;

        const manifestPath = join(stagingDir, "manifest.json");
        const reportPath = join(stagingDir, "report.md");

        if (
          !(await pathExists(manifestPath)) ||
          !(await pathExists(reportPath))
        ) {
          continue;
        }

        // Validate report.md
        const reportStat = await lstat(reportPath);
        if (
          reportStat.isSymbolicLink() ||
          !reportStat.isFile() ||
          reportStat.size > MAX_REPORT_BYTES
        ) {
          continue;
        }

        // Validate manifest.json
        const manifestStat = await lstat(manifestPath);
        if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) continue;

        const manifest = await readJson<StagingManifest>(manifestPath);
        if (
          manifest?.schema !== "skillopt-sleep-staging" ||
          manifest?.schema_version !== 2 ||
          manifest?.accepted !== true
        ) {
          continue;
        }

        // Check 1: managed proposal
        if (manifest.has_managed_skill && manifest.legacy?.skill) {
          const legSkill = manifest.legacy.skill;
          const proposedFile = legSkill.proposed_file;
          const livePath = legSkill.live_path;
          const expectedSha = legSkill.sha256;

          if (
            proposedFile &&
            livePath &&
            expectedSha &&
            typeof proposedFile === "string" &&
            typeof livePath === "string" &&
            typeof expectedSha === "string"
          ) {
            const adoptedLegacyFile = join(stagingDir, "adopted_legacy.json");
            const isAdopted = await pathExists(adoptedLegacyFile);

            if (!isAdopted) {
              const proposedSkillPath = join(stagingDir, proposedFile);
              const targetSkillPath = resolve(livePath);
              const skillName =
                basename(dirname(targetSkillPath)) || "skillopt-sleep-learned";

              if (
                safeSkillName(skillName) &&
                isWithin(expectedSkillRoot, targetSkillPath) &&
                basename(targetSkillPath) === "SKILL.md" &&
                (await pathExists(proposedSkillPath))
              ) {
                const propStat = await lstat(proposedSkillPath);
                if (
                  !propStat.isSymbolicLink() &&
                  propStat.isFile() &&
                  propStat.size <= MAX_PROPOSED_SKILL_BYTES
                ) {
                  const actualSha = await sha256File(proposedSkillPath);
                  if (actualSha === expectedSha) {
                    const proposalId = sha256Hex(
                      `${realStagingDir}managed${skillName}${actualSha}`,
                    );

                    const resolution = await this.repo.getResolution(
                      projectId,
                      proposalId,
                    );
                    if (resolution?.decision !== "discarded") {
                      proposals.push({
                        id: proposalId,
                        kind: "managed",
                        skillName,
                        stagingDir: realStagingDir,
                        manifestPath,
                        reportPath,
                        proposedSkillPath,
                        proposedSha256: actualSha,
                        targetSkillPath,
                        accepted: true,
                        hasManagedSkill: true,
                      });
                    }
                  }
                }
              }
            }
          }
        }

        // Check 2: skills fan-out rows
        if (Array.isArray(manifest.skills)) {
          const adoptedSkillsFile = join(stagingDir, "adopted_skills.json");
          const adoptedList =
            (await readJson<Array<{ skill_name?: string }>>(
              adoptedSkillsFile,
            )) ?? [];
          const adoptedNames = new Set(
            adoptedList.map((r) => r.skill_name).filter(Boolean),
          );

          for (const row of manifest.skills) {
            const skillName = row.skill_name;
            const proposedFile = row.proposed_file;
            const livePath = row.live_skill_path;
            const expectedSha = row.sha256;

            if (
              !skillName ||
              !proposedFile ||
              !livePath ||
              !expectedSha ||
              adoptedNames.has(skillName) ||
              !safeSkillName(skillName)
            ) {
              continue;
            }

            const targetSkillPath = resolve(livePath);
            if (
              !isWithin(expectedSkillRoot, targetSkillPath) ||
              basename(targetSkillPath) !== "SKILL.md" ||
              basename(dirname(targetSkillPath)) !== skillName
            ) {
              continue;
            }

            const proposedSkillPath = join(stagingDir, proposedFile);
            if (!(await pathExists(proposedSkillPath))) continue;

            const propStat = await lstat(proposedSkillPath);
            if (
              propStat.isSymbolicLink() ||
              !propStat.isFile() ||
              propStat.size > MAX_PROPOSED_SKILL_BYTES
            ) {
              continue;
            }

            const actualSha = await sha256File(proposedSkillPath);
            if (actualSha !== expectedSha) continue;

            const proposalId = sha256Hex(
              `${realStagingDir}skill${skillName}${actualSha}`,
            );

            const resolution = await this.repo.getResolution(
              projectId,
              proposalId,
            );
            if (resolution?.decision === "discarded") continue;

            proposals.push({
              id: proposalId,
              kind: "skill",
              skillName,
              stagingDir: realStagingDir,
              manifestPath,
              reportPath,
              proposedSkillPath,
              proposedSha256: actualSha,
              targetSkillPath,
              accepted: true,
              hasManagedSkill: false,
            });
          }
        }
      } catch {
        // Staging directory corrupted or inaccessible, skip safely
      }
    }

    return proposals;
  }
}
