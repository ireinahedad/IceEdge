# SLIP_COMMANDE_PLAN — ajouter au coupon en langage naturel

> Rédigé le 2026-09-28. Décisions du user prises le même jour (§ 1).
> **Avancement :** étapes 1 à 5 écrites et vérifiées le 2026-09-28 (l'étape 5, messages de
> quota et bouton Pro, s'est faite avec la 4). Étape 4 NON commitée, NON déployée :
> voir « Mise en service » à la fin du § 5.

Le joueur tape « Canadien gagne ce soir », « Suzuki over 2.5 tirs » ou « Habs ML et over 6.5 »,
et la jambe apparaît dans son coupon. Il ne fait que confirmer, puis verrouiller comme d'habitude.

**Principe non négociable : ni l'analyseur ni le LLM ne produisent de chiffre.** Ils traduisent une
phrase en *intention* (`qui`, `quel marché`, `quelle sélection`, `quelle ligne`, `quel match`).
La probabilité vient toujours de `getSinglePrediction`, exactement comme quand on passe par la
feuille `MarketSelectorSheet`. Une jambe ajoutée par commande doit être **identique** (même `id`,
même `gameId`, même `selectionValue`, même probabilité) à la même jambe ajoutée à la main.

---

## 1. Décisions du user (2026-09-28)

| # | Décision |
|---|---|
| D1 | **Paris joueurs inclus dès la v1**, en plus des marchés de match et d'équipe. |
| D2 | « <équipe> gagne » = **`moneyline`** par défaut (prolongation et tirs de barrage inclus). |
| D3 | **Analyseur local gratuit et illimité** pour tout le monde. |
| D4 | **Renfort LLM : 2 appels par jour pour un compte gratuit**, aux frais de l'opérateur. Au-delà, réservé à Pro, avec le message « Passe Pro pour que l'IA comprenne des paris plus complexes ». |
| D5 | Pour un abonné Pro, **chaque appel LLM compte** dans le plafond mensuel (`MONTHLY_QUOTA`, 500). |
| D6 | Le bouton vers Pro passe par **`features.proUpgrade`**, comme tous les autres. Le jour où iOS démarre, on décide à un seul endroit (`platform.ts`) si Pro apparaît sur iOS ; ce bouton suivra. |
| D7 | **On extrait la construction de jambe** de `MarketSelectorSheet` dans un helper partagé (§ 4). |
| D8 | Le web n'est **pas gelé** : le tag `pre-ios-freeze` a été retiré le 2026-09-28. |

---

## 2. Flux

```
phrase du joueur
   │
   ▼
[A] analyseur local  (slipCommand.ts, client, sans réseau)
   │  ok ──────────────────────────────┐
   │  unknown / ambiguous              │
   ▼                                   │
[B] POST /api/llm  taskType=parse_bet_command
   │  (Pro : quota mensuel ; gratuit : 2/jour, puis 429 + appel à Pro)
   │  réponse JSON revalidée côté serveur par le MÊME validateur que [A]
   ▼                                   │
intents[] ◄────────────────────────────┘
   │
   ▼
[C] buildLeg(intent)  → getSinglePrediction → BetLeg
   │
   ▼
addLeg()  + confirmation « ✓ Canadien gagne · MTL @ TOR »  [Annuler]
```

---

## 3. Étape A — analyseur local partagé

**Nouveau fichier `server/src/services/slipCommand.ts`.** Module **pur**, sans dépendance,
sur le modèle de `parlay.ts` : testé par vitest côté serveur, importé tel quel par le client
(le client n'a pas de runner de tests). Il ne fait aucun appel réseau : on lui passe les données.

```ts
parseSlipCommand(text: string, ctx: {
  games:   { id; homeAbbr; awayAbbr; date; startTime? }[];   // matchs à venir
  players: { id; name; teamAbbr }[];
  today:   string;                                           // YYYY-MM-DD, date NHL
  lines:   Partial<Record<SlipMarket, readonly number[]>>;   // lineOptions
}): { ok: true; intents: SlipIntent[] }
 | { ok: false; reason: 'unknown' | 'ambiguous' | 'no_game' | 'unsupported'; chunk; detail? }
```

**Écarts livrés par rapport à cette première signature (2026-09-28) :**
- `today: 'YYYY-MM-DD'` au lieu de `now: Date` : « ce soir » se lit sur la date NHL
  (`getScheduleAnchor().today`), pas sur l'horloge de l'appareil (à Bali, le soir
  nord-américain tombe le lendemain).
- `lines` est passé par l'appelant : les `lineOptions` vivent dans
  `client/src/app/data/betMarkets.ts`, que le serveur ne peut pas importer. Le client
  les tire de `MARKET_DEFINITIONS`. **Décision du user (2026-09-28), à faire à l'étape 4 :**
  les lignes des 6 marchés plus/moins déménagent dans un **fichier partagé côté serveur** ;
  `betMarkets.ts` l'importe (comme `BetContext` importe `parlay.ts`). Une seule source,
  pas de copie, et le serveur valide avec SES lignes, pas celles envoyées par le client.
- « Habs over 6.5 » (ligne qui n'existe que pour le total du match) → `ambiguous`,
  `detail.kind: 'total_scope'` : l'écran demande « total du match ou total des
  Canadiens ? ». **Décision du user (2026-09-28).**
- `players[].position` facultatif : sert à refuser « arrêts » pour un patineur et
  « tirs » pour un gardien.
- Chaque échec porte `chunk` (le morceau en cause) et un `detail.kind` précis
  (`team`, `player`, `line_missing`, `game_missing`, `no_game`, `line`, `position`,
  `too_long`, `too_many`).
- Refus volontaires (→ `unknown`) : négations (« ne gagne pas », « perd »), « ou »,
  nul, et tout chiffre non lu (« 3-2 », « +1.5 »).
- ⚠️ Import côté client (étape 3) : `vite.config.ts` devra autoriser `slipCommand.ts`
  **et** `oddsTeamNames.ts` dans `server.fs.allow`, comme `parlay.ts`.

`SlipIntent` = `{ subjectType: 'team' | 'player' | 'game', subjectId, marketType, selection, line?, gameId }`.

### 3.1 Normalisation
Minuscules, accents retirés, apostrophes et tirets unifiés, `o6.5` / `u6,5` / `6,5` lus comme `6.5`.

### 3.2 Table de surnoms des équipes
Part de `NAME_TO_ABBR` (`oddsTeamNames.ts`, déjà là) : noms complets, puis villes, puis surnoms.
Exemples : `ch`, `habs`, `canadien(s)`, `glorieux`, `montreal` → MTL ; `leafs` → TOR ; `bs` → BOS ;
`oil`, `oilers` → EDM ; `avs` → COL ; `bolts` → TBL ; `caps` → WSH ; `sens` → OTT ; `nucks` → VAN ;
`knights`, `vegas` → VGK ; `canes` → CAR ; `preds` → NSH ; `hawks` → CHI ; `yotes`, `mammoth` → UTA.
⚠️ **Collisions à trancher dans les tests** : `new york` (NYR ou NYI), `rangers` / `islanders`,
`kings` / `knights`. Un nom ambigu donne `ambiguous`, jamais un choix au hasard.

### 3.3 Joueurs
Recherche dans `players` : nom complet, puis nom de famille seul **s'il est unique** dans la liste
des joueurs des matchs à venir. Deux « Hughes » donnent `ambiguous`. Le match du joueur est trouvé
comme dans la feuille (`getPlayerGameId`).

### 3.4 Motifs v1 (fr / en)

| Phrase | Marché |
|---|---|
| `<éq> gagne / win / ML / victoire` | `moneyline` (D2) |
| `<éq> en temps réglementaire / 60 min / regulation` | `regulation_result` |
| `<éq> -1.5 / puck line` | `puck_line` |
| `over / plus de / o <n>` et `under / moins de / u <n>` (sans équipe ou avec les deux) | `total_goals` |
| `<éq> over / under <n>` | `team_total_goals` |
| `les deux équipes marquent / BTTS` | `both_teams_score` |
| `prolongation / OT / va en prolo` | `game_to_ot` |
| `<joueur> marque / but / to score / anytime` | `anytime_goal` |
| `<joueur> premier but / first goal` | `first_goal_scorer` |
| `<joueur> over / under <n> tirs / shots` | `shots_ou` |
| `<joueur> over / under <n> points` | `points_ou` |
| `<joueur> over / under <n> passes / assists` | `assists_ou` |
| `<gardien> over / under <n> arrêts / saves` | `goalie_saves_ou` |

Tout le reste renvoie `unknown` et passe au LLM. La **ligne** doit figurer dans les
`lineOptions` de `MARKET_DEFINITIONS` quand le marché en déclare ; sinon `unsupported`
(avec les lignes proposées dans `detail`).

### 3.5 Quel match
Prochain match à venir du sujet. « ce soir » / `tonight` limite au jour même ; « demain » /
`tomorrow` au lendemain ; un adversaire nommé (« Canadien contre Toronto ») choisit l'affiche.
Aucun match dans la fenêtre donne `no_game`, **jamais un match inventé**.

### 3.6 Plusieurs demandes
Découpage sur `et`, `and`, `+`, `,`, `&`. Chaque morceau est analysé seul ; il hérite de l'équipe
ou du match du morceau précédent quand il n'en nomme pas (« Habs ML et over 6.5 »). Si un morceau
échoue, toute la phrase part au LLM : on n'ajoute pas la moitié d'une demande.

### 3.7 Validateur partagé
`validateIntent(intent, ctx)` vit dans le même fichier. Il est appelé sur la sortie de
l'analyseur **et** sur celle du LLM (§ 5) : marché dans l'énumération, sujet et match existants,
sélection cohérente avec le marché, ligne autorisée.

### 3.8 Tests (`slipCommand.test.ts`)
Chaque surnom ; chaque motif en français et en anglais ; accents et casse ; virgule décimale ;
collisions de noms ; joueur homonyme ; équipe qui ne joue pas ce soir ; ligne hors `lineOptions` ;
phrase multiple ; phrase multiple dont un morceau échoue ; texte vide ou très long.

---

## 4. Étape C — extraction de `buildLeg`  ⚠️ seul changement d'architecture

Aujourd'hui, la construction d'une jambe vit **dans** `MarketSelectorSheet.tsx`
(`getPlayerGameId` ligne ~180 et `handleAdd` lignes ~188 à 293) : id déterministe, appel `getSinglePrediction`, libellés,
`gameId`, `selectionValue`, `opponentId` / `isHome`.

- Nouveau `client/src/app/services/buildLeg.ts` : **déplacement tel quel** de cette logique, sans
  la réécrire. Signature :
  `buildLeg(input, deps) → Promise<{ ok: true; leg: BetLeg } | { ok: false; reason: 'unavailable' }>`.
- `MarketSelectorSheet` l'appelle et garde son comportement exact (doublon via `hasLeg`, message
  `pred.unavailableLeg`, fermeture après 600 ms).
- La commande appelle la même fonction.
- **Contrôle de non-régression** : ajouter à la main puis par commande la même jambe (équipe,
  match, joueur) et comparer les deux objets `BetLeg` champ par champ.

**Livré (2026-09-28) — décisions du user :**
- Le doublon est contrôlé **dans** `buildLeg` (`deps.hasLeg`), avant l'appel au modèle :
  `{ ok: false, reason: 'duplicate' }` sans appel réseau. Signature :
  `buildLeg({ subject, market, selection, line, game, playerGameId? }, { players, games, getTeamById, hasLeg })`.
- **Match d'un pari joueur — corrigé le 2026-09-28** (décisions du user). Avant, la feuille
  le cherchait dans `useNHLData().games`, qui ne porte que la soirée du jour : un joueur qui
  jouait demain partait sans `gameId` et sa jambe ne se réglait jamais. Désormais un pari
  joueur se traite comme un pari d'équipe :
  - la feuille affiche le même sélecteur de match (14 jours, `useUpcomingGames` sur
    l'équipe du joueur), présélectionné sur le prochain ;
  - sans match à venir, « Ajouter au coupon » est désactivé (clé i18n
    `mkt.noUpcomingGamePlayer`) ;
  - le match entre dans l'id de la jambe (Suzuki ce soir ≠ Suzuki demain), dans son
    `gameId` et dans sa ligne d'affiche (« vs TOR · date · heure ») ;
  - la requête au modèle d'un pari joueur est INCHANGÉE (ni adversaire ni côté).
  Signature finale : `buildLeg({ subject, market, selection, line, game }, { players, getTeamById, hasLeg })`
  — `game` sert à l'équipe ET au joueur ; plus de `playerGameId` ni de `deps.games`. La
  commande (étape 3) fournira donc un `UpcomingGame` pour les deux.
- Non-régression vérifiée hors navigateur : l'ancien `handleAdd`, collé tel quel, et le
  nouveau tournent sur 20 cas (équipe, match, joueur, doublon, prédiction indisponible)
  avec un modèle simulé : jambes, requêtes au modèle, fermeture et message identiques.
  Un bug volontaire (côté domicile inversé) est bien attrapé (7 écarts). La comparaison
  « feuille contre commande » se fera à l'étape 3.

---

## 5. Étape B — renfort LLM

### 5.1 Tâche
- `llmPrompts.ts` : ajouter `parse_bet_command` à `LLM_TASK_TYPES`, avec son invite système
  (fr / en). Elle reçoit la phrase, la liste des matchs à venir (id, abréviations, date), les
  joueurs **des équipes nommées seulement** (pas les 700 de la ligue), et l'énumération des
  marchés supportés avec leurs lignes autorisées.
- Réponse imposée par **structured outputs** (`response_format: json_schema`) :
  `{ intents: SlipIntent[] }` ou `{ clarification: string }`.
- Le serveur passe chaque intention dans **`validateIntent`** (§ 3.7). Une intention invalide
  n'est jamais transmise : on renvoie `clarification`.
- ⚠️ **Le `taskType` absent devient un 400** (note du lot sécurité du 2026-09-08 : « le jour où il
  y aura une DEUXIÈME tâche, ce défaut doit devenir un 400 »). Vérifier avant que le client déployé
  envoie bien `taskType` partout.

### 5.2 Qui paie, combien (D4, D5)
- **Pro** : `consumeProRequest` comme aujourd'hui ; l'appel compte dans les 500. Au plafond, le
  repli existant sur la clé perso s'applique.
- **Gratuit** : **clé de l'opérateur**, 2 appels par jour. C'est le **premier usage gratuit payé
  par l'opérateur** : le compteur doit donc être en base, pas en mémoire (le `DAILY_QUOTA` actuel
  est par instance et remis à zéro à chaque redéploiement, ce qui convient pour protéger le
  serveur, pas un budget).
  - Migration **`039_llm_free_daily.sql`** : `llm_free_daily (user_id, day, count, updated_at)`,
    clé primaire `(user_id, day)`.
  - Incrément et contrôle dans **le même énoncé** (`INSERT … ON CONFLICT DO UPDATE … WHERE count < 2`),
    même motif que `consumeProRequest`. Remboursement si le fournisseur échoue.
  - Ces appels **comptent aussi dans `llm_usage_global`** : le disjoncteur global reste la borne
    absolue de la dépense.
  - Constante `LLM_FREE_PARSE_DAILY` (défaut 2), jamais recopiée dans une traduction : l'API
    renvoie la limite, l'écran l'affiche.
  - Un compte gratuit **avec sa propre clé** : passe par sa clé comme aujourd'hui, sans limite de 2.
- Réservé à `parse_bet_command` : `explain_bet` garde ses règles actuelles.

### 5.3 Coût
Invite petite (≤ 15 matchs + quelques joueurs), sortie de quelques dizaines de tokens.
Recalculer le pire cas dans la formule de `llmQuota` pour cette tâche et vérifier qu'il reste
sous celui d'`explain_bet`. `LLM_REASONING_EFFORT=none` suffit : c'est de l'extraction.

### 5.4 Au quota
- Gratuit, 2 appels atteints : 429 avec `code: 'free_parse_quota'`. Écran : « Passe Pro pour que
  l'IA comprenne des paris plus complexes », bouton vers `/pro` **si `features.proUpgrade`** (D6).
  L'analyseur local continue de marcher.
- Pro au plafond : message existant du quota mensuel.

---

### 5.5 Livré (2026-09-28) — décisions du user

- **Relais AUTOMATIQUE** : dès que l'analyseur local rend `unknown` (et SEULEMENT ce cas :
  une ambiguïté a déjà ses choix cliquables), la phrase part au LLM, pour un compte connecté.
  Visiteur non connecté : pas d'appel, message local.
- **Ligne de quota discrète** dans la feuille : « Analyses IA gratuites restantes
  aujourd'hui : n sur 2 » / « Analyses IA ce mois-ci : n sur 500 » (Pro) / « L'IA utilise
  ta clé OpenAI. » Mise à jour par la réponse elle-même (`usage`), sans recharger `/usage`
  (qui partage `llmLimiter`, 10 req/min).
- **Quota gratuit épuisé** : la phrase du user « … Passe Pro pour que l'IA comprenne des
  paris plus complexes » **partout**, le bouton vers /pro seulement si
  `features.proUpgrade` (iOS : même phrase, sans bouton — comme `ProLock`).
- **Lignes partagées** : `server/src/services/marketLines.ts` (6 marchés plus/moins) ;
  `betMarkets.ts`, l'analyseur (client) et la validation serveur la lisent.

Fichiers : `slipCommandLlm.ts` (candidats, invite, schéma strict, relecture),
`slipCommandContext.ts` (contexte serveur : mêmes sources que le client — anchor,
`/games/range` 14 j, `fetchTopPlayers`), `llmQuota.service.ts` (`consumeFreeParse`,
`refundFreeParse`, `getFreeParseUsage`, `FREE_PARSE_DAILY`, `PROMPT_BUDGET_CHARS`),
`039_llm_free_daily.sql`, purge à 7 jours dans `cleanup.service.ts`, `llm.routes.ts`,
`llmPrompts.ts`, `llmService.ts`, `SlipCommandSheet.tsx`, i18n `cmd.ai*`, `.env.example`.

Points de conception :
- `taskType` **obligatoire** (400). Vérifié avant : le client en production (commit
  `bb71c6f`) l'envoie toujours.
- Le serveur ne croit rien du client : il construit son propre contexte, impose un schéma
  JSON strict, et repasse chaque intention par `validateIntent` ; une seule invalide →
  toute la réponse rejetée. Le client revalide contre SON contexte.
- Invite : matchs des équipes nommées (≤ 15) et joueurs des équipes nommées + ceux dont
  le nom ressemble à un mot de la phrase (fautes de frappe, inversions) (≤ 60). La phrase
  reste dans le message UTILISATEUR ; la question de précision est bornée à 200 caractères.
- **Coût** : l'invite est bornée à `min(7 000, PROMPT_BUDGET_CHARS − 200)` caractères, donc
  jamais au-delà du pire cas sur lequel le plafond mensuel est calculé (5 800 avec les
  4 000 + 2 000 de `.env.example`). Même budget de sortie qu'`explain_bet`.
- Remboursement de l'appel gratuit sur panne réseau et 4xx du fournisseur ; PAS sur 5xx
  (le modèle a pu tourner), PAS sur une réponse inutilisable (sinon une phrase absurde
  deviendrait un appel gratuit illimité).
- Compte gratuit avec sa clé perso : sa clé, sans compteur de 2 ; `explain_bet` sans clé
  reste un 422, inchangé.

Vérifié : suite serveur complète **962 tests / 49 fichiers** verts (919 avant) ; typecheck
serveur et client ; builds web et iOS (le texte de l'invite n'apparaît dans aucun bundle) ;
migration 039 jouée après `schema.sql` + les 38 autres dans un PostgreSQL 16 jetable, avec
le VRAI `llmQuota.service` : 2 puis refus, 10 appels simultanés → exactement 2 passent,
remboursement, disjoncteur partagé avec Pro, cascade à la suppression du compte,
`CHECK count >= 0`, purge, rejeu idempotent ; banc Playwright de la feuille (12 scénarios).
Non vérifié : un vrai appel OpenAI (pas de clé ici) — la route est testée fournisseur simulé.

### 5.6 Mise en service — dans cet ordre

1. `npm run db:migrate:all` sur Neon (migration 039) **avant** de déployer le serveur :
   sans la table, les appels gratuits échouent fermés (503) et la purge quotidienne
   journalise une erreur.
2. Déployer le **serveur** (Railway), puis le **client** (Vercel). Dans l'autre ordre, le
   client enverrait `parse_bet_command` à un serveur qui ne la connaît pas (« IA
   indisponible », sans casse).
3. Facultatif : `LLM_FREE_PARSE_DAILY` (défaut 2). ⚠️ Piège Railway : une variable modifiée
   reste EN ATTENTE derrière le bouton Deploy.
4. ✅ **Disjoncteur séparé (décision du user, 2026-09-29)** : les appels gratuits ont leur
   propre plafond mensuel global, `LLM_FREE_GLOBAL_MONTHLY_CAP` (5 000 par défaut, ~11,85 $
   au pire cas), table `llm_free_global` dans la migration 039. Ils ne touchent plus
   `llm_usage_global` : le gratuit ne peut plus couper l'IA aux abonnés Pro, et l'inverse.
   Vérifié en vrai PostgreSQL (gratuit plein à 5 000 → refusé, Pro passe toujours).

### 5.7 Nom affiché : « Bet builder IA » (décision du user, 2026-09-29)

Pour ne jamais le confondre avec l'« Analyse LLM » d'un pari individuel (`PredictionSheet`,
`explain_bet`), la fonction s'appelle **« Bet builder IA »** (« AI bet builder ») partout :
boutons des pages Stats et Coupon, titre de la feuille, compteur (« Essais gratuits restants
du Bet builder IA aujourd'hui : n sur 2 »), messages (« Le Bet builder IA lit ton pari… »,
« … indisponible… », « Tu as utilisé tes 2 essais gratuits du Bet builder IA aujourd'hui.
Passe Pro pour que l'IA comprenne des paris plus complexes. »). Pour un abonné Pro, le
compteur dit que le quota est **partagé** : « Quota IA du mois, partagé avec l'Analyse
LLM : n sur 500 ». Commentaires du code alignés ; les identifiants internes
(`SlipCommandSheet`, clés `cmd.*`, `parse_bet_command`) restent inchangés.
La carte des Réglages (`SettingsTab`) est alignée : titre « Analyse LLM et Bet builder IA » ;
Pro : « Un seul quota pour l'Analyse LLM et le Bet builder IA. » ; gratuit : la phrase de la
clé OpenAI est préfixée « Analyse LLM : », suivie des essais restants du Bet builder IA (ou
« Le Bet builder IA utilise ta clé OpenAI. » avec une clé perso). Vérifié : 964
tests serveur, builds web + iOS (l'ancien nom n'est plus dans aucun bundle), banc
navigateur 11/11 en français et en anglais.

### 5.8 Noms mal écrits et ligne des essais gratuits (demande du user, 2026-09-29)

- **Fautes de frappe** — `findSpellingFixes` dans `slipCommand.ts`. Un nom de joueur ou
  d'équipe mal écrit n'est JAMAIS corrigé en silence : échec `ambiguous`, détail
  `spelling` (`word` + `fixes`), et les noms proches en choix cliquables, comme
  « quel Hughes ? ». Comme c'est un `ambiguous`, la phrase ne part PAS au LLM : aucun
  essai consommé.
- Distance de Damerau-Levenshtein (une lettre inversée = 1 faute). Fautes tolérées :
  0 sous 4 lettres, 1 jusqu'à 5, 2 jusqu'à 8, 3 au-delà. Cibles : surnoms d'équipe de
  4 lettres et plus, noms complets et noms de famille des joueurs du contexte.
- Chaque correction est **ré-analysée** avant d'être proposée ; elle n'est gardée que si
  elle fait avancer la phrase.
- Phrase **déjà comprise** (« Habs gagne contre Otawa ») : on ne demande que si la
  correction mène à un AUTRE pari valide ; 5 lettres minimum, première lettre identique,
  1 faute jusqu'à 8 lettres. Mots courants proches d'un surnom (« sans »/Sens,
  « stats »/Stars…) dans `FILLER_WORDS`.
- Vérifié sur les 678 joueurs réels de `content_insight_*.csv` : 0 fausse question sur
  4 470 phrases correctes ; 12 tests ajoutés (263 au total).
- **Ligne « essais gratuits restants »** retirée de la feuille : un compte Free n'y voit
  plus de compteur (le message au quota épuisé reste). La ligne Pro / clé perso reste,
  et le compteur Free reste dans les Réglages.

## 6. Étape D — interface

- Champ « Ajoute un pari… » sur la page Coupon (`BetBuilderPage`), à côté du bouton qui ouvre la
  feuille. Texte ≥ 16 px (anti-zoom iOS), cible ≥ 44 px (`.tap-44`).
- Soumission : [A] puis, si besoin, [B], puis `buildLeg` pour chaque intention, puis `addLeg`.
- Confirmation courte par jambe, avec **Annuler** (`removeLeg`).
- Messages : équipe ou joueur inconnu (avec 3 exemples de phrases), pas de match ce soir,
  ambiguïté (avec la question), prédiction indisponible (`pred.unavailableLeg`), quota (§ 5.4),
  jambe déjà dans le coupon.
- Toutes les chaînes en i18n fr / en. Aucun chiffre en dur dans les traductions.
- Hors saison : sans match à venir, le champ affiche un état vide clair au lieu d'échouer.

**Livré (2026-09-28) — décisions du user :**
- Pas de champ permanent : un bouton **« Construire un pari avec l'IA »** (sans emoji) qui
  ouvre une feuille (`components/SlipCommandSheet.tsx`, même gabarit que « + Ajouter »).
  Il est placé :
  - en haut de la page **Stats**, sur les trois onglets ;
  - sur **Coupon** : au-dessus de « Browse markets » quand le coupon est vide
    (`EmptySlip`), puis à côté de « + Ajouter » une fois le coupon rempli.
- Chaque jambe ajoutée laisse une ligne « ✓ … Annuler » sous le champ, jusqu'à la
  commande suivante.
- **Choix cliquables** pour les ambiguïtés. C'est l'analyseur qui les fournit
  (`SlipFailure.choices`, `SlipChoice.text` = commande réécrite à ré-analyser) : équipe
  (`New York` → Rangers / Islanders), joueur (`Hughes` → 3 boutons, passage par la ville,
  « carolina », quand l'abréviation est un mot courant), ligne manquante ou refusée,
  total du match ou de l'équipe.
- Phrase à plusieurs paris : **ce qui marche est ajouté**, le reste est signalé (doublon,
  probabilité indisponible).
- Données : `hooks/useSlipCommandData.ts`, chargé à l'ouverture de la feuille ; un seul
  appel `/games/range` sur 14 jours via `fetchUpcomingWindow()` (partagé avec
  `useUpcomingGames`, même comportement). Intention → jambe : `services/slipCommandLegs.ts`,
  qui passe par `teamSubject` / `playerSubject` / `gameSubject` + `buildLeg`, exactement
  comme la feuille.
- `vite.config.ts` autorise `slipCommand.ts` et `oddsTeamNames.ts` dans `server.fs.allow`.
- Vérifié : 251 tests serveur (dont 8 sur les choix cliquables) ; typecheck client ;
  builds web et iOS ; banc Playwright sur la vraie feuille, avec API LNH simulée
  (14 contrôles : ajout, Annuler, phrase double, Hughes, total du match, doublon,
  pari indisponible, négation, pas de match ce soir, ligne manquante, 16 px) ; et le
  contrôle du § 4 : feuille « + Ajouter » contre commande, **jambes identiques champ
  par champ** (équipe ce soir, joueur ce soir, joueur demain).

---

## 7. Vérification

1. **Serveur** : `npm run typecheck` et vitest (`slipCommand.test.ts`, tests de la route LLM :
   400 sans `taskType`, schéma JSON invalide rejeté, compteur gratuit à 2 puis 429,
   remboursement sur échec du fournisseur, comptage dans le global).
2. **Migration 039** jouée d'abord dans un PostgreSQL jetable (recette du bac à sable), puis Neon.
3. **Client** : build web et `VITE_TARGET=ios` ; vérifier dans le bundle bâti que le bouton Pro
   suit bien `features.proUpgrade`.
4. **Navigateur** : 6 phrases réelles (équipe, total, joueur, gardien, phrase double, phrase que
   seul le LLM comprend) et le contrôle de non-régression du § 4.

### 7.1 État des vérifications (2026-09-29)

1. ✅ Serveur : typecheck + vitest (964 tests, dont `slipCommand`, `slipCommandLlm`, route LLM,
   compteur gratuit et disjoncteur séparé).
2. ✅ Migration 039 jouée dans un PostgreSQL 16 jetable après `schema.sql` + les 38 autres,
   avec le vrai `llmQuota.service`. ⏳ Reste : `npm run db:migrate:all` sur Neon.
3. ✅ Builds web et `VITE_TARGET=ios`, **vérifiés dans le bundle bâti** : le chunk
   `SlipCommandSheet` web contient le bouton Pro gardé par `proUpgrade` ; le chunk iOS ne
   contient NI `"/pro"` NI le libellé du bouton (branche éliminée à la compilation), et
   aucun `ProPage-*.js` n'est émis. La phrase « Passe Pro pour que l'IA… » est dans les
   deux, comme décidé.
4. ✅ Navigateur (Playwright, API simulée) : feuille, relais IA, compteurs, carte des
   Réglages, contrôle « feuille contre commande » du § 4. ⏳ **Reste, après déploiement** :
   les 6 phrases réelles avec le VRAI modèle (équipe, total, joueur, gardien, phrase double,
   phrase que seul le LLM comprend, ex. « Suzuki 3+ tirs »).

## 8. Ordre de livraison

1. `slipCommand.ts` + tests (analyseur et validateur).
2. Extraction de `buildLeg` + contrôle de non-régression de la feuille.
3. Champ sur la page Coupon, branché sur l'analyseur seul (utilisable tel quel).
4. Renfort LLM : tâche, migration 039, compteur gratuit, 400 sur `taskType` absent.
5. Messages de quota et bouton Pro. ✅ Fait avec l'étape 4 (§ 5.5, § 5.7, § 7.1).

Chaque étape est livrable seule ; l'étape 3 donne déjà une fonctionnalité complète sans LLM.
