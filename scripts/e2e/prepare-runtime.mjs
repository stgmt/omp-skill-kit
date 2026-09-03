import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function prepareRuntime(targetHome) {
  const home =
    targetHome ||
    process.env.OMP_SKILL_KIT_HOME ||
    join(root, ".tmp", "test-real-bootstrap");
  console.log("Checking mega-tron runtime at:", home);

  const activePath = join(home, "runtime", "active.json");
  const statePath = join(home, "state.json");

  let ready = false;
  if ((await pathExists(activePath)) && (await pathExists(statePath))) {
    try {
      const active = JSON.parse(await readFile(activePath, "utf8"));
      const state = JSON.parse(await readFile(statePath, "utf8"));
      if (
        state.phase === "ready" &&
        active.venv &&
        (await pathExists(active.venv))
      ) {
        ready = true;
      }
    } catch {}
  }

  if (!ready) {
    console.log(
      "Runtime not present or incomplete. Bootstrapping managed runtime via real installer...",
    );
    await mkdir(home, { recursive: true });
    const installerJs = join(root, "dist", "installer.js");
    assert.ok(
      await pathExists(installerJs),
      "dist/installer.js missing; run pnpm run build first",
    );

    const t0 = Date.now();
    const runner = "bun";
    const res = spawnSync(runner, [installerJs, "--home", home], {
      env: {
        ...process.env,
        BUN_BE_BUN: "1",
        OMP_SKILL_KIT_INSTALLER: "1",
        OMP_SKILL_KIT_HOME: home,
      },
      encoding: "utf8",
      timeout: 300000,
    });
    console.log(
      "Bootstrap finished in",
      Date.now() - t0,
      "ms with code:",
      res.status,
    );
    if (res.stdout?.trim()) console.log(res.stdout.trim());
    if (res.stderr?.trim()) console.error(res.stderr.trim());
    assert.equal(res.status, 0, `Installer bootstrap failed: ${res.stderr}`);

    const checkState = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(
      checkState.phase,
      "ready",
      "State phase not ready after bootstrap",
    );
  } else {
    console.log("Healthy managed runtime verified at:", home);
  }

  return home;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  prepareRuntime().catch((err) => {
    console.error("prepareRuntime failed:", err);
    process.exit(1);
  });
}
