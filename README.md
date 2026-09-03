# omp-skill-kit

Native Oh My Pi plugin for local skill routing with the pinned `mega-tron` runtime.

## Behavior

- Starts installation autonomously in the background on the first OMP session start. Manual `/setup` is not required for the first run.
- Keeps the agent turn fail-open while Python, model, or the bridge is initializing or unavailable.
- Publishes only eligible OMP skills to a revisioned local catalog.
- Injects at most three candidate skill names into the next system prompt; descriptions, bodies, and paths are never injected into context.
- Shows transparent progress in the OMP footer status bar (`setup <step>/9 — <description> (<time>)`).
- Stores runtime data under `~/.omp/skill-kit` (override with `OMP_SKILL_KIT_HOME`).
- Uses Python 3.11.15, uv 0.12.9, sentence-transformers 5.4.1, transformers 5.16.1, and mega-tron commit `0ed290a1df1739af5cf4291d0ad8155afc7af16b`.

## Installation

Install the plugin through the Oh My Pi marketplace:

```bash
omp plugin install omp-skill-kit@omp-skill-kit --scope user
```

The first OMP session starts the runtime bootstrap automatically in the background.

## Commands

- `/omp-skill-kit:status` — Displays current lifecycle phase, install lock status, active runtime hash, bridge status, and progress.
- `/omp-skill-kit:setup` — Inspects the install lock and initiates or repairs the local runtime (reports if automatic setup is already running).
- `/omp-skill-kit:doctor` — Performs health checks on the runtime state, process lock, bridge connectivity, and active catalog entries.
- `/omp-skill-kit:dashboard` — Opens the local routing dashboard in the default browser. If installation is ongoing, it queues the dashboard to open automatically once ready.
- `/omp-skill-kit:purge --confirm` — Gracefully stops bridge and dashboard processes, and removes runtime data.
- `/omp-skill-kit:help` — Displays an overview of all six commands, the active runtime home directory, and paths to all component logs.

## Troubleshooting

When diagnosing runtime issues, start with `/omp-skill-kit:doctor`.

The extension isolates logs for each component under `<home>/logs/` (`~/.omp/skill-kit/logs` by default):

| Component | Log File | Description |
|---|---|---|
| Extension | `extension.log` | Extension lifecycle decisions, installer supervision events, route matches, and errors (JSONL) |
| Installer | `installer.log` | Detailed output from uv downloads, Python environment setup, dependency sync, and model warmup |
| Bridge | `bridge.log` | Python JSONL RPC server output, embeddings, and ranking requests |
| Dashboard | `dashboard.log` | Upstream dashboard server lifecycle, HTTP requests, and health status |

### Inspecting Logs

To monitor logs in real time:

**PowerShell (Windows):**
```powershell
Get-Content "$HOME\.omp\skill-kit\logs\extension.log" -Tail 100 -Wait
Get-Content "$HOME\.omp\skill-kit\logs\installer.log" -Tail 100 -Wait
Get-Content "$HOME\.omp\skill-kit\logs\bridge.log" -Tail 100 -Wait
Get-Content "$HOME\.omp\skill-kit\logs\dashboard.log" -Tail 100 -Wait
```

**POSIX Shell (Linux / macOS):**
```bash
tail -n 100 -f ~/.omp/skill-kit/logs/extension.log
tail -n 100 -f ~/.omp/skill-kit/logs/installer.log
tail -n 100 -f ~/.omp/skill-kit/logs/bridge.log
tail -n 100 -f ~/.omp/skill-kit/logs/dashboard.log
```

## Development

```bash
pnpm install
pnpm run check
```

The native OMP contract evidence is documented in `audit-reports/omp-skill-kit-omp-contract.md`.
