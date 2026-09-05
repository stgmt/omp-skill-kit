import { lstat, open } from "node:fs/promises";
import { normalize, resolve } from "node:path";
import { sha256Hex } from "../shared/fsx.js";
import { projectIdentity } from "../telemetry.js";

const MAX_HEADER_SCAN_BYTES = 1024 * 1024; // 1 MiB
const MAX_HEADER_SCAN_LINES = 256;

export function normalizeProjectPath(cwd: string): string {
  return normalize(cwd).replaceAll("\\", "/").toLowerCase();
}

export type SessionParseResult =
  | {
      valid: true;
      sessionId: string;
      sessionHash: string;
      sessionFile: string;
      startedAt: string;
      projectRoot: string;
      projectId: string;
      profileRoot: string;
    }
  | {
      valid: false;
      reason: string;
      sessionFile?: string;
    };

export async function validateAndParseSessionFile(
  sessionFile: string,
  expectedProjectCwd: string,
): Promise<SessionParseResult> {
  if (!sessionFile || typeof sessionFile !== "string") {
    return { valid: false, reason: "empty_path" };
  }

  const resolvedPath = resolve(sessionFile);

  // 1. Must exist and not be a symlink
  try {
    const st = await lstat(resolvedPath);
    if (st.isSymbolicLink()) {
      return {
        valid: false,
        reason: "symlink_not_allowed",
        sessionFile: resolvedPath,
      };
    }
    if (!st.isFile()) {
      return {
        valid: false,
        reason: "not_a_regular_file",
        sessionFile: resolvedPath,
      };
    }
  } catch {
    return {
      valid: false,
      reason: "file_not_found",
      sessionFile: resolvedPath,
    };
  }

  if (!resolvedPath.endsWith(".jsonl")) {
    return {
      valid: false,
      reason: "not_a_jsonl_file",
      sessionFile: resolvedPath,
    };
  }

  // 2. Strict OMP path structure: <profileRoot>/agent/sessions/<project-dir>/<file>.jsonl
  // Exactly 2 segments under agent/sessions
  const normalizedPath = resolvedPath.replaceAll("\\", "/");
  const sessionsMarker = "/agent/sessions/";
  const markerIndex = normalizedPath.toLowerCase().indexOf(sessionsMarker);
  if (markerIndex === -1) {
    return {
      valid: false,
      reason: "invalid_session_path_structure",
      sessionFile: resolvedPath,
    };
  }

  const profilePart = normalizedPath.slice(0, markerIndex);
  const relativePart = normalizedPath.slice(
    markerIndex + sessionsMarker.length,
  );
  const segments = relativePart.split("/").filter(Boolean);

  if (segments.length !== 2) {
    // Nested sidecars (e.g. advisor/scout dirs) have >2 segments
    return {
      valid: false,
      reason: "nested_sidecar_or_invalid_depth",
      sessionFile: resolvedPath,
    };
  }

  const profileRoot = resolve(profilePart);

  // 3. Scan up to 1 MiB / 256 lines for the session header
  let buffer: Buffer;
  const fileHandle = await open(resolvedPath, "r");
  try {
    const stat = await fileHandle.stat();
    const bytesToRead = Math.min(stat.size, MAX_HEADER_SCAN_BYTES);
    buffer = Buffer.alloc(bytesToRead);
    await fileHandle.read(buffer, 0, bytesToRead, 0);
  } finally {
    await fileHandle.close();
  }

  const textChunk = buffer.toString("utf8");
  const lines = textChunk.split(/\r?\n/);
  const scanLimit = Math.min(lines.length, MAX_HEADER_SCAN_LINES);

  let sessionHeader:
    | { id?: string; cwd?: string; timestamp?: string }
    | undefined;
  let sessionHeaderCount = 0;

  for (let i = 0; i < scanLimit; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as {
        type?: string;
        id?: string;
        cwd?: string;
        timestamp?: string;
      };
      if (rec && rec.type === "session") {
        sessionHeaderCount++;
        if (sessionHeaderCount === 1) {
          sessionHeader = rec;
        }
      }
    } catch {
      // Non-JSON line before session header
    }
  }

  if (sessionHeaderCount === 0) {
    return {
      valid: false,
      reason: "missing_session_header",
      sessionFile: resolvedPath,
    };
  }
  if (sessionHeaderCount > 1) {
    return {
      valid: false,
      reason: "ambiguous_session_header",
      sessionFile: resolvedPath,
    };
  }

  const headerId = sessionHeader?.id;
  const headerCwd = sessionHeader?.cwd;
  const headerTs = sessionHeader?.timestamp;

  if (!headerId || typeof headerId !== "string") {
    return {
      valid: false,
      reason: "missing_session_id",
      sessionFile: resolvedPath,
    };
  }
  if (!headerCwd || typeof headerCwd !== "string") {
    return {
      valid: false,
      reason: "missing_session_cwd",
      sessionFile: resolvedPath,
    };
  }
  if (
    !headerTs ||
    typeof headerTs !== "string" ||
    Number.isNaN(Date.parse(headerTs))
  ) {
    return {
      valid: false,
      reason: "invalid_session_timestamp",
      sessionFile: resolvedPath,
    };
  }

  // 4. Validate cwd matches expected project
  const expectedPath = normalizeProjectPath(expectedProjectCwd);
  const sessionPath = normalizeProjectPath(headerCwd);
  if (expectedPath !== sessionPath) {
    return {
      valid: false,
      reason: "mismatched_project_cwd",
      sessionFile: resolvedPath,
    };
  }

  const expectedIdentity = projectIdentity(expectedProjectCwd);

  return {
    valid: true,
    sessionId: headerId,
    sessionHash: sha256Hex(headerId),
    sessionFile: resolvedPath,
    startedAt: headerTs,
    projectRoot: expectedPath,
    projectId: expectedIdentity.id,
    profileRoot,
  };
}
