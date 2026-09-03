import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";
import { CatalogStore, loadEligibleCatalog } from "./catalog.js";
import { promptHash, RouterClient } from "./router-client.js";
import { StateStore } from "./runtime.js";
import { BRIDGE_IDLE_SHUTDOWN_MS, PLUGIN_NAME } from "./shared/constants.js";
import { pathExists } from "./shared/fsx.js";
import { spawnDetached } from "./shared/spawn.js";

const HOME_ENV = "OMP_SKILL_KIT_HOME";

function homePath(): string {
  return process.env[HOME_ENV] || join(homedir(), ".omp", "skill-kit");
}
function pluginRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}
function installerPath(): string {
  return join(pluginRoot(), "dist", "installer.js");
}

function launchInstaller(home: string): number {
  return spawnDetached([process.execPath, installerPath(), "--home", home], {
    env: {
      ...process.env,
      BUN_BE_BUN: "1",
      OMP_SKILL_KIT_INSTALLER: "1",
      OMP_SKILL_KIT_HOME: home,
    },
    logFile: join(home, "logs", "installer.log"),
  });
}

async function ensureInstaller(home: string): Promise<void> {
  const state = await new StateStore(home).load();
  if (
    state.phase === "ready" ||
    state.phase === "downloading" ||
    state.phase === "installing-python" ||
    state.phase === "installing-mega-tron" ||
    state.phase === "warming"
  )
    return;
  if (!(await pathExists(installerPath()))) return;
  await import("node:fs/promises").then((fs) =>
    fs.mkdir(join(home, "logs"), { recursive: true }),
  );
  launchInstaller(home);
}

function appendHints(systemPrompt: string[], names: string[]): string[] {
  if (!names.length) return systemPrompt;
  return [
    ...systemPrompt,
    `<omp-skill-kit>Relevant skills: ${names.join(", ")}</omp-skill-kit>`,
  ];
}

async function statusText(home: string, client: RouterClient): Promise<string> {
  const state = await new StateStore(home).load();
  const bridge = state.phase === "ready" && (await client.ping(1500));
  return `${PLUGIN_NAME}: phase=${state.phase}; runtime=${state.runtimeHash || "none"}; bridge=${bridge ? "up" : "down"}; idle=${BRIDGE_IDLE_SHUTDOWN_MS / 60000}m`;
}

async function commandStatus(
  home: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  ctx.ui.notify(
    await statusText(home, new RouterClient(home, pluginRoot())),
    "info",
  );
}

async function commandSetup(
  home: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const pid = launchInstaller(home);
  ctx.ui.notify(
    pid
      ? `${PLUGIN_NAME}: setup started (${pid})`
      : `${PLUGIN_NAME}: setup could not start`,
    pid ? "info" : "error",
  );
}

async function commandDoctor(
  home: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const state = await new StateStore(home).load();
  const client = new RouterClient(home, pluginRoot());
  const bridge = await client.ping(1500);
  const catalog = await new CatalogStore(join(home, "catalogs")).readCatalog(
    state.runtimeHash,
  );
  ctx.ui.notify(
    `${PLUGIN_NAME}: phase=${state.phase}; bridge=${bridge ? "up" : "down"}; catalogEntries=${catalog?.size ?? 0}; lastError=${client.lastRouteError() ?? "none"}`,
    bridge ? "info" : "warning",
  );
}

async function commandPurge(
  args: string,
  home: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (!args.split(/\s+/).includes("--confirm")) {
    ctx.ui.notify(
      `${PLUGIN_NAME}: use /${PLUGIN_NAME}:purge --confirm`,
      "warning",
    );
    return;
  }
  const client = new RouterClient(home, pluginRoot());
  try {
    await client.shutdown();
  } catch {}
  try {
    const { stopDashboard } = await import("./dashboard.js");
    await stopDashboard(home);
  } catch {}
  await new Promise((r) => setTimeout(r, 600));
  await rm(home, { recursive: true, force: true });
  ctx.ui.notify(`${PLUGIN_NAME}: runtime data removed`, "info");
}

async function commandDashboard(
  home: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const state = await new StateStore(home).load();
  if (state.phase !== "ready") {
    ctx.ui.notify(
      `${PLUGIN_NAME}: runtime is ${state.phase}; run /${PLUGIN_NAME}:setup first`,
      "warning",
    );
    return;
  }
  try {
    const { ensureDashboard } = await import("./dashboard.js");
    const info = await ensureDashboard(home, pluginRoot(), {
      openBrowser: true,
    });
    ctx.ui.notify(
      `${PLUGIN_NAME}: dashboard ${info.reused ? "reused" : "started"} at ${info.url}`,
      "info",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`${PLUGIN_NAME}: dashboard failed: ${msg}`, "error");
  }
}

export default function extension(pi: ExtensionAPI): void {
  const home = homePath();
  const client = new RouterClient(home, pluginRoot());
  const catalogs = new CatalogStore(join(home, "catalogs"));

  pi.on("session_start", () => {
    void ensureInstaller(home);
  });

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx) => {
    try {
      const state = await new StateStore(home).load();
      if (state.phase !== "ready") {
        console.error(
          "[omp-skill-kit] state.phase is not ready:",
          state.phase,
          "at home:",
          home,
        );
        return;
      }
      const entries = await loadEligibleCatalog(ctx.cwd);
      const snapshot = await catalogs.publish(entries);
      console.error(
        "[omp-skill-kit] snapshot revision:",
        snapshot.revision,
        "entries count:",
        entries.length,
      );
      const result = await client.rank({
        prompt: event.prompt,
        promptHash: promptHash(event.prompt),
        catalogHash: snapshot.revision,
        catalogPath: join(home, "catalogs", snapshot.revision, "catalog.json"),
        topK: 3,
        sessionId:
          ctx.sessionManager &&
          typeof ctx.sessionManager.getSessionId === "function"
            ? ctx.sessionManager.getSessionId()
            : "ephemeral",
      });
      if (result.unavailable || !result.names.length) {
        console.error(
          "[omp-skill-kit] rank unavailable or empty:",
          result,
          "lastError:",
          client.lastRouteError(),
        );
        return;
      }
      console.error("[omp-skill-kit] rank result:", result);
      return { systemPrompt: appendHints(event.systemPrompt, result.names) };
    } catch (e) {
      console.error("[omp-skill-kit] before_agent_start error:", e);
      return;
    }
  });

  pi.registerCommand("omp-skill-kit:status", {
    description: "Show omp-skill-kit runtime status",
    handler: (_args, ctx) => commandStatus(home, ctx),
  });
  pi.registerCommand("omp-skill-kit:setup", {
    description: "Install or repair the local routing runtime",
    handler: (_args, ctx) => commandSetup(home, ctx),
  });
  pi.registerCommand("omp-skill-kit:doctor", {
    description: "Check runtime, bridge, and catalog health",
    handler: (_args, ctx) => commandDoctor(home, ctx),
  });
  pi.registerCommand("omp-skill-kit:purge", {
    description: "Remove runtime data (requires --confirm)",
    handler: (args, ctx) => commandPurge(args, home, ctx),
  });
  pi.registerCommand("omp-skill-kit:dashboard", {
    description: "Open local routing dashboard",
    handler: (_args, ctx) => commandDashboard(home, ctx),
  });
}
