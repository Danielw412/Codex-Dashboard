$ErrorActionPreference = "Stop"

$projectPath = Split-Path -Parent $PSScriptRoot
$startScript = Join-Path $projectPath "scripts\start-dashboard.ps1"

$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScript`""

$trigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Days 3650)

Register-ScheduledTask `
    -TaskName "Codex Usage Dashboard" `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Collect Codex quota and token usage in the background." `
    -Force

Write-Host "Codex Usage Dashboard will start automatically when you sign in."