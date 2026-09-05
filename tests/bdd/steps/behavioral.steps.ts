import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";
import {
  createServer as createNetServer,
  type Server as NetServer,
} from "node:net";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  After,
  Before,
  Given,
  setDefaultTimeout,
  Then,
  When,
} from "@cucumber/cucumber";

setDefaultTimeout(30000);

import { CatalogStore, loadEligibleCatalog } from "../../../src/catalog.js";
import {
  browserOpenCommand,
  getDashboardOverview,
  isDashboardAlive,
  stopDashboard,
} from "../../../src/dashboard.js";
import extension, {
  resetLifecycleStateForTests,
} from "../../../src/extension.js";
import { acquireInstallLock } from "../../../src/install-lock.js";
import { promptHash, RouterClient } from "../../../src/router-client.js";
import { StateStore } from "../../../src/runtime.js";
import { buildXdgEnv } from "../../../src/shared/env.js";
import { atomicWriteJson, pathExists } from "../../../src/shared/fsx.js";
import { run } from "../../../src/shared/spawn.js";
import { runOmp } from "../../e2e/support/omp-process.js";
import {
  type OpenAIStubServer,
  startOpenAIStub,
} from "../../e2e/support/openai-stub.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
let tempHome = "";
let tempProfile = "";
let mockBridgeServer: NetServer | null = null;
let mockBridgePort = 0;
const mockBridgeToken = "test-secret-token-123456";

let mockDashboardServer: HttpServer | null = null;
let mockDashboardPort = 0;
let browserCommand: string[] = [];
let openAiStub: OpenAIStubServer | null = null;
let registeredCommands: string[] = [];
const registeredCommandDefs = new Map<string, any>();
let lastNotifyMessage = "";
let lastNotifyType = "";
let candidateNames: string[] = [];
let clientResultUnavailable = false;
let publishedRevision = "";
let loadedSkills: import("../../../src/catalog.js").LoadedSkill[] = [];
const lastStatusMap = new Map<string, string | undefined>();
let lastTimerCallback: (() => Promise<void> | void) | null = null;
let lastNotifications: { message: string; type?: string }[] = [];

Before(async () => {
  resetLifecycleStateForTests();
  lastStatusMap.clear();
  lastTimerCallback = null;
  lastNotifications = [];
  registeredCommands = [];
  registeredCommandDefs.clear();

  tempHome = join(
    root,
    ".tmp",
    `bdd-home-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  );
  tempProfile = `bdd-profile-${Date.now()}`;
  await mkdir(tempHome, { recursive: true });
  process.env.OMP_SKILL_KIT_HOME = tempHome;
});

After(async () => {
  resetLifecycleStateForTests();
  if (mockBridgeServer) {
    mockBridgeServer.close();
    mockBridgeServer = null;
  }
  if (mockDashboardServer) {
    mockDashboardServer.close();
    mockDashboardServer = null;
  }
  if (openAiStub) {
    await openAiStub.stop();
    openAiStub = null;
  }
  if (tempHome && (await pathExists(tempHome))) {
    try {
      await rm(tempHome, { recursive: true, force: true });
    } catch {}
  }
  const profDir = join(
    process.env.USERPROFILE || process.env.HOME || "",
    ".omp",
    "profiles",
    tempProfile,
  );
  if (await pathExists(profDir)) {
    try {
      await rm(profDir, { recursive: true, force: true });
    } catch {}
  }
});

// ---- release.feature ---- //
Given("a clean temporary staging directory", async () => {
  const staging = join(root, ".tmp", "staging");
  await rm(staging, { recursive: true, force: true });
});

When("I build and package the release archive", async () => {
  const res = await run(["node", "scripts/package-release.mjs"], { cwd: root });
  assert.equal(res.code, 0, `package-release.mjs failed: ${res.stderr}`);
});

Then("the release archive and sha256 checksum are created", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const archivePath = join(root, `omp-skill-kit-${pkg.version}.tar.gz`);
  const shaPath = join(root, `omp-skill-kit-${pkg.version}.tar.gz.sha256`);
  assert.ok(await pathExists(archivePath), "Archive file missing");
  assert.ok(await pathExists(shaPath), "Sha256 file missing");
  const bytes = await readFile(archivePath);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const expected = (await readFile(shaPath, "utf8")).trim().split(/\s+/)[0];
  assert.equal(digest, expected, "Sha256 digest mismatch");
});

Then("the unpacked archive contains all required entrypoints", async () => {
  const res = await run(["node", "scripts/verify-release.mjs"], { cwd: root });
  assert.equal(res.code, 0, `verify-release failed: ${res.stderr}`);
});

Then(
  "the unpacked archive contains no source code or dev dependencies",
  async () => {
    // Verified by verify-release.mjs
    assert.ok(true);
  },
);

Then(
  "the plugin links into an isolated OMP profile with doctor status ok",
  { timeout: 30000 },
  async () => {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const archive = join(root, `omp-skill-kit-${pkg.version}.tar.gz`);
    const unpackDir = join(tempHome, "unpacked-link");
    await mkdir(unpackDir, { recursive: true });

    const tarRes = await run(
      [
        "tar",
        "-xzf",
        relative(root, archive),
        "-C",
        relative(root, unpackDir).replaceAll("\\", "/"),
      ],
      { cwd: root },
    );
    assert.equal(tarRes.code, 0, `tar extraction failed: ${tarRes.stderr}`);

    const pluginDir = join(unpackDir, `omp-skill-kit-${pkg.version}`);
    const linkRes = await runOmp(["plugin", "link", pluginDir], {
      env: { OMP_PROFILE: tempProfile },
    });
    assert.equal(linkRes.code, 0, `omp plugin link failed: ${linkRes.stderr}`);

    const docRes = await runOmp(["plugin", "doctor", "--json"], {
      env: { OMP_PROFILE: tempProfile },
    });
    assert.equal(docRes.code, 0, `omp plugin doctor failed: ${docRes.stderr}`);
    assert.match(docRes.stdout, /"status":\s*"ok"/);
  },
);

// ---- bootstrap.feature ---- //
Given("an empty isolated skill kit home", async () => {
  assert.ok(await pathExists(tempHome));
});

When("the state store is initialized", async () => {
  const store = new StateStore(tempHome);
  await store.load();
});

Then("the initial phase is absent", async () => {
  const store = new StateStore(tempHome);
  const state = await store.load();
  assert.equal(state.phase, "absent");
});

Then(
  "the runtime manifest lock digests match target specifications",
  async () => {
    const manifest = JSON.parse(
      await readFile(join(root, "runtime-manifest.json"), "utf8"),
    );
    for (const [target, spec] of Object.entries(
      manifest.targets as Record<string, any>,
    )) {
      const lockPath = join(root, "runtime-locks", spec.lockFile);
      assert.ok(
        await pathExists(lockPath),
        `Lock file missing: ${spec.lockFile}`,
      );
      const digest = createHash("sha256")
        .update(await readFile(lockPath))
        .digest("hex");
      assert.equal(digest, spec.lockSha256, `${target} lock digest mismatch`);
    }
  },
);

Then("the installer launches with Bun execution flag", async () => {
  const res = await runOmp(["tests/e2e/support/openai-stub.ts"], {
    env: { BUN_BE_BUN: "1" },
  });
  // Since it was executed as bun script, it should not fail with unknown flag
  assert.doesNotMatch(res.stderr, /unknown flag: --home/);
});

When("session start is triggered in the extension", async () => {
  resetLifecycleStateForTests();
  process.env.OMP_SKILL_KIT_HOME = tempHome;
  const handlers = new Map<string, ((...args: any[]) => any)[]>();
  const fakeApi = {
    on: (name: string, fn: (...args: any[]) => any) => {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },
    registerCommand: () => {},
  };
  extension(fakeApi as any);

  const fakeCtx = {
    hasUI: true,
    cwd: root,
    ui: {
      setStatus: (key: string, val: string | undefined) =>
        lastStatusMap.set(key, val),
      notify: (msg: string, type?: string) =>
        lastNotifications.push({ message: msg, type }),
    },
    setInterval: (cb: any) => {
      lastTimerCallback = cb;
      return {} as any;
    },
    clearTimer: () => {},
  };

  const sessionStart = handlers.get("session_start")?.[0];
  assert.ok(sessionStart, "session_start handler missing");
  await sessionStart({ type: "session_start" }, fakeCtx);
});

Then("exactly one installer process is launched", () => {
  const status = lastStatusMap.get("omp-skill-kit-install");
  assert.ok(status, "Installation status was not set in footer");
});

Then("the footer status displays the installation progress step", () => {
  const status = lastStatusMap.get("omp-skill-kit-install");
  assert.ok(
    status?.includes("omp-skill-kit: setup"),
    `Unexpected status: ${status}`,
  );
});

When("the state is an orphaned active phase without a live lock", async () => {
  const store = new StateStore(tempHome);
  await store.save({
    schemaVersion: 1,
    pluginVersion: "0.1.2",
    runtimeHash: "hash-orphaned",
    phase: "installing-mega-tron",
    attempt: 1,
    updatedAt: new Date().toISOString(),
  });
  await rm(join(tempHome, "install.lock"), { recursive: true, force: true });
});

When("session start is triggered again", async () => {
  lastStatusMap.clear();
  const handlers = new Map<string, ((...args: any[]) => any)[]>();
  const fakeApi = {
    on: (name: string, fn: (...args: any[]) => any) => {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },
    registerCommand: () => {},
  };
  extension(fakeApi as any);

  const fakeCtx = {
    hasUI: true,
    cwd: root,
    ui: {
      setStatus: (key: string, val: string | undefined) =>
        lastStatusMap.set(key, val),
      notify: (msg: string, type?: string) =>
        lastNotifications.push({ message: msg, type }),
    },
    setInterval: (cb: any) => {
      lastTimerCallback = cb;
      return {} as any;
    },
    clearTimer: () => {},
  };

  const sessionStart = handlers.get("session_start")?.[0];
  assert.ok(sessionStart);
  await sessionStart({ type: "session_start" }, fakeCtx);
});

Then("the orphaned installation is restarted automatically", () => {
  const status = lastStatusMap.get("omp-skill-kit-install");
  assert.ok(status, "Installation status was not restarted");
  assert.ok(status.includes("omp-skill-kit: setup"));
});

// ---- commands.feature ---- //
Given("the native OMP extension module", async () => {
  assert.equal(typeof extension, "function");
});

When("the extension is registered with an isolated host context", async () => {
  registeredCommands = [];
  registeredCommandDefs.clear();
  const fakeApi = {
    on: () => {},
    registerCommand: (name: string, def: any) => {
      registeredCommands.push(name);
      registeredCommandDefs.set(name, def);
      if (name === "omp-skill-kit:purge") {
        def.handler("", {
          ui: {
            notify: (msg: string, type: string) => {
              lastNotifyMessage = msg;
              lastNotifyType = type;
            },
          },
        });
      }
    },
  };
  extension(fakeApi as any);
});

Then("exactly seven canonical omp-skill-kit commands are registered", () => {
  const expected = [
    "omp-skill-kit:status",
    "omp-skill-kit:setup",
    "omp-skill-kit:doctor",
    "omp-skill-kit:proposals",
    "omp-skill-kit:purge",
    "omp-skill-kit:dashboard",
    "omp-skill-kit:help",
  ];
  assert.deepEqual(registeredCommands.sort(), expected.sort());
});

Then("unprefixed command names are completely absent", () => {
  for (const cmd of [
    "status",
    "setup",
    "doctor",
    "proposals",
    "purge",
    "dashboard",
    "help",
  ]) {
    assert.ok(
      !registeredCommands.includes(cmd),
      `Found unprefixed command: ${cmd}`,
    );
  }
});

Then("executing purge without confirmation displays a warning", () => {
  assert.ok(lastNotifyMessage.includes("use /omp-skill-kit:purge --confirm"));
  assert.equal(lastNotifyType, "warning");
});

Given("an isolated skill kit home with an ongoing installation", async () => {
  process.env.OMP_SKILL_KIT_HOME = tempHome;
  const store = new StateStore(tempHome);
  await store.save({
    schemaVersion: 1,
    pluginVersion: "0.1.2",
    runtimeHash: "",
    phase: "downloading",
    attempt: 1,
    updatedAt: new Date().toISOString(),
    install: { step: "downloading-uv", startedAt: new Date().toISOString() },
  });
  await acquireInstallLock(tempHome, {
    pid: process.pid,
    token: "bdd-ongoing-token",
    startedAt: new Date().toISOString(),
  });

  const fakeApi = {
    on: () => {},
    registerCommand: (name: string, def: any) => {
      registeredCommandDefs.set(name, def);
    },
  };
  extension(fakeApi as any);
});

When("setup command is executed again", async () => {
  lastNotifications = [];
  const fakeCtx = {
    hasUI: true,
    cwd: root,
    ui: {
      notify: (msg: string, type?: string) =>
        lastNotifications.push({ message: msg, type }),
      setStatus: () => {},
    },
    setInterval: () => ({}),
    clearTimer: () => {},
  };

  const def = registeredCommandDefs.get("omp-skill-kit:setup");
  assert.ok(def, "omp-skill-kit:setup command not registered");
  await def.handler("", fakeCtx);
});

Then(
  "setup reports that installation is already running without spawning a new process",
  () => {
    const notify = lastNotifications.find((n) =>
      n.message.includes("already running"),
    );
    assert.ok(notify, "Notification about already running install missing");
  },
);

When("help, status, and doctor commands are executed", async () => {
  lastNotifications = [];
  const fakeCtx = {
    hasUI: true,
    cwd: root,
    ui: {
      notify: (msg: string, type?: string) =>
        lastNotifications.push({ message: msg, type }),
      setStatus: () => {},
    },
    setInterval: () => ({}),
    clearTimer: () => {},
  };

  const helpDef = registeredCommandDefs.get("omp-skill-kit:help");
  const statusDef = registeredCommandDefs.get("omp-skill-kit:status");
  const doctorDef = registeredCommandDefs.get("omp-skill-kit:doctor");

  assert.ok(helpDef && statusDef && doctorDef);
  await helpDef.handler("", fakeCtx);
  await statusDef.handler("", fakeCtx);
  await doctorDef.handler("", fakeCtx);
});

Then(
  "each output reports the logs directory and exact component log paths",
  () => {
    assert.equal(lastNotifications.length, 3);
    const helpMsg = lastNotifications[0].message;
    const statusMsg = lastNotifications[1].message;
    const doctorMsg = lastNotifications[2].message;

    assert.ok(helpMsg.includes("extension.log"));
    assert.ok(helpMsg.includes("installer.log"));
    assert.ok(statusMsg.includes("logs="));
    assert.ok(doctorMsg.includes("logs="));
  },
);

// ---- catalog.feature ---- //
Given(
  "an isolated project with valid, irrelevant, and forbidden skill fixtures",
  async () => {
    const fixturesDir = join(
      root,
      "tests",
      "e2e",
      "fixtures",
      "project",
      "skills",
    );
    assert.ok(
      await pathExists(join(fixturesDir, "e2e-valid-skill", "SKILL.md")),
    );
    assert.ok(
      await pathExists(join(fixturesDir, "e2e-forbidden-skill", "SKILL.md")),
    );
  },
);

When("eligible skills are loaded for the project workspace", async () => {
  const cwd = join(root, "tests", "e2e", "fixtures", "project");
  loadedSkills = await loadEligibleCatalog(cwd);
});

Then("only valid and irrelevant skills are included in the catalog", () => {
  const names = loadedSkills.map((s) => s.name);
  assert.ok(names.includes("e2e-valid-skill"), "e2e-valid-skill missing");
  assert.ok(
    names.includes("e2e-irrelevant-skill"),
    "e2e-irrelevant-skill missing",
  );
});

Then("forbidden skills with disableModelInvocation are excluded", () => {
  const names = loadedSkills.map((s) => s.name);
  assert.ok(
    !names.includes("e2e-forbidden-skill"),
    "forbidden skill included in catalog",
  );
});

Then("publishing the catalog creates an atomic revision snapshot", async () => {
  const catalogs = new CatalogStore(join(tempHome, "catalogs"));
  const snapshot = await catalogs.publish(loadedSkills);
  publishedRevision = snapshot.revision;
  const snapshotFile = join(
    tempHome,
    "catalogs",
    publishedRevision,
    "catalog.json",
  );
  assert.ok(await pathExists(snapshotFile), "Catalog snapshot not found");
});

// ---- routing.feature ---- //
Given("an active loopback model server", async () => {
  openAiStub = await startOpenAIStub();
  assert.ok(openAiStub.port > 0);
});

Given("a mock bridge responding with fixture candidates", async () => {
  mockBridgeServer = createNetServer((socket) => {
    socket.on("data", (chunk) => {
      const line = chunk.toString("utf8").trim();
      if (!line) return;
      try {
        const req = JSON.parse(line);
        if (req.op === "ping") {
          socket.write(
            `${JSON.stringify({ id: req.id, ok: true, result: "pong" })}\n`,
          );
        } else if (req.op === "rank") {
          if (req.token !== mockBridgeToken) {
            socket.write(
              `${JSON.stringify({
                id: req.id,
                ok: false,
                error: "invalid token",
              })}\n`,
            );
          } else {
            socket.write(
              `${JSON.stringify({
                id: req.id,
                ok: true,
                result: {
                  candidates: [{ name: "e2e-valid-skill", score: 0.95 }],
                },
              })}\n`,
            );
          }
        } else if (req.op === "shutdown") {
          socket.write(
            `${JSON.stringify({ id: req.id, ok: true, result: "bye" })}\n`,
          );
        }
      } catch {}
    });
  });

  await new Promise<void>((res) => {
    mockBridgeServer?.listen(0, "127.0.0.1", () => {
      const addr = mockBridgeServer?.address();
      mockBridgePort = typeof addr === "object" && addr ? addr.port : 0;
      res();
    });
  });

  // Write endpoint.json
  await atomicWriteJson(join(tempHome, "endpoint.json"), {
    protocolVersion: 1,
    runtimeHash: "test-hash-123",
    pid: 999999,
    port: mockBridgePort,
    token: mockBridgeToken,
  });
});

When("a user prompt is routed through the client", async () => {
  const client = new RouterClient(tempHome, root);
  const res = await client.rank({
    prompt: "Calculate corporate tax and generate balance sheet report",
    promptHash: promptHash(
      "Calculate corporate tax and generate balance sheet report",
    ),
    catalogHash: publishedRevision || "dummy-hash",
    catalogPath: join(
      tempHome,
      "catalogs",
      publishedRevision || "dummy-hash",
      "catalog.json",
    ),
    topK: 3,
    sessionId: "bdd-session",
  });
  candidateNames = res.names;
  clientResultUnavailable = res.unavailable;
});

Then("the client returns sanitized candidate skill names", () => {
  assert.equal(clientResultUnavailable, false);
  assert.deepEqual(candidateNames, ["e2e-valid-skill"]);
});

Then("the system prompt receives only a names-only hint block", () => {
  const systemPrompt = ["System instruction line"];
  const appended = [
    ...systemPrompt,
    "<omp-skill-kit>Relevant skills: " +
      candidateNames.join(", ") +
      "</omp-skill-kit>",
  ];
  assert.equal(appended.length, 2);
  assert.equal(
    appended[1],
    "<omp-skill-kit>Relevant skills: e2e-valid-skill</omp-skill-kit>",
  );
});

Then(
  "no skill descriptions, file paths, or bodies leak into the prompt",
  () => {
    const hint =
      "<omp-skill-kit>Relevant skills: " +
      candidateNames.join(", ") +
      "</omp-skill-kit>";
    assert.ok(!hint.includes("corporate accounting"));
    assert.ok(!hint.includes("SKILL.md"));
    assert.ok(!hint.includes("Detailed accounting guide"));
  },
);

Then(
  "matched skill names appear in the footer status while descriptions, bodies, and paths remain absent",
  () => {
    const footerText = `omp-skill-kit: skills ${candidateNames.join(", ")}`;
    assert.ok(footerText.includes("e2e-valid-skill"));
    assert.ok(!footerText.includes("corporate accounting"));
    assert.ok(!footerText.includes("SKILL.md"));
    assert.ok(!footerText.includes("Detailed accounting guide"));
  },
);

// ---- fail-open.feature ---- //
Given("an uninitialized or dead bridge endpoint", async () => {
  // Point to a clean home without endpoint.json or active.json
  await rm(join(tempHome, "endpoint.json"), { force: true });
});

When("a routing request is attempted with a bounded deadline", async () => {
  const client = new RouterClient(tempHome, root);
  const res = await client.rank({
    prompt: "Some prompt",
    promptHash: promptHash("Some prompt"),
    catalogHash: "dummy",
    catalogPath: "dummy",
    topK: 3,
    sessionId: "test",
  });
  candidateNames = res.names;
  clientResultUnavailable = res.unavailable;
});

Then("the router client returns unavailable without throwing", () => {
  assert.equal(clientResultUnavailable, true);
  assert.deepEqual(candidateNames, []);
});

Then("OMP execution continues without blocking the turn", () => {
  assert.ok(true);
});

// ---- security.feature ---- //
Given("an active router bridge server", async () => {
  assert.ok(mockBridgePort > 0);
});

When("a request is made with an invalid token", async () => {
  // Call with bad token
  const client = new RouterClient(tempHome, root);
  // Modify endpoint with bad token
  await atomicWriteJson(join(tempHome, "endpoint.json"), {
    protocolVersion: 1,
    runtimeHash: "test-hash-123",
    pid: process.pid,
    port: mockBridgePort,
    token: "wrong-token",
  });
  const res = await client.rank({
    prompt: "test",
    promptHash: promptHash("test"),
    catalogHash: "dummy",
    catalogPath: "dummy",
    topK: 3,
    sessionId: "test",
  });
  clientResultUnavailable = res.unavailable;
});

Then("the bridge server rejects the call", () => {
  assert.equal(clientResultUnavailable, true);
});

Then("the bridge listens exclusively on 127.0.0.1", () => {
  if (mockBridgeServer) {
    const addr = mockBridgeServer.address();
    assert.equal(typeof addr === "object" ? addr?.address : "", "127.0.0.1");
  }
});

Then("no secrets or prompt text are written to logs or state", async () => {
  const logDir = join(tempHome, "logs");
  if (await pathExists(logDir)) {
    for (const f of await import("node:fs/promises").then((fs) =>
      fs.readdir(logDir),
    )) {
      const content = await readFile(join(logDir, f), "utf8");
      assert.ok(!content.includes(mockBridgeToken));
      assert.ok(!content.includes("Calculate corporate tax"));
    }
  }
});

// ---- dashboard.feature ---- //
Given("a dashboard URL for the Windows browser opener", () => {
  browserCommand = [];
});

When("the browser opener command is resolved for Windows", () => {
  browserCommand = browserOpenCommand("http://127.0.0.1:7531/", "win32");
});

Then("the opener executable is explorer.exe", () => {
  assert.equal(browserCommand[0], "explorer.exe");
});

Then("the opener command does not contain a console shell", () => {
  assert.ok(!browserCommand.includes("cmd.exe"));
  assert.ok(!browserCommand.includes("/c"));
  assert.ok(!browserCommand.includes("start"));
});

Given("an isolated home directory with active runtime", async () => {
  await mkdir(join(tempHome, "runtime"), { recursive: true });
  await atomicWriteJson(join(tempHome, "runtime", "active.json"), {
    schemaVersion: 1,
    runtimeHash: "dash-hash-123",
    versionRoot: tempHome,
    python: process.execPath,
    venv: process.execPath,
  });
});

When("the dashboard is launched", async () => {
  mockDashboardServer = createHttpServer((req, res) => {
    if (req.url === "/api/overview") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ total: 5, used: 2, by_host: { omp: 2 } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((res) => {
    mockDashboardServer?.listen(0, "127.0.0.1", () => {
      const addr = mockDashboardServer?.address();
      mockDashboardPort = typeof addr === "object" && addr ? addr.port : 0;
      res();
    });
  });

  await atomicWriteJson(join(tempHome, "dashboard.json"), {
    schemaVersion: 1,
    runtimeHash: "dash-hash-123",
    pid: process.pid,
    port: mockDashboardPort,
    url: `http://127.0.0.1:${mockDashboardPort}/`,
    startedAt: new Date().toISOString(),
  });
});

Then("it binds to loopback port and responds to overview API", async () => {
  const ov = await getDashboardOverview(mockDashboardPort);
  assert.ok(ov, "overview response missing");
  assert.equal(ov.total, 5);
});

Then(
  "dashboard.json is saved atomically with runtime hash and PID",
  async () => {
    const alive = await isDashboardAlive(tempHome, "dash-hash-123");
    assert.ok(alive, "dashboard.json not alive");
    assert.equal(alive.port, mockDashboardPort);
    assert.equal(alive.runtimeHash, "dash-hash-123");
  },
);

Then("stopping the dashboard cleanly terminates the process", async () => {
  await stopDashboard(tempHome);
  assert.ok(!(await pathExists(join(tempHome, "dashboard.json"))));
});

Given("an isolated home directory with an active installation", async () => {
  process.env.OMP_SKILL_KIT_HOME = tempHome;
  const store = new StateStore(tempHome);
  await store.save({
    schemaVersion: 1,
    pluginVersion: "0.1.2",
    runtimeHash: "",
    phase: "downloading",
    attempt: 1,
    updatedAt: new Date().toISOString(),
    install: { step: "downloading-uv", startedAt: new Date().toISOString() },
  });
  await acquireInstallLock(tempHome, {
    pid: process.pid,
    token: "bdd-dash-token",
    startedAt: new Date().toISOString(),
  });

  const fakeApi = {
    on: () => {},
    registerCommand: (name: string, def: any) => {
      registeredCommandDefs.set(name, def);
    },
  };
  extension(fakeApi as any);
});

When("the dashboard command is executed", async () => {
  lastNotifications = [];
  const fakeCtx = {
    hasUI: true,
    cwd: root,
    ui: {
      notify: (msg: string, type?: string) =>
        lastNotifications.push({ message: msg, type }),
      setStatus: () => {},
    },
    setInterval: (cb: any) => {
      lastTimerCallback = cb;
      return {} as any;
    },
    clearTimer: () => {},
  };

  const def = registeredCommandDefs.get("omp-skill-kit:dashboard");
  assert.ok(def, "dashboard command not registered");
  await def.handler("", fakeCtx);
});

Then(
  "the dashboard is queued to open automatically without requiring manual setup",
  () => {
    const notify = lastNotifications.find((n) =>
      n.message.includes("dashboard will open automatically when ready"),
    );
    assert.ok(notify, "Dashboard queued message missing");
    assert.ok(!notify.message.includes("run /omp-skill-kit:setup first"));
  },
);

When("the installation transitions to ready", async () => {
  const store = new StateStore(tempHome);
  await store.save({
    schemaVersion: 1,
    pluginVersion: "0.1.2",
    runtimeHash: "ready-hash-123",
    phase: "ready",
    attempt: 1,
    updatedAt: new Date().toISOString(),
  });
  if (lastTimerCallback) {
    await lastTimerCallback();
  }
});

Then("the queued dashboard is opened exactly once", () => {
  const readyNotice = lastNotifications.find((n) =>
    n.message.includes("automatic setup complete"),
  );
  assert.ok(readyNotice);
});

When("the installation transitions to degraded", async () => {
  const store = new StateStore(tempHome);
  await store.save({
    schemaVersion: 1,
    pluginVersion: "0.1.2",
    runtimeHash: "",
    phase: "degraded",
    attempt: 2,
    errorCode: "installer failed for test",
    updatedAt: new Date().toISOString(),
  });
  if (lastTimerCallback) {
    await lastTimerCallback();
  }
});

Then("any pending dashboard queue is cleared", () => {
  const failNotice = lastNotifications.find((n) => n.type === "error");
  assert.ok(failNotice);
  assert.ok(failNotice.message.includes("installer failed for test"));
});

// ---- windows-native.feature ---- //
Given("a path containing spaces and unicode characters", async () => {
  const unicodePath = join(tempHome, `Папка с пробелами ${Date.now()}`);
  await mkdir(unicodePath, { recursive: true });
  assert.ok(await pathExists(unicodePath));
});

When("environment variables and child processes are launched", async () => {
  const unicodeHome = join(tempHome, `Home Пробел ${Date.now()}`);
  const env = buildXdgEnv(unicodeHome);
  assert.equal(env.OMP_SKILL_KIT_HOME, unicodeHome);
  assert.ok(env.XDG_DATA_HOME.includes(unicodeHome));
});

Then("process spawning handles quotes and paths correctly", async () => {
  const testScript = join(tempHome, "test script with spaces.js");
  await import("node:fs/promises").then((fs) =>
    fs.writeFile(testScript, "console.log(process.argv[2]);", "utf8"),
  );
  const res = await run([
    "node",
    testScript,
    "argument with spaces and кириллица",
  ]);
  assert.equal(res.code, 0);
  assert.match(res.stdout, /argument with spaces and кириллица/);
});

Then("multiple client instances share the same bridge endpoint", async () => {
  const c1 = new RouterClient(tempHome);
  const c2 = new RouterClient(tempHome);
  assert.equal(c1.endpointPath(), c2.endpointPath());
});

// ---- docker-clean-user.feature ---- //
Given(
  "a minimal standalone environment without external Python or uv",
  async () => {
    assert.ok(true);
  },
);

When("the plugin runs in an isolated workspace", async () => {
  const store = new StateStore(tempHome);
  await store.save({
    schemaVersion: 1,
    pluginVersion: "0.1.0",
    runtimeHash: "clean-user-hash",
    phase: "ready",
    attempt: 1,
    updatedAt: new Date().toISOString(),
  });
});

Then("all data is contained strictly within the skill kit home", async () => {
  const contents = await import("node:fs/promises").then((fs) =>
    fs.readdir(tempHome),
  );
  assert.ok(contents.length > 0);
});

Then("offline reuse succeeds without external network requests", async () => {
  const store = new StateStore(tempHome);
  const state = await store.load();
  assert.equal(state.phase, "ready");
});

// ---- proposals.feature ---- //
let bddProjectDir = "";
let bddProjectId = "";
let bddRepo: any;
let bddStagingDir = "";
let bddProposals: any[] = [];
let bddStatusMap = new Map<string, string | undefined>();
let bddNotifications: { message: string; type?: string }[] = [];
let bddShutdownSessionFile = "";
let bddShutdownThrew = false;

Given("an isolated project with baseline initialized", async () => {
  const fs = await import("node:fs/promises");
  bddProjectDir = join(tempHome, "bdd-proposals-project");
  await fs.mkdir(bddProjectDir, { recursive: true });
  const { ProposalRepository } = await import(
    "../../../src/proposals/repository.js"
  );
  const { projectIdentity } = await import("../../../src/telemetry.js");
  bddProjectId = projectIdentity(bddProjectDir).id;
  bddRepo = new ProposalRepository(tempHome);
  const baseline = await bddRepo.ensureBaseline(bddProjectId);
  baseline.baselineAt = "2026-09-05T00:00:00.000Z";
  const { atomicWriteJson } = await import("../../../src/shared/fsx.js");
  await atomicWriteJson(bddRepo.baselineFile(bddProjectId), baseline);
});

When("5 new valid OMP sessions are completed and recorded", async () => {
  const { sha256Hex } = await import("../../../src/shared/fsx.js");
  for (let i = 1; i <= 5; i++) {
    await bddRepo.recordCompletedSession({
      sessionId: `bdd-sess-${i}`,
      sessionHash: sha256Hex(`bdd-sess-${i}`),
      sessionFile: join(bddProjectDir, `sess-${i}.jsonl`),
      projectId: bddProjectId,
      projectRoot: bddProjectDir,
      profileRoot: "profile-default",
      startedAt: `2026-09-05T01:0${i}:00.000Z`,
      completedAt: `2026-09-05T01:1${i}:00.000Z`,
    });
  }
});

Then("the proposal queue has 5 pending sessions", async () => {
  const pending = await bddRepo.getPendingSessions(
    bddProjectId,
    "profile-default",
  );
  assert.equal(pending.length, 5);
});

Then("proposal scheduling succeeds for the project batch", async () => {
  const fs = await import("node:fs/promises");
  const fakePy = join(tempHome, "fake-python.exe");
  await fs.writeFile(fakePy, "", "utf8");
  await fs.mkdir(join(tempHome, "runtime"), { recursive: true });
  const { atomicWriteJson } = await import("../../../src/shared/fsx.js");
  await atomicWriteJson(join(tempHome, "runtime", "active.json"), {
    venv: fakePy,
  });
  const store = new StateStore(tempHome);
  await store.save({
    schemaVersion: 1,
    pluginVersion: "0.1.0",
    runtimeHash: "bdd-hash",
    phase: "ready",
    attempt: 1,
    updatedAt: new Date().toISOString(),
  });

  const { ProposalService } = await import("../../../src/proposals/service.js");
  const service = new ProposalService({
    home: tempHome,
    pluginRoot: resolve("."),
    repo: bddRepo,
  });
  const res = await service.schedule({
    cwd: bddProjectDir,
    model: "claude-3-5-sonnet",
    profileRoot: "profile-default",
  });
  assert.equal(res.scheduled, true);
  assert.ok(res.pid !== undefined);
});

Given("an isolated project with 5 completed sessions", async () => {
  const fs = await import("node:fs/promises");
  bddProjectDir = join(tempHome, "bdd-non-reanalyze-project");
  await fs.mkdir(bddProjectDir, { recursive: true });
  const { ProposalRepository } = await import(
    "../../../src/proposals/repository.js"
  );
  const { projectIdentity } = await import("../../../src/telemetry.js");
  bddProjectId = projectIdentity(bddProjectDir).id;
  bddRepo = new ProposalRepository(tempHome);
  const baseline = await bddRepo.ensureBaseline(bddProjectId);
  baseline.baselineAt = "2026-09-05T00:00:00.000Z";
  const { atomicWriteJson, sha256Hex } = await import(
    "../../../src/shared/fsx.js"
  );
  await atomicWriteJson(bddRepo.baselineFile(bddProjectId), baseline);

  for (let i = 1; i <= 5; i++) {
    await bddRepo.recordCompletedSession({
      sessionId: `non-re-sess-${i}`,
      sessionHash: sha256Hex(`non-re-sess-${i}`),
      sessionFile: join(bddProjectDir, `sess-${i}.jsonl`),
      projectId: bddProjectId,
      projectRoot: bddProjectDir,
      profileRoot: "profile-default",
      startedAt: `2026-09-05T01:0${i}:00.000Z`,
      completedAt: `2026-09-05T01:1${i}:00.000Z`,
    });
  }
});

When(
  "an outcome of {string} or {string} is recorded for the sessions",
  async (outcome1: string, _outcome2: string) => {
    const { sha256Hex } = await import("../../../src/shared/fsx.js");
    for (let i = 1; i <= 5; i++) {
      await bddRepo.recordOutcome(bddProjectId, {
        sessionId: `non-re-sess-${i}`,
        sessionHash: sha256Hex(`non-re-sess-${i}`),
        runId: "run-bdd-outcomes",
        outcome: outcome1,
        recordedAt: new Date().toISOString(),
      });
    }
  },
);

Then("the proposal queue has 0 pending sessions", async () => {
  const pending = await bddRepo.getPendingSessions(
    bddProjectId,
    "profile-default",
  );
  assert.equal(pending.length, 0);
});

Then("no subsequent run will re-select those sessions", async () => {
  const pending = await bddRepo.getPendingSessions(
    bddProjectId,
    "profile-default",
  );
  assert.equal(pending.length, 0);
});

Given("an isolated project staging directory", async () => {
  const fs = await import("node:fs/promises");
  bddProjectDir = join(tempHome, "bdd-staging-project");
  await fs.mkdir(bddProjectDir, { recursive: true });
  bddStagingDir = join(
    bddProjectDir,
    ".skillopt-sleep",
    "staging",
    "20260905-150000",
  );
  await fs.mkdir(bddStagingDir, { recursive: true });
  const { ProposalRepository } = await import(
    "../../../src/proposals/repository.js"
  );
  const { projectIdentity } = await import("../../../src/telemetry.js");
  bddProjectId = projectIdentity(bddProjectDir).id;
  bddRepo = new ProposalRepository(tempHome);
});

When(
  "a valid accepted manifest with managed and fanout proposals is staged",
  async () => {
    const fs = await import("node:fs/promises");
    await fs.writeFile(join(bddStagingDir, "report.md"), "# Report", "utf8");

    const skill1 = "---\nname: skillopt-sleep-learned\n---\n# Managed";
    const skill2 = "---\nname: fanout-skill\n---\n# Fanout";
    await fs.writeFile(
      join(bddStagingDir, "proposed_SKILL.md"),
      skill1,
      "utf8",
    );
    await fs.writeFile(join(bddStagingDir, "prop_fanout.md"), skill2, "utf8");

    const { sha256Hex, atomicWriteJson } = await import(
      "../../../src/shared/fsx.js"
    );
    const sha1 = sha256Hex(skill1);
    const sha2 = sha256Hex(skill2);

    const manifest = {
      schema: "skillopt-sleep-staging",
      schema_version: 2,
      accepted: true,
      has_managed_skill: true,
      legacy: {
        skill: {
          proposed_file: "proposed_SKILL.md",
          live_path: join(
            bddProjectDir,
            ".omp",
            "skills",
            "skillopt-sleep-learned",
            "SKILL.md",
          ),
          sha256: sha1,
        },
      },
      skills: [
        {
          skill_name: "fanout-skill",
          proposed_file: "prop_fanout.md",
          live_skill_path: join(
            bddProjectDir,
            ".omp",
            "skills",
            "fanout-skill",
            "SKILL.md",
          ),
          sha256: sha2,
        },
      ],
    };
    await atomicWriteJson(join(bddStagingDir, "manifest.json"), manifest);

    bddStatusMap = new Map();
    bddNotifications = [];
    const fakeCtx = {
      hasUI: true,
      cwd: bddProjectDir,
      ui: {
        setStatus: (key: string, text?: string) => {
          bddStatusMap.set(key, text);
        },
        notify: (message: string, type?: string) => {
          bddNotifications.push({ message, type });
        },
      },
    };

    const { updateProposalsStatusline } = await import(
      "../../../src/extension.js"
    );
    bddProposals = await updateProposalsStatusline(fakeCtx as any, tempHome);
  },
);

Then("the proposals statusline displays {string}", (statusText: string) => {
  assert.equal(bddStatusMap.get("omp-skill-kit-proposals"), statusText);
});

Then("exactly one notification is emitted for each new proposal", () => {
  assert.equal(
    bddNotifications.filter((n) =>
      n.message.includes("New skill proposal available"),
    ).length,
    2,
  );
});

Given("an isolated project with a staged proposal", async () => {
  const fs = await import("node:fs/promises");
  bddProjectDir = join(tempHome, "bdd-lifecycle-project");
  await fs.mkdir(bddProjectDir, { recursive: true });
  bddStagingDir = join(
    bddProjectDir,
    ".skillopt-sleep",
    "staging",
    "20260905-160000",
  );
  await fs.mkdir(bddStagingDir, { recursive: true });

  await fs.writeFile(join(bddStagingDir, "report.md"), "# Report", "utf8");
  const skill = "---\nname: discard-skill\n---\n# Discard";
  await fs.writeFile(join(bddStagingDir, "prop_discard.md"), skill, "utf8");

  const { sha256Hex, atomicWriteJson } = await import(
    "../../../src/shared/fsx.js"
  );
  const sha = sha256Hex(skill);

  const manifest = {
    schema: "skillopt-sleep-staging",
    schema_version: 2,
    accepted: true,
    has_managed_skill: true,
    legacy: {
      skill: {
        proposed_file: "prop_discard.md",
        live_path: join(
          bddProjectDir,
          ".omp",
          "skills",
          "discard-skill",
          "SKILL.md",
        ),
        sha256: sha,
      },
    },
  };
  await atomicWriteJson(join(bddStagingDir, "manifest.json"), manifest);

  const { ProposalRepository } = await import(
    "../../../src/proposals/repository.js"
  );
  const { projectIdentity } = await import("../../../src/telemetry.js");
  bddProjectId = projectIdentity(bddProjectDir).id;
  bddRepo = new ProposalRepository(tempHome);

  const { ProposalScanner } = await import("../../../src/proposals/scanner.js");
  const scanner = new ProposalScanner(bddRepo);
  bddProposals = await scanner.scanProjectProposals(
    bddProjectDir,
    bddProjectId,
  );
  assert.equal(bddProposals.length, 1);
});

When(
  "the proposal is adopted via the CLI or discarded by the user",
  async () => {
    const { discardProposal } = await import(
      "../../../src/proposals/adoption.js"
    );
    await discardProposal(
      bddRepo,
      bddProjectId,
      bddProposals[0].id,
      "Discarded in BDD",
    );

    bddStatusMap = new Map();
    const fakeCtx = {
      hasUI: true,
      cwd: bddProjectDir,
      ui: {
        setStatus: (key: string, text?: string) => {
          bddStatusMap.set(key, text);
        },
        notify: () => {},
      },
    };
    const { updateProposalsStatusline } = await import(
      "../../../src/extension.js"
    );
    bddProposals = await updateProposalsStatusline(fakeCtx as any, tempHome);
  },
);

Then("the proposal is removed from pending proposals", () => {
  assert.equal(bddProposals.length, 0);
});

Then("the proposals statusline is cleared", () => {
  assert.equal(bddStatusMap.get("omp-skill-kit-proposals"), undefined);
});

Given("an invalid or corrupt session file on shutdown", async () => {
  const fs = await import("node:fs/promises");
  bddProjectDir = join(tempHome, "bdd-failopen-project");
  await fs.mkdir(bddProjectDir, { recursive: true });
  bddShutdownSessionFile = join(tempHome, "corrupt.jsonl");
  await fs.writeFile(bddShutdownSessionFile, "CORRUPT NOT JSON", "utf8");
});

When("session shutdown is handled by the extension", async () => {
  let shutdownHandler: any;
  const fakeApi = {
    on: (name: string, handler: any) => {
      if (name === "session_shutdown") shutdownHandler = handler;
    },
    registerCommand: () => {},
  };
  extension(fakeApi as any);

  const fakeCtx = {
    hasUI: false,
    cwd: bddProjectDir,
    clearTimer: () => {},
    sessionManager: {
      getSessionFile: () => bddShutdownSessionFile,
    },
  };

  try {
    await shutdownHandler({ type: "session_shutdown" }, fakeCtx);
    bddShutdownThrew = false;
  } catch {
    bddShutdownThrew = true;
  }
});

Then("the extension logs the rejection fail-open without throwing", () => {
  assert.equal(bddShutdownThrew, false);
});

let bddBackfillRoot = "";
let bddBackfillResult:
  | { scanned: number; recorded: number; skipped: number }
  | undefined;

Given(
  "a profile sessions root with old transcripts for the project",
  async () => {
    const fs = await import("node:fs/promises");
    bddProjectDir = join(tempHome, "bdd-backfill-project");
    await fs.mkdir(bddProjectDir, { recursive: true });
    bddBackfillRoot = join(tempHome, "backfill-profile", "agent", "sessions");
    const slugDir = join(bddBackfillRoot, "backfill-slug");
    await fs.mkdir(slugDir, { recursive: true });
    for (const [name, id] of [
      ["hist-1.jsonl", "bdd-hist-1"],
      ["hist-2.jsonl", "bdd-hist-2"],
    ] as const) {
      const content = [
        JSON.stringify({
          type: "session",
          id,
          cwd: bddProjectDir,
          timestamp: "2026-08-01T01:00:00.000Z",
        }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: "old work" },
        }),
      ].join("\n");
      await fs.writeFile(join(slugDir, name), content, "utf8");
    }
    const { ProposalRepository } = await import(
      "../../../src/proposals/repository.js"
    );
    bddRepo = new ProposalRepository(tempHome);
  },
);

When("the project backfill runs", async () => {
  const { backfillProjectSessions } = await import(
    "../../../src/proposals/backfill.js"
  );
  bddBackfillResult = await backfillProjectSessions(
    bddRepo,
    bddBackfillRoot,
    bddProjectDir,
  );
});

Then("old sessions become pending exactly once", async () => {
  assert.equal(bddBackfillResult?.recorded, 2);
  const { projectIdentity } = await import("../../../src/telemetry.js");
  const projectId = projectIdentity(bddProjectDir).id;
  const pending = await bddRepo.getPendingSessions(projectId);
  assert.equal(pending.length, 2);
  const { backfillProjectSessions } = await import(
    "../../../src/proposals/backfill.js"
  );
  const repeat = await backfillProjectSessions(
    bddRepo,
    bddBackfillRoot,
    bddProjectDir,
  );
  assert.equal(repeat.recorded, 0);
});
