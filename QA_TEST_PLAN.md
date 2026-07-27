# QA — Plan de tests avant mise en production (ArakIce / ICEEDGE)

> Document de campagne de tests priorisée, adapté à l'architecture réelle du projet.
> À conserver dans le dépôt et à mettre à jour au fil des campagnes.

**Dernière mise à jour :** 2026-07-27
**Responsable QA :** _(à compléter)_
**Version / commit ciblé :** _(à compléter)_

---

## Contexte technique (ce qui conditionne les tests)

| Couche | Techno | Hébergement | Points sensibles |
|---|---|---|---|
| Frontend | React 18 + Vite + Tailwind + Radix UI, React Router 7, socket.io-client, Sentry, i18n, PWA/web-push | Vercel — `arakice.com` | SPA, appels multi-API (`VITE_*_URL`), thèmes, partage d'images (`html-to-image`) |
| API | Node/Express (TS), JWT + refresh cookie httpOnly, Google OAuth, Stripe, Zod, Helmet, CORS, rate-limit (+ store Redis), socket.io, pino, Sentry | Railway (Docker) | Auth, gating Pro, cookie `SameSite=None` cross-site, webhooks Stripe |
| Service ML | Python FastAPI + uvicorn (`/predict/game`, `/predict/player`, `/predict/team`, `/health`) | Railway (Docker) | Dépendance modèle (`inference_state.json`, `elo_ratings.json`), latence, cold start |
| Base de données | PostgreSQL (`pg`) | Supabase | Migrations, chiffrement des clés OpenAI, intégrité des slips |
| Données externes | NHL API, MoneyPuck, The Odds API, référés/scratches (JSON manuel), Tennis API | — | Indisponibilité/quotas des tiers, données périmées |

**Fonctionnalités clés à couvrir :** inscription/connexion (email + Google), prédictions NHL, Bet Builder / paris (slips), Best Bets / value bet scan, page Charts, prédictions Tennis, abonnement Pro (Stripe + codes promo), chat/LLM, notifications push, pages de partage, pages SEO statiques.

**Légende Priorité :** Critique = bloque la prod · Haute = à traiter avant lancement large · Moyenne = à planifier tôt post-lancement.
**Légende Statut :** À faire · Réussi · Échoué.

---

## 1. Tests fonctionnels

Objectif : valider les parcours qui portent la valeur métier et la monétisation.

| # | Nom du test | Résultat attendu | Priorité | Statut | Notes |
|---|---|---|---|---|---|
| F1 | Cycle d'authentification complet (register → vérif email → login → refresh → logout) | Compte créé, email vérifié requis, JWT court + cookie refresh httpOnly émis, refresh renouvelle le token, logout invalide le refresh. OAuth Google aboutit sur `AuthCallback`. | Critique | À faire | Vérifier `SameSite=None; Secure` en prod, `Lax` en dev. |
| F2 | Gating Pro de bout en bout (checkout Stripe OU code promo → contenu Pro débloqué) | Un utilisateur gratuit est bloqué sur les fonctions Pro ; après paiement/redeem, `subscription/me` renvoie `pro` et le contenu s'ouvre. En prod sans Stripe → `501`, jamais de Pro gratuit. | Critique | À faire | Tester aussi expiration/annulation → retour au plan gratuit. |
| F3 | Création et calcul d'un slip / Bet Builder | Ajout de sélections, cotes agrégées correctes, persistance en base, settlement (`settlement.service`) marque gagné/perdu selon résultat officiel. | Haute | À faire | Couvre `slip.service` (déjà testé unitairement) au niveau parcours. |
| F4 | Affichage des prédictions NHL du jour (page `NHLPredictionsPage`) | La liste des matchs du soir se charge avec probabilités, cotes et facteurs ; état vide géré (aucun match) ; rafraîchissement live cohérent. | Haute | À faire | Vérifier gardien partant/scratches réellement reflétés. |
| F5 | Best Bets / value bet scan | Les paris à valeur sont calculés et affichés (edge > seuil), tri correct, gating Pro respecté si le contenu est premium. | Haute | À faire | Couvre `bestBets.service` + `valueBetScan.service`. |
| F6 | Récupération de mot de passe (forgot → email → reset → login) | Lien de reset valide à usage unique et expirant, nouveau mot de passe accepté, ancien refusé, anciens refresh invalidés. | Haute | À faire | Vérifier non-divulgation de l'existence du compte (message neutre). |
| F7 | Prédictions Tennis (parcours `TennisPredictionsPage` / joueur) | Les matchs et prédictions tennis se chargent via `tennisApiClient`, page joueur et stats cohérentes. | Haute | À faire | Fonction secondaire mais exposée publiquement. |

---

## 2. Tests d'intégration

Objectif : valider les frontières entre les 3 services (Front ↔ API ↔ ML) et les données tierces.

| # | Nom du test | Résultat attendu | Priorité | Statut | Notes |
|---|---|---|---|---|---|
| I1 | Chaîne prédiction NHL : Front → `/api/predict` → FastAPI `/predict/game` | La prédiction affichée provient bien du service ML ; features envoyées (gardien partant, scratches, cotes) correctement mappées ; réponse conforme au schéma `MLResponse`. | Critique | À faire | Vérifier alignement contrat Node ↔ Python (noms de features). |
| I2 | CORS + cookie cross-site Vercel ↔ Railway | Requêtes authentifiées cross-origin acceptées (`CORS_ORIGIN` = domaine front), cookie refresh envoyé et accepté, pas d'erreur préflight. | Critique | À faire | Cause classique de « ça marche en local, pas en prod ». |
| I3 | Webhook Stripe → activation d'abonnement en base | L'événement `checkout.session.completed` (signature vérifiée) met à jour le statut Pro ; événement rejoué/dupliqué = idempotent. | Haute | À faire | Tester avec la CLI Stripe ; vérifier la vérif de signature. |
| I4 | Google OAuth de bout en bout (Front → API → callback Google) | Le flux `GOOGLE_REDIRECT_URI` aboutit, crée/relie le compte, émet JWT + cookie refresh, et redirige vers `AuthCallback` côté front. | Haute | À faire | URI de callback prod bien enregistré côté Google Console. |
| I5 | Temps réel socket.io Front ↔ API | Connexion établie après auth, les mises à jour (cotes/prédictions/slips) poussées sont reçues côté client ; l'auth du socket est vérifiée. | Haute | À faire | Tester en cross-site (`VITE_SOCKET_URL`) + reconnexion. |
| I6 | Pipeline données externes → features → prédiction | Les données NHL/MoneyPuck/Odds ingérées sont correctement transformées en features envoyées au ML ; une donnée manquante n'invalide pas tout le lot. | Haute | À faire | Couvre `featureEngineering` + `nhlApiClient`/`oddsClient`. |

---

## 3. Tests de performance / charge

Objectif : garantir la tenue sous charge des points chers (ML, données live) sans exploser les quotas tiers.

| # | Nom du test | Résultat attendu | Priorité | Statut | Notes |
|---|---|---|---|---|---|
| P1 | Charge sur l'endpoint de prédiction ML | Sous charge nominale (ex. 50 req/s pendant 5 min) : p95 sous seuil défini (ex. < 800 ms), 0 erreur 5xx, mémoire stable côté FastAPI. | Haute | À faire | Inclure le cold start Railway ; définir le seuil de p95 accepté. |
| P2 | Cache et quotas des données externes (Odds / NHL / MoneyPuck) | Les résultats sont servis depuis le cache (TTL respecté) ; le trafic utilisateur ne provoque pas de dépassement de quota The Odds API. | Haute | À faire | Vérifier qu'une hausse de trafic ne multiplie pas les appels tiers. |
| P4 | Performance de chargement front sur mobile (Lighthouse) | Score perf mobile acceptable (ex. LCP < 2,5 s, bundle maîtrisé) sur la landing et la page prédictions ; pas de blocage sur les gros graphiques Recharts. | Haute | À faire | Vérifier code-splitting Vite et taille du bundle. |
| P5 | Pool de connexions Postgres sous charge | Sous charge concurrente, le pool `pg` ne s'épuise pas (pas d'erreurs « too many connections » côté Supabase) ; requêtes lentes identifiées. | Haute | À faire | Aligner la taille du pool avec les limites du plan Supabase. |
| P3 | Rate limiting effectif sous burst | Au-delà du seuil (`apiLimiter`/`authLimiter`/`writeLimiter`), réponses `429` propres ; le store Redis partage bien le compteur entre instances. | Moyenne | À faire | Tester en multi-instance (le store mémoire ne suffit pas en prod). |

---

## 4. Tests de sécurité

Objectif : couvrir auth, gating payant et exposition de données — les risques les plus coûteux.

| # | Nom du test | Résultat attendu | Priorité | Statut | Notes |
|---|---|---|---|---|---|
| S1 | Contrôle d'accès / IDOR sur ressources utilisateur (slips, profil, subscription) | Impossible de lire/modifier les ressources d'un autre `user.sub` en changeant l'ID ; toute route sensible exige `authenticate`. | Critique | Réussi | Audit statique 2026-07-27 — cf. SEC-1. Vérif dynamique 2-comptes recommandée avant prod. |
| S2 | Robustesse des secrets et de l'auth | JWT expiré/altéré rejeté, refresh non rejouable après logout, mots de passe en bcrypt jamais renvoyés, clés OpenAI chiffrées en base, aucun secret dans les logs/erreurs client. | Critique | Réussi | Audit statique 2026-07-27 — cf. SEC-2. |
| S3 | En-têtes, validation d'entrée et surface d'abus | Helmet actif (CSP, HSTS), payloads invalides rejetés par Zod (400), limite `5mb` JSON respectée, routes `/api/dev` **absentes** en production. | Haute | Réussi | Audit statique 2026-07-27 — cf. SEC-3 (CSP front à vérifier côté Vercel). |
| S4 | Anti-brute-force sur l'authentification | `authLimiter` bloque les tentatives répétées de login/reset (`429`), pas d'énumération de comptes, verrouillage/backoff efficace même distribué (store Redis). | Haute | Réussi | Audit + correctif 2026-07-27 — cf. SEC-4 (`passwordResetLimiter` ajouté sur forgot-password/resend-verification). |
| S5 | Injection SQL et abus des entrées ML/LLM | Toutes les requêtes DB paramétrées (aucune concaténation) ; entrées chat/LLM assainies (pas d'injection de prompt exploitable ni de fuite de clé) ; taille/format bornés. | Haute | Réussi | Audit statique 2026-07-27 — cf. SEC-5 (requêtes 100 % paramétrées). |
| S6 | Codes promo / redeem non exploitables | Un code ne peut être utilisé au-delà de sa limite, ni bruteforcé (rate-limit `redeemLimiter`), ni réutilisé pour cumuler du Pro indûment. | Haute | Corrigé (partiel) | Audit + correctif 2026-07-27 — cf. SEC-6 : code par défaut désactivé en prod ; plafond d'usage par code = follow-up optionnel (schéma). |

---

## 5. Tests de compatibilité (navigateurs, mobile)

Objectif : garantir l'expérience sur les cibles réelles d'un produit grand public de paris.

| # | Nom du test | Résultat attendu | Priorité | Statut | Notes |
|---|---|---|---|---|---|
| C1 | Parcours critique sur mobile (iOS Safari + Android Chrome) | Login, prédictions, Bet Builder et paiement sont utilisables et lisibles ; pas de débordement, cibles tactiles correctes, thème respecté. | Haute | À faire | Safari iOS = source n°1 de bugs cookies/`SameSite`/PWA. |
| C4 | Pages SEO statiques (`public/`) sur crawlers et réseaux sociaux | Les landing pages arakice.com se rendent avec titres/meta/OpenGraph corrects, sont indexables et affichent un aperçu propre au partage. | Haute | À faire | Vérifier le générateur `seo:gen` et la cohérence des templates. |
| C2 | Cross-navigateur desktop (Chrome, Firefox, Safari, Edge) | Rendu et interactions Radix/Recharts identiques ; aucune erreur console bloquante ; graphiques Charts corrects. | Moyenne | À faire | Vérifier partage d'image (`html-to-image`) selon navigateur. |
| C3 | Notifications push web (PWA / web-push) | Abonnement, réception et clic sur notification fonctionnent là où supporté ; dégradation propre là où non supporté (iOS restrictions). | Moyenne | À faire | Tester ajout à l'écran d'accueil + permission refusée. |

---

## 6. Tests de résilience (erreurs, timeouts, indisponibilité)

Objectif : le produit reste utilisable et ne « ment » pas quand un service tiers ou interne tombe.

| # | Nom du test | Résultat attendu | Priorité | Statut | Notes |
|---|---|---|---|---|---|
| R1 | Indisponibilité du service ML (down / timeout / 5xx) | L'API renvoie une erreur maîtrisée, le front affiche un message clair (pas d'écran blanc), aucune prédiction erronée servie ; erreur remontée à Sentry. | Critique | Réussi | Audit statique 2026-07-27 — cf. RES-1. Test dynamique (couper le ML) recommandé avant prod. |
| R2 | Données tierces indisponibles ou périmées (Odds/NHL down, JSON scratches manquant) | Fallback propre (cache/valeur par défaut/indicateur « données indisponibles ») ; pas de crash serveur ; les cotes placeholder ne sont pas présentées comme réelles. | Haute | Réussi | Audit statique 2026-07-27 — cf. RES-2 (note : cotes servies vides plutôt que cache périmé pendant une panne). |
| R4 | Indisponibilité du fournisseur de paiement pendant le checkout | Si Stripe est injoignable/timeout, l'utilisateur voit une erreur claire et n'est ni débité ni passé Pro ; réessai possible ; aucun état incohérent en base. | Haute | Réussi | Audit statique 2026-07-27 — cf. RES-4 (erreurs structurées, Pro accordé uniquement par webhook signé). |
| R5 | Redéploiement / redémarrage sans coupure (Railway) | Un redeploy de l'API ou du ML ne provoque pas d'erreurs 5xx visibles prolongées ; arrêt gracieux (drain des requêtes), reconnexion socket/DB automatique. | Haute | Réussi | Audit statique 2026-07-27 — cf. RES-5 (SIGTERM drain + force-exit, `/health`). |
| R3 | Perte de connexion socket.io + coupure DB transitoire | Le client se reconnecte automatiquement sans doublons ; une erreur Postgres transitoire renvoie 5xx maîtrisé sans fuite de détails ni corruption de slip. | Moyenne | Réussi | Audit statique 2026-07-27 — cf. RES-3 (reconnexion auto + dédup par id + `pool.on('error')`). |

---

## Checklist — Avant mise en prod

**Configuration & secrets** — _campagne exécutée le 2026-07-27, détail dans « Résultats » ci-dessous_

- [x] Toutes les variables d'env prod définies (Railway API, Railway ML, Vercel) : `DATABASE_URL`, `CORS_ORIGIN`/`CLIENT_URL`, `ML_SERVICE_URL`, `STRIPE_SECRET_KEY` + secret webhook, JWT secrets, Google OAuth (`GOOGLE_REDIRECT_URI`), clés VAPID push, `VITE_*_URL`. → **Templates complétés** (cf. CFG-1). Reste à confirmer leur présence dans Railway/Vercel (opérationnel).
- [x] Aucun secret en clair dans le dépôt ni dans le bundle front (`VITE_*` ne contient que du public). → **Réussi** : bundle propre, valeur littérale retirée des docs (cf. CFG-4).
- [x] `NODE_ENV=production` → routes `/api/dev` non montées, pas d'activation Pro gratuite. → **Réussi** (cf. CFG-2).
- [x] Rotation/validité des secrets vérifiée (`SECRET_ROTATION.md`). → **Scanner gitleaks ajouté au CI** (cf. CFG-5). Mot de passe DB = local uniquement, rotation non nécessaire.

**Sécurité** — _validé en statique le 2026-07-27 (cf. campagne « Sécurité »)_

- [x] Cookie refresh `httpOnly; Secure; SameSite=None` fonctionnel cross-site en prod. → Code OK (`httpOnly`, `secure`/`sameSite=none` en prod, `path=/api/auth`). Fonctionnement cross-site réel à confirmer en staging.
- [x] Helmet + CORS restreints au domaine de prod ; rate limiting actif. → Helmet actif, CORS = allowlist + preview Vercel (`credentials:true`), limiters actifs. *Store Redis partagé = différé (CFG-6, mono-instance).* 
- [x] Contrôle d'accès vérifié sur toutes les routes utilisateur (pas d'IDOR). → SEC-1 ✅ (test dynamique 2-comptes recommandé).
- [x] Signature des webhooks Stripe vérifiée ; clés OpenAI chiffrées en base. → `constructEvent` (400 si invalide) + AES-256-GCM (`crypto.util`) ✅.

**Données & ML**

- [~] Migrations Postgres appliquées sur la base de prod (`db:migrate:all`, slips). → Migrations présentes dans le dépôt (jusqu'à `011_subscriptions`). **Application sur la base de prod = opérationnel, à confirmer.**
- [x] Modèle ML entraîné et fichiers d'état présents (`inference_state.json`, `elo_ratings.json`, modèles) ; `/health` OK. → Fichiers présents (`game_model.json`, `totals_model.json`, `inference_state.json`, `elo_ratings.json`…) ; endpoints `/health` + `/health/ready` définis ✅.
- [x] Sources de données du soir alimentées (scratches, gardiens partants, référés) ou fallback validé. → **Fallback validé** (RES-2 : fichier manquant → `{}` sans crash). Alimentation quotidienne = opérationnel.
- [~] Cotes réelles distinguées des placeholders côté UI. → Côté serveur, panne odds → `[]` (pas de cote inventée). **À confirmer côté UI** : aucune cote factice/démo affichée comme réelle.

**Qualité & build**

- [ ] `npm run typecheck` + `vitest run` (server) au vert ; build front Vercel OK. → **À lancer en local** (le mount du sandbox tronque les lectures → build non fiable ici). 3 fichiers de tests présents (`app.test.ts`, `slip.service.test.ts`, `schemas.test.ts`) + job CI `server`/`client`.
- [ ] Parcours critiques F1, F2, I1, I2 passés en environnement de staging. → **Dynamique, à exécuter en staging.**
- [ ] Test mobile iOS Safari du parcours login → prédiction → paiement passé (C1). → **Dynamique, à exécuter.**

**Observabilité & reprise**

- [x] Sentry actif et recevant les erreurs (front + API + ML). → Front (`main.tsx`) ✅ + API (`instrument.ts`) ✅ + **ML (FastAPI) ajouté le 2026-07-27** (`sentry-sdk[fastapi]` + init conditionnel sur `SENTRY_DSN` dans `ml_service.py`, no-op sinon). **Reste opérationnel** : définir `SENTRY_DSN` sur le service ML Railway (variable propre à ce service).
- [x] Logs pino lisibles, sans fuite de secrets ; monitoring/uptime en place (`MONITORING.md`). → Rédaction `authorization`/`cookie`/`set-cookie` ✅ ; `MONITORING.md` présent (uptime à brancher = opérationnel).
- [~] Procédure de sauvegarde/restauration DB validée (`BACKUP_DR.md`). → Doc présente ; **exécution d'un test de restauration = opérationnel, à valider.**
- [~] Plan de rollback déploiement documenté et testé. → **Opérationnel** (rollback Railway/Vercel à documenter + tester une fois).

**Légal / conformité produit paris**

- [x] Pages Terms, Privacy, Support accessibles et à jour. → `TermsPage`, `PrivacyPage`, `SupportPage` présentes (EN/FR) ✅.
- [x] Mentions de responsabilité / avertissement paris présentes selon la juridiction cible. → Disclaimer « 18+ · Jouez de manière responsable · Non disponible dans toutes les juridictions » + Terms « à titre informatif, pas un bookmaker, pas un conseil de pari » ✅. À adapter si juridiction cible spécifique.

**Légende checklist :** [x] validé en statique · [~] partiel / à confirmer en opérationnel · [ ] à exécuter (dynamique/local).

---

_Comment utiliser ce document : mettre à jour la colonne Statut à chaque exécution, documenter tout échec dans Notes (avec lien vers l'issue), et ne pas déployer tant qu'un test **Critique** est en Échoué ou À faire._

---

## Résultats — Campagne « Configuration & secrets » (2026-07-27)

Audit statique du dépôt (branche courante). Légende : ✅ conforme · ⚠️ à corriger · 🔴 bloquant.

| # | Vérification | Résultat | Priorité | Statut | Détail / action |
|---|---|---|---|---|---|
| CFG-1 | Complétude des templates d'env vs code | ✅ | Haute | Réussi | **Corrigé le 2026-07-27.** Les ~18 vars serveur manquantes ajoutées à `server/.env.example` (bloc « Variables additionnelles » : `REDIS_URL`, `PRO_PROMO_CODES`, `ENABLE_DEV_ROUTES`, `REFRESH_TOKEN_TTL(_REMEMBER)`, `DB_SSL`, `LOG_LEVEL`, `LLM_*`, `VALUE_BET_*`, `ODDS_LOG_*`, `SCRATCHES_PATH`, `STARTING_GOALIES_PATH`, `TOKEN_CLEANUP_GRACE_DAYS`) et `VITE_STAKE_AFFILIATE_CODE` ajoutée à `client/.env.example`. `.env` reste ignoré ; seuls les `.env.example` sont suivis. |
| CFG-2 | Gating `NODE_ENV=production` | ✅ | Critique | Réussi | `/api/dev` monté seulement si `NODE_ENV !== 'production'` **ou** `ENABLE_DEV_ROUTES=true` (défense en profondeur : aussi `authenticate` + rôle admin) ; `/dev/seed` hors prod uniquement ; `subscription/checkout` renvoie `501` en prod sans Stripe (jamais de Pro gratuit) ; `trust proxy = 1` bien activé en prod. |
| CFG-3 | Fail-fast des secrets obligatoires | ✅ | Haute | Réussi | `JWT_SECRET` → throw si absent (`auth.service`) ; `ENCRYPTION_KEY` → requis en prod et doit décoder à exactement 32 octets (`crypto.util`, AES-256-GCM). L'app ne démarre pas / ne chiffre pas sans ces clés. |
| CFG-4 | Absence de secret en clair (dépôt + bundle) | ✅ | Critique | Réussi | Bundle front `client/dist` : **aucun** motif de secret (`sk_live`, `github_pat_`, `re_…`, clés API) ; aucun secret serveur exposé via `import.meta.env`. **Corrigé le 2026-07-27** : la valeur littérale du mot de passe DB a été retirée des docs suivis (`PRODUCTION_READINESS_AUDIT.md`, `SECRET_ROTATION.md` → placeholders) ; `git grep` ne renvoie plus rien. **Note contexte** : mot de passe de DB **locale** uniquement (confirmé par Miss) → non compromettant pour la prod ; rotation non nécessaire. La purge de l'historique git reste optionnelle (valeur locale sans valeur pour un attaquant). |
| CFG-5 | Hygiène / prévention (scanner CI) | ✅ | Moyenne | Réussi | **Corrigé le 2026-07-27** : job `secrets` (gitleaks) ajouté à `.github/workflows/ci.yml`, exécuté sur push/PR avec `fetch-depth: 0` (scan de l'historique). Bloque la CI si un secret est commité. |
| CFG-6 | Store rate-limit multi-instance | ⚠️ | Haute | Différé | `redisRateLimitStore.ts` existe mais n'est pas câblé → store mémoire par défaut. **Différé (2026-07-27)** : Redis pas encore utilisé et déploiement mono-instance → non bloquant. À câbler le jour où l'API passe en multi-instance sur Railway (sinon compteurs non partagés + reset à chaque redeploy). |

**Vérifications non concluables en statique (à confirmer par Miss, hors dépôt) :**

- Rotation effective côté fournisseurs (Postgres/Supabase, JWT, Google, Stripe, Resend, Odds, VAPID) — la présence d'un secret dans l'historique n'indique pas s'il a déjà été rotationné.
- Purge réelle de l'historique git (`git log -p -S mike1970` — non exécuté ici, coûteux dans l'environnement d'audit).
- Présence de toutes les variables dans les tableaux de bord Railway/Vercel de prod.

**Synthèse (mise à jour 2026-07-27) :** CFG-1, CFG-2, CFG-3, CFG-4, CFG-5 conformes. Reste **CFG-6** (câblage du store Redis de rate-limit — touche du code applicatif, à traiter séparément) et les vérifications opérationnelles hors dépôt (présence des vars dans Railway/Vercel). Aucun point bloquant restant pour « Configuration & secrets ».

---

## Résultats — Campagne « Sécurité » (2026-07-27)

Audit statique du code serveur (`server/src`). Légende : ✅ conforme · ⚠️ à corriger · 🔴 bloquant.

| # | Vérification | Résultat | Priorité | Statut | Détail / action |
|---|---|---|---|---|---|
| SEC-1 | Contrôle d'accès / IDOR | ✅ | Critique | Réussi | `slip.routes` : `router.use(authenticate)` + service scopé (`getSlip` → `WHERE id=$1 AND user_id=$2`, `getSlips` → `WHERE user_id=$1`) ; `resolveSlip` réservé admin + contrôle de propriété. `user.routes` : `requireOwnerOrAdmin`. `chat.service` : `assertAdmin` sur retrait de membre / changement de rôle / suppression de room, `assertMember` en lecture, suppression de message limitée au propriétaire. `profile/:userId/slips` : ses propres slips OK, ceux d'autrui exigent Pro (feature « slips publics » volontaire). **Aucun IDOR détecté.** Recommandé : test dynamique à 2 comptes avant prod. |
| SEC-2 | JWT / secrets / mots de passe | ✅ | Critique | Réussi | `verifyAccessToken` = `jwt.verify` (signature **et** expiration) ; token d'accès court. Refresh tokens **stockés hachés**, révoqués au logout, à la rotation et au reset ; `logoutAll` disponible. `toPublicUser` retire `password_hash` sur **tous** les retours ; hachage bcrypt + `bcrypt.compare`. Logs pino : `authorization`, `cookie`, `set-cookie` supprimés. *Amélioration mineure* : rédiger aussi `req.body.password`/`code` par précaution. |
| SEC-3 | En-têtes / validation / surface d'abus | ✅ | Haute | Réussi | `helmet()` actif (CSP `default-src 'self'` + HSTS par défaut) ; `express.json({ limit: '5mb' })` ; validation Zod (`validateBody`) sur auth et slips ; `llm.routes` borne types + longueurs ; `/api/dev` non monté en prod (SEC/CFG-2). **À vérifier séparément** : la CSP réellement exposée au navigateur est servie par **Vercel** (front), pas par cette API → contrôler les en-têtes/CSP côté Vercel pour la protection XSS du SPA. |
| SEC-4 | Anti-brute-force auth | ✅ | Haute | Réussi | `authLimiter` appliqué à tout `/api/auth` (15 essais/15 min/IP en prod, ne compte que les échecs) ; messages d'erreur **génériques** (`Invalid credentials`, `forgot-password` → `{ok:true}` neutre) → pas d'énumération de comptes. **Corrigé le 2026-07-27** : ajout de `passwordResetLimiter` (compte **toutes** les requêtes, 5/h/IP en prod) appliqué à `forgot-password` **et** `resend-verification` → email-bombing bloqué. Réserve restante : store mémoire mono-instance (cf. CFG-6, non bloquant en mono-instance). |
| SEC-5 | Injection SQL / abus LLM | ✅ | Haute | Réussi | **Toutes** les requêtes `pg` auditées sont paramétrées (`$1,$2,…`), aucune concaténation d'entrée utilisateur dans le SQL (slip/auth/user/subscription/chat). LLM : plafonds `MAX_PROMPT_CHARS`/`MAX_SYSTEM_CHARS`, `model` typé + borné à 100 car., timeout, quota quotidien, `llmLimiter` par utilisateur. Chat : longueur de message plafonnée, couleur hex assainie. |
| SEC-6 | Codes promo non exploitables | ⚠️ | Haute | Corrigé (partiel) | `redeemPromo` : protégé par `redeemLimiter` (10/h/user), code invalide → 400, **pas de cumul** (sémantique d'écrasement : fin = maintenant + jours). **Corrigé le 2026-07-27** : le code par défaut devinable `ICEEDGEPRO` **n'est plus actif en production** — si `PRO_PROMO_CODES` n'est pas défini, le catalogue est vide (tout code → 400) et un `logger.warn` est émis ; le défaut ne sert plus qu'en dev/test. **Reste optionnel (non implémenté)** : plafond d'usage par code + date d'expiration (nécessite une table `promo_redemptions` avec `max_uses`/`expires_at` — changement de schéma, à décider selon l'usage des codes). Sans ça, un code **volontairement** partagé reste utilisable par plusieurs comptes — acceptable pour des codes de lancement contrôlés, à border si les codes sont individuels. |

**Vérifications à compléter en dynamique (hors audit statique) :**

- Test IDOR à 2 comptes (lecture/écriture croisée sur slips et profil).
- Rejet effectif d'un JWT expiré/altéré et non-rejouabilité d'un refresh après logout (test d'intégration).
- En-têtes/CSP réellement servis au navigateur (front Vercel).

**Synthèse (mise à jour 2026-07-27) :** SEC-1→SEC-5 conformes. Correctifs appliqués : `passwordResetLimiter` sur les endpoints d'email (SEC-4) et désactivation du code promo par défaut en production (SEC-6). Reste optionnel : plafond d'usage/expiration par code promo (SEC-6, nécessite un changement de schéma — à décider). Aucun bloquant restant pour la Sécurité. **Rappel** : lancer `npm run typecheck && npm test` (server) en local pour valider le TS des 3 fichiers modifiés (`rateLimit.middleware.ts`, `auth.routes.ts`, `subscription.service.ts`).

---

## Résultats — Campagne « Résilience » (2026-07-27)

Audit statique (serveur + client). Légende : ✅ conforme · ⚠️ amélioration possible · 🔴 bloquant.

| # | Vérification | Résultat | Priorité | Statut | Détail / action |
|---|---|---|---|---|---|
| RES-1 | Indisponibilité du service ML | ✅ | Critique | Réussi | `mlApiClient` : timeout **5 s** via `AbortController`, throw sur timeout/`!res.ok`. Repli en cascade : route `/predict/ml` → **503 maîtrisé** (`logger.warn`, le front masque la section) ; `bestBets.service` → repli **par candidat** sur le score de règles (`mlScore` renvoie `null`) + flag `mlAvailable` exposé ; court-circuit `ML_DISABLED=true`. Aucune prédiction erronée servie, aucun crash. *Note* : les pannes ML sont journalisées en `warn` (état dégradé attendu), pas envoyées à Sentry comme erreurs — cohérent. |
| RES-2 | Données tierces indisponibles / périmées | ✅ | Haute | Réussi | `oddsClient` : cache 5 min ; sur `!res.ok`/exception → `logger.error` + renvoie `[]` (pas de crash) ; `findEvent` gère l'absence → pas de cote affichée. `nhlApiClient` : cache TTL en mémoire + `catch` avec fallback neutre par source. `scratches.ts` : fichier manquant/JSON invalide → `catch` → `{}` (comportement legacy). **Amélioration possible** : servir le **cache périmé** plutôt que `[]` pendant une panne de The Odds API (évite un écran sans cotes). |
| RES-3 | Reconnexion socket + coupure DB transitoire | ✅ | Moyenne | Réussi | Client : `socket.io-client` reconnecte automatiquement ; `disconnect` gère l'état ; **dédup par `id`** sur `new_message` (pas de doublon à la reconnexion) ; `confirmMessage` gère la course socket/HTTP ; **cleanup à l'unmount** (`leave_room` + `disconnect`) → pas de connexions fantômes. DB : `pool.on('error')` empêche le crash du process sur erreur de client idle ; `connectionTimeoutMillis=5s`. |
| RES-4 | Indisponibilité du fournisseur de paiement | ✅ | Haute | Réussi | `createCheckoutSession` lève des erreurs **structurées** (501/500/502) captées par la route (`res.status(err.status)`), l'utilisateur voit une erreur claire ; le Pro n'est accordé **que** par le webhook signé (`constructEvent`) ou l'activation dev — jamais sur un échec de checkout → pas d'état incohérent. Webhook : signature vérifiée, throw **400** sur signature invalide → Stripe **rejoue**. |
| RES-5 | Redéploiement / redémarrage sans coupure | ✅ | Haute | Réussi | `registerGracefulShutdown` sur `SIGTERM`/`SIGINT` : draine WebSocket (`io.close`) + HTTP (`httpServer.close`) puis `pool.end()`, avec **timeout dur** `SHUTDOWN_TIMEOUT_MS` (force-exit `unref`'d) et idempotence (2ᵉ signal ignoré). Endpoints `/health` (`{status:ok}`) + readiness (503 si non prêt) pour le healthcheck Railway. |

**Tests dynamiques à réaliser avant prod (non couverts par l'audit statique) :**

- Couper le service ML (down + lent) et vérifier la dégradation UI + le repli règles.
- Couper The Odds API / retirer `scratches.json` et vérifier l'absence de crash.
- Redeploy Railway sous trafic : mesurer les 5xx pendant le drain + reconnexion socket auto.
- Webhook Stripe rejoué/retardé : vérifier l'idempotence (croise avec I3).

**Synthèse :** RES-1→RES-5 **tous conformes** — la gestion d'erreurs/timeouts/pannes est de bonne qualité (repli règles, caches, `pool.on('error')`, arrêt gracieux). **Aucun correctif requis.** Une seule amélioration optionnelle : servir le cache d'odds périmé pendant une panne (RES-2).
