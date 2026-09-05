import { join } from "node:path";
import { buildXdgEnv } from "../shared/env.js";
import { run } from "../shared/spawn.js";
import type { Proposal } from "./domain.js";
import { redactSecrets } from "./process.js";
import type { ProposalRepository } from "./repository.js";

export interface AdoptProposalOptions {
  home: string;
  pluginRoot: string;
  python: string;
  projectRoot: string;
  proposal: Proposal;
}

export async function adoptProposal(
  options: AdoptProposalOptions,
): Promise<{ success: boolean; error?: string }> {
  const { home, pluginRoot, python, projectRoot, proposal } = options;
  const configPath = join(home, "proposals", "skillopt-config.json");
  const pluginPython = join(pluginRoot, "python");
  const xdgEnv = buildXdgEnv(home);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...xdgEnv,
    PYTHONPATH: pluginPython,
    SKILLOPT_SLEEP_CONFIG: configPath,
  };

  const claudeHome = join(projectRoot, ".omp");
  const skillRoot = join(projectRoot, ".omp", "skills");

  const argv = [
    python,
    "-m",
    "skillopt_sleep",
    "adopt",
    "--project",
    projectRoot,
    "--claude-home",
    claudeHome,
    "--skill-root",
    skillRoot,
    "--staging",
    proposal.stagingDir,
  ];

  if (proposal.kind === "managed") {
    argv.push("--legacy");
  } else {
    argv.push("--skill", proposal.skillName);
  }

  argv.push("--json");

  try {
    const result = await run(argv, {
      cwd: projectRoot,
      env,
      timeoutMs: 60_000,
    });

    if (result.code !== 0) {
      const errorText = redactSecrets(result.stderr || result.stdout).slice(
        0,
        1000,
      );
      return {
        success: false,
        error: `Adoption failed with exit code ${result.code}: ${errorText}`,
      };
    }

    return { success: true };
  } catch (err: unknown) {
    const errorText = redactSecrets(
      err instanceof Error ? err.message : String(err),
    ).slice(0, 1000);
    return {
      success: false,
      error: errorText,
    };
  }
}

export async function discardProposal(
  repo: ProposalRepository,
  projectId: string,
  proposalId: string,
  reason?: string,
): Promise<void> {
  await repo.recordResolution(projectId, {
    proposalId,
    decision: "discarded",
    resolvedAt: new Date().toISOString(),
    reason,
  });
}
