# LIVE_PREDICTIONS_PLAN.md — prédictions en direct : plan détaillé

> Plan détaillé derrière la tâche « Live predictions, phase 2 part 2 » de
> `STATUS.md` §3.5. **La liste des tâches reste dans `STATUS.md`** (règle du
> dépôt) ; ce fichier n'en garde que le détail et l'historique des décisions.
> À relire en début de session avant de reprendre la partie 2.


Légende : ✅ fait · 🔄 modifié en cours de route · ⏳ à faire (bloqué)

Branche : `claude/laughing-davinci-3ver59` → `master` (Pull Request ouverte le 2026-10-01).

| Commit | Contenu |
|---|---|
| `ee5c761` | Phase 1 — règles en direct (score actuel + temps restant) |
| `613e043` | Phase 2, partie 1 — ML en direct, paris joueur en direct, face-à-face (donnée) |
| `8ae3059` | Affichage : recalculé en direct = blanc opaque, avant-match = plus pâle + note |

## Ce que tu dois faire, toi
1. ⏳ **Ouvrir le réseau** : environnement cloud → Edit → Network access → ajouter `moneypuck.com`, `api-web.nhle.com`, `api.nhle.com`. Toujours bloqué au dernier contrôle (2026-10-01). Une nouvelle session sera sans doute nécessaire après le réglage.
2. ⏳ **Fusionner** `claude/laughing-davinci-3ver59` dans `master`. Railway (Node) et Vercel (site) redéploient seuls. Pas de Python, pas de migration pour ce qui est déjà fait.

## Tes demandes
1. ✅ Le ML se recalcule pendant le match.
2. 🔄 Les chiffres tiennent compte de comment va la partie :
   - ✅ score et temps restant ;
   - ⏳ effets de score mesurés (équipe menée, gardien retiré, avantage numérique) : besoin du réseau.
3. ⏳ Derniers matchs entre les deux équipes : la donnée est récupérée (✅), mais elle n'est pas encore utilisée. Son poids doit d'abord être mesuré (réseau).
4. 🔄 « Aucune valeur bidon » → règle d'affichage retenue : un chiffre recalculé en direct apparaît en **blanc opaque**, tout ce qui a été calculé avant le match apparaît **plus pâle**, avec une note en haut de la page. Aucune constante nouvelle sans mesure sur de vrais matchs.

---

## Phase 1 — ✅ (commit `ee5c761`)
- `finalScore.ts` : `LiveState`, grille décalée du score actuel, λ × f, `regHome/regAway/regTie`, `nbAtLeastLive`. Sans direct, sortie identique.
- `nhlPredictions.ts` :
  - `liveCtxFromDetail` (lit `fetchGameDetail`) ;
  - f pondéré par période ;
  - calage sur la victoire et le P(prolongation) d'avant-match (`liveCalibration`, `tieBoost`) ;
  - marchés décidés à 100/0 ;
  - pas de facteurs en direct ;
  - match terminé = état final décidé ;
  - `buildGameMarketsWithStatus` + cache de 30 s.
- Route `/predictions/game/:id` : 30 s en direct, 6 h terminé.
- Client : rafraîchissement toutes les 30 s sans clignotement, vrai statut du match, une seule requête de feuille de match et d'effectif partagée par les 7 grilles.

## Phase 2, partie 1 (bloc A) — ✅ (commits `613e043` + `8ae3059`)

### 1. Affichage en direct — 🔄 remplacé à ta demande
- Prévu : erreur 503 + bandeau « données indisponibles » + cases « — ».
- **Fait (version finale)** :
  - chaque chiffre recalculé sur l'état du match porte `live: true` (tuiles du serveur, paquet ML, grilles joueur) → **blanc opaque** ;
  - tout le reste montre sa **valeur d'avant-match, plus pâle** (opacité 40 %) : feuille de match illisible (le serveur sert l'avant-match avec un cache court), paris joueur en prolongation, entrée ML manquante, questions non recalculables, **cotes du bookmaker**, chiffres non rafraîchis depuis 90 s ;
  - note en haut de page (`pred.liveNote`) ; la fiche d'un chiffre pâle dit « Calculé avant le match » ;
  - une réponse de repli du serveur (`X-Stale-Response`, désormais exposé par CORS) est refusée pendant le match.
  - Retirés en cours de route : le 503, `noStaleFallback`, `BetOpt.unavailable` et le bandeau.

### 2. ML en direct — ✅
- `computeGameMarkets(…, live, model)`, `buildLiveModelMarkets`, `buildPrematchGameMarkets`.
- `gameMlBundle.applyLive` : les chiffres d'avant-match du modèle (victoire, prolongation, λ) passent par la grille du score.
  - Cache : 10 min avant-match, 30 s en direct.
  - Champ `probability_scale: 'pct'`, pour que 0 et 1 % ne soient pas lus comme des fractions.
- Route du paquet : 2 min avant-match, 30 s en direct, 6 h terminé.
- Client : bouton ML réactivé, paquet redemandé toutes les 30 s.

### 3. Paris joueur en direct — ✅ (sauf `teamGoalsFactor`, qui attend les effets de score)
- `fetchGameDetail` gagne `scoring[].playerId` et `situation`.
- `getGameBoxscore` → `live: { f, label, firstScorerId }` (`boxscoreLiveInfo`).
- `PlayerPropGrid` :
  - seuil atteint → 100 ;
  - sinon P(≥ k − déjà fait) sur le temps restant, en règles et en ML ;
  - premier buteur tranché au premier but ;
  - joueurs hors feuille masqués ;
  - feuille non rafraîchie depuis 90 s → pâle.

### 4. Face-à-face (donnée) — ✅
- `fetchHeadToHead(team, opp)` dans `nhl/teamSeasons.ts`. Pas encore utilisé.

### Vérifié
- 1071 tests serveur, `tsc` serveur et client, `npm run build`.
- Avant-match identique octet pour octet.
- Pas d'essai sur un vrai match : l'API NHL est bloquée ici.

---

## Phase 2, partie 2 (bloc B) — ⏳ bloquée par le réseau
Rien n'est activé sans gain mesuré au rejeu.

5. ⏳ **Données** : `fetch_data_v4.py` (spine + MoneyPuck) et nouveau `fetch_live_goals.py` (buts horodatés extraits des fichiers de tirs MoneyPuck → `ml/data/live_goals.csv`, ignoré par git).
6. ⏳ **Effets de score mesurés** :
   - `calibrate_live.py` estime un multiplicateur par état (écart × période, tranches fines en fin de 3e), par maximum de vraisemblance d'exposition. Cases rares rétrécies vers 1. Sortie : `prediction/liveEffects.json` ;
   - jeu de puissance : PP% et PK% réels des équipes ;
   - moteur `evolveLiveScore` (programmation dynamique, pas de 10 s) pour la grille, P1/P2 et `teamGoalsFactor` ;
   - `situationCode` vérifié sur un vrai match.
7. ⏳ **Rejeu** `server/scripts/replay-live.ts`, avec le vrai moteur :
   - moments : mise au jeu, fin P1, fin P2, 5 min restantes ;
   - saisons de test : 2023-24 et 2024-25 ;
   - Brier et log-loss, Phase 1 contre Phase 2 ;
   - rapport : `ml/models/live/live_report.md`.
8. ⏳ **Face-à-face mesurés** :
   - règles : ajustement des λ + facteur de victoire, avec poids estimé ;
   - ML : features `h2h_*` (`build_dataset.py`, `ml_service.py`, `featureEngineering.ts`), réentraînement avec et sans, comparé par `backtest_walkforward.py` ;
   - gardés seulement s'ils apportent un gain. Si le ML change : déploiement Python + Node.

Méthode complète aussi notée dans `STATUS.md` §3.5.

---

## Reprendre dans une nouvelle session
1. Vérifier le réseau : `curl -sI https://moneypuck.com/` et `curl -sI https://api-web.nhle.com/v1/schedule/now` doivent répondre (pas `000` ni un refus 403 du proxy).
2. `cd server && npm ci && npm test` ; `cd client && npm ci && npm run build` ; `pip install -r ml/python/requirements.txt`.
3. Lire ce fichier, `STATUS.md` §3.5 et `PROJECT_CONTEXT.md` (sessions du 2026-09-30 et du 2026-10-01).
4. Commencer par l'étape 5 (données), puis 6 → 7 : rien n'est branché avant le rejeu.
