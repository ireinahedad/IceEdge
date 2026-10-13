@echo off
REM ---------------------------------------------------------------------------
REM refresh-data.cmd — met a jour les donnees du modele ML en cours de saison
REM
REM Lance ml\python\refresh_data.py : calendrier NHL + MoneyPuck (saison en
REM cours seulement, ajoutee a l'historique deja sur disque), puis
REM build_dataset.py. Regenere ml\models\inference_state.json et
REM ml\models\elo_ratings.json, puis calcule le recalage de niveau des
REM buts (ml\models\level_layer.json). Ne touche JAMAIS ml\data\odds.csv, ne
REM reentraine rien, ne committe rien.
REM
REM Apres le run, pour que le service en ligne en profite :
REM   git add ml/models/inference_state.json ml/models/elo_ratings.json ml/models/level_layer.json ml/models/ref_effects.json
REM   git commit -m "Donnees ML au <date>" ^&^& git push
REM (le service ML embarque ml/models dans son image : Railway redeploie.)
REM
REM Installation dans le Planificateur de taches (une fois, sans admin) —
REM chaque lundi a 9 h, heure du poste :
REM
REM   schtasks /create /tn "ICEEDGE refresh ML" ^
REM     /tr "C:\Users\irein\dev\ICEEDGE\ml\refresh-data.cmd" ^
REM     /sc weekly /d MON /st 09:00
REM
REM Verifier / lancer a la main / supprimer :
REM   schtasks /query  /tn "ICEEDGE refresh ML"
REM   schtasks /run    /tn "ICEEDGE refresh ML"
REM   schtasks /delete /tn "ICEEDGE refresh ML" /f
REM
REM DUREE : ~10 min (all_teams.csv fait ~125 Mo). Si le zip de saison des
REM patineurs est inaccessible, le repli lit un fichier par joueur, une
REM requete par seconde (MoneyPuck refuse au-dela) : ~7 min de plus.
REM Journal : ml\data\refresh-data.log
REM ---------------------------------------------------------------------------
setlocal
REM UTF-8 : sans lui, les accents et emojis du journal plantent en cp1252
set PYTHONUTF8=1
cd /d "%~dp0python"
python refresh_data.py > "%~dp0data\refresh-data.log" 2>&1
set RC=%ERRORLEVEL%
type "%~dp0data\refresh-data.log"
exit /b %RC%
