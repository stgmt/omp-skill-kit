import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { safeSkillName } from "./shared/fsx.js";

export type DiagnosticLevel = "info" | "warn" | "error";

export type DiagnosticComponent =
  | "extension"
  | "installer"
  | "router"
  | "dashboard";

export type DiagnosticEvent =
  | "installer.ensure.started"
  | "installer.ensure.running"
  | "installer.ensure.restarted"
  | "installer.ensure.unavailable"
  | "installer.phase.changed"
  | "installer.phase.ready"
  | "installer.phase.failed"
  | "dashboard.queued"
  | "dashboard.started"
  | "dashboard.reused"
  | "dashboard.failed"
  | "route.matched"
  | "route.empty"
  | "route.unavailable"
  | "route.failed";

export interface DiagnosticEntry {
  ts: string;
  level: DiagnosticLevel;
  component: DiagnosticComponent;
  event: DiagnosticEvent;
  phase?: string;
  step?: string;
  pid?: number;
  names?: string[];
  promptHash?: string;
  error?: string;
}

export interface ComponentLogPaths {
  logsDir: string;
  extensionLog: string;
  installerLog: string;
  bridgeLog: string;
  dashboardLog: string;
}

export function getComponentLogPaths(home: string): ComponentLogPaths {
  const logsDir = join(home, "logs");
  return {
    logsDir,
    extensionLog: join(logsDir, "extension.log"),
    installerLog: join(logsDir, "installer.log"),
    bridgeLog: join(logsDir, "bridge.log"),
    dashboardLog: join(logsDir, "dashboard.log"),
  };
}

export interface DiagnosticLogOptions {
  warnFn?: (message: string, error?: unknown) => void;
}

function redactSecrets(str: string): string {
  return str
    .replace(/sk-[a-zA-Z0-9._-]+/gu, "[REDACTED]")
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/giu, "[REDACTED]");
}

export class DiagnosticLog {
  private queue: Promise<void> = Promise.resolve();
  private readonly logPath: string;
  private readonly logsDir: string;
  private readonly warnFn: (message: string, error?: unknown) => void;

  constructor(home: string, options?: DiagnosticLogOptions) {
    const paths = getComponentLogPaths(home);
    this.logsDir = paths.logsDir;
    this.logPath = paths.extensionLog;
    this.warnFn = options?.warnFn ?? ((msg) => console.warn(msg));
  }

  log(entry: Omit<DiagnosticEntry, "ts">): Promise<void> {
    const sanitizedNames = entry.names
      ? entry.names.filter(
          (name) =>
            safeSkillName(name) &&
            !name.startsWith("sk-") &&
            !name.toLowerCase().startsWith("bearer") &&
            !name.includes("/") &&
            !name.includes("\\"),
        )
      : undefined;

    const sanitizedError = entry.error
      ? redactSecrets(entry.error).slice(0, 500)
      : undefined;

    const fullEntry: DiagnosticEntry = {
      ts: new Date().toISOString(),
      level: entry.level,
      component: entry.component,
      event: entry.event,
      phase: entry.phase,
      step: entry.step,
      pid: entry.pid,
      names: sanitizedNames,
      promptHash: entry.promptHash,
      error: sanitizedError,
    };

    this.queue = this.queue.then(async () => {
      try {
        await mkdir(this.logsDir, { recursive: true });
        const line = `${JSON.stringify(fullEntry)}\n`;
        await appendFile(this.logPath, line, "utf8");
      } catch (err) {
        this.warnFn(
          `[omp-skill-kit] Failed to append diagnostic log: ${err instanceof Error ? err.message : String(err)}`,
          err,
        );
      }
    });

    return this.queue;
  }
}
