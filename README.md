# omp-skill-kit

Native Oh My Pi plugin for local skill routing with the pinned `mega-tron` runtime (0.1.1).

## Behavior

- Starts installation in the background after the first OMP session starts.
- Keeps the agent turn fail-open while Python, model, or the bridge is unavailable.
- Publishes only eligible OMP skills to a revisioned local catalog.
- Adds at most three skill names to the next system prompt; descriptions and bodies are not injected.
- Stores runtime data under `~/.omp/skill-kit` (override with `OMP_SKILL_KIT_HOME`).
- Uses Python 3.11.15, uv 0.12.9, sentence-transformers 5.4.1, transformers 5.16.1, and mega-tron commit `0ed290a1df1739af5cf4291d0ad8155afc7af16b`.

## Installation

Install the plugin through the Oh My Pi marketplace. The first OMP session starts the runtime bootstrap in the background. Use `/omp-skill-kit:setup` to start or repair it explicitly.

Commands:

- `/omp-skill-kit:status`
- `/omp-skill-kit:setup`
- `/omp-skill-kit:doctor`
- `/omp-skill-kit:dashboard`
- `/omp-skill-kit:purge --confirm`

The runtime is pinned in `runtime-manifest.json` and `runtime-locks/`. Windows arm64 uses the Windows x64 wheel set under emulation because the pinned PyTorch release does not publish a Windows arm64 wheel. The plugin does not publish to npm; distribution is through GitHub and the OMP marketplace.

## Development

```text
pnpm install
pnpm run check
```

The native OMP contract evidence is in `audit-reports/omp-skill-kit-omp-contract.md`.
