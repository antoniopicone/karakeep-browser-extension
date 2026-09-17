<#
  Removes the reading-list-syncd scheduled task and the Native Messaging
  host registration installed by install-reading-list-syncd.ps1.
  Your ledger CSV on disk is left untouched.
#>
param(
  [string]$TaskName = "reading-list-syncd"
)

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "reading-list-syncd scheduled task '$TaskName' removed."

foreach ($browserKey in @("Google\Chrome", "Chromium", "BraveSoftware\Brave-Browser", "Microsoft\Edge", "Vivaldi")) {
  $regPath = "HKCU:\Software\$browserKey\NativeMessagingHosts\com.antoniopicone.reading_list_syncd"
  Remove-Item -Path $regPath -Force -ErrorAction SilentlyContinue
}
Write-Host "Native messaging host registration removed."
