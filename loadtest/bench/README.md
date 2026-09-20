# Bancs instrumentés — ce que k6 ne peut pas voir

Quatorze bancs qui répondent chacun à **une** question de coût, sur le **vrai code**
du serveur, sans base, sans réseau et sans quota consommé.

Ils ne remplacent pas `loadtest/s1-landing.js` : k6 mesure ce que voit le
client (latence, taux d'erreur, débit) contre une vraie cible. Ces bancs
mesurent ce que le serveur **émet et recalcule**, ce qui est invisible de
l'extérieur — et c'est ce qui décide de la facture.

> Un endpoint qui répond 200 en 40 ms à 500 visiteurs peut avoir appelé
> l'amont 500 fois ou 1 fois. De l'extérieur, c'est indiscernable.

---

## Lancer

Depuis `server/` (c'est là que sont les dépendances) :

```bash
node ../loadtest/bench/run.js all        # les quatorze, ~12 min
node ../loadtest/bench/run.js smoke      # vérification à blanc, ~5 s
node ../loadtest/bench/run.js b3-dedup   # un banc précis
```

Sur Windows / PowerShell, exactement la même chose :

```powershell
cd C:\Users\irein\dev\ICEEDGE\server
node ..\loadtest\bench\run.js all
```

Aucun prérequis au-delà d'un `npm install` dans `server/` : `socket.io-client`
(devDependency, pour B11) y est déclaré. Ni k6, ni Postgres, ni service ML, ni
clé API, ni serveur démarré. **Rien ne sort de la machine** — c'est le point : un tir contre la
production viderait le quota The Odds API en quelques secondes.

`all` écrit aussi `loadtest/bench-results.json` (résultats bruts, pour comparer
deux exécutions).

### Réglages

| Variable | Défaut | Effet |
|---|---|---|
| `BENCH_SECONDS` | 90 (45 via `all`) | durée d'une phase de B6 |
| `BENCH_VUS` | 40 | utilisateurs virtuels de B6 |
| `BENCH_LOGINS` | 60 | connexions de la vague de B6 |
| `BENCH_LEVELS` | `10,50,200` | paliers de concurrence de B3 |
| `BENCH_ROWS_LEVELS` | `5,100` | tailles de données de B4 |
| `BENCH_WINDOW_MS` | 3000 | durée d'une fenêtre de mesure de B9 |
| `BENCH_SOCKET_LEVELS` | `25,100,300` | paliers de sockets de B11 |
| `BENCH_ROOM_INTERVAL_MS` | 1000 | coalescence du compte de présence, pour B11 |
| `BENCH_ENDURANCE_SECONDS` | 180 (120 via `all`) | durée de B13 |
| `BENCH_SLIP_LEVELS` | `200,1000` | nombre de tickets en attente, pour B14 |
| `BENCH_GAMES_FINAL` | 10 | matchs sur lesquels portent les tickets de B14 |
| `REDIS_URL` | absente | **lue par le serveur, pas par le banc** : posée, elle fait basculer B12 sur l'adaptateur Redis — voir plus bas |

---

## Les quatorze bancs

| # | Question | Critère |
|---|---|---|
| **B1** | Une requête HTTP froide émet-elle deux fois le même appel sortant ? | gaspillage = 0 |
| **B2** | R requêtes identiques dans le TTL : combien d'appels ? | 0 après la première |
| **B3** | N requêtes **simultanées** sur une clé froide : combien d'exécutions ? | 1, quel que soit N |
| **B4** | Le nombre de requêtes SQL suit-il le nombre de lignes ? | constant |
| **B5** | Le coût d'une exécution suit-il le nombre de matchs/joueurs ? | au plus linéaire |
| **B6** | Le coût amont suit-il le nombre de visiteurs ? Les lectures tiennent-elles pendant une vague de connexions ? | ≈ 0 appel/itération ; p95 stable |
| **B8** | L'appelant peut-il CHOISIR la clé de cache depuis la query string ? | non |
| **B10** | Chemins authentifiés — N+1 sur les listings, coût d'une ouverture de salon, cache `isPro` | SQL constant ; `isPro` ~0 lecture |
| **B11** | Socket.io : arrivée simultanée dans un salon (S4) — amplification et coût Neon | fan-out linéaire ; ~0 requête par arrivée |
| **B14** | Soirée de règlement (S6) — la file se vide-t-elle, et à quel coût ? | `exhausted` vrai ; appels NHL = nb de matchs |
| **B13** | Endurance / fuite mémoire (S5) — le RSS atteint-il un plateau ? | plateau, dans le bruit du relevé |
| **B12** | Deux instances : un message traverse-t-il ? (ligne D) | sans `REDIS_URL` : **non** · avec : **oui** |
| **B7** | **Les six premiers savent-ils échouer ?** | oui |
| **B9** | **Le compteur d'event loop sait-il voir un blocage ?** | oui |

**B8 pose la question que B2 et B3 ne posent pas.** Ceux-là vérifient qu'UNE clé
est bien cachée et bien dédoublonnée — et elle l'est. Mais un cache parfait sur
chaque clé ne protège de rien si l'appelant choisit la clé : il lui suffit d'en
demander une nouvelle à chaque requête. Le cache reste intact, et inutile.

**B12 a deux modes, et c'est le même banc.** Il démarre deux applications
complètes dans deux processus, branche un lecteur sur chacune, et poste un
message sur la première. Ce qu'il rend dépend d'une seule variable
d'environnement, lue par le **serveur** :

| | `REDIS_URL` absente | `REDIS_URL` posée |
|---|---|---|
| trames reçues sur A / sur B | 1 / **0** | 1 / **1** |
| « N en ligne » annoncé par A / par B | 1 / 1 | **2 / 2** |
| verdict | ✗ attendu — adaptateur mémoire | ✓ non-régression |

Sans Redis, ce ✗ n'est pas un défaut de ce dépôt : c'est le comportement correct
d'un déploiement à une instance. **La suite `all` tourne sans Redis**, donc B12
y compte pour le seul ✗ — volontairement.

Pour le voir passer au vert, il faut un Redis joignable :

```bash
# un Redis local quelconque suffit — rien n'y est écrit de durable
redis-server --port 6399 --daemonize yes
cd server && REDIS_URL=redis://127.0.0.1:6399 node ../loadtest/bench/run.js b12-multiinstance
```

```powershell
# PowerShell
cd C:\Users\irein\dev\ICEEDGE\server
$env:REDIS_URL = 'redis://127.0.0.1:6399'
node ..\loadtest\bench\run.js b12-multiinstance
Remove-Item Env:REDIS_URL
```

C'est ce banc, et lui seul, qui prouve que l'adaptateur fait son travail : la
bannière de démarrage dit quel adaptateur est **chargé**, pas qu'un message
**traverse**. Deux pièges qu'il a déjà attrapés, et qui expliquent sa forme :

- **La colonne « N en ligne » est mesurée séparément de la diffusion**, parce que
  les deux ne viennent pas du même mécanisme. `io.in(salon).allSockets()` et
  `adapter.sockets()` restent **locaux** même avec un adaptateur ; seul
  `fetchSockets()` interroge le cluster. Un message qui traverse pendant que le
  compte reste à 1 est donc un état possible — et c'est celui qui a été trouvé,
  puis corrigé, le 2026-09-19.
- **`harness.close()` ferme les clients Redis.** Sans ça, ils gardent l'event
  loop ouverte : le banc se termine, affiche son verdict, et le processus reste
  en vie — un orchestrateur qui attend sa sortie attend pour toujours.

**B7 et B9 sont les deux contrôles, et ils closent la série.** Les autres
rendent « ✓ » ; un banc qui ne peut pas échouer ne prouve rien, et un « ✓ » veut
parfois dire « le code surveillé n'a pas tourné » — le piège du README §5, où
`odds.calls` valait 1 parce que l'API NHL était morte. B7 casse la déduplication
en mémoire et vérifie que B3 le voit. B9 bloque délibérément l'event loop et
vérifie que le compteur de `metrics.ts` bouge — parce qu'un critère qu'on ne
peut pas rater n'est pas un critère tenu.

---

## Comment c'est construit

```
harness.ts    pose l'environnement, installe les bouchons, PUIS importe app.ts,
              démarre un vrai serveur HTTP sur un port éphémère et le pilote
              avec le module `http` (pas `fetch`, qui est bouchonné)
upstream.ts   amont synthétique : NHL, The Odds API, service ML. Compte chaque
              appel (méthode + URL + corps), simule une latence, et sert une
              ligue de taille PARAMÉTRABLE — c'est l'axe de B5
pgstub.ts     Postgres bouchonné et compté ; le nombre de lignes rendues est
              réglable — c'est l'axe de B4
spawn.ts      un processus par palier : la seule façon d'avoir un cache froid
run.js        lanceur (résolution de ts-node/typescript depuis server/)
```

**Ce qui est du vrai code :** tout sauf `fetch` et `pg`. Les routes, les
middlewares, le limiteur, les caches `TtlCache`, la déduplication de `fetchNHL`,
le disjoncteur ML, bcrypt — importés tels quels depuis `server/src`.

### Trois pièges, et comment ils sont traités

**L'ordre d'import.** `NHL_USE_MOCK`, `ODDS_API_KEY`, `API_RATE_LIMIT` et
`ML_DISABLED` sont lus **à l'import des modules**. `boot()` pose donc
l'environnement avant le premier `import` applicatif. C'est le défaut qui a
coûté deux tirs complets en août 2026.

**Un processus par palier.** `resetMetrics()` remet les compteurs à zéro mais
**ne vide pas les caches**. Mesurer deux paliers dans le même processus rendrait
le premier à froid et tous les suivants à chaud, dans la même colonne.

**Où lire la vérité.** `best-bets`, `odds` et `leaderboard` passent par
`TtlCache.wrap`, qui compte lui-même ses trois issues : `misses` y est le nombre
d'**exécutions réelles**. `nhlApiClient` ne passe pas par `wrap` — il déduplique
plus bas, dans `fetchNHL` — donc son `misses` compte N clés froides pour **un
seul** appel sortant. Pour lui, la vérité est `upstream.nhl.calls`. B3 applique
cette distinction au lieu de la rappeler en note de bas de page.

---

## Ce que ces bancs ne mesurent pas

- **Les latences réelles.** L'amont est bouchonné, la base aussi : les p50/p95
  affichés décrivent le coût CPU du serveur, pas ce que verra un visiteur.
  Pour ça, `s1-landing.js` contre une préproduction.
- **Le SQL lui-même.** Le bouchon compte les requêtes ; il ne dira jamais qu'un
  index manque. Il dit **combien de fois** le code parle à la base.
- **La concurrence réelle d'un conteneur**, le réseau, PgBouncer, Cloudflare.
- **Une fuite mémoire LENTE.** B13 tourne quelques minutes et affiche la pente
  qu'il sait résoudre ; quelques mégaoctets par heure lui échappent. Pour
  celle-là, relever `memory.rssMb` sur `/api/dev/metrics` en préproduction
  pendant une vraie soirée.
- **Le débit RÉEL du règlement.** B14 compte les allers-retours et le CPU ; ce
  que Neon fera d'un `UPDATE` un soir de match, lui seul le dira.
