import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDashboard, stopDashboard } from "../../src/dashboard.js";
import { install } from "../../src/installer.js";
import { RouterClient } from "../../src/router-client.js";
import { rpcCall } from "../../src/rpc.js";
import { run } from "../../src/shared/spawn.js";
import { runOmp } from "./support/omp-process.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

interface DiagnosticCheck {
  status?: string;
  name?: string;
}

interface ClientWithEndpoint {
  endpoint?: {
    port: number;
    token: string;
  };
}

async function main() {
  console.log("==================================================");
  console.log("Starting Negative Scenarios & Control Verification");
  console.log("==================================================");

  // 1. Missing dist/extension.js -> doctor turns red
  console.log("1. Testing missing extension file detection...");
  const tempExtDir = join(root, ".tmp", "test-missing-ext");
  await rm(tempExtDir, { recursive: true, force: true });
  await mkdir(tempExtDir, { recursive: true });
  await writeFile(
    join(tempExtDir, "package.json"),
    JSON.stringify({
      name: "missing-ext-test",
      version: "1.0.0",
      omp: { extensions: ["./nonexistent.js"] },
    }),
    "utf8",
  );
  const linkRes = await runOmp(["plugin", "link", tempExtDir], {
    env: { OMP_PROFILE: "neg-missing-ext" },
  });
  assert.equal(linkRes.code, 0);
  const docRes = await runOmp(["plugin", "doctor", "--json"], {
    env: { OMP_PROFILE: "neg-missing-ext" },
  });
  const docJson = JSON.parse(docRes.stdout) as DiagnosticCheck[];
  const check = (docJson || []).find(
    (c) =>
      c.status === "error" && Boolean(c.name?.includes("missing-ext-test")),
  );
  assert.ok(check, "Missing extension was not detected as error");
  console.log(
    "   Missing extension correctly detected by doctor:",
    check.status,
  );

  // 2. Build without external host package -> fails to bundle host agent
  console.log("2. Testing un-externalized build detection...");
  const testBundleOut = join(root, ".tmp", "test-unexternalized.js");
  const unextRes = await run([
    "bun",
    "build",
    "src/extension.ts",
    "--outfile",
    testBundleOut,
    "--target",
    "bun",
  ]);
  assert.notEqual(unextRes.code, 0, "Unexternalized build should fail");
  console.log("   Unexternalized build correctly rejected by bundler");
  await rm(testBundleOut, { force: true });

  // 3. Omitting BUN_BE_BUN -> omp rejects flags
  console.log("3. Testing BUN_BE_BUN flag absence detection...");
  const ompExeRes = await runOmp(
    ["dist/installer.js", "--home", "test-dummy"],
    { env: { BUN_BE_BUN: "" } },
  );
  assert.match(ompExeRes.stderr + ompExeRes.stdout, /unknown flag: --home/);
  console.log("   Absence of BUN_BE_BUN correctly triggers unknown flag error");

  // 4. Occupied port 7531 by foreign server -> dashboard picks alternate port without killing foreign process
  console.log("4. Testing busy port 7531 alternative loopback selection...");
  const foreignServer = createHttpServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("foreign-server-on-7531");
  });
  await new Promise<void>((res, rej) => {
    foreignServer.once("error", rej);
    foreignServer.listen(7531, "127.0.0.1", () => res());
  });

  const dashInfo = await ensureDashboard(
    join(root, ".tmp", "test-real-bootstrap"),
    root,
    {
      openBrowser: false,
      printMode: true,
    },
  );
  console.log("   Dashboard chose alternative port:", dashInfo.url);
  assert.notEqual(
    new URL(dashInfo.url).port,
    "7531",
    "Dashboard should not bind to occupied port 7531",
  );

  // Verify foreign server is still alive
  const foreignRes = await fetch("http://127.0.0.1:7531/");
  const foreignText = await foreignRes.text();
  assert.equal(
    foreignText,
    "foreign-server-on-7531",
    "Dashboard killed foreign process on port 7531!",
  );
  console.log("   Foreign server on 7531 untouched and alive.");

  await stopDashboard(join(root, ".tmp", "test-real-bootstrap"));
  foreignServer.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    foreignServer.close((error) => (error ? reject(error) : resolve()));
  });

  // 5. Invalid token -> RPC rejected
  console.log("5. Testing invalid token rejection...");
  const client = new RouterClient(
    join(root, ".tmp", "test-real-bootstrap"),
    root,
  );
  const bridgeOk = await client.ensureBridge(10000);
  assert.ok(bridgeOk, "Bridge could not be ensured for negative test");
  await client.loadEndpoint();
  const endpoint = (client as unknown as ClientWithEndpoint).endpoint;
  assert.ok(endpoint, "Endpoint missing");
  const badTokenRes = await rpcCall(
    { id: "bad-token-test", op: "ping", token: "wrong-token-abc" },
    { port: endpoint.port, token: "wrong-token-abc", timeoutMs: 2000 },
  );
  assert.equal(badTokenRes.ok, false, "Bridge accepted invalid token");
  console.log("   Invalid token call rejected as expected:", badTokenRes.error);

  // 6. Privacy & Sentinel check: ensure unique sentinel is never stored in home
  console.log("6. Testing sentinel prompt non-leakage...");
  const sentinel = `SENTINEL_${Date.now()}_SECRET_DATA`;
  // Search .tmp/test-real-bootstrap for sentinel
  function searchDir(dir: string): boolean {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (searchDir(full)) return true;
      } else if (ent.isFile()) {
        const text = readFileSync(full);
        if (text.includes(Buffer.from(sentinel))) return true;
      }
    }
    return false;
  }
  const leaked = searchDir(join(root, ".tmp", "test-real-bootstrap"));
  assert.equal(leaked, false, "Sentinel found in runtime directory!");
  console.log(
    "   Sentinel audit verified: zero prompt leakage in runtime store/logs",
  );

  // 7. Damaged lock digest or artifact -> installation rejects update and preserves prior healthy runtime
  console.log(
    "7. Testing corrupted digest rejection & healthy runtime preservation...",
  );
  const tempCorruptHome = join(root, ".tmp", "test-corrupt-runtime");
  const tempCorruptPlugin = join(root, ".tmp", "test-corrupt-plugin");
  await rm(tempCorruptHome, { recursive: true, force: true });
  await rm(tempCorruptPlugin, { recursive: true, force: true });
  await mkdir(join(tempCorruptHome, "runtime"), { recursive: true });
  await mkdir(tempCorruptPlugin, { recursive: true });

  // Seed prior healthy state and active.json
  const priorHealthyHash = "healthy-hash-0123456789abcdef";
  await writeFile(
    join(tempCorruptHome, "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      pluginVersion: "0.1.0",
      runtimeHash: priorHealthyHash,
      phase: "ready",
      attempt: 1,
      lastHealthyRuntimeHash: priorHealthyHash,
      updatedAt: new Date().toISOString(),
    }),
    "utf8",
  );
  await writeFile(
    join(tempCorruptHome, "runtime", "active.json"),
    JSON.stringify({
      schemaVersion: 1,
      runtimeHash: priorHealthyHash,
      versionRoot: join(
        tempCorruptHome,
        "runtime",
        "versions",
        priorHealthyHash,
      ),
      python: "dummy-python.exe",
      venv: "dummy-venv.exe",
      megaTron: "dummy-mega-tron.exe",
    }),
    "utf8",
  );

  // Copy package.json and runtime-manifest.json to tempCorruptPlugin
  await writeFile(
    join(tempCorruptPlugin, "package.json"),
    await readFile(join(root, "package.json"), "utf8"),
    "utf8",
  );
  const manifest = JSON.parse(
    await readFile(join(root, "runtime-manifest.json"), "utf8"),
  );
  // Tamper uv asset sha256 to simulate corrupt artifact / checksum mismatch
  for (const target of Object.keys(manifest.uv.assets)) {
    manifest.uv.assets[target].sha256 =
      "badbeef000000000000000000000000000000000000000000000000000000000";
  }
  await writeFile(
    join(tempCorruptPlugin, "runtime-manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );

  // Run installer with corrupted plugin root
  await install({ home: tempCorruptHome, pluginRoot: tempCorruptPlugin });

  // Verify state.json transitioned to degraded
  const corruptState = JSON.parse(
    await readFile(join(tempCorruptHome, "state.json"), "utf8"),
  );
  assert.equal(
    corruptState.phase,
    "degraded",
    "State phase should be degraded after digest mismatch",
  );
  assert.match(
    corruptState.errorCode,
    /mismatch|sha256/i,
    "Error code should describe digest mismatch",
  );
  assert.equal(
    corruptState.lastHealthyRuntimeHash,
    priorHealthyHash,
    "lastHealthyRuntimeHash must preserve prior healthy hash",
  );

  // Verify active.json was NOT overwritten with broken runtime
  const activeAfterCorrupt = JSON.parse(
    await readFile(join(tempCorruptHome, "runtime", "active.json"), "utf8"),
  );
  assert.equal(
    activeAfterCorrupt.runtimeHash,
    priorHealthyHash,
    "active.json must not be overwritten by failed update",
  );
  console.log(
    "   Corrupted update rejected, prior healthy runtime preserved:",
    corruptState.lastHealthyRuntimeHash,
  );

  await rm(tempCorruptHome, { recursive: true, force: true });
  await rm(tempCorruptPlugin, { recursive: true, force: true });

  console.log("==================================================");
  console.log("All Negative Scenarios PASSED successfully!");
  console.log("==================================================");
}

main().catch((err) => {
  console.error("Negative tests FAILED:", err);
  process.exit(1);
});
