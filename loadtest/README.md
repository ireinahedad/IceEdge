# Tests de charge — procédure

Scénarios définis dans `AUDIT_SCALABILITE_COUTS.md` §5. Ce dossier contient
pour l'instant **S1**, celui que l'audit désigne comme décisif pour le
lancement.

> **Règle absolue, reprise de l'audit :** ne jamais tirer contre la production.
> Un tir de charge consomme le quota The Odds API en quelques secondes et
> déclenche de vraies notifications push. Cible = préprod avec sa propre base
> Neon et des clés externes de test ou absentes.

---

## 1. Ce que le test doit prouver

Les quatre critères de S1 :

| # | Critère | Se lit où |
|---|---|---|
| 1 | p95 < 800 ms | résumé k6 |
| 2 | erreurs < 0,5 % | résumé k6 |
| 3 | **≤ 2 appels Odds API sur toute la durée** | `/api/dev/metrics` |
| 4 | **≤ 5 exécutions complètes de `getBestBets`** | `/api/dev/metrics` |

Les critères 3 et 4 sont les vrais. Les deux premiers disent que le serveur
répond vite ; les deux autres disent **ce que ça coûte**. Un endpoint peut
répondre 200 en 40 ms à 500 utilisateurs virtuels en ayant appelé l'upstream
500 fois — de l'extérieur, c'est indiscernable d'un cache qui fonctionne. C'est
précisément la différence que ce test existe pour mesurer, et k6 ne peut pas la
voir.

**Un run k6 tout vert dont on n'a pas lu les compteurs ne prouve rien sur le
coût.**

---

## 2. Préparer la cible

### a. Relever le limiteur de débit — sinon le test ne mesure rien

500 utilisateurs virtuels partent de quelques adresses IP. Le limiteur large
(`apiLimiter`) plafonne à 300 req/min/IP en production : il répondrait 429 dès
la première seconde et **le test mesurerait le limiteur, pas l'application**.

```bash
API_RATE_LIMIT=100000
```

C'est le symptôme le plus courant d'un premier run raté : un taux d'erreur
énorme et des latences excellentes. Le script affiche un avertissement dès le
premier 429.

> Cette variable est bruyante en production : le serveur journalise un
> avertissement à chaque démarrage tant qu'elle est présente. **La retirer après
> le test.**

### b. Ouvrir la route de métriques

```bash
ENABLE_DEV_ROUTES=true
```

`/api/dev/*` reste authentifié et réservé au rôle `admin`. En production sans
cette variable, le routeur n'est pas monté du tout.

### c. Neutraliser les clés externes

Selon ce qu'on veut mesurer :

- **Mesurer les caches et la déduplication** → laisser les clés absentes.
  `ODDS_API_KEY` non défini fait répondre `[]` au proxy sans appel sortant ;
  `NHL_USE_MOCK=true` sert des données locales. Le test valide alors la
  mécanique interne, pas les latences réseau.
- **Mesurer des latences réalistes** → clés de test, et surveiller le quota.
  Les compteurs disent exactement combien a été consommé.

Et dans tous les cas, **couper les effets de bord qui sortent du serveur** :

```bash
PUSH_SCAN_ENABLED=false     # sinon le scan pousse de vraies notifications
ODDS_LOG_ENABLED=false      # sinon le tir consomme du quota Odds pour rien
```

Le scan de value bets appelle `getBestBets({limit: 40})` toutes les 30 min : le
laisser tourner pendant le tir ajoute une charge qui n'a rien à voir avec le
scénario, et fausse `caches["best-bets"].misses`, qui est le critère 4.

### d. Récupérer un jeton admin

```bash
TOKEN=$(curl -s -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@…","password":"…"}' | jq -r .accessToken)
```

---

## 3. Lancer

### 3.0 — Premier tir en local (Windows / PowerShell)

Le chemin le plus court pour un premier vrai résultat. Trois terminaux.

**Prérequis : k6.** Une seule fois :

```powershell
winget install k6 --source winget   # ou : choco install k6
k6 version
```

**Terminal 1 — le service ML.** Sans lui, `best-bets` retombe sur les règles, le
disjoncteur s'ouvre au bout de 5 échecs et **le run ne mesure plus le chemin
réel** (`mlCircuit.open` le dira). Si tu acceptes de ne pas mesurer le ML, saute
ce terminal et pose `ML_DISABLED=true` — c'est plus honnête qu'un circuit ouvert.

```powershell
cd C:\Users\irein\dev\ICEEDGE\ml\python
python ml_service.py            # écoute sur :8000
```

**Terminal 2 — l'API.** En local `NODE_ENV` n'est pas `production`, donc
`/api/dev/*` est **déjà monté** : pas besoin de `ENABLE_DEV_ROUTES`. En revanche
le limiteur vaut 2000 req/min hors production, et 500 VUs en produisent environ
20 000 — il faut quand même le relever.

```powershell
cd C:\Users\irein\dev\ICEEDGE\server
$env:API_RATE_LIMIT   = "100000"
$env:PUSH_SCAN_ENABLED= "false"
$env:ODDS_LOG_ENABLED = "false"
$env:NHL_USE_MOCK     = "true"   # ← pour un run qui mesure la mécanique interne
npm run dev                      # écoute sur :3001
```

> ⚠️ **Ces variables sont lues à l'IMPORT des modules.** Les poser dans le
> terminal de k6, ou dans celui du serveur *après* l'avoir démarré, ne fait
> rien du tout — et rien à l'écran ne le signale. C'est ce qui a coûté un run
> complet le 2026-08-03 : le tir mesurait l'API NHL réelle en croyant mesurer
> les caches.
>
> **Vérification en une ligne**, dans les logs de démarrage :
> `[Server] Réglages effectifs` liste `NHL_USE_MOCK`, `NHL_TIMEOUT_MS`,
> `ML_DISABLED`, la présence de `ODDS_API_KEY` et `API_RATE_LIMIT`. Si la ligne
> ne dit pas ce que tu crois avoir posé, ne lance pas les six minutes.

**Terminal 3 — le tir.**

```powershell
cd C:\Users\irein\dev\ICEEDGE
$BASE = "http://localhost:3001"

# Jeton admin (le compte doit être admin : cd server ; npx ts-node scripts/make-admin.ts <email>)
$login = Invoke-RestMethod -Method Post -Uri "$BASE/api/auth/login" `
  -ContentType 'application/json' `
  -Body (@{ email = "ireinahedad@icloud.com"; password = "…" } | ConvertTo-Json)
$H = @{ Authorization = "Bearer $($login.accessToken)" }

# Vérifie l'accès aux compteurs AVANT de tirer 6 minutes
Invoke-RestMethod -Uri "$BASE/api/dev/metrics" -Headers $H | ConvertTo-Json -Depth 4

# Répétition à blanc — 20 s
k6 run -e BASE_URL=$BASE -e PEAK_VUS=20 -e HOLD=20s loadtest/s1-landing.js

# Le tir réel
Invoke-RestMethod -Method Post -Uri "$BASE/api/dev/metrics/reset" -Headers $H | Select-Object reset_at
k6 run -e BASE_URL=$BASE loadtest/s1-landing.js
Invoke-RestMethod -Uri "$BASE/api/dev/metrics" -Headers $H | ConvertTo-Json -Depth 4
```

> **Lancer k6 depuis la racine du dépôt**, pas depuis `loadtest/` : le script
> écrit `loadtest/s1-summary.json` en chemin relatif.

**Faut-il garder la vraie clé The Odds API ?** Oui, et c'est tout l'intérêt :
si le cache fonctionne, les 6 minutes coûtent **2 crédits**. S'il ne fonctionne
pas, la facture le dira — mais on l'apprend alors sur la répétition à blanc de
20 s, pas sur le tir complet. **Lire `upstream.odds.calls` après la répétition
avant d'enchaîner** : au-delà de 2, arrêter et corriger (§5).

**Ce qu'un tir local mesure et ne mesure pas.** Il n'y a ni latence réseau ni
concurrence réelle de conteneur, donc les p95 sont optimistes. En revanche les
critères 3 et 4 — appels upstream et exécutions de cache — sont **exacts** :
ils ne dépendent que de la logique interne. Ce sont eux qui décident.

### Le tir, prêt à copier (bash / préprod)

Les variables de §2 rassemblées. À poser sur la **cible** (le serveur), pas sur
la machine qui lance k6 :

```bash
# Sur la cible, avant de démarrer le serveur
export API_RATE_LIMIT=100000      # sinon on mesure le limiteur (§2a)
export ENABLE_DEV_ROUTES=true     # ouvre /api/dev/metrics (§2b)
export PUSH_SCAN_ENABLED=false    # pas de vraies notifications (§2c)
export ODDS_LOG_ENABLED=false     # pas de quota Odds consommé pour rien
export NHL_USE_MOCK=true          # ← seulement si on mesure les caches, pas le réseau
npm --prefix server run dev       # ou `npm --prefix server start` sur une préprod
```

```bash
# Sur la machine qui tire
export BASE=http://localhost:3001
export TOKEN=$(curl -s -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@…","password":"…"}' | jq -r .accessToken)

# Répétition à blanc — vérifie que la chaîne complète marche avant les 6 minutes
k6 run -e BASE_URL="$BASE" -e PEAK_VUS=20 -e HOLD=20s loadtest/s1-landing.js
```

Si la répétition à blanc rend des 429 ou un 401 sur `/api/dev/metrics`, le vrai
tir ne dira rien de plus : corriger d'abord.

### Le tir réel

```bash
# 1. Fenêtre de mesure propre
curl -s -X POST "$BASE/api/dev/metrics/reset" -H "Authorization: Bearer $TOKEN" | jq .reset_at

# 2. Le tir (≈ 6 min : 60 s de montée + 5 min de maintien)
k6 run -e BASE_URL="$BASE" loadtest/s1-landing.js

# 3. Les compteurs, IMMÉDIATEMENT après
curl -s "$BASE/api/dev/metrics" -H "Authorization: Bearer $TOKEN" | jq .
```

Variables du script : `BASE_URL`, `PEAK_VUS` (défaut 500), `RAMP` (60s),
`HOLD` (5m). Pour une répétition rapide avant le vrai tir :

```bash
k6 run -e BASE_URL="$BASE" -e PEAK_VUS=50 -e HOLD=30s loadtest/s1-landing.js
```

---

## 4. Lire les compteurs

```jsonc
{
  "windowMs": 372000,
  "upstream": {
    "odds": { "calls": 2,  "errors": 0, "avgMs": 210, "maxMs": 480 },
    "nhl":  { "calls": 14, "errors": 0, "avgMs": 95,  "maxMs": 620 },
    "ml":   { "calls": 30, "errors": 0, "avgMs": 180, "maxMs": 900 }
  },
  "caches": {
    "best-bets":     { "hits": 4821, "misses": 3, "dedup": 412, "evictions": 0, "size": 1,   "hitRate": 0.921 },
    "odds":          { "hits": 4903, "misses": 2, "dedup": 331, "evictions": 0, "size": 2,   "hitRate": 0.936 },
    "nhl":           { "hits": 8100, "misses": 14, "dedup": 0,  "evictions": 0, "size": 12,  "hitRate": 0.998 },
    "leaderboard":   { "hits": 4900, "misses": 6, "dedup": 280, "evictions": 0, "size": 1,   "hitRate": 0.945 },
    "mlPredictions": { "hits": 870,  "misses": 30, "dedup": 61, "evictions": 0, "size": 30,  "hitRate": 0.905 },
    "isPro":         { "hits": 0,    "misses": 0,  "dedup": 0,  "evictions": 0, "size": 0,   "hitRate": 0 }
  },
  "eventLoop": { "meanMs": 1.2, "p99Ms": 14.8, "maxMs": 62 },
  "memory":    { "rssMb": 214, "heapUsedMb": 118 },
  "mlCircuit": { "open": false, "failures": 0, "openForMs": 0 }
}
```

Comment lire :

- **`upstream.odds.calls`** → critère 3. Doit être **≤ 2**. Ce compteur agrège
  les *deux* consommateurs du quota : le proxy (`odds.routes.ts`) et
  `oddsClient.ts`, utilisé par le moteur de prédiction.

  > **Comparer ce chiffre au cache `odds` dit LEQUEL des deux a payé.** Le cache
  > `odds` n'appartient qu'au proxy. Un `upstream.odds.calls` élevé avec un cache
  > `odds` à `size: 0` signifie que tout vient d'`oddsClient` — c'est ainsi que le
  > troupeau de la ligne Z a été identifié (26 appels pour **une** exécution de
  > `best-bets`), et c'est le seul moyen de les distinguer.
- **`caches["best-bets"].misses`** → critère 4. C'est le nombre d'exécutions
  **réelles**. Doit être **≤ 5** (6 min de test, TTL 60 s → 6 recalculs légitimes
  au maximum).
- **`dedup`** → requêtes concurrentes rattachées à un calcul déjà en vol. Un
  `dedup` élevé avec `misses` à 1 ou 2 est le signe que la protection
  anti-stampede fonctionne. C'est ce que le scénario S3 isole.

  > **Attendu : `dedup` reste à 0 pour le cache `nhl`, et c'est normal.**
  > `nhlApiClient` déduplique dans `fetchNHL` (au niveau HTTP) et non dans
  > `TtlCache`, donc les rattachements ne sont pas comptés par ce compteur-là.
  > Le bon indicateur pour lui est `upstream.nhl.calls`, qui doit rester
  > constant quand le nombre de VUs augmente. Les caches `best-bets`, `odds` et
  > `leaderboard`, eux, passent par `wrap` et doivent afficher un `dedup` élevé.
- **`evictions`** durablement > 0 → le plafond du cache est trop bas, il se vide
  lui-même et le taux de hit s'effondre. Relever `NHL_CACHE_MAX_ENTRIES` (ou
  l'équivalent) plutôt que d'accepter le gaspillage upstream.
- **`eventLoop.p99Ms`** → au-delà de ~50 ms sous charge, du travail synchrone
  bloque le process. C'est le cœur du scénario S2.
- **`memory.rssMb`** → un seul point ici. La **courbe** est ce qui compte, et
  c'est l'objet de S5 : relever ce champ toutes les 5 min pendant 2 à 4 h.
- **`mlCircuit.open`** → **à lire AVANT de se réjouir d'un `upstream.ml.calls`
  bas.** Un circuit ouvert et un cache efficace produisent tous deux « peu
  d'appels ML », et ce sont deux situations opposées : dans le premier cas le
  service Python est tombé et l'application sert des prédictions par règles. Si
  `open` vaut `true` à la fin du tir, le run ne mesure pas ce qu'on croit.
- **`caches.mlPredictions.misses`** → nombre d'inférences réellement demandées.
  À TTL 5 min sur un tir de 6 min, l'ordre de grandeur attendu est « une fois le
  nombre de matchs/joueurs distincts », pas « une fois par VU ».
- **`caches.isPro`** → reste à 0 sur S1, qui est anonyme. Il devient significatif
  dès qu'un scénario authentifié existe : `misses` doit alors rester très
  inférieur au nombre d'appels aux routes Pro.

---

## 5. Si ça échoue

> **Piège de lecture, appris à la dure.** Un critère vert peut vouloir dire que
> le code concerné **n'a pas tourné**. Pendant deux tirs, `odds.calls` valait 1
> et le critère 3 semblait tenu — parce que l'API NHL était morte, donc zéro
> match, donc aucun pricing. Avant de conclure « c'est bon », vérifier que le
> chemin a bien été exercé : `caches["best-bets"].size > 0`,
> `caches.mlPredictions.misses > 0`, `upstream.nhl.calls > 0` (ou le mock actif).

| Symptôme | Cause probable |
|---|---|
| `upstream.odds.calls` élevé **et** cache `odds` à `size: 0` | le troupeau vient d'`oddsClient`, pas du proxy — c'est la ligne Z, à vérifier en non-régression |
| Beaucoup de 429, latences excellentes | `API_RATE_LIMIT` non relevé — le test mesure le limiteur (§2a) |
| `upstream.odds.calls` ≈ nombre de VUs | le cache du proxy ne fonctionne pas → P0-1 est en régression |
| `best-bets.misses` ≈ nombre de VUs | pas de cache de réponse → P0-2 en régression |
| `misses` élevé **et** `dedup` proche de 0 sur `best-bets`/`odds` | la déduplication en vol ne prend pas ; chaque redéploiement provoquera une tempête |
| `upstream.nhl.calls` proportionnel au nombre de VUs | la déduplication de `fetchNHL` a régressé — `nhlApiClient.test.ts` devrait l'avoir attrapé |
| `evictions` qui grimpe | plafond de cache trop bas pour la diversité des clés |
| p95 correct mais `eventLoop.p99Ms` élevé | travail synchrone sur l'event loop (hachage, gros `JSON.parse`, sérialisation) |
| `upstream.ml.errors` > 0 sous charge | le service Python sature — 2 workers uvicorn |
| `upstream.ml.calls` très bas **et** `mlCircuit.open = true` | le service ML est tombé pendant le tir : l'application a basculé sur les règles. Le run est à refaire, pas à célébrer |
| `mlCircuit.failures` > 0 sans ouverture | échecs intermittents sous les 5 consécutifs — regarder `upstream.ml.errors` et la RAM du service Python |

---

## 6. Banc « troupeau » — décider de migrer `nhlApiClient`

`stampede.ts` répond à une question précise sans serveur, sans base et sans
réseau : **combien d'appels NHL partent quand N requêtes arrivent sur une clé
froide ?** `fetch` est bouchonné, le reste est le vrai code.

```bash
cd server
./node_modules/.bin/ts-node --transpile-only \
  --compiler-options '{"module":"commonjs","resolveJsonModule":true,"esModuleInterop":true}' \
  ../loadtest/stampede.ts
```

Résultat **après correction** (déduplication posée dans `fetchNHL`) :

```
            10 │        200 ms │               1 │         0
           100 │        200 ms │               1 │         0
           500 │        200 ms │               1 │         0
```

Non-régression verrouillée par `server/src/services/nhlApiClient.test.ts`.

Résultat mesuré au 2026-07-28, **avant** correction — conservé comme référence :

```
 N concurrents │ latence amont │ appels NHL émis │ gaspillage
───────────────┼───────────────┼─────────────────┼───────────
            10 │        200 ms │              10 │         9
           100 │        200 ms │             100 │        99
           500 │        200 ms │             500 │       499

 Contrôle — cache chaud, 500 concurrents → 0 appel(s)

 Même charge à travers TtlCache.wrap :
 500 concurrents → 1 appel(s)  (misses=1, dedup=499)
```

Lecture :

- La colonne « appels émis » suit N → **aucune déduplication en vol**.
- Le contrôle à cache chaud rend 0 → le cache lui-même fonctionne ; le trou est
  strictement la fenêtre froide (démarrage, redéploiement, expiration de TTL).
- `wrap` sur la même charge rend 1 → l'écart mesure exactement ce que la
  migration ferait gagner.

Le banc fait arriver tout le monde au même instant : c'est le pire cas. En
trafic réel, seules les requêtes arrivant *pendant* l'appel amont se dupliquent,
soit environ `débit × latence` par fenêtre froide (à 50 req/s et 200 ms : ~10
appels au lieu d'1).

**À rejouer après migration** : les deux blocs doivent alors afficher 1.

---

## 7. Scénarios restants

S2 à S7 ne sont pas encore scriptés. Les compteurs les servent déjà tous :

- **S2** (vague de connexions) → `eventLoop.p99Ms` pendant le tir.
- **S3** (cache froid) → redémarrer le service, 300 requêtes concurrentes sur
  `best-bets`, vérifier `misses === 1`. Ne pas utiliser `/metrics/reset` : il
  remet les compteurs à zéro mais **laisse les caches chauds**, ce qui donnerait
  un faux « 0 exécution ».
- **S5** (endurance) → échantillonner `memory.rssMb` pendant 2 à 4 h ; il doit
  atteindre un plateau.
- **S6** (soirée de matchs) → insérer N tickets pending sur une poignée de
  matchs, les marquer finaux, déclencher une passe. **Le résultat se lit
  directement dans le résumé renvoyé par `settlePendingSlips`** : `exhausted`
  dit si la file a été vidée, `checked`/`settled` donnent le débit. Depuis le lot
  du 2026-08-02, ce n'est plus le plafond de 200 tickets qui arrête la passe mais
  `SETTLEMENT_BUDGET_MS` — le test mesure donc un vrai débit et non une constante.
  Ce qu'il faut surveiller en même temps : `upstream.nhl.calls`, qui doit suivre
  le nombre de MATCHS distincts et non le nombre de tickets (les caches de passe
  sont partagés).
- **S7** (budget) → `upstream.*.calls` sur 24 h, extrapolé à 30 jours et comparé
  aux quotas des plans.

---

## 8. Bancs instrumentés — `bench/`

Les scénarios ci-dessus demandent une cible : un serveur démarré, une base, des
clés. `bench/` répond aux mêmes questions de coût **sans cible du tout**, sur le
vrai code du serveur, avec `fetch` et `pg` bouchonnés et comptés.

```bash
cd server
node ../loadtest/bench/run.js all        # les quatorze bancs, ~12 min
node ../loadtest/bench/run.js smoke      # vérification à blanc, ~5 s
```

| # | Question | Critère |
|---|---|---|
| B1 | Une requête froide émet-elle deux fois le même appel sortant ? | gaspillage = 0 |
| B2 | R requêtes identiques dans le TTL ? | 0 appel après la première |
| B3 | N requêtes simultanées sur clé froide ? (= S3) | 1 exécution, quel que soit N |
| B4 | Le nombre de requêtes SQL suit-il le nombre de lignes ? | constant |
| B5 | Le coût suit-il le nombre de matchs/équipes/joueurs ? | au plus linéaire |
| B6 | Le coût amont suit-il le nombre de visiteurs ? (= S1, S2) | ≈ 0 appel/itération |
| B8 | L'appelant peut-il choisir la clé de cache depuis la query string ? | non |
| B7 | **Les six premiers savent-ils échouer ?** | oui |
| B9 | **Le compteur d'event loop sait-il voir un blocage ?** | oui |
| B10 | Chemins authentifiés : N+1, ouverture de salon, cache `isPro` | SQL constant |
| B11 | Socket.io, arrivée simultanée (= S4 mono-instance) | fan-out linéaire |
| B12 | Deux instances : un message traverse-t-il ? (ligne D) | sans `REDIS_URL` : non · avec : **oui** |
| B13 | Endurance / fuite mémoire (= S5) | plateau |
| B14 | Soirée de règlement (= S6) | file vidée |

Ce qu'ils remplacent : rien. k6 mesure ce que voit le client contre une vraie
cible ; ces bancs mesurent ce que le serveur **émet et recalcule**, et ils le
font sans consommer un crédit ni démarrer quoi que ce soit — donc on peut les
lancer à chaque modification plutôt qu'une fois par trimestre.

Ce qu'ils NE mesurent pas : les latences réelles (l'amont est bouchonné), la
qualité du SQL, Socket.io (S4), l'endurance (S5) et le règlement de soirée (S6).

Les sept scénarios S1-S7 sont couverts par ces bancs, multi-instance de S4
compris : B12 démarre deux applications complètes dans deux processus. Il rend
✗ sans `REDIS_URL` — le comportement correct à une instance — et ✓ avec, depuis
que l'adaptateur Redis est livré (2026-09-19 ; voir
`RAPPORT_TESTS_CHARGE_2026-09-18.md`, addenda 3 et 5).

Détail, pièges et façon de lire : **`bench/README.md`**.
Dernier passage complet : `RAPPORT_TESTS_CHARGE_2026-09-18.md` (racine du dépôt).
