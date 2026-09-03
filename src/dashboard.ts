import { readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import type { RuntimeState } from "./runtime.js";
import { buildXdgEnv } from "./shared/env.js";
import { atomicWriteJson, pathExists, readJson } from "./shared/fsx.js";
import { spawnDetached } from "./shared/spawn.js";

export interface DashboardFile {
  schemaVersion: number;
  runtimeHash: string;
  pid: number;
  port: number;
  url: string;
  startedAt: string;
}

export interface DashboardSummary {
  phase: string;
  runtimeHash: string;
  bridge: "up" | "down";
  dashboard: "up" | "down";
  url?: string;
  statePath: string;
}

export function dashboardFilePath(home: string): string {
  return join(home, "dashboard.json");
}

export async function getDashboardOverview(
  port: number,
  timeoutMs = 1500,
): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/overview`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as Record<string, unknown>;
    return typeof json === "object" && json !== null ? json : undefined;
  } catch {
    return undefined;
  }
}

export async function isDashboardAlive(
  home: string,
  runtimeHash?: string,
): Promise<DashboardFile | undefined> {
  const p = dashboardFilePath(home);
  if (!(await pathExists(p))) return undefined;
  try {
    const raw = await readFile(p, "utf8");
    const file = JSON.parse(raw) as DashboardFile;
    if (
      file.schemaVersion !== 1 ||
      !file.port ||
      !file.pid ||
      (runtimeHash && file.runtimeHash !== runtimeHash)
    ) {
      return undefined;
    }
    const overview = await getDashboardOverview(file.port);
    if (overview) return file;
    // Not responding, remove stale file
    try {
      await rm(p, { force: true });
    } catch {}
    return undefined;
  } catch {
    return undefined;
  }
}

export function findFreeLoopbackPort(preferred = 7531): Promise<number> {
  return new Promise((resolvePromise) => {
    const srv = createServer();
    srv.listen(preferred, "127.0.0.1", () => {
      srv.close(() => resolvePromise(preferred));
    });
    srv.on("error", () => {
      const fallback = createServer();
      fallback.listen(0, "127.0.0.1", () => {
        const address = fallback.address();
        const port =
          typeof address === "object" && address ? address.port : 7532;
        fallback.close(() => resolvePromise(port));
      });
      fallback.on("error", () => resolvePromise(7532));
    });
  });
}

export async function resolveMegaTronCli(home: string): Promise<{
  command: string[];
  runtimeHash: string;
}> {
  const activePath = join(home, "runtime", "active.json");
  if (!(await pathExists(activePath))) {
    throw new Error("runtime not installed; run setup first");
  }
  const active = JSON.parse(await readFile(activePath, "utf8")) as {
    runtimeHash?: string;
    megaTron?: string;
    venv?: string;
    versionRoot?: string;
  };
  const isWindows = process.platform === "win32";
  const venvDir = active.venv ? dirname(dirname(active.venv)) : "";
  const scriptsDir = isWindows
    ? join(venvDir, "Scripts")
    : join(venvDir, "bin");
  const directExe = join(scriptsDir, isWindows ? "mega-tron.exe" : "mega-tron");
  if (await pathExists(directExe)) {
    return { command: [directExe], runtimeHash: active.runtimeHash || "" };
  }
  if (active.venv && (await pathExists(active.venv))) {
    return {
      command: [active.venv, "-m", "mega_tron.cli"],
      runtimeHash: active.runtimeHash || "",
    };
  }
  throw new Error("mega-tron CLI not found in venv");
}

export async function ensureDashboard(
  home: string,
  _pluginRoot?: string,
  opts: {
    openBrowser?: boolean;
    printMode?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<{ url: string; pid: number; reused: boolean }> {
  const { command, runtimeHash } = await resolveMegaTronCli(home);
  const alive = await isDashboardAlive(home, runtimeHash);
  if (alive) {
    if (opts.openBrowser && !opts.printMode) {
      openBrowserSafely(alive.url);
    }
    return { url: alive.url, pid: alive.pid, reused: true };
  }

  const port = await findFreeLoopbackPort(7531);
  const logDir = join(home, "logs");
  await import("node:fs/promises").then((fs) =>
    fs.mkdir(logDir, { recursive: true }),
  );

  const pid = spawnDetached(
    [
      ...command,
      "dashboard",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-open",
    ],
    {
      env: { ...process.env, ...buildXdgEnv(home) },
      logFile: join(logDir, "dashboard.log"),
    },
  );

  const url = `http://127.0.0.1:${port}/`;
  const timeout = opts.timeoutMs ?? 10000;
  const start = Date.now();
  let ready = false;

  while (Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, 200));
    const overview = await getDashboardOverview(port, 500);
    if (overview) {
      ready = true;
      break;
    }
  }

  if (!ready) {
    throw new Error(
      `dashboard failed to respond at ${url} within ${timeout}ms`,
    );
  }

  const fileData: DashboardFile = {
    schemaVersion: 1,
    runtimeHash,
    pid,
    port,
    url,
    startedAt: new Date().toISOString(),
  };
  await atomicWriteJson(dashboardFilePath(home), fileData);

  if (opts.openBrowser && !opts.printMode) {
    openBrowserSafely(url);
  }

  return { url, pid, reused: false };
}

export async function stopDashboard(home: string): Promise<void> {
  const p = dashboardFilePath(home);
  if (!(await pathExists(p))) return;
  try {
    const raw = await readFile(p, "utf8");
    const file = JSON.parse(raw) as DashboardFile;
    if (file.pid && file.pid > 0 && file.pid !== process.pid) {
      try {
        process.kill(file.pid, "SIGTERM");
      } catch {
        try {
          process.kill(file.pid, "SIGKILL");
        } catch {}
      }
    }
  } catch {}
  try {
    await rm(p, { force: true });
  } catch {}
}

function openBrowserSafely(url: string): void {
  try {
    const isWindows = process.platform === "win32";
    const isMac = process.platform === "darwin";
    if (isWindows) {
      spawnDetached(["cmd.exe", "/c", "start", "", url], {});
    } else if (isMac) {
      spawnDetached(["open", url], {});
    } else {
      spawnDetached(["xdg-open", url], {});
    }
  } catch {}
}

export async function dashboardSummary(
  home: string,
): Promise<DashboardSummary> {
  const state = await readJson<RuntimeState>(join(home, "state.json"));
  let bridge: "up" | "down" = "down";
  try {
    const endpoint = JSON.parse(
      await readFile(join(home, "endpoint.json"), "utf8"),
    ) as { port?: number };
    bridge = endpoint.port && endpoint.port > 0 ? "up" : "down";
  } catch {}

  const dash = await isDashboardAlive(home, state?.runtimeHash);
  return {
    phase: state?.phase ?? "absent",
    runtimeHash: state?.runtimeHash ?? "",
    bridge,
    dashboard: dash ? "up" : "down",
    url: dash?.url,
    statePath: join(home, "state.json"),
  };
}

export function renderDashboard(summary: DashboardSummary): string {
  return [
    "omp-skill-kit dashboard",
    `phase: ${summary.phase}`,
    `runtime: ${summary.runtimeHash || "none"}`,
    `bridge: ${summary.bridge}`,
    `dashboard: ${summary.dashboard}${summary.url ? ` (${summary.url})` : ""}`,
    `state: ${summary.statePath}`,
  ].join("\n");
}
