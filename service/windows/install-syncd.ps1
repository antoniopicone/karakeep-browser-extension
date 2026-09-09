<#
  Installs syncd as a Windows Scheduled Task that starts at logon and
  restarts automatically if it exits.

  Run from an elevated or regular PowerShell prompt (elevation not required
  since this registers a per-user task):

    .\install-syncd.ps1 -SyncdBin "C:\path\to\syncd.exe" -AuthToken "secret"

  Uninstall with uninstall-syncd.ps1.
#>
param(
  [string]$SyncdBin    = "$env:USERPROFILE\Developer\serverless-sync\target\release\syncd.exe",
  [string]$Device      = $env:COMPUTERNAME,
  [string]$DataDir     = "$env:USERPROFILE\.syncd",
  [int]   $Port        = 47100,
  [string]$AuthToken   = "",
  [string]$Bootstrap   = "",
  [string]$TaskName    = "syncd"
)

if (-not (Test-Path $SyncdBin)) {
  Write-Error "syncd.exe not found at $SyncdBin — build it first (cargo build --release in serverless-sync), or pass -SyncdBin"
  exit 1
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

$argList = @("--device", $Device, "--data-dir", $DataDir, "--port", $Port)
if ($AuthToken -ne "") { $argList += @("--auth-token", $AuthToken) }
if ($Bootstrap -ne "") { $argList += @("--bootstrap", $Bootstrap) }

$action    = New-ScheduledTaskAction -Execute $SyncdBin -Argument ($argList -join ' ')
$trigger   = New-ScheduledTaskTrigger -AtLogOn
$settings  = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "syncd (serverless-sync) local bookmark sync daemon" -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName

Write-Host "syncd registered as scheduled task '$TaskName' and started (port $Port, data dir $DataDir)."
Write-Host "It will now also start automatically at your next logon."
