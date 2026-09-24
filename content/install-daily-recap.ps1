# install-daily-recap.ps1 - installe la tache planifiee du recap quotidien.
# A lancer une fois, sans admin :
#   powershell -ExecutionPolicy Bypass -File C:\Users\irein\dev\ICEEDGE\content\install-daily-recap.ps1
#
# Verifier / lancer a la main / supprimer :
#   Get-ScheduledTask   -TaskName "ICEEDGE daily recap"
#   Start-ScheduledTask -TaskName "ICEEDGE daily recap"
#   Unregister-ScheduledTask -TaskName "ICEEDGE daily recap" -Confirm:$false

$script = Join-Path $PSScriptRoot 'daily-recap.cmd'

$action   = New-ScheduledTaskAction -Execute $script -WorkingDirectory $PSScriptRoot
$trigger  = New-ScheduledTaskTrigger -Daily -At '12:00'
# StartWhenAvailable : si le PC dormait a midi, la tache part au reveil.
# 4 h max : 5 tentatives de recap espacees de 30 min + rendu + montage.
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 4) `
  -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName 'ICEEDGE daily recap' `
  -Action $action -Trigger $trigger -Settings $settings `
  -Description 'content:recap + render + video, puis copie des mp4 vers Google Drive' `
  -Force | Out-Null

Get-ScheduledTask -TaskName 'ICEEDGE daily recap' | Select-Object TaskName, State
Write-Host "Prochain lancement :" (Get-ScheduledTaskInfo -TaskName 'ICEEDGE daily recap').NextRunTime
