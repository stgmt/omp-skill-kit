import { describe, expect, it, vi } from "vitest";

vi.mock("@oh-my-pi/pi-coding-agent/capability", () => ({
  loadCapability: vi.fn(),
}));

import extension from "../src/extension.js";

describe("native extension registration", () => {
  it("registers only the supported lifecycle and commands", () => {
    const events: string[] = [];
    const commands: string[] = [];
    extension({
      on: (name: string) => events.push(name),
      registerCommand: (name: string) => commands.push(name),
    } as any);
    expect(events).toEqual(["session_start", "before_agent_start"]);
    expect(commands).toEqual([
      "omp-skill-kit:status",
      "omp-skill-kit:setup",
      "omp-skill-kit:doctor",
      "omp-skill-kit:purge",
      "omp-skill-kit:dashboard",
    ]);
  });
});
