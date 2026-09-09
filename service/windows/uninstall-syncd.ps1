<#
  Removes the syncd scheduled task installed by install-syncd.ps1.
  Data on disk under the --data-dir used at install time is left untouched.
#>
param(
  [string]$TaskName = "syncd"
)

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Write-Host "syncd scheduled task '$TaskName' removed."
