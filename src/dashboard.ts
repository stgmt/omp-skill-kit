import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeState } from "./runtime.js";
import { readJson } from "./shared/fsx.js";

export interface DashboardSummary {
  phase: string;
  runtimeHash: string;
  bridge: "up" | "down";
  statePath: string;
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
  return {
    phase: state?.phase ?? "absent",
    runtimeHash: state?.runtimeHash ?? "",
    bridge,
    statePath: join(home, "state.json"),
  };
}

export function renderDashboard(summary: DashboardSummary): string {
  return [
    "omp-skill-kit dashboard",
    `phase: ${summary.phase}`,
    `runtime: ${summary.runtimeHash || "none"}`,
    `bridge: ${summary.bridge}`,
    `state: ${summary.statePath}`,
  ].join("\n");
}
