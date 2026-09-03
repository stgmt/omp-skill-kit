import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isProcessAlive } from "../../src/install-lock.js";
import { pathExists } from "../../src/shared/fsx.js";
import { run } from "../../src/shared/spawn.js";
import { runOmp } from "./support/omp-process.js";
import { startOpenAIStub } from "./support/openai-stub.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

async function main() {
  console.log("==================================================");
  console.log("Starting Autonomous Installer Lifecycle E2E Test");
  console.log("==================================================");

  const runId = `lifecycle-${Date.now()}`;
  const testProfile = `omp-skill-kit-${runId}`;
  const tempHome = join(root, ".tmp", `lifecycle-home-${runId}`);
  const tempWorkspace = join(root, ".tmp", `lifecycle-ws-${runId}`);

  await mkdir(tempHome, { recursive: true });
  await mkdir(tempWorkspace, { recursive: true });

  const pkg = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ) as {
    version: string;
  };
  const version = pkg.version;

  // 1. Build and verify release archive
  console.log("1. Packaging release archive...");
  const packRes = await run(["node", "scripts/package-release.mjs"], {
    cwd: root,
  });
  assert.equal(packRes.code, 0, `package-release failed: ${packRes.stderr}`);

  const archivePath = join(root, `omp-skill-kit-${version}.tar.gz`);
  assert.ok(await pathExists(archivePath), `Archive missing: ${archivePath}`);

  // 2. Unpack archive to candidate root
  console.log("2. Unpacking release candidate...");
  const unpackDir = join(tempWorkspace, "candidate");
  await mkdir(unpackDir, { recursive: true });
  const tarRes = await run(
    [
      "tar",
      "-xzf",
      relative(root, archivePath),
      "-C",
      relative(root, unpackDir).replaceAll("\\", "/"),
    ],
    { cwd: root },
  );
  assert.equal(tarRes.code, 0, `tar extraction failed: ${tarRes.stderr}`);
  const pluginDir = join(unpackDir, `omp-skill-kit-${version}`);

  // 3. Start loopback OpenAI stub model server
  console.log("3. Starting loopback model server...");
  const stub = await startOpenAIStub(0);
  console.log("   Stub running at:", stub.url);

  let spawnedInstallerPid = 0;

  try {
    // 4. Configure isolated profile and models.yml
    console.log("4. Configuring isolated profile:", testProfile);
    const profileBase = join(
      process.env.USERPROFILE || process.env.HOME || "",
      ".omp",
      "profiles",
      testProfile,
    );
    const agentDir = join(profileBase, "agent");
    await mkdir(agentDir, { recursive: true });

    const modelsYml = `providers:
  omp-skill-kit-e2e:
    baseUrl: ${stub.url}
    auth: none
    api: openai-completions
    models:
      - id: test-model
        name: E2E Test Model
        input: [text]
        supportsTools: true
        contextWindow: 128000
        maxTokens: 4096
`;
    await writeFile(join(agentDir, "models.yml"), modelsYml, "utf8");

    // 5. Link unpacked candidate plugin into profile
    console.log("5. Linking candidate plugin into profile...");
    const linkRes = await runOmp(["plugin", "link", pluginDir], {
      env: { OMP_PROFILE: testProfile },
    });
    assert.equal(linkRes.code, 0, `Plugin link failed: ${linkRes.stderr}`);

    // Verify plugin doctor
    const docRes = await runOmp(["plugin", "doctor", "--json"], {
      env: { OMP_PROFILE: testProfile },
    });
    assert.equal(docRes.code, 0);

    // 6. Run a single real omp turn (-p) with empty OMP_SKILL_KIT_HOME and NO slash-commands
    console.log("6. Executing real OMP turn without any setup commands...");
    const ompTurnPromise = runOmp(
      [
        "-p",
        "--model",
        "omp-skill-kit-e2e/test-model",
        "--auto-approve",
        "Say hello to verify autonomous bootstrap",
      ],
      {
        cwd: tempWorkspace,
        env: {
          OMP_PROFILE: testProfile,
          OMP_SKILL_KIT_HOME: tempHome,
          CI: "true",
        },
        timeoutMs: 45000,
      },
    );

    // 7. Poll and wait for autonomous background installation to start
    console.log("7. Waiting for autonomous installer process and lock...");
    const lockOwnerFile = join(tempHome, "install.lock", "owner.json");
    const stateFile = join(tempHome, "state.json");
    const extensionLogFile = join(tempHome, "logs", "extension.log");
    const installerLogFile = join(tempHome, "logs", "installer.log");

    const deadline = Date.now() + 30000;
    let lockFound = false;
    let extensionLogFound = false;
    let installerLogFound = false;

    while (Date.now() < deadline) {
      if (!lockFound && (await pathExists(lockOwnerFile))) {
        try {
          const owner = JSON.parse(await readFile(lockOwnerFile, "utf8")) as {
            pid: number;
          };
          if (owner.pid > 0 && isProcessAlive(owner.pid)) {
            spawnedInstallerPid = owner.pid;
            lockFound = true;
            console.log(
              `   Found live install.lock owner PID: ${spawnedInstallerPid}`,
            );
          }
        } catch {}
      }

      if (!extensionLogFound && (await pathExists(extensionLogFile))) {
        try {
          const logContent = await readFile(extensionLogFile, "utf8");
          if (logContent.includes("installer.ensure.started")) {
            extensionLogFound = true;
            console.log(
              "   Found installer.ensure.started event in extension.log",
            );
          }
        } catch {}
      }

      if (!installerLogFound && (await pathExists(installerLogFile))) {
        try {
          const logContent = await readFile(installerLogFile, "utf8");
          if (
            logContent.includes("step 1/9") ||
            logContent.includes("step 2/9")
          ) {
            installerLogFound = true;
            console.log("   Found step progress in installer.log");
          }
        } catch {}
      }

      if (lockFound && extensionLogFound && installerLogFound) {
        break;
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    const ompTurnResult = await ompTurnPromise;
    console.log("   OMP turn exit code:", ompTurnResult.code);
    if (ompTurnResult.code !== 0) {
      console.log("   OMP stderr:", ompTurnResult.stderr);
    }

    assert.ok(
      lockFound,
      "Live install.lock owner was not created autonomously",
    );
    assert.ok(
      extensionLogFound,
      "extension.log does not contain installer.ensure.started",
    );
    assert.ok(
      installerLogFound,
      "installer.log does not contain step progress",
    );

    // Verify state.json was written
    assert.ok(await pathExists(stateFile), "state.json was not created");
    const state = JSON.parse(await readFile(stateFile, "utf8")) as {
      phase: string;
      install?: { step: string };
    };
    assert.ok(
      state.phase === "downloading" || state.phase === "installing-python",
      `Unexpected state.phase: ${state.phase}`,
    );

    console.log("   Autonomous background installer successfully verified!");
  } finally {
    // 8. Safely terminate the background installer process group so it doesn't run indefinitely
    if (spawnedInstallerPid > 0 && isProcessAlive(spawnedInstallerPid)) {
      console.log(
        `Terminating background installer process tree (PID ${spawnedInstallerPid})...`,
      );
      try {
        if (process.platform === "win32") {
          await run([
            "taskkill",
            "/F",
            "/T",
            "/PID",
            String(spawnedInstallerPid),
          ]);
        } else {
          process.kill(spawnedInstallerPid, "SIGKILL");
        }
      } catch {}
    }

    await stub.stop();

    // Clean up isolated profile and temp directories
    const profileBase = join(
      process.env.USERPROFILE || process.env.HOME || "",
      ".omp",
      "profiles",
      testProfile,
    );
    if (await pathExists(profileBase)) {
      try {
        await rm(profileBase, { recursive: true, force: true });
      } catch {}
    }
    if (await pathExists(tempHome)) {
      try {
        await rm(tempHome, { recursive: true, force: true });
      } catch {}
    }
    if (await pathExists(tempWorkspace)) {
      try {
        await rm(tempWorkspace, { recursive: true, force: true });
      } catch {}
    }
  }

  console.log("==================================================");
  console.log("Autonomous Installer Lifecycle E2E PASSED!");
  console.log("==================================================");
}

main().catch((err) => {
  console.error("Lifecycle E2E FAILED:", err);
  process.exit(1);
});
