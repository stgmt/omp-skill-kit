$ErrorActionPreference = "Stop"
Write-Host "Running Native Windows x64 E2E test..."
pnpm run release:package
pnpm run release:verify
node scripts/e2e/prepare-runtime.mjs
npx tsx tests/e2e/windows.ts
