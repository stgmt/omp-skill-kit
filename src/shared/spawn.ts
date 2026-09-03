import { spawn } from "node:child_process";
import { openSync } from "node:fs";

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
  return new Promise((resolvePromise, rejectPromise) => {
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
      if (timer) clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
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
