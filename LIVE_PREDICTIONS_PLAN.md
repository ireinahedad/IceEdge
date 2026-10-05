# LIVE_PREDICTIONS_PLAN.md — prédictions en direct : ce qui reste

> Phases 1 et 2 livrées et vérifiées pendant un vrai match (2026-10-05). La version
> complète, avec tout l'historique des mesures : `git show 0916b52:LIVE_PREDICTIONS_PLAN.md`.
> **La liste des tâches reste dans `STATUS.md` §3.5** ; ce fichier n'en garde que le détail.

Règle tenue depuis le début : **rien n'est activé sans gain mesuré au rejeu**, et aucune
constante qui n'a pas été mesurée sur de vrais matchs.

## 1. Avantage numérique en cours — pas fait

Les fichiers de tirs MoneyPuck ne donnent pas le temps passé en avantage (il n'y a que les
tirs), donc le multiplicateur ne peut pas en être mesuré. Il faut :

1. Les pénalités du play-by-play NHL (`v1/gamecenter/{id}/play-by-play`, ~1 300 matchs par
   saison) pour reconstruire les intervalles 5 c. 4, 5 c. 3, 4 c. 4.
2. La même vraisemblance d'exposition que `calibrate_live.py` (cadence = λ × w(t) × m(…)),
   avec un facteur par situation.
3. Un rejeu (`server/scripts/replay-live.ts`) : n'activer que si la log-loss baisse.

Déjà en place côté Node : `situationCode` est vérifié (`1451` = domicile à 5 contre 4) et la
feuille de match porte `situation.secondsRemaining`.

## 2. Pas encore passés par le moteur à effets de score

Cartes P1/P2 (Skellam) et « les deux marquent » (binomiale négative) restent sur le calcul de
la phase 1. Les effets pèsent surtout en fin de 3e, où ces cartes sont déjà décidées : faible
priorité.

## 3. À re-vérifier après la saison 2026-27

Le rejeu montrait 2 cases pires sur 50 : totaux > 5,5 et > 6,5 **à la mise au jeu**, à cause du
niveau d'avant-match trop haut. Le recalage de niveau (`measure_level.py`, 2026-10-04) devrait
les corriger : relancer `live_pregame.py && measure_level.py`, puis le rejeu.

## Refaire les mesures

1. Réseau : `curl -sI https://moneypuck.com/` et `curl -sI https://api-web.nhle.com/v1/schedule/now`.
   ⚠️ Avast intercepte le HTTPS sur le poste : exporter sa racine en PEM et poser
   `REQUESTS_CA_BUNDLE` (Python) / `NODE_EXTRA_CA_CERTS` (Node), ou exclure ces domaines.
2. `fetch_live_goals.py` → `live_pregame.py` → `calibrate_live.py`, puis
   `cd server && npx ts-node --transpile-only scripts/replay-live.ts` (~15 min pour 3 saisons).
   Garder les saisons de test au-delà de `--last-train` (le rejeu refuse sinon).
