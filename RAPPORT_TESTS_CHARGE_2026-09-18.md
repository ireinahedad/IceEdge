# Tests de charge légère — endpoints critiques ARAKICE / ICEEDGE

**Date :** 2026-09-18 · **Cible :** aucune. Tout a tourné sur le vrai code du
serveur, en mémoire, avec l'amont et Postgres bouchonnés. **Zéro requête vers la
production, zéro crédit The Odds API consommé, zéro notification push envoyée.**

**Portée demandée :** `/api/predict/best-bets`, `/api/nhl/*`, `/api/odds/*` et
l'authentification. Six phénomènes à détecter : multiplication des requêtes,
absence de déduplication, absence de cache, N+1, explosion avec le nombre de
matchs/équipes/joueurs, comportement multi-utilisateurs.

---

## Verdict

**Les six phénomènes ont été cherchés. Aucun n'a été trouvé.** Les corrections
du lot d'août 2026 (lignes X, Y, Z de l'audit) tiennent sous mesure, et deux
d'entre elles sont maintenant démontrées plutôt que raisonnées.

Le chiffre le plus parlant : **42 282 requêtes HTTP servies en 45 s à 40
utilisateurs simultanés, pour 1 seul appel sortant.** Le coût amont ne suit pas
le nombre de visiteurs — c'est la thèse centrale de `AUDIT_SCALABILITE_COUTS.md`,
et elle est vérifiée.

| Banc | Question | Résultat |
|---|---|---|
| B1 | Une requête froide émet-elle deux fois le même appel ? | **0 gaspillage** sur les 10 endpoints |
| B2 | 20 requêtes identiques dans le TTL ? | **0 appel** après la première, partout |
| B3 | 200 requêtes simultanées sur cache froid ? | **1 exécution**, 199 rattachées |
| B4 | Le SQL suit-il le nombre de lignes ? | **constant** de 5 à 100 lignes |
| B5 | 4 matchs → 16 matchs, 10 joueurs → 50 ? | sujets ×4,7 → appels **×1,4** |
| B6 | 40 utilisateurs pendant 45 s ? | **0,00 appel/itération**, 0 erreur |
| B7 | **Ces bancs savent-ils échouer ?** | **oui** — voir plus bas |

---

## Ce que chaque banc a mesuré

### B1 · Multiplication des requêtes

Une requête HTTP sur un cache entièrement froid, un processus par endpoint.
La colonne qui compte est **gaspillage = appels émis − appels distincts**
(méthode + URL + corps) : elle vaut 0 partout.

| endpoint | appels | dont distincts | gaspillage | nhl | odds | ml | sql |
|---|---|---|---|---|---|---|---|
| best-bets | 51 | 51 | **0** | 34 | 1 | 16 | 3 |
| games-live | 1 | 1 | 0 | 1 | 0 | 0 | 0 |
| games-date | 1 | 1 | 0 | 1 | 0 | 0 | 0 |
| odds-h2h | 1 | 1 | 0 | 0 | 1 | 0 | 1 |
| odds-totals | 1 | 1 | 0 | 0 | 1 | 0 | 1 |
| leaderboard | 0 | 0 | 0 | 0 | 0 | 0 | 2 |
| teams / standings | 1 | 1 | 0 | 1 | 0 | 0 | 0 |
| players | 2 | 2 | 0 | 2 | 0 | 0 | 0 |
| predictions/team | 3 | 3 | 0 | 3 | 0 | 0 | 0 |

**Les 51 appels de `best-bets` sont un coût de DÉMARRAGE, pas un coût par
minute.** B6 le montre : une fois les caches NHL chauds (6 h pour les calendriers
d'équipe, 10 min pour les joueurs), un recalcul de `best-bets` coûte **1 appel
sortant**, pas 51. Les 51 sont payés une fois par redéploiement.

> Piège évité : les 16 inférences ML sont 16 POST sur **deux** URL. Compter par
> URL les aurait fait passer pour 14 doublons. La clé de comptage inclut donc le
> corps de la requête.

### B2 · Absence de cache

20 requêtes identiques dans le TTL, un processus par endpoint.
**Appels sortants après la première : 0 sur les dix endpoints.** Requêtes SQL à
chaud : 0 également.

Le `Cache-Control` renvoyé est présent partout, aligné sur les TTL serveur
(`best-bets` et odds : `max-age=60, stale-while-revalidate=300` ; matchs en
direct : 30 s ; joueurs : 600 s). Derrière Cloudflare, ces requêtes n'atteindront
même pas le serveur.

### B3 · Absence de déduplication (scénario S3 de l'audit)

N requêtes **simultanées** sur une clé froide, un processus neuf par palier —
la seule façon d'avoir un cache réellement froid, puisque `/metrics/reset` ne
vide pas les caches.

| endpoint | N=10 | N=50 | N=200 | lu sur |
|---|---|---|---|---|
| best-bets | 1 exéc. / 9 rattachées | 1 / 49 | **1 / 199** | `cache best-bets` |
| odds-h2h | 1 / 9 | 1 / 49 | **1 / 199** | `cache odds` |
| teams | 1 appel amont | 1 | **1** | `upstream.nhl.calls` |
| games?date= | 1 appel amont | 1 | **1** | `upstream.nhl.calls` |

`best-bets` reste à **51 appels sortants** que N vaille 10 ou 200 : la
protection anti-troupeau tient à l'échelle d'un redéploiement.

> **Où lire la vérité change selon le cache**, et le banc l'applique tout seul.
> `best-bets` et `odds` passent par `TtlCache.wrap`, qui compte ses trois issues :
> `misses` y est le nombre d'exécutions réelles. `nhlApiClient` déduplique plus
> bas, dans `fetchNHL`, donc son `misses` compte N clés froides pour **un seul**
> appel sortant. Lire `misses` sur les lignes NHL ferait crier au troupeau sur du
> code sain — c'est la note du README §4, ici transformée en règle exécutable.

### B4 · Requêtes N+1

Même requête HTTP servie avec 5 lignes puis 100 lignes en base. Un N+1 se
traduirait par « 1 + nombre de lignes » ; le compte est **identique** :

| endpoint | 5 lignes | 100 lignes | à chaud |
|---|---|---|---|
| leaderboard | 2 | **2** | 0 |
| best-bets | 3 | **3** | 0 |
| odds-h2h | 1 | **1** | 0 |
| auth/me | 0 | 0 | 0 |
| auth/login | 3 | 3 | 3 |

Le classement fait bien 2 requêtes et non 21 : le comptage des paris est agrégé
côté Postgres, comme le commentaire de `profile.service.ts` l'annonce.

**Une observation, pas un défaut :** `auth/login` émet 3 requêtes dont un
`INSERT INTO user_profiles … ON CONFLICT DO NOTHING` **à chaque connexion**,
y compris pour un compte qui a son profil depuis des mois. C'est une écriture
inutile par connexion, qui prend une place dans le pool Neon. Le commentaire du
code l'assume (« safety net for old accounts ») ; à 200 connexions par vague,
ça reste 200 écritures pour rien. Un `SELECT` d'abord, ou le retrait pur et
simple une fois les vieux comptes rattrapés, est le seul point d'optimisation que
ces bancs ont trouvé.

### B5 · Explosion avec le nombre de matchs / équipes / joueurs

Une exécution froide de `best-bets` par taille de ligue, processus neuf à chaque
palier.

| équipes | matchs | joueurs | candidats | nhl | ml | odds | appels | **appels/sujet** |
|---|---|---|---|---|---|---|---|---|
| 8 | 4 | 10 | 80 | 25 | 15 | 1 | 41 | 2,93 |
| 16 | 8 | 20 | 140 | 34 | 16 | 1 | 51 | 1,82 |
| 24 | 12 | 30 | 180 | 36 | 16 | 1 | 53 | 1,26 |
| 32 | 16 | 50 | 220 | 40 | 17 | 1 | 58 | **0,88** |

**Sujets ×4,7 → appels sortants ×1,4.** La croissance est *sous*-linéaire : la
part fixe (classement, résumé de ligue, cotes) est partagée par tous les matchs,
et les appels par sujet se diluent.

Trois garde-fous vérifiés :

- **The Odds API : 1 appel par exécution**, que la soirée compte 4 ou 16 matchs.
  C'est le seul amont facturé à l'appel — c'est là que la ligne Z faisait mal
  (26 appels pour une exécution) et c'est réglé.
- **Inférences ML plafonnées à 17** au palier le plus gros, loin de `mlDepth=30`.
  Le plafond ne dépend pas du calendrier : la facture Python ne suivra pas un
  samedi soir chargé.
- **SQL constant à 3** quelle que soit la taille.

### B6 · Plusieurs utilisateurs simultanés (charge légère)

40 utilisateurs virtuels, 45 s par phase, latences amont réalistes simulées
(NHL 120 ms, odds 200 ms, ML 60 ms, SQL 8 ms).

| | phase A (lectures) | phase B (+ 60 connexions) |
|---|---|---|
| itérations | 7 047 | 7 042 |
| requêtes HTTP | 42 282 | 42 252 |
| erreurs | **0 (0,00 %)** | **0 (0,00 %)** |
| 429 (limiteur) | 0 | 0 |
| p50 / p95 lectures | 3 / 9 ms | 3 / 9 ms |
| **appels amont** | **1** | **2** |
| appels / itération | **0,00** | **0,00** |
| requêtes SQL | 0 | 184 |
| event loop p99 | 26,2 ms | 25,3 ms |
| RSS | 427 Mo | 455 Mo |

Connexions : 60 tentées, 0 en erreur, p50 165 ms, p95 174 ms — c'est le coût de
bcrypt, et il est stable.

**Le point du scénario S2 est tenu :** le p95 des routes de lecture est
**identique** pendant la vague de connexions (×1,00). bcrypt via `@node-rs/bcrypt`
travaille hors de l'event loop ; il ne bloque pas les lectures.

Taux de hit en fin de phase : `best-bets` 99,9 %, `odds` 100 %, `nhl` 99,7 %,
`leaderboard` 100 %.

> ⚠️ **Les latences de ce tableau ne prédisent rien sur la production.** L'amont
> et la base sont bouchonnés ; ces p95 mesurent le coût CPU du serveur, pas ce
> que verra un visiteur. Ce sont les **compteurs** qui sont exacts, parce qu'ils
> ne dépendent que de la logique interne. Pour les latences réelles :
> `loadtest/s1-landing.js` contre une préproduction.

### B7 · Contrôle négatif — le banc sait-il échouer ?

Six « ✓ » d'affilée, c'est le moment de se méfier : un critère vert veut parfois
dire que le code surveillé n'a pas tourné. B7 neutralise en mémoire la
déduplication de `TtlCache.wrap`, puis rejoue B3 à N=50.

| endpoint | code sain | déduplication cassée | |
|---|---|---|---|
| best-bets | 1 exéc. / **51 appels** | **3 034 appels** | ✓ détecté |
| odds-h2h | 1 exéc. / **1 appel** | **50 appels** | ✓ détecté |

Le code de production n'est pas modifié : le remplacement vit et meurt dans le
processus enfant.

Cette ligne chiffre aussi ce que la correction achète : **50 visiteurs
simultanés = 50 crédits The Odds API sans déduplication, 1 avec.**

---

## Ce qui n'a pas été mesuré

- **Latences et débit réels** → `loadtest/s1-landing.js` contre une préproduction.
- **Le SQL lui-même** : les bancs comptent les requêtes, ils ne diront jamais
  qu'un index manque.
- **Socket.io / salons de chat** (S4), **endurance 2-4 h** (S5), **soirée de
  règlement** (S6) : ces trois-là demandent autre chose qu'un banc en process.
- **Le disjoncteur ML sous panne réelle** : le bouchon répond toujours.

---

## Livrable

`loadtest/bench/` — 7 bancs, un harnais, deux bouchons, un lanceur, un README.

```bash
cd server
node ../loadtest/bench/run.js all      # les sept, ~4 min
node ../loadtest/bench/run.js smoke    # vérification à blanc, ~5 s
node ../loadtest/bench/run.js b3-dedup # un banc précis
```

Aucun prérequis : ni k6, ni Postgres, ni service ML, ni clé API, ni serveur
démarré. Rien ne sort de la machine. `all` écrit aussi
`loadtest/bench-results.json` pour comparer deux exécutions.

Ce qui est du vrai code : **tout sauf `fetch` et `pg`**. Routes, middlewares,
limiteur, `TtlCache`, déduplication de `fetchNHL`, disjoncteur ML, bcrypt —
importés tels quels depuis `server/src`.

Les trois pièges traités par construction (ordre d'import des variables
d'environnement, un processus par palier pour un cache réellement froid, et où
lire la vérité selon le cache) sont documentés dans `loadtest/bench/README.md`.

---

# Addendum — corrections appliquées le 2026-09-18

Deux bancs de plus (B8, B9) ont trouvé ce que les six premiers ne cherchaient
pas. Quatre correctifs livrés, chacun avec sa mesure avant/après et son test de
non-régression. `tsc --noEmit` propre, 453 tests verts, suite complète à
**17 ✓ / 0 ✗**.

## 1. La clé de cache de `best-bets` était pilotable depuis l'URL — corrigé

B2 et B3 vérifiaient qu'UNE clé est bien cachée et bien dédoublonnée. Elle
l'était. Ils ne demandaient pas : *et si l'appelant choisit la clé ?*

`limit` entrait dans la clé alors qu'il ne fait que TRONQUER une liste déjà
triée. Résultat : 50 façons de demander la même chose = 50 calculs, dans un
cache de 50 entrées.

| balayage (caches NHL chauds) | avant | après |
|---|---|---|
| `?limit=1..20` | **19 recalculs** / 20 req, ~40 ms chacun | **0 recalcul**, 20 hits |
| `?players=1..20` | 19 recalculs, 21 appels NHL | 1 recalcul, 16 appels |
| `?days=1..7` | 6 recalculs, 5 appels NHL | 2 recalculs, 1 appel |
| entrées du cache après balayage | 46 / 50 | **4 / 50** |

Ce que ça valait : `best-bets` n'est pas sous `predictLimiter`, seulement sous
`apiLimiter` — **300 req/min/IP en production**. Une seule adresse pouvait donc
commander 300 recalculs par minute (~12 s de CPU par minute sur une instance) et
contourner intégralement la protection anti-troupeau que B3 venait de prouver :
celle-ci ne protège qu'UNE clé, et l'appelant choisissait la sienne.

- `bestBets.service.ts` — clé = `days|maxPlayers|source|mlDepth`. On calcule au
  plafond (`LIMIT_MAX = 50`), on met CELA en cache, on tranche à la sortie.
  Réponses identiques à l'octet près pour tout `limit ≤ 50`.
- `ml.routes.ts` — liste blanche `BEST_BETS_DAYS = [1,2,3]` et
  `BEST_BETS_PLAYERS = [0,15,30]`. Ces deux-là changent réellement le calcul,
  donc leur place dans la clé est justifiée ; c'est le NOMBRE de valeurs
  joignables qui devait être fermé. Espace de clés : **28 700 → 18**.

**La règle générale, qui vaut au-delà d'ici :** un paramètre qui change la
PRÉSENTATION d'un résultat n'a rien à faire dans la clé du cache ; seuls ceux
qui changent le CALCUL y ont leur place. Et borner un intervalle borne la
MÉMOIRE du cache, pas le TRAVAIL qu'un appelant peut commander.

## 2. Le compteur d'event loop ne pouvait pas voir un blocage — corrigé

Le critère S2 de l'audit est « `eventLoop.p99Ms` ne doit pas grimper ». En
bloquant délibérément le process 30-60 ms par tour de boucle :

| résolution | repos p99 | bloqué p99 | écart |
|---|---|---|---|
| **20 ms (avant)** | 22,7 | 27,7 | **×1,2** |
| 5 ms | 6,9 | 13,8 | ×2,0 |
| **1 ms (après)** | 2,0 | 8,4 | **×4,2** |

La résolution est le PLANCHER de mesure : à 20 ms, un process réellement bloqué
ne se distinguait du repos que d'un facteur 1,2, c'est-à-dire dans le bruit. S2
n'était pas *tenu*, il était **impossible à rater**. Ça explique aussi
rétroactivement le « mean 30,5 / p99 34,4 » du tir du 2026-08-03 qu'on avait mis
sur le dos de Windows : c'était surtout le plancher.

`metrics.ts` expose désormais `EVENT_LOOP_RESOLUTION_MS` (défaut 1), que B6 et
B9 lisent au lieu d'une constante recopiée — un banc qui se trompe sur ce qu'il
teste est pire que pas de banc.

## 3. Une écriture inutile à chaque connexion — corrigée

`auth/login` émettait un `INSERT INTO user_profiles … ON CONFLICT DO NOTHING`
à chaque connexion, y compris pour un compte dont le profil existe depuis des
mois. Pas un N+1 : plus discret. Une écriture Postgres prend le chemin
d'écriture même quand elle n'insère rien, et sur Neon derrière PgBouncer elle
prend une place dans un pool qui en a dix — autant de places retirées, pendant
une vague de connexions, aux requêtes qui servent quelqu'un.

**3 → 2 requêtes SQL par connexion.** Les deux restantes sont nécessaires
(lecture du compte, création du refresh token). Un cache TTL 1 h
(`profileEnsured`, visible dans `/api/dev/metrics`) fait qu'une connexion
répétée n'émet plus rien pour ce contrôle. Le `ON CONFLICT DO NOTHING` reste la
garantie réelle ; le raccourci ne s'applique jamais dans une transaction, où la
ligne n'est pas encore validée. Sens de la panne choisi : jamais « profil
manquant », au pire « écriture en trop ».

## 4. Le cache `manual` ne servait jamais — corrigé

Il affichait `hits 0 / misses 2 / dedup 28` sous charge. TTL 30 s contre un
recalcul de `best-bets` toutes les 60 s : chaque lecture retombait dans la
fenêtre où l'entrée venait d'expirer.

Et l'aligner à 60 s n'aurait rien réglé — à 60 contre 60, l'entrée expire à
l'instant où la passe suivante la demande : un tirage au sort, pas un cache. Il
faut la marge. **TTL 90 s**, vérifié sur deux passes espacées de 65 s :

| | avant | après |
|---|---|---|
| requêtes `manual_data` au 2ᵉ recalcul | 2 | **0** |
| cache `manual` | 0 hit | **30 hits, 50 %** |

Contrepartie assumée : une saisie manuelle met jusqu'à 90 s au lieu de 30 à se
voir. Les écritures invalident déjà explicitement leurs clés, donc le délai ne
concerne que les autres instances.

## 5. Réchauffage au démarrage — livré, mais OPT-IN

`BEST_BETS_WARMUP=true` dans `server.ts`. Un cache froid coûte ~51 appels
sortants et ~600 ms au premier visiteur après chaque redéploiement ; le
réchauffage déplace cette attente vers le démarrage. Mais il coûte **1 crédit
The Odds API par déploiement** — à vingt déploiements par mois sur une clé
gratuite de 500, ce n'est pas gratuit. D'où le drapeau plutôt qu'un
comportement imposé. `DORMANT` l'emporte.

---

## Ce qui reste non mesuré

Inchangé : routes Pro (`isPro` est resté à zéro sur toute la campagne), chat,
tickets, Socket.io (S4), endurance 2-4 h (S5), soirée de règlement (S6). Et les
latences de ces bancs ne prédisent toujours rien sur la production — seuls les
compteurs sont exacts.

Sortie complète du dernier passage : `loadtest/bench-sortie-2026-09-18.txt`.

---

# Addendum 2 — couverture étendue, 2026-09-19

La première campagne n'avait mesuré que l'anonyme. Deux bancs de plus couvrent
maintenant les chemins authentifiés (**B10**) et Socket.io (**B11**). Ils ont
trouvé deux défauts, tous deux corrigés. Suite complète : **23 ✓ / 0 ✗**,
`tsc --noEmit` propre, **456 tests verts** (3 nouveaux).

## B10 · Chemins authentifiés — Pro, tickets, chat

Même méthode que B4 : la même requête HTTP servie avec 5 lignes puis 100, un
processus par palier.

| endpoint | froid | chaud | |
|---|---|---|---|
| subscription/me | 1 | 1 | |
| slips | 1 | 1 | |
| users/me | 2 | 2 | **était 3** |
| users/me/bets · stats | 1 | 1 | |
| summary (Pro) | 3 | **2** | la 3ᵉ est la lecture d'entitlement, une seule fois |
| chat/rooms | 1 | 1 | une seule requête pour toutes les cartes |
| chat/messages | 3 | **2** | 100 messages + leurs réactions |
| chat/members | 2 | 2 | |

**Aucun N+1** : le compte est identique à 5 et à 100 lignes, partout.

**Le critère S4 est tenu sur le chemin HTTP** : ouvrir un salon de 100 messages
coûte 3 requêtes Neon (la ligne de salon, les messages, les réactions groupées),
pas 100. Le `WHERE message_id = ANY($1)` de `fetchReactions` fait son travail.

**Le cache `isPro` est enfin mesuré.** Il était resté à zéro sur toute la
première campagne : aucun banc ne touchait de route Pro, donc le cache de
l'audit (ligne L) n'avait jamais été exercé. Résultat : **0 lecture en base
pour 30 requêtes Pro**, 30 hits.

> Deux pièges de méthode, réglés dans le banc plutôt que signalés en note :
> `requireProForOthers` laisse passer quand on regarde SON PROPRE profil — viser
> son propre id mesurait un chemin sans porte Pro. Et `requirePro` court-circuite
> `isPro` pour un compte **admin** : un banc connecté en admin traverse toutes les
> portes sans jamais toucher le cache. B10 vise autrui, connecté en simple membre.

### Défaut trouvé et corrigé — l'écriture inutile, deuxième occurrence

`getProfileById` émettait `INSERT INTO user_profiles … ON CONFLICT DO NOTHING`
à **chaque lecture de `GET /api/users/me`**, donc à chaque chargement de
l'application. Exactement le même défaut que sur le chemin de connexion, dans un
chemin plus chaud — et invisible dans le total (3 requêtes n'a rien d'alarmant) :
c'est le DÉTAIL des requêtes qui l'a montré.

La mémoire partagée `profileEnsured.ts` couvre désormais les deux appelants.
**`users/me` : 3 → 2 requêtes.** Le `ON CONFLICT DO NOTHING` reste la garantie
réelle ; trois tests verrouillent le comportement (l'INSERT part la première
fois, plus après, et repart pour un compte jamais vu).

## B11 · Socket.io — le coup d'envoi (scénario S4)

N sockets rejoignant le salon « live » dans la même seconde, un processus par
palier. `socket.io-client` est ajouté aux devDependencies — **`cd server && npm
install`** avant de lancer ce banc.

| sockets | trames `room_users` | /arrivée | SQL | /arrivée |
|---|---|---|---|---|
| 25 | 50 | 2 | 1 | 0,04 |
| 100 | 200 | 2 | 1 | 0,01 |
| 300 | 600 | 2 | **1** | **0** |

**Le fan-out du compte de présence est linéaire** : sockets ×12 → trames ×12,
2 trames par arrivée quel que soit N. La coalescence de `scheduleRoomCount`
tient ; il n'y a pas de tempête quadratique au coup d'envoi. C'était le
principal risque de S4.

### Défaut trouvé et corrigé — une lecture Neon par arrivant

`join_room` vérifie le droit de lecture avant d'abonner le socket, et cette
vérification passait par `getRoomRow` **sans cache** : 300 arrivées = **300
requêtes Neon identiques**, pour la même ligne, dans la même seconde, sur un
pool qui en compte dix. Au coup d'envoi d'un vrai match, c'est une rafale de
lectures identiques au moment précis où il faut servir les vrais messages.

**300 → 1.** Cache TTL 5 s sur la ligne de salon.

Pourquoi c'est sûr sur une donnée d'autorisation, ce qui demande normalement de
la méfiance : **une ligne de salon ne se modifie jamais** — le code n'émet aucun
`UPDATE chat_rooms`, un salon est créé puis supprimé. Les deux chemins de
suppression invalident explicitement. Si un `UPDATE chat_rooms` apparaît un jour
(passer un salon en privé, par exemple), il devra appeler `forgetRoom` — c'est
écrit en toutes lettres au-dessus du cache.

Effet de bord bienvenu : `chat/messages` et `chat/members` passent de 3 à 2
requêtes à chaud, et poster un message de 4 à 3.

## Ce qui reste non mesuré

- **Le multi-instance.** B11 couvre S4 sur UNE instance. Le verrou que l'audit
  appelle « le dernier verrou architectural » (ligne D — Socket.io sans
  adaptateur Redis) ne se manifeste qu'à partir de la deuxième instance, où deux
  visiteurs du même salon cessent de se voir. Aucun banc en process ne peut le
  reproduire.
- **Endurance 2-4 h** (S5) et **soirée de règlement** (S6).
- Les latences, toujours : l'amont et la base sont bouchonnés.

Sortie complète : `loadtest/bench-sortie-2026-09-19.txt`.

---

# Addendum 3 — les trois derniers scénarios, 2026-09-19

S4 multi-instance (**B12**), S5 endurance (**B13**) et S6 règlement (**B14**)
sont couverts. Suite complète : **27 ✓ / 1 ✗**, le ✗ étant B12 — voir plus bas,
il est voulu. `tsc --noEmit` propre, 456 tests verts.

## B14 · Soirée de règlement (S6)

Tickets en attente sur 10 matchs, matchs passés finaux, une passe de règlement.
`settlePendingSlips` est appelée directement : c'est un job de fond, pas une
route.

| tickets | examinés | réglés | file vidée | appels NHL | SQL/réglé |
|---|---|---|---|---|---|
| 200 | 200 | 200 | **oui** | 10 | 3,02 |
| 600 | 600 | 600 | **oui** | **10** | 3,01 |
| 200, matchs NON finis *(contrôle)* | 200 | **0** | oui | 10 | — |

**Le critère de S6 est tenu**, et pour la bonne raison : `exhausted` est vrai,
la file est vide, et le budget temps n'a pas eu à s'en mêler. Le contrôle
confirme que le banc sait distinguer « tout réglé » de « rien à régler » — un
ticket ne se règle jamais contre un match en cours.

**Le regroupement par match fonctionne** : 10 récupérations NHL pour 600 tickets
sur 10 matchs, et ce chiffre ne bouge pas quand les tickets doublent. C'était
l'essentiel du bénéfice attendu de la ligne H de l'audit.

### Défaut trouvé et corrigé — l'écriture inutile, TROISIÈME occurrence

`applyXpDelta` refaisait le même `INSERT INTO user_profiles … ON CONFLICT DO
NOTHING`, cette fois **une fois par ticket réglé**. C'est la plus coûteuse des
trois : un soir de 2 000 tickets, 2 000 allers-retours Neon et 2 000 places
prises dans un pool qui en compte dix, pour n'insérer aucune ligne — au moment
exact où la file doit se vider vite.

| | avant | après |
|---|---|---|
| SQL par ticket réglé | 4,01 | **3,01** |
| débit (600 tickets) | 53,5/s | **68,1/s** |

La même mémoire partagée (`profileEnsured.ts`) couvre désormais les trois
appelants : connexion, lecture de profil, règlement.

## B13 · Endurance / fuite mémoire (S5)

12 boucles pendant 90 s à 180 s, avec des clés de cache **toutes différentes** —
une date de calendrier, un joueur et une équipe jamais demandés à chaque
itération. C'est la consigne de S5, et le seul profil qui puisse révéler une
fuite : un trafic répétitif tape toujours les mêmes entrées, donc une `Map` non
bornée y ressemble exactement à une `Map` bornée.

**Résultat : plateau.** Le RSS monte de ~275 à ~410 Mo pendant les vingt
premières secondes — c'est le coût d'exister, pas une fuite — puis ne suit plus
le trafic. Le plateau s'explique : le cache `nhl` évince (500/500, ~19 000
évictions sur 90 s), donc c'est bien son plafond qui tient la mémoire.

Deux choses que ce banc a dû apprendre à ne pas dire :

- **Une pente positive n'est pas une fuite.** Une exécution a donné « +65 Mo/min,
  OOM dans une minute » sur une courbe qui était un ESCALIER : plat, une marche,
  plat. V8 et l'allocateur réservent par blocs et ne rendent pas à l'OS. Le banc
  exige maintenant deux choses pour parler de fuite — que le **dernier tiers**
  monte aussi, et que le **tas** monte aussi. Un RSS qui monte à tas constant
  décrit l'allocateur, pas le code.
- **Ce qu'une durée courte ne peut pas résoudre.** Le banc mesure le bruit du
  relevé et annonce sa propre résolution (~1 Mo/min sur 90 s). En dessous, il dit
  qu'il ne sait pas, au lieu de trancher.

**Observation, pas défaut :** sous ce profil adversarial, le cache `nhl` sature
et son taux de hit tombe à 34 %. Le trafic réel a bien moins de diversité de
clés, mais le chiffre existe désormais si `NHL_CACHE_MAX_ENTRIES` doit être
arbitré un jour : relever le plafond coûte de la mémoire, ne pas le relever
coûte de l'amont.

## B12 · Deux instances — et il reste ROUGE

L'audit classe « Socket.io mono-instance » 🔴, « le dernier verrou
architectural », sur la foi d'une lecture de code. B12 en fait une expérience :
deux applications complètes dans deux processus, un lecteur branché sur chacune,
un message posté sur la première.

| lecteur branché sur | trames `new_message` | « N en ligne » |
|---|---|---|
| instance A | **1** | 1 |
| instance B | **0** | 1 |

Le message ne traverse pas. `io.to(room).emit()` ne parle qu'aux sockets de son
propre processus, et chaque instance annonce SES sockets — jamais le total du
salon. En production, à partir de la deuxième instance, deux personnes du même
salon ne se voient que si le répartiteur les a posées sur le même conteneur. Le
symptôme n'est pas une erreur : c'est un chat qui « marche une fois sur deux »,
et il est invisible tant qu'on ne tourne qu'à une instance, c'est-à-dire pendant
tout le développement.

**Ce ✗ ne demande pas un correctif dans ce dépôt.** Il mesure une décision
d'infrastructure qui n'est pas prise : un adaptateur Redis, donc un Redis à
héberger et à payer. Le banc passera au vert tout seul le jour où elle sera
prise — c'est sa raison d'être. D'ici là, il chiffre ce qu'on accepte en scalant.

## Où en est la couverture

Les sept scénarios de l'audit sont maintenant mesurés : S1 (B1-B6), S2 (B6),
S3 (B3), S4 (B11 mono-instance, B12 multi-instance), S5 (B13), S6 (B14),
S7 (les compteurs `upstream.*` de tous les bancs).

Ce qui reste hors de portée d'un banc en process, et le restera :

- une fuite **lente** (quelques mégaoctets par heure) — B13 annonce sa propre
  résolution et ne prétend pas la voir ;
- le débit **réel** de Neon et de l'API NHL — les bancs comptent les
  allers-retours, pas ce qu'ils coûteront un soir de match ;
- les latences vues par un visiteur — pour ça, `s1-landing.js` contre une
  préproduction.

Sortie complète : `loadtest/bench-sortie-2026-09-19.txt`.
