# SLIP_COMMANDE_PLAN — ajouter au coupon en langage naturel

> Rédigé le 2026-09-28. Décisions du user prises le même jour (§ 1).
> **Avancement :** étape 1 livrée le 2026-09-28 (`server/src/services/slipCommand.ts` +
> `slipCommand.test.ts`, 243 tests verts, non commitée). Étapes 2 à 5 à faire.

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

## 8. Ordre de livraison

1. `slipCommand.ts` + tests (analyseur et validateur).
2. Extraction de `buildLeg` + contrôle de non-régression de la feuille.
3. Champ sur la page Coupon, branché sur l'analyseur seul (utilisable tel quel).
4. Renfort LLM : tâche, migration 039, compteur gratuit, 400 sur `taskType` absent.
5. Messages de quota et bouton Pro.

Chaque étape est livrable seule ; l'étape 3 donne déjà une fonctionnalité complète sans LLM.
