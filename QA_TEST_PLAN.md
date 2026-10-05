# QA — ce qui reste à jouer (ArakIce / ICEEDGE)

> Tout ce qui pouvait tourner sans le monde réel est passé (campagnes statiques de juillet,
> I1/I2 du 2026-08-31, QA dynamique du 2026-09-26, F1/F2/F6 et C1 en production le
> 2026-10-05, I6 sur l'API NHL réelle le 2026-10-05, C4 le 2026-10-06). P1, P2 et P5 sont clos
> sans tir contre la production (décision du 2026-10-06, § Charge prod). Le détail de ces campagnes et les runbooks F1/F2/I1/I2 ont été retirés le
> 2026-10-05 : `git show 0916b52:QA_TEST_PLAN.md`. La liste des tâches est dans
> **`STATUS.md` §3.7**.

Règles inchangées : **pas de staging** — on teste en production avec des comptes jetables,
Pro accordé par code promo, jamais par un vrai paiement ; tester l'authentification sur le
vrai domaine, pas sur un aperçu `*.vercel.app`.

## Contexte technique (ce qui conditionne les tests)

| Couche | Techno | Hébergement | Points sensibles |
|---|---|---|---|
| Frontend | React 18 + Vite + Tailwind + Radix UI, React Router 7, socket.io-client, Sentry, i18n, PWA/web-push | Vercel — `arakice.com` | SPA, appels multi-API (`VITE_*_URL`), thèmes, partage d'images (`html-to-image`) |
| API | Node/Express (TS), JWT + refresh cookie httpOnly, Google OAuth, Stripe, Zod, Helmet, CORS, rate-limit (+ store Redis), socket.io, pino, Sentry | Railway (Docker) | Auth, gating Pro, cookie `SameSite=None` cross-site, webhooks Stripe |
| Service ML | Python FastAPI + uvicorn (`/predict/game`, `/predict/player`, `/predict/team`, `/health`) | Railway (Docker) | Dépendance modèle (`inference_state.json`, `elo_ratings.json`), latence, cold start |
| Base de données | PostgreSQL (`pg`) | Neon | Migrations, chiffrement des clés OpenAI, intégrité des slips |
| Données externes | NHL API, MoneyPuck, The Odds API, référés/scratches (JSON manuel) | — | Indisponibilité/quotas des tiers, données périmées |

**Fonctionnalités clés à couvrir :** inscription/connexion (email + Google), prédictions NHL, Bet Builder / paris (slips), Best Bets / value bet scan, page Charts, abonnement Pro (Stripe + codes promo), chat/LLM, notifications push, pages de partage, pages SEO statiques.

**Légende Priorité :** Critique = bloque la prod · Haute = à traiter avant lancement large · Moyenne = à planifier tôt post-lancement.
**Légende Statut :** À faire · Réussi · Échoué.

---

## Tests restants

| # | Nom du test | Résultat attendu | Priorité | Statut | Notes |
|---|---|---|---|---|---|
| I4 | Google OAuth de bout en bout (Front → API → callback Google) | Le flux `GOOGLE_REDIRECT_URI` aboutit, crée/relie le compte, émet JWT + cookie refresh, et redirige vers `AuthCallback` côté front. | Haute | **Réussi** (2026-10-06) | Sur arakice.com, compte existant (branche « relier ») ; la création d'un nouveau compte n'a pas été rejouée. Détail § I4. |
| I6 | Pipeline données externes → features → prédiction | Les données NHL/MoneyPuck/Odds ingérées sont correctement transformées en features envoyées au ML ; une donnée manquante n'invalide pas tout le lot. | Haute | **Réussi** (2026-10-05) | 34/34 sur 9 vrais matchs — voir § I6 ci-dessous. Cotes non couvertes (The Odds API injoignable depuis le shell). |
| P1 | Charge sur l'endpoint de prédiction ML | Sous charge nominale (ex. 50 req/s pendant 5 min) : p95 sous seuil défini (ex. < 800 ms), 0 erreur 5xx, mémoire stable côté FastAPI. | Haute | **Clos — hors prod** (2026-10-06) | Pas de tir contre la vraie prod (décision du 2026-10-06). Référence : bancs du 2026-09-18/19 (`loadtest/bench-results*.json`, rapport retiré le 2026-10-05 : `git show 0916b52:RAPPORT_TESTS_CHARGE_2026-09-18.md`) + sonde légère en prod, 82/82 OK. |
| P2 | Cache et quotas des données externes (Odds / NHL / MoneyPuck) | Les résultats sont servis depuis le cache (TTL respecté) ; le trafic utilisateur ne provoque pas de dépassement de quota The Odds API. | Haute | **Clos — hors prod** (2026-10-06) | Bancs B2/B3/B8 du 2026-09-18/19 (cache, déduplication, clé de cache). En prod : `Cache-Control` présent sur les 6 endpoints publics. À froid, 9 matchs = 480 appels NHL (I6). |
| P4 | Performance de chargement front sur mobile (Lighthouse) | Score perf mobile acceptable (ex. LCP < 2,5 s, bundle maîtrisé) sur la landing et la page prédictions ; pas de blocage sur les gros graphiques Recharts. | Haute | **Échoué** (2026-10-06) | Prod : 58 (LCP 4,2 s, CLS 0,368). Deux correctifs en attente de déploiement — § P4. |
| P5 | Pool de connexions Postgres sous charge | Sous charge concurrente, le pool `pg` ne s'épuise pas (pas d'erreurs « too many connections » côté Neon) ; requêtes lentes identifiées. | Haute | **Clos — hors prod** (2026-10-06) | Joué sur la stack locale le 2026-09-26 (QA dynamique) et dans les bancs B4/B6 ; pas de tir contre Neon. Vérifier quand même que `DATABASE_URL` en prod pointe sur l'endpoint `-pooler`. |
| C4 | Pages SEO statiques (`public/`) sur crawlers et réseaux sociaux | Les landing pages arakice.com se rendent avec titres/meta/OpenGraph corrects, sont indexables et affichent un aperçu propre au partage. | Haute | **Réussi** (2026-10-06) | 261 URL, 0 erreur bloquante ; soft 404 corrigé et vérifié en prod. Titres trop longs sur les pages de match — § C4. |
| C2 | Cross-navigateur desktop (Chrome, Firefox, Safari, Edge) | Rendu et interactions Radix/Recharts identiques ; aucune erreur console bloquante ; graphiques Charts corrects. | Moyenne | À faire (Chromium ✔) | 2026-10-06 : Chromium desktop OK sur 9 routes, Charts rendus (4 graphiques). Reste Firefox, Safari, Edge et le partage d'image. |
| C3 | Notifications push web (PWA / web-push) | Abonnement, réception et clic sur notification fonctionnent là où supporté ; dégradation propre là où non supporté (iOS restrictions). | Moyenne | À faire | Tester ajout à l'écran d'accueil + permission refusée. |

## I6 — exécution du 2026-10-05 (API NHL réelle, ML local)

`loadtest/qa-dynamic/i6.ts` : vrais matchs de saison régulière (5 terminés le 04/10, 4 à venir
le 05/10) → `buildGameFeatures` → `getGameMlBundle` contre `ml_service.py` local (modèles du dépôt).
Base forcée injoignable, clé Odds vide : rien n'est écrit, aucun quota consommé.

| Phase | Résultat |
|---|---|
| A — nominal, 9 matchs | 18/18 : aucun NaN, PP/PK réels lus, repos et b2b justes (CGY et SEA en b2b le 04/10), 101 marchés pricés par match, 0 invalide |
| B — `api.nhle.com/stats/rest` coupé dès le départ (`QA_FAIL_STATS=1`, 4 matchs) | 8/8 : PP/PK **absents** (pas 20/80), tirs/mises au jeu neutres, prédiction servie quand même |
| C — un identifiant invalide au milieu du lot | ✔ 404 sur lui seul, les deux autres servis |
| Base injoignable (saisies manuelles : gardiens, absents, arbitres, blessures) | repli neutre journalisé, aucune exception |

Moneyline domicile du 05/10 (stats coupées) : TBL 68 %, BOS 48 %, PIT 66 %, DAL 68 %.

**À retenir :**
- **P2** : à froid, 9 matchs = **480 appels** à `api-web.nhle.com` (~53 par match) + 2 à
  `stats/rest`. Le cache absorbe la suite, mais un redémarrage de l'API en pleine soirée repart de là.
- Début de saison : PP 0,0 % (PHI, TBL, OTT, BOS après 1–3 matchs) est servi tel quel — c'est voulu
  (« bas » ≠ « inconnu »), mais l'échantillon est minuscule ; à surveiller dans les prédictions d'octobre.
- Le service ML éteint fait échouer `getGameMlBundle` (« fetch failed » puis disjoncteur ouvert) :
  le repli éventuel est à la charge de la route, pas du pipeline.

Rejouer (shell Linux) : lancer `uvicorn ml_service:app --app-dir python --port 8000` dans `ml/`
avec `ML_API_TOKEN=qa-i6-token MODELS_DIR=$PWD/models`, puis dans `server/` :
`npx tsx ../loadtest/qa-dynamic/i6.ts [AAAA-MM-JJ ...]` (et `QA_FAIL_STATS=1` pour la phase B).

## I4 — exécution du 2026-10-06 (arakice.com, navigateur intégré)

Connexion Google faite par l'utilisatrice → `/auth/callback` (200) → `/profile` connecté.
- JWT d'accès : `sub`, `email`, `role`, durée de vie de 15 min, rangé dans `localStorage` (`ice_access`).
- Cookie de refresh absent de `document.cookie` (httpOnly ✔).
- `POST /api/auth/refresh` avec cookie : 200 avec un `access_token` et **pas** de `refresh_token`
  dans le corps (web ✔), rotation acceptée deux fois de suite ; session intacte après rechargement.
- Pas rejoué : la création d'un compte neuf (seule la liaison d'un compte existant a été vue)
  et la déconnexion.

**Corrigé (non déployé)** : au démarrage, le client ne tentait un refresh que s'il trouvait un
jeton d'accès. Sans `ice_access` (stockage vidé, ou purge Safari/ITP au bout de 7 jours sans
visite), l'utilisateur était renvoyé vers `/login` alors que son cookie de refresh (7 à 30 jours)
était encore valide : vu en prod en retirant `ice_access`.
→ L'API pose maintenant un témoin `ice_session_hint=1` (lisible, `Domain=arakice.com`, même durée
que le refresh, effacé avec lui). `AuthContext` relance `refreshSession()` en silence s'il voit le
témoin sans jeton ; un visiteur anonyme ne déclenche aucune requête.
Tests : `auth.sessionHint.test.ts` (5), suite serveur 1 334/1 334, typecheck et build client OK.
**Pour l'activer : `SESSION_HINT_DOMAIN=arakice.com` dans les variables Railway de l'API.**
Pour le vérifier après le déploiement : se connecter, supprimer `ice_access` dans DevTools,
recharger ; la session doit revenir.

## C4 — exécution du 2026-10-06 (arakice.com)

155 URL de `sitemap.xml` + 106 de `sitemap-games.xml` : toutes en 200, une seule `<h1>`,
canonical = URL, OG/Twitter complets, image OG 1200×630 (98 Kio), JSON-LD valide
(Organization, WebSite, FAQPage, BreadcrumbList, CollectionPage), hreflang en/fr-ca/x-default
sur les pages de match, `lang` cohérent. `robots.txt` déclare les deux sitemaps.

- **Corrigé** : une URL inconnue était servie en 200 avec `index, follow` et le titre de
  l'accueil (soft 404, réécriture Vercel). `NotFoundPage` pose maintenant `noindex, follow` et le
  titre `404 | ArakIce` : vérifié en prod après le commit `594f098`.
- **Titres trop longs** (> 65 caractères, tronqués par Google) : les 138 `/matchup/*`
  (70–85 c) et les pages `/match` FR (jusqu'à 96 c). À raccourcir dans `seo-gen` / `gameday-gen`.
- **Texte faux sur 169 des 174 pages `/matchup/*`** : « The only road win by either club was… »
  et « Where the game is played has mattered more… » s'affichaient pour toutes les paires,
  même quand l'équipe à domicile n'avait gagné que 7 rencontres sur 15. Corrigé dans `seo-gen.mjs`
  (`roadWinCount === 1`, part de victoires à domicile ≥ 65 %). **Il faut régénérer : `npm run seo:gen`.**
- 36 pages `/matchup/*` ne sont plus dans le sitemap (paires de la fenêtre du 25/09 sorties de
  l'horizon de 3 semaines). Gardées volontairement : 34 pages de match y renvoient, et chaque paire
  rejoue dans la saison, donc `seo:gen` les réinscrira.
- Descriptions de 176 à 191 caractères sur 4 landings (coupées vers 160).
- Les routes SPA du sitemap (`/schedule`, `/stats`, `/bet`, `/league`…) n'ont qu'environ 200
  caractères de HTML brut : correct pour Google (rendu JS), mais vide pour les robots qui ne
  l'exécutent pas.
- ✔ **Pages de match figées au 04/10** : le workflow `seo-gameday` du 05/10 a échoué, aucun runner
  GitHub n'ayant été attribué en 15 min (incident GitHub, pas le code). Relancé avec succès le 05/10 à 23:36 UTC :
  `gh workflow run seo-gameday.yml -R ireinahedad/IceEdge -f days_back=3` ;
  le cron (11:00 UTC) part en pratique entre 15:00 et 19:30 UTC.
- Le job « Secret scan — gitleaks » échouait sur chaque PR à cause de deux détections dans
  l'historique : une vraie clé Resend (2026-07-05, **révoquée et remplacée le 2026-10-06**) et un
  faux positif (badge du README NestJS). Elles sont déclarées dans `.gitleaksignore` ; gitleaks
  ne trouve plus rien sur tout l'historique.
- Cloudflare injecte `static.cloudflareinsights.com/beacon.min.js`, que la CSP (`script-src 'self'`)
  bloque sur chaque page : une erreur console partout (Best Practices 92). Couper Web Analytics
  dans Cloudflare, ou autoriser ce script dans la CSP.

## P4 — PageSpeed mobile sur arakice.com (2026-10-06, avant le commit `594f098`)

`/` : **58** (FCP 3,4 s · LCP 4,2 s · TBT 0 ms · **CLS 0,368** · SI 5,3 s). Accessibilité 98,
Best Practices 92, SEO 100. Pas encore de données terrain (CrUX).

- **Polices bloquantes, 1 330 ms** : Merriweather (6 variantes) arrivait par un `@import` dans
  `fonts.css`, découvert seulement après le CSS du bundle. Seul le 700 est utilisé.
  → Fusionné dans la requête d'`index.html` (`Merriweather:wght@700`), `@import` supprimé.
  **Non commité.** Étape suivante possible : héberger les polices soi-même (la CSP accepte `'self'`).
- **CLS** : 0,278 sur la liste des matchs du jour, 0,085 sur le bloc calendrier. Il n'est pas
  reproduit sans bridage réseau (0,000 mesuré dans le navigateur). Correctif partiel : le titre des
  matchs à venir garde 32 px pendant le chargement au lieu de 20 px (`HockeyLanding`). **Non commité.**
  Le commit `594f098` ajoute une restauration de défilement à l'accueil : remesurer après déploiement,
  et si le CLS reste élevé, enregistrer une trace DevTools (Performance, 4G lente) pour trouver la cause.
- LCP = le paragraphe « Best Parlay », 2,5 s de délai de rendu (contenu rendu en JS).

## Charge prod — sonde légère du 2026-10-06

Depuis le navigateur (Bali → Railway), 82 requêtes GET en 38 s sur les 6 endpoints publics
de l'accueil, sous le limiteur de 300 req/min : **82/82 en 200**, p50 ≈ 250 ms, p95 ≤ 303 ms
(sauf `games/range` à 561 ms), soit le simple aller-retour réseau. Premier paquet ML à froid : 806 ms.
Ça ne remplace pas P1 : un seul client, 2 req/s.

**Décision du 2026-10-06 : P1, P2 et P5 ne seront pas joués contre la vraie production.**
La règle de `loadtest/README.md` (« ne jamais tirer contre la production ») l'emporte : un tir
consomme le quota The Odds API, déclenche de vraies notifications push et oblige à relever le
limiteur (300 req/min/IP) en prod. Font référence : les bancs du 2026-09-18/19
(`loadtest/bench-results*.json`, rapport retiré le 2026-10-05 : `git show 0916b52:RAPPORT_TESTS_CHARGE_2026-09-18.md`), la QA dynamique locale du
2026-09-26 et la sonde ci-dessus. À rejouer sur une préprod si elle existe un jour.

## P4 — Lighthouse mobile (build local, `vite preview`)

Le chunk `charts` (recharts + d3, ~154 ko gzip) était **préchargé sur toutes les pages** :
`manualChunks` ne classait pas React, et Rollup rangeait react / react-dom / scheduler *dans*
`charts` — l'entrée importait donc React depuis `charts`. React a maintenant son chunk.

| Page | Avant | Après |
|---|---|---|
| `/` | score 79 · LCP 4,0 s · 337 Kio | score 84 · LCP 3,5 s · 230 Kio |
| `/nhl-predictions` | score 80 · LCP 3,9 s · 335 Kio | score 85 · LCP 3,5 s · 228 Kio |

`charts` ne se charge plus que sur `/stats/chart…` (vérifié : aucune erreur de page sur 8 routes).
LCP reste > 2,5 s en 4G lente simulée, sans CDN : à remesurer sur arakice.com.

## I2, étape 4 — sans en-tête Origin (impossible depuis un navigateur)

Un navigateur envoie **toujours** `Origin` en cross-site : il est structurellement
incapable de tester une requête qui n'en a pas. Il faut un client non navigateur,
et `arakice.com`, `api.arakice.com` comme le domaine Railway sont **bloqués par
l'allowlist d'egress** des shells de session (vérifié le 2026-08-31, les deux
shells). À lancer depuis un terminal de la machine :

```bash
# 4 — sans Origin : doit être ACCEPTÉ (voulu ; ce n'est pas une requête cross-origin)
curl -i -X POST https://api.arakice.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"cors-probe@invalid.test","password":"x"}'
# attendu : 401 Invalid credentials — et surtout PAS un refus CORS

# 1 bis — la même avec Origin, pour lire les en-têtes à l'œil
curl -i -X OPTIONS https://api.arakice.com/api/auth/login \
  -H "Origin: https://arakice.com" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type"
# attendu : 204 · access-control-allow-origin: https://arakice.com (PAS *)
#           · access-control-allow-credentials: true
```

## Après une vraie fréquentation du chat

`npm run moderation:dry-run` (serveur) : relire ce que le filtre aurait refusé.
