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
