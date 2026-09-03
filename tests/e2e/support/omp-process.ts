import { spawn } from "node:child_process";

export interface OmpExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export function findOmpExecutable(): string {
  // Use omp on PATH
  return process.platform === "win32" ? "omp.exe" : "omp";
}

export function runOmp(
  argv: string[],
  opts: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
  } = {},
): Promise<OmpExecResult> {
  return new Promise((resolvePromise) => {
    const startTime = Date.now();
    const ompExe = findOmpExecutable();

    const child = spawn(ompExe, argv, {
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
      resolvePromise({
        code: killed ? -1 : code,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({
        code: -1,
        stdout,
        stderr: `${stderr}\n${err.message}`,
        durationMs: Date.now() - startTime,
      });
    });
  });
}
