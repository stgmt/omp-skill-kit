---
name: mega-tron-dashboard
description: Inspect and explain mega-tron skill routing status, catalogs, and runtime health.
---

Use this skill when the user asks about skill routing health, runtime setup, catalog contents, or the local dashboard.

## Canonical Commands

- `/omp-skill-kit:status` — display runtime phase, bridge availability, and active runtime hash
- `/omp-skill-kit:setup` — trigger background installer to download and build managed runtime
- `/omp-skill-kit:doctor` — verify runtime health, active catalog snapshot, and bridge responsiveness
- `/omp-skill-kit:dashboard` — start or reuse local mega-tron HTTP dashboard at `http://127.0.0.1:7531/`
- `/omp-skill-kit:purge --confirm` — gracefully shutdown bridge and dashboard, remove all runtime data
