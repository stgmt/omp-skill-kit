# Repository Guidelines

## Project Overview

`omp-skill-kit` is a native Oh My Pi (`@oh-my-pi/pi-coding-agent >=17.3.7`) extension that provides privacy-preserving, background semantic skill routing using an isolated, pinned `mega-tron` Python runtime.

- **Hook-Driven Routing**: Intercepts `before_agent_start` (per user turn) to scan workspace skills (`.omp/skills`, `.agents/skills`, `.claude/skills`, `skills/`), score candidate skills against the prompt via a local Python bridge, and inject at most three skill names as a prompt hint.
- **Names-Only Prompt Hints**: Injects only a prompt hint with skill names (e.g. `&lt;omp-skill-kit&gt;Relevant skills: ...&lt;/omp-skill-kit&gt;`). Skill bodies, descriptions, and file paths are **never** injected into the system prompt, preserving context tokens and avoiding prompt pollution.
- **Fail-Open Resilience**: Routing calls enforce a strict 750 ms timeout. If the bridge is initializing, degraded, slow, or offline, the extension fails open silently (`{ names: [], unavailable: true }`), never blocking or crashing the agent turn.
- **No MCP / No External Hooks**: Exposes standard OMP slash commands (`/omp-skill-kit:*`) and bundles the `mega-tron-dashboard` skill. It registers no MCP servers and avoids foreign Claude Code hooks.
- **Self-Contained Managed Runtime**: Automatically bootstraps an isolated Python 3.11.15 environment via `uv 0.12.9` into `~/.omp/skill-kit/runtime`, completely segregated from user system Python installations.

---

## Architecture & Data Flow

### Process Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                         Oh My Pi Host Process                          │
│                                                                        │
│  pi.on("session_start") ──► launchInstaller() (fire-and-forget)        │
│                                      │                                 │
│  pi.on("before_agent_start")         │ (spawn detached)                │
│         │                            ▼                                 │
│         ├── 1. Read StateStore (~/.omp/skill-kit/state.json)           │
│         ├── 2. loadEligibleCatalog() (discover SKILL.md files)         │
│         ├── 3. CatalogStore.publish() (fingerprint & snapshot)         │
│         ├── 4. RouterClient.rank() ──► [Loopback JSONL TCP]            │
│         │                                      │                       │
│         └── 5. Append prompt hints             ▼                       │
│                &lt;omp-skill-kit&gt;...   ┌───────────────────────────────┐  │
│                                     │     Detached Python Bridge    │  │
│                                     │ (python/omp_skill_kit_bridge) │  │
│                                     │ - mega_tron.router.Router     │  │
│                                     │ - Pinned commit 0ed290a       │  │
│                                     │ - npz vector cache            │  │
│                                     │ - 30 min idle shutdown        │  │
│                                     └───────────────────────────────┘  │
│                                                                        │
│  Commands: /omp-skill-kit:status, setup, doctor, dashboard, purge      │
└────────────────────────────────────────────────────────────────────────┘
```

### Data Flow Per Turn

1. **Trigger**: Agent receives prompt; OMP triggers `before_agent_start`.
2. **State Gate**: `RouterClient` verifies `state.json` phase is `ready`. If not ready, it immediately returns `{ names: [], unavailable: true }`.
3. **Catalog Snapshot**: `loadEligibleCatalog(cwd)` finds eligible `SKILL.md` candidates (ignoring hidden or disabled skills). `CatalogStore` computes a deterministic SHA-256 revision hash and persists `catalog.json` under `~/.omp/skill-kit/catalogs/<revision>/`.
4. **RPC Ranking**: `RouterClient` sends a JSONL RPC line over a loopback TCP socket (`127.0.0.1:<port>`) with the bearer token from `endpoint.json`.
5. **Bridge Execution**: `omp_skill_kit_bridge.py` queries `mega_tron.router.Router`, scoring candidate skills against the prompt and returning the top-k matches (max 3).
6. **Prompt Injection**: If candidates exceed confidence thresholds, the extension appends `&lt;omp-skill-kit&gt;Relevant skills: ...&lt;/omp-skill-kit&gt;` with matching candidate names to `systemPrompt`.

### Runtime & State Isolation

All runtime artifacts live under `~/.omp/skill-kit/` (overridable via `OMP_SKILL_KIT_HOME`):

```
~/.omp/skill-kit/
├── runtime/          # Managed Python 3.11 virtualenv & mega-tron package
├── catalogs/         # Versioned, hashed skill snapshots (retains newest 2)
├── models/           # Isolated Hugging Face cache (HF_HOME)
├── xdg/              # Isolated XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME
├── logs/             # Installer, bridge, and dashboard logs
├── state.json        # Runtime lifecycle phase, attempts, PIDs, error codes
├── endpoint.json     # Bridge loopback port, PID, and bearer token
└── dashboard.json    # Upstream dashboard URL, port, PID
```

---

## Key Directories

| Directory | Purpose |
|---|---|
| `src/` | Core TypeScript source for the OMP extension, installer, router client, and utilities. |
| `src/shared/` | Shared helpers: atomic filesystem ops, platform detection, manifest validation, safe downloads, and process spawning. |
| `python/` | Python bridge script (`omp_skill_kit_bridge.py`) running inside the managed virtualenv. |
| `skills/` | Bundled native skills provided by the plugin (`skills/mega-tron-dashboard/SKILL.md`). |
| `runtime-locks/` | Pinned dependency lockfiles (`requirements-*.txt`) with SHA-256 hashes across 6 platform targets. |
| `scripts/` | Deterministic release packager, archive verifier, release manifest generator, and E2E runners. |
| `tests/` | Vitest unit tests verifying components in isolation. |
| `tests/mutation/` | Path-traversal and skill name sanitization security fuzz tests. |
| `tests/bdd/` | Cucumber behavioral feature specifications (`features/*.feature`) and step definitions (`steps/`). |
| `tests/e2e/` | Standalone OMP loader, native Windows, Docker clean-user, and Windows Sandbox integration harnesses. |
| `audit-reports/` | Grounded contract audits for OMP runtime compatibility and extensibility. |
| `docs/` | Architectural design documents and multi-platform E2E plans. |

---

## Development Commands

Always use **`pnpm`** (`11.13.0`). Do not use `npm`, `yarn`, or `bun install`.

### Verification & Unified Gate

```bash
# Run complete pre-flight check (lint -> typecheck -> unit -> bdd -> mutation -> build)
pnpm run check
```

### Build & Compilation

```bash
# Bundle standalone ESM artifacts (dist/extension.js and dist/installer.js) via Bun
pnpm run build

# Typecheck TypeScript files without emitting JS
pnpm run typecheck
```

### Linting & Formatting

```bash
# Check code style, syntax, and import organization via Biome
pnpm run lint

# Automatically format code and organize imports
pnpm run format
```

### Testing

```bash
# Run Vitest unit tests (30s timeout, restoreMocks)
pnpm test

# Run Vitest in watch mode for active development
pnpm run test:watch

# Run Cucumber BDD behavioral test suite (10 feature specs via tsx)
pnpm run test:bdd

# Run Vitest mutation and security fuzz tests (60s timeout)
pnpm run test:mutation

# Run local OMP plugin loader test in an isolated profile
pnpm run test:e2e
```

### Advanced E2E Verification

```bash
# Run native Windows x64 OMP integration test (requires Windows)
pnpm run test:e2e:windows

# Run Docker Debian clean-user verification (requires Docker)
pnpm run test:e2e:docker

# Run Windows Sandbox VM verification (requires Windows Sandbox)
pnpm run test:e2e:windows-sandbox
```

### Packaging & Release

```bash
# Build deterministic release tarball (omp-skill-kit-<version>.tar.gz) and SHA256 checksum
pnpm run release:package

# Verify package privacy, entry points, lockfile hashes, and absence of pi_natives
pnpm run release:verify

# Generate unified multi-target release gate manifest
pnpm run release:manifest
```

---

## Code Conventions & Common Patterns

### Formatting & Style

- **Tooling**: Biome 2.4.15 (`biome.json`). 2 spaces, double quotes, trailing commas, line width 100.
- **Import Organization**: Automated by Biome on save (`assist.actions.source.organizeImports: "on"`).
- **Node Built-in Prefix**: Always use the `node:` protocol prefix:
  ```ts
  import { readFile, writeFile } from "node:fs/promises";
  import path from "node:path";
  import net from "node:net";
  ```
- **ESM Extensions**: Source relative imports MUST include explicit `.js` extensions:
  ```ts
  import { StateStore } from "./runtime.js";
  import { ROUTE_TIMEOUT_MS } from "./shared/constants.js";
  ```

### Naming Conventions

- **Files**: Lowercase kebab-case (`router-client.ts`, `bridge-protocol.ts`, `platform.ts`).
- **Classes**: PascalCase (`RouterClient`, `CatalogStore`, `StateStore`, `BridgeServer`).
- **Interfaces / Types**: PascalCase (`RuntimeState`, `HostPlatform`, `BridgeRequest`, `Phase`).
- **Functions & Methods**: camelCase (`loadEligibleCatalog`, `catalogRevision`, `rpcCall`, `detectPlatform`).
- **Constants**: UPPER_SNAKE_CASE (`ROUTE_TIMEOUT_MS = 750`, `MAX_CANDIDATE_SKILLS = 3`, `MAX_HINT_BYTES = 512`).
- **Slash Commands**: Namespaced kebab-case with prefix `/omp-skill-kit:` (`/omp-skill-kit:status`, `/omp-skill-kit:doctor`).

### Error Handling & Resilience Patterns

- **Fail-Open for Routing**: Semantic routing must never break user agent turns. In `src/router-client.ts`, all socket timeouts, network errors, and parsing issues are caught, logged to `console.error`, and resolved to `{ names: [], unavailable: true }`:
  ```ts
  try {
    const res = await this.rpc.call({ op: "rank", payload }, { timeoutMs: ROUTE_TIMEOUT_MS });
    return { names: res.candidates.map(c => c.name), unavailable: false };
  } catch (error) {
    console.error("[omp-skill-kit] Routing failed open:", error);
    return { names: [], unavailable: true };
  }
  ```
- **Fail-Closed for Security**:
  - `src/archive.ts` throws `UnsafeArchiveError` if an archive entry contains path traversals (`..`), absolute paths, symlinks, hardlinks, or exceeds safe size limits (2 GB per entry, 8 GB total).
  - `src/shared/fsx.ts` enforces `safeSkillName(name)` (`^[a-zA-Z0-9_-]{1,64}$`) before accessing files or passing names to Python.
  - `src/shared/download.ts` verifies SHA-256 against `runtime-manifest.json` and deletes partial files immediately on failure.

### Concurrency & State Management

- **Atomic File Writes**: Never write JSON state directly to disk. Use `writeAtomicJson()` in `src/shared/fsx.ts`, which writes to a temporary file (`<target>.tmp-<pid>-<time>`) and atomically renames it:
  ```ts
  await writeAtomicJson(statePath, state);
  ```
- **Directory Locks with Owner Check**: Background installer concurrency uses `mkdir` locks (`install.lock`) containing `owner.json`. If an active process holds the lock, incoming runs yield; if the PID in `owner.json` is dead, the stale lock is safely broken.
- **Typed Schema Versioning**: All serialized JSON schemas (`state.json`, `endpoint.json`, `dashboard.json`, `runtime-manifest.json`) specify `schemaVersion: 1`.

### Asynchronous & Process Patterns

- Native `async/await` and Promises throughout.
- Stream composition via `node:stream/promises` (`pipeline`).
- Sockets: Low-level TCP connections in `src/rpc.ts` wrap requests with hard timeouts (`setTimeout` / `AbortSignal.timeout`) and immediately destroy sockets on failure to prevent hung turns.
- Detached Background Processes: Detached workers (`installer.js`, `omp_skill_kit_bridge.py`, dashboard) use `spawnDetached` with `detached: true`, `stdio: ["ignore", logFd, logFd]`, and `child.unref()`.

### Dependency Injection for Testability

Classes (`CatalogStore`, `RouterClient`, `StateStore`) accept filesystem boundaries (`home`, `pluginRoot`, `catalogsRoot`) as explicit constructor options. This allows tests to inject isolated `.tmp/` directories without touching `~/.omp`.

---

## Important Files

### Entry Points

- `src/extension.ts`: Main OMP plugin entry point registering hooks (`session_start`, `before_agent_start`) and slash commands.
- `src/installer.ts`: Standalone CLI script (`dist/installer.js`) managing uv, Python, venv, and mega-tron bootstrap.
- `python/omp_skill_kit_bridge.py`: Detached Python asyncio JSONL server executing embedding and routing.
- `dist/extension.js`: Bundled OMP extension output.
- `dist/installer.js`: Bundled background installer output.

### Configuration & Manifests

- `package.json`: Manifest specifying `omp.extensions`, private status, pnpm 11.13.0, OMP engine requirement (`>=17.3.7`), and scripts.
- `tsconfig.json`: TypeScript compiler options (`ES2022`, `ESNext`, `moduleResolution: "bundler"`, `strict: true`, `noEmit: true`).
- `biome.json`: Biome formatting, linting, and import-organization configuration.
- `runtime-manifest.json`: Single source of truth for pinned URLs, versions (Python 3.11.15, uv 0.12.9, mega-tron 0ed290a), and per-target lockfile SHA-256 digests.
- `vitest.config.ts`: Vitest unit test runner settings.
- `vitest.mutation.config.ts`: Vitest security mutation test runner settings.
- `cucumber.cjs`: Cucumber BDD runner configuration using `tsx`.
- `pnpm-workspace.yaml`: Native build allowlist for esbuild, onnxruntime-node, protobufjs, sharp.
- `.omp-plugin/marketplace.json`: OMP plugin marketplace registration schema.

### Core Modules

- `src/router-client.ts`: High-level bridge supervisor, route dispatch, prompt hint formatting, and retry logic.
- `src/rpc.ts`: Low-level JSONL TCP client enforcing request IDs, timeouts, and byte limits.
- `src/catalog.ts`: Skill discovery, frontmatter validation, revision hashing, and snapshot persistence.
- `src/runtime.ts`: State machine tracking phases (`absent`, `downloading`, `installing-python`, `installing-mega-tron`, `warming`, `ready`, `degraded`).
- `src/archive.ts`: Hardened archive extraction defending against directory traversal and zip bombs.
- `src/dashboard.ts`: Mega-tron dashboard process launcher and HTTP health checker.
- `src/shared/constants.ts`: Core system limits (timeouts, candidate counts, byte limits).

---

## Runtime & Tooling Preferences

### Runtimes & Versions

- **Bun** (`1.3.14` in CI): Required for bundling (`bun build`) TypeScript sources into standalone ESM bundles.
- **Node.js** (`>=24.0.0`): Required for running tests (Vitest runs in `node` environment), BDD features (`tsx`), and release maintenance scripts (`node scripts/*.mjs`).
- **Python** (`3.11.15` via `uv 0.12.9`): Managed runtime in `~/.omp/skill-kit/runtime`, bootstrapped automatically. Do not rely on system Python.
- **Host Harness**: Requires Oh My Pi with `@oh-my-pi/pi-coding-agent >=17.3.7`.

### Package Manager & Distribution Rules

- **pnpm Only**: Pinned strictly to `pnpm@11.13.0`. Never commit `package-lock.json` or `yarn.lock`.
- **Private Repository / No-npm Policy**: `package.json` contains `"private": true`. Under no circumstances should this package be published to the npm registry.
- **Distribution Flow**: Distributed via deterministic GitHub Release tarballs (`omp-skill-kit-<version>.tar.gz` with SHA-256 checksums) and OMP marketplace manifests.
- **Pi-Natives Ban**: `@oh-my-pi/pi-coding-agent` is externalized during bundling. `scripts/verify-release.mjs` strictly fails if host native addon `pi_natives` is bundled into `dist/extension.js`.

---

## Testing & QA Expectations

### Test Tiers

1. **Unit Tests (Vitest)**:
   - Location: `tests/**/*.test.ts`
   - Role: Fast, in-memory validation of catalog hashing, RPC framing, archive parsing, and platform detection.
   - Command: `pnpm test`
2. **Mutation & Security Tests (Vitest)**:
   - Location: `tests/mutation/**/*.test.ts`
   - Role: Fuzzing path traversal inputs, safe skill name escaping, and security boundary validation.
   - Command: `pnpm run test:mutation`
3. **Behavioral BDD Tests (Cucumber)**:
   - Location: `tests/bdd/features/*.feature` (10 feature specs), `tests/bdd/steps/behavioral.steps.ts`
   - Role: End-to-end contract verification for bootstrap, catalog snapshotting, commands, dashboard, docker clean-user, fail-open behavior, release packaging, routing, and security.
   - Assertions: `node:assert/strict`
   - Command: `pnpm run test:bdd`
4. **Integration & E2E Tests (Custom TSX / Shell)**:
   - Location: `tests/e2e/`
   - Role: Plugin loader (`loader.ts`), native Windows execution (`windows.ts`), clean Debian container execution (`docker/run.mjs`), and Windows Sandbox (`windows-sandbox/`).
   - Mocking: Uses local loopback OpenAI-compatible stubs (`tests/e2e/support/openai-stub.ts`) to capture prompt hints.

### Non-Negotiable Test Invariants

1. **Prompt Privacy Guarantee**: Tests assert that prompt hints only contain skill names. Descriptions, markdown bodies, or paths must never appear in `systemPrompt`. The E2E evidence collector strictly verifies zero leakage of API secrets (`sk-`, `Bearer `).
2. **Fail-Open Behavior**: All routing tests must verify that when the Python bridge is absent, uninitialized, terminated, or timing out, the extension returns `{ unavailable: true }` without throwing.
3. **Loopback & Token Authorization**: All network services (bridge JSONL, dashboard HTTP, OpenAI mock stubs) must bind strictly to `127.0.0.1` and enforce token authentication.
4. **Strict Test Environment Isolation**: Tests must never read from or modify `~/.omp`. Every test suite must configure an isolated temporary home directory (`.tmp/bdd-home-...`, `OMP_SKILL_KIT_HOME`) and dedicated profile (`OMP_PROFILE=...`).
5. **Clean-User Validation**: Clean-user tests verify runtime bootstrapping in environments completely lacking developer tools (`python`, `uv`, `node`, `pnpm`, `bun`, `git`).
6. **Zero Drift Release Verification**: `scripts/verify-release.mjs` must pass on release tarballs, validating byte-for-byte checksums against `runtime-manifest.json` and verifying that no source files or dev dependencies leak into release archives.
