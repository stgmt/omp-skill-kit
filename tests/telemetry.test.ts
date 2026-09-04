import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseFeedbackMarkers,
  projectIdentity,
  skillWasRead,
  TelemetryStore,
} from "../src/telemetry.js";

describe("OMP usage telemetry", () => {
  let home = "";

  afterEach(async () => {
    if (home) await rm(home, { recursive: true, force: true });
  });

  it("records usage without storing prompt or skill body", async () => {
    home = await mkdtemp(join(tmpdir(), "omp-telemetry-"));
    const store = new TelemetryStore(home);
    const project = projectIdentity("E:\\repos\\presentation-reels");
    await store.append({
      schemaVersion: 1,
      type: "usage",
      eventId: "usage-1",
      routeId: "route-1",
      ts: new Date().toISOString(),
      host: "omp",
      projectId: project.id,
      projectName: project.name,
      sessionId: "session-1",
      turnId: "turn-1",
      catalogRevision: "rev-1",
      used: ["video-production-patterns"],
      toolErrors: 0,
      outcome: "completed",
    });
    const raw = await readFile(join(home, "telemetry", "events.jsonl"), "utf8");
    expect(raw).toContain("video-production-patterns");
    expect(raw).not.toContain("prompt");
    expect(raw).not.toContain("SKILL.md body");
  });

  it("recognizes only a selected skill's SKILL.md read", () => {
    expect(
      skillWasRead(
        "skill://video-production-patterns",
        "video-production-patterns",
      ),
    ).toBe(true);
    expect(
      skillWasRead(
        "E:/repos/presentation-reels/.omp/skills/video-production-patterns/SKILL.md",
        "video-production-patterns",
      ),
    ).toBe(true);
    expect(
      skillWasRead(
        "E:/repos/presentation-reels/.omp/skills/video-production-patterns/SKILL.md",
        "developer-rules",
      ),
    ).toBe(false);
  });

  it("parses explicit verdict markers and ignores unknown verdicts", () => {
    const markers = parseFeedbackMarkers([
      '<skill-used name="video-production-patterns" verdict="helpful">',
      '<skill-used name="developer-rules" verdict="unknown">',
    ]);
    expect(markers.get("video-production-patterns")).toBe("helpful");
    expect(markers.has("developer-rules")).toBe(false);
  });
});
