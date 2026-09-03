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
import { openSync, readFileSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { argv } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractTarGzHardened, extractZipHardened } from "./archive.js";
import { rpcCall } from "./rpc.js";
import { initialState, StateStore } from "./runtime.js";
import { PROTOCOL_VERSION } from "./shared/constants.js";
import { downloadVerified } from "./shared/download.js";
import { atomicWriteJson, pathExists, sha256Hex } from "./shared/fsx.js";
import { loadManifest, targetSpec, uvAsset } from "./shared/manifest.js";
import { detectPlatform } from "./shared/platform.js";
import { run } from "./shared/spawn.js";

const HOME_ENV = "OMP_SKILL_KIT_HOME";
const RUNTIME_VERSION = "v1"; // bump when layout/state contract changes

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

/** Atomic lock: mkdir + owner file. Stale locks are broken only after the
 * owner pid is verified dead. */
async function acquireLock(
  lockDir: string,
  pid: number,
  token: string,
): Promise<boolean> {
  for (;;) {
    try {
      await mkdir(lockDir);
      await writeFile(
        join(lockDir, "owner.json"),
        JSON.stringify({ pid, token, startedAt: new Date().toISOString() }),
        "utf8",
      );
      return true;
    } catch {
      // exists
    }
    const ownerFile = join(lockDir, "owner.json");
    let stale = false;
    try {
      const owner = JSON.parse(await readFile(ownerFile, "utf8")) as {
        pid?: number;
      };
      if (typeof owner.pid !== "number") stale = true;
      else if (!processAlive(owner.pid)) stale = true;
    } catch {
      stale = true;
    }
    if (stale) {
      await rm(lockDir, { recursive: true, force: true });
      continue;
    }
    return false; // live owner
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
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
  const lockDir = join(home, "install.lock");
  if (!(await acquireLock(lockDir, process.pid ?? 0, cryptoToken()))) {
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
    const xdgEnv = {
      XDG_CONFIG_HOME: join(home, "xdg", "config"),
      XDG_DATA_HOME: join(home, "xdg", "data"),
      XDG_CACHE_HOME: join(home, "xdg", "cache"),
      HF_HOME: join(home, "models"),
      SENTENCE_TRANSFORMERS_HOME: join(home, "models", "sentence-transformers"),
    };

    // ---- 0. state: downloading -------------------------------------------------
    await store.save({
      ...state,
      schemaVersion: 1,
      pluginVersion: version,
      phase: "downloading",
      attempt: state.attempt + 1,
      updatedAt: new Date().toISOString(),
      lastHealthyRuntimeHash: state.lastHealthyRuntimeHash,
    });

    // ---- 1. uv (pinned asset, digest-verified, hardened extract) --------------
    const uvArchive = join(
      home,
      "downloads",
      isWindows ? "uv.zip" : "uv.tar.gz",
    );
    log(
      `downloading uv ${manifest.uv.version} (${asset.sha256.slice(0, 12)}...)`,
    );
    await downloadVerified({
      url: asset.url,
      dest: uvArchive,
      sha256: asset.sha256,
    });
    const uvTop = join(versionRoot, ".uv-top");
    await rm(uvTop, { recursive: true, force: true });
    await mkdir(uvTop, { recursive: true });
    if (isWindows) await extractZipHardened(uvArchive, uvTop);
    else await extractTarGzHardened(uvArchive, uvTop);
    const uvExe = await findExecutable(uvTop, isWindows ? "uv.exe" : "uv");
    if (!uvExe) throw new Error("uv executable missing after extraction");

    // ---- 2. state: installing-python -------------------------------------------
    await store.save({
      ...state,
      schemaVersion: 1,
      pluginVersion: version,
      phase: "installing-python",
      attempt: state.attempt + 1,
      updatedAt: new Date().toISOString(),
      lastHealthyRuntimeHash: state.lastHealthyRuntimeHash,
    });
    log(
      `installing python ${manifest.python.version} via uv ${manifest.uv.version}`,
    );
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

    // ---- 3. venv ---------------------------------------------------------------
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

    // ---- 4. state: installing-mega-tron -----------------------------------------
    await store.save({
      ...state,
      schemaVersion: 1,
      pluginVersion: version,
      phase: "installing-mega-tron",
      attempt: state.attempt + 1,
      updatedAt: new Date().toISOString(),
      lastHealthyRuntimeHash: state.lastHealthyRuntimeHash,
    });
    log("verifying mega-tron source archive");
    const megaArchive = join(home, "downloads", "mega-tron.tar.gz");
    await downloadVerified({
      url: manifest.megaTron.archiveUrl,
      dest: megaArchive,
      sha256: manifest.megaTron.archiveSha256,
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
    log("installing locked dependencies");
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

    // The pinned upstream archive has a Windows-incompatible duplicate
    // Hatch force-include entry. Install its verified source tree directly
    // after syncing every locked dependency; no source code is changed.
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

    // ---- 5. state: warming (real embedder against fixture catalog) --------------
    await store.save({
      ...state,
      schemaVersion: 1,
      pluginVersion: version,
      phase: "warming",
      attempt: state.attempt + 1,
      updatedAt: new Date().toISOString(),
      lastHealthyRuntimeHash: state.lastHealthyRuntimeHash,
    });
    log("warming embedder + first rank");
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

    // ---- 6. bridge start + ping, then ready --------------------------------------
    const token = cryptoToken();
    await rm(join(home, "endpoint.json"), { force: true });
    const pid = spawnDetachedBridge(
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

    await atomicWriteJson(join(home, "runtime", "active.json"), {
      runtimeHash,
      versionRoot,
      python: pyExe,
      venv: venvPy,
    });
    await store.save({
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
    const message = err instanceof Error ? err.message : String(err);
    log(`install failed: ${message}`);
    const failed = await store.load();
    await store.save({
      ...failed,
      schemaVersion: 1,
      pluginVersion: version,
      phase: "degraded",
      attempt: failed.attempt + 1,
      updatedAt: new Date().toISOString(),
      errorCode: message.slice(0, 500),
    });
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

function computeRuntimeHash(
  _pluginRoot: string,
  manifest: Awaited<ReturnType<typeof loadManifest>>,
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

function spawnDetachedBridge(
  python: string,
  script: string,
  home: string,
  runtimeHash: string,
  token: string,
  xdgEnv: Record<string, string>,
): number {
  const out = openSync(join(home, "logs", "bridge.log"), "a");
  const child = spawn(
    python,
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
    const current = queue.shift();
    if (!current) break;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = join(current, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === wanted)
        return candidate;
      if (
        entry.isDirectory() &&
        !(wanted === 'python.exe' && entry.name.toLowerCase() === 'lib')
      )
        queue.push(candidate);
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
