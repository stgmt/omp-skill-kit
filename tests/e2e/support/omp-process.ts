import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface OmpExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface OmpCommand {
  cmd: string;
  args: string[];
}

export function resolveOmpCommand(): OmpCommand {
  if (process.env.OMP_EXE) {
    return { cmd: process.env.OMP_EXE, args: [] };
  }

  // Check PATH for omp.exe (on Windows) or omp (on POSIX)
  const pathDirs = (process.env.PATH || "").split(
    process.platform === "win32" ? ";" : ":",
  );
  const candidates = process.platform === "win32" ? ["omp.exe"] : ["omp"];
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const cand of candidates) {
      const full = join(dir, cand);
      try {
        if (existsSync(full)) {
          return { cmd: full, args: [] };
        }
      } catch {}
    }
  }

  // Fallback to local package cli.js under bun when omp binary is not in PATH
  const localCli = join(
    process.cwd(),
    "node_modules",
    "@oh-my-pi",
    "pi-coding-agent",
    "dist",
    "cli.js",
  );
  if (existsSync(localCli)) {
    return { cmd: "bun", args: [localCli] };
  }

  // Default fallback
  return { cmd: process.platform === "win32" ? "omp.exe" : "omp", args: [] };
}

export function runOmp(
  argv: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
  } = {},
): Promise<OmpExecResult> {
  const { promise, resolve } = Promise.withResolvers<OmpExecResult>();
  const startTime = Date.now();
  const { cmd, args: prefixArgs } = resolveOmpCommand();

  const child = spawn(cmd, [...prefixArgs, ...argv], {
    cwd: opts.cwd,
    env: {
      ...process.env,
      ...opts.env,
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let killed = false;

  const timeoutMs = opts.timeoutMs ?? 30000;
  const timer = setTimeout(() => {
    killed = true;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], {
          windowsHide: true,
        });
      } else {
        child.kill("SIGKILL");
      }
    } catch {}
  }, timeoutMs);

  child.stdout.on("data", (c) => {
    stdout += c.toString("utf8");
  });
  child.stderr.on("data", (c) => {
    stderr += c.toString("utf8");
  });

  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({
      code: killed ? -1 : code,
      stdout,
      stderr,
      durationMs: Date.now() - startTime,
    });
  });

  child.on("error", (err) => {
    clearTimeout(timer);
    resolve({
      code: -1,
      stdout,
      stderr: `${stderr}\n${err.message}`,
      durationMs: Date.now() - startTime,
    });
  });

  return promise;
}
