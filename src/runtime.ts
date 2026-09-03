import { join } from "node:path";
import { STATE_SCHEMA_VERSION } from "./shared/constants.js";
import { atomicWriteJson, pathExists, readJson } from "./shared/fsx.js";

export type Phase =
  | "absent"
  | "downloading"
  | "installing-python"
  | "installing-mega-tron"
  | "warming"
  | "ready"
  | "degraded";

export const INSTALL_STEPS = [
  "preparing",
  "downloading-uv",
  "installing-python",
  "creating-venv",
  "downloading-mega-tron",
  "installing-dependencies",
  "installing-mega-tron",
  "warming-model",
  "starting-bridge",
] as const;

export type InstallStep = (typeof INSTALL_STEPS)[number];

export const INSTALL_STEP_DESCRIPTIONS: Record<InstallStep, string> = {
  preparing: "preparing",
  "downloading-uv": "downloading uv",
  "installing-python": "installing python",
  "creating-venv": "creating virtual environment",
  "downloading-mega-tron": "downloading mega-tron",
  "installing-dependencies": "installing dependencies",
  "installing-mega-tron": "installing mega-tron",
  "warming-model": "warming model",
  "starting-bridge": "starting bridge",
};

export interface InstallProgress {
  step: InstallStep;
  startedAt: string;
  downloadedBytes?: number;
  totalBytes?: number;
}

export interface RuntimeState {
  schemaVersion: number;
  pluginVersion: string;
  runtimeHash: string;
  phase: Phase;
  attempt: number;
  pid?: number;
  startedAt?: string;
  updatedAt: string;
  errorCode?: string;
  /** Failed installs keep the previous healthy runtime hash, if any. */
  lastHealthyRuntimeHash?: string;
  /** Structured progress for ongoing install */
  install?: InstallProgress;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(remMinutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatInstallProgress(
  state: RuntimeState,
  lockOwner?: { startedAt?: string },
  now: number = Date.now(),
): string {
  if (state.install) {
    const step = state.install.step;
    const stepIdx = INSTALL_STEPS.indexOf(step);
    const stepNum = stepIdx >= 0 ? stepIdx + 1 : 1;
    const desc = INSTALL_STEP_DESCRIPTIONS[step] ?? step;
    const started = new Date(
      state.install.startedAt || state.updatedAt,
    ).getTime();
    const elapsed = formatDuration(
      now - (Number.isNaN(started) ? now : started),
    );

    let details = elapsed;
    if (state.install.downloadedBytes !== undefined) {
      const downloaded = (
        state.install.downloadedBytes /
        (1024 * 1024)
      ).toFixed(1);
      if (
        state.install.totalBytes !== undefined &&
        state.install.totalBytes > 0
      ) {
        const total = (state.install.totalBytes / (1024 * 1024)).toFixed(1);
        details = `${downloaded}/${total} MB, ${elapsed}`;
      } else {
        details = `${downloaded} MB, ${elapsed}`;
      }
    }
    return `omp-skill-kit: setup ${stepNum}/9 — ${desc} (${details})`;
  }

  const phase = state.phase;
  const startedStr = lockOwner?.startedAt || state.startedAt || state.updatedAt;
  const started = new Date(startedStr).getTime();
  const elapsed = formatDuration(now - (Number.isNaN(started) ? now : started));
  return `omp-skill-kit: setup — ${phase} (${elapsed})`;
}

export function initialState(pluginVersion: string): RuntimeState {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    pluginVersion,
    runtimeHash: "",
    phase: "absent",
    attempt: 0,
    updatedAt: new Date().toISOString(),
  };
}

export class StateStore {
  constructor(private readonly home: string) {}

  private get path(): string {
    return join(this.home, "state.json");
  }

  async load(): Promise<RuntimeState> {
    const state = await readJson<RuntimeState>(this.path);
    if (!state || state.schemaVersion !== STATE_SCHEMA_VERSION) {
      return initialState("0.0.0");
    }
    return state;
  }

  async save(state: RuntimeState): Promise<void> {
    await atomicWriteJson(this.path, state);
  }

  async exists(): Promise<boolean> {
    return pathExists(this.path);
  }

  /** Rewrite phase/attempt/errorCode and bump timestamps; keeps pid/runtimeHash. */
  async transition(
    current: RuntimeState,
    patch: Partial<RuntimeState>,
  ): Promise<RuntimeState> {
    const next: RuntimeState = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await this.save(next);
    return next;
  }
}
