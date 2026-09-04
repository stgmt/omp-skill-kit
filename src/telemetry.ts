import { appendFile, mkdir, readFile } from "node:fs/promises";
import { basename, join, normalize } from "node:path";
import { sha256Hex } from "./shared/fsx.js";

export type RouteStatus =
  | "matched"
  | "empty"
  | "unavailable"
  | "timeout"
  | "failed";
export type FeedbackVerdict = "helpful" | "harmful" | "neutral";

export interface RouteTelemetry {
  schemaVersion: 1;
  type: "route";
  eventId: string;
  routeId: string;
  ts: string;
  host: "omp";
  projectId: string;
  projectName: string;
  sessionId: string;
  turnId: string;
  catalogRevision: string;
  promptHash?: string;
  status: RouteStatus;
  reason?: string;
  latencyMs: number;
  candidates: Array<{ name: string; score: number }>;
  selected: string[];
}

export interface UsageTelemetry {
  schemaVersion: 1;
  type: "usage";
  eventId: string;
  routeId: string;
  ts: string;
  host: "omp";
  projectId: string;
  projectName: string;
  sessionId: string;
  turnId: string;
  catalogRevision: string;
  used: string[];
  toolErrors: number;
  outcome: "completed" | "failed" | "unknown";
}

export interface FeedbackTelemetry {
  schemaVersion: 1;
  type: "feedback";
  eventId: string;
  routeId: string;
  ts: string;
  host: "omp";
  projectId: string;
  projectName: string;
  sessionId: string;
  turnId: string;
  catalogRevision: string;
  used: string[];
  toolErrors: number;
  outcome: "completed" | "failed" | "unknown";
  verdict: FeedbackVerdict;
  accepted: boolean;
}

export type TelemetryEvent =
  | RouteTelemetry
  | UsageTelemetry
  | FeedbackTelemetry;

export interface ProjectIdentity {
  id: string;
  name: string;
}

export function projectIdentity(cwd: string): ProjectIdentity {
  const normalized = normalize(cwd).replaceAll("\\", "/").toLowerCase();
  return {
    id: sha256Hex(normalized),
    name: basename(normalized) || "unknown-project",
  };
}

export function telemetryPath(home: string): string {
  return join(home, "telemetry", "events.jsonl");
}

export class TelemetryStore {
  constructor(private readonly home: string) {}

  async append(event: TelemetryEvent): Promise<void> {
    const line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(line, "utf8") > 32 * 1024) return;
    const path = telemetryPath(this.home);
    await mkdir(join(this.home, "telemetry"), { recursive: true });
    await appendFile(path, line, "utf8");
  }

  async read(limit = 5000): Promise<TelemetryEvent[]> {
    try {
      const raw = await readFile(telemetryPath(this.home), "utf8");
      const events: TelemetryEvent[] = [];
      for (const line of raw.split("\n").slice(-limit)) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as TelemetryEvent;
          if (
            parsed &&
            parsed.schemaVersion === 1 &&
            typeof parsed.type === "string"
          ) {
            events.push(parsed);
          }
        } catch {
          // Ignore a torn final line; the next event remains usable.
        }
      }
      return events;
    } catch {
      return [];
    }
  }
}

export function skillWasRead(path: string, skillName: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return (
    normalized === `skill://${skillName}` ||
    normalized.startsWith(`skill://${skillName}/`) ||
    normalized.includes(`/skills/${skillName}/SKILL.md`) ||
    normalized.includes(`/skills/${skillName}/SKILL.md:`) ||
    normalized.includes(`/skills/${skillName}/SKILL.md#`)
  );
}

export function parseFeedbackMarkers(
  value: unknown,
): Map<string, FeedbackVerdict> {
  const flatten = (item: unknown): string => {
    if (typeof item === "string") return item;
    if (Array.isArray(item)) return item.map(flatten).join("\n");
    if (item && typeof item === "object")
      return Object.values(item).map(flatten).join("\n");
    return "";
  };
  const text = flatten(value);
  const result = new Map<string, FeedbackVerdict>();
  const pattern =
    /<skill-used\b[^>]*?name=["']([^"']+)["'][^>]*?verdict=["'](helpful|harmful|neutral)["'][^>]*>/gi;
  for (const match of text.matchAll(pattern)) {
    const name = match[1];
    const verdict = match[2]?.toLowerCase() as FeedbackVerdict | undefined;
    if (name && verdict) result.set(name, verdict);
  }
  return result;
}

export function isSkillPathForProject(
  path: string,
  projectCwd: string,
): boolean {
  const normalizedPath = normalize(path).replaceAll("\\", "/").toLowerCase();
  const normalizedCwd = normalize(projectCwd)
    .replaceAll("\\", "/")
    .toLowerCase()
    .replace(/\/$/, "");
  return (
    normalizedPath.startsWith(`${normalizedCwd}/`) &&
    normalizedPath.includes("/skill.md")
  );
}
