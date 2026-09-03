import { describe, expect, it } from "vitest";
import { detectPlatform } from "../src/shared/platform.js";

describe("platform selection", () => {
  it("returns a manifest target for the current supported workstation", () => {
    const host = detectPlatform();
    expect([
      "windows-x64",
      "windows-arm64",
      "linux-x64",
      "linux-arm64",
      "macos-x64",
      "macos-arm64",
    ]).toContain(host.target);
    expect(typeof host.supported).toBe("boolean");
  });

  it("covers every supported target in the manifest", () => {
    const cases = [
      ["win32", "x64", "windows-x64"],
      ["win32", "arm64", "windows-arm64"],
      ["linux", "x64", "linux-x64"],
      ["linux", "arm64", "linux-arm64"],
      ["darwin", "x64", "macos-x64"],
      ["darwin", "arm64", "macos-arm64"],
    ] as const;
    for (const [platform, arch, target] of cases) {
      expect(detectPlatform(platform, arch)).toMatchObject({
        target,
        supported: true,
      });
    }
  });

  it("rejects unsupported architectures and platforms", () => {
    expect(detectPlatform("win32", "ia32").supported).toBe(false);
    expect(detectPlatform("linux", "ia32").supported).toBe(false);
    expect(detectPlatform("darwin", "ia32").supported).toBe(false);
    expect(detectPlatform("freebsd", "x64").supported).toBe(false);
  });
});
