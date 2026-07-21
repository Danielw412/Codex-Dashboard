$ErrorActionPreference = "Stop"

$projectPath = Split-Path -Parent $PSScriptRoot
Set-Location $projectPath

$logDirectory = Join-Path $projectPath "logs"
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

$stdoutLog = Join-Path $logDirectory "dashboard.log"
$stderrLog = Join-Path $logDirectory "dashboard-error.log"

Start-Process `
    -FilePath "node.exe" `
    -ArgumentList "dist-server/index.js" `
    -WorkingDirectory $projectPath `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog