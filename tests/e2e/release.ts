import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { pathExists } from "../../src/shared/fsx.js";
import { run } from "../../src/shared/spawn.js";
import { runOmp } from "./support/omp-process.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

async function main() {
  console.log("Starting release packaging and verification E2E...");
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const version = pkg.version;
  const runId = `release-${Date.now()}`;
  const testProfile = `omp-skill-kit-e2e-${runId}`;
  const tempDir = join(root, ".tmp", runId);
  await mkdir(tempDir, { recursive: true });

  try {
    // 1. Package release
    console.log("1. Packaging release from staging allowlist...");
    const packRes = await run(["node", "scripts/package-release.mjs"], {
      cwd: root,
    });
    assert.equal(
      packRes.code,
      0,
      `package-release.mjs failed: ${packRes.stderr}`,
    );

    // 2. Verify release
    console.log("2. Verifying release archive structure and integrity...");
    const verifyRes = await run(["node", "scripts/verify-release.mjs"], {
      cwd: root,
    });
    assert.equal(
      verifyRes.code,
      0,
      `verify-release.mjs failed: ${verifyRes.stderr}`,
    );

    // 3. Extract release archive
    const archivePath = join(root, `omp-skill-kit-${version}.tar.gz`);
    const extractedDir = join(tempDir, "extracted");
    await mkdir(extractedDir, { recursive: true });
    const tarRes = await run(
      [
        "tar",
        "-xzf",
        relative(root, archivePath),
        "-C",
        relative(root, extractedDir).replaceAll("\\", "/"),
      ],
      { cwd: root },
    );
    assert.equal(tarRes.code, 0, "tar extraction failed");
    const pluginPath = join(extractedDir, `omp-skill-kit-${version}`);

    // 4. Install/link in isolated OMP profile
    console.log(
      "3. Linking unpacked archive in isolated profile:",
      testProfile,
    );
    const linkRes = await runOmp(["plugin", "link", pluginPath], {
      env: { OMP_PROFILE: testProfile },
    });
    assert.equal(linkRes.code, 0, `omp plugin link failed: ${linkRes.stderr}`);

    // 5. Check plugin list
    const listRes = await runOmp(["plugin", "list", "--json"], {
      env: { OMP_PROFILE: testProfile },
    });
    assert.equal(listRes.code, 0, `omp plugin list failed: ${listRes.stderr}`);
    const listJson = JSON.parse(listRes.stdout);
    assert.ok(
      (listJson.npm || []).some(
        (p: any) => p.name === "omp-skill-kit" && p.enabled === true,
      ),
      "omp-skill-kit not listed as enabled",
    );

    // 6. Check plugin doctor
    const docRes = await runOmp(["plugin", "doctor", "--json"], {
      env: { OMP_PROFILE: testProfile },
    });
    assert.equal(docRes.code, 0, `omp plugin doctor failed: ${docRes.stderr}`);
    const docJson = JSON.parse(docRes.stdout);
    const check = (docJson || []).find(
      (c: any) => c.name === "plugin:omp-skill-kit",
    );
    assert.ok(check, "Missing plugin check in doctor");
    assert.equal(check.status, "ok", "Doctor status is not ok");

    // 7. Uninstall and verify removal
    console.log("4. Testing plugin uninstall...");
    const uninstRes = await runOmp(["plugin", "uninstall", "omp-skill-kit"], {
      env: { OMP_PROFILE: testProfile },
    });
    assert.equal(
      uninstRes.code,
      0,
      `omp plugin uninstall failed: ${uninstRes.stderr}`,
    );

    const listAfterRes = await runOmp(["plugin", "list", "--json"], {
      env: { OMP_PROFILE: testProfile },
    });
    const listAfterJson = JSON.parse(listAfterRes.stdout);
    assert.ok(
      !(listAfterJson.npm || []).some((p: any) => p.name === "omp-skill-kit"),
      "Plugin still present after uninstall",
    );

    // 8. Re-link and verify clean reinstall
    console.log("5. Testing plugin reinstall...");
    const relinkRes = await runOmp(["plugin", "link", pluginPath], {
      env: { OMP_PROFILE: testProfile },
    });
    assert.equal(
      relinkRes.code,
      0,
      `Plugin relink failed: ${relinkRes.stderr}`,
    );

    const docAfterRes = await runOmp(["plugin", "doctor", "--json"], {
      env: { OMP_PROFILE: testProfile },
    });
    const docAfterJson = JSON.parse(docAfterRes.stdout);
    const checkAfter = (docAfterJson || []).find(
      (c: any) => c.name === "plugin:omp-skill-kit",
    );
    assert.ok(
      checkAfter && checkAfter.status === "ok",
      "Doctor status after reinstall not ok",
    );

    console.log("Release E2E verification PASSED successfully!");
  } finally {
    // Cleanup
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
  console.error("Release E2E FAILED:", err);
  process.exit(1);
});
