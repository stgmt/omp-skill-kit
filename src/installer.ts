/**
 * Detached background installer for the omp-skill-kit runtime.
 *
 * Runs as its own process (launched from extension.ts, never awaited).
 * Imports ONLY the manifest (single source of pins), verifies every artifact
 * digest, builds an isolated runtime under ~/.omp/skill-kit, and flips state
 * to "ready" only after bridge ping + warmup + first rank.
 *
 * Bundled separately (dist/installer.js) so the thin extension.js entry never
 * carries networking/install logic.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { type Dirent, openSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { argv } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractTarGzHardened, extractZipHardened } from "./archive.js";
import { acquireInstallLock, releaseInstallLock } from "./install-lock.js";
import { rpcCall } from "./rpc.js";
import {
  type InstallProgress,
  initialState,
  type Phase,
  type RuntimeState,
  StateStore,
} from "./runtime.js";
import { PROTOCOL_VERSION } from "./shared/constants.js";
import { downloadVerified } from "./shared/download.js";
import { buildXdgEnv } from "./shared/env.js";
import { atomicWriteJson, pathExists, sha256Hex } from "./shared/fsx.js";
import {
  loadManifest,
  type RuntimeManifest,
  targetSpec,
  uvAsset,
} from "./shared/manifest.js";
import { detectPlatform } from "./shared/platform.js";
import { resolveBackgroundPython, run } from "./shared/spawn.js";

const HOME_ENV = "OMP_SKILL_KIT_HOME";
const RUNTIME_VERSION = "v1"; // bump when layout/state contract changes

export async function ensureProposalsConfig(home: string): Promise<void> {
  const proposalsDir = join(home, "proposals");
  await mkdir(proposalsDir, { recursive: true });

  const userConfigPath = join(proposalsDir, "config.json");
  if (!(await pathExists(userConfigPath))) {
    const userConfig = {
      schemaVersion: 1,
      enabled: true,
      batchSize: 5,
      minimumIntervalHours: 24,
      model: "@smol",
      fallbackModels: ["current"],
      autoAdopt: false,
    };
    await atomicWriteJson(userConfigPath, userConfig);
  }

  const skilloptConfigPath = join(proposalsDir, "skillopt-config.json");
  if (!(await pathExists(skilloptConfigPath))) {
    const skilloptConfig = {
      transcript_source: "pi",
      projects: "invoked",
      backend: "pi",
      gate_mode: "on",
      gate_no_regression: true,
      evidence_log: true,
      redact_secrets: true,
      multi_skill_fanout: true,
      evolve_skill: true,
      evolve_memory: false,
      auto_adopt: false,
    };
    await atomicWriteJson(skilloptConfigPath, skilloptConfig);
  }
}

export function resolveHome(): string {
  const override = process.env[HOME_ENV];
  return override && override.length > 0
    ? override
    : join(homedir(), ".omp", "skill-kit");
}

function pluginRootDir(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function pluginVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(pluginRootDir(), "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function cryptoToken(): string {
  return randomBytes(32).toString("hex");
}

async function saveInstallProgress(
  store: StateStore,
  baseState: RuntimeState,
  phase: Phase,
  progress: InstallProgress,
): Promise<RuntimeState> {
  const next: RuntimeState = {
    ...baseState,
    schemaVersion: 1,
    phase,
    updatedAt: new Date().toISOString(),
    install: progress,
  };
  await store.save(next);
  return next;
}

export interface InstallerOptions {
  home: string;
  pluginRoot: string;
}

export async function install(opts: InstallerOptions): Promise<void> {
  const { home, pluginRoot } = opts;
  const host = detectPlatform();
  const store = new StateStore(home);
  const version = pluginVersion();

  let state = await store.load();
  if (state.pluginVersion === "0.0.0" || state.schemaVersion !== 1) {
    state = { ...initialState(version) };
  }
  if (state.runtimeHash === "") {
    // A prior healthy install (if any) is kept until this one is verified.
    state = { ...state, pluginVersion: version, phase: "absent" };
  }

  const log = (msg: string) => console.log(`[skill-kit:installer] ${msg}`);

  if (!host.supported) {
    await store.save({
      schemaVersion: 1,
      pluginVersion: version,
      runtimeHash: state.lastHealthyRuntimeHash ?? "",
      phase: "degraded",
      attempt: state.attempt + 1,
      updatedAt: new Date().toISOString(),
      lastHealthyRuntimeHash: state.lastHealthyRuntimeHash,
      errorCode: host.unsupportedReason,
    });
    log(`unsupported platform: ${host.unsupportedReason}`);
    return;
  }

  await mkdir(home, { recursive: true });
  const lockToken = cryptoToken();
  const acquired = await acquireInstallLock(home, {
    pid: process.pid,
    token: lockToken,
    startedAt: new Date().toISOString(),
  });

  if (!acquired) {
    log("another installer is running; exiting");
    return;
  }

  try {
    await mkdir(join(home, "runtime"), { recursive: true });
    await mkdir(join(home, "downloads"), { recursive: true });
    await mkdir(join(home, "catalogs"), { recursive: true });
    await mkdir(join(home, "xdg", "config"), { recursive: true });
    await mkdir(join(home, "xdg", "data"), { recursive: true });
    await mkdir(join(home, "xdg", "cache"), { recursive: true });
    await mkdir(join(home, "models"), { recursive: true });
    await mkdir(join(home, "logs"), { recursive: true });

    const manifest = loadManifest(pluginRoot);
    const spec = targetSpec(manifest, host);
    const asset = uvAsset(manifest, spec);
    const lockPath = join(pluginRoot, "runtime-locks", spec.lockFile);
    const runtimeHash = computeRuntimeHash(pluginRoot, manifest);
    const versionRoot = join(home, "runtime", "versions", runtimeHash);
    await rm(versionRoot, { recursive: true, force: true });
    await mkdir(versionRoot, { recursive: true });
    const isWindows = spec.lockFile.startsWith("win");
    const isLinux = spec.lockFile.startsWith("linux");
    const xdgEnv = buildXdgEnv(home);

    // ---- 1/9. preparing --------------------------------------------------------
    let stepStartedAt = new Date().toISOString();
    log("step 1/9: preparing environment");
    state = await saveInstallProgress(store, state, "downloading", {
      step: "preparing",
      startedAt: stepStartedAt,
    });

    // ---- 2/9. downloading-uv ---------------------------------------------------
    stepStartedAt = new Date().toISOString();
    const uvArchive = join(
      home,
      "downloads",
      isWindows ? "uv.zip" : "uv.tar.gz",
    );
    log(
      `step 2/9: downloading uv ${manifest.uv.version} (${asset.sha256.slice(0, 12)}...)`,
    );
    state = await saveInstallProgress(store, state, "downloading", {
      step: "downloading-uv",
      startedAt: stepStartedAt,
    });
    await downloadVerified({
      url: asset.url,
      dest: uvArchive,
      sha256: asset.sha256,
      onProgress: async (p) => {
        log(
          `downloading uv: ${p.downloadedBytes}${p.totalBytes ? `/${p.totalBytes}` : ""} bytes`,
        );
        state = await saveInstallProgress(store, state, "downloading", {
          step: "downloading-uv",
          startedAt: stepStartedAt,
          downloadedBytes: p.downloadedBytes,
          totalBytes: p.totalBytes,
        });
      },
    });

    const uvTop = join(versionRoot, ".uv-top");
    await rm(uvTop, { recursive: true, force: true });
    await mkdir(uvTop, { recursive: true });
    if (isWindows) await extractZipHardened(uvArchive, uvTop);
    else await extractTarGzHardened(uvArchive, uvTop);
    const uvExe = await findExecutable(uvTop, isWindows ? "uv.exe" : "uv");
    if (!uvExe) throw new Error("uv executable missing after extraction");

    // ---- 3/9. installing-python ------------------------------------------------
    stepStartedAt = new Date().toISOString();
    log(
      `step 3/9: installing python ${manifest.python.version} via uv ${manifest.uv.version}`,
    );
    state = await saveInstallProgress(store, state, "installing-python", {
      step: "installing-python",
      startedAt: stepStartedAt,
    });
    const pythonInstall = join(versionRoot, "python");
    const pythonEnv = {
      UV_PYTHON_INSTALL_DIR: pythonInstall,
      UV_CACHE_DIR: join(home, "runtime", "uv-cache"),
    };
    const pyRes = await run(
      [
        uvExe,
        "python",
        "install",
        manifest.python.version,
        "--install-dir",
        pythonInstall,
      ],
      { env: pythonEnv, timeoutMs: 20 * 60 * 1000 },
    );
    if (pyRes.code !== 0)
      throw new Error(
        `uv python install failed: ${(pyRes.stderr || pyRes.stdout).slice(0, 800)}`,
      );
    const pyExe = await findExecutable(
      pythonInstall,
      isWindows ? "python.exe" : "python3",
    );
    if (!pyExe || !(await pathExists(pyExe)))
      throw new Error("python binary missing after uv install");
    const pyVersion = await run([pyExe, "--version"], { timeoutMs: 60_000 });
    if (
      pyVersion.code !== 0 ||
      !pyVersion.stdout.includes(manifest.python.version)
    )
      throw new Error(
        `managed Python version mismatch: ${(pyVersion.stdout || pyVersion.stderr).trim()}`,
      );

    // ---- 4/9. creating-venv ----------------------------------------------------
    stepStartedAt = new Date().toISOString();
    log("step 4/9: creating virtual environment");
    state = await saveInstallProgress(store, state, "installing-python", {
      step: "creating-venv",
      startedAt: stepStartedAt,
    });
    const venv = join(versionRoot, "venv");
    await rm(venv, { recursive: true, force: true });
    const venvRes = await run([pyExe, "-m", "venv", venv], {
      timeoutMs: 10 * 60 * 1000,
      env: xdgEnv,
    });
    if (venvRes.code !== 0)
      throw new Error(
        `venv create failed: ${(venvRes.stderr || venvRes.stdout).slice(0, 800)}`,
      );
    const venvPy = isWindows
      ? join(venv, "Scripts", "python.exe")
      : join(venv, "bin", "python");
    if (!(await pathExists(venvPy)))
      throw new Error(`venv python missing at ${venvPy}`);

    // ---- 5/9. downloading-mega-tron --------------------------------------------
    stepStartedAt = new Date().toISOString();
    log("step 5/9: downloading mega-tron source archive");
    state = await saveInstallProgress(store, state, "installing-mega-tron", {
      step: "downloading-mega-tron",
      startedAt: stepStartedAt,
    });
    const megaArchive = join(home, "downloads", "mega-tron.tar.gz");
    await downloadVerified({
      url: manifest.megaTron.archiveUrl,
      dest: megaArchive,
      sha256: manifest.megaTron.archiveSha256,
      onProgress: async (p) => {
        log(
          `downloading mega-tron: ${p.downloadedBytes}${p.totalBytes ? `/${p.totalBytes}` : ""} bytes`,
        );
        state = await saveInstallProgress(
          store,
          state,
          "installing-mega-tron",
          {
            step: "downloading-mega-tron",
            startedAt: stepStartedAt,
            downloadedBytes: p.downloadedBytes,
            totalBytes: p.totalBytes,
          },
        );
      },
    });

    const localLockPath = join(versionRoot, "runtime-lock.txt");
    const lockText = await readFile(lockPath, "utf8");
    const githubArchiveUrl = `https://github.com/mega-edo/mega-tron/archive/${manifest.megaTron.commit}.tar.gz`;
    const localArchiveUrl = pathToFileURL(megaArchive).href;
    const dependencyLock = lockText
      .replace(githubArchiveUrl, localArchiveUrl)
      .replace(manifest.megaTron.archiveUrl, localArchiveUrl)
      .replace(/^mega-tron @.*\n\s+--hash=.*\n(?:\s+# via.*\n)?/m, "");
    await writeFile(localLockPath, dependencyLock, "utf8");

    // ---- 6/9. installing-dependencies ------------------------------------------
    stepStartedAt = new Date().toISOString();
    log("step 6/9: installing locked dependencies via uv pip sync");
    state = await saveInstallProgress(store, state, "installing-mega-tron", {
      step: "installing-dependencies",
      startedAt: stepStartedAt,
    });
    const syncArgs = [
      uvExe,
      "pip",
      "sync",
      localLockPath,
      "--require-hashes",
      "--python",
      venvPy,
    ];
    if (isLinux)
      syncArgs.push("--find-links", "https://download.pytorch.org/whl/cpu");
    const syncRes = await run(syncArgs, {
      env: { ...xdgEnv, UV_CACHE_DIR: join(home, "runtime", "uv-cache") },
      timeoutMs: 45 * 60 * 1000,
    });
    if (syncRes.code !== 0)
      throw new Error(
        `pip sync failed: ${(syncRes.stderr || syncRes.stdout).slice(0, 1200)}`,
      );

    // ---- 7/9. installing-mega-tron ---------------------------------------------
    stepStartedAt = new Date().toISOString();
    log("step 7/9: installing mega-tron package into venv");
    state = await saveInstallProgress(store, state, "installing-mega-tron", {
      step: "installing-mega-tron",
      startedAt: stepStartedAt,
    });
    const sourceRoot = join(versionRoot, "mega-tron-source");
    await extractTarGzHardened(megaArchive, sourceRoot);
    const sourcePackage = await findDirectoryContaining(
      sourceRoot,
      join("src", "mega_tron"),
    );
    if (!sourcePackage)
      throw new Error("mega-tron source package missing from verified archive");
    const sitePackagesRes = await run(
      [venvPy, "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"],
      { timeoutMs: 60_000, env: xdgEnv },
    );
    const sitePackages = sitePackagesRes.stdout.trim();
    if (sitePackagesRes.code !== 0 || !sitePackages)
      throw new Error("venv site-packages path unavailable");
    await cp(
      join(sourcePackage, "src", "mega_tron"),
      join(sitePackages, "mega_tron"),
      { recursive: true },
    );

    // import/version verification must come from the venv itself
    const importRes = await run(
      [
        venvPy,
        "-c",
        "import mega_tron; import torch; print(mega_tron.__version__ if hasattr(mega_tron,'__version__') else '1.0.0')",
      ],
      {
        timeoutMs: 5 * 60 * 1000,
        env: xdgEnv,
      },
    );
    if (importRes.code !== 0)
      throw new Error(
        `mega_tron import failed: ${(importRes.stderr || importRes.stdout).slice(0, 800)}`,
      );
    const importSrc = await run(
      [venvPy, "-c", "import mega_tron; print(mega_tron.__file__)"],
      { timeoutMs: 60_000, env: xdgEnv },
    );
    if (
      importSrc.code !== 0 ||
      !importSrc.stdout.trim().toLowerCase().startsWith(venv.toLowerCase())
    ) {
      throw new Error(
        `mega_tron resolved outside venv: ${importSrc.stdout.trim()}`,
      );
    }
    log(`mega-tron ${importRes.stdout.trim()} installed into venv`);

    // Verify vendored skillopt_sleep imports cleanly with plugin PYTHONPATH
    const skillOptPyPath = join(pluginRoot, "python");
    const skillOptEnv = {
      ...xdgEnv,
      PYTHONPATH: skillOptPyPath,
    };
    const skillOptImportRes = await run(
      [venvPy, "-c", "import skillopt_sleep; print(skillopt_sleep.__file__)"],
      { timeoutMs: 60_000, env: skillOptEnv },
    );
    if (skillOptImportRes.code !== 0) {
      throw new Error(
        `skillopt_sleep import failed: ${(skillOptImportRes.stderr || skillOptImportRes.stdout).slice(0, 800)}`,
      );
    }
    log(`skillopt_sleep verified from ${skillOptImportRes.stdout.trim()}`);

    // Atomically create proposals configs if not present
    await ensureProposalsConfig(home);

    // ---- 8/9. warming-model ----------------------------------------------------
    stepStartedAt = new Date().toISOString();
    log("step 8/9: warming model embedder and initial rank");
    state = await saveInstallProgress(store, state, "warming", {
      step: "warming-model",
      startedAt: stepStartedAt,
    });
    const bridgeScript = join(pluginRoot, "python", "omp_skill_kit_bridge.py");
    const fixtureCatalog = join(pluginRoot, "skills");
    const fixtureHash = sha256Hex("bundled-fixture");
    const warmRes = await run(
      [
        venvPy,
        bridgeScript,
        "--home",
        home,
        "--warmup-only",
        "--catalog-path",
        fixtureCatalog,
        "--catalog-hash",
        fixtureHash,
      ],
      {
        timeoutMs: 25 * 60 * 1000,
        env: xdgEnv,
      },
    );
    if (warmRes.code !== 0)
      throw new Error(
        `warmup failed: ${(warmRes.stderr || warmRes.stdout).slice(0, 1200)}`,
      );

    // ---- 9/9. starting-bridge --------------------------------------------------
    stepStartedAt = new Date().toISOString();
    log("step 9/9: starting bridge process and pinging");
    state = await saveInstallProgress(store, state, "warming", {
      step: "starting-bridge",
      startedAt: stepStartedAt,
    });
    const token = cryptoToken();
    await rm(join(home, "endpoint.json"), { force: true });
    const pid = await spawnDetachedBridge(
      venvPy,
      bridgeScript,
      home,
      runtimeHash,
      token,
      xdgEnv,
    );
    const endpoint = await waitForEndpoint(home, 90_000);
    if (!endpoint) throw new Error("bridge endpoint not published within 90s");
    const ping = await rpcCall(
      { id: "installer-ping", op: "ping", token: endpoint.token },
      { port: endpoint.port, token: endpoint.token, timeoutMs: 5000 },
    );
    if (!(ping.ok && ping.result === "pong"))
      throw new Error("bridge ping failed");

    const megaTronExe = isWindows
      ? join(venv, "Scripts", "mega-tron.exe")
      : join(venv, "bin", "mega-tron");

    await atomicWriteJson(join(home, "runtime", "active.json"), {
      schemaVersion: 1,
      runtimeHash,
      versionRoot,
      python: pyExe,
      venv: venvPy,
      megaTron: megaTronExe,
    });

    const { install: _removed, ...cleanState } = state;
    await store.save({
      ...cleanState,
      schemaVersion: 1,
      pluginVersion: version,
      runtimeHash,
      phase: "ready",
      attempt: state.attempt + 1,
      pid,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastHealthyRuntimeHash: runtimeHash,
    });
    log("runtime ready");
  } catch (err) {
    const message =
      err instanceof Error ? err.stack || err.message : String(err);
    log(`install failed: ${message}`);
    const failed = await store.load();
    const { install: _removed, ...cleanFailed } = failed;
    await store.save({
      ...cleanFailed,
      schemaVersion: 1,
      pluginVersion: version,
      phase: "degraded",
      attempt: failed.attempt + 1,
      updatedAt: new Date().toISOString(),
      errorCode: message.slice(0, 500),
    });
  } finally {
    await releaseInstallLock(home, lockToken);
  }
}

function computeRuntimeHash(
  _pluginRoot: string,
  manifest: RuntimeManifest,
): string {
  // Deterministic hash over pin declaration only (no local paths, no stdout).
  const h = createHash("sha256");
  h.update(RUNTIME_VERSION);
  h.update(manifest.python.version);
  h.update(manifest.uv.version);
  h.update(manifest.megaTron.commit);
  for (const [target, spec] of Object.entries(manifest.targets)) {
    h.update(target);
    h.update(spec.lockSha256);
  }
  return h.digest("hex").slice(0, 24);
}

async function spawnDetachedBridge(
  python: string,
  script: string,
  home: string,
  runtimeHash: string,
  token: string,
  xdgEnv: Record<string, string>,
): Promise<number> {
  const out = openSync(join(home, "logs", "bridge.log"), "a");
  const backgroundPython = await resolveBackgroundPython(python);
  const child = spawn(
    backgroundPython,
    [script, "--home", home, "--runtime-hash", runtimeHash, "--token", token],
    {
      detached: true,
      stdio: ["ignore", out, out],
      windowsHide: true,
      env: { ...process.env, ...xdgEnv },
    },
  );
  child.unref();
  return child.pid ?? 0;
}

async function findDirectoryContaining(
  root: string,
  relativePath: string,
): Promise<string | undefined> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name);
    if (await pathExists(join(candidate, relativePath))) return candidate;
    const found = await findDirectoryContaining(candidate, relativePath);
    if (found) return found;
  }
  return undefined;
}

async function findExecutable(
  root: string,
  name: string,
): Promise<string | undefined> {
  const queue = [root];
  const wanted = name.toLowerCase();
  while (queue.length > 0) {
    const dir = queue.shift();
    if (!dir) continue;
    let entries: Dirent[] = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase() === wanted) {
        return full;
      }
    }
  }
  return undefined;
}

async function waitForEndpoint(
  home: string,
  timeoutMs: number,
): Promise<{ port: number; token: string } | undefined> {
  const p = join(home, "endpoint.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ep = JSON.parse(await readFile(p, "utf8")) as {
        protocolVersion?: number;
        port?: number;
        token?: string;
      };
      if (
        ep.protocolVersion === PROTOCOL_VERSION &&
        typeof ep.port === "number" &&
        ep.port > 0 &&
        ep.token
      ) {
        return { port: ep.port, token: ep.token };
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return undefined;
}

// Entry point when invoked directly (detached installer process).
const isMain =
  argv[1] !== undefined &&
  resolve(argv[1]).endsWith(join("dist", "installer.js"));
if (isMain || process.env.OMP_SKILL_KIT_INSTALLER === "1") {
  const args = argv.slice(2);
  const homeIdx = args.indexOf("--home");
  const homeArg = homeIdx >= 0 ? args[homeIdx + 1] : undefined;
  install({
    home: homeArg || resolveHome(),
    pluginRoot: pluginRootDir(),
  })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(
        `[skill-kit:installer] fatal: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    });
}
