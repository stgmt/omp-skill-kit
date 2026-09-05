/**
 * Domain types for SkillOpt proposal management in omp-skill-kit.
 */

export type SessionOutcome = "analyzed" | "no_tasks" | "rejected" | "failed";

export interface CompletedSession {
  sessionId: string;
  sessionHash: string; // sha256(sessionId)
  sessionFile: string; // normalized path to .jsonl
  projectId: string; // project identity hash
  projectRoot: string; // normalized cwd
  profileRoot: string; // OMP profile root (e.g. ~/.omp or custom profile)
  startedAt: string; // ISO string from session header
  completedAt: string; // ISO string at session_shutdown
}

export interface SessionOutcomeRecord {
  sessionId: string;
  sessionHash: string;
  runId: string;
  outcome: SessionOutcome;
  recordedAt: string;
  error?: string;
}

export interface ProjectBaseline {
  schemaVersion: 1;
  baselineAt: string; // ISO string
}

export type ProposalRunStatus =
  | "running"
  | "analyzed"
  | "no_tasks"
  | "rejected"
  | "failed";

export interface ProposalRun {
  runId: string;
  projectId: string;
  projectRoot: string;
  profileRoot: string;
  model: string;
  sessionIds: string[];
  sessionPaths: string[];
  startedAt: string; // ISO string
  completedAt?: string; // ISO string
  pid: number;
  status: ProposalRunStatus;
  error?: string;
}

export interface ProposalSchedule {
  schemaVersion: 1;
  lastRunAt: string; // ISO string
  lastRunId: string;
  lastStatus: ProposalRunStatus;
}

export type ProposalKind = "managed" | "skill";

export interface Proposal {
  id: string; // sha256(realStagingPath + kind + skillName + proposedSha256)
  kind: ProposalKind;
  skillName: string;
  stagingDir: string;
  manifestPath: string;
  reportPath: string;
  proposedSkillPath: string;
  proposedSha256: string;
  targetSkillPath: string;
  accepted: boolean;
  hasManagedSkill: boolean;
}

export interface ProposalResolution {
  proposalId: string;
  decision: "adopted" | "discarded";
  resolvedAt: string; // ISO string
  reason?: string;
}

export interface ProposalNotificationLedger {
  schemaVersion: 1;
  notifiedProposalIds: Record<string, string>; // proposalId -> ISO string
}

export interface ProposalConfig {
  schemaVersion: 1;
  enabled: boolean;
  batchSize: number;
  minimumIntervalHours: number;
  model: string;
  fallbackModels: string[];
  autoAdopt: boolean;
}

export const DEFAULT_PROPOSAL_CONFIG: ProposalConfig = {
  schemaVersion: 1,
  enabled: true,
  batchSize: 5,
  minimumIntervalHours: 24,
  model: "@smol",
  fallbackModels: ["current"],
  autoAdopt: false,
};
