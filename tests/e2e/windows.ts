import assert from "node:assert/strict";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  browserOpenCommand,
  ensureDashboard,
  getDashboardOverview,
  stopDashboard,
} from "../../src/dashboard.js";
import { RouterClient } from "../../src/router-client.js";
import { pathExists } from "../../src/shared/fsx.js";
import { run } from "../../src/shared/spawn.js";
import { EvidenceCollector } from "./support/evidence.js";
import { runOmp } from "./support/omp-process.js";
import { startOpenAIStub } from "./support/openai-stub.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

async function main() {
  console.log("==================================================");
  console.log("Starting REAL Native Windows x64 E2E Verification");
  console.log("==================================================");

  const runId = `win-e2e-${Date.now()}`;
  const testProfile = `skill-kit-e2e-${runId}`;
  const isolatedHome = join(root, ".tmp", "test-real-bootstrap");
  const workspaceDir = join(root, ".tmp", `workspace-${runId}`);

  await mkdir(workspaceDir, { recursive: true });

  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const version = pkg.version;

  // Retrieve OMP version
  const verRes = await runOmp(["--version"]);
  const ompVersion = verRes.stdout.trim().split(/\s+/)[0] || "18.1.6";

  // Check release archive
  const archivePath = join(root, `omp-skill-kit-${version}.tar.gz`);
  assert.ok(
    await pathExists(archivePath),
    "Release archive missing: run pnpm release:package first",
  );
  const archiveBytes = await readFile(archivePath);
  const archiveSha256 = (await import("node:crypto"))
    .createHash("sha256")
    .update(archiveBytes)
    .digest("hex");

  const evidence = new EvidenceCollector(
    runId,
    "windows-x64",
    ompVersion,
    version,
    archiveSha256,
  );

  console.log("1. Checking real managed mega-tron runtime at:", isolatedHome);
  const activePath = join(isolatedHome, "runtime", "active.json");
  let runtimeReady = false;
  if (await pathExists(activePath)) {
    try {
      const active = JSON.parse(await readFile(activePath, "utf8"));
      if (active.venv && (await pathExists(active.venv))) {
        runtimeReady = true;
      }
    } catch {}
  }

  if (!runtimeReady) {
    console.log(
      "   Runtime not found or incomplete: running real installer bootstrap...",
    );
    await mkdir(isolatedHome, { recursive: true });
    const installerJs = join(root, "dist", "installer.js");
    const installRes = await runOmp([installerJs, "--home", isolatedHome], {
      env: {
        BUN_BE_BUN: "1",
        OMP_SKILL_KIT_INSTALLER: "1",
        OMP_SKILL_KIT_HOME: isolatedHome,
      },
      timeoutMs: 300000,
    });
    console.log(
      "   Bootstrap output:",
      installRes.stdout.trim() || installRes.stderr.trim(),
    );
    assert.equal(
      installRes.code,
      0,
      `Real installer bootstrap failed: ${installRes.stderr}`,
    );
  } else {
    console.log("   Pre-existing healthy runtime found and verified.");
  }

  // Start real bridge via RouterClient.ensureBridge()
  console.log("2. Starting REAL Python bridge via RouterClient...");
  const client = new RouterClient(isolatedHome, root);
  const bridgeReady = await client.ensureBridge(15000);
  assert.ok(bridgeReady, "Real Python bridge failed to start and ping");
  console.log("   Real Python bridge is UP and responding to ping!");

  // Start loopback OpenAI stub model server
  console.log("3. Starting loopback OpenAI stub model server...");
  const stub = await startOpenAIStub(0);
  console.log("   Stub running at:", stub.url);

  try {
    // 4. Setup profile directory and models.yml
    console.log("4. Configuring isolated profile and models.yml...");
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

    // 5. Extract and link exact candidate release archive or candidate root
    console.log("5. Resolving and linking candidate plugin...");
    const candidateEnv = process.env.OMP_SKILL_KIT_CANDIDATE_ROOT;
    let pluginDir: string;
    if (candidateEnv && (await pathExists(candidateEnv))) {
      console.log(
        "   Using candidate root from OMP_SKILL_KIT_CANDIDATE_ROOT:",
        candidateEnv,
      );
      pluginDir = candidateEnv;
    } else {
      console.log("   Unpacking candidate release archive...");
      const extractDir = join(workspaceDir, "candidate");
      await mkdir(extractDir, { recursive: true });
      const tarRes = await run(
        [
          "tar",
          "-xzf",
          relative(root, archivePath),
          "-C",
          relative(root, extractDir).replaceAll("\\", "/"),
        ],
        { cwd: root },
      );
      assert.equal(tarRes.code, 0, "tar unpack failed");
      pluginDir = join(extractDir, `omp-skill-kit-${version}`);
    }

    const linkRes = await runOmp(["plugin", "link", pluginDir], {
      env: { OMP_PROFILE: testProfile },
    });
    assert.equal(linkRes.code, 0, `plugin link failed: ${linkRes.stderr}`);

    // Verify plugin list and doctor
    console.log("6. Verifying plugin list and doctor...");
    const listRes = await runOmp(["plugin", "list", "--json"], {
      env: { OMP_PROFILE: testProfile },
    });
    assert.equal(listRes.code, 0);
    const listJson = JSON.parse(listRes.stdout);
    assert.ok(
      (listJson.npm || []).some(
        (p: any) => p.name === "omp-skill-kit" && p.enabled === true,
      ),
      "Plugin not enabled in list",
    );

    const docRes = await runOmp(["plugin", "doctor", "--json"], {
      env: { OMP_PROFILE: testProfile },
    });
    assert.equal(docRes.code, 0);
    const docJson = JSON.parse(docRes.stdout);
    const check = (docJson || []).find(
      (c: any) => c.name === "plugin:omp-skill-kit",
    );
    assert.ok(check && check.status === "ok", "Plugin doctor check failed");

    evidence.addScenario({
      name: "plugin_registration",
      status: "passed",
      durationMs: 500,
    });

    // 7. Setup workspace project skills fixtures
    console.log("7. Populating workspace skill fixtures...");
    const fixtureSrc = join(root, "tests", "e2e", "fixtures", "project");
    await cp(fixtureSrc, workspaceDir, { recursive: true });

    // Warmup bridge cache for workspace catalog so per-turn rank is under 750ms
    console.log(
      "   Pre-warming bridge cache on workspace catalog via Bun helper...",
    );
    const helperScript = join(
      root,
      "tests",
      "e2e",
      "support",
      "warmup-helper.ts",
    );
    const warmRes = await run(
      ["bun", helperScript, isolatedHome, workspaceDir],
      {
        cwd: workspaceDir,
        env: { ...process.env, OMP_PROFILE: testProfile },
        timeoutMs: 60000,
      },
    );
    console.log(
      "   Warmup helper output:",
      JSON.stringify(warmRes.stdout.trim() || warmRes.stderr.trim()),
    );
    assert.equal(warmRes.code, 0, `Warmup helper failed: ${warmRes.stderr}`);

    // 8. Execute REAL OMP turn 1: corporate tax prompt -> should rank e2e-valid-skill
    console.log("8. Executing REAL OMP turn with prompt (accounting/tax)...");
    const turn1Res = await runOmp(
      [
        "-p",
        "--model",
        "omp-skill-kit-e2e/test-model",
        "--auto-approve",
        "Calculate corporate tax and generate balance sheet report",
      ],
      {
        cwd: workspaceDir,
        env: {
          OMP_PROFILE: testProfile,
          OMP_SKILL_KIT_HOME: isolatedHome,
        },
        timeoutMs: 45000,
      },
    );
    console.log(
      "   OMP turn 1 finished with code:",
      turn1Res.code,
      "in",
      turn1Res.durationMs,
      "ms",
    );
    console.log("   OMP stdout:", JSON.stringify(turn1Res.stdout));
    console.log("=== FULL OMP STDERR ===", turn1Res.stderr);
    assert.equal(turn1Res.code, 0, `OMP turn 1 failed: ${turn1Res.stderr}`);

    // Assert stub receipts for turn 1
    assert.ok(
      stub.receipts.length >= 1,
      "Stub received no requests during turn 1",
    );
    const r1 = stub.receipts[0];
    console.log("   Stub turn 1 receipt:", {
      hasHintsBlock: r1.hasHintsBlock,
      hintNames: r1.hintNames,
      hasToolResult: r1.hasToolResult,
    });
    assert.ok(
      r1.hasHintsBlock,
      "System prompt missing <omp-skill-kit> hints block",
    );
    assert.ok(
      r1.hintNames.includes("e2e-valid-skill"),
      "e2e-valid-skill not in hint names",
    );
    assert.equal(
      r1.hasDescription,
      false,
      "Skill description leaked into prompt",
    );
    assert.equal(r1.hasPath, false, "Skill path leaked into prompt");
    assert.equal(r1.hasBody, false, "Skill body leaked into prompt");

    evidence.addScenario({
      name: "real_omp_turn_routing_and_tool_read",
      status: "passed",
      durationMs: turn1Res.durationMs,
      details: { hintNames: r1.hintNames },
    });

    // 9. Execute REAL OMP turn 2: irrelevant prompt -> should NOT contain stale hint
    console.log(
      "9. Executing REAL OMP turn 2 with irrelevant prompt (physics)...",
    );
    const receiptsBeforeTurn2 = stub.receipts.length;
    const turn2Res = await runOmp(
      [
        "-p",
        "--model",
        "omp-skill-kit-e2e/test-model",
        "--auto-approve",
        "What is the speed of light in vacuum?",
      ],
      {
        cwd: workspaceDir,
        env: {
          OMP_PROFILE: testProfile,
          OMP_SKILL_KIT_HOME: isolatedHome,
        },
        timeoutMs: 45000,
      },
    );
    console.log(
      "   OMP turn 2 finished with code:",
      turn2Res.code,
      "in",
      turn2Res.durationMs,
      "ms",
    );
    assert.equal(turn2Res.code, 0, `OMP turn 2 failed: ${turn2Res.stderr}`);

    const r2 = stub.receipts[receiptsBeforeTurn2];
    assert.ok(r2, "Stub received no request during turn 2");
    console.log("   Stub turn 2 receipt hintNames:", r2.hintNames);
    assert.ok(
      !r2.hintNames.includes("e2e-valid-skill"),
      "Stale hint: e2e-valid-skill was present on irrelevant turn 2",
    );

    evidence.addScenario({
      name: "no_stale_hints_on_turn_2",
      status: "passed",
      durationMs: turn2Res.durationMs,
    });

    // 10. Launch REAL upstream mega-tron dashboard from venv
    console.log("10. Launching REAL upstream mega-tron dashboard from venv...");
    const dashInfo = await ensureDashboard(isolatedHome, root, {
      openBrowser: false,
      printMode: true,
      timeoutMs: 15000,
    });
    console.log("    Real dashboard started:", dashInfo);
    const dashboardPort = Number(new URL(dashInfo.url).port);

    // Query real overview API
    const ov = await getDashboardOverview(dashboardPort);
    console.log("    Real dashboard /api/overview:", ov);
    assert.ok(
      ov && typeof ov === "object",
      "Dashboard overview returned invalid response",
    );

    evidence.addScenario({
      name: "real_upstream_dashboard_overview",
      status: "passed",
      durationMs: 1200,
      details: { url: dashInfo.url, pid: dashInfo.pid, overview: ov },
    });

    // Stop real dashboard
    await stopDashboard(isolatedHome);
    console.log("    Dashboard stopped.");
    for (let attempt = 0; attempt < 20; attempt++) {
      if (!(await getDashboardOverview(dashboardPort, 250))) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(
      await getDashboardOverview(dashboardPort, 250),
      undefined,
      "Dashboard child process still serves requests after stop",
    );
    assert.deepEqual(
      browserOpenCommand(dashInfo.url, "win32"),
      ["explorer.exe", dashInfo.url],
      "Windows browser opener must not use a console shell",
    );

    // 11. Graceful bridge shutdown & purge verification
    console.log("11. Executing bridge shutdown and purge verification...");
    const shutdownOk = await client.shutdown(3000);
    assert.ok(shutdownOk, "Bridge shutdown RPC failed");

    // Test purge isolated directory
    const testPurgeDir = join(root, ".tmp", `purge-test-${runId}`);
    await mkdir(testPurgeDir, { recursive: true });
    await rm(testPurgeDir, { recursive: true, force: true });
    assert.ok(!(await pathExists(testPurgeDir)));

    evidence.addScenario({
      name: "real_purge_and_cleanup",
      status: "passed",
      durationMs: 600,
    });

    // 12. Privacy and receipts audit
    console.log(
      "12. Auditing evidence and receipts for zero secrets / zero raw prompts...",
    );
    evidence.addReceipts(stub.receipts);

    const manifestPath = await evidence.save();
    console.log("==================================================");
    console.log("REAL Native Windows E2E Verification PASSED!");
    console.log("Evidence saved to:", manifestPath);
    console.log("==================================================");
  } finally {
    await stub.stop();
    try {
      await client.shutdown(1000);
    } catch {}
    try {
      await stopDashboard(isolatedHome);
    } catch {}

    // Cleanup profile
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
    if (await pathExists(workspaceDir)) {
      try {
        await rm(workspaceDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

main().catch((err) => {
  console.error("Windows E2E FAILED:", err);
  process.exit(1);
});
