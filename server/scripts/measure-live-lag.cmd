@echo off
rem Mesure du retard du direct en production (ml/EXPLICATION_ML.md, section 10.2).
rem Releve l API NHL et https://api.arakice.com toutes les 2 s pendant 5 h 30,
rem puis ecrit ml\models\live\live_lag_<date>.md et .json.
rem Lance a la main, ou a l heure prevue par schedule-live-lag.ps1.
cd /d "%~dp0.."
if not exist "..\ml\models\live" mkdir "..\ml\models\live"
call npx ts-node --transpile-only scripts\measure-live-lag.ts --base https://api.arakice.com --minutes 330 > "..\ml\models\live\live_lag_run.log" 2>&1
