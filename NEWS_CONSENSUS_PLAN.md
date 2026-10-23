# NEWS_CONSENSUS_PLAN.md — Nouvelles, consensus et pick'em

Créé le 2026-10-23, après lecture de 4 canaux du serveur Discord « Hockey Chat »
(#news, #league-transactions, #pickems, #pickems-weekly-winner).

## Règle de base

On ne lit PAS Discord par programme (pas de self-bot, pas de script sur le compte
perso) : interdit par les conditions de Discord, risque de bannissement du compte.
Discord a servi d'inspiration : on remonte aux sources publiques d'où viennent
ses infos, ou on recrée la fonctionnalité dans ICEEDGE.

## Ce que Discord a montré

| Canal | D'où vient l'info | Équivalent pour ICEEDGE |
|---|---|---|
| #news | Un membre repartage des tweets d'équipes et de journalistes, étiquetés par équipe | Comptes publics des journalistes et des équipes (Bluesky gratuit ; X payant) |
| #league-transactions | Bot PuckPedia (échanges, contrats, ballottage) | Comparer chaque jour les effectifs de l'API LNH (déjà utilisée) |
| #pickems | Bot du serveur, environ 50 votants par match | Marchés de prédiction publics (Kalshi, Polymarket) + un pick'em propre à ICEEDGE |
| #pickems-weekly-winner | Classement hebdo, les meilleurs font 72 à 73 % | Classement hebdo ICEEDGE, avec le taux du modèle à côté |

Constat du 2026-10-22 (matchs terminés) : consensus Hockey Chat 2/7, et 1/3 quand il
dépassait 80 %. VGK était à 84 % ; Marner a été déclaré absent 32 minutes avant le
match (tweet de VGK) ; défaite 6-2. Une seule soirée : aucune conclusion, mais c'est
le genre d'histoire que les fonctionnalités ci-dessous racontent.

Déjà couvert dans le code : blessés longue durée (`injurySync.ts`, PoolExpert),
absents officiels vers T−30 min (`officialLineup.ts`), saisies manuelles
(`scratches.ts`, `startingGoalies.ts`). Ce qui manque : les nouvelles des
HEURES avant le match, le gardien partant (encore saisi à la main) et un
consensus du public.

---

## F1 — Fil de nouvelles par match (priorité 1)

But : sur chaque page de match, les dernières nouvelles des deux équipes (lien +
auteur + heure), et une alerte admin quand une nouvelle touche un joueur ou un gardien.

Source principale : Bluesky, API publique sans clé
(`public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=<handle>`).
Beaucoup de journalistes LNH et d'équipes y publient aussi. À VÉRIFIER : quels
journalistes par équipe sont actifs sur Bluesky.
Source secondaire : saisie manuelle d'un lien X dans l'admin (`manual.routes.ts`).
Tu lis Discord ou X toi-même et tu colles le lien : c'est légal, et rapide.
X API : payante, à garder pour plus tard si le fil prend.

Travail :
1. `content/config/news_sources.json` : handle → équipe (2 à 4 sources par équipe).
2. Job serveur, cadence décidée le 2026-10-23 pour limiter le compute (Neon) :
   **toutes les heures**, et **toutes les 15 min** à partir d'une heure avant le
   premier match du jour jusqu'à la dernière mise au jeu. Pendant cette fenêtre,
   on ne lit que les sources des équipes qui jouent (+ les sources de ligue).
   Réutilise `jobLock.ts`. Opt-in : `NEWS_SYNC_ENABLED=true`. Le job
   lit les fils, garde les posts < 24 h, les range dans `news_items`
   (id, team_abbr, author, url, posted_at, text_excerpt court, flags).
   Comme `injurySync.ts` : on garde le lien et un extrait court, jamais le post entier.
3. Mots-clés → flags : `out`, `will not play`, `scratched`, `day-to-day`,
   `returns`, `in goal`, `starts`, `will start`, `IR`, `LTIR`.
4. Flag gardien ou absent → notification admin (`push.service.ts`) avec un bouton
   « Ajouter aux scratches / gardien partant ». Ça ferme la boucle du gardien
   partant SANS scraper Daily Faceoff.
5. Front : composant `MatchNews` sur la page de match (dans `max-w-[430px]`, Tailwind).
6. Plus tard : envoyer les nouvelles signalées à l'analyse LLM (`llmAnalysisContext.ts`).

## F2 — Consensus du marché (priorité 2)

**Décision du 2026-10-23 : le % Kalshi / Polymarket n'est PAS affiché dans l'app.**
Si F2 se fait, c'est en interne seulement (comparer le modèle au marché dans
`/dev`, ou comme feature candidate) — à rediscuter avant de coder.

Sources publiques, sans clé :
- Kalshi : `external-api.kalshi.com/trade-api/v2/markets?series_ticker=<NHL>&status=open`
  (ticker de la série LNH à trouver avec `/series`).
- Polymarket : API Gamma (événements sport LNH). À VÉRIFIER : couverture des
  matchs de saison régulière.

Travail :
1. `marketConsensus.service.ts` : récupère, fait correspondre les noms d'équipes
   (`oddsTeamNames.ts`), met en cache (`ttlCache.ts`).
2. Table `consensus_snapshots` (game_id, source, home_pct, taken_at), avec une
   photo à la mise au jeu pour pouvoir noter après coup.
3. Badge « Le modèle n'est pas d'accord avec le marché » quand l'écart est > X points.

## F3 — Pick'em ICEEDGE (priorité 3, c'est la croissance)

But : recréer #pickems dans l'app avec de vrais utilisateurs. Ça donne un vrai
« consensus du public » qui est À TOI, et une raison de revenir chaque jour.

1. Table `pickem_votes` (user_id, game_id, team_abbr, created_at). Verrouillage
   à la mise au jeu (heure de `/nhl/games`). Un vote par utilisateur et par match.
2. Sur la page de match : 2 boutons + barre « X % des utilisateurs ICEEDGE ».
   Afficher le nombre réel de votants. Rien de fabriqué : sous 10 votes,
   on affiche « Pas encore assez de votes ».
3. Règlement des votes avec `settlement.service.ts`.
4. Classement hebdo (lundi), réutiliser les ligues et le chat existants.
   Toujours afficher le taux du modèle ICEEDGE sur la même semaine.
5. Notification « Picks verrouillés dans 1 h ».

## F4 — Transactions (priorité 4)

Pas besoin de PuckPedia : une fois par jour, comparer les effectifs de l'API LNH
(route `/nhl/teams/:abbr/roster` existante) à ceux de la veille. Un joueur
ajouté ou retiré devient une entrée « Mouvement d'effectif » dans `news_items`
(source = `nhl_roster_diff`). Ça couvre les échanges, les rappels et les
ballottages réclamés ; pas les montants de contrat (rien de nécessaire au modèle).

## F5 — Page « Public vs modèle » (après F2 et F3)

Le soir, une fois les matchs réglés : taux de réussite du modèle, du marché, du
pick'em ICEEDGE, et du « favori du public » quand il dépasse 80 %. Ça va sur
`nhl-prediction-accuracy.html` (déjà là) et ça nourrit `MARKETING_PLAN.md`.

---

## Ordre proposé

1. F1 étapes 1 à 4 (fil + alertes admin) : le plus grand gain pour le modèle.
2. F1 étape 5 (affichage) + F4 (diff d'effectifs).
3. F2 (Kalshi, puis Polymarket).
4. F3 (pick'em), puis F5.

## Suivi

Les tâches restantes sont dans `STATUS.md` §3.15 (règle du projet : une seule liste).
