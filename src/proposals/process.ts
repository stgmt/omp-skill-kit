import { join } from "node:path";
import { buildXdgEnv } from "../shared/env.js";
import { run } from "../shared/spawn.js";
import type { CompletedSession, SessionOutcome } from "./domain.js";

export interface SkillOptRunBatch {
  projectId: string;
  projectRoot: string;
  profileRoot: string;
  model: string;
  sessions: CompletedSession[];
}

export interface SkillOptRunResult {
  outcome: SessionOutcome;
  rawJson?: Record<string, unknown>;
  error?: string;
}

export function redactSecrets(str: string): string {
  return str
    .replace(/sk-[a-zA-Z0-9._-]+/gu, "[REDACTED]")
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/giu, "[REDACTED]");
}

export class SkillOptProcess {
  readonly home: string;
  readonly pluginRoot: string;
  readonly python: string;

  constructor(options: { home: string; pluginRoot: string; python: string }) {
    this.home = options.home;
    this.pluginRoot = options.pluginRoot;
    this.python = options.python;
  }

  async run(batch: SkillOptRunBatch): Promise<SkillOptRunResult> {
    if (batch.sessions.length < 1) {
      return {
        outcome: "failed",
        error: `Expected at least 1 session for SkillOpt batch, got ${batch.sessions.length}`,
      };
    }

    const configPath = join(this.home, "proposals", "skillopt-config.json");
    const pluginPython = join(this.pluginRoot, "python");
    const xdgEnv = buildXdgEnv(this.home);

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...xdgEnv,
      PYTHONPATH: pluginPython,
      SKILLOPT_SLEEP_CONFIG: configPath,
    };

    const claudeHome = join(batch.projectRoot, ".omp");
    const skillRoot = join(batch.projectRoot, ".omp", "skills");

    const argv = [
      this.python,
      "-m",
      "skillopt_sleep",
      "run",
      "--source",
      "pi",
      "--scope",
      "invoked",
      "--backend",
      "pi",
      "--model",
      batch.model,
      "--project",
      batch.projectRoot,
      "--pi-home",
      batch.profileRoot,
      "--claude-home",
      claudeHome,
      "--skill-root",
      skillRoot,
      "--progress",
      "--json",
    ];

    for (const session of batch.sessions) {
      argv.push("--pi-session-file", session.sessionFile);
    }

    try {
      const result = await run(argv, {
        cwd: batch.projectRoot,
        env,
        timeoutMs: 15 * 60 * 1000,
      });

      if (result.code !== 0) {
        const errorText = redactSecrets(result.stderr || result.stdout).slice(
          0,
          1000,
        );
        return {
          outcome: "failed",
          error: `Process exit code ${result.code}: ${errorText}`,
        };
      }

      const stdout = result.stdout.trim();
      let payload: Record<string, unknown> | undefined;
      try {
        const jsonMatch = stdout.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          payload = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
        } else {
          payload = JSON.parse(stdout) as Record<string, unknown>;
        }
      } catch (parseErr) {
        return {
          outcome: "failed",
          error: `Failed to parse json output: ${redactSecrets(String(parseErr))}`,
        };
      }

      if (!payload) {
        return {
          outcome: "failed",
          error: "Empty payload from skillopt_sleep run",
        };
      }

      if (payload.accepted === true) {
        return { outcome: "analyzed", rawJson: payload };
      }

      const noEditsReason =
        typeof payload.no_edits_reason === "string"
          ? payload.no_edits_reason
          : "";
      if (
        payload.n_tasks === 0 ||
        payload.gate_action === "no_tasks" ||
        noEditsReason.includes("no tasks")
      ) {
        return { outcome: "no_tasks", rawJson: payload };
      }

      return { outcome: "rejected", rawJson: payload };
    } catch (err: unknown) {
      const errorText = redactSecrets(
        err instanceof Error ? err.message : String(err),
      ).slice(0, 1000);
      return {
        outcome: "failed",
        error: errorText,
      };
    }
  }
}
