# ARAKICE / ICEEDGE — Audit de scalabilité & de coûts

**Date :** 2026-07-28
**Cible :** 500 utilisateurs simultanés au lancement → 5 000 simultanés avec un minimum de changements
**Contrainte :** infrastructure peu coûteuse, pas de refonte, réutilisation de l'architecture existante
**Méthode :** inspection directe du code (`server/src`, `client/src`, `ml/python`, `server/src/db`, Dockerfiles, `vercel.json`, `.env.example`). Chaque constat cite un fichier réel.

> Cet audit est **complémentaire** de `PRODUCTION_READINESS_AUDIT.md` (2026-07-20), qui traitait la sécurité et la production-readiness. La plupart de ses points critiques ont été livrés depuis (Sentry, arrêt gracieux, pino, zod, chiffrement AES-GCM, tini/non-root, hash des refresh tokens, job de cleanup). **Ce document n'y revient pas.** Il regarde une seule chose : *qu'est-ce qui casse ou explose en coût quand le nombre d'utilisateurs est multiplié par 10 ?*

---

## Avertissement sur les chiffres de coûts

Les montants indiqués sont des **ordres de grandeur** basés sur les grilles tarifaires publiques telles que je les connais ; les prix changent. **Vérifie chaque ligne avant d'engager une dépense.** Ce qui compte dans ce rapport n'est pas le montant exact mais la **forme de la courbe** : un coût *constant* (cache partagé) contre un coût *linéaire au nombre d'utilisateurs* (appel non caché). C'est cette distinction qui décide de ta facture à 5 000 utilisateurs.

De même, les seuils « à partir de N utilisateurs » sont des **estimations d'ingénierie** dérivées du code, pas des mesures. Le plan de tests de charge en fin de document sert précisément à les valider ou les corriger.

---

## Hypothèses de charge utilisées

| Paramètre | Lancement | Cible |
|---|---|---|
| Utilisateurs simultanés | 500 | 5 000 |
| Requêtes backend par chargement de la landing | **~7** (mesuré dans `HockeyLanding.tsx`) | idem |
| Débit backend en régime établi (1 action / 25 s) | ~20 req/s | ~200 req/s |
| Pic d'arrivée (500 users en 60 s) | **~58 req/s** | ~580 req/s |
| Instances Railway Node | 1 | 1 → 2-3 |

Le pic d'arrivée est le scénario dimensionnant : c'est lui qui casse, pas le régime établi.

---

## Verdict en une page

| Domaine | 500 simultanés | 5 000 simultanés | Commentaire |
|---|---|---|---|
| **Vercel / frontend** | 🟢 OK | 🟢 OK | SPA Vite statique = quasi gratuit. Un seul vrai sujet : le plan Hobby interdit l'usage commercial. |
| **The Odds API (proxy)** | 🟢 | 🟢 | ✅ Cache 5 min + `Cache-Control` + repli `getStale` si le quota tombe. Coût upstream découplé du trafic (~17 000 appels/mois au pire). |
| **`/api/predict/best-bets`** | 🟢 | 🟢 | ✅ Cache de réponse 60 s + déduplication en vol : 500 arrivées sur un cache froid = **une** exécution. Cache par instance : chaque redéploiement repart froid. |
| **`/api/leaderboard`** | 🟢 | 🟢 | ✅ 21 requêtes → 2 (agrégat Postgres), cache 60 s partagé, index `(user_id, outcome)`, `Cache-Control` pour le CDN. |
| **Avatars base64 en DB** | 🟢 | 🟠 | ✅ 256×256 WebP côté client : ~27 ko en base64 au lieu de ~2 Mo, et déduplication par auteur dans les réponses de chat. Reste le stockage en base (→ R2, ligne E). |
| **Service ML Python** | 🟢 | 🟠 | ✅ Réseau privé Railway, plus de domaine public. Reste 2 workers et aucun cache côté Python — mais le cache de `best-bets` absorbe l'essentiel. |
| **Neon Postgres** | 🟢 avec pooler | 🟠 | Pool à 10, connexion directe non documentée, jamais de scale-to-zero (probes + jobs). |
| **Railway / process Node** | 🟢 | 🟠 | ✅ `@node-rs/bcrypt` (hors event loop) et caches mémoire bornés. Reste tous les jobs in-process (ligne C). |
| **Socket.io / chat** | 🟢 | 🔴 | ✅ Broadcast de présence coalescé (3 s/salon) et CORS aligné sur l'API. **L'adapter mémoire reste le verrou** : impossible de passer à 2 instances (ligne D). |
| **Stripe** | 🟢 | 🟢 | Bien fait (signature vérifiée, upsert idempotent). Deux points mineurs. |
| **Google OAuth** | 🟢 | 🟢 | Aucun goulot. |
| **LLM (GitHub Models)** | 🟠 | 🔴 | Quota par utilisateur mais **aucun plafond global**. Le compte opérateur paie. |
| **Push notifications** | 🟢 | 🔴 | Fan-out `Promise.all` non borné sur tous les destinataires. |
| **Logging / erreurs** | 🟢 | 🟠 | `tracesSampleRate: 0.1` → facture Sentry linéaire au trafic. |
| **Tâches planifiées** | 🟠 | 🔴 | Empêchent le scale horizontal ; `oddsLogger` écrit sur un disque éphémère. |

**Conclusion courte :** l'architecture est saine et n'a pas besoin d'être remplacée. Les cinq corrections qui bloquaient les 500 simultanés — quatre endpoints non cachés et le stockage des avatars — **sont faites**, pour ~0 € d'infrastructure supplémentaire.

**Où on en est (2026-07-28) :**

- **500 simultanés : plus de 🔴.** Ce qui reste avant lancement est de la configuration de console, pas du code : plan Vercel (9), endpoint Neon `-pooler` (7), `SENTRY_TRACES_SAMPLE_RATE` (10), alertes de budget (12). Et surtout **le scénario de charge S1 (13), qui n'a pas encore été exécuté** — tant qu'il ne l'a pas été, tout ce tableau reste une prédiction.
- **5 000 simultanés : un seul 🔴, l'adapter Socket.io** (ligne D). C'est le verrou architectural restant ; il conditionne aussi la ligne C (jobs planifiés) et la ligne Q (2ᵉ instance).

---

# 1. Bloquants avant le lancement (P0)

---

## P0-1 · Le proxy The Odds API n'a aucun cache

- **Composant :** `server/src/routes/odds.routes.ts` (`GET /api/odds/bet365/:sportKey`, `GET /api/odds/sports`) ; appelé par `client/src/app/pages/HockeyLanding.tsx:1184` et `:1264`.
- **Pourquoi c'est un risque :** chaque chargement de la landing déclenche **deux** appels `fetchBet365Odds` (hockey + tennis). Le proxy relaie chaque appel tel quel vers `api.the-odds-api.com`, sans cache et sans en-tête `Cache-Control`. Le coût upstream est donc **strictement linéaire au nombre de visiteurs**.
  L'ironie : `services/oddsClient.ts` implémente déjà exactement le bon cache (TTL 5 min, ligne `const TTL = 5 * 60_000`) — mais il n'est utilisé que par le job `valueBetScan`, pas par la route que le client appelle.
- **À partir de quand :** **immédiatement.** Un plan gratuit The Odds API (≈500 crédits/mois) est consommé par **250 visiteurs**, soit le premier jour du lancement. À 500 simultanés on parle de ~1 000 appels upstream sur la seule vague d'arrivée.
- **Solution :** réutiliser le cache existant. Extraire le pattern de `oddsClient.ts` (ou simplement envelopper le handler dans le même `Map` TTL) avec un TTL de **5 minutes**, et ajouter `Cache-Control: public, max-age=60, stale-while-revalidate=300` sur la réponse. Le coût upstream devient **constant** (~17 000 appels/mois quel que soit le nombre d'utilisateurs) au lieu de linéaire.
  Logger aussi l'en-tête `x-requests-remaining` renvoyé par The Odds API et alerter en dessous d'un seuil — aujourd'hui il est ignoré, donc tu découvriras l'épuisement du quota par une page vide.
- **Coût supplémentaire :** **0 €** (le cache est du code). Économie : évite de devoir passer sur un palier The Odds API à trois chiffres mensuels.
- **Timing :** 🔴 **Indispensable avant le lancement.** C'est le point le plus rentable du rapport : ~30 lignes de code.

---

## P0-2 · `/api/predict/best-bets` : jusqu'à 30 appels ML par requête, sans cache

- **Composant :** `server/src/services/bestBets.service.ts` → `getBestBets()`, exposé par `routes/ml.routes.ts` (`GET /api/predict/best-bets`), appelé par `HockeyLanding.tsx:425` au montage.
- **Pourquoi c'est un risque :** un seul appel exécute :
  1. `fetchUpcomingGames(days)` — plusieurs appels NHL (cachés) ;
  2. `buildGameCandidates` pour chaque match — 4 prédictions règles en parallèle par match ;
  3. `buildPlayerCandidates` pour jusqu'à 40 joueurs — 4 prédictions par joueur ;
  4. **`Promise.all` sur `mlDepth` (défaut 30, max 60) appels HTTP vers le service Python**, chacun avec un timeout de 5 s (`mlApiClient.ts`).

  Le résultat n'est mis en cache **nulle part** — ni côté serveur, ni via `Cache-Control`, ni côté client. Chaque visiteur qui arrive sur la landing, ou qui y revient en naviguant, relance tout.
- **À partir de quand :** dégradation visible dès **~50 utilisateurs simultanés**, rupture vers **150-300**. À 500 arrivées en une minute cela fait ~15 000 requêtes HTTP sortantes vers le service ML depuis un **process Node unique** — épuisement de descripteurs de fichiers / ports éphémères bien avant que le CPU ne sature. Le service ML (`--workers 2`) tombe en premier ou répond en 5 s, ce qui fait que chaque requête entrante retient une connexion pendant 5 secondes.
- **Solution (par ordre de rentabilité) :**
  1. **Cache de réponse en mémoire, TTL 60 s**, clé = `limit|days|players|source`. Une seule ligne de `Map` autour de `getBestBets`. Ramène le coût à ~1 exécution par minute quel que soit le trafic. **C'est la correction minimale suffisante.**
  2. Ajouter `Cache-Control: public, max-age=60` pour que le navigateur et un éventuel CDN absorbent le reste.
  3. **Protection contre le cache stampede** : mémoriser la promesse en vol (`Map<string, Promise<T>>`) pour que 500 requêtes concurrentes sur un cache froid déclenchent **une** exécution, pas 500. Indispensable après chaque redéploiement, où tous les caches mémoire repartent à zéro.
  4. À terme : précalculer le résultat dans un job toutes les 2 min et servir depuis un cache — l'endpoint devient une lecture triviale.
- **Coût supplémentaire :** **0 €**. Réduit au contraire fortement la charge CPU du service ML (donc sa facture Railway).
- **Timing :** 🔴 **Indispensable avant le lancement.**

---

## P0-3 · `/api/leaderboard` : N+1 + scan complet des paris, endpoint public

- **Composant :** `server/src/services/profile.service.ts:322` (`getLeaderboard`), monté directement dans `app.ts` sur `GET /api/leaderboard`.
- **Pourquoi c'est un risque :** la fonction fait 1 requête pour le top 20, puis **une requête par utilisateur** dans un `Promise.all` — et chacune est `SELECT outcome FROM user_bets WHERE user_id = $1` **sans agrégation ni limite** : elle rapatrie *toutes* les lignes de paris de l'utilisateur pour compter les victoires en JavaScript. Soit 21 allers-retours Postgres et un volume de données croissant à chaque appel. Aucun cache, aucune authentification requise.
- **À partir de quand :** le nombre de requêtes est fixe (21) mais **le volume par requête croît avec l'historique**. Douloureux dès **~200 simultanés** (≈4 200 requêtes/min vers Neon) ; ingérable à 5 000. Un utilisateur du top 20 avec 5 000 paris fait transiter 5 000 lignes à chaque appel de leaderboard, pour produire deux entiers.
- **Solution :**
  1. Remplacer la boucle par **une seule requête agrégée** :
     ```sql
     SELECT ub.user_id,
            COUNT(*) FILTER (WHERE ub.outcome <> 'pending') AS decided,
            COUNT(*) FILTER (WHERE ub.outcome = 'win')      AS wins,
            COUNT(*)                                        AS total
       FROM user_bets ub
      WHERE ub.user_id = ANY($1)
      GROUP BY ub.user_id
     ```
     21 requêtes → 2.
  2. Index composite `CREATE INDEX ON user_bets (user_id, outcome);` — aujourd'hui seul `idx_user_bets_user` existe.
  3. **Cache 60 s** sur le résultat complet : le classement n'a pas besoin d'être à la seconde.
- **Coût supplémentaire :** **0 €**. Économise directement des compute-hours Neon.
- **Timing :** 🔴 **Indispensable avant le lancement.**

---

## P0-4 · Avatars stockés en base64 dans Postgres, et renvoyés dans chaque payload

- **Composant :** `server/src/routes/profile.routes.ts:86` (`POST /api/users/me/avatar`), colonne `user_profiles.avatar_url TEXT`, lue par `chat.service.ts:176` (`getMessages`) et `profile.service.ts:257` (leaderboard).
- **Pourquoi c'est un risque :** trois problèmes en un.
  1. **Stockage.** Une data-URI base64 de ~2 Mo par utilisateur. 5 000 utilisateurs = **~10 Go** dans Neon, qui est le stockage le plus cher de ta stack (Neon Free = 0,5 Go). Un objet-store coûte ~100× moins cher pour la même donnée.
  2. **Egress / taille de réponse.** `getMessages` renvoie 100 messages avec, pour chacun, `COALESCE(up.avatar_url, u.avatar_url)`. Si dix participants ont un avatar de 2 Mo, une seule ouverture de salon de chat peut produire une réponse JSON de **plusieurs dizaines de Mo**, sérialisée sur l'event loop du process Node. Idem pour le leaderboard.
  3. **Event loop.** L'upload passe par `express.json({ limit: '5mb' })` : Express parse une chaîne de 2,7 Mo (base64 = +33 %) de façon synchrone, puis Postgres l'écrit en TOAST.
- **À partir de quand :** le problème d'egress/latence apparaît **dès qu'une poignée d'utilisateurs actifs ont un avatar** — potentiellement dès le lancement, indépendamment du nombre total d'utilisateurs. Le problème de stockage devient bloquant vers **~250 utilisateurs** sur Neon Free, **~5 000** sur un plan à 10 Go.
- **Solution :**
  1. Basculer sur un **object storage** : Cloudflare R2 (10 Go gratuits, pas de frais d'egress — le meilleur rapport pour ce cas), Vercel Blob ou Supabase Storage. Stocker **uniquement l'URL** dans `avatar_url`.
  2. Redimensionner côté client avant l'upload (canvas → 256×256 WebP ≈ 20 Ko) — c'est la correction la moins chère et elle peut être faite seule si la migration objet-store attend.
  3. **Dé-dupliquer les avatars dans les réponses** : `getMessages` ne devrait pas répéter l'avatar par message. Renvoyer une map `userId → avatarUrl` à part, ou laisser le client résoudre l'avatar via une route dédiée cachable.
  4. Réduire `express.json` à **100 ko globalement** et n'appliquer `5mb` que sur la route avatar.
- **Coût supplémentaire :** **0 à 5 €/mois** (R2 gratuit jusqu'à 10 Go). **Économie nette** côté Neon.
- **Timing :** 🔴 **Indispensable avant le lancement** pour les points 2 et 4 (redimensionnement client + limite de body). L'object storage peut suivre dans les semaines suivantes si le redimensionnement est fait.

---

## P0-5 · Le service ML Python est public, sans authentification

- **Composant :** `ml/python/ml_service.py:47-53` — `CORSMiddleware(allow_origins=["*"])`, aucun contrôle d'accès sur `/predict/*`. `DEPLOYMENT.md` §3 demande explicitement de générer un **domaine public Railway** pour ce service.
- **Pourquoi c'est un risque :** n'importe qui connaissant l'URL peut envoyer des requêtes d'inférence XGBoost illimitées. Sur Railway, le compute est facturé à l'usage : c'est une **facture ouverte**, et accessoirement une exfiltration de ton modèle par requêtes répétées. Il n'y a ni rate limiting, ni clé partagée, ni restriction réseau.
- **À partir de quand :** **dès la mise en ligne** — le risque n'est pas corrélé à ton nombre d'utilisateurs mais à la découverte de l'URL.
- **Solution (choisir l'une, la première est la meilleure) :**
  1. **Réseau privé Railway** : supprimer le domaine public du service ML et mettre `ML_SERVICE_URL=http://<service>.railway.internal:8000`. Coût 0, latence réduite, surface d'attaque nulle.
  2. À défaut : header secret partagé (`X-ML-Token`) vérifié par une dépendance FastAPI, + `allow_origins` restreint.
- **Coût supplémentaire :** **0 €** (le réseau privé Railway est inclus et gratuit, contrairement à l'egress public).
- **Timing :** 🔴 **Indispensable avant le lancement.**

---

## P0-6 · bcrypt**js** au coût 12, deux fois par inscription, sur l'event loop

- **Composant :** `server/src/services/auth.service.ts:1` (`import bcrypt from 'bcryptjs'`), `SALT_ROUNDS = 12`, utilisé ligne 103 (`createCode`), 160 (`register`), 268 (reset), 293 (`compare` au login).
- **Pourquoi c'est un risque :** `bcryptjs` est une implémentation **JavaScript pure**. Contrairement au module natif `bcrypt`, elle ne s'exécute pas dans le threadpool libuv : elle **bloque l'event loop** du process Node. Au coût 12 sur un vCPU partagé Railway, un hash coûte de l'ordre de **0,5 à 2 secondes de CPU bloquant**.
  Pire : `register` (`auth.service.ts:160` puis `:143-144`) effectue **deux** hashes coût 12 (mot de passe + code de vérification) **et** un appel HTTP bloquant à Resend, le tout en ligne dans la requête.
- **À partir de quand :** une inscription bloque tout le serveur pendant ~1-4 s. **10 inscriptions simultanées** suffisent à faire expirer les timeouts de tous les autres utilisateurs. C'est exactement le profil d'un lancement : une vague d'inscriptions en même temps. Le risque est donc **maximal au jour 1**, pas à 5 000 utilisateurs.
- **Solution :**
  1. Remplacer `bcryptjs` par **`@node-rs/bcrypt`** (binaire natif, API compatible, s'exécute hors event loop) ou `bcrypt`. Changement d'une ligne d'import ; les hashes existants restent valides (même format `$2a$`/`$2b$`).
  2. Descendre `SALT_ROUNDS` à **10 ou 11** — reste au-dessus de la recommandation OWASP et divise le coût par 2-4.
  3. Ne pas hasher le code de vérification au coût 12 : c'est un code court à durée de vie de quelques minutes, un **SHA-256 salé** suffit largement (le pattern est déjà utilisé pour les refresh tokens, cf. migration 021 et le commentaire `hashToken()`).
  4. Envoyer l'e-mail de vérification **après** avoir répondu (fire-and-forget avec capture d'erreur), pas dans le chemin de la requête.
- **Coût supplémentaire :** **0 €**.
- **Timing :** 🔴 **Indispensable avant le lancement.**

---

## P0-7 · Neon : connexion directe, pool à 10, et compute qui ne dort jamais

- **Composant :** `server/src/db/connection.ts` (`max: Number(process.env.DB_POOL_MAX) || 10`), `DEPLOYMENT.md` (documente encore Supabase, pas Neon).
- **Pourquoi c'est un risque :** trois sujets distincts.
  1. **Pooler.** Neon expose deux endpoints : direct (limite basse de connexions, quelques dizaines) et **`-pooler`** (PgBouncer, ~10 000 connexions). Rien dans le code ni la doc n'indique lequel est utilisé. Avec une seule instance Node et `max: 10` ça passe ; avec 2-3 instances Railway, ou si le job de settlement et les requêtes web se disputent le pool, tu satures. **Le `DATABASE_URL` doit pointer sur l'endpoint `-pooler`.**
  2. **Taille du pool.** 10 connexions pour ~200 req/s implique que chaque requête tienne < 50 ms. Les requêtes N+1 ci-dessus (leaderboard, chat) monopolisent le pool bien plus longtemps. Une fois les N+1 corrigés, 10-20 est raisonnable ; sans correction, augmenter le pool ne fait que déplacer le problème vers Neon.
  3. **Scale-to-zero jamais atteint.** Ton `.env.example` explique que le job de settlement dort longtemps « pour laisser la base Neon se mettre en veille (scale-to-zero) ». C'est une bonne intention, mais elle est annulée par : `/health/ready` qui exécute un `SELECT 1` à **chaque probe** (`app.ts`, et `MONITORING.md` recommande un intervalle de 1-5 min), le `startCleanupJob` quotidien, le `startValueBetScan` toutes les 30 min, et le fallback de settlement horaire. **La base ne dort jamais**, donc tu paies le compute 24/7.
- **À partir de quand :** le pooler devient bloquant **dès la 2ᵉ instance Railway**. Le compute permanent coûte dès aujourd'hui.
- **Solution :**
  1. Vérifier et forcer l'endpoint `-pooler` dans `DATABASE_URL` ; documenter dans `DEPLOYMENT.md` (qui parle encore de Supabase — à corriger, c'est une source d'erreur de configuration).
  2. Garder `DB_POOL_MAX` à 10 par instance après correction des N+1 ; ne l'augmenter qu'avec des mesures.
  3. **Décider consciemment** : soit tu veux le scale-to-zero (alors la sonde de readiness ne doit pas taper la DB à chaque appel — mettre en cache le résultat 60 s, et espacer les probes à 5 min), soit tu acceptes un compute permanent et tu supprimes la complexité des cadences de settlement. Aujourd'hui tu as le coût des deux et le bénéfice d'aucun.
- **Coût supplémentaire :** **0 €** pour le pooler. Le scale-to-zero peut économiser plusieurs dizaines d'euros/mois hors saison NHL.
- **Timing :** 🔴 **Avant le lancement** pour le pooler (point 1). 🟠 Les points 2-3 peuvent attendre.

---

## P0-8 · Vercel Hobby et usage commercial

- **Composant :** `client/vercel.json`, plan Vercel.
- **Pourquoi c'est un risque :** ce n'est pas un risque technique mais **contractuel**. Le plan Hobby de Vercel est réservé aux projets non commerciaux. ArakIce vend un abonnement Pro via Stripe : c'est commercial. Un projet Hobby signalé peut être suspendu — indisponibilité totale du frontend, sans préavis utile.
- **À partir de quand :** dès la première vente.
- **Solution :** passer sur **Vercel Pro**. Bonus : cela débloque aussi des limites de bande passante et d'analytics utiles.
- **Coût supplémentaire :** **~20 $/mois** (à vérifier).
- **Timing :** 🔴 **Avant le lancement** (ou au premier paiement encaissé).

---

# 2. Risques entre 500 et 5 000 (P1 — à traiter dans les 4-8 semaines)

---

## P1-1 · Caches mémoire sans éviction → fuite mémoire et OOM

- **Composant :** `services/nhlApiClient.ts:25` (`_cache`), `services/tennisApiClient.ts:18`, `routes/llm.routes.ts:34` (`quota`), `services/settlement.service.ts` (`knownFinal`).
- **Pourquoi c'est un risque :** `getCached` vérifie l'expiration à la lecture mais **rien ne supprime jamais** les entrées expirées. Les clés sont dérivées de données utilisateur : `player:<id>`, `range:<start>:<end>`, `boxscore:<gameId>`… Un utilisateur qui navigue dans le calendrier crée une clé `range:` par plage consultée. Avec 5 000 utilisateurs qui explorent joueurs, équipes et dates, la `Map` croît de façon monotone jusqu'à l'OOM et au redémarrage du conteneur (qui vide tous les caches → tempête de requêtes upstream au redémarrage, cf. P0-2).
  Même problème pour `quota` (`llm.routes.ts`) : une entrée par utilisateur, jamais supprimée, et pour `knownFinal` (un id de match par match terminé, à vie).
- **À partir de quand :** **~1 000-2 000 utilisateurs actifs cumulés**, ou plus tôt si le conteneur Railway est petit. Se manifeste par des redémarrages inexpliqués.
- **Solution :** remplacer les `Map` maison par **`lru-cache`** (une dépendance, ~10 lignes de changement) avec `max` en nombre d'entrées + `ttl`. Ou, si tu veux éviter la dépendance : un `setInterval(prune, 5 * 60_000).unref()` qui balaie les entrées expirées, comme le fait déjà correctement `InMemoryRateLimitStore.prune()` — le bon pattern existe déjà dans le repo, il n'est simplement pas appliqué aux caches API.
- **Coût :** 0 €.
- **Timing :** 🟠 Peut attendre, mais **avant de dépasser ~1 000 utilisateurs**.
- **✅ Corrigé (2026-07-28).** Sans dépendance : la classe `TtlCache` existait déjà dans le repo (plafond d'entrées, éviction FIFO, anti-stampede) ; il lui manquait un TTL par entrée, ajouté ici, car les clients d'API n'ont pas une durée unique. `nhlApiClient` (500 entrées), `tennisApiClient` (200), `refereeStore` (60, même défaut non listé ci-dessus) et le quota LLM (20 000) passent dessus ; les signatures `getCached`/`setCached` sont inchangées, donc aucun appelant n'a bougé. Plafonds réglables par variable d'environnement. `knownFinal` était déjà borné (`clear()` à 2 000) — rien à faire. Sur le quota LLM, l'éviction *remet à zéro* le compteur de la personne évincée : elle ne peut jamais bloquer quelqu'un à tort, et le vrai plafond de coût reste `llmLimiter` (10/min), incontournable.

---

## P1-2 · N+1 dans le chat (100 requêtes par ouverture de salon)

- **Composant :** `services/chat.service.ts:176-193` (`getMessages`), `:112` (compte de membres par salon), `:122` et `:149` (dernier message par salon).
- **Pourquoi c'est un risque :** `getMessages` sélectionne 100 messages puis exécute **une requête par message** pour récupérer ses réactions. La liste des salons fait un `COUNT(*)` et un « dernier message » **par salon**. Chaque ouverture du chat = ~100+ allers-retours Neon.
- **À partir de quand :** **~100-200 utilisateurs simultanés** dans le chat suffisent à saturer un pool de 10 connexions.
- **Solution :**
  1. Une seule requête pour les réactions : `SELECT message_id, emoji, count FROM chat_reactions WHERE message_id = ANY($1)` puis regroupement en mémoire. 101 requêtes → 2.
  2. Liste des salons : `LEFT JOIN LATERAL` pour le dernier message + agrégat `GROUP BY` pour le compte de membres. N×2+1 requêtes → 1.
  3. Index : `chat_messages(room_id, sent_at DESC)` existe (migration 019) ✅.
- **Coût :** 0 €.
- **Timing :** 🟠 Avant 1 000 utilisateurs. À faire en même temps que P0-3, c'est le même geste.
- **✅ Corrigé (2026-07-28).** Le point 1 (réactions) était déjà fait : `fetchReactions` groupait déjà par `= ANY($1::text[])`. Le point 2 est fait : `viewRoom` et `viewRoomGuest` fusionnent en un seul SQL (`LEFT JOIN LATERAL` pour le dernier message, sous-requête corrélée sur la PK `(room_id, user_id)` pour le compte). Dix salons visibles : 31 requêtes → 1. Les chemins mono-salon (`createRoom`, `joinRoom`, `setPinned`, `findRoomByCode`) tombent de 4 requêtes à 1-2. Effet de bord utile : un seul SQL sert les connectés et les invités, donc les deux vues ne peuvent plus diverger sur ce qu'elles exposent — le `joinCode` reste masqué aux non-membres par construction.

---

## P1-3 · Socket.io mono-instance : bloque le scale horizontal et broadcast O(n)

- **Composant :** `server/src/socket.ts`.
- **Pourquoi c'est un risque :** deux choses.
  1. **Adapter mémoire.** `io.to(roomId).emit(...)` ne touche que les sockets de *ce* process. Dès la 2ᵉ instance Railway, la moitié des utilisateurs d'un salon cesse de recevoir les messages de l'autre moitié. **C'est le principal verrou architectural au passage à 5 000.**
  2. **Broadcast O(n) sur chaque événement de présence.** À chaque `join_room`, `leave_room` et `disconnecting`, le code fait `io.in(roomId).allSockets()` puis `emit('room_users', size)` **à tous les membres du salon**. Avec 2 000 personnes dans le salon « live » d'un match, chaque connexion/déconnexion génère 2 000 messages sortants. Un match qui commence = churn massif = tempête de messages qui sature l'event loop.
  3. **CORS incohérent** : `socket.ts` utilise `process.env.CORS_ORIGIN` **brut**, alors que `app.ts` le traite comme une liste séparée par virgules avec en plus une regex pour les previews Vercel. Si `CORS_ORIGIN` contient deux origines, le WebSocket est cassé pour toutes.
- **À partir de quand :** le broadcast devient douloureux vers **~500-1 000 sockets dans un même salon**. L'adapter bloque **dès la 2ᵉ instance**.
- **Solution :**
  1. **`@socket.io/redis-adapter`** + Redis managé (Upstash a une offre gratuite généreuse pour ce volume). Prérequis obligatoire au multi-instance, avec sticky sessions côté Railway.
  2. **Débouncer `room_users`** : n'émettre le compte qu'au maximum une fois par 2-5 s par salon, et ne pas recalculer `allSockets()` à chaque événement.
  3. Aligner le CORS socket sur la même logique que `app.ts` (extraire la fonction d'origine autorisée dans un module partagé). **Cette correction-là est à faire avant le lancement** — c'est un bug de configuration, pas une optimisation.
- **Coût :** **0 à 10 €/mois** (Upstash gratuit à ce volume).
- **Timing :** 🔴 Le point 3 (CORS) avant le lancement. 🟠 Les points 1-2 avant la 2ᵉ instance.
- **✅ Points 2 et 3 corrigés (2026-07-28).**
  - *CORS* : la politique d'origine vit désormais dans `server/src/cors.ts`, importée par `app.ts` **et** `socket.ts` — les deux couches ne peuvent plus diverger. Le bug était réel et silencieux : `CORS_ORIGIN="https://a.com,https://b.com"` cassait le WebSocket pour **les deux** origines, y compris celle qui marchait avant qu'on en ajoute une seconde. `cors.test.ts` couvre la liste à virgules, l'ancrage de la regex Vercel (`https://ice-edge.vercel.app.attaquant.com` doit être refusé) et la requête sans `Origin`.
  - *`room_users`* : une mesure et un envoi par salon toutes les 3 s (`ROOM_COUNT_INTERVAL_MS`), en fin d'intervalle. Le coup d'envoi d'un match passe de quadratique en sockets à linéaire en salons. L'arrivant reçoit quand même son compte immédiatement via `adapter.rooms.get(id).size` (O(1), un seul destinataire) — sinon il afficherait « 0 en ligne » pendant 3 s. Le `−1` de `disconnecting` disparaît : en mesurant après la rafale, le socket est déjà parti.
- **⏳ Reste le point 1** (`@socket.io/redis-adapter`) : nécessite de provisionner Redis et des sticky sessions Railway. Voir la ligne D de la feuille de route.

---

## P1-4 · Tous les jobs planifiés tournent dans le process web

- **Composant :** `server/src/server.ts` — `startSettlementJob()`, `startValueBetScan()`, `startCleanupJob()`, `startOddsLogger()`.
- **Pourquoi c'est un risque :**
  1. **Duplication au scale.** Aucun verrou : avec 3 instances, le scan de value bets tourne 3 fois → 3× les appels Odds API et **3 notifications push identiques** par utilisateur. Le settlement tournerait 3 fois (l'`UPDATE ... WHERE outcome='pending'` protège de la double-comptabilisation ✅, mais pas du triple travail).
  2. **Concurrence CPU.** `valueBetScan` appelle `getBestBets({limit: 40})` — donc jusqu'à 30 appels ML — **dans le process qui sert les requêtes utilisateurs**, toutes les 30 min.
  3. **`lastAlertKey` en mémoire** (`valueBetScan.service.ts`) : après un redéploiement, la même alerte est renvoyée à tous les utilisateurs opt-in.
- **À partir de quand :** dès la 2ᵉ instance. La contention CPU est déjà mesurable à 500 utilisateurs.
- **Solution :** deux options, par ordre de simplicité.
  1. **Verrou d'unicité Postgres** : `SELECT pg_try_advisory_lock(<id>)` au début de chaque tick ; l'instance qui ne l'obtient pas passe son tour. ~15 lignes, aucun service supplémentaire, résout la duplication immédiatement. **C'est l'option recommandée compte tenu de ta contrainte de coût.**
  2. Extraire les jobs dans un **service Railway « worker » séparé** (même image, `CMD` différent, `WORKER_ONLY=true`). Plus propre, isole le CPU, mais ajoute un service facturé.
  Dans les deux cas : persister `lastAlertKey` en base plutôt qu'en mémoire.
- **Coût :** **0 €** (option 1) ou **~5 €/mois** (option 2).
- **Timing :** 🟠 Peut attendre — **mais devient obligatoire avant de passer à 2 instances**.

---

## P1-5 · `oddsLogger` écrit sur un disque éphémère (et probablement inexistant)

- **Composant :** `server/src/services/oddsLogger.service.ts` → `csvPath()`.
- **Pourquoi c'est un risque :** le chemin par défaut est `path.resolve(process.cwd(), '..', 'ml', 'data', 'odds_live_log.csv')`. Dans le conteneur, `WORKDIR /app` et seul `dist/` est copié (`server/Dockerfile`) — donc `../ml/data/` **n'existe pas**. Le `mkdirSync(..., {recursive:true})` le créera à la racine du conteneur, où :
  - le système de fichiers Railway est **éphémère** : tout est perdu à chaque déploiement ;
  - le process tourne en `USER node`, donc l'écriture peut échouer selon le chemin résolu ;
  - `existingKeys()` **relit tout le fichier en mémoire** à chaque exécution — croissance linéaire sur la saison.

  Le job est désactivé par défaut (`ODDS_LOG_ENABLED !== 'true'`), donc ce n'est pas un incident aujourd'hui. Mais son objectif — constituer un dataset pour le réentraînement — n'est **pas atteignable** en l'état : tu croiras collecter des données et tu les perdras à chaque déploiement.
- **À partir de quand :** dès la première activation en production.
- **Solution :** écrire dans une **table Postgres** `odds_log (date, home, away, …)` avec une contrainte d'unicité `(date, home, away)` pour l'idempotence — l'export CSV pour `fetch_data_v4.py` devient un `COPY … TO`. Alternative : un volume Railway persistant, ou R2.
- **Coût :** 0 € (quelques Mo dans Neon par saison).
- **Timing :** 🟠 Avant d'activer `ODDS_LOG_ENABLED=true`. Sans urgence tant que c'est off.

---

## P1-6 · LLM : quota par utilisateur, aucun plafond global

- **Composant :** `server/src/routes/llm.routes.ts`.
- **Pourquoi c'est un risque :** les garde-fous existants sont bons (rate limit 10/min/user, caps de taille, timeout 30 s, retry) mais le quota journalier `DAILY_QUOTA` est **par utilisateur et en mémoire de l'instance**. Il n'existe **aucun plafond global**. Sur le chemin Pro, c'est **ton** compte GitHub Models qui est facturé/limité.
  Calcul : 5 000 utilisateurs × 50 requêtes/jour (valeur de ton `.env.example`) = **250 000 requêtes/jour** au maximum théorique. GitHub Models applique des limites au niveau du **compte**, pas de l'utilisateur final : bien avant d'atteindre ce volume, ton token sera throttlé et **tous** tes utilisateurs Pro verront le service tomber en même temps.
  Par ailleurs, `quota` étant en mémoire, un redémarrage remet tous les compteurs à zéro — le quota journalier est contournable en attendant un déploiement.
- **À partir de quand :** dépend du taux d'usage réel de la fonctionnalité, mais **le mode de défaillance est un throttling global**, pas une dégradation progressive : ça marche, puis plus rien pour personne.
- **Solution :**
  1. **Compteur global journalier** en base (`llm_usage(day, count)` avec `INSERT … ON CONFLICT DO UPDATE … RETURNING count`) et un plafond `LLM_GLOBAL_DAILY_CAP`. Au-delà : 429 propre, ou bascule des utilisateurs Pro vers un message explicite.
  2. Déplacer le quota par utilisateur de la mémoire vers la même table (résout aussi le multi-instance et le contournement par redémarrage).
  3. Prévoir une **clé provider payante avec un budget plafonné** (OpenAI/Anthropic permettent de fixer une limite mensuelle dure) plutôt que GitHub Models, dont les quotas gratuits ne sont pas conçus pour du multi-tenant.
  4. Mettre en cache les réponses aux prompts identiques (hash du prompt+système+modèle, TTL 1 h) — sur un usage type « explique ce pari », le taux de répétition est élevé.
- **Coût :** dépend du provider choisi ; l'intérêt de la mesure est précisément de **rendre ce coût plafonnable et prévisible**.
- **Timing :** 🟠 Peut attendre le lancement (500 utilisateurs), 🔴 obligatoire avant une croissance forte.

---

## P1-7 · Fan-out push non borné

- **Composant :** `services/valueBetScan.service.ts` → `await Promise.all(recipients.map((u) => sendToUser(u.userId, payload)))`, et `services/push.service.ts:87` (`Promise.all` sur les endpoints de l'utilisateur).
- **Pourquoi c'est un risque :** double `Promise.all` imbriqué, sans limite de concurrence. Avec 2 000 utilisateurs opt-in ayant chacun 1-2 appareils, un seul scan lance **~3 000 requêtes HTTP simultanées** vers les services push (FCM/Mozilla/Apple) depuis un process Node unique, plus une requête Postgres par utilisateur (`SELECT … FROM push_subscriptions WHERE user_id = $1`) — soit 2 000 requêtes DB avec un pool de 10. Event loop bloqué, pool saturé, l'API ne répond plus pendant l'envoi.
- **À partir de quand :** **~300-500 destinataires**.
- **Solution :**
  1. Limiter la concurrence (`p-limit` à 20-50, ou une boucle par lots).
  2. Récupérer **toutes** les souscriptions en **une** requête (`WHERE user_id = ANY($1)`) au lieu d'une par utilisateur.
  3. À plus grande échelle : sortir l'envoi dans le worker (P1-4) ou une file.
- **Coût :** 0 €.
- **Timing :** 🟠 Avant que la base d'opt-in ne dépasse ~300 utilisateurs.

---

## P1-8 · Settlement : plafonds fixes qui deviennent un goulot

- **Composant :** `services/settlement.service.ts` → `settlePendingSlips(userId?, max = 100)`, fallback à `max = 200`, boucle **séquentielle** (`for (const leg of legs) results.push(await settleLeg(...))`).
- **Pourquoi c'est un risque :** le nombre de tickets réglés par passe est plafonné en dur (100, ou 200 pour le fallback horaire) et le traitement est séquentiel avec des appels NHL par jambe. À 5 000 utilisateurs plaçant chacun 1-2 tickets par soirée, ~7 000 tickets deviennent réglables en même temps après les matchs — la file se vide à 200/heure. **Des utilisateurs attendront des jours pour voir leur pari réglé**, et les caches par passe (`GameCache`, `BoxCache`) sont recréés à chaque appel donc rien n'est amorti entre les passes.
  À noter aussi : `pendingGameIds()` fait un `jsonb_array_elements` sur tous les tickets pending — un scan séquentiel, exécuté toutes les 2 minutes quand un match est en cours.
- **À partir de quand :** **~1 500-2 000 utilisateurs actifs** (dès que le nombre de tickets par soirée dépasse ~500).
- **Solution :**
  1. Rendre le plafond configurable et boucler jusqu'à épuisement (`while (settled === max)`), avec un budget temps maximal par passe.
  2. Traiter les jambes d'un ticket en `Promise.all` (les caches partagés rendent l'opération sûre).
  3. Grouper les tickets **par match** plutôt que par ticket : récupérer le boxscore une fois par match, puis régler tous les tickets qui le référencent.
  4. Index partiel : `CREATE INDEX ON bet_slips (placed_at) WHERE outcome = 'pending';`
- **Coût :** 0 €.
- **Timing :** 🟠 Peut attendre. À faire quand le volume de tickets par soirée dépasse ~300.

---

## P1-9 · Aucun en-tête de cache HTTP sur l'API

- **Composant :** toutes les routes de `server/src/routes/` — `grep -rn "Cache-Control" server/src/routes/` ne renvoie **rien**.
- **Pourquoi c'est un risque :** tes données NHL sont quasi-statiques (classements, calendrier, statistiques de joueurs) et déjà cachées côté serveur avec des TTL de 5 min à 6 h. Mais sans `Cache-Control`, **ni le navigateur ni un CDN ne peuvent les réutiliser** : chaque navigation refait l'aller-retour complet jusqu'à Railway. C'est du trafic et du compute payés pour rien.
- **À partir de quand :** le gain est proportionnel au trafic — donc croissant, jamais bloquant.
- **Solution :**
  1. Ajouter `Cache-Control: public, max-age=<TTL serveur>, stale-while-revalidate=<2×TTL>` sur `/api/nhl/*`, `/api/odds/*`, `/api/predict/best-bets`. Un petit middleware par routeur suffit.
  2. **Mettre Cloudflare (gratuit) devant le domaine Railway.** Avec les en-têtes ci-dessus, le CDN absorbe l'essentiel du trafic NHL/odds en périphérie. C'est de loin le meilleur rapport effet/coût pour passer à 5 000 : **coût 0 €**, et cela réduit aussi l'egress Railway (facturé).
  3. Ne **jamais** mettre de cache public sur les routes authentifiées (`/api/users/me`, `/api/slips`, `/api/subscription`) — `private, no-store`.
- **Coût :** **0 €**.
- **Timing :** 🟠 Peut attendre, mais c'est le levier n°1 pour la marche 500 → 5 000.

---

## P1-10 · Pas de cache client, pas de déduplication de requêtes

- **Composant :** `client/src/app/services/*.ts` — `fetch` brut partout, aucun `react-query`/`swr`. `HockeyLanding.tsx` déclenche ~7 appels au montage, à chaque montage.
- **Pourquoi c'est un risque :** revenir sur la page d'accueil relance tout, y compris `getBestBets` (P0-2) et les deux appels odds (P0-1). Deux composants qui ont besoin de la même donnée font deux requêtes. Le trafic backend est un multiple inutile du trafic utile.
- **À partir de quand :** proportionnel — pas de rupture, juste une facture multipliée par ~2-3.
- **Solution :** introduire **TanStack Query** (`@tanstack/react-query`) avec `staleTime` par type de donnée (60 s pour les best bets, 5 min pour les classements). Il fournit gratuitement la déduplication des requêtes en vol, le cache entre montages et le retry. Migration progressive, service par service — pas besoin de tout convertir d'un coup.
- **Coût :** 0 € (+ ~13 ko gzip au bundle).
- **Timing :** 🟠 Peut attendre.

---

## P1-11 · Sentry : `tracesSampleRate` à 0.1

- **Composant :** `server/src/instrument.ts`, `SENTRY_TRACES_SAMPLE_RATE=0.1` dans `.env.example`.
- **Pourquoi c'est un risque :** 10 % des requêtes tracées. À ~200 req/s, cela fait **~52 millions de transactions/mois**. Les plans Sentry incluent typiquement quelques dizaines de milliers de transactions ; le dépassement est facturé à l'unité. C'est le type de coût qui n'apparaît que sur la facture.
- **À partir de quand :** **~50-100 utilisateurs simultanés** en continu suffisent à dépasser un quota gratuit.
- **Solution :** descendre à **0.01** (ou 0.02) en production, et utiliser un `tracesSampler` pour tracer 100 % des routes critiques (auth, paiement, settlement) et ~0 % des routes chaudes de lecture. Les **erreurs** restent capturées à 100 % — c'est le tracing de performance qui est échantillonné.
- **Coût :** évite un dépassement potentiellement à trois chiffres.
- **Timing :** 🟠 Peut attendre, mais c'est un changement d'une variable d'environnement : autant le faire tout de suite.

---

## P1-12 · Tennis / RapidAPI : TTL trop court pour un quota mensuel

- **Composant :** `services/tennisApiClient.ts` → `rapidGet(path, ttlMs = 60_000)`.
- **Pourquoi c'est un risque :** le cache existe ✅ et rend le coût **indépendant du nombre d'utilisateurs** — c'est le bon design. Mais un TTL de 60 s autorise jusqu'à ~43 000 appels par mois **et par chemin**, alors que les plans RapidAPI d'entrée de gamme tournent autour de quelques centaines à quelques milliers d'appels mensuels. Le quota peut être épuisé **même avec un seul utilisateur**.
- **À partir de quand :** indépendant du nombre d'utilisateurs — dépend uniquement du TTL et de l'uptime.
- **Solution :** TTL différencié : 60 s pour les matchs *live*, **15-30 min** pour les fixtures et les classements (qui ne bougent pas). Et ne rafraîchir que pendant les fenêtres de tournoi. Le code gère déjà proprement les 403/429 en renvoyant `{results: []}` ✅.
- **Coût :** 0 €.
- **Timing :** 🟠 Peut attendre.

---

## P1-13 · Stripe : deux points mineurs

- **Composant :** `services/subscription.service.ts` → `handleStripeWebhook`, `createCheckoutSession`.
- **Ce qui est déjà bien :** signature vérifiée avant tout traitement ✅, `upsert` idempotent via `ON CONFLICT` ✅, montage `express.raw` avant le parser JSON et hors du rate limiter ✅, réutilisation du customer existant ✅. C'est propre.
- **Les deux risques :**
  1. **Traitement synchrone.** Le webhook fait un `stripe.subscriptions.retrieve` puis un `UPSERT` **avant** de répondre. Si Neon est froid (scale-to-zero) ou lent, le délai peut dépasser le timeout de Stripe → Stripe rejoue l'événement. L'`upsert` étant idempotent, il n'y a pas de corruption, mais tu accumules des rejeux et Stripe finit par désactiver l'endpoint après des échecs répétés.
  2. **Pas de garde sur l'ordre des événements.** Stripe ne garantit pas l'ordre de livraison. Un `customer.subscription.updated` ancien arrivant après un plus récent écrase l'état avec des données périmées.
- **À partir de quand :** proportionnel au volume d'abonnements — statistiquement visible à partir de quelques centaines d'abonnés.
- **Solution :** répondre `200` immédiatement puis traiter (avec une table `stripe_events(id)` pour la déduplication), et ajouter une garde `WHERE subscriptions.updated_at < $event_created` dans l'`upsert`.
- **Coût :** 0 €.
- **Timing :** 🟠 Peut attendre.

---

## P1-14 · Points divers vérifiés

| Point | Constat | Action |
|---|---|---|
| **Google OAuth** | 2 appels externes séquentiels par login (`oauth2.googleapis.com/token` + `userinfo`). Pas de quota problématique côté Google. `loginWithGoogle` fait plusieurs requêtes DB mais utilise un `client` transactionnel. | 🟢 Rien à faire. |
| **`express.json({limit:'5mb'})`** | Appliqué globalement (`app.ts`). 500 requêtes concurrentes à 5 Mo = 2,5 Go bufferisés. | 🔴 Passer à `100kb` global, `5mb` uniquement sur la route avatar. Trivial, à faire avec P0-4. |
| **`apiLimiter` 300/min par IP** | Le NAT opérateur mobile fait partager une IP à de nombreux utilisateurs ; la landing consomme ~7 requêtes. Faux positifs probables. Store en mémoire → non partagé entre instances, remis à zéro à chaque déploiement. | 🟠 Clé par `userId` quand authentifié, IP en repli. Store Redis au multi-instance (le `RedisRateLimitStore` est déjà écrit, il suffit de le brancher ✅). |
| **`isPro()`** | Une requête DB à chaque appel LLM et à chaque route `requirePro`. `SELECT *`. | 🟠 Cache mémoire 30-60 s par `userId`. Le commentaire du code dit vouloir l'immédiateté d'un downgrade : 60 s reste immédiat à l'échelle humaine. |
| **Rotation des refresh tokens** | Une écriture toutes les 15 min par utilisateur actif → ~5,5 écritures/s à 5 000. Le job de cleanup existe ✅ avec 7 jours de grâce, index `expires_at` présent (migration 020) ✅. | 🟢 Acceptable. Réduire `TOKEN_CLEANUP_GRACE_DAYS` à 1-2 si la table gonfle. |
| **Bundle frontend** | `index.js` 344 ko + CSS 124 ko, découpage par route en place ✅ (`vite.config.ts` `manualChunks` + `React.lazy`). | 🟢 Bien fait. Le CSS de 124 ko est le prochain candidat (purge Tailwind). |
| **Migrations** | Toujours pas de table `schema_migrations` ; `migrate-all.ts` rejoue tout en s'appuyant sur `IF NOT EXISTS`. | 🟠 Déjà signalé dans l'audit précédent (M2). Devient dangereux quand tu ne peux plus te permettre une interruption. |
| **`ml_service.py`** | Endpoints synchrones (`def`, pas `async def`) → FastAPI les exécute dans un threadpool, donc pas de blocage ✅. `--workers 2`, chacun charge numpy/pandas/xgboost (~300-500 Mo RSS chacun). | 🟠 Vérifier la RAM allouée au service Railway ; 2 workers ne tiennent pas dans 512 Mo. Ajouter un cache mémoire sur les prédictions (déterministes à features égales). |
| **`mlApiClient`** | Timeout 5 s, aucun retry, aucun circuit breaker. Quand le ML ralentit, `getBestBets` maintient 30 sockets ouvertes 5 s par requête entrante. | 🟠 Ajouter un circuit breaker simple (après N échecs consécutifs, court-circuiter vers les règles pendant 60 s). Le repli règles existe déjà ✅, il manque juste le déclencheur rapide. |
| **`fetchGamesRange`** | Jusqu'à 7 appels NHL séquentiels par plage non cachée, clé de cache `range:<start>:<end>` dérivée de l'entrée utilisateur → prolifération de clés (cf. P1-1). Amplitude bornée à 45 jours ✅. | 🟠 Normaliser la clé sur des semaines calendaires et cacher par semaine, pas par plage arbitraire. |
| **Logging** | pino JSON, health checks et 2 routes chaudes exclus de l'autologging ✅. ~100 k lignes/jour à 5 000 utilisateurs. | 🟠 Échantillonner les 2xx si Railway facture le volume de logs. |

---

# 3. Checklist « Avant le lancement »

Ordonnée par rapport valeur/effort. Les six premières lignes sont ce qui te sépare d'un lancement qui tient à 500 simultanés.

| # | Action | Fichier | Effort | Coût |
|---|---|---|---|---|
| ☑ 1 | **Cacher le proxy Odds API** (TTL 5 min) + `Cache-Control` + log de `x-requests-remaining` — fait, avec en prime une liste blanche de marchés (évite l'explosion de clés) et un repli `getStale` quand le quota est épuisé | `routes/odds.routes.ts` | 1 h | 0 € |
| ☑ 2 | **Cacher `getBestBets`** (TTL 60 s) + déduplication des requêtes en vol — fait via `TtlCache.wrap`, clé dérivée des options normalisées | `services/bestBets.service.ts` | 2 h | 0 € |
| ☑ 3 | **Dé-N+1 le leaderboard** + cache 60 s + index `user_bets(user_id, outcome)` — fait : 21 requêtes → 2 (`fetchBetStats` agrège côté Postgres), cache partagé, index en migration 022 | `services/profile.service.ts` | 2 h | 0 € |
| ☑ 4 | **Remplacer `bcryptjs`** par `@node-rs/bcrypt`, `SALT_ROUNDS` → 10-11, SHA-256 pour les codes, e-mail hors du chemin de requête | `services/auth.service.ts` | 2 h | 0 € |
| ☑ 5 | **Fermer le service ML** : réseau privé Railway (`*.railway.internal`), retirer le domaine public | `DEPLOYMENT.md`, var. Railway | 30 min | 0 € |
| ☑ 6 | **Redimensionner les avatars côté client** (256×256 WebP, repli JPEG) + `express.json` à `100kb` global — plafond de la route avatar fixé à **600 ko** et non 5 Mo : un 256×256 WebP pèse ~27 ko en base64, donc 5 Mo laissait une surface de blocage de l'event loop sans aucun usage légitime | `client/services/userService.ts` + `app.ts` | 3 h | 0 € |
| ☐ 7 | **Confirmer que `DATABASE_URL` pointe sur l'endpoint Neon `-pooler`** ; corriger `DEPLOYMENT.md` (il documente encore Supabase) | var. Railway + doc | 30 min | 0 € |
| ☑ 8 | **Aligner le CORS Socket.io** sur la logique de `app.ts` (liste + regex preview) — politique extraite dans `server/src/cors.ts`, partagée par HTTP et WebSocket, couverte par `cors.test.ts` | `socket.ts`, `app.ts`, `cors.ts` | 30 min | 0 € |
| ☐ 9 | **Passer Vercel sur Pro** (usage commercial) | — | 10 min | ~20 $/mois |
| ☐ 10 | **`SENTRY_TRACES_SAMPLE_RATE=0.01`** en production | var. Railway | 2 min | 0 € |
| ☐ 11 | **Mettre Cloudflare (gratuit) devant Railway** + `Cache-Control` sur `/api/nhl/*` et `/api/odds/*` | `routes/` + DNS | 3 h | 0 € |
| ☐ 12 | **Alertes de budget** : Railway (usage), Neon, Stripe, provider LLM, The Odds API | consoles | 1 h | 0 € |
| ◐ 13 | **Exécuter le scénario de charge S1** ci-dessous et corriger ce qu'il révèle — script, compteurs et runbook prêts (`loadtest/`, `server/src/metrics.ts`) ; **reste à choisir la cible et à tirer** | — | 1 j | 0 € |

**Total : ~2,5 jours de travail, +20 $/mois.**

---

# 4. Checklist « Peut attendre »

À déclencher sur seuil, pas sur calendrier.

| # | Action | Déclencheur | Effort | Coût |
|---|---|---|---|---|
| ☑ A | Éviction des caches mémoire — `TtlCache` (plafond d'entrées, éviction FIFO) appliqué à `nhlApiClient`, `tennisApiClient`, `refereeStore` et au quota LLM ; TTL par entrée ajouté à `TtlCache`. Sans dépendance | ~1 000 utilisateurs, ou premier OOM Railway | 2 h | 0 € |
| ☑ B | Dé-N+1 le chat — réactions déjà groupées (`= ANY($1)`) ; liste des salons passée à une requête unique (`LEFT JOIN LATERAL` + compte corrélé), 31 requêtes → 1 | ~200 simultanés dans le chat | 3 h | 0 € |
| ☐ C | Verrou consultatif Postgres sur les jobs planifiés | **avant la 2ᵉ instance** | 2 h | 0 € |
| ☐ D | Redis (Upstash) : adapter Socket.io + `RedisRateLimitStore` (déjà écrit ✅) + quota LLM (borné en mémoire depuis A, mais toujours **par instance** : N instances = N× le quota) | **avant la 2ᵉ instance** | 1 j | 0-10 €/mois |
| ☐ E | Avatars vers Cloudflare R2, ne stocker que l'URL | ~500 utilisateurs avec avatar | 1 j | 0-5 €/mois |
| ☑ F | Débouncer `room_users` — une mesure + un envoi par salon toutes les 3 s (`ROOM_COUNT_INTERVAL_MS`) ; l'arrivant reçoit son compte immédiatement en O(1) via `adapter.rooms` | ~500 sockets dans un salon | 2 h | 0 € |
| ☐ G | Concurrence bornée sur le fan-out push + `WHERE user_id = ANY($1)` | ~300 destinataires opt-in | 3 h | 0 € |
| ☐ H | Settlement : pagination jusqu'à épuisement, regroupement par match, index partiel | ~300 tickets/soirée | 1 j | 0 € |
| ☐ I | TanStack Query côté client | quand la facture Railway devient visible | 2 j | 0 € |
| ☐ J | Plafond global LLM en base + cache de prompts | quand l'usage LLM devient significatif | 1 j | variable |
| ☐ K | `oddsLogger` → table Postgres | **avant `ODDS_LOG_ENABLED=true`** | 4 h | 0 € |
| ☐ L | Cache mémoire sur `isPro()` (30-60 s) | ~1 000 utilisateurs Pro | 1 h | 0 € |
| ☐ M | Circuit breaker sur `mlApiClient` + cache des prédictions ML | ~1 000 simultanés | 4 h | 0 € |
| ☐ N | Table `schema_migrations` (ou `node-pg-migrate`) | avant la première migration sur données de production critiques | 1 j | 0 € |
| ☐ O | TTL différenciés Tennis (15-30 min sur fixtures/classements) | à la première alerte de quota RapidAPI | 1 h | 0 € |
| ☐ P | Webhook Stripe asynchrone + garde d'ordonnancement | ~500 abonnés | 4 h | 0 € |
| ☐ Q | 2ᵉ instance Railway + sticky sessions | quand la charge CPU dépasse ~70 % en régime | 4 h | ~+5-20 €/mois |

---

# 5. Tests de charge à exécuter

Outil recommandé : **k6** (scriptable, gratuit, exécutable en local ou en CI). Alternative : Artillery.

> Les scripts et la procédure vivent dans **`loadtest/`**. Les critères qui portent sur les appels sortants et les exécutions de cache se lisent sur `GET /api/dev/metrics` (module `server/src/metrics.ts`) — k6 ne peut pas les voir.

> **Règle absolue :** exécuter ces tests contre un **environnement de préproduction** avec sa propre base Neon et — surtout — des **clés API externes de test ou désactivées**. Un test de charge contre la production consommerait ton quota The Odds API en quelques secondes et enverrait de vraies notifications push.

### S1 — Vague d'arrivée sur la landing (**le test qui décide du lancement**)
- **Profil :** montée de 0 → 500 utilisateurs virtuels en 60 s, maintien 5 min. Chaque VU rejoue la séquence réelle de `HockeyLanding` : `GET /api/predict/best-bets`, `GET /api/nhl/games/live`, `GET /api/nhl/games?date=…`, `GET /api/odds/bet365/icehockey_nhl`, `GET /api/odds/bet365/tennis_*`, `GET /api/leaderboard`.
- **À mesurer :** p50/p95/p99 par endpoint, taux d'erreur, **nombre d'appels sortants réellement émis vers The Odds API et vers le service ML** (c'est la métrique clé — elle doit être *constante*, pas proportionnelle aux VUs), RSS du conteneur Node, connexions Neon actives, CPU du service ML.
- **Critères de réussite :** p95 < 800 ms, erreurs < 0,5 %, **≤ 2 appels Odds API sur toute la durée du test**, **≤ 5 exécutions complètes de `getBestBets`**.
- **Si ça échoue :** P0-1, P0-2 et P0-3 ne sont pas corrigés.
- **✅ Outillé (2026-07-28), pas encore exécuté.** Script : `loadtest/s1-landing.js`. Procédure complète : `loadtest/README.md`.
  Les deux derniers critères n'étaient **pas mesurables depuis k6**, qui ne voit que la façade HTTP : un endpoint qui répond 200 en 40 ms peut avoir appelé l'upstream 500 fois ou 1 fois, c'est indiscernable de l'extérieur. D'où `server/src/metrics.ts` : compteurs d'appels sortants par API externe (posés aux points d'étranglement — `fetchNHL`, `mlPost`, `rapidGet`, les deux consommateurs d'Odds), compteurs par cache nommé (hits / **misses = exécutions réelles** / dedup / évictions), retard de l'event loop et RSS. Lecture sur `GET /api/dev/metrics`, déjà admin-only et non monté en prod sans `ENABLE_DEV_ROUTES`.
  **Deux pièges documentés dans le runbook :** (1) `apiLimiter` plafonne à 300 req/min/IP — sans `API_RATE_LIMIT` relevé, le test mesure le limiteur et non l'application, et rend un résultat faussement excellent ; (2) `/api/dev/metrics/reset` ne vide pas les caches, donc il ne sert pas à préparer S3.
  **Trou identifié et MESURÉ (2026-07-28), sans avoir eu besoin du run complet :** `nhlApiClient` utilise `getCached`/`setCached` et non `wrap` — il n'a donc **aucune déduplication en vol**. Banc `loadtest/stampede.ts` (vrai code, `fetch` bouchonné) : 10 concurrents → 10 appels NHL, 100 → 100, 500 → 500. La même charge à travers `wrap` → **1 appel** (dedup = 499). Contrôle à cache chaud → 0 appel, donc le cache fonctionne : le trou est strictement la fenêtre froide (démarrage, redéploiement, expiration de TTL).
  Ordre de grandeur en trafic réel : les doublons valent environ `débit d'arrivée × latence amont` par fenêtre froide — ~10 appels au lieu d'1 à 50 req/s et 200 ms. L'API NHL étant gratuite, le coût est de la latence et un risque de throttling, pas une facture.
  **✅ Corrigé (2026-07-28).** La déduplication a été posée dans `fetchNHL` / `fetchNHLSearch` plutôt que fonction par fonction : le point d'étranglement HTTP couvre les 19 fonctions d'un coup — y compris celles qu'on oublierait — et deux fonctions différentes demandant la même URL partagent aussi la requête. Surtout, **aucune sémantique de cache n'est touchée** : les cas « ne pas mettre en cache » (jour sans match, boxscore absent, échec réseau) restent identiques, là où une migration vers `wrap` aurait dû les reproduire un à un dans un diff de 1 650 lignes.
  Banc rejoué après correction : **500 concurrents → 1 appel** (contre 500). Non-régression verrouillée par `server/src/services/nhlApiClient.test.ts` (4 tests, dont « un échec n'est pas mémorisé » — sans quoi une coupure réseau gèlerait l'endpoint jusqu'au redémarrage).
  **Reste non fait, volontairement :** le post-traitement (formatage, agrégation) tourne encore une fois par appelant. C'est du CPU, plus du réseau ni du quota. Si un profilage le désigne, la suite est de basculer les fonctions les plus chaudes sur `TtlCache.wrap`.

### S2 — Vague d'inscriptions/connexions
- **Profil :** 50 inscriptions puis 200 connexions en 30 s.
- **À mesurer :** **latence de l'event loop** (`perf_hooks.monitorEventLoopDelay` exposé sur une route de debug, ou l'instrumentation Sentry), p95 de `/api/auth/login`, et l'impact sur une route de lecture concurrente.
- **Critères :** p95 login < 1 s, **et surtout** : la latence des routes de lecture ne doit pas se dégrader pendant la vague. C'est ce qui révèle le blocage bcryptjs (P0-6).

### S3 — Cache froid / redéploiement
- **Profil :** redémarrer le service, puis envoyer immédiatement 300 requêtes concurrentes sur `/api/predict/best-bets`.
- **À mesurer :** nombre d'exécutions réelles de `getBestBets` et d'appels au service ML.
- **Critères :** **1 seule exécution** (validation de la déduplication en vol). Sans elle, chaque déploiement provoque une tempête. C'est le test le plus souvent oublié.

### S4 — Chat et WebSocket
- **Profil :** 500 sockets se connectant et rejoignant le même salon en 60 s, puis 5 messages/s pendant 5 min, avec des déconnexions/reconnexions aléatoires (10 %).
- **À mesurer :** messages sortants émis par le serveur (attention à l'amplification `room_users`, P1-3), RSS, latence de bout en bout d'un message, requêtes Neon par ouverture de salon (doit être ~2, pas ~100).
- **Critères :** latence de diffusion p95 < 500 ms, mémoire stable.

### S5 — Endurance / fuite mémoire (**le plus important pour le coût**)
- **Profil :** 100 VUs en continu pendant **2 à 4 heures**, en variant les paramètres pour créer des clés de cache distinctes (ids de joueurs différents, plages `/api/nhl/games/range` différentes, ids de matchs différents).
- **À mesurer :** courbe du RSS dans le temps.
- **Critères :** le RSS doit **se stabiliser sur un plateau**. Une croissance linéaire confirme P1-1 et prédit des redémarrages OOM en production.

### S6 — Soirée de matchs / settlement
- **Profil :** insérer 2 000 tickets pending référençant 10 matchs, marquer les matchs comme terminés (ou mocker `fetchGameById`), déclencher le settlement.
- **À mesurer :** temps de règlement total, appels NHL émis, connexions Neon.
- **Critères :** 2 000 tickets réglés en < 10 min. Avec le plafond actuel de 100-200 par passe, ce test **échouera** — c'est précisément ce qu'il doit démontrer (P1-8).

### S7 — Budget des API externes (test analytique, pas de charge)
- Instrumenter un compteur par API externe (Odds, NHL, RapidAPI, LLM, ML) et le laisser tourner **24 h en préproduction avec un trafic simulé réaliste**. Extrapoler à 30 jours et comparer aux quotas des plans. C'est le seul moyen fiable de prévoir ta facture — et il vaut mieux le découvrir maintenant.

---

# 6. Ce que je n'ai pas pu vérifier

Pour fiabiliser cet audit, il me faudrait :

1. **La configuration Railway réelle** : plan, RAM/vCPU alloués par service, nombre de replicas, et si le service ML a un domaine public. La différence entre 512 Mo et 8 Go change plusieurs seuils de ce rapport (notamment P1-1 et le nombre de workers uvicorn viable).
2. **La chaîne de connexion Neon** (masquée) : endpoint `-pooler` ou direct ? Plan et taille de compute ? Autosuspend activé ? — détermine P0-7.
3. **Le plan The Odds API et le plan RapidAPI** effectivement souscrits : les quotas exacts changent l'urgence de P0-1 et P1-12 (de « critique » à « à surveiller »).
4. **Les métriques de production actuelles** s'il y a déjà du trafic : req/s, p95, RSS, connexions Neon. N'importe quel export Railway/Sentry de 7 jours remplacerait mes estimations par des mesures.
5. **`client/src/app/services/predictionApiService.ts` et `nhlApiService.ts`** en entier — je les ai vus par leurs appelants, pas ligne à ligne ; il pourrait y avoir un cache client que je n'ai pas repéré (le `grep` sur `setInterval`/`refetchInterval` n'a rien trouvé, donc c'est peu probable, mais je préfère le dire).
6. **Le taux d'usage attendu de la fonctionnalité LLM** (requêtes/utilisateur/jour) : c'est la seule inconnue qui empêche de chiffrer P1-6.
7. **La saisonnalité** : la NHL a une intersaison. 5 000 simultanés en mars et 200 en juillet, ce n'est pas la même infrastructure — un dimensionnement élastique (scale-to-zero Neon, replicas Railway variables) peut diviser la facture annuelle par deux.

---

# 7. Résumé exécutif

**L'architecture n'est pas le problème.** Vite/Vercel + Express/Railway + Neon + un service ML séparé est un choix cohérent, peu coûteux, et qui monte à 5 000 utilisateurs simultanés sans refonte. Le code est de bonne facture : requêtes paramétrées, TTL déjà en place sur les clients NHL et Odds, arrêt gracieux, sondes liveness/readiness distinctes, garde anti-double-règlement, interface `RateLimitStore` avec l'implémentation Redis **déjà écrite** en attente d'être branchée. Beaucoup de bonnes décisions ont été prises en amont.

**Le problème est que trois ou quatre endroits font un travail proportionnel au nombre d'utilisateurs alors qu'ils devraient faire un travail constant.** Le proxy Odds appelle l'upstream une fois par visiteur au lieu d'une fois toutes les 5 minutes. `best-bets` recalcule 30 prédictions ML par visiteur au lieu d'une fois par minute. Le leaderboard exécute 21 requêtes par visiteur au lieu d'en servir une version cachée. Les avatars sont transportés en base64 dans chaque payload au lieu d'être servis par un CDN. Ce sont quatre corrections locales, sans impact architectural, pour un coût d'infrastructure nul.

**Le seul vrai verrou architectural** — et il n'est pas urgent — est l'**état partagé en mémoire** : caches, limiteurs de débit, adapter Socket.io et ordonnancement des jobs vivent tous dans le process. C'est le bon choix pour une instance et ça ne coûte rien. Mais le jour où tu passes à deux instances, il faut Redis et un verrou d'unicité sur les jobs, sinon les notifications partent en double et le chat se scinde silencieusement en deux moitiés qui ne se parlent pas. Prévois-le comme une étape identifiée, pas comme une urgence.

**Le plus gros risque de dépense imprévue n'est pas l'hébergement** — Railway, Neon et Vercel resteront de l'ordre de quelques dizaines d'euros par mois à cette échelle. Ce sont les **APIs tierces facturées à l'appel** : The Odds API sans cache, le LLM sans plafond global, le service ML exposé publiquement, et Sentry à 10 % d'échantillonnage. Ce sont les quatre lignes qui peuvent produire une facture surprenante, et ce sont aussi les quatre qui se corrigent le plus vite.

**En une phrase :** environ 2,5 jours de travail avant le lancement (dont l'essentiel est de la mise en cache) et +20 $/mois te font passer de « ne tient pas 500 simultanés » à « tient 500 confortablement, et 5 000 avec Redis et une deuxième instance ».
