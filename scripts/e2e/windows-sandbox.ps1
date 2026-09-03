$ErrorActionPreference = "Stop"

$sandboxExe = "C:\Windows\System32\WindowsSandbox.exe"
if (!(Test-Path $sandboxExe)) {
    Write-Warning "Windows Sandbox is not installed or enabled on this system (Containers-DisposableClientVM)."
    Write-Host "Target windows-sandbox cannot be executed natively and is recorded as unconfirmed."
    
    $reportDir = "reports/e2e/windows-sandbox"
    New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
    @{
        environment = "windows-sandbox"
        status = "unconfirmed"
        reason = "Windows Sandbox feature Containers-DisposableClientVM not installed on host"
        timestamp = (Get-Date).ToString("o")
    } | ConvertTo-Json | Out-File "$reportDir/manifest.json" -Encoding utf8
    exit 0
}

Write-Host "Windows Sandbox is available, preparing test environment..."
# Host orchestration logic here
