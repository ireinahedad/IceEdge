@echo off
REM ---------------------------------------------------------------------------
REM refresh-insights.cmd — rafraichit les deux jeux d'insights
REM
REM PASSE 1 (Python, ml/data/content_insights*.json) : facteurs situationnels.
REM   Ne depend de rien d'autre que des CSV deja presents dans ml/data.
REM   `advanced` est EXCLU par defaut : c'est le seul des trois qui remonte
REM   jusqu'a 6 saisons, il n'a donc pas a etre regenere tous les 3 jours.
REM   Une fois par saison suffit -> lancer avec l'argument WITH_ADVANCED.
REM
REM PASSE 2 (TypeScript, content/data/content_insight_*.csv) : forme actuelle.
REM   EXIGE que l'app tourne (cd server ^&^& npm run dev), car le script lit via
REM   /api/nhl pour profiter des caches plutot que de retaper l'API NHL.
REM
REM Les deux passes sont independantes : si l'app n'est pas lancee, la passe 2
REM echoue mais la passe 1 a deja fait son travail. Le code de sortie reflete
REM la presence d'au moins un echec, sans jamais interrompre l'autre passe.
REM
REM Note : le script TypeScript ne connait que --only= et --api=. Il n'existe
REM pas de --skip= de ce cote, et cela ne manquerait a rien : `advanced` y
REM partage le fetch des 32 alignements avec `player`, donc l'exclure
REM n'economiserait aucun appel.
REM
REM Installation dans le Planificateur de taches (une fois, sans admin) :
REM   Le nom ne doit contenir aucun de ces caracteres : \ / : * ? " < > |
REM   (le \ y sert de separateur de dossier, le : est simplement interdit)
REM
REM   schtasks /create /tn "ICEEDGE content insights" ^
REM     /tr "C:\Users\irein\dev\ICEEDGE\content\refresh-insights.cmd" ^
REM     /sc daily /mo 3 /st 08:00
REM
REM Verifier / lancer a la main / supprimer :
REM   schtasks /query  /tn "ICEEDGE content insights"
REM   schtasks /run    /tn "ICEEDGE content insights"
REM   schtasks /delete /tn "ICEEDGE content insights" /f
REM
REM Passe complete, une fois par saison :
REM   refresh-insights.cmd WITH_ADVANCED
REM
REM DUREE : ~10 min sans advanced (mp_team_games.csv fait 100 Mo), ~20 avec.
REM JOURNAL : content\refresh-insights.log, ecrase a chaque execution.
REM ---------------------------------------------------------------------------

setlocal EnableDelayedExpansion

set "ROOT=%~dp0.."
set "LOG=%~dp0refresh-insights.log"
set "FAILED="

REM Le Planificateur de taches demarre avec un cwd imprevisible : tous les
REM chemins ci-dessous sont donc derives de %~dp0, jamais du repertoire courant.

> "%LOG%" echo [%DATE% %TIME%] debut

REM Python peut s'appeler python ou py selon l'installation.
where python >nul 2>&1 && (set "PY=python") || (set "PY=py")

REM --- Passe 1 : facteurs situationnels (Python) ------------------------------
cd /d "%ROOT%\ml\python" || (echo ERREUR: ml\python introuvable & exit /b 1)

call :run "insights ligue"   %PY% content_insights.py
call :run "insights equipes" %PY% content_insights_team_player.py

if /i "%~1"=="WITH_ADVANCED" (
  call :run "insights advanced" %PY% content_insights_advanced.py
) else (
  >> "%LOG%" echo [%DATE% %TIME%] advanced ignore - relancer avec WITH_ADVANCED
  echo [%DATE% %TIME%] advanced ignore
)

REM --- Passe 2 : forme actuelle, les 5 CSV (TypeScript) -----------------------
cd /d "%ROOT%\server" || (echo ERREUR: server introuvable & exit /b 1)
call :run "CSV forme actuelle" npm run content:insights

REM --- Bilan ------------------------------------------------------------------
if defined FAILED (
  >> "%LOG%" echo [%DATE% %TIME%] TERMINE AVEC ERREURS :!FAILED!
  echo.
  echo [%DATE% %TIME%] TERMINE AVEC ERREURS :!FAILED!
  echo   Si "CSV forme actuelle" a echoue : l'app tourne-t-elle ^(cd server ^&^& npm run dev^) ?
  echo   Detail complet dans %LOG%
  endlocal & exit /b 1
)

>> "%LOG%" echo [%DATE% %TIME%] termine sans erreur
echo [%DATE% %TIME%] termine sans erreur
endlocal & exit /b 0

REM ---------------------------------------------------------------------------
REM :run <libelle> <commande...>
REM Execute une etape, journalise, et memorise l'echec sans interrompre la
REM suite : une passe qui tombe ne doit pas empecher l'autre de s'executer, et
REM les fichiers de la passe precedente restent valides.
REM ---------------------------------------------------------------------------
:run
set "STEP=%~1"
shift
>> "%LOG%" echo.
>> "%LOG%" echo [%DATE% %TIME%] --- %STEP%
echo [%DATE% %TIME%] %STEP%
call %1 %2 %3 %4 %5 %6 >> "%LOG%" 2>&1
if errorlevel 1 (
  set "FAILED=!FAILED! [%STEP%]"
  >> "%LOG%" echo [%DATE% %TIME%] ECHEC : %STEP%
  echo    ECHEC - suite dans %LOG%
)
exit /b 0
