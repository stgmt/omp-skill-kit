import { describe, expect, it, vi } from "vitest";

vi.mock("@oh-my-pi/pi-coding-agent/capability", () => ({
  loadCapability: vi.fn(),
}));

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CatalogStore,
  catalogRevision,
  type LoadedSkill,
} from "../src/catalog.js";

const entries: LoadedSkill[] = [
  {
    name: "alpha",
    description: "route alpha work",
    provider: "test",
    path: "/skills/alpha/SKILL.md",
  },
];

describe("catalog snapshots", () => {
  it("is deterministic and contains only routing metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-skill-kit-catalog-"));
    const store = new CatalogStore(root);
    const first = await store.publish(entries);
    const second = await store.publish(entries);
    expect(first.revision).toBe(catalogRevision(entries));
    expect(second.revision).toBe(first.revision);
    const skill = await readFile(
      join(
        root,
        first.revision,
        "skills",
        "8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8",
        "SKILL.md",
      ),
      "utf8",
    ).catch(() => "");
    expect(skill).toContain('name: "alpha"');
    expect(skill).toContain('description: "route alpha work"');
    expect(skill).not.toContain("/skills/alpha");
  });
});
