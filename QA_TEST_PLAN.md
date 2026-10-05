# QA — ce qui reste à jouer (ArakIce / ICEEDGE)

> Tout ce qui pouvait tourner sans le monde réel est passé (campagnes statiques de juillet,
> I1/I2 du 2026-08-31, QA dynamique du 2026-09-26, F1/F2/F6 et C1 en production le
> 2026-10-05, I6 sur l'API NHL réelle le 2026-10-05). Le détail de ces campagnes et les runbooks F1/F2/I1/I2 ont été retirés le
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
| I4 | Google OAuth de bout en bout (Front → API → callback Google) | Le flux `GOOGLE_REDIRECT_URI` aboutit, crée/relie le compte, émet JWT + cookie refresh, et redirige vers `AuthCallback` côté front. | Haute | À faire | URI de callback prod bien enregistré côté Google Console. |
| I6 | Pipeline données externes → features → prédiction | Les données NHL/MoneyPuck/Odds ingérées sont correctement transformées en features envoyées au ML ; une donnée manquante n'invalide pas tout le lot. | Haute | **Réussi** (2026-10-05) | 34/34 sur 9 vrais matchs — voir § I6 ci-dessous. Cotes non couvertes (The Odds API injoignable depuis le shell). |
| P1 | Charge sur l'endpoint de prédiction ML | Sous charge nominale (ex. 50 req/s pendant 5 min) : p95 sous seuil défini (ex. < 800 ms), 0 erreur 5xx, mémoire stable côté FastAPI. | Haute | À faire | Inclure le cold start Railway ; définir le seuil de p95 accepté. |
| P2 | Cache et quotas des données externes (Odds / NHL / MoneyPuck) | Les résultats sont servis depuis le cache (TTL respecté) ; le trafic utilisateur ne provoque pas de dépassement de quota The Odds API. | Haute | À faire | Vérifier qu'une hausse de trafic ne multiplie pas les appels tiers. |
| P4 | Performance de chargement front sur mobile (Lighthouse) | Score perf mobile acceptable (ex. LCP < 2,5 s, bundle maîtrisé) sur la landing et la page prédictions ; pas de blocage sur les gros graphiques Recharts. | Haute | À faire | Vérifier code-splitting Vite et taille du bundle. |
| P5 | Pool de connexions Postgres sous charge | Sous charge concurrente, le pool `pg` ne s'épuise pas (pas d'erreurs « too many connections » côté Neon) ; requêtes lentes identifiées. | Haute | À faire | Vérifier d'abord que `DATABASE_URL` pointe sur l'endpoint `-pooler` : sur l'endpoint direct le test échouera pour la mauvaise raison. |
| C4 | Pages SEO statiques (`public/`) sur crawlers et réseaux sociaux | Les landing pages arakice.com se rendent avec titres/meta/OpenGraph corrects, sont indexables et affichent un aperçu propre au partage. | Haute | À faire | Vérifier le générateur `seo:gen` et la cohérence des templates. |
| C2 | Cross-navigateur desktop (Chrome, Firefox, Safari, Edge) | Rendu et interactions Radix/Recharts identiques ; aucune erreur console bloquante ; graphiques Charts corrects. | Moyenne | À faire | Vérifier partage d'image (`html-to-image`) selon navigateur. |
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
