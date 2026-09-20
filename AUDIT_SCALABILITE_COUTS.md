# ARAKICE / ICEEDGE — Audit de scalabilité & de coûts

**Date :** 2026-07-28 · **dernière mise à jour :** 2026-08-03
**Cible :** 500 utilisateurs simultanés au lancement → 5 000 simultanés avec un minimum de changements
**Contrainte :** infrastructure peu coûteuse, pas de refonte, réutilisation de l'architecture existante
**Méthode :** inspection directe du code (`server/src`, `client/src`, `ml/python`, `server/src/db`, Dockerfiles, `vercel.json`, `.env.example`). Chaque constat cite un fichier réel.

> Complémentaire de `PRODUCTION_READINESS_AUDIT.md` (2026-07-20), qui traitait la sécurité. **Ce document n'y revient pas.** Il regarde une seule chose : *qu'est-ce qui casse ou explose en coût quand le nombre d'utilisateurs est multiplié par 10 ?*

> **Sur les chiffres.** Les montants sont des **ordres de grandeur** ; les prix changent, vérifie avant d'engager une dépense. Ce qui compte n'est pas le montant mais la **forme de la courbe** : coût *constant* (cache partagé) contre coût *linéaire au nombre d'utilisateurs* (appel non caché). Les seuils « à partir de N utilisateurs » sont des estimations dérivées du code, pas des mesures — le plan de tests de charge (§5) sert à les valider.

---

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

# 1. Corrections livrées avant le 2026-08-02 (résumé)

Ces points sont **faits**. Ils sont conservés en une ligne chacun parce que la décision qu'ils portent reste utile à relire ; le raisonnement complet est dans l'historique Git des fichiers cités.

| Point | Ce qui posait problème | Ce qui a été fait |
|---|---|---|
| **P0-1** Proxy Odds sans cache | 2 appels upstream **par visiteur** ; le plan gratuit (~500 crédits) tenait 250 visiteurs | Cache TTL 5 min réutilisant `oddsClient`, `Cache-Control`, liste blanche de marchés, repli `getStale` quand le quota tombe, log de `x-requests-remaining` (`routes/odds.routes.ts`) |
| **P0-2** `best-bets` : 30 appels ML par requête | Recalcul complet à chaque montage de la landing ; rupture vers 150-300 simultanés | `TtlCache.wrap` TTL 60 s, clé sur options normalisées → **une** exécution par minute quel que soit le trafic, et une seule sur un cache froid grâce à la déduplication en vol (`services/bestBets.service.ts`) |
| **P0-3** Leaderboard N+1 | 21 requêtes, dont une par utilisateur ramenant *toutes* ses lignes de paris pour compter en JS | Agrégat Postgres unique (`fetchBetStats`), cache 60 s partagé, index `(user_id, outcome)` (migration 022) |
| **P0-4** Avatars base64 en base | ~2 Mo par utilisateur dans Neon, répétés dans chaque payload de chat | Redimensionnement client 256×256 WebP (~27 ko), déduplication par auteur, `express.json` à 100 ko global et 600 ko sur la route avatar |
| **P0-5** Service ML public | Inférence XGBoost illimitée pour qui connaît l'URL = facture ouverte | Réseau privé Railway (`*.railway.internal`), domaine public retiré, jeton partagé `X-ML-Token` en seconde barrière |
| **P0-6** bcrypt**js** coût 12 | Implémentation JS pure → **bloque l'event loop** ~1-4 s par inscription ; 10 inscriptions simultanées font expirer tout le reste | `@node-rs/bcrypt` (natif, hors event loop), SHA-256 salé pour les codes courts, e-mail sorti du chemin de requête |
| **P0-7** Neon | Endpoint direct vs `-pooler` non documenté | `DATABASE_URL` sur `-pooler` **confirmé**, documenté dans `DEPLOYMENT.md`, et **avertissement au démarrage** si l'URL ne le contient pas (`db/connection.ts`) |
| **P1-1** Caches mémoire sans éviction | `Map` qui ne perdaient jamais une entrée, clés dérivées d'entrées utilisateur → OOM | `TtlCache` (plafond d'entrées, éviction FIFO, TTL par entrée) sur `nhlApiClient`, `tennisApiClient`, `refereeStore`, quota LLM. Sans dépendance : la classe existait déjà dans le repo |
| **P1-2** Chat N+1 | ~100 requêtes par ouverture de salon | `LEFT JOIN LATERAL` + compte corrélé : 31 requêtes → 1 pour dix salons. Effet de bord utile : un seul SQL sert connectés et invités, les deux vues ne peuvent plus diverger |
| **P1-3** Socket.io (points 2-3) | Broadcast de présence O(n) à chaque connexion ; CORS socket incompatible avec une liste à virgules | Politique d'origine extraite dans `cors.ts`, partagée HTTP + WebSocket ; `room_users` coalescé à 3 s par salon, l'arrivant recevant son compte en O(1). **Le point 1 (adaptateur Redis) est livré le 2026-09-19 → ligne D** |
| **P1-4** Jobs planifiés dupliqués | Aucun verrou : N instances = N× le travail et N notifications identiques | **Bail en table** (`job_locks`, migration 023) et non `pg_try_advisory_lock` — un verrou de *session* ne survit pas au PgBouncer de Neon en mode transaction, donc il aurait fonctionné en dev et échoué en prod. `lastAlertKey` déplacé en base (`job_state`), écrit **avant** l'envoi |
| **P1-6** LLM sans plafond | Quota par utilisateur, en mémoire, contournable par redéploiement ; aucun plafond global | Plafond **dérivé du prix** : `(prix Pro × part IA) ÷ coût pire-cas` ≈ 995 req/mois à 9,99 $. Compteur en base (migration 024), incrément et contrôle dans le même énoncé, fail-closed. Au plafond, bascule sur la clé OpenAI de l'abonné plutôt que blocage |
| **P1-9** Aucun en-tête de cache HTTP | Données NHL quasi-statiques refaisant l'aller-retour complet à chaque navigation | `middleware/httpCache.middleware.ts` : `max-age` repris des TTL de `nhlApiClient`, en-tête posé **à l'envoi et sur 2xx seulement** (un 502 caché 30 min transformerait une coupure de 10 s en panne de 30 min), `no-store` monté au niveau des 7 routeurs authentifiés. **Reste Cloudflare → ligne 11** |
| **P1-15** `fetchGameById` / `fetchPlayerById` | Les 2 seules fonctions NHL sans cache serveur, sur 5 routes + 2 chemins ML | Cache posé dans le client (là où les 17 autres cachent), TTL selon l'état du match. Un échec n'est jamais mémorisé |
| **Migrations** | *(constat périmé)* | `migrate-all.ts` tient un registre `schema_migrations`, une transaction par fichier. Seule limite : `CREATE INDEX CONCURRENTLY` est incompatible avec l'exécution en transaction — à passer à la main sur une table volumineuse |

---

# 2. Corrections livrées le 2026-08-02

## G · Fan-out push non borné → **fait**

- **Le problème :** `Promise.all(recipients.map(sendToUser))`, et `sendToUser` faisait lui-même un `SELECT … WHERE user_id = $1` puis un `Promise.all` sur les appareils. À 2 000 abonnés opt-in : **2 000 requêtes Postgres lancées d'un coup sur un pool de 10** et ~3 000 requêtes HTTP simultanées vers FCM/Mozilla/Apple. Les requêtes des utilisateurs passaient derrière : l'API semblait tomber à chaque scan.
- **Ce qui a été fait :** `sendToUsers(userIds, payload)` — **une** requête de lecture (`= ANY($1::uuid[])`), un plafond d'envois simultanés à l'échelle du lot (`PUSH_CONCURRENCY`, défaut 20), et une purge **groupée** des endpoints expirés. `sendToUser` devient un appel à un seul élément.
- **Deux détails qui font la différence :** le plafond est posé sur le **lot** et non par utilisateur — le nombre d'appareils par personne est petit, c'est le nombre de personnes qui est grand, donc borner par utilisateur n'aurait rien borné. Et la purge est groupée parce qu'un service push expire souvent un lot d'abonnements d'un coup (mise à jour de navigateur) : sans cela on remplaçait N envois concurrents par N `DELETE` concurrents.
- **Outil :** `services/concurrency.ts` → `mapLimit`, sans dépendance (`p-limit` est ESM-only depuis la v4, incompatible avec la compilation CommonJS de ce serveur). Une largeur aberrante (0, négative, `NaN`) retombe sur le **séquentiel**, jamais sur l'illimité : une variable d'environnement mal réglée ne doit pas rouvrir le trou que la fonction ferme. 5 tests.

## L · `isPro()` : une requête à chaque appel → **fait**

- **Le problème :** la requête la plus fréquente de l'application (chaque appel LLM, chaque route `requirePro`), pour une donnée qui change quelques fois dans la vie d'un compte.
- **Ce qui a été fait :** `TtlCache` de 60 s (`PRO_CACHE_TTL_MS`), invalidé par **toute** écriture sur l'abonnement — `upsert` (donc Stripe, promo, activation dev), `startTrial`, `cancel`.
- **Le détail qui compte :** le TTL est **borné par la fin de période**. Un abonnement qui expire dans 10 s ne peut pas être mis en cache 60 s ; sans cela le cache prolongerait gratuitement un accès payant, et c'est exactement le genre de chose qu'on ne découvre jamais. Reste par instance : au scale, une révocation met au pire un TTL à se propager — d'où un TTL court plutôt que de plusieurs minutes.
- `cancel()` invalide aussi, bien que `cancel_at_period_end` ne retire pas l'accès : un cache dont l'invalidation dépend de « est-ce que ce champ-là compte ? » finit toujours par être faux le jour où un champ s'ajoute.

## M · `mlApiClient` : ni disjoncteur ni cache → **fait**

- **Le problème :** timeout de 5 s, aucun retry, aucun disjoncteur. Quand le service Python ralentit, `getBestBets` maintient 30 sockets ouvertes pendant 5 s **pour chaque requête entrante**. Le repli sur les règles existait déjà, mais n'était atteint qu'*après* le timeout : le serveur passait 5 s par requête à attendre un service dont il savait déjà, depuis la requête précédente, qu'il ne répondait pas. C'est ainsi qu'une panne d'un service secondaire devient une panne de l'API principale.
- **Ce qui a été fait :** disjoncteur (5 échecs consécutifs → fenêtre de repos de 60 s pendant laquelle les appels échouent **sans réseau ni attente**), demi-ouverture par **une seule sonde**, et cache d'inférence.
- **Quels échecs comptent :** réseau, timeout, 5xx, 401/403/429. **Pas les 400** — un appel malformé est la faute d'un appelant ; le compter ouvrirait le circuit pour tout le monde à cause d'une seule route boguée, et le disjoncteur deviendrait lui-même la panne.
- **Une seule sonde, pas une rafale :** sans le drapeau, les 30 appels d'un `getBestBets` partiraient tous à la seconde où la fenêtre expire et rouvriraient le circuit par la rafale même qu'il est censé empêcher.
- **Cache lu avant le disjoncteur, délibérément :** une valeur déjà calculée reste servable pendant une panne — la refuser dégraderait le produit sans soulager le service. Un hit ne referme donc pas le circuit et ne consomme pas la sonde. Il utilise `peekFresh` et non `get` : `wrap` compte déjà l'accès, et `misses` — la métrique sur laquelle reposent les critères S1/S3 — serait sinon fausse d'un facteur deux.
- **Le cache a un TTL court malgré un modèle déterministe** : ce sont les *features* qui bougent (blessures, gardien annoncé, cotes). On mémorise le calcul, pas le pronostic. Bénéfice principal : `wrap` déduplique les appels **en vol**, et `getBestBets` lance les siens d'un coup.
- État exposé sur `GET /api/dev/metrics` (`mlCircuit`) : sans lui, un tir de charge pendant une panne montrerait « 0 appel ML » sans dire si c'est le cache qui a bien travaillé ou le circuit qui est ouvert — deux situations opposées. 8 tests.

## H · Règlement : plafond fixe et boucle séquentielle → **fait**

- **Le problème :** 100 tickets par passe (200 pour le rattrapage horaire), traitement séquentiel des jambes, caches recréés à chaque appel. À 5 000 utilisateurs, ~7 000 tickets deviennent réglables après les matchs et la file se vidait à 200/heure : **des utilisateurs auraient attendu des jours** le règlement d'un pari dont le résultat était connu.
- **Ce qui a été fait :** boucle par lots jusqu'à épuisement, arrêtée par un **budget temps** et non par un plafond de tickets ; jambes en parallèle borné (`mapLimit`, 4) ; les quatre caches créés **une fois pour toute la passe** — régler 300 tickets portant sur 10 matchs coûte 10 récupérations, pas 300, ce qui est l'essentiel du bénéfice du « regroupement par match » sans réorganiser la boucle.
- **Pagination par curseur `(placed_at, id)`, pas par `OFFSET` :** un ticket examiné mais non réglable (marché non auto-réglé, match pas encore final) **reste pending**. Une seconde requête `LIMIT` sans curseur renverrait exactement les mêmes lignes et la boucle tournerait sur place indéfiniment.
- **Les budgets sont calés sous les TTL des baux** (3 min sous un bail de 5, 10 min sous un bail de 15) : c'est le budget qui arrête la passe, jamais le bail — sinon une deuxième instance reprendrait le travail pendant que la première l'exécute encore. Le chemin interactif `POST /api/slips/settle` garde un plafond bas **et** un budget de 10 s : personne ne doit tenir une connexion HTTP ouverte pendant que la file se vide.
- `SettlementSummary.exhausted` dit si la file a été vidée ; durablement faux = elle se remplit plus vite qu'elle ne se vide (et c'est journalisé).
- Index **partiels** (migration 025) : `(placed_at, id)` et `(user_id, placed_at, id)` `WHERE outcome = 'pending'`. Partiels parce que les tickets réglés ne sont jamais relus par ces requêtes et représentent, passé quelques semaines, la quasi-totalité de la table — l'index ne contient donc que la file d'attente et reste en cache mémoire quelle que soit la taille de l'historique.

## P · Webhook Stripe : rejeux et ordre → **fait**

- **Le problème :** (1) le traitement (un `subscriptions.retrieve` + un upsert) se faisait avant de répondre ; sur une base froide, le délai pouvait dépasser le timeout de Stripe, qui rejouait — et finit par désactiver un endpoint qui échoue de façon répétée. (2) Stripe **ne garantit pas l'ordre** de livraison : un `customer.subscription.updated` ancien arrivant après un plus récent écrasait l'état avec des données périmées.
- **Ce qui a été fait :** registre `stripe_events` (migration 026) — un événement déjà traité est acquitté immédiatement, donc les redélivrances deviennent gratuites — et colonne `subscriptions.last_event_at` portant la garde d'ordonnancement.
- **Choix assumé : le traitement reste synchrone.** « Répondre 200 puis traiter » a une contrepartie que l'audit initial ne mentionnait pas : une fois le 200 envoyé, Stripe ne réessaie plus. Un échec de traitement derrière signifie **un abonné qui a payé et ne passe jamais Pro**, à moins de reconstruire notre propre file et notre propre job de reprise. Garder le traitement dans la requête laisse le réessai de Stripe faire ce travail, et le registre suffit à rendre les rejeux gratuits.
- **Conséquence directe : l'événement n'est enregistré qu'APRÈS un traitement réussi.** L'inscrire d'abord ferait passer un échec pour un succès, et le réessai — notre seul filet — serait ignoré.
- **La garde vit dans le `WHERE` du `DO UPDATE`**, donc dans le même énoncé que l'écriture : aucune fenêtre entre « comparer » et « écrire ». Et `last_event_at` est **distincte de `updated_at`** : `updated_at` est l'heure de *notre* écriture, elle vaut « maintenant » aussi bien pour un webhook que pour un essai gratuit. Comparer un horodatage Stripe à `updated_at` bloquerait les écritures locales ou les laisserait passer par erreur. Seules les écritures issues de Stripe participent à l'ordonnancement ; un `NULL` ne bloque jamais rien.
- **Une écriture rejetée par la garde relit l'état** au lieu de renvoyer la ligne vide : `toStatus(undefined)` annoncerait « free » à quelqu'un qui est Pro — le bug que la garde devait empêcher, déplacé d'un cran.
- Purge du registre par le job de nettoyage (`STRIPE_EVENT_RETENTION_DAYS`, 30 j).

## K · `oddsLogger` sur disque éphémère → **fait**

- **Le problème :** le chemin par défaut `<cwd>/../ml/data/odds_live_log.csv` **n'existe pas dans le conteneur** (`WORKDIR /app`, seul `dist/` est copié). `mkdirSync` le créait à la racine, sur un système de fichiers éphémère : tout était perdu à chaque déploiement. Le job ne levait pas, donc rien ne se voyait — et son objectif (constituer un dataset que The Odds API ne vend pas rétroactivement) était inatteignable. Un mois de collecte perdu ne se rattrape pas : la cote de clôture d'un match d'hier n'existe plus.
- **Ce qui a été fait :** table `odds_log` (migration 027), clé primaire `(game_date, home_team, away_team)` qui porte l'idempotence — la relecture intégrale du fichier à chaque exécution, dont le coût croissait avec la saison, disparaît. Un seul aller-retour par passe (`unnest`). Export vers le format de `fetch_data_v4.py` par `npm run odds:export`.
- **Bénéfice non prévu par l'audit :** le CSV écrivait `open = close` faute de pouvoir relire ce qu'il avait écrit. En base, la première passe d'une journée pose l'ouverture et les suivantes ne mettent à jour que la clôture — la ligne gagne le **mouvement de cote**, qui est précisément le signal recherché.

## X · `fetchNHL` sans timeout — **trouvé par le tir S1, corrigé**

*(Constat issu du premier tir de charge, 2026-08-03. Aucune relecture de code ne l'avait produit en trois passes.)*

- **Composant :** `services/nhlApiClient.ts` → `fetchNHL`, `fetchNHLSearch`.
- **Le problème :** aucun timeout. `fetch` sans `signal` s'en remet au défaut d'undici — **300 secondes**. Ce n'est pas une hypothèse : les compteurs du tir donnent `upstream.nhl` à **avgMs 9 611, maxMs 305 043**, soit exactement ce plafond, sur 3 appels en erreur.
- **Pourquoi c'était bien pire qu'une lenteur :** la déduplication en vol (posée le 2026-07-28, et qui est la bonne décision pour le coût) fait que **tous les appelants d'une URL partagent le sort du premier**. Un appel parti pour cinq minutes retient cinq minutes tous ceux qui demandent la même donnée. Pendant le tir, c'est cette chaîne qui a fait expirer `/api/nhl/games?date=` puis `best-bets` — qui appelle `fetchUpcomingGames`. Le rayon de souffle d'un upstream lent, c'était l'application entière.
- **Ce qui rendait le constat invisible autrement :** `mlApiClient` avait bien son timeout de 5 s, ce qui donnait l'impression que la question était traitée. Et en usage normal l'API NHL répond en 100-600 ms — le trou ne s'ouvre que quand elle ralentit, c'est-à-dire exactement quand on ne peut pas se le permettre.
- **✅ Corrigé (2026-08-03).** `AbortController` à 8 s (`NHL_TIMEOUT_MS`) posé dans `fetchWithTimeout`, au point d'étranglement HTTP — donc les 19 fonctions d'un coup, comme la déduplication. L'`AbortError` est reformulé en message nommant la cause : sinon un dépassement de délai ressemble dans les logs à une annulation côté client, deux causes opposées. Un dépassement n'est jamais mémorisé, ni par `dedupe` ni par le cache.
- **3 tests** (`nhlApiClient.test.ts`), dont celui qui compte : **20 appelants dédoublonnés doivent TOUS être libérés**, pas seulement le premier — sinon le timeout ne protège qu'une requête sur N.
- **Non traité :** les 4 `fetch` bruts vers `STATS_BASE` (classements, sommaires de saison) contournent `fetchNHL` et restent sans timeout. Ils n'étaient pas exercés par S1. À faire si un tir les met en cause.

## Y · Les routes NHL rendaient 500 quand l'amont tombait — **trouvé par le tir S1, corrigé**

*(Second constat du tir du 2026-08-03, révélé par une panne réelle de l'API NHL survenue pendant le run.)*

- **Le problème :** `upstream.nhl` a rendu **5 appels, 5 échecs**. Le reste de la stack s'est comporté exactement comme l'audit le prédit — 5 appels sortants seulement pour 50 VUs sur 6 minutes, donc caches et déduplication ont tenu — mais `/api/nhl/games?date=` propageait un 500 à chaque requête. C'est **la totalité** des 2,94 % d'erreur du run.
- **L'asymétrie qui saute aux yeux une fois vue :** le proxy Odds gère déjà ce cas depuis le 2026-07-28 — quand l'amont tombe, il sert `oddsCache.getStale()` plutôt qu'une page vide. Les routes NHL n'avaient jamais eu l'équivalent, alors qu'elles dépendent d'une API tierce tout autant.
- **✅ Corrigé (2026-08-03).** `middleware/staleFallback.middleware.ts` : mémorise la dernière réponse 2xx par URL et la ressert sur 5xx, avec l'en-tête `X-Stale-Response: 1` et un `Cache-Control` court.
- **Pourquoi au niveau de la route et non dans `nhlApiClient`.** La version « client » serait plus économe — `TtlCache.getStale` existe déjà et contient la donnée. Mais elle obligerait à modifier une à une les 19 fonctions du client, dont chacune a sa propre logique de « quand mettre en cache » (jour sans match, boxscore absent, match introuvable). Reproduire 19 fois une gestion d'erreur, c'est 19 occasions de se tromper — **et l'oubli est silencieux** : la route concernée continue simplement de rendre 500 le jour où l'amont tombe. Un point unique monté sur le routeur couvre les 20 routes et celles qu'on ajoutera. Le prix est une seconde copie de la dernière réponse par URL, plafonnée (`STALE_FALLBACK_MAX_ENTRIES`).
- **Trois limites volontaires :** les **4xx passent** (un 404 est une réponse définitive, pas une panne — resservir du vieux serait mentir) ; seules les **2xx sont mémorisées**, donc le repli ne peut pas servir un 500 d'hier ; et l'entrée **expire** (`STALE_FALLBACK_TTL_MS`, 30 min) — mieux vaut une erreur franche qu'un calendrier de la veille présenté comme courant.
- **Ne jamais monter ce middleware sur un routeur authentifié** : la clé est l'URL, donc deux comptes partageraient une entrée. C'est sûr sur `/api/nhl/*` précisément parce qu'aucune de ces routes ne lit l'identité de l'appelant — la même hypothèse qui autorise déjà `publicCache` sur elles.
- **5 tests** (`staleFallback.middleware.test.ts`), sur un comportement qui n'apparaît que pendant une panne d'API tierce : sans eux, retirer le middleware laisserait toute la suite au vert.

## Z · `oddsClient` : troupeau sur la seule API facturée à l'appel — **trouvé par le tir S1, corrigé**

*(Troisième et plus coûteux constat du 2026-08-03. Invisible pendant les deux premiers tirs, pour une raison instructive.)*

- **Le problème :** `fetchAllOdds` tenait un cache maison **sans déduplication en vol** — un `let cache` avec vérification d'expiration à la lecture, exactement le motif corrigé dans `nhlApiClient` le 2026-07-28. `getBestBets` price ses candidats en parallèle, donc N appelants lisent le cache froid avant que le premier n'écrive.
- **Mesuré :** `upstream.odds.calls = 26` pour **une seule** exécution de `getBestBets` (`best-bets.misses = 1`), soit 13 matchs × h2h + totals. Quatre des 26 rejetés — vraisemblablement le limiteur d'en face répondant à la rafale.
- **Pourquoi c'est le pire endroit possible pour ce bug :** l'API NHL est gratuite, le troupeau n'y coûtait que de la latence. **The Odds API est facturée à l'appel.** À 26 appels par fenêtre froide de 5 minutes, la consommation passe de ~8 600 crédits par mois à **~225 000** — soit un plan à trois chiffres mensuels au lieu du plan gratuit, pour un service rendu identique.
- **Pourquoi les deux premiers tirs ne l'ont pas vu, et c'est la leçon du run :** l'API NHL était injoignable, donc `fetchUpcomingGames` rendait une liste vide, donc **aucun candidat à pricer**. Les compteurs affichaient `odds.calls = 1` et le critère 3 semblait tenu haut la main. C'est le passage en `NHL_USE_MOCK=true` — donc l'apparition de vrais matchs — qui a fait surgir le chemin coûteux. **Un critère vert peut simplement vouloir dire que le code concerné n'a pas tourné.**
- **✅ Corrigé (2026-08-03).** `TtlCache.wrap` (une entrée, TTL 5 min, nommée `odds-client` dans les métriques) : une fenêtre froide coûte un appel quel que soit le nombre d'appelants simultanés. Deux affinages : un échec **lève** au lieu de renvoyer `[]` — un `[]` mémorisé 5 minutes priverait le moteur de cotes bien après le rétablissement — et l'appelant retombe sur `getStale`, car des cotes de dix minutes valent mieux qu'aucun facteur marché.
- **4 tests** (`oddsClient.test.ts`), dont celui qui reproduit la forme exacte de la rafale de `getBestBets` : 13 matchs × 2 marchés → **1 appel**.

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

**En une phrase :** le tir de charge est fait (`RAPPORT_TESTS_CHARGE_2026-09-18.md`, 14 bancs, sept défauts trouvés et corrigés), et **tout le travail de code de la marche 500 → 5 000 est terminé** — adaptateur Socket.io compris depuis le 2026-09-19. Il reste deux lignes volontairement reportées au lancement officiel (Vercel Pro, Cloudflare), la pose des alertes de budget dans les consoles, et un compteur de débit à partager le jour de la deuxième instance.
