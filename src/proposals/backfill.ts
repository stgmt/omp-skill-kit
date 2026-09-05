import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ProposalRepository } from "./repository.js";
import { validateAndParseSessionFile } from "./session-source.js";

/** Max session files examined per backfill pass (newest first). */
export const BACKFILL_MAX_FILES = 50;

/** Minimum age of the backfill marker before a rescan is allowed. */
export const BACKFILL_RESCAN_INTERVAL_MS = 24 * 3600 * 1000;

export interface BackfillResult {
  scanned: number;
  recorded: number;
  skipped: number;
}

/**
 * Resolve `<profileRoot>/agent/sessions` from the live session directory.
 * Falls back to `PI_CODING_AGENT_DIR` (or `~/.omp/agent`) when the session
 * manager is unavailable (e.g. headless mocks in tests).
 */
export function resolveProfileSessionsRoot(sessionDir?: string): string {
  if (sessionDir) {
    return dirname(sessionDir);
  }
  const agentDir =
    process.env.PI_CODING_AGENT_DIR || join(homedir(), ".omp", "agent");
  return join(agentDir, "sessions");
}

/**
 * One-time (per 24h) import of pre-existing session transcripts for a project.
 *
 * Sessions recorded through the normal `session_shutdown` path are untouched;
 * only files with no receipt yet are validated and recorded. Validation reuses
 * the same strict rules as live shutdown handling (main JSONL directly under
 * `agent/sessions/<project-dir>`, single unambiguous session header, header
 * cwd matching the project, no symlinks), so nested advisor/scout sidecars
 * and foreign-project transcripts are skipped the same way.
 */
export async function backfillProjectSessions(
  repo: ProposalRepository,
  sessionsRoot: string,
  projectCwd: string,
  opts?: { limit?: number },
): Promise<BackfillResult> {
  const limit = Math.max(1, opts?.limit ?? BACKFILL_MAX_FILES);
  const result: BackfillResult = { scanned: 0, recorded: 0, skipped: 0 };

  let entries: string[];
  try {
    entries = await readdir(sessionsRoot);
  } catch {
    return result;
  }

  const candidates: { path: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    const subdir = join(sessionsRoot, entry);
    try {
      const dirStat = await lstat(subdir);
      if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
        continue;
      }
      const files = await readdir(subdir);
      for (const file of files) {
        if (!file.endsWith(".jsonl")) {
          continue;
        }
        const full = join(subdir, file);
        try {
          const fileStat = await lstat(full);
          if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
            continue;
          }
          candidates.push({ path: full, mtimeMs: fileStat.mtimeMs });
        } catch {
          // Ignore unreadable session files.
        }
      }
    } catch {
      // Ignore unreadable project directories.
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const candidate of candidates.slice(0, limit)) {
    result.scanned++;
    try {
      const parsed = await validateAndParseSessionFile(
        candidate.path,
        projectCwd,
      );
      if (!parsed.valid) {
        result.skipped++;
        continue;
      }
      const recorded = await repo.recordCompletedSession({
        sessionId: parsed.sessionId,
        sessionHash: parsed.sessionHash,
        sessionFile: parsed.sessionFile,
        projectId: parsed.projectId,
        projectRoot: parsed.projectRoot,
        profileRoot: parsed.profileRoot,
        startedAt: parsed.startedAt,
        completedAt: new Date(candidate.mtimeMs).toISOString(),
      });
      if (recorded) {
        result.recorded++;
      } else {
        result.skipped++;
      }
    } catch {
      result.skipped++;
    }
  }

  return result;
}

/**
 * Run the backfill when the per-project marker is missing or older than 24h.
 * Returns the backfill result, or `undefined` when a fresh marker exists or no
 * sessions root could be resolved. Never throws.
 */
export async function maybeBackfillProjectSessions(
  repo: ProposalRepository,
  projectId: string,
  sessionsRoot: string | undefined,
  projectCwd: string,
): Promise<BackfillResult | undefined> {
  try {
    if (!sessionsRoot) {
      return undefined;
    }
    const marker = await repo.getBackfillState(projectId);
    if (marker?.backfilledAt) {
      const ageMs = Date.now() - Date.parse(marker.backfilledAt);
      if (!Number.isNaN(ageMs) && ageMs < BACKFILL_RESCAN_INTERVAL_MS) {
        return undefined;
      }
    }
    const result = await backfillProjectSessions(
      repo,
      sessionsRoot,
      projectCwd,
    );
    await repo.recordBackfill(projectId);
    return result;
  } catch {
    return undefined;
  }
}
