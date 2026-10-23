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

Déjà couvert avant ce plan : blessés longue durée (`injurySync.ts`, PoolExpert),
absents officiels vers T−30 min (`officialLineup.ts`), saisies manuelles
(`scratches.ts`, `startingGoalies.ts`).

---

## Décisions prises (2026-10-23)

| Sujet | Décision |
|---|---|
| Discord | Aucune lecture par programme, aucune demande aux admins de Hockey Chat. |
| Votes Hockey Chat | Pas recopiés, pas de faux comptes. Le consensus affiché sera celui des VRAIS utilisateurs ICEEDGE (F3). |
| Cadence du fil | 1 h ; 15 min d'une heure avant le 1er match jusqu'à la dernière mise au jeu. |
| Kalshi / Polymarket (F2) | **Pas affiché dans l'app.** Mis de côté ; usage interne seulement si on le reprend un jour. |
| Section nouvelles | Pliable, repliée par défaut, en-tête avec compteur et badge alignement/gardien. |

## Livré le 2026-10-23 — F1, fil de nouvelles

En production : migration 047 (`news_items`), job `newsSync.service.ts`
(`NEWS_SYNC_ENABLED=true`), 19 sources Bluesky vérifiées par `npm run news:check`,
`GET /api/news`, section « Dernières nouvelles » sur la page de match, carte
« Ajouter une nouvelle » dans /dev/saisie, alerte admin (absent/gardien, < 3 h,
match pas encore commencé). 1er tour : 19 sources lues, 152 publications.

Équipes avec une source dédiée : CHI, BUF, MIN, PHI, MTL, VAN, TOR, EDM, CGY.
Les 23 autres dépendent des sources de ligue (Daily Faceoff surtout).

---

## Ce qui reste — dans l'ordre

### Étape 1 — Valider F1 en conditions réelles (toi, ce soir et demain)

Rien à coder. Avant d'empiler autre chose sur le fil, vérifier qu'il dit vrai.

- [ ] Dans les logs Railway : passage à `nextMin: 15` une heure avant le 1er match,
      retour à `60` après la dernière mise au jeu.
- [ ] Une alerte admin reçue AVANT un match (et aucune pour un match commencé).
- [ ] Sur 3-4 pages de match : la section s'affiche, les liens ouvrent le bon post,
      aucune nouvelle collée à la mauvaise équipe. Noter les erreurs : elles
      corrigent `teamsInText` (`newsFeed.ts`).
- [ ] Supprimer `_to_delete/server-src-tests.tgz` et `_to_delete/client-src-tests.tgz`.

### Étape 2 — Couverture : sources pour les 23 équipes sans compte dédié (1 session)

Le fil vaut ce que valent ses sources. Deviner des handles a échoué 9 fois sur 12.

- Script `npm run news:discover` : pour chaque équipe sans source, interroge
  `app.bsky.actor.searchActors` (API publique, sans clé) avec « <équipe> beat »,
  « <équipe> reporter », « <ville> hockey », puis passe chaque candidat au même
  contrôle que `news:check` (actif sur 7 j, cite l'équipe). Sortie : une liste
  de candidats à copier dans `newsSources.ts`. Lecture seule, rien en base.
- Garder 1-3 sources par équipe ; c'est toi qui valides chaque ajout.
- Coût : nul en production (script local). Plus de sources = plus d'appels
  Bluesky par tour, pas plus d'écritures Neon.

### Étape 3 — F4, transactions par comparaison d'effectifs (1 session) — ✅ codé 2026-10-23

Livré dans le code (pas encore en production) : `newsRoster.ts` (pur : lecture,
comparaison, extraits, échéance), `newsRoster.service.ts` (appels + 1 transaction),
appel en fin de `runNewsSync`, migration 048. Choix faits en route :
- Un joueur retiré de A et ajouté à B le même jour = UNE nouvelle « moved » (A et B).
- 1er jour : base enregistrée, aucune nouvelle. Plus de 8 mouvements dans une équipe
  (bascule de saison, réponse anormale) : rebase sans nouvelle.
- Équipe illisible : pas comparée, sa veille reste. Écriture refusée (048 absente) :
  tout est annulé, les écarts reviennent le lendemain — rien de perdu.
- Extraits en anglais comme le reste du fil (« Roster move: … leaves TOR for VGK. »),
  auteur « NHL.com », lien `https://www.nhl.com/player/<id>`. Pas d'alerte admin.

Plan d'origine :

Remplace le canal #league-transactions sans PuckPedia.

- Une fois par jour (le 1er tour de NewsSync après 12 h ET), lire
  `v1/roster/{équipe}/current` pour les 32 équipes, comparer à la veille.
- Effectif de la veille : `job_state` (une clé JSON par équipe) — pas de table de plus.
- Chaque joueur ajouté / retiré → une ligne `news_items` (`source = 'nhl_roster'`,
  drapeau `transaction`, lien vers la page joueur nhl.com). Migration 048 :
  élargir le CHECK de `source`.
- Rien à afficher de neuf : ces lignes apparaissent dans la section existante.
- Coût : 32 appels NHL par jour, 1 INSERT par jour.

### Étape 4 — Brancher le fil sur l'analyse IA (½ session)

- `llmAnalysisContext.ts` : ajouter les nouvelles drapeautées (absent/gardien)
  des 24 dernières heures des deux équipes, en liste courte (auteur, heure, extrait).
- L'IA les cite comme contexte ; elles NE modifient PAS les probabilités du modèle.
  Le modèle ne bouge que par la saisie (scratches / gardien partant), comme aujourd'hui.
- Tests : le contexte reste sous le plafond de jetons ; aucune nouvelle → rien d'ajouté.

### Étape 5 — F3, Pick'em ICEEDGE (2-3 sessions)

Le vrai remplaçant de #pickems et #pickems-weekly-winner, avec tes utilisateurs.

Session A — vote et affichage
- Migration 049 `pickem_votes` (user_id, game_id, team_abbr, created_at ;
  UNIQUE (user_id, game_id)). Vote modifiable jusqu'à la mise au jeu, refusé après
  (heure de `/nhl/games`, vérifiée côté serveur).
- `POST /api/pickem/:gameId` (connecté), `GET /api/pickem/:gameId` (public :
  totaux + mon vote). Totaux en cache mémoire 1 min (coût Neon).
- Page de match : 2 boutons + barre « X % des utilisateurs ICEEDGE », nombre réel
  de votants. Sous 10 votes : « Pas encore assez de votes », pas de pourcentage.

Session B — résultats et classement
- Règlement : à la fin du match, `correct` = vrai/faux, dans le job de règlement
  existant (`settlement.service.ts`), pas un job de plus.
- Classement hebdo (lundi → dimanche, heure de l'Est) : `GET /api/pickem/leaderboard`,
  minimum 10 picks dans la semaine pour être classé. Le taux du modèle ICEEDGE sur
  les mêmes matchs affiché à côté.
- Annonce du gagnant le lundi dans le chat de la ligue publique (déjà en place).

Session C — rétention (optionnel)
- Notification « Picks verrouillés dans 1 h » aux utilisateurs qui ont voté au moins
  une fois et activé les notifications.

### Étape 6 — F5, page « Public vs modèle » (1 session, après 3-4 semaines de F3)

- Taux de réussite par semaine : modèle ICEEDGE, pick'em ICEEDGE, et « favori du
  public quand il dépasse 80 % ».
- Sur `nhl-prediction-accuracy.html` (déjà là). Sert aussi `MARKETING_PLAN.md`.
- À ne lancer qu'avec assez de votes : sous ~300 picks réglés, les écarts sont du bruit.

### Mis de côté

- **F2 Kalshi / Polymarket** : pas affiché (décision du 2026-10-23). À rediscuter
  seulement comme comparaison interne dans /dev.
- **X (Twitter) API** : payante. La carte « Ajouter une nouvelle » couvre les trous.

---

## Suivi

Les cases à cocher vivent dans `STATUS.md` §3.15 (règle du projet : une seule liste).
