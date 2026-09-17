<#
  Installs reading-list-syncd as a Windows Scheduled Task that starts at
  logon and restarts automatically if it exits, AND registers it as a
  Chrome/Chromium Native Messaging host so the extension can reach it via
  chrome.runtime.sendNativeMessage — both are needed.

  Run from an elevated or regular PowerShell prompt (elevation not required
  since this registers a per-user task and per-user registry keys):

    .\install-reading-list-syncd.ps1 -SyncdBin "C:\path\to\reading-list-syncd.exe"

  There's no port or secret to pass here beyond -Port: Chrome's Native
  Messaging origin check (allowed_origins, pinned to this extension's fixed
  ID — see manifest.json's "key") plus the daemon's loopback-only local API
  are what gate access now.

  Uninstall with uninstall-reading-list-syncd.ps1.
#>
param(
  [string]$SyncdBin    = "$env:USERPROFILE\Developer\karakeep-browser-extension\native\reading-list-syncd\target\release\reading-list-syncd.exe",
  [string]$Device      = $env:COMPUTERNAME,
  [string]$DataFile    = "$env:USERPROFILE\.reading-list\reading-list.csv",
  [int]   $Port        = 47100,
  [string]$Bootstrap   = "",
  [string]$TaskName    = "reading-list-syncd",
  [string]$ExtensionId = "abnldgaciobpabmoffpkalojiihoollj"
)

if (-not (Test-Path $SyncdBin)) {
  Write-Error "reading-list-syncd.exe not found at $SyncdBin — build it first (cargo build --release in native\reading-list-syncd), or pass -SyncdBin"
  exit 1
}

New-Item -ItemType Directory -Force -Path (Split-Path $DataFile) | Out-Null

# ---- 1. Scheduled Task: the actual background daemon (serve mode) -------

$argList = @("serve", "--device", $Device, "--data", $DataFile, "--port", $Port)
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
  -Description "reading-list-syncd — embedded sync daemon for the Reading List extension" -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName

Write-Host "reading-list-syncd registered as scheduled task '$TaskName' and started (port $Port, ledger $DataFile)."
Write-Host "It will now also start automatically at your next logon."

# ---- 2. Native Messaging host manifest + registry key --------------------
# Chrome invokes $SyncdBin directly (no "serve" argument — bridge mode, see
# the binary's own module doc comment) whenever the extension calls
# chrome.runtime.sendNativeMessage; the registry key just tells Chrome where
# to find the manifest describing that.

$manifestDir  = Split-Path $DataFile
$manifestPath = Join-Path $manifestDir "com.antoniopicone.reading_list_syncd.json"
$manifest = @{
  name            = "com.antoniopicone.reading_list_syncd"
  description     = "Reading List extension — bridge to its embedded sync daemon"
  path            = $SyncdBin
  type            = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifest | ConvertTo-Json | Set-Content -Path $manifestPath -Encoding UTF8

foreach ($browserKey in @("Google\Chrome", "Chromium", "BraveSoftware\Brave-Browser", "Microsoft\Edge", "Vivaldi")) {
  $regPath = "HKCU:\Software\$browserKey\NativeMessagingHosts\com.antoniopicone.reading_list_syncd"
  New-Item -Path $regPath -Force | Out-Null
  Set-Item -Path $regPath -Value $manifestPath
}

Write-Host "Native messaging host manifest installed at $manifestPath and registered for Chrome and Chromium."
Write-Host "If you loaded the extension unpacked with a different ID than $ExtensionId, edit manifest.json's `"key`" back to the committed value, or re-run this script with -ExtensionId, or Chrome will refuse to reach this host."
