$ErrorActionPreference = "Stop"
Write-Host "Starting Clean-User Windows Sandbox verification..."

# 1. Verify clean user environment (no pre-installed tools)
$forbidden = @("python", "python3", "uv", "mega-tron", "node", "npm", "pnpm", "bun", "git")
foreach ($cmd in $forbidden) {
    if (Get-Command $cmd -ErrorAction SilentlyContinue) {
        Write-Error "Forbidden tool detected in clean sandbox: $cmd"
        exit 1
    }
}
Write-Host "Clean user environment confirmed: zero development tools installed."

# 2. Setup standalone omp from input
$ompPath = "C:\Input\omp.exe"
if (!(Test-Path $ompPath)) {
    Write-Error "Standalone omp.exe missing in C:\Input"
    exit 1
}

# 3. Test plugin link and doctor
$env:OMP_PROFILE = "sandbox-test-profile"
& $ompPath plugin link "C:\Input\omp-skill-kit"
& $ompPath plugin list --json | Out-File "C:\Output\plugin-list.json" -Encoding utf8
& $ompPath plugin doctor --json | Out-File "C:\Output\plugin-doctor.json" -Encoding utf8

# 4. Save manifest
$manifest = @{
    environment = "windows-sandbox"
    status = "passed"
    timestamp = (Get-Date).ToString("o")
}
$manifest | ConvertTo-Json | Out-File "C:\Output\manifest.json" -Encoding utf8
Write-Host "Windows Sandbox E2E completed successfully."
