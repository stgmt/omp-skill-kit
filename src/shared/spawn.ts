import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function run(
  argv: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    timeoutMs?: number;
  } = {},
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = opts.timeoutMs
      ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs)
      : undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export function spawnDetached(
  argv: string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    logFile?: string;
  },
): number {
  const out = opts.logFile ? openSync(opts.logFile, "a") : "ignore";
  const child = spawn(argv[0], argv.slice(1), {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  child.unref();
  return child.pid ?? 0;
}

export async function resolveBackgroundPython(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  if (
    platform !== "win32" ||
    !executable.toLowerCase().endsWith("python.exe")
  ) {
    return executable;
  }
  const hiddenExecutable = join(dirname(executable), "pythonw.exe");
  try {
    await access(hiddenExecutable);
    return hiddenExecutable;
  } catch {
    return executable;
  }
}

export async function terminateProcessTree(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;

  if (platform === "win32") {
    await run(["taskkill", "/PID", String(pid), "/T", "/F"], {
      timeoutMs: 5000,
    }).catch(() => undefined);
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}
