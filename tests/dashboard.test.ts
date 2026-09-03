import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { browserOpenCommand } from "../src/dashboard.js";
import { resolveBackgroundPython } from "../src/shared/spawn.js";

describe("dashboard browser opener", () => {
  it("opens Windows URLs directly without a console shell", () => {
    const url = "http://127.0.0.1:7531/?source=omp skill kit";

    expect(browserOpenCommand(url, "win32")).toEqual(["explorer.exe", url]);
  });

  it.each([
    ["darwin", "open"],
    ["linux", "xdg-open"],
    ["freebsd", "xdg-open"],
  ] as const)("keeps the native opener on %s", (platform, executable) => {
    expect(browserOpenCommand("http://127.0.0.1:7531/", platform)).toEqual([
      executable,
      "http://127.0.0.1:7531/",
    ]);
  });
});

describe("background Python launcher", () => {
  it("prefers pythonw.exe on Windows when available", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-pythonw-test-"));
    try {
      const python = join(root, "python.exe");
      const pythonw = join(root, "pythonw.exe");
      await writeFile(pythonw, "", "utf8");

      await expect(resolveBackgroundPython(python, "win32")).resolves.toBe(
        pythonw,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to python.exe when pythonw.exe is unavailable", async () => {
    const python = join(tmpdir(), "omp-missing-python.exe");

    await expect(resolveBackgroundPython(python, "win32")).resolves.toBe(
      python,
    );
  });
});
