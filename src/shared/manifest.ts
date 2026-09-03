import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_SCHEMA_VERSION } from "./constants.js";
import type { HostPlatform } from "./platform.js";

export interface UvAsset {
  url: string;
  sha256: string;
}

export interface TargetSpec {
  uvAsset: string;
  uvPlatform: string;
  emulatedFromX64?: boolean;
  gccLibrary?: string;
  lockFile: string;
  lockSha256: string;
}

export interface RuntimeManifest {
  schemaVersion: number;
  pluginMinOmp: string;
  python: { version: string; requiresPython: string };
  uv: { version: string; assets: Record<string, UvAsset> };
  megaTron: {
    commit: string;
    archiveUrl: string;
    archiveSha256: string;
    license: string;
  };
  targets: Record<string, TargetSpec>;
}

/** Load the bundled manifest (single source of truth for pins). */
export function loadManifest(pluginRoot: string): RuntimeManifest {
  const raw = readFileSync(join(pluginRoot, "runtime-manifest.json"), "utf8");
  const manifest = JSON.parse(raw) as RuntimeManifest;
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `runtime-manifest schema mismatch: expected ${MANIFEST_SCHEMA_VERSION}, got ${manifest.schemaVersion}`,
    );
  }
  return manifest;
}

export function targetSpec(
  manifest: RuntimeManifest,
  host: HostPlatform,
): TargetSpec {
  const spec = manifest.targets[host.target];
  if (!spec) throw new Error(`no target spec for ${host.target}`);
  return spec;
}

export function uvAsset(manifest: RuntimeManifest, spec: TargetSpec): UvAsset {
  const asset = manifest.uv.assets[spec.uvAsset];
  if (!asset) throw new Error(`no uv asset "${spec.uvAsset}" in manifest`);
  return asset;
}
