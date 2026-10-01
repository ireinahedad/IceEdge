# LIVE_PREDICTIONS_PLAN.md — prédictions en direct : plan détaillé

> Plan détaillé derrière la tâche « Live predictions, phase 2 part 2 » de
> `STATUS.md` §3.5. **La liste des tâches reste dans `STATUS.md`** (règle du
> dépôt) ; ce fichier n'en garde que le détail et l'historique des décisions.
> Partie 2 faite le 2026-10-01 (session locale, réseau ouvert) : voir plus bas.


Légende : ✅ fait · 🔄 modifié en cours de route · ⏳ à faire (bloqué)

Branche : `claude/laughing-davinci-3ver59` → `master` (Pull Request ouverte le 2026-10-01).

| Commit | Contenu |
|---|---|
| `ee5c761` | Phase 1 — règles en direct (score actuel + temps restant) |
| `613e043` | Phase 2, partie 1 — ML en direct, paris joueur en direct, face-à-face (donnée) |
| `8ae3059` | Affichage : recalculé en direct = blanc opaque, avant-match = plus pâle + note |
| (2026-10-01, local) | Phase 2, partie 2 — effets de score mesurés, rejeu, face-à-face mesurés (non gardés) |

## Ce que tu dois faire, toi
1. ✅ ~~Ouvrir le réseau~~ — sans objet : la partie 2 a tourné sur ta machine (2026-10-01).
   ⚠️ Avast intercepte le HTTPS : Python, curl et Node ne reconnaissent pas son certificat.
   Pour relancer les scripts, exporter la racine « Avast Web/Mail Shield Root » en PEM et poser
   `REQUESTS_CA_BUNDLE` (Python) / `NODE_EXTRA_CA_CERTS` (Node), ou exclure ces domaines du
   bouclier web d'Avast.
2. ⏳ **Fusionner** `claude/laughing-davinci-3ver59` dans `master`. Railway (Node) et Vercel (site)
   redéploient seuls. **Pas de Python, pas de migration** : `liveEffects.json` part avec le code Node.
3. ⏳ **Vérifier pendant un vrai match** : les chiffres bougent toutes les 30 s (règles ET ML), une
   période finie affiche 100/0, et en fin de 3e avec un but d'écart, la puck line et les totaux
   montent (gardien retiré, filet désert) au lieu de rester figés.

## Tes demandes
1. ✅ Le ML se recalcule pendant le match.
2. ✅ Les chiffres tiennent compte de comment va la partie :
   - ✅ score et temps restant ;
   - ✅ effets de score mesurés (équipe menée, gardien retiré, filet désert, nul en fin de match) ;
   - ⏳ avantage numérique en cours : pas mesurable avec les fichiers MoneyPuck (voir plus bas).
3. ✅ Derniers matchs entre les deux équipes : mesurés, **aucun gain** → non utilisés (règle tenue).
4. 🔄 « Aucune valeur bidon » → règle d'affichage retenue : un chiffre recalculé en direct apparaît en
   **blanc opaque**, tout ce qui a été calculé avant le match apparaît **plus pâle**, avec une note
   en haut de la page. Aucune constante nouvelle sans mesure sur de vrais matchs : les effets
   viennent de 16 489 matchs, le rétrécissement est choisi par validation croisée.

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

## Phase 2, partie 2 (bloc B) — ✅ (2026-10-01)
Règle tenue : rien n'est activé sans gain mesuré au rejeu.

5. ✅ **Données**
   - `ml/python/fetch_live_goals.py` : fichiers de tirs MoneyPuck (`shots_{saison}.zip`, ~20 Mo,
     cache `ml/data/raw/shots/`) → `ml/data/live_goals.csv` (106 198 buts réglementaires : temps,
     score avant le but, filet désert, patineurs, buteur) et `ml/data/live_games.csv` (18 896 matchs,
     2010-11 → 2025-26). Contrôle : les buts de chaque match recollent au score réglementaire de
     `nhl_games_v4.csv`, sinon le match est écarté (~1,5 %, un but manquant chez MoneyPuck).
   - Le spine et MoneyPuck par match étaient déjà en local : `fetch_data_v4.py` pas relancé.
   - `ml/python/live_pregame.py` : chiffres d'avant-match HORS ÉCHANTILLON (modèle de score
     walk-forward, `fit_score_fold`) → `ml/data/live_pregame.csv` (16 682 matchs, 2012-13 → 2025-26) :
     λ domicile/visiteur, victoire, nul à 60 min — les entrées du chemin ML en direct.
6. ✅ **Effets de score mesurés**
   - `ml/python/calibrate_live.py` : maximum de vraisemblance d'exposition, cadence =
     λ × w(t) × m(écart −3…+3, tranche), tranches P1, P2, 40–50, 50–55, 55–57, 57–58, 58–59, 59–60.
     Rétrécissement vers 1 choisi par saison laissée de côté : a = 2. Entraîné sur 2012-13 → 2022-23.
     Sortie `server/src/services/prediction/liveEffects.json` (+ `leagueLambda` = 2,78), rapport
     `ml/models/live/calibrate_live_report.json`.
   - Ce que ça mesure (dernière minute) : équipe qui mène d'un but ×7,35 (filet désert), menée d'un
     but ×2,61 (attaquant de plus), nul ×0,64. Gain de log-vraisemblance aussi sur les 3 saisons de test.
   - Moteur `evolveLiveScore` (`prediction/finalScore.ts`) : programmation dynamique sur le score,
     pas de 10 s, 0–2 buts par équipe et par pas. Avec m ≡ 1, redonne la phase 1 (testé).
     `finalScoreGrid` l'utilise dès que `live.effects` est là ; `liveCalibration` passe par le
     même moteur (mémorisé par match) : à la mise au jeu, victoire et prolongation = avant-match.
   - Paris joueur : `boxscoreLiveInfo` renvoie `fTeam` (buts restants attendus de l'équipe / λ),
     utilisé pour buts, passes, points ; tirs, mises en échec, tirs bloqués, arrêts gardent `f`.
   - ✅ `situationCode` vérifié sur de vrais buts (2026-09-30) : gardien visiteur, patineurs
     visiteur, patineurs domicile, gardien domicile (`1451` = domicile à 5 contre 4).
   - ⏳ **Avantage numérique en cours : pas fait.** Les fichiers de tirs ne donnent pas le temps
     passé en avantage (il n'y a que les tirs), donc rien à mesurer. Il faudrait les pénalités du
     play-by-play NHL (`v1/gamecenter/{id}/play-by-play`, ~1 300 matchs par saison) ; la feuille
     de match donne déjà `situation.secondsRemaining`. Aucune constante d'ici là.
   - ⏳ Pas passés par le moteur (phase 1 inchangée) : cartes P1/P2 (Skellam), « les deux marquent »
     (binomiale négative). Les effets pèsent surtout en fin de 3e, où ces cartes sont déjà décidées.
7. ✅ **Rejeu** `server/scripts/replay-live.ts` (vrai moteur : `liveCtxFromDetail` sur une feuille
   simulée + `computeLiveModelGroups`, le calcul du paquet ML en direct) — 3 903 matchs, 2023-24,
   2024-25 et 2025-26 en plus ; 5 moments (mise au jeu, fin P1, fin P2, 5 et 2 min restantes) ;
   10 questions. Rapport `ml/models/live/live_report.md`.
   - **Log-loss cumulée −2,19 %** ; 23 cases significativement meilleures, 2 pires, sur 50.
   - À 2 min de la fin : puck line −27 %, total > 5.5 −21 %, totaux d'équipe −13 % ; à 5 min : −9 à −15 %.
   - Les 2 pires : totaux > 5.5 et > 6.5 **à la mise au jeu** (+0,13 % et +0,23 %). Cause : l'avant-
     match surestime déjà les totaux sur ces saisons (P(> 5.5) prédit 60 %, observé 56 %), et le
     moteur les relève d'~1 point. C'est un défaut de l'avant-match (voir ci-dessous), pas des effets.
   - → **Effets activés** (`LIVE_EFFECTS` dans `nhlPredictions.ts`). Le chemin des RÈGLES n'est pas
     rejoué (il faudrait les statistiques d'équipe de chaque date) ; il partage la grille et le calage.
8. ✅ **Face-à-face mesurés — non gardés.** `ml/python/measure_h2h.py` : 10 dernières rencontres
   (saison en cours + précédente, comme `fetchHeadToHead`), 4 features, walk-forward 2015-16 →
   2025-26, mêmes hyperparamètres avec et sans. Δ log-loss moneyline +0,00006 (pire), améliorée sur
   55 % des saisons ; déviance −0,00066 sur 64 % des saisons. Règle fixée avant lecture (≥ 70 % des
   saisons, moneyline ET déviance) → **rien de branché**, ni ML ni règles (pas de poids mesurable
   pour les règles sans leur historique). Rapport `ml/models/live/h2h_report.json`.

### Constat en passant — biais de l'avant-match
Le modèle de score walk-forward se trompe de niveau selon les saisons : buts réglementaires
observés / λ = 1,03 sur 2017-21, **0,96 sur 2022-25** (λ trop haut de ~4 %). Les totaux « over »
d'avant-match sont donc trop hauts ces dernières saisons. À traiter côté modèle d'avant-match
(recalage de niveau sur la saison en cours), pas dans le direct.

### Vérifié
- Serveur : 1078 tests (dont 4 du moteur, 3 de la phase 2), `tsc` serveur et client, `npm run build`.
- Chemin réel sur un match en cours (COL–LAK, 2026-09-30) : `fetchGameDetail` → `boxscoreLiveInfo`
  (`fTeam`) → `buildGameMarketsWithStatus`, tuiles `live`.
- Pas vu dans le navigateur (il faudrait la pile locale complète avec base de données).

---

## Reprendre dans une nouvelle session
1. Vérifier le réseau : `curl -sI https://moneypuck.com/` et `curl -sI https://api-web.nhle.com/v1/schedule/now` doivent répondre (pas `000` ni un refus 403 du proxy).
2. `cd server && npm ci && npm test` ; `cd client && npm ci && npm run build` ; `pip install -r ml/python/requirements.txt`.
3. Lire ce fichier, `STATUS.md` §3.5 et `PROJECT_CONTEXT.md` (sessions du 2026-09-30 et du 2026-10-01).
4. Pour refaire la mesure : `fetch_live_goals.py` → `live_pregame.py` → `calibrate_live.py`, puis
   `cd server && npx ts-node --transpile-only scripts/replay-live.ts` (~15 min pour 3 saisons).
   Garder les saisons de test au-delà de `--last-train` (le rejeu refuse sinon).
