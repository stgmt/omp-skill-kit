import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  atomicWriteJson,
  pathExists,
  safeSkillName,
  sha256Hex,
} from "./shared/fsx.js";

export interface CatalogEntry {
  name: string;
  description: string;
  provider: string;
  sourcePath: string;
}
interface CapabilitySkill {
  name: string;
  path: string;
  frontmatter?: {
    description?: string;
    hide?: boolean;
    disableModelInvocation?: boolean;
  };
  _source?: { provider?: string };
}

export interface LoadedSkill {
  name: string;
  description: string;
  provider: string;
  path: string;
}

export async function loadEligibleCatalog(cwd: string): Promise<LoadedSkill[]> {
  const { loadCapability } = await import(
    "@oh-my-pi/pi-coding-agent/capability"
  );
  const result = await loadCapability<CapabilitySkill>("skills", { cwd });
  const out: LoadedSkill[] = [];
  for (const item of result.items ?? []) {
    const name = String(item.name ?? "");
    const description = String(item.frontmatter?.description ?? "").trim();
    if (!safeSkillName(name) || !description) continue;
    if (item.frontmatter?.hide || item.frontmatter?.disableModelInvocation)
      continue;
    if (Buffer.byteLength(description, "utf8") > 4096) continue;
    out.push({
      name,
      description,
      provider: String(item._source?.provider ?? "unknown"),
      path: String(item.path ?? ""),
    });
  }
  return out;
}

export function catalogRevision(entries: LoadedSkill[]): string {
  const rows = entries
    .map((e) => JSON.stringify([e.name, e.description, e.provider, e.path]))
    .sort();
  return sha256Hex(rows.join("\n"));
}

export interface SnapshotMetadata {
  revision: string;
  writtenAt: string;
  count: number;
}

export class CatalogStore {
  constructor(private readonly catalogsRoot: string) {}
  private snapshotDir(revision: string): string {
    return join(this.catalogsRoot, revision);
  }

  async publish(entries: LoadedSkill[]): Promise<SnapshotMetadata> {
    const revision = catalogRevision(entries);
    const dir = this.snapshotDir(revision);
    if (!(await pathExists(join(dir, "catalog.json")))) {
      await mkdir(join(dir, "skills"), { recursive: true });
      for (const entry of entries) {
        const skillDir = join(dir, "skills", sha256Hex(entry.name));
        await mkdir(skillDir, { recursive: true });
        const frontmatter = `---\nname: ${JSON.stringify(entry.name)}\ndescription: ${JSON.stringify(entry.description)}\n---\n`;
        await writeFile(join(skillDir, "SKILL.md"), frontmatter, "utf8");
      }
      await atomicWriteJson(join(dir, "catalog.json"), {
        revision,
        writtenAt: new Date().toISOString(),
        count: entries.length,
        entries: entries.map(({ name, description }) => ({
          name,
          description,
        })),
      });
    }
    await this.prune(revision);
    return {
      revision,
      writtenAt: new Date().toISOString(),
      count: entries.length,
    };
  }

  private async prune(current: string): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.catalogsRoot);
    } catch {
      return;
    }
    const older = names
      .filter((name) => name !== current)
      .sort()
      .reverse();
    for (const name of older.slice(2))
      await rm(join(this.catalogsRoot, name), { recursive: true, force: true });
  }

  async readCatalog(
    revision: string,
  ): Promise<Map<string, string> | undefined> {
    try {
      const data = JSON.parse(
        await readFile(
          join(this.snapshotDir(revision), "catalog.json"),
          "utf8",
        ),
      ) as { entries?: Array<{ name: string; description: string }> };
      return new Map(
        (data.entries ?? []).map((entry) => [entry.name, entry.description]),
      );
    } catch {
      return undefined;
    }
  }

  async snapshotPath(revision: string): Promise<string | undefined> {
    const p = join(this.snapshotDir(revision), "catalog.json");
    return (await pathExists(p)) ? p : undefined;
  }
}
