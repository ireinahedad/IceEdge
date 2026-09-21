# PROJECT_CONTEXT.md

---

# CLAUDE_INSTRUCTIONS

When continuing this project:
- Read this file before generating any code.
- Never rewrite working code unless requested.
- Reuse existing architecture.
- Prefer modifying existing files over creating new ones.
- Explain major architectural changes before implementing them.
- If information is missing, ask instead of assuming.
- Keep code clean, modular, and production-ready.
- Verify that what you are implementing is secure
- At the end of each session, update PROJECT_CONTEXT.md.

Last updated: 2026-09-21

## Session 2026-09-21 — Page match : tableaux de paris + cohérence des règles

Chiffres des RÈGLES seulement ; le ML n'est pas touché (les variantes qu'il ne
sait pas chiffrer rendent « — », voir `mlUnsupportedVariant` dans `ml.routes.ts`).

1. **`MarketGroup.tables`** (serveur `nhlPredictions.ts` ↔ client `MktTable`) :
   un groupe peut se rendre en tableau (lignes = seuils, colonnes = côtés).
   Les cases référencent `options` par id ; `options` reste la liste plate lue
   par les facteurs, le ML et le coupon. Rendu : `MarketTableView` (PredictionSheet).
2. **Loi du score FINAL** (`prediction/finalScore.ts`) : Poisson + but de
   prolongation/fusillade (nul k–k → k+1–k selon `otShareHome`). Sert puck
   lines, totaux, buts par équipe, score exact, écart de victoire.
3. **Nouveaux tableaux** : puck line ±1.5/2.5/3.5 (2 équipes), total 2.5→7.5,
   buts par équipe 0.5→4.5, BTTS 1+/2+/3+, score exact (1-0 … 4-3 + « vainqueur
   5+ »). Cases d'un camp = P(victoire) × P(score | victoire) → somment à la
   victoire de Match Betting.
4. **Une carte par période** : « qui mène APRÈS la période » (buts cumulés, ce
   que règle `periodN_winner`) + égalité. P1/P2 partitionnent à 100 (pctScale =
   1 − nul) ; P3 = tuiles « in Reg » + « Goes to OT ». Buts de la 1re dans la
   carte P1. Avant : ~125 % par période.
5. **Corrections de règles** : écart de victoire (sommait ~120 % de la victoire),
   puck line (`v − 0.15` identique à toutes les lignes), BTTS (facteurs en
   Poisson), totaux (sans le but de prolongation), `invExact` pour over/under.
6. **Règlement** : `correct_score`, BTTS avec `line`, période `draw` + égalité
   = perdu (était `unknown` → coupon figé). `gameParlay` / `parlay` suivent.
7. **Joueurs** : passes 1+→4+ (de retour sur la page match), tirs bloqués et
   mises en échec 1+/3+/5+/7+, arrêts = seulement le gardien du match
   (feuille de match > saisie manuelle `GET /games/:id/starting-goalies` > plus utilisé).
8. **Page équipe** : ses tableaux puck line / totaux / BTTS / périodes sont
   remplacés par ceux du serveur (adversaire moyen `OPP` → adversaire réel du
   match choisi).

9. **Mode ML des grilles joueur, sans Python** (`prediction/playerRates.ts`,
   `GET /predictions/player-rates/game/:id` et `/team/:abbr`). `/predict/player`
   n'était qu'une Poisson de saison bornée à 5 % (Demidov = Danault sur 2+
   buts), appelée case par case (~120 requêtes par équipe). Maintenant : UNE
   requête par page (cache 5 min côté client, `publicCache` côté HTTP), une
   cadence par joueur et par statistique = saison rétrécie vers un a priori de
   poste (`PSEUDO_GAMES`) × ajustement adversaire (±15 %), binomiale négative à
   dispersion fixée à la main (`DISPERSION`). Tous les seuils en découlent côté
   client. `BetOpt.mlPreset` / `mlExternal` : la tuile et sa fiche n'appellent
   plus `/predict/ml`. Affichage « <3% » sous 3 % (`belowFloor`) ; plancher des
   règles de la grille ramené de 3 à 1. Premier buteur en ML = part des buts du
   match × P(au moins un but), au lieu de la requête « 1+ but ».
   Reste à faire : tuiles de la page JOUEUR (toujours par appel), requête unique
   par match pour les marchés d'équipe.

Vérifié en sandbox Linux : `tsc` serveur + client, `vite build`, vitest 38/38
fichiers (tests ajoutés dans `nhlPredictions.test.ts` et `settlement.service.test.ts`).
Le repli client `buildGameGroups` (avant réponse serveur) garde l'ancien format.

## Session 2026-08-09 — Coupons publics réservés aux abonnés Pro

Ajout d'une valeur Pro : consulter les paris des autres joueurs. **Pivot en cours
de route** — le plan initial (marketplace, abonnement payant entre utilisateurs,
Stripe Connect) a été abandonné : Stripe classe le « sports forecasting or odds
making » avec contrepartie monétaire dans ses commerces prohibés, et chaque compte
connecté hérite de la restriction. Le périmètre retenu, les invariants de vie
privée à ne pas casser et la procédure d'allumage font foi dans `DEPLOYMENT.md`
§7 (« Mise en service des coupons publics »).

1. **Résultats par jambe conservés** (`settlement.service.ts`) — `results[]` était
   calculé puis jeté ; seul l'`outcome` du ticket survivait. Fusionné dans `legs`
   (champ `result` par jambe) **dans le même UPDATE** que l'outcome : c'est le
   `WHERE outcome = 'pending'` qui porte l'idempotence, une écriture séparée en
   sortirait. Les coupons réglés avant ce lot n'ont pas de détail → affichés `—`,
   jamais « perdu ».
2. **`locks_at`** (migration **029**) — mise au jeu du match le plus tôt du
   coupon, résolue au serveur à la soumission (`slip.service.ts`, `fetchGameById`),
   jamais acceptée du client. Avant cette heure, un tiers voit qu'un coupon existe
   mais pas ses sélections. `NULL` = masqué tant que `pending` (défaut sûr : une
   panne de résolution doit rendre un coupon trop discret, pas le divulguer).
3. **Trois filtres distincts** dans `getPublicSlips` (`profile.service.ts`) :
   `show_slips` (qui), `PUBLIC_SLIPS_SINCE` (quand), `locks_at` (quoi). Aucun ne
   s'applique au propriétaire. **Découplé de `is_public`** — le lier ferait payer
   la discrétion d'un rang au classement. Redaction faite dans le service, jamais
   « floutée » côté client.
4. **`PUBLIC_SLIPS_SINCE`** — date de coupure en variable d'environnement, **échec
   fermé** : absente → aucun coupon visible + warn (même parti pris que
   `PRO_PROMO_CODES`). Seuls les coupons postérieurs sont exposés ; l'historique
   antérieur reste privé pour toujours (il a été saisi sous la promesse inverse).
5. **`GET /users/:userId/summary`** — forme sur 30 jours glissants + cumul, calculés
   sur les coupons **visibles** (pas `user_bets`, qui produirait « 64 % sur 128 »
   au-dessus d'une liste de 12). Plancher de 10 paris tranchés : en dessous,
   `hitRate` vaut `null` et le client ne peut pas peindre un chiffre insensé.
   Mur Pro partagé par `/slips` et `/summary` via `requireProForOthers`.
6. **Client** — `PlayerBetsPage` (`/player/:userId`, route protégée), coupons
   repliables, jambe fautive mise en évidence, `ApiError` qui conserve le statut
   pour distinguer 402 / 403 / 404. Entrées : classement et recherche via la
   modale existante de `FullLeaderBoard` (qui gagne « Voir tous ses paris »),
   chat via le **nom** de l'auteur (l'avatar sert déjà à répondre).
7. **Opt-out, pas opt-in** (migration **030**) — `show_slips` passe à
   `DEFAULT TRUE`. Le réglage n'est pas supprimé : forcer la publication sans
   porte de sortie n'est pas défendable (Loi 25). Déplacé dans une carte
   « Confidentialité » et formulé à la négative. Ligne de divulgation ajoutée sous
   le bouton de soumission du coupon — c'est elle qui rend le consentement
   éclairé, pas les CGU. `TermsPage` / `PrivacyPage` mises à jour (FR + EN).

**⚠️ État : livré mais INERTE.** Rien n'est visible tant que `PUBLIC_SLIPS_SINCE`
n'est pas renseignée. Procédure d'allumage complète en **§7 de `DEPLOYMENT.md`**
(bascule visée au début de la saison NHL ; retour arrière = retirer la variable).

**⚠️ À faire en local** : `npm run db:migrate:all` (029 + 030), puis
`npm run typecheck && npm test` (server) et `npm run build` (client). Le sandbox
ne peut ni compiler ni lancer vitest (rollup natif Windows) ; seule la syntaxe a
été validée via `ts.transpileModule`.

## Session 2026-07-22 — Blessures/scratches réels + absence pondérée

Le hook `stars_missing` n'était jamais rempli (Node passait `undefined`). Câblé la
vraie liste des absents du soir + nouvelle feature d'absence pondérée.

1. **Source = JSON daté manuel** (`server/src/services/scratches.ts` +
   `ml/data/scratches.json`, chemin `SCRATCHES_PATH`), miroir exact de
   `startingGoalies.ts` : `{ "YYYY-MM-DD"(Est): { ABBR: ["Nom MoneyPuck", …] } }`.
   Daily Faceoff non branché en auto (déjà jugé non fiable pour les gardiens :
   Cloudflare + build-id + ToS). Cache 30 s. Clé `_comment` ignorée.
2. **Câblage Node** (`featureEngineering.ts`) : `GameFeatureOpts` gagne
   `homeScratches`/`awayScratches` ; `buildGameFeatures` envoie
   `home_scratches`/`away_scratches` (override appelant < fichier < []).
3. **Inférence par noms** (`ml_service.py`) : `GameFeatures` accepte
   `home/away_scratches: List[str]`. Si fournis → `star_power` retire les BONS
   joueurs (par nom, plus l'hypothèse « les meilleurs manquent ») et
   `stars_missing` est dérivé des noms. Rétro-compatible (legacy si liste vide).
   **Marche avec le modèle ACTUEL sans réentraîner.**
4. **Nouvelle feature `stars_out_weight`** (perf individuelle × rôle) — pool
   **top-6 attaquants + top-4 défenseurs** (les D n'entraient jamais dans le
   top-5 ppg → une blessure de D pesait 0 avant). Poids = `max(ppg, 0.15)` ×
   prime position (D ×1.6) × palier de trio/paire (rang ppg intra-groupe).
   Calculée à l'identique dans `build_dataset.py` (colonne + `keys[].w` stockés
   dans `inference_state`, source unique) et consommée telle quelle par
   `ml_service.py`. Diff `stars_out_weight_diff`. Trio réel absent de
   l'historique MoneyPuck → approché par le rang ppg intra-groupe.
5. Constantes de pondération en tête de `build_star_features` (tunables :
   `STARS_D_PREMIUM`, `STARS_F_TIER`, `STARS_D_TIER`, `STARS_PPG_FLOOR`).

**⚠️ À faire en local** (sandbox : réseau bloqué + mount tronqué) :
`cd ml/python && python build_dataset.py && python train.py && python backtest.py`
(train.py auto-détecte les 3 nouvelles colonnes ; `position` déjà dans
`SKATER_KEEP`). Puis `npm run build` (server) pour valider le TS. Alimenter
`scratches.json` chaque soir (noms = orthographe MoneyPuck).

## Session 2026-07-21 — ML v4 (MoneyPuck + gardiens + stars + cotes)

Constat v3 : skill_score négatif, l'ELO seul battait le modèle (53.9% vs 53.1%).
Refonte complète du pipeline data/features :

1. **`fetch_data_v4.py`** (nouveau) : 3 sources — spine des matchs 2008→ via
   `api.nhle.com/stats/rest/en/game` (1 requête, scores officiels SO inclus),
   stats avancées MoneyPuck (all_teams.csv + zips gardiens/patineurs par match),
   cotes historiques sportsbookreviewsonline (xlsx, ML open/close + totaux).
   Fusionne aussi `data/odds_live_log.csv` si présent (log The Odds API).
2. **`build_dataset.py`** (nouveau) : features PRÉ-MATCH sans leakage (EWMA
   demi-vie 6/20 matchs) — xGF/xGA par 60, xGF%, Corsi%, high-danger, finishing,
   PP/PK par xG, gardien partant (save%, GSAx/60 EWMA sur ses départs), star
   power top-3 + stars absentes, repos/b2b/3-en-4, ELO v3, probas implicites
   dévigées open/close. Sorties : `nhl_games_v4.csv`, `inference_state.json`,
   `elo_ratings.json`.
3. **`train.py`** (réécrit) : features auto-détectées, recherche aléatoire
   d'hyperparamètres sur val (40 essais), NaN natif XGBoost (cotes manquantes ok),
   calibration Platt, blend logistique modèle ⊕ marché ajusté sur val,
   baselines honnêtes (domicile/constant/ELO/marché). Fallback v3 si pas de v4.
4. **`backtest.py`** (réécrit) : ROI value betting sur test set (flat + ¼ Kelly,
   seuils d'edge 1–8%), log-loss vs marché → `backtest_report.json`.
5. **`ml_service.py`** : charge `inference_state.json` + blend ; `GameFeatures`
   accepte `home_odds_decimal`/`away_odds_decimal`/`total_line_market`,
   `home_goalie`/`away_goalie`, `home/away_stars_missing`. Features v4 résolues
   par abréviation d'équipe ; DMatrix missing=NaN ; version `xgb-nhl-v4.0`.
   Les ajouts déploiement (readiness probe `_startup_complete`) sont préservés.
   Rétro-compatible : le serveur Node fonctionne sans changement.

**⚠️ À faire sur la machine locale** (réseau sandbox bloqué) :
`cd ml/python && pip install -r requirements.txt && python fetch_data_v4.py
&& python build_dataset.py && python train.py && python backtest.py`.
Chaîne complète validée sur données synthétiques (smoke test), y compris
l'inférence (blend, gardien nommé, équipe inconnue, totaux).

**Résultats v4 (données réelles)** : accuracy 0.586 (ELO 0.577, domicile 0.540),
log-loss 0.666 (ELO 0.670), skill +0.047 (v3 était −0.007). Backtest walk-forward
sur 9 saisons avec cotes (2014-15→2022-23, 9823 matchs) : log-loss modèle 0.666
≈ marché 0.666 ; ROI flat value betting positif à edge modéré (+1.34 % @ edge>2 %
sur 4578 paris, +2.53 % @ 5 %), négatif au-delà de 6 % (bruit / info manquée).

## Session 2026-07-21 (2) — Câblage cotes live + signal value + logger

1. **Logger de cotes** (`server/src/services/oddsLogger.service.ts`, nouveau) :
   job serveur qui capture les cotes NHL du jour (The Odds API via `fetchRawOdds`,
   ajoutée à `oddsClient.ts`). Activé par `ODDS_LOG_ENABLED=true`, passe toutes
   les 6 h, dédup par date+équipes, dates en Est.
   *Depuis 2026-08-02 (audit, ligne K) : écriture dans la table `odds_log`
   (migration 027) et non plus dans un CSV — le disque Railway est éphémère.
   Export vers `ml/data/odds_live_log.csv` par `npm run odds:export`.*
   Câblé dans `server.ts` (`startOddsLogger()`). → débloque le backtest 2023+.
2. **Cotes live → /predict/game** (`featureEngineering.ts`) : `buildGameFeatures`
   récupère `fetchOddsImplied`/`fetchTotalsOdds` et remplit `home_odds_decimal`/
   `away_odds_decimal`/`total_line_market` → le service Python active le blend
   modèle⊕marché. Option `GameFeatureOpts { includeOdds, homeGoalie, awayGoalie,
   homeStarsMissing, awayStarsMissing }` (includeOdds défaut true).
3. **Signal value = edge dé-viggé** (`valueBetScan.service.ts`) : le filtre passe
   de « EV brut » à « edge = proba_modèle − proba_marché_dévig » dans la bande
   [MIN_EDGE=0.02, MAX_EDGE=0.06] + EV≥0. C'est le critère dont le ROI est validé
   par le backtest. Env : `VALUE_BET_MIN_EDGE`, `VALUE_BET_MAX_EDGE`. Notif enrichie
   (edge% + EV%). Classement des candidats par edge.

**⚠️ Vérifier `npm run build` (server) en local** — tsc est inexploitable dans le
sandbox distant (bloque). Syntaxe validée via ts.transpileModule sur les 5 fichiers.

4. **Gardien partant — override manuel** (`server/src/services/startingGoalies.ts`,
   nouveau) : Daily Faceoff jugé non fiable (Cloudflare + build-id volatil + ToS).
   Route auto propre = feed pré-match de l'API NHL (`gamecenter/{id}/landing` /
   `right-rail`) mais champ non vérifiable depuis le sandbox → à brancher plus tard.
   En attendant : fichier `ml/data/starting_goalies.json` daté (Est) → { ABBR: nom }
   pour les EXCEPTIONS seulement. Lu par `buildGameFeatures` (override < opts <
   fichier < défaut = moyenne pondérée). Nom = orthographe MoneyPuck. Cache 30 s.

**TODO suivants** : laisser tourner le logger quelques semaines puis relancer
`fetch_data_v4.py --only odds` (il fusionne odds_live_log.csv) + rebuild + retrain
pour backtester sur 2023-2026 ; vérifier le champ gardien partant du feed NHL
pré-match et le brancher en auto (fallback sur starting_goalies.json) ;
réentraîner chaque mois.

## Session 2026-07-15 — Pondération complète par type de pari

1. **Facteurs sur mesure pour chaque famille de pari** (`server/src/services/factorModel.ts`) : plus aucun pari sans pondération. Nouvelles familles (factorGroup) avec facteurs dédiés :
   - `period_draw` — nul de période : modèle Skellam 50, faible rythme de buts 30, équilibre 20
   - `player_goals` / `player_first_goal` / `player_assists` / `player_points` / `player_shots` / `player_hits` / `player_blocks` / `player_pp` / `player_pim` — décompositions réelles (taux Poisson vs ligne, volume de tirs, finition tir%, production PP, rôle physique/défensif par position) via `PlayerFactorCtx` passé par `buildSkaterMarkets`
   - `goalie_saves` / `goalie_ga` / `goalie_win` / `goalie_shutout` — via `GoalieFactorCtx` (stats réelles)
   - `team_totals` / `team_shutout` / `team_special` — extras de la vue équipe
2. **Stats gardien réelles** : `fetchPlayerById` (nhlApiClient) retourne désormais `savePct`, `goalsAgainstAvg`, `wins`, `shutouts`, `shotsAgainst` (endpoint landing) ; `buildGoalieMarkets` les utilise (fallback = défauts de position).
3. **Extras équipe** : `computeGameMarkets` a un flag `teamExtras` (true seulement depuis `buildTeamMarkets`) → groupe `teamx` : `tg-o25`/`tg-u25` (buts équipe O/U 2.5), `cs-for` (blanchissage), `ppgoal` (but en PP), `pk-perfect` (tue toutes ses pénalités).
4. **Mapping ids client → serveur** (`PredictionPage.tsx`) — résout l'item ouvert connu : vue équipe `TEAM_ID_MAP` (t-win→ml-home, t-p1→p1-home, t-w1→wm-1, t-cs→cs-for, etc.) ; vue joueur/gardien `resolve()` (p-anytime→g-anytime, g-win→gr-win…) avec choix de la ligne serveur la plus proche (`nearest`) et **inversion des valeurs (1−v) pour les paris under**. Tous les paris des vues équipe/joueur affichent maintenant la Pondération.
5. **Redistribution au décochage** (`RuleFactorEditor.tsx`) : décocher un facteur redistribue son poids au prorata entre les facteurs restants ; le recocher reprend son poids par défaut au prorata (total inchangé, arrondis compensés sur le dernier).
6. **Lacune de données restante** : hits/blocs/PIM par joueur côté serveur = moyennes de position (`POSITION_DEFAULTS`) car absents de l'endpoint landing. Les vraies valeurs existent dans `nhl_player_stats` (seed) — brancher `fetchPlayerById`/`buildSkaterMarkets` dessus serait l'étape suivante.
7. ⚠️ Vérifier avec `npm run build` (server + client) sur la machine locale — le sandbox de build distant tronque les fichiers (quirk connu).

## Session 2026-07-11 (3) — Branding ArakIce, Pro, navigation équipe

1. **Marque ArakIce** : textes visibles restants passés de « IceEdge/ICEEDGE » à « ArakIce » (`index.html` `<title>` + apple title, `LoginPage`, `HowItWorksSheet`, `shareImage`, `BetBuilderPage`). Favicon + apple-touch-icon + icône du manifeste pointent maintenant sur `public/arakice-logo.jpg` (l'onglet navigateur montrait encore l'ancien nom/logo). NB : le composant `IceedgeLogo` (nom de fichier inchangé) rendait déjà la marque ArakIce.
2. **Page de retour Pro** : nouvelle route `/pro/success` (`ProSuccessPage`) « Bienvenue dans ArakIce Pro » + bouton retour accueil. `ProPage` y redirige après activation (upgrade dev / trial / promo réussis).
3. **Abonnement dans les Paramètres** : carte « Abonnement » dans `ProfilePage` → `SettingsTab`. Free → bouton « Passer à ArakIce Pro » (vers `/pro`). Pro → statut (renouvellement / fin) + bouton « Annuler l'abonnement » (`apiCancelSubscription` + `refresh` du contexte).
4. **Navigation équipe depuis un match** : dans la prédiction d'un match (`GamePrediction`), les deux équipes (logo + nom) sont cliquables → `/stats/prediction/team/:abbr`.

## Session 2026-07-11 (2) — Refonte UI du chat (Ligue)

1. **Disposition** : onglets Chat / Podium sur toutes tailles (desktop inclus), avec **Chat en premier et par défaut** (`LeaguePage`, `LeagueHeader`).
2. **Liste des salons** (`RoomList`) : plus de 2 boutons Mes salons/Découvrir — une seule page avec deux sections repliables **« Public »** (tous les salons publics) et **« Privé »** (salons privés dont je suis membre). Barre de recherche **sans bouton d'effacement**. Le lookup par code est conservé.
3. **Couleur de salon** : le créateur choisit une couleur (palette de pastilles) dans `CreateRoomModal` → colonne `color` (`chat_rooms`), migration `016_chat_room_color.sql`, validée (`#RGB`/`#RRGGBB`) côté serveur, propagée dans toutes les requêtes/`viewRoom`. Utilisée comme fond de l'icône du salon. **⚠️ `npm run db:migrate:all` requis.**
4. **Suppression de message** : un utilisateur peut supprimer **ses propres** messages. `chatService.deleteMessage` (403 si pas l'auteur), `DELETE /api/chat/rooms/:roomId/messages/:messageId`, event socket `message_deleted` (retrait temps réel via `useChatSocket`), bouton 🗑️ sur ses bulles.
5. **Effet « icy »** : retiré des surfaces de chat (nouvelle classe plate `.chat-tile`) ; le frost glossy `.icy-tile` est **réservé aux salons épinglés**.

## Session 2026-07-11 — Persistance de session

1. **« Rester connecté » (Remember me)** : nouvelle colonne `remember` sur `refresh_tokens` (migration `015_refresh_remember.sql` + `schema.sql`). Le refresh token dure **7 j** par défaut, **30 j** si l'utilisateur coche « Rester connecté » à la connexion (TTL surchargeables via `REFRESH_TOKEN_TTL` / `REFRESH_TOKEN_TTL_REMEMBER`). Le flag est conservé lors de la rotation du token ; la connexion Google est persistante par défaut. Le `maxAge` du cookie `ice_refresh` suit désormais le TTL réel du token. Câblage : `AuthTokens.refresh_expires_in`, `LoginBody.remember` → `authService.apiLogin(email, pwd, remember)` → `AuthContext.login` → case à cocher (cochée par défaut) dans `LoginPage`. **⚠️ `npm run db:migrate:all` requis dans server/.**
2. **« Se déconnecter de tous les appareils »** : `AuthService.logoutAll(userId)` révoque tous les refresh tokens de l'utilisateur ; endpoint `POST /auth/logout-all` (authentifié). Client : `apiLogoutAll` + `AuthContext.logoutAll` + bouton dans l'onglet **Paramètres** du profil (carte « Sécurité », `ProfilePage.tsx` → `SettingsTab`), avec confirmation, puis redirection vers `/login`.

## Session 2026-07-04 — P1 terminés

1. **Règlement auto des slips** (`settlement.service.ts`) : job événementiel — toutes les 2 min, SQL léger sur les gameIds des slips pending, poll du statut de CES matchs seulement, règlement dès qu'un match passe FINAL. Fallback complet toutes les 60 min + passe de rattrapage 30 s après boot. Aucune requête API quand rien n'est en attente.
2. **Refresh tokens → cookie httpOnly** : cookie `ice_refresh` (httpOnly, sameSite=lax, path=/api/auth, 7 j, secure en prod). Rotation à chaque refresh (déjà en DB). Le refresh token ne transite plus ni dans le JSON, ni dans localStorage, ni dans l'URL du callback Google. Ajouts : `cookie-parser` (package.json), CORS `credentials:true`, client en `credentials:'include'` (authService, AuthContext, AuthCallback). **⚠️ `npm install` requis dans server/.**
3. **ML v3** : features ELO (base 1500, K=6, avantage glace 50, régression 30 % inter-saisons, multiplicateur marge) calculées dans `train.py` sans leakage + `elo_ratings.json` pour l'inférence ; split temporel 3 voies (train/val/test) — early stopping et calibration de Platt sur val, test vierge ; baselines honnêtes dans `training_report.json`. `ml_service.py` charge ELO + calibration, `featureEngineering.ts` envoie `home_team`/`away_team`. **⚠️ Relancer `fetch_data.py` (CSV local incomplet : 726 matchs) puis `train.py`.**
4. Fixes : `seed.ts` (6701 octets NUL supprimés → tsc OK), `main.ts` exclu du tsconfig (vestige NestJS, import inexistant), cast `openAiRes` dans `llm.routes.ts`. `tsc --noEmit` passe.

---

# Project Overview

## Goal

**ICEEDGE** — Application mobile-first de prédictions sportives NHL.
(Le tennis a été retiré du produit le 2026-08-24 : pages, API et marchés supprimés.)
Permet aux utilisateurs de consulter des prédictions basées sur des règles statistiques et un modèle ML (XGBoost), de construire des slips de paris, de rejoindre des ligues avec chat en temps réel, et de suivre leur performance.

## Tech Stack

- **Frontend:** React 18 + Vite + TypeScript + Tailwind CSS (mobile-first, `max-w-[430px]`)
- **Backend:** Node.js + Express + TypeScript (`ts-node-dev`)
- **Database:** PostgreSQL (`IceedgeDB` sur `localhost:5432`)
- **Authentication:** JWT (localStorage) + Google OAuth
- **Real-time:** Socket.io (WebSocket pour le chat)
- **ML Service:** Python 3.14 + FastAPI + XGBoost (port 8000, processus séparé)
- **API externe:** NHL Stats API (`api-web.nhle.com/v1`), The Odds API (Bet365)
- **Hosting:** Local dev — pas encore déployé

---

# Architecture

## Folder Structure

```
ICEEDGE/
├── client/                        # React frontend (Vite)
│   ├── src/app/
│   │   ├── App.tsx                # Root: providers + AppShell
│   │   ├── routes.tsx             # React Router (11 routes)
│   │   ├── context/
│   │   │   ├── AuthContext.tsx    # JWT auth state
│   │   │   ├── BetContext.tsx     # Legs + parlay probability
│   │   │   └── SportContext.tsx   # thème (mono-sport depuis le retrait du tennis)
│   │   ├── components/
│   │   │   ├── HockeyLanding.tsx
│   │   │   ├── StatsPage.tsx
│   │   │   ├── PlayersTab.tsx
│   │   │   ├── PredictionPage.tsx
│   │   │   ├── BetBuilderPage.tsx
│   │   │   ├── MarketSelectorSheet.tsx
│   │   │   ├── NHLPredictionsPage.tsx
│   │   │   ├── MLPredictionCard.tsx   # ← composant ML réutilisable
│   │   │   ├── LoginPage.tsx
│   │   │   ├── AuthCallback.tsx
│   │   │   ├── BottomNav.tsx
│   │   │   ├── league/
│   │   │   │   ├── LeaguePage.tsx
│   │   │   │   └── chat/ChatTab.tsx
│   │   │   └── profile/
│   │   │       ├── ProfilePage.tsx
│   │   │       └── ProfileComponents.tsx
│   │   ├── hooks/
│   │   │   └── useChatSocket.ts   # Socket.io client hook
│   │   ├── services/
│   │   │   ├── nhlApiService.ts
│   │   │   ├── predictionApiService.ts
│   │   │   ├── slipApiService.ts
│   │   │   ├── oddsApiService.ts
│   │   │   ├── authService.ts
│   │   │   └── bookmakers.ts        # Liens affiliés Bet365 / Stake
│   │   └── data/
│   │       ├── betMarkets.ts      # Définitions des 40+ marchés
│   │       └── teamEmoji.ts
│   └── .env                       # Variables Vite
├── server/                        # Express backend
│   └── src/
│       ├── server.ts              # HTTP + WebSocket entry
│       ├── app.ts                 # Express routes mounting
│       ├── socket.ts              # Socket.io singleton
│       ├── routes/
│       │   ├── auth.routes.ts
│       │   ├── nhl.route.ts
│       │   ├── ml.routes.ts       # /api/predict/* (règles + proxy ML)
│       │   ├── chat.routes.ts
│       │   ├── slip.routes.ts
│       │   ├── profile.routes.ts
│       │   └── odds.route.ts
│       ├── services/
│       │   ├── predictionEngine.ts    # Log5, Poisson, futures
│       │   ├── featureEngineering.ts  # NHL API → vecteurs de features
│       │   ├── mlApiClient.ts         # HTTP bridge → Python :8000
│       │   ├── nhlApiClient.ts        # NHL public API client
│       │   └── ...
│       └── db/
│           ├── schema.sql
│           └── connection.ts
└── ml/                            # Service Python ML
    ├── python/
    │   ├── ml_service.py          # FastAPI :8000 (règles + XGBoost si .json dispo)
    │   ├── fetch_data.py          # Collecte NHL API historique → data/nhl_games.csv
    │   ├── train.py               # Pipeline XGBoost → models/*.json
    │   └── requirements.txt
    ├── data/
    │   └── nhl_games.csv          # ~3600 matchs (généré par fetch_data.py)
    └── models/
        ├── game_model.json        # XGBoost moneyline (si entraîné)
        ├── score_model.json       # Poisson empilé — price TOUS les marchés dérivés
        └── training_report.json
```

## Important Files

| Fichier | Rôle |
|---------|------|
| `client/src/app/components/MLPredictionCard.tsx` | Composant ML réutilisable + `MLSection` auto-fetch |
| `client/src/app/hooks/useChatSocket.ts` | Hook Socket.io chat temps réel |
| `server/src/services/predictionEngine.ts` | Math règle-based (Log5, Poisson) |
| `server/src/services/featureEngineering.ts` | Convertit stats NHL en vecteurs pour Python |
| `server/src/services/mlApiClient.ts` | Proxy HTTP Node.js → Python :8000 |
| `server/src/routes/ml.routes.ts` | `/api/predict/*` — dispatch règles + ML |
| `server/src/socket.ts` | Socket.io singleton + gestion des rooms |
| `ml/python/ml_service.py` | FastAPI ML — charge XGBoost si .json dispo, sinon fallback LR |
| `ml/python/fetch_data.py` | Collecte 3 saisons de matchs NHL via `api-web.nhle.com` |
| `ml/python/train.py` | Entraîne XGBoost (sans scikit-learn) — Python 3.14 compatible |

---

# Coding Standards

- **Naming:** PascalCase composants, camelCase variables/functions, kebab-case fichiers de routes
- **Composants:** Functional components + hooks uniquement. Pas de classes.
- **Style:** Tailwind uniquement. Classes inline. Pas de CSS séparé.
- **Mobile-first:** Tous les layouts dans `max-w-[430px]`. Pas de breakpoints desktop.
- **Couleurs:** Background `#0a1014`, cards `#111a1f`, accent dynamique via `SportContext`
- **State:** React Context pour état global (Auth, Bet, Sport). `useState` local pour UI.
- **API calls:** Services dédiés dans `client/src/app/services/`. Jamais de `fetch` direct dans les composants sauf `MLSection`.
- **Erreurs:** Fallback silencieux côté frontend (ML down → `null`, API down → mock data)
- **Backend routes:** `async/await` + try/catch + `res.status(xxx).json()`
- **TypeScript:** Strict. Interfaces définies pour toutes les shapes d'API.

---

# Features

## ✅ Complétées

- **App shell** — React Router 11 routes, SportContext, AuthContext, BetContext, BottomNav
- **Auth** — Email/password + Google OAuth, access token (15 min) en localStorage + refresh token en cookie httpOnly, `returnTo` param, « Rester connecté » (30 j), « Se déconnecter de tous les appareils »
- **Home** — HockeyLanding avec matchs en direct et odds Bet365
- **Stats Hockey** — By Team, By Game, By Player, By Form (LastNGames)
- **Prediction Page** — 5 types: team, game, player, ngames, future
- **Bet Builder** — Legs, parlay gauge, odds labels américains, confirmation clear, auth gate
- **Slip resolve** — PATCH /api/slips/:id/resolve → XP badge
- **League/Chat** — Rooms PostgreSQL + Socket.io temps réel + compteur online
- **NHLPredictionsPage** — 40+ marchés bet365, game pills horizontaux (pas de form vide)
- **Prediction Backend** — Log5, Poisson, futures règle-based, tous les marchés
- **ML Pipeline** — FastAPI Python, featureEngineering TS, proxy Node.js, `MLSection` UI
- **MLPredictionCard** — Violet card avec gauge, feature importances, comparaison règles vs ML
- **ML sur toutes les pages** — PredictionPage (6 handlers) + NHLPredictionsPage (BetPredictionCard)
- **XGBoost training** — fetch_data.py (NHL API historique) + train.py (sans scikit-learn)

## 🚧 En cours

### ML Frontend Connection
Problème actuel : `MLSection` affiche une erreur rouge "ML indisponible" quand le service Python retourne une erreur.

Étapes pour déboguer :
1. S'assurer que Python service tourne : `cd ml/python && python ml_service.py`
2. Tester : `curl -X POST http://localhost:8000/health`
3. Vérifier `F12 → Console` dans le navigateur pour le message exact de `[MLSection] fetch failed:`
4. Vérifier que le Node.js (`npm run dev` dans `server/`) tourne aussi

Erreurs déjà corrigées :
- `pk_pct` validé à 0 par Pydantic → `|| 80` dans featureEngineering.ts + `ge=0` dans Pydantic
- `KeyError: 'moneyline'` dans predict_team → `.get(f.prop_type, f.prop_type)`

## 📋 Todo

> **Cette liste a été vidée le 2026-08-10 : elle était entièrement livrée ou
> morte.** Share et la route 404 existent, `/api/opportunities` a été supprimé du
> backend, les deux pages de prédiction tennis étaient orphelines (le tennis
> a depuis été retiré entièrement, le 2026-08-24), et la Section 8 est couverte
> par les audits.
>
> **Le seul inventaire à jour de ce qui reste est `RESTE_A_FAIRE.md`**, à la
> racine. Ne pas rouvrir de todo ici : deux listes divergent toujours.

---

# API

## Base URL
`http://localhost:3001/api`

## Routes

### Auth
| Route | Description |
|-------|-------------|
| `POST /auth/login` | Email + password (+ `remember`) → access token + cookie refresh |
| `POST /auth/register` | Créer un compte (vérif. email) |
| `POST /auth/refresh` | Rotation via cookie httpOnly `ice_refresh` |
| `POST /auth/logout` | Révoque le refresh token courant |
| `POST /auth/logout-all` | Révoque tous les refresh tokens de l'utilisateur (auth requise) |
| `GET /auth/google` | Redirect OAuth Google |
| `GET /auth/google/callback` | Callback OAuth → access token + cookie refresh |

### NHL
| Route | Description |
|-------|-------------|
| `GET /nhl/games` | Matchs du jour |
| `GET /nhl/games/live` | Matchs en direct |
| `GET /nhl/teams` | 32 équipes + standings |
| `GET /nhl/teams/:abbr/stats` | Stats d'une équipe |
| `GET /nhl/teams/:abbr/roster` | Roster complet |
| `GET /nhl/players` | Top 50 joueurs |
| `GET /nhl/players/:id` | Stats d'un joueur |

### Predictions
| Route | Description |
|-------|-------------|
| `POST /predict/single` | Probabilité règle-based pour un marché |
| `POST /predict/parlay` | Combinaison de legs |
| `POST /predict/factors` | Facteurs explicatifs |
| `POST /predict/player-prop` | Prop joueur saison |
| `POST /predict/futures` | Futures équipe |
| `POST /predict/ml` | **Proxy → Python :8000** (XGBoost ou fallback LR) |

### Chat / Social
| Route | Description |
|-------|-------------|
| `GET /chat/rooms` | Salons publics + mes salons privés |
| `POST /chat/rooms` | Créer un salon (nom, icône, description, isPrivate, **color**) |
| `GET /chat/rooms/:id/messages` | Historique messages |
| `POST /chat/rooms/:id/messages` | Envoyer + emit Socket.io `new_message` |
| `DELETE /chat/rooms/:id/messages/:msgId` | Supprimer **son** message + emit `message_deleted` |
| `POST /chat/rooms/:id/join` · `/join` (code) · `/leave` · `/pin` | Adhésion / épinglage |
| `GET /users/leaderboard` | Classement XP |

### Slips
| Route | Description |
|-------|-------------|
| `POST /slips` | Soumettre un slip (JWT requis) |
| `GET /slips` | Historique user |
| `PATCH /slips/:id/resolve` | Marquer win/loss + XP |

## Python ML Service (port 8000)
| Route | Description |
|-------|-------------|
| `POST /predict/game` | Moneyline, puck-line, totaux |
| `POST /predict/player` | Props joueur |
| `POST /predict/team` | Futures équipe |
| `GET /health` | Status + modèles chargés |

---

# Database

`postgresql://postgres:<DB_PASSWORD>@localhost:5432/IceedgeDB`

> ⚠️ Never commit real credentials to this file. Use a local `server/.env` (git-ignored). See `SECRET_ROTATION.md`.

## Tables

```sql
users              -- id, email, password_hash, google_id, created_at
refresh_tokens     -- id, user_id, token, expires_at, revoked, remember, created_at
user_profiles      -- user_id, display_name, avatar_url, xp, tier, streak
user_badges        -- user_id, badge_type, earned_at
user_bets          -- id, user_id, market_type, legs (JSON), probability, outcome, xp_earned
chat_rooms         -- id, name, icon, description, color, is_private, join_code, created_by, member_count
chat_messages      -- id, room_id, user_id, username, display_name, avatar, tier, text, tag, reply_to_*, sent_at
chat_room_members  -- room_id, user_id, role (admin|member), pinned, joined_at
chat_reactions     -- id, message_id, user_id, emoji
nhl_teams          -- id, abbreviation, name, conference, division, ...
nhl_team_stats     -- team_id, season, wins, losses, goals_for, goals_against, ...
nhl_games          -- id, home_team_id, away_team_id, date, status, score_home, score_away
nhl_players        -- id, team_id, name, position, number
nhl_player_stats   -- player_id, season, goals, assists, points, shots, ...
nhl_odds           -- game_id, market, home_odds, away_odds, bookmaker
```

---

# Environment Variables

## `client/.env`
```
VITE_NHL_API_URL=http://localhost:3001/api/nhl
VITE_PROFILE_API_URL=http://localhost:3001/api
VITE_PREDICTION_API_URL=http://localhost:3001/api
VITE_SOCKET_URL=http://localhost:3001
VITE_ODDS_API_KEY=<the-odds-api-key>
VITE_BET365_AFFILIATE_CODE=365_XXXXXXX    # À remplacer par le vrai code
```

## `server/.env` (à créer si absent)
```
DATABASE_URL=postgresql://postgres:<DB_PASSWORD>@localhost:5432/IceedgeDB
JWT_SECRET=<secret>
JWT_REFRESH_SECRET=<secret>
GOOGLE_CLIENT_ID=<id>
GOOGLE_CLIENT_SECRET=<secret>
GOOGLE_CALLBACK_URL=http://localhost:3001/api/auth/google/callback
CORS_ORIGIN=http://localhost:5173
ML_SERVICE_URL=http://localhost:8000
```

---

# Décisions architecturales

- **Access token (15 min) en localStorage + refresh token en cookie httpOnly** (`ice_refresh`, path `/api/auth`, rotation à chaque refresh) — le refresh token ne transite jamais par JS/localStorage/URL (XSS-safe). Durée 7 j, ou 30 j avec « Rester connecté »
- **Socket.io** pour le chat — évite le polling, messages instantanés
- **Python séparé pour le ML** (FastAPI :8000) — découplage, permet de déployer le ML indépendamment
- **Fallback systématique** — si API/ML down, le frontend ne casse pas (mock data, null components)
- **XGBoost natif** (format `.json`) sans scikit-learn — compatibilité Python 3.14
- **Split temporel** pour le train/test (par date) — évite le data leakage sur données sportives
- **`??` vs `||`** dans featureEngineering — utiliser `||` pour les champs numériques qui peuvent être `0` (ex: pkPct)
- **`ge=0`** dans les Pydantic models — ne pas contraindre des valeurs qui peuvent être 0 côté NHL API

---

# Known Bugs

- `MLSection` retourne `null` silencieusement si Python service down → maintenant montre un bandeau rouge avec le message d'erreur exact
- `pk_pct = 0` depuis NHL API déclenchait une erreur 422 Pydantic → corrigé dans featureEngineering.ts et ml_service.py
- `KeyError: 'moneyline'` dans `predict_team` quand `prop_type` n'est pas cup/conf/playoff → corrigé avec `.get()`
- `NHLPredictionsPage` montrait une page vide si aucun match sélectionné → remplacé le dropdown par des pills horizontaux avec auto-select

---

# Démarrage du projet

```bash
# 1. Frontend
cd ICEEDGE/client
npm run dev               # → http://localhost:5173

# 2. Backend Node.js
cd ICEEDGE/server
npm run dev               # → http://localhost:3001

# 3. Service ML Python
cd ICEEDGE/ml/python
python ml_service.py      # → http://localhost:8000

# 4. (Optionnel) Entraîner le modèle
python fetch_data.py --seasons 3   # ~8 min
python train.py                    # ~30 sec
# Redémarrer ml_service.py ensuite

# 5. Base de données
cd ICEEDGE/server
npm run db:migrate        # Crée les tables
npm run seed              # (optionnel) données de test
```

---

# Recent Changes

## 2026-07-15
- Pondération sur mesure pour chaque type de pari (game/team/player/goalie) — voir Session 2026-07-15
- Mapping ids client → serveur dans `PredictionPage.tsx` (vues équipe + joueur)
- Stats gardien réelles (save%, GAA, SO, wins) dans `fetchPlayerById`
- Redistribution proportionnelle des poids au décochage d'un facteur (`RuleFactorEditor`)

## 2026-07-11
- Ajouté « Rester connecté » (refresh token 30 j) : migration `015_refresh_remember.sql`, colonne `remember`, `issueTokens/createRefreshToken` paramétrés, cookie `maxAge` aligné, case à cocher dans `LoginPage`
- Ajouté « Se déconnecter de tous les appareils » : `AuthService.logoutAll`, `POST /auth/logout-all`, `apiLogoutAll`, `AuthContext.logoutAll`, bouton dans l'onglet Paramètres (carte Sécurité de `ProfilePage`)
- Mis à jour ce fichier (routes auth, schéma `refresh_tokens`, décision archi httpOnly corrigée)

## 2026-06-30
- Créé `ml/python/fetch_data.py` — collecte NHL API historique (3 saisons, ~3600 matchs)
- Créé `ml/python/train.py` — XGBoost sans scikit-learn (Python 3.14 compatible), split temporel
- Mis à jour `ml/python/ml_service.py` — charge `game_model.json` + `totals_model.json` si disponibles
- Corrigé `featureEngineering.ts` — `|| 80` au lieu de `?? 80` pour pkPct (0 = données manquantes)
- Corrigé Pydantic — `ge=0` au lieu de `ge=50` pour pk_pct (validait `0` comme invalide)
- Corrigé `predict_team` — `KeyError: 'moneyline'` → `.get()` avec défaut
- `MLSection` — affiche maintenant l'erreur exacte (bandeau rouge) au lieu de `null` silencieux
- `NHLPredictionsPage` — remplacé dropdown `GameSelector` par pills horizontaux (plus de page vide)
- `BetPredictionCard` — branché `MLSection` sur chaque carte de marché (remplace placeholder "À venir")
- Créé fichiers de déploiement : `server/Dockerfile`, `ml/python/Dockerfile`, `client/vercel.json`, `client/.env.production`, `server/.env.example`
- Créé `DEPLOYMENT.md` — guide complet Supabase + Railway + Vercel (étapes, env vars, OAuth, checklist)

## Sessions précédentes
- Sections 1–5 complètes (`PLAN.md` supprimé le 2026-08-10, entièrement livré ; détail dans l'historique Git)
- Section 3 : predictionEngine.ts (Log5, Poisson), featureEngineering.ts, mlApiClient.ts
- Section 4 : auth gate returnTo, odds labels américains, parlay implied odds, clear confirmation
- Section 5 : Socket.io chat temps réel (server/socket.ts + useChatSocket hook)
- ML : ml_service.py FastAPI, MLPredictionCard.tsx, MLSection intégré dans PredictionPage + NHLPredictionsPage

---

# Next Session Prompt

```
Contexte : Application ARAKICE (mobile-first NHL prediction app).
Lire PROJECT_CONTEXT.md pour l'état complet du projet.

Objectif actuel :
1. Vérifier ML frontend : F12 → Console → "[MLSection] fetch failed:"
   - 3 services requis : client (:5173), server (:3001), ml (:8000)
2. Entraîner le modèle XGBoost si pas encore fait :
   cd ml/python && python fetch_data.py --seasons 3 && python train.py
3. Déploiement : suivre DEPLOYMENT.md (Supabase → Railway → Vercel)
4. Ensuite : Section 6 (Share feature) ou Section 7 (EV/Opportunities frontend)

Règles :
- Ne pas réécrire du code existant sauf si nécessaire
- Réutiliser les composants existants (MLSection, MLPredictionCard, etc.)
- Garder max-w-[430px] mobile-first
- Tout nouveau endpoint Python doit gérer pk_pct=0 (ge=0 dans Pydantic)
```

---

# Notes

- Le modèle ML utilise les **mêmes features** que `featureEngineering.ts` — si on ajoute une feature en Python, l'ajouter aussi côté TS
- La NHL API retourne parfois `pkPct = 0` quand les données ne sont pas encore disponibles en début de saison — toujours utiliser `|| defaultValue` (pas `??`) pour les champs numériques
- `scikit-learn` ne compile pas sur Python 3.14 — rester sur XGBoost natif + numpy/pandas
- Les modèles `.pkl` (joblib) ont été remplacés par `.json` (format natif XGBoost) pour la compatibilité Python 3.14
- Le split train/test se fait **par date** (temporel), pas aléatoirement — important pour éviter le data leakage en données sportives
