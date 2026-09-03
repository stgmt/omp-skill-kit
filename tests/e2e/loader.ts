import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathExists } from "../../src/shared/fsx.js";
import { runOmp } from "./support/omp-process.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

async function main() {
  console.log("Starting loader E2E verification...");
  const runId = `loader-${Date.now()}`;
  const testProfile = `omp-skill-kit-e2e-${runId}`;
  const tempDir = join(root, ".tmp", runId);
  await mkdir(tempDir, { recursive: true });

  try {
    // 1. Verify extension file
    const extPath = join(root, "dist", "extension.js");
    assert.ok(await pathExists(extPath), "dist/extension.js missing");
    const content = await readFile(extPath, "utf8");
    assert.ok(
      !content.includes("pi_natives"),
      "dist/extension.js must not contain pi_natives",
    );

    // 2. Link plugin in fresh OMP profile
    console.log("Linking plugin in isolated profile:", testProfile);
    const linkRes = await runOmp(["plugin", "link", root], {
      env: { OMP_PROFILE: testProfile },
    });
    assert.equal(linkRes.code, 0, `Plugin link failed: ${linkRes.stderr}`);

    // 3. Check plugin list
    const listRes = await runOmp(["plugin", "list", "--json"], {
      env: { OMP_PROFILE: testProfile },
    });
    assert.equal(listRes.code, 0, `Plugin list failed: ${listRes.stderr}`);
    const listData = JSON.parse(listRes.stdout);
    const hasPlugin = (listData.npm || []).some(
      (p: any) => p.name === "omp-skill-kit" && p.enabled === true,
    );
    assert.ok(
      hasPlugin,
      "Plugin omp-skill-kit missing or disabled in plugin list",
    );

    // 4. Check plugin doctor
    const docRes = await runOmp(["plugin", "doctor", "--json"], {
      env: { OMP_PROFILE: testProfile },
    });
    assert.equal(docRes.code, 0, `Plugin doctor failed: ${docRes.stderr}`);
    const docData = JSON.parse(docRes.stdout);
    const pluginCheck = (docData || []).find(
      (c: any) => c.name === "plugin:omp-skill-kit",
    );
    assert.ok(pluginCheck, "Missing plugin:omp-skill-kit check in doctor");
    assert.equal(
      pluginCheck.status,
      "ok",
      `Doctor status is not ok: ${pluginCheck.message}`,
    );

    console.log("Loader E2E verification PASSED successfully!");
  } finally {
    // Cleanup profile
    const profDir = join(
      process.env.USERPROFILE || process.env.HOME || "",
      ".omp",
      "profiles",
      testProfile,
    );
    if (await pathExists(profDir)) {
      try {
        await rm(profDir, { recursive: true, force: true });
      } catch {}
    }
    if (await pathExists(tempDir)) {
      try {
        await rm(tempDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

main().catch((err) => {
  console.error("Loader E2E FAILED:", err);
  process.exit(1);
});
