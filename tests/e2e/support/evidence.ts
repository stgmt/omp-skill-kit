import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RequestReceipt } from "./openai-stub.js";

export interface ScenarioResult {
  name: string;
  status: "passed" | "failed";
  durationMs: number;
  details?: Record<string, unknown>;
}

export interface E2EManifest {
  runId: string;
  timestamp: string;
  platform: string;
  arch: string;
  ompVersion: string;
  pluginVersion: string;
  archiveSha256: string;
  environment: string;
  scenarios: ScenarioResult[];
  receipts: RequestReceipt[];
  privacyVerified: boolean;
}

export class EvidenceCollector {
  private scenarios: ScenarioResult[] = [];
  private receipts: RequestReceipt[] = [];

  constructor(
    private readonly runId: string,
    private readonly environment: string,
    private readonly ompVersion: string,
    private readonly pluginVersion: string,
    private readonly archiveSha256: string,
  ) {}

  addScenario(scenario: ScenarioResult): void {
    this.scenarios.push(scenario);
  }

  addReceipts(receipts: RequestReceipt[]): void {
    this.receipts.push(...receipts);
  }

  async save(outputDir?: string): Promise<string> {
    const dir = outputDir || join(process.cwd(), "reports", "e2e", this.runId);
    await mkdir(dir, { recursive: true });
    const manifestPath = join(dir, "manifest.json");

    // Strict privacy verification: verify zero tokens or sensitive keys in manifest
    const manifest: E2EManifest = {
      runId: this.runId,
      timestamp: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      ompVersion: this.ompVersion,
      pluginVersion: this.pluginVersion,
      archiveSha256: this.archiveSha256,
      environment: this.environment,
      scenarios: this.scenarios,
      receipts: this.receipts,
      privacyVerified: true,
    };

    const raw = JSON.stringify(manifest, null, 2);
    // Sanity check for secrets
    if (
      raw.includes("sk-") ||
      raw.includes("Bearer ") ||
      raw.includes("token_hex")
    ) {
      throw new Error(
        "Security violation: secret token leaked into evidence manifest!",
      );
    }

    await writeFile(manifestPath, `${raw}\n`, "utf8");
    return manifestPath;
  }
}
