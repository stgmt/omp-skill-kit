import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  BridgeResponse,
  RankPayload,
  RankResult,
} from "./bridge-protocol.js";
import { rpcCall } from "./rpc.js";
import {
  MAX_CANDIDATE_HINT_BYTES,
  MAX_CANDIDATES,
  PROTOCOL_VERSION,
  ROUTE_RESTART_CAP,
  ROUTE_TIMEOUT_MS,
} from "./shared/constants.js";
import { pathExists, sha256Hex } from "./shared/fsx.js";

export interface EndpointFile {
  protocolVersion: number;
  runtimeHash: string;
  pid: number;
  port: number;
  token: string;
}
export interface RouteResult {
  names: string[];
  unavailable: boolean;
}

export class RouterClient {
  private endpoint: EndpointFile | undefined;
  private lastError: string | undefined;
  constructor(
    private readonly home: string,
    private readonly pluginRoot?: string,
  ) {}
  endpointPath(): string {
    return join(this.home, "endpoint.json");
  }
  async loadEndpoint(): Promise<void> {
    try {
      const endpoint = JSON.parse(
        await readFile(this.endpointPath(), "utf8"),
      ) as EndpointFile;
      this.endpoint =
        endpoint.protocolVersion === PROTOCOL_VERSION &&
        endpoint.port > 0 &&
        endpoint.token
          ? endpoint
          : undefined;
    } catch {
      this.endpoint = undefined;
    }
  }
  async ping(timeoutMs = 2000): Promise<boolean> {
    await this.loadEndpoint();
    if (!this.endpoint) return false;
    try {
      const response = await this.call(
        { id: randomUUID(), op: "ping", token: this.endpoint.token },
        timeoutMs,
      );
      return response.ok && response.result === "pong";
    } catch {
      return false;
    }
  }
  async rank(payload: RankPayload): Promise<RouteResult> {
    await this.loadEndpoint();
    if (!this.endpoint) return { names: [], unavailable: true };
    for (let attempt = 0; attempt <= ROUTE_RESTART_CAP; attempt++) {
      try {
        const response = await this.call(
          { id: randomUUID(), op: "rank", token: this.endpoint.token, payload },
          ROUTE_TIMEOUT_MS,
        );
        if (!response.ok) {
          this.lastError = response.error;
          return { names: [], unavailable: true };
        }
        const result = (response.result ?? { candidates: [] }) as RankResult;
        const names = this.sanitize(result.candidates ?? []);
        return { names, unavailable: false };
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        if (attempt < ROUTE_RESTART_CAP) {
          await this.restartBridge();
          await this.loadEndpoint();
          if (!this.endpoint) break;
        }
      }
    }
    return { names: [], unavailable: true };
  }
  lastRouteError(): string | undefined {
    return this.lastError;
  }
  private async call(
    request: {
      id: string;
      op: "ping" | "rank";
      token: string;
      payload?: RankPayload;
    },
    timeoutMs: number,
  ): Promise<BridgeResponse> {
    if (!this.endpoint) throw new Error("bridge endpoint unavailable");
    return rpcCall(request, {
      port: this.endpoint.port,
      token: this.endpoint.token,
      timeoutMs,
    });
  }
  private sanitize(
    candidates: Array<{ name: string; score: number }>,
  ): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    let bytes = 0;
    for (const candidate of candidates) {
      if (names.length >= MAX_CANDIDATES) break;
      const name = String(candidate.name ?? "");
      const score = Number(candidate.score);
      if (!name || !Number.isFinite(score) || seen.has(name)) continue;
      const cost = Buffer.byteLength(name, "utf8") + 1;
      if (bytes + cost > MAX_CANDIDATE_HINT_BYTES) break;
      seen.add(name);
      names.push(name);
      bytes += cost;
    }
    return names;
  }
  private async restartBridge(): Promise<void> {
    if (!this.pluginRoot) return;
    let runtime = "";
    try {
      const active = JSON.parse(
        await readFile(join(this.home, "runtime", "active.json"), "utf8"),
      ) as { venv?: string };
      runtime = active.venv ?? "";
    } catch {
      return;
    }
    const script = join(this.pluginRoot, "python", "omp_skill_kit_bridge.py");
    if (!(await pathExists(runtime)) || !(await pathExists(script))) return;
    const { spawnDetached } = await import("./shared/spawn.js");
    spawnDetached([runtime, script, "--home", this.home], {
      logFile: join(this.home, "logs", "bridge-restart.log"),
    });
  }
}

export function promptHash(prompt: string): string {
  return sha256Hex(prompt);
}
