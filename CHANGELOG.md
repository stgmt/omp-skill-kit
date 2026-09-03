# Changelog

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
