@echo off
REM ---------------------------------------------------------------------------
REM daily-recap.cmd - recap d'apres-match automatique, video vers Google Drive
REM
REM Enchaine, pour la soiree LNH qui vient de finir :
REM   npm run content:recap  -- --date=<D> --require-all
REM   npm run content:render -- --date=<D>-recap
REM   npm run content:video  -- --date=<D>-recap
REM puis copie chaque video.mp4 dans  <Drive>\ICEEDGE\recaps\<D>\<post>.mp4
REM
REM DATE : calculee ici (heure locale - 36 h), puis passee aux trois commandes.
REM   Lancee a midi (Makassar, UTC+8) le jour J+1, elle tombe sur la soiree J.
REM   Le calcul reste juste pour tout lancement entre J+1 12:00 et J+2 11:59,
REM   donc aussi quand la tache rattrape un lancement manque (PC eteint).
REM   Forcer une soiree :  daily-recap.cmd 2026-09-20
REM
REM MATCHS EN COURS : --require-all refuse un tableau incomplet. A midi, les
REM   matchs de la cote Ouest peuvent encore tourner : le script reessaie
REM   toutes les 30 min, 5 tentatives au total (12:00 -> 14:00).
REM   Soir sans match ("aucun match au calendrier") : sortie propre, code 0.
REM
REM DRIVE : "G:\My Drive" (Google Drive pour ordinateur), ou la variable
REM   ICEEDGE_DRIVE si definie. Si le dossier n'existe pas (Drive deconnecte),
REM   les videos restent dans content\output\<D>-recap et la tache sort en erreur.
REM
REM JOURNAL : content\daily-recap.log (ajout a chaque execution).
REM INSTALLATION : content\install-daily-recap.ps1 (une fois).
REM ---------------------------------------------------------------------------

setlocal EnableDelayedExpansion

set "ROOT=%~dp0.."
set "LOG=%~dp0daily-recap.log"
set "TMPOUT=%TEMP%\iceedge-recap-attempt.txt"
set "MAX_TRIES=5"
set "WAIT_SEC=1800"

REM --- Soiree visee -----------------------------------------------------------
set "D=%~1"
if not defined D (
  for /f %%d in ('powershell -NoProfile -Command "(Get-Date).AddHours(-36).ToString('yyyy-MM-dd')"') do set "D=%%d"
)
if not defined D (echo ERREUR: date introuvable & exit /b 1)

REM --- Dossier Drive ----------------------------------------------------------
set "DRIVE=G:\My Drive"
if defined ICEEDGE_DRIVE set "DRIVE=%ICEEDGE_DRIVE%"
if not exist "%DRIVE%\" set "DRIVE="

>> "%LOG%" echo.
>> "%LOG%" echo ===========================================================
call :log "debut - soiree %D%"

cd /d "%ROOT%\server" || (call :log "ERREUR: server introuvable" & exit /b 1)

REM --- 1. content:recap, avec reessais ---------------------------------------
set /a TRY=0
:recap
set /a TRY+=1
call :log "content:recap - tentative !TRY!/%MAX_TRIES%"
call npm run content:recap -- --date=%D% --require-all > "%TMPOUT%" 2>&1
set "RC=!errorlevel!"
type "%TMPOUT%" >> "%LOG%"
if "!RC!"=="0" goto :render

findstr /c:"au calendrier" "%TMPOUT%" >nul
if not errorlevel 1 (
  call :log "aucun match le %D% - rien a produire"
  exit /b 0
)
if !TRY! GEQ %MAX_TRIES% (
  call :log "ECHEC content:recap apres %MAX_TRIES% tentatives"
  exit /b 1
)
call :log "attente %WAIT_SEC% s avant nouvel essai"
powershell -NoProfile -Command "Start-Sleep -Seconds %WAIT_SEC%"
goto :recap

REM --- 2. content:render -----------------------------------------------------
:render
call :log "content:render"
call npm run content:render -- --date=%D%-recap >> "%LOG%" 2>&1
if errorlevel 1 (call :log "ECHEC content:render" & exit /b 1)

REM --- 3. content:video ------------------------------------------------------
call :log "content:video"
call npm run content:video -- --date=%D%-recap >> "%LOG%" 2>&1
if errorlevel 1 (call :log "ECHEC content:video" & exit /b 1)

REM --- 4. Copie vers le Drive ------------------------------------------------
set "OUT=%ROOT%\content\output\%D%-recap"
if not defined DRIVE (
  call :log "ECHEC: Google Drive introuvable - videos laissees dans %OUT%"
  exit /b 1
)
set "DEST=%DRIVE%\ICEEDGE\recaps\%D%"
if not exist "%DEST%\" mkdir "%DEST%"
set /a N=0
for /d %%p in ("%OUT%\*") do (
  if exist "%%p\video.mp4" (
    copy /y "%%p\video.mp4" "%DEST%\%%~nxp.mp4" >nul && set /a N+=1
  )
)
if !N! EQU 0 (call :log "ECHEC: aucune video.mp4 dans %OUT%" & exit /b 1)

call :log "termine - !N! video(s) dans %DEST%"
endlocal & exit /b 0

REM ---------------------------------------------------------------------------
:log
>> "%LOG%" echo [%DATE% %TIME%] %~1
echo [%DATE% %TIME%] %~1
exit /b 0
