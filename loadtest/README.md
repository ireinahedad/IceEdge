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

### d. Récupérer un jeton admin

```bash
TOKEN=$(curl -s -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@…","password":"…"}' | jq -r .accessToken)
```

---

## 3. Lancer

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
    "best-bets": { "hits": 4821, "misses": 3, "dedup": 412, "evictions": 0, "size": 1, "hitRate": 0.921 },
    "odds":      { "hits": 4903, "misses": 2, "dedup": 331, "evictions": 0, "size": 2, "hitRate": 0.936 }
  },
  "eventLoop": { "meanMs": 1.2, "p99Ms": 14.8, "maxMs": 62 },
  "memory":    { "rssMb": 214, "heapUsedMb": 118 }
}
```

Comment lire :

- **`upstream.odds.calls`** → critère 3. Doit être **≤ 2**. Ce compteur agrège
  les *deux* consommateurs du quota : le proxy (`odds.routes.ts`) et
  `oddsClient.ts`, utilisé par le moteur de prédiction.
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

---

## 5. Si ça échoue

| Symptôme | Cause probable |
|---|---|
| Beaucoup de 429, latences excellentes | `API_RATE_LIMIT` non relevé — le test mesure le limiteur (§2a) |
| `upstream.odds.calls` ≈ nombre de VUs | le cache du proxy ne fonctionne pas → P0-1 est en régression |
| `best-bets.misses` ≈ nombre de VUs | pas de cache de réponse → P0-2 en régression |
| `misses` élevé **et** `dedup` proche de 0 sur `best-bets`/`odds` | la déduplication en vol ne prend pas ; chaque redéploiement provoquera une tempête |
| `upstream.nhl.calls` proportionnel au nombre de VUs | la déduplication de `fetchNHL` a régressé — `nhlApiClient.test.ts` devrait l'avoir attrapé |
| `evictions` qui grimpe | plafond de cache trop bas pour la diversité des clés |
| p95 correct mais `eventLoop.p99Ms` élevé | travail synchrone sur l'event loop (hachage, gros `JSON.parse`, sérialisation) |
| `upstream.ml.errors` > 0 sous charge | le service Python sature — 2 workers uvicorn |

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
- **S7** (budget) → `upstream.*.calls` sur 24 h, extrapolé à 30 jours et comparé
  aux quotas des plans.
