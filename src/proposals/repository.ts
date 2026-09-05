import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  atomicWriteJson,
  pathExists,
  readJson,
  sha256Hex,
} from "../shared/fsx.js";
import {
  type CompletedSession,
  DEFAULT_PROPOSAL_CONFIG,
  type ProjectBaseline,
  type ProposalConfig,
  type ProposalNotificationLedger,
  type ProposalResolution,
  type ProposalRun,
  type ProposalSchedule,
  type SessionOutcomeRecord,
} from "./domain.js";

export interface BackfillState {
  backfilledAt: string; // ISO string
}

export class ProposalRepository {
  readonly home: string;
  readonly proposalsDir: string;

  constructor(home: string) {
    this.home = home;
    this.proposalsDir = join(home, "proposals");
  }

  projectDir(projectId: string): string {
    return join(this.proposalsDir, projectId);
  }

  sessionsDir(projectId: string): string {
    return join(this.projectDir(projectId), "sessions");
  }

  outcomesDir(projectId: string): string {
    return join(this.projectDir(projectId), "outcomes");
  }

  runsDir(projectId: string): string {
    return join(this.projectDir(projectId), "runs");
  }

  resolutionsDir(projectId: string): string {
    return join(this.projectDir(projectId), "resolutions");
  }

  runLockDir(projectId: string): string {
    return join(this.projectDir(projectId), "run.lock");
  }

  baselineFile(projectId: string): string {
    return join(this.projectDir(projectId), "baseline.json");
  }

  scheduleFile(projectId: string): string {
    return join(this.projectDir(projectId), "schedule.json");
  }

  notificationsFile(projectId: string): string {
    return join(this.projectDir(projectId), "notifications.json");
  }

  backfillFile(projectId: string): string {
    return join(this.projectDir(projectId), "backfill.json");
  }

  userConfigFile(): string {
    return join(this.proposalsDir, "config.json");
  }

  skilloptConfigFile(): string {
    return join(this.proposalsDir, "skillopt-config.json");
  }

  async ensureProjectDirs(projectId: string): Promise<void> {
    await mkdir(this.sessionsDir(projectId), { recursive: true });
    await mkdir(this.outcomesDir(projectId), { recursive: true });
    await mkdir(this.runsDir(projectId), { recursive: true });
    await mkdir(this.resolutionsDir(projectId), { recursive: true });
  }

  async ensureBaseline(projectId: string): Promise<ProjectBaseline> {
    await this.ensureProjectDirs(projectId);
    const file = this.baselineFile(projectId);
    const existing = await readJson<ProjectBaseline>(file);
    if (existing && existing.schemaVersion === 1 && existing.baselineAt) {
      return existing;
    }
    const baseline: ProjectBaseline = {
      schemaVersion: 1,
      baselineAt: new Date().toISOString(),
    };
    await atomicWriteJson(file, baseline);
    return baseline;
  }

  async getBaseline(projectId: string): Promise<ProjectBaseline | undefined> {
    const file = this.baselineFile(projectId);
    const existing = await readJson<ProjectBaseline>(file);
    if (existing && existing.schemaVersion === 1 && existing.baselineAt) {
      return existing;
    }
    return undefined;
  }

  async getBackfillState(
    projectId: string,
  ): Promise<BackfillState | undefined> {
    const existing = await readJson<BackfillState>(
      this.backfillFile(projectId),
    );
    if (existing?.backfilledAt) {
      return existing;
    }
    return undefined;
  }

  async recordBackfill(projectId: string): Promise<void> {
    await this.ensureProjectDirs(projectId);
    await atomicWriteJson(this.backfillFile(projectId), {
      backfilledAt: new Date().toISOString(),
    } satisfies BackfillState);
  }

  /**
   * Record a completed session immutably using exclusive create (flag: "wx").
   * Returns true if recorded as new, false if it already existed.
   */
  async recordCompletedSession(session: CompletedSession): Promise<boolean> {
    await this.ensureProjectDirs(session.projectId);
    const hash = sha256Hex(session.sessionId);
    session.sessionHash = hash;
    const file = join(this.sessionsDir(session.projectId), `${hash}.json`);
    try {
      const content = `${JSON.stringify(session, null, 2)}\n`;
      await writeFile(file, content, { flag: "wx", encoding: "utf8" });
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw err;
    }
  }

  async getCompletedSession(
    projectId: string,
    sessionId: string,
  ): Promise<CompletedSession | undefined> {
    const hash = sha256Hex(sessionId);
    const file = join(this.sessionsDir(projectId), `${hash}.json`);
    return readJson<CompletedSession>(file);
  }

  async listCompletedSessions(projectId: string): Promise<CompletedSession[]> {
    const dir = this.sessionsDir(projectId);
    if (!(await pathExists(dir))) {
      return [];
    }
    const entries = await readdir(dir);
    const sessions: CompletedSession[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const session = await readJson<CompletedSession>(join(dir, entry));
      if (session) {
        sessions.push(session);
      }
    }
    return sessions;
  }

  /**
   * Retrieve pending sessions:
   * - profileRoot matches (if provided)
   * - no outcome recorded in outcomes/
   * No start-time filter: backfilled history recorded before first-seen is
   * eligible exactly like new sessions. Exclusion is permanent and
   * outcome-based only (see recordOutcome).
   * Sorted by completedAt descending (newest first).
   */
  async getPendingSessions(
    projectId: string,
    profileRoot?: string,
  ): Promise<CompletedSession[]> {
    const all = await this.listCompletedSessions(projectId);
    const outcomesDir = this.outcomesDir(projectId);

    const pending: CompletedSession[] = [];
    for (const session of all) {
      if (Number.isNaN(Date.parse(session.startedAt))) {
        continue;
      }
      if (profileRoot && session.profileRoot !== profileRoot) {
        continue;
      }
      const hasOutcome = await pathExists(
        join(outcomesDir, `${session.sessionHash}.json`),
      );
      if (hasOutcome) {
        continue;
      }
      pending.push(session);
    }

    pending.sort(
      (a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt),
    );
    return pending;
  }

  async recordOutcome(
    projectId: string,
    outcome: SessionOutcomeRecord,
  ): Promise<void> {
    await this.ensureProjectDirs(projectId);
    const hash = sha256Hex(outcome.sessionId);
    outcome.sessionHash = hash;
    const file = join(this.outcomesDir(projectId), `${hash}.json`);
    await atomicWriteJson(file, outcome);
  }

  async getOutcome(
    projectId: string,
    sessionIdOrHash: string,
  ): Promise<SessionOutcomeRecord | undefined> {
    const hash =
      sessionIdOrHash.length === 64
        ? sessionIdOrHash
        : sha256Hex(sessionIdOrHash);
    const file = join(this.outcomesDir(projectId), `${hash}.json`);
    return readJson<SessionOutcomeRecord>(file);
  }

  async recordRun(projectId: string, run: ProposalRun): Promise<void> {
    await this.ensureProjectDirs(projectId);
    const file = join(this.runsDir(projectId), `${run.runId}.json`);
    await atomicWriteJson(file, run);
  }

  async getRun(
    projectId: string,
    runId: string,
  ): Promise<ProposalRun | undefined> {
    const file = join(this.runsDir(projectId), `${runId}.json`);
    return readJson<ProposalRun>(file);
  }

  async listRuns(projectId: string): Promise<ProposalRun[]> {
    const dir = this.runsDir(projectId);
    if (!(await pathExists(dir))) {
      return [];
    }
    const entries = await readdir(dir);
    const runs: ProposalRun[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const run = await readJson<ProposalRun>(join(dir, entry));
      if (run) {
        runs.push(run);
      }
    }
    runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    return runs;
  }

  async getSchedule(projectId: string): Promise<ProposalSchedule | undefined> {
    const file = this.scheduleFile(projectId);
    return readJson<ProposalSchedule>(file);
  }

  async updateSchedule(
    projectId: string,
    schedule: ProposalSchedule,
  ): Promise<void> {
    await this.ensureProjectDirs(projectId);
    const file = this.scheduleFile(projectId);
    await atomicWriteJson(file, schedule);
  }

  async recordResolution(
    projectId: string,
    resolution: ProposalResolution,
  ): Promise<void> {
    await this.ensureProjectDirs(projectId);
    const file = join(
      this.resolutionsDir(projectId),
      `${resolution.proposalId}.json`,
    );
    await atomicWriteJson(file, resolution);
  }

  async getResolution(
    projectId: string,
    proposalId: string,
  ): Promise<ProposalResolution | undefined> {
    const file = join(this.resolutionsDir(projectId), `${proposalId}.json`);
    return readJson<ProposalResolution>(file);
  }

  async listResolutions(projectId: string): Promise<ProposalResolution[]> {
    const dir = this.resolutionsDir(projectId);
    if (!(await pathExists(dir))) {
      return [];
    }
    const entries = await readdir(dir);
    const resolutions: ProposalResolution[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const res = await readJson<ProposalResolution>(join(dir, entry));
      if (res) {
        resolutions.push(res);
      }
    }
    return resolutions;
  }

  async getNotificationLedger(
    projectId: string,
  ): Promise<ProposalNotificationLedger> {
    const file = this.notificationsFile(projectId);
    const existing = await readJson<ProposalNotificationLedger>(file);
    if (existing && existing.schemaVersion === 1) {
      return existing;
    }
    return { schemaVersion: 1, notifiedProposalIds: {} };
  }

  async updateNotificationLedger(
    projectId: string,
    ledger: ProposalNotificationLedger,
  ): Promise<void> {
    await this.ensureProjectDirs(projectId);
    const file = this.notificationsFile(projectId);
    await atomicWriteJson(file, ledger);
  }

  async getUserConfig(): Promise<ProposalConfig> {
    const file = this.userConfigFile();
    const existing = await readJson<ProposalConfig>(file);
    if (existing && existing.schemaVersion === 1) {
      return existing;
    }
    return DEFAULT_PROPOSAL_CONFIG;
  }

  async getSkilloptConfig(): Promise<Record<string, unknown> | undefined> {
    const file = this.skilloptConfigFile();
    return readJson<Record<string, unknown>>(file);
  }
}
