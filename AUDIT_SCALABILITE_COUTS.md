# ARAKICE / ICEEDGE — Audit de scalabilité & de coûts

**Date :** 2026-07-28 · **dernière mise à jour :** 2026-08-03
**Cible :** 500 utilisateurs simultanés au lancement → 5 000 simultanés avec un minimum de changements
**Contrainte :** infrastructure peu coûteuse, pas de refonte, réutilisation de l'architecture existante
**Méthode :** inspection directe du code (`server/src`, `client/src`, `ml/python`, `server/src/db`, Dockerfiles, `vercel.json`, `.env.example`). Chaque constat cite un fichier réel.

> Complémentaire de `PRODUCTION_READINESS_AUDIT.md` (2026-07-20, retiré le 2026-09-24 : entièrement livré ou repris ici — voir `STATUS.md`), qui traitait la sécurité. **Ce document n'y revient pas.** Il regarde une seule chose : *qu'est-ce qui casse ou explose en coût quand le nombre d'utilisateurs est multiplié par 10 ?*

> **Sur les chiffres.** Les montants sont des **ordres de grandeur** ; les prix changent, vérifie avant d'engager une dépense. Ce qui compte n'est pas le montant mais la **forme de la courbe** : coût *constant* (cache partagé) contre coût *linéaire au nombre d'utilisateurs* (appel non caché). Les seuils « à partir de N utilisateurs » sont des estimations dérivées du code, pas des mesures — le plan de tests de charge (§5) sert à les valider.

---

> Les corrections livrées (§1 et §2 d'origine : P0-1 → P1-15, G, L, M, H, P, K, X, Y, Z)
> ont été retirées le 2026-10-05 — `git show 0916b52:AUDIT_SCALABILITE_COUTS.md`. Restent
> l'état, ce qui est ouvert et ce qui se déclenche sur seuil (`STATUS.md` §3.6).

## Hypothèses de charge

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

| Domaine | 500 | 5 000 | Commentaire |
|---|---|---|---|
| **Vercel / frontend** | 🟢 | 🟢 | SPA Vite statique = quasi gratuit. Seul sujet : le plan Hobby interdit l'usage commercial (ligne 9). |
| **The Odds API** | 🟢 | 🟢 | ✅ Proxy : cache 5 min + `Cache-Control` + repli `getStale`. ✅ `oddsClient` : troupeau corrigé le 2026-08-03 (ligne Z) — c'était 26 appels par exécution de `best-bets`. Les **deux** consommateurs du quota sont désormais bornés. |
| **`/api/predict/best-bets`** | 🟢 | 🟢 | ✅ Cache 60 s + déduplication en vol : 500 arrivées sur un cache froid = **une** exécution. |
| **`/api/leaderboard`** | 🟢 | 🟢 | ✅ 21 requêtes → 2, cache 60 s, index `(user_id, outcome)`. |
| **Avatars** | 🟢 | 🟢 | ✅ 256×256 WebP côté client (~27 ko), déduplication par auteur, upload R2 branché. Reste la migration des data-URI historiques. |
| **Service ML Python** | 🟢 | 🟠 | ✅ Réseau privé Railway, ✅ disjoncteur + cache d'inférence. Reste 2 workers — vérifier la RAM allouée. |
| **Neon Postgres** | 🟢 | 🟠 | ✅ `-pooler` confirmé et documenté. Reste le choix scale-to-zero vs compute permanent (ligne 7 bis). |
| **Railway / process Node** | 🟢 | 🟠 | ✅ `@node-rs/bcrypt`, caches bornés, jobs sous bail Postgres. |
| **Socket.io / chat** | 🟢 | 🟢 | ✅ Présence coalescée, CORS aligné. ✅ **Adaptateur Redis livré le 2026-09-19** (`@socket.io/redis-adapter`, derrière `REDIS_URL` : variable absente ⇒ comportement mémoire inchangé). La diffusion traverse les instances, et le banc B12 le vérifie. Reste le limiteur de débit, toujours par process (ligne D). |
| **Stripe** | 🟢 | 🟢 | ✅ Signature vérifiée, upsert idempotent, déduplication des événements + garde d'ordonnancement. |
| **Google OAuth** | 🟢 | 🟢 | Aucun goulot. |
| **LLM (GitHub Models)** | 🟢 | 🟢 | ✅ Plafond mensuel dérivé du prix de l'abonnement, compteur en base, bascule sur la clé perso au plafond. |
| **Push notifications** | 🟢 | 🟢 | ✅ Une requête de lecture pour tout le lot + plafond d'envois simultanés + purge groupée. |
| **Règlement des paris** | 🟢 | 🟢 | ✅ Pagination par curseur jusqu'à épuisement, budget temps, jambes en parallèle borné, index partiel. |
| **Cache HTTP / CDN** | 🟢 | 🟢 | ✅ `Cache-Control` sur les 20 routes NHL + `no-store` sur les 7 routeurs authentifiés. Reste Cloudflare devant Railway (ligne 11). |
| **Logging / erreurs** | 🟢 | 🟢 | ✅ Tracing échantillonné à 1 % **par défaut en production**, côté Node et côté Python. Les erreurs restent à 100 %. |
| **Tâches planifiées** | 🟢 | 🟢 | ✅ Bail Postgres sur les 5 jobs, `lastAlertKey` partagé, `oddsLogger` écrit en base. |

**Où on en est (2026-08-03)**

- **500 simultanés : plus de 🔴, et plus rien à faire côté code.** Il ne reste que **le scénario de charge S1 (13), toujours pas exécuté** — tant qu'il ne l'a pas été, tout ce tableau reste une prédiction — et deux lignes **reportées au lancement officiel** par décision : Vercel Pro (9) et Cloudflare (11).
- **5 000 simultanés : plus de 🔴 depuis le 2026-09-19.** L'adaptateur Socket.io — le dernier verrou architectural — est livré et mesuré (banc B12). Ce qui reste de la ligne D n'est plus un verrou mais un réglage : le limiteur de débit du chat compte toujours en mémoire de process, donc N instances = N× l'autorisation.
- **Lot du 2026-08-02** — six lignes fermées côté code, aucune dépendance ajoutée, aucun service en plus : fan-out push borné (G), cache d'entitlement `isPro` (L), disjoncteur + cache ML (M), pagination du règlement (H), déduplication et ordonnancement des webhooks Stripe (P), journal des cotes en base (K). Détail par ligne en §2.
- **Second lot du 2026-08-02** — l'échantillonnage Sentry (10) est passé **dans le code** plutôt que dans une variable Railway : 0.01 par défaut en production, côté Node et côté Python. Un garde-fou qu'il faut penser à activer est un garde-fou éteint. Les alertes de budget (12) sont documentées seuil par seuil dans `MONITORING.md`. Le harnais S1 (13) a été revu pour correspondre au code actuel.
- **Tirs S1 (2026-08-03) — trois défauts trouvés, aucun n'avait été produit par la relecture de code.** `fetchNHL` sans timeout (ligne X), routes NHL rendant 500 au lieu de servir du périmé (ligne Y), et surtout **`oddsClient` en troupeau sur la seule API facturée à l'appel** (ligne Z) : 26 crédits consommés par *une* exécution de `best-bets`, soit ~225 000 par mois au lieu de ~8 600. Les trois sont corrigés. Détail des runs et de leurs angles morts en §5.
- **La leçon méthodologique du run**, plus utile que les trois correctifs : pendant les deux premiers tirs, `odds.calls` valait 1 et le critère 3 semblait tenu — parce que l'API NHL était morte, donc aucun match à pricer, donc le chemin coûteux ne tournait pas. **Un critère vert peut simplement vouloir dire que le code concerné n'a pas été exercé.** Le troisième run, avec le mock, a produit des matchs et fait surgir le vrai coût.
- **Ce qui a été écarté sciemment :** les TTL Tennis (ligne O) — décision produit, pas oubli. Vercel Pro et Cloudflare sont **reportés**, pas écartés. *(Redis, longtemps dans cette liste, en est sorti le 2026-09-19 : le code est livré et inerte sans `REDIS_URL`.)*

---

# 3. Ce qui reste ouvert

## D · État partagé entre instances — 🟠 l'adaptateur Socket.io est livré, le limiteur de débit ne l'est pas

**Mise à jour du 2026-09-19.** La partie 🔴 de cette ligne — la diffusion du
chat — est fermée. Ce qui reste n'est plus un verrou architectural : c'est un
compteur qui devient trop généreux à N instances.

- **Composants :** `server/src/socket.ts`, `server/src/redis.ts` (nouveau), `client/src/app/hooks/useChatSocket.ts`.
- **Ce qui était en cause :** l'adaptateur mémoire fait que `io.to(roomId).emit(...)` ne touche que les sockets de *ce* process. Dès la 2ᵉ instance Railway, la moitié des utilisateurs d'un salon cesse de recevoir les messages de l'autre moitié — **silencieusement**. Ce n'est plus une déduction de lecture de code : le banc `loadtest/bench/b12-multiinstance.ts` le reproduit — deux applications complètes, un lecteur sur chacune, un message qui n'arrive qu'à un seul.
- **Ce qui est livré :** `@socket.io/redis-adapter` + `ioredis`, branchés derrière `REDIS_URL`. **Variable absente ⇒ adaptateur mémoire, comportement d'avant strictement inchangé** — c'est ce qui permet de livrer le code avant de provisionner le service, et de garder le développement local sans dépendance de plus. Avec `REDIS_URL`, B12 passe au vert sans avoir été retouché : le message traverse, et chaque instance annonce le salon entier au lieu de ses seuls sockets locaux. La bannière de démarrage affiche `SOCKET_ADAPTER: redis | mémoire`, parce que c'est un réglage qu'on ne peut pas déduire du comportement observable tant qu'on n'a qu'un conteneur.
- **⚠️ Correction d'une erreur de cette ligne : les sticky sessions n'existent pas sur Railway**, et ne sont pas annoncées. La solution retenue est donc `transports: ['websocket']` côté client : une connexion WebSocket est négociée une fois et reste sur le même conteneur, là où le repli HTTP long-polling de Socket.io fait une requête par échange et exige, lui, l'affinité de session. Ce que ce choix coûte : plus de repli automatique derrière un proxy d'entreprise qui bloque le WebSocket.
- **Ce qui reste ouvert :** `RateLimitStore` n'a qu'une implémentation, `InMemoryRateLimitStore` — **par process**. N instances = N× l'autorisation, pour le limiteur du chat (`chat.routes.ts`) comme pour les limiteurs `express-rate-limit` (aucun n'a de `store:` configuré). *Correction d'une deuxième erreur de cette ligne : `RedisRateLimitStore` n'est **pas** déjà écrit — seule l'interface existe, avec la marche à suivre (`INCR` + `PEXPIRE`) en commentaire. Et le quota LLM n'est plus concerné : il est en base depuis la migration 024, donc déjà partagé.* Le Redis étant désormais là, il ne reste qu'à y brancher le compteur.
- **Coût :** 0-10 €/mois, inchangé — et rien n'est dépensé tant que `REDIS_URL` n'est pas posée. **Déclencheur du reliquat : avant la 2ᵉ instance.**

## Configuration de console (avant lancement)

| # | Action | Où | Effort | Coût |
|---|---|---|---|---|
| ⏸ 9 | **Passer Vercel sur Pro** — le plan Hobby est réservé aux projets non commerciaux, et ArakIce vend un abonnement ; un projet signalé peut être suspendu sans préavis utile. Risque contractuel, pas technique. **Reporté au lancement officiel** : tant que rien n'est vendu, le risque ne s'est pas matérialisé — mais il commence **à la première vente**, pas au premier utilisateur | console Vercel | 10 min | ~20 $/mois |
| ☑ 10 | **Échantillonnage Sentry** — réglé **dans le code** : `instrument.ts` prend 0.01 par défaut en production (0.1 ailleurs), et `ml_service.py` suit la même règle. `SENTRY_TRACES_SAMPLE_RATE` ne sert plus qu'à s'en écarter volontairement. À 0.1 et ~200 req/s on émettrait ~52 M de transactions/mois, très au-delà des quotas inclus, et le dépassement ne se voit que sur la facture. Les **erreurs** restent capturées à 100 % | `instrument.ts`, `ml_service.py` | fait | 0 € |
| ⏸ 11 | **Cloudflare devant Railway** — les en-têtes de cache sont posés (P1-9) ; c'est ce qui manque pour qu'un CDN serve à quelque chose. Réduit aussi l'egress Railway, qui est facturé. **Reporté au lancement officiel** avec la ligne 9 | DNS | 1 h | 0 € |
| ☑ 12 | **Alertes de budget** — seuils, emplacements et lecture documentés dans `MONITORING.md` § « Alertes de budget » : Railway, Neon, The Odds API, provider LLM, Stripe, Sentry, R2. Deux principes : seuils à ~50 % du plafond acceptable (à 90 % il ne reste qu'à payer), et **hard limits là où ils existent** — une alerte suppose que quelqu'un lise dans l'heure, un plafond dur agit tout seul. **Reste à les poser dans les consoles** | `MONITORING.md` + consoles | 30 min | 0 € |
| ◐ 13 | **Exécuter le scénario S1** (§5) — **premier tir fait le 2026-08-03** (local, 500 VUs, interrompu à 98 s par `abortOnFail`, comme prévu). Résultats et suites en §5. **Reste : le tir de validation** en `NHL_USE_MOCK=true` à 50 VUs, puis un tir court avec la vraie clé Odds pour prouver le critère 3 | — | 0,5 j | 0 € |

## À déclencher sur seuil

| # | Action | Déclencheur | Effort | Coût |
|---|---|---|---|---|
| ◐ D | Redis : ✅ adaptateur Socket.io **livré le 2026-09-19** (inerte sans `REDIS_URL`) · ☐ reste `RedisRateLimitStore` à écrire et à brancher (le quota LLM, lui, est en base depuis la 024) | **avant la 2ᵉ instance** | 0,5 j | 0-10 €/mois |
| ◐ E | Migrer les data-URI d'avatars déjà en base vers R2 — le code et les variables sont en place, il ne reste que la reprise de l'historique | ~500 utilisateurs avec avatar | 2 h | 0 € |
| ☐ I | TanStack Query côté client — `fetch` brut partout, aucune déduplication ; revenir sur la page d'accueil relance les ~7 appels. Pas de rupture, juste une facture ×2-3. Migration progressive, service par service | quand la facture Railway devient visible | 2 j | 0 € |
| ☐ O | TTL différenciés Tennis (15-30 min sur fixtures/classements au lieu de 60 s) | *écarté sciemment* | 1 h | 0 € |
| ☐ Q | 2ᵉ instance Railway — **sans** sticky sessions : Railway n'en propose pas. Prérequis : `REDIS_URL` posée (ligne D) et le client en `transports: ['websocket']`, déjà fait | charge CPU > ~70 % en régime | 4 h | ~+5-20 €/mois |
| ☐ 7 bis | **Décider** : scale-to-zero Neon (sonde de readiness qui ne tape pas la DB à chaque appel, probes espacées) **ou** compute permanent assumé (et suppression de la complexité des cadences de règlement). Aujourd'hui : le coût des deux, le bénéfice d'aucun | hors-saison NHL | 2 h | −10 à −50 €/mois |
| ☐ R | `apiLimiter` : clé par `userId` quand authentifié, IP en repli — le NAT opérateur mobile fait partager une IP, et la landing consomme ~7 requêtes. Faux positifs probables | premiers signalements de 429 | 2 h | 0 € |
| ☐ S | `fetchGamesRange` : normaliser la clé de cache sur des semaines calendaires plutôt que sur une plage arbitraire dérivée de l'entrée utilisateur | prolifération de clés visible dans `/api/dev/metrics` | 2 h | 0 € |
| ☐ T | Cache de prompts LLM identiques (hash prompt+système+modèle, TTL 1 h) — réduirait le coût réel mais **ne change pas la garantie**, qui raisonne sur le pire cas où rien n'est répété | quand l'usage LLM devient significatif | 4 h | 0 € |
| ☐ U | RAM du service ML Railway : 2 workers uvicorn chargent chacun numpy/pandas/xgboost (~300-500 Mo RSS). Ne tiennent pas dans 512 Mo | avant le premier pic réel | 15 min | variable |
| ☐ V | Échantillonner les logs 2xx si Railway facture le volume (~100 k lignes/jour à 5 000 utilisateurs) | à la première facture de logs | 1 h | 0 € |
| ☐ W | Purge Tailwind : le CSS du bundle pèse 124 ko (le JS, lui, est déjà découpé par route ✅) | — | 2 h | 0 € |

---

# 4. Nouvelles variables d'environnement (lot 2026-08-02)

Toutes ont une valeur par défaut sensée dans le code ; les poser n'est nécessaire que pour s'écarter du défaut.

| Variable | Défaut | Rôle |
|---|---|---|
| `PUSH_CONCURRENCY` | 20 | Notifications envoyées en parallèle sur un lot (G) |
| `PRO_CACHE_TTL_MS` | 60000 | Durée du cache d'entitlement Pro (L) |
| `ML_BREAKER_THRESHOLD` | 5 | Échecs consécutifs avant ouverture du circuit (M) |
| `ML_BREAKER_COOLDOWN_MS` | 60000 | Fenêtre de repos du disjoncteur (M) |
| `ML_CACHE_TTL_MS` | 300000 | TTL du cache d'inférence (M) |
| `SETTLEMENT_BATCH` | 100 | Tickets lus par aller-retour Postgres (H) |
| `SETTLEMENT_MAX_SLIPS` | 5000 | Garde-fou anti-boucle-infinie (H) |
| `SETTLEMENT_BUDGET_MS` | 120000 | Budget temps par défaut d'une passe (H) |
| `SETTLEMENT_LEG_CONCURRENCY` | 4 | Jambes d'un ticket traitées en parallèle (H) |
| `STRIPE_EVENT_RETENTION_DAYS` | 30 | Rétention du registre de déduplication (P) |
| `SENTRY_TRACES_SAMPLE_RATE` | **0.01 en prod**, 0.1 sinon | Le défaut est désormais dans le code ; **laisser la variable vide** en production (ligne 10) |
| `NHL_TIMEOUT_MS` | 8000 | Abandon d'un appel NHL — l'absence de timeout laissait undici attendre 300 s (ligne X) |
| `STALE_FALLBACK_TTL_MS` | 1800000 | Durée pendant laquelle une réponse NHL reste utilisable en repli (ligne Y) |
| `STALE_FALLBACK_MAX_ENTRIES` | 120 | Plafond d'URL mémorisées pour le repli (ligne Y) |
| ~~`ODDS_LOG_PATH`~~ | — | **Supprimée** : le journal des cotes vit en base (K) |

**Migrations ajoutées :** 025 (index partiels des tickets en attente), 026 (`stripe_events` + `subscriptions.last_event_at`), 027 (`odds_log`).

---

# 5. Tests de charge à exécuter

Outil recommandé : **k6**. Scripts et procédure dans **`loadtest/`**. Les critères portant sur les appels sortants et les exécutions de cache se lisent sur `GET /api/dev/metrics` (`server/src/metrics.ts`) — k6 ne peut pas les voir.

> **Règle absolue :** exécuter contre une **préproduction** avec sa propre base Neon et des **clés API externes de test ou désactivées**. Un tir contre la production consommerait le quota The Odds API en quelques secondes et enverrait de vraies notifications push.

### S1 — Vague d'arrivée sur la landing (**le test qui décide du lancement**)
- **Profil :** 0 → 500 VUs en 60 s, maintien 5 min, rejouant la séquence réelle de `HockeyLanding` (`best-bets`, `games/live`, `games?date=`, les deux appels odds, `leaderboard`).
- **Critères :** p95 < 800 ms, erreurs < 0,5 %, **≤ 2 appels Odds API** sur toute la durée, **≤ 5 exécutions complètes de `getBestBets`**. Les deux derniers sont la vraie mesure : un endpoint qui répond 200 en 40 ms peut avoir appelé l'upstream 500 fois ou 1 fois, c'est indiscernable de l'extérieur.
- **✅ Premier tir exécuté le 2026-08-03** (local, 500 VUs, `NHL_USE_MOCK` inactif). Interrompu à 98 s par `abortOnFail` sur `ep_best_bets` — le garde-fou a fait son travail au lieu de faire attendre 6 minutes.

  **Ce qui a été prouvé.** `best-bets` : **2 exécutions** sur 6 minutes pour 1 039 hits et **495 dédoublonnages en vol** — le critère 4 est tenu et l'anti-stampede est démontré sous charge réelle, pas seulement au banc. `leaderboard` : 2 exécutions, 1 493 hits. Et surtout **`upstream.nhl.calls = 70` pour 500 VUs** : le nombre d'appels sortants ne suit pas le nombre de visiteurs, ce qui est la thèse centrale de cet audit.

  **Ce que le tir a trouvé.** Le timeout manquant sur `fetchNHL` (ligne X ci-dessus). C'est le seul vrai défaut découvert, et aucune des trois relectures de code ne l'avait produit.

  **Ce que ce tir n'a PAS prouvé, et qu'il faut savoir avant de conclure :**
  - `upstream.odds.calls = 0` **et** `odds.misses = 0` : `ODDS_API_KEY` était absente, le proxy répond `[]` sans appel sortant. Le critère 3 n'est pas tenu, il est **contourné**. Les 1 884 hits venaient d'un cache déjà chaud avant la remise à zéro des compteurs (`/metrics/reset` ne vide pas les caches — c'est documenté, et ça se voit ici).
  - `upstream.ml.calls = 0` avec `mlCircuit` intact (0 échec) : aucun appel ML n'a été *tenté*. `fetchUpcomingGames` expirait, `.catch(() => [])` rendait une liste vide, donc aucun candidat à prédire. Les 2 exécutions de `best-bets` étaient quasi vides — le chiffre est bon, ce qu'il mesure ne l'est pas.
  - `caches.nhl` à 43 % de hits avec `dedup: 0` **n'est pas une anomalie** : `nhlApiClient` déduplique sous le cache, dans `fetchNHL`, donc ses rattachements ne sont pas comptés par ce compteur-là. `misses` y surestime les exécutions réelles ; la vérité est `upstream.nhl.calls`.
  - `eventLoop` mean 30,5 / p50 31,1 / p99 34,4 : distribution trop plate pour être du blocage réel (qui est irrégulier). Sous Windows, la résolution des timers (~15,6 ms) gonfle cette mesure. **Ne pas conclure à un event loop bloqué sur un tir Windows local.**

- **✅ Second tir, 2026-08-03, 50 VUs, 6 minutes complètes** (2 516 itérations, 0 interrompue). Taux d'erreur 13,54 % → **2,94 %**, p95 à 13-25 ms sur cinq endpoints sur six.

  **Le timeout tient :** les `max` plafonnent à 8 118 / 8 049 / 8 112 ms, soit `NHL_TIMEOUT_MS`. Avant : 305 000 ms.

  **Le critère 3 est PROUVÉ**, cette fois avec la vraie clé : `upstream.odds.calls = 1` sur 2 516 itérations. Le seuil était « ≤ 2 ». Coût du test : 1 crédit — ce qui est la démonstration même de ce que le cache achète.

  **L'API NHL est devenue injoignable pendant le run** : `upstream.nhl` à **5 appels, 5 erreurs**, toutes au plafond du timeout. Accident heureux : c'est une panne d'amont réelle, non simulée, et elle a révélé la ligne Y ci-dessus. Elle explique aussi la totalité des 2,94 % d'erreur restants et le p95 de 6,68 s sur `games?date`.

  **Le mock n'était toujours pas actif** — les 8 s de plafond le prouvent : avec `NHL_USE_MOCK=true`, `fetchGamesByDate` rend `MOCK_GAMES_FULL` en mémoire et n'atteint jamais un timeout. La variable est lue **à l'import du module**, donc un serveur déjà démarré ne la voit pas. D'où l'ajout d'une ligne `[Server] Réglages effectifs` au démarrage (`server.ts`) qui journalise `NHL_USE_MOCK`, `NHL_TIMEOUT_MS`, `ML_DISABLED`, la présence de `ODDS_API_KEY` et `API_RATE_LIMIT` : **une configuration qui ne s'applique pas en silence a déjà coûté deux runs**.

  **Suite :** un tir avec le mock réellement actif (vérifié dans les logs de démarrage) pour mesurer la mécanique interne sans dépendre de la joignabilité de l'API NHL. Et, séparément, comprendre pourquoi `api-web.nhle.com` ne répond pas depuis cette machine — suspect principal, la résolution IPv6, qui fait attendre Node jusqu'au timeout quand l'IPv6 est cassé sur le réseau local. C'est un problème de poste, pas de l'application, mais il fausse toute mesure tant qu'il dure.
- **Deux pièges documentés :** `apiLimiter` plafonne à 300 req/min/IP — sans `API_RATE_LIMIT` relevé, le test mesure le limiteur et rend un résultat faussement excellent ; et `/api/dev/metrics/reset` ne vide pas les caches, donc il ne prépare pas S3.
- **Trou trouvé et corrigé sans avoir eu besoin du run complet :** `nhlApiClient` n'avait aucune déduplication en vol. Banc `loadtest/stampede.ts` : 500 concurrents → 500 appels NHL. La déduplication a été posée dans `fetchNHL` plutôt que fonction par fonction — le point d'étranglement HTTP couvre les 19 fonctions d'un coup, y compris celles qu'on oublierait, et **aucune sémantique de cache n'est touchée** (les cas « ne pas mettre en cache » restent identiques, là où une migration vers `wrap` aurait dû les reproduire un à un dans un diff de 1 650 lignes). Banc rejoué : **500 concurrents → 1 appel**.

### S2 — Vague d'inscriptions/connexions
50 inscriptions puis 200 connexions en 30 s. **Le critère n'est pas la latence du login** mais celle des routes de **lecture concurrentes** : c'est elle qui révèle un blocage de l'event loop. Mesurer `eventLoop` sur `/api/dev/metrics`.

### S3 — Cache froid / redéploiement
Redémarrer, puis 300 requêtes concurrentes sur `/api/predict/best-bets`. **Critère : 1 seule exécution.** Sans la déduplication, chaque déploiement provoque une tempête. C'est le test le plus souvent oublié.

### S4 — Chat et WebSocket
500 sockets rejoignant le même salon en 60 s, puis 5 msg/s pendant 5 min avec 10 % de churn. Surveiller l'amplification `room_users` et le nombre de requêtes Neon par ouverture de salon (doit être ~1, pas ~100).

### S5 — Endurance / fuite mémoire (**le plus important pour le coût**)
100 VUs pendant 2-4 h en variant les paramètres pour créer des clés de cache distinctes. **Le RSS doit se stabiliser sur un plateau** ; une croissance linéaire prédit des redémarrages OOM.

### S6 — Soirée de matchs / règlement
2 000 tickets pending sur 10 matchs, matchs marqués finaux, règlement déclenché. **Critère : réglés en < 10 min.** Ce test **échouait par construction** avec l'ancien plafond de 200 par passe ; c'est désormais le budget temps qui décide, donc il devient un vrai test de débit — et `exhausted` dans le résumé dit sans ambiguïté si la file a été vidée.

### S7 — Budget des API externes (analytique)
Laisser tourner 24 h en préproduction avec un trafic réaliste, lire les compteurs par API externe, extrapoler à 30 jours, comparer aux quotas souscrits. Le seul moyen fiable de prévoir la facture.

---

# 6. Ce que je n'ai pas pu vérifier

1. **La configuration Railway réelle** : plan, RAM/vCPU par service, nombre de replicas. La différence entre 512 Mo et 8 Go change plusieurs seuils (notamment la ligne U et le nombre de workers uvicorn viable).
2. **Le plan Neon** : taille de compute, autosuspend activé ? — détermine la ligne 7 bis.
3. **Les plans The Odds API et RapidAPI** effectivement souscrits : les quotas exacts font passer certaines lignes de « critique » à « à surveiller ».
4. **Les métriques de production actuelles** s'il y a déjà du trafic. N'importe quel export Railway/Sentry de 7 jours remplacerait ces estimations par des mesures.
5. **Le taux d'usage réel de la fonctionnalité LLM** (requêtes/utilisateur/jour) — la seule inconnue restante côté coût IA, même si le plafond la rend sans conséquence sur la facture.
6. **La saisonnalité** : 5 000 simultanés en mars et 200 en juillet, ce n'est pas la même infrastructure. Un dimensionnement élastique peut diviser la facture annuelle par deux.

---

# 7. Résumé exécutif

**L'architecture n'est pas le problème.** Vite/Vercel + Express/Railway + Neon + un service ML séparé est cohérent, peu coûteux, et monte à 5 000 utilisateurs simultanés sans refonte.

**Le problème était que quelques endroits faisaient un travail proportionnel au nombre d'utilisateurs là où il devait être constant.** Le proxy Odds appelait l'upstream une fois par visiteur ; `best-bets` recalculait 30 prédictions ML par visiteur ; le leaderboard exécutait 21 requêtes par visiteur ; les avatars étaient transportés en base64 dans chaque payload ; le fan-out push ouvrait une requête et une socket par destinataire. **Toutes ces lignes sont fermées**, pour un coût d'infrastructure nul.

**Une seconde famille de problèmes concernait les bornes manquantes**, moins visibles parce qu'elles ne se manifestent qu'en cas de panne ou de pic : pas de disjoncteur devant le service ML, pas de plafond sur la dépense LLM, un plafond *trop bas* et fixe sur le règlement des paris, un journal de cotes écrivant sur un disque qui n'existe pas. Elles sont fermées aussi. Le fil commun : **borner ce qui peut croître, et rendre visible ce qui est borné** — d'où les compteurs de `/api/dev/metrics` et le champ `exhausted` du règlement.

**Le dernier verrou architectural — l'adaptateur Socket.io — est tombé le 2026-09-19** : `@socket.io/redis-adapter` derrière `REDIS_URL`, vérifié par le banc B12 qui le mesurait rouge. Il reste de l'**état en mémoire de process** — les caches, qui sont un simple gaspillage à N instances (N caches froids au lieu d'un), et le limiteur de débit, qui devient N× trop généreux. Aucun des deux ne scinde le produit en deux moitiés qui ne se parlent pas, ce qui était le vrai danger. *(L'ordonnancement des jobs, qui posait le même problème, est réglé depuis le 2026-07-29 : bail Postgres + état partagé en base, sans service supplémentaire.)* Étape identifiée, pas urgence.

**Le plus gros risque de dépense imprévue n'est pas l'hébergement** — Railway, Neon et Vercel resteront de l'ordre de quelques dizaines d'euros par mois à cette échelle. Ce sont les **APIs tierces facturées à l'appel** : elles sont désormais **toutes bornées**, et chacune l'est par un mécanisme qui agit sans qu'on ait à le déclencher — cache pour The Odds API, plafond dérivé du prix pour le LLM, réseau privé pour le service ML, échantillonnage par défaut pour Sentry. Les alertes de budget de `MONITORING.md` sont une seconde ligne, pas la première : une protection qui repose sur quelqu'un qui lit un email n'est pas une protection.

Sur le LLM en particulier, la protection n'est pas une surveillance mais une **identité comptable** : le nombre de requêtes qu'un abonné peut envoyer sur le compte de l'opérateur est calculé à partir de ce qu'il paie et du coût pire-cas d'une requête. La dépense IA totale est bornée par le revenu des abonnements, sans qu'aucune alerte n'ait à se déclencher — et un changement de tarif du fournisseur resserre le plafond automatiquement.

**En une phrase :** le tir de charge est fait (rapport supprimé, `git show 0916b52:RAPPORT_TESTS_CHARGE_2026-09-18.md`, 14 bancs, sept défauts trouvés et corrigés), et **tout le travail de code de la marche 500 → 5 000 est terminé** — adaptateur Socket.io compris depuis le 2026-09-19. Il reste deux lignes volontairement reportées au lancement officiel (Vercel Pro, Cloudflare), la pose des alertes de budget dans les consoles, et un compteur de débit à partager le jour de la deuxième instance.
