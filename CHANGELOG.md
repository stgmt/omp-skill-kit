# Changelog

## 0.1.2

- Autonomous background installation on first OMP session start (`session_start` and `before_agent_start`) without requiring manual setup commands.
- Synchronized OMP contract with the latest local `omp 18.1.6` and pinned `@oh-my-pi/pi-coding-agent 18.1.6`.
- Implemented observable, safe cross-process install lock (`src/install-lock.ts`) with grace period, owner token validation, and stale lock auto-recovery.
- Honest 9-step install progress tracking (`src/runtime.ts`, `src/installer.ts`) with real-time download byte progress callbacks (`src/shared/download.ts`).
- Real-time OMP status bar progress reporting (`setup <step>/9 — <description> (<time>)`).
- Unified lifecycle controller in `src/extension.ts` with automatic recovery of interrupted installations and deduplication of concurrent launches.
- Automatic queueing for `/omp-skill-kit:dashboard` during installation to open once ready, eliminating `run setup first` warnings.
- Persistent JSONL diagnostic logging in `<home>/logs/extension.log` with strict privacy allowlist and secret redaction.
- Registered canonical `/omp-skill-kit:help` command displaying command overview, runtime home, and exact component log paths.
- Added comprehensive unit, BDD, mutation, and autonomous lifecycle E2E tests (`tests/e2e/lifecycle.ts`).

## 0.1.1

- Verified Windows 11 x64 and Debian Linux clean-user container E2E execution.
- Externalized `@oh-my-pi/pi-coding-agent` during bundling, eliminating host `pi_natives` leakage.
- Added native `mega-tron dashboard` port-fallback and loopback readiness checks.
- Hardened zip archive extraction with system tar fallback on Windows.
- Added E2E negative scenario #7 verifying damaged digest rollback and healthy runtime preservation.
- Formalized consolidated release gate matrix.

## 0.1.0

- Initial standalone native OMP plugin.
- Background hash-verified uv/Python/mega-tron runtime bootstrap.
- Revisioned OMP skill catalog and loopback names-only routing bridge.
- Fail-open lifecycle integration and health commands.
- Model-compatible sentence-transformers 5.4.1 and transformers 5.16.1 runtime locks.
