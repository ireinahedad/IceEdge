# Programme la mesure du retard du direct pour la soirée de matchs.
#
#   Clic droit > « Exécuter avec PowerShell », ou :
#   powershell -ExecutionPolicy Bypass -File server\scripts\schedule-live-lag.ps1
#
# Par défaut : mardi 20 octobre 2026 à 06:55 (heure de l'ordinateur, Bali), juste
# avant les matchs du 19 octobre (heure de l'Est) : ANA@NYR et COL@PHI à 07:00,
# SJS@TOR à 07:30, PIT@UTA à 09:00. La mesure dure 5 h 30 (jusqu'à ~12:25).
# Un autre soir : -At '2026-10-21T06:55'.
#
# L'ordinateur doit être allumé (il est réveillé s'il dort), avec la session
# ouverte, et la version à mesurer doit être déployée en production.
param([datetime]$At = [datetime]'2026-10-20T06:55:00')

$cmd = Join-Path $PSScriptRoot 'measure-live-lag.cmd'
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$cmd`""
$trigger = New-ScheduledTaskTrigger -Once -At $At
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Hours 6)
Register-ScheduledTask -TaskName 'IceEdge - mesure du retard du direct' -Action $action -Trigger $trigger `
  -Settings $settings -Description 'server/scripts/measure-live-lag.ts (ml/EXPLICATION_ML.md, section 10.2)' -Force | Out-Null
Write-Host "Mesure programmée le $($At.ToString('yyyy-MM-dd HH:mm')). Résultat : ml\models\live\live_lag_<date>.md"
