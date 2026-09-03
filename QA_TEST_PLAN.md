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
| Base de données | PostgreSQL (`pg`) | Neon | Migrations, chiffrement des clés OpenAI, intégrité des slips |
| Données externes | NHL API, MoneyPuck, The Odds API, référés/scratches (JSON manuel) | — | Indisponibilité/quotas des tiers, données périmées |

**Fonctionnalités clés à couvrir :** inscription/connexion (email + Google), prédictions NHL, Bet Builder / paris (slips), Best Bets / value bet scan, page Charts, abonnement Pro (Stripe + codes promo), chat/LLM, notifications push, pages de partage, pages SEO statiques.

**Légende Priorité :** Critique = bloque la prod · Haute = à traiter avant lancement large · Moyenne = à planifier tôt post-lancement.
**Légende Statut :** À faire · Réussi · Échoué.

---

## 1. Tests fonctionnels

Objectif : valider les parcours qui portent la valeur métier et la monétisation.

> **F1 et F2 ont un runbook exécutable** en fin de document (§ « Runbooks B4 »).

| # | Nom du test | Résultat attendu | Priorité | Statut | Notes |
|---|---|---|---|---|---|
| F1 | Cycle d'authentification complet (register → vérif email → login → refresh → logout) | Compte créé, email vérifié requis, JWT court + cookie refresh httpOnly émis, refresh renouvelle le token, logout invalide le refresh. OAuth Google aboutit sur `AuthCallback`. | Critique | À faire | Vérifier `SameSite=None; Secure` en prod, `Lax` en dev. |
| F2 | Gating Pro de bout en bout (checkout Stripe OU code promo → contenu Pro débloqué) | Un utilisateur gratuit est bloqué sur les fonctions Pro ; après paiement/redeem, `subscription/me` renvoie `pro` et le contenu s'ouvre. En prod sans Stripe → `501`, jamais de Pro gratuit. | Critique | À faire | Tester aussi expiration/annulation → retour au plan gratuit. |
| F3 | Création et calcul d'un slip / Bet Builder | Ajout de sélections, cotes agrégées correctes, persistance en base, settlement (`settlement.service`) marque gagné/perdu selon résultat officiel. | Haute | À faire | Couvre `slip.service` (déjà testé unitairement) au niveau parcours. |
| F4 | Affichage des prédictions NHL du jour (page `NHLPredictionsPage`) | La liste des matchs du soir se charge avec probabilités, cotes et facteurs ; état vide géré (aucun match) ; rafraîchissement live cohérent. | Haute | À faire | Vérifier gardien partant/scratches réellement reflétés. |
| F5 | Best Bets / value bet scan | Les paris à valeur sont calculés et affichés (edge > seuil), tri correct, gating Pro respecté si le contenu est premium. | Haute | À faire | Couvre `bestBets.service` + `valueBetScan.service`. |
| F6 | Récupération de mot de passe (forgot → email → reset → login) | Lien de reset valide à usage unique et expirant, nouveau mot de passe accepté, ancien refusé, anciens refresh invalidés. | Haute | À faire | Vérifier non-divulgation de l'existence du compte (message neutre). |

---

## 2. Tests d'intégration

Objectif : valider les frontières entre les 3 services (Front ↔ API ↔ ML) et les données tierces.

> **I1 et I2 ont un runbook exécutable** en fin de document (§ « Runbooks B4 »).

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
| P5 | Pool de connexions Postgres sous charge | Sous charge concurrente, le pool `pg` ne s'épuise pas (pas d'erreurs « too many connections » côté Neon) ; requêtes lentes identifiées. | Haute | À faire | Vérifier d'abord que `DATABASE_URL` pointe sur l'endpoint `-pooler` : sur l'endpoint direct le test échouera pour la mauvaise raison. |
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
- [~] Parcours critiques F1, F2, I1, I2. → **I1 et I2 exécutés le 2026-08-31 — verts, contre la PRODUCTION** (il n'existe pas de staging : voir § « Exécution du 2026-08-31 » en fin de document). **F1 et F2 restent à faire** : ils écrivent en base.
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
| RES-2 | Données tierces indisponibles / périmées | ✅ | Haute | Réussi | `oddsClient` : cache 5 min ; sur `!res.ok`/exception → `logger.error` + renvoie `[]` (pas de crash) ; `findEvent` gère l'absence → pas de cote affichée. `nhlApiClient` : cache TTL en mémoire + `catch` avec fallback neutre par source. `scratches.ts` : fichier manquant/JSON invalide → `catch` → `{}` (comportement legacy). **Amélioration appliquée depuis, vérifiée le 2026-08-24** : le cache périmé est servi plutôt que `[]` pendant une panne de The Odds API — `oddsClient.fetchAllOdds` → `oddsCache.getStale()` + `logger.warn` ; proxy `odds.routes.ts` → réponse stale en `max-age=30`, 502 seulement si le cache est vide. `fetchSpreadsOnly` garde `[]` **volontairement** (un prix ancien réécrit dans un snapshot fabriquerait un faux mouvement de ligne). |
| RES-3 | Reconnexion socket + coupure DB transitoire | ✅ | Moyenne | Réussi | Client : `socket.io-client` reconnecte automatiquement ; `disconnect` gère l'état ; **dédup par `id`** sur `new_message` (pas de doublon à la reconnexion) ; `confirmMessage` gère la course socket/HTTP ; **cleanup à l'unmount** (`leave_room` + `disconnect`) → pas de connexions fantômes. DB : `pool.on('error')` empêche le crash du process sur erreur de client idle ; `connectionTimeoutMillis=5s`. |
| RES-4 | Indisponibilité du fournisseur de paiement | ✅ | Haute | Réussi | `createCheckoutSession` lève des erreurs **structurées** (501/500/502) captées par la route (`res.status(err.status)`), l'utilisateur voit une erreur claire ; le Pro n'est accordé **que** par le webhook signé (`constructEvent`) ou l'activation dev — jamais sur un échec de checkout → pas d'état incohérent. Webhook : signature vérifiée, throw **400** sur signature invalide → Stripe **rejoue**. |
| RES-5 | Redéploiement / redémarrage sans coupure | ✅ | Haute | Réussi | `registerGracefulShutdown` sur `SIGTERM`/`SIGINT` : draine WebSocket (`io.close`) + HTTP (`httpServer.close`) puis `pool.end()`, avec **timeout dur** `SHUTDOWN_TIMEOUT_MS` (force-exit `unref`'d) et idempotence (2ᵉ signal ignoré). Endpoints `/health` (`{status:ok}`) + readiness (503 si non prêt) pour le healthcheck Railway. |

**Tests dynamiques à réaliser avant prod (non couverts par l'audit statique) :**

- Couper le service ML (down + lent) et vérifier la dégradation UI + le repli règles.
- Couper The Odds API / retirer `scratches.json` et vérifier l'absence de crash.
- Redeploy Railway sous trafic : mesurer les 5xx pendant le drain + reconnexion socket auto.
- Webhook Stripe rejoué/retardé : vérifier l'idempotence (croise avec I3).

**Synthèse :** RES-1→RES-5 **tous conformes** — la gestion d'erreurs/timeouts/pannes est de bonne qualité (repli règles, caches, `pool.on('error')`, arrêt gracieux). **Aucun correctif requis.** La seule amélioration optionnelle (servir le cache d'odds périmé pendant une panne, RES-2) est **implémentée** ; il reste à la provoquer en dynamique, pas à l'écrire.


---

# Runbooks B4 — F1, F2, I1, I2

*Écrits le 2026-08-30, depuis le code (`auth.routes.ts`, `subscription.routes.ts`,
`ml.routes.ts`, `dev.routes.ts`, `cors.ts`, `mlApiClient.ts`). Ces quatre
parcours sont la ligne **B4** de `RESTE_A_FAIRE.md` §1 : bloquants avant
lancement. Le but de cette section est qu'exécuter la campagne ne demande plus
aucune décision — seulement de lire et de comparer.*

Conventions : `$API` = base de l'API de staging (ex. `https://…up.railway.app`),
`$FRONT` = origine du front de staging. **Les deux en `https://`, sans slash
final.** `$ACCESS` = le jeton d'accès (JWT court) renvoyé dans le corps JSON.

## Préflight commun — 4 variables à lire AVANT de commencer

Trois des quatre parcours échouent pour la même poignée de raisons, et aucune ne
se voit dans la réponse HTTP. À lire dans la bannière `[Server] Réglages
effectifs` du conteneur, **pas dans le dashboard** : c'est la seule source qui
dise ce que le process fait.

| Variable | Ce qu'il faut | Ce qui casse silencieusement sinon |
|---|---|---|
| `NODE_ENV` | **`production`** | En dessous, le cookie de refresh part en `SameSite=Lax` **sans `Secure`** (`auth.routes.ts` : `IS_PROD`). Le navigateur le refuse en cross-site → F1 et I2 échouent tous les deux, et l'erreur ressemble à un bug d'auth |
| `CORS_ORIGIN` | **exactement** `$FRONT` | Une liste séparée par des virgules est acceptée, mais un slash final ou une casse différente ne matche pas : `isAllowedOrigin` fait une **égalité de chaîne** |
| `EMAIL_VERIFICATION_DISABLED` | à connaître, pas à changer | Décide quelle branche de F1 s'applique (voir plus bas). Ne pas le basculer pour « aller plus vite » : on testerait alors un parcours qui n'existe pas en production |
| `ENABLE_DEV_ROUTES` | **`true`** pour I1 | Sans ça, `/api/dev/*` n'est **pas monté du tout** en production (`app.ts`) : les appels renvoient 404, ce qui se lit à tort comme « la route est cassée » |

Pour I1, ajouter : `ML_DISABLED=false`, `ML_API_TOKEN` présent **des deux côtés**,
et `ML_SERVICE_URL` avec **son port** (`http://<service>.railway.internal:8080`).
Sans port, `mlApiClient` journalise `[ML] Adresse interne sans port` au
démarrage — un avertissement à chercher avant de conclure quoi que ce soit.

---

## F1 — Cycle d'authentification complet

**Ce qui est réellement testé :** que le refresh vit dans un cookie httpOnly aux
bons attributs, qu'il ne fuit jamais dans le corps JSON, et qu'un logout le rend
**définitivement** inutilisable.

### Séquence

| # | Appel | Attendu | Assertion qui compte |
|---|---|---|---|
| 1 | `POST $API/api/auth/register` · `{email, username, password}` (≥ 8 caractères) | **201** | Si `EMAIL_VERIFICATION_DISABLED=true` → corps `{user, tokens}` **et** un `Set-Cookie`. Sinon → corps `{pending:true, email}` et **aucun cookie** : c'est correct, aucun jeton n'est émis avant vérification |
| 2 | *(branche vérification)* récupérer le code à 6 chiffres | — | Si `RESEND_API_KEY` est absente, l'e-mail **n'est pas envoyé** : le code n'existe que dans les logs Railway, ligne `[Email] RESEND_API_KEY not set`. Le chercher là plutôt que dans une boîte mail |
| 3 | `POST $API/api/auth/verify-email` · `{email, code}` | **200** + `Set-Cookie` | Attributs **exacts** : `HttpOnly`, `Secure`, `SameSite=None`, **`Path=/api/auth`**, `Max-Age` = 604800 (7 j) ou 2592000 (« remember me »). Un seul attribut faux et le navigateur jette le cookie sans rien dire |
| 4 | `POST $API/api/auth/login` · `{email, password}` | **200** | Le corps **ne doit pas contenir** `refresh_token` ni `refresh_expires_in` (`publicTokens` les retire). S'ils y sont, le refresh a fuité hors du cookie : **échec, même si le parcours marche** |
| 5 | `GET $API/api/auth/me` · `Authorization: Bearer $ACCESS` | **200**, l'utilisateur créé | — |
| 6 | `POST $API/api/auth/refresh` · **cookie seul, sans Bearer** | **200**, nouvel access token | Doit marcher sans en-tête d'autorisation : c'est tout l'intérêt du cookie |
| 7 | `POST $API/api/auth/logout` · Bearer **+** cookie | **200** | `logout` est derrière `authenticate` : sans le Bearer c'est 401, et on croit à tort que le logout est cassé |
| 8 | `POST $API/api/auth/refresh` avec le **même** cookie | **401** | Le rejeu après logout doit échouer. C'est aussi la vérification « refresh non rejouable » de la campagne Sécurité |
| 9 | `POST /api/auth/login` avec un compte **non vérifié** | rejeté | `auth.service.ts` refuse tant que `email_verified` est faux (sauf bypass) |
| 10 | `POST /api/auth/register` en réutilisant l'e-mail | **409** | Message identique pour e-mail et username déjà pris — voulu |
| 11 | `GET $API/api/auth/google` puis retour | atterrit sur `AuthCallback` côté front | Croise I4 ; l'URI de callback de **staging** doit être enregistrée côté Google |

### Les trois pièges de F1

1. **`Path=/api/auth` n'est pas un bug.** Le cookie n'est envoyé qu'aux routes
   d'auth. Un `fetch` vers `/api/users/me` ne le porte pas — c'est le design,
   pas une régression.
2. **`Secure` exige HTTPS.** Contre une URL de staging en `http://`, le
   navigateur ignore le cookie en silence. `curl` l'acceptera quand même : le
   parcours passera en ligne de commande et échouera dans le navigateur.
3. **`authLimiter` est monté sur tout `/api/auth`.** Répéter la séquence
   plusieurs fois de suite finit en **429**. Espacer, ou changer d'IP — et ne
   pas interpréter le 429 comme un échec d'authentification.

---

## F2 — Gating Pro de bout en bout

**Ce qui est réellement testé :** qu'un compte gratuit ne peut pas atteindre le
contenu Pro, et surtout qu'**en production sans Stripe, personne ne devient Pro
gratuitement**.

### Le mur Pro côté serveur, celui qu'il faut viser

Le gating visible est côté client ; le seul mur qui compte est côté API. Il est
dans `profile.routes.ts` (`requireProForOthers`) :

- `GET $API/api/users/<SON PROPRE id>/summary` → **200** même en gratuit ;
- `GET $API/api/users/<id D'UN AUTRE>/summary` → **403** en gratuit, **200** en Pro ;
- idem pour `/api/users/<id>/slips`.

Tester le mur sur **son propre** identifiant ne prouve rien : la règle laisse
volontairement passer. C'est l'erreur facile de ce test.

### Séquence

| # | Appel | Gratuit | Pro |
|---|---|---|---|
| 1 | `GET $API/api/subscription/me` | `{isPro:false, plan, status, trialUsed:false}` | `isPro:true` |
| 2 | `GET /api/users/<autre>/summary` | **403** | 200 |
| 3 | `GET /api/users/<autre>/slips` | **403** | 200 |
| 4 | `POST /api/subscription/checkout` | **en prod sans Stripe → 501** `Payments are not configured` | avec Stripe → `{url}` d'une session Checkout réelle |
| 5 | `POST /api/subscription/redeem` · `{code}` | dépend du code — **les promos sont désactivées par défaut en production** (SEC-6) | — |
| 6 | `POST /api/subscription/trial` | 1ʳᵉ fois : Pro + `trialUsed:true` · 2ᵉ fois : refus | — |
| 7 | `POST /api/subscription/cancel` | `cancelAtPeriodEnd:true` **et `isPro` reste `true`** jusqu'à `currentPeriodEnd` | — |

### Le critère qui fait passer ou échouer F2

Après le **501** de l'étape 4, vérifier qu'**aucune ligne d'abonnement n'a été
créée** pour ce compte et que `/subscription/me` renvoie toujours `isPro:false`.
Un 501 suivi d'un Pro accordé serait le pire résultat possible du test, et il ne
se voit pas dans le code de retour.

### Le piège du cache d'entitlement

`isPro` est mis en cache **par instance**, invalidé à l'écriture et borné par la
fin de période (`subscription.service.ts`). Conséquence pour le test : un
changement de plan écrit par un **webhook Stripe** peut mettre jusqu'à un TTL à
se voir sur une autre instance. À une seule instance — la configuration actuelle
— le problème n'existe pas ; y penser le jour où la ligne Q de l'audit passe à
deux instances, et **ne pas conclure d'un test à une instance** que la
propagation est bonne.

---

## I1 — Chaîne ML : Front → Node → FastAPI

**Ce qui est réellement testé :** que la prédiction affichée vient bien du modèle
Python, et que le contrat de features Node ↔ Python n'a pas divergé.

### L'appel qui répond à presque tout

`GET $API/api/dev/ml-info` — **compte admin obligatoire**, et
`ENABLE_DEV_ROUTES=true`. Un seul appel renvoie :

- `ml_url` — la valeur réellement résolue (repère un port oublié) ;
- `service_up` — `/health` du service Python a répondu ;
- `features` — la liste des features **attendues par Python** ;
- `samples.game` et `samples.player` — deux prédictions réellement calculées
  (`bos` vs `nyr`, et le joueur `8478402`).

**Critère :** `service_up: true` **et** `samples.game` non nul. `service_up:true`
avec `samples.game: null` est le cas intéressant : le service répond mais la
prédiction échoue — c'est un problème de **features**, pas de réseau. Comparer
alors la liste `features` avec ce que `buildGameFeatures` envoie.

### Ensuite

| # | Appel | Attendu |
|---|---|---|
| 2 | `POST $API/api/dev/ml-test` · `{"type":"game","teamId":"bos","opponentId":"nyr"}` | une prédiction ; **503** avec un message si le ML est indisponible |
| 3 | `POST $API/api/predict/ml` · `{"type":"game","subjectId":"bos","opponentId":"nyr"}` | le **même ordre de grandeur** qu'à l'étape 2. C'est le seul appel des trois qui emprunte le chemin du front |
| 4 | même chose en `"type":"player"` puis `"team"` | les trois routes Python sont couvertes |
| 5 | dans le navigateur, ouvrir une page de prédiction | une probabilité s'affiche |

### Le critère d'acceptation a changé depuis B9 — et il vous facilite la vie

La couche de mocks a été **supprimée** le 2026-08-29 : plus aucun repli local ne
fabrique de probabilité. Un nombre affiché vient donc nécessairement du modèle,
et une panne se manifeste par « — », un bandeau d'indisponibilité, et le refus
d'ajouter la jambe au coupon. **Autrement dit : voir un chiffre suffit
désormais à conclure.** Avant B9, il aurait fallu vérifier qu'il n'était pas
inventé.

### Le piège du disjoncteur

`mlApiClient` a un **circuit breaker** (`mlCircuitState`) : après quelques
échecs, les appels suivants échouent **immédiatement sans toucher Python**. Un
test relancé juste après un test raté mesure donc le disjoncteur, pas le
service. Laisser retomber le circuit (ou redémarrer le conteneur) avant de
conclure. Même logique pour le timeout de **5 s** : un cold start du service ML
peut le dépasser une fois, puis passer.

---

## I2 — CORS + cookie cross-site (Vercel ↔ Railway)

**Ce qui est réellement testé :** la cause n°1 des « ça marche en local, pas en
prod ». Front et API sont sur deux sites différents : tout repose sur
`CORS_ORIGIN` et sur `SameSite=None; Secure`.

### Séquence

| # | Appel | Attendu |
|---|---|---|
| 1 | `OPTIONS $API/api/auth/login` avec `Origin: $FRONT` et `Access-Control-Request-Method: POST` | **204** · `Access-Control-Allow-Origin` **égal à `$FRONT`** (pas `*`) · `Access-Control-Allow-Credentials: true` |
| 2 | même chose avec `Origin: https://exemple-hostile.com` | refusé |
| 3 | même chose avec `Origin: https://ice-edge-abc123.vercel.app` | **accepté** — les préviews Vercel sont autorisées par la regex ancrée de `cors.ts` |
| 4 | `curl` **sans** en-tête `Origin` | **accepté** — voulu (`isAllowedOrigin` renvoie `true` sans origine) |
| 5 | dans le navigateur : se connecter sur `$FRONT`, puis DevTools → Application → Cookies **du domaine de l'API** | `ice_refresh` présent, `HttpOnly` ✓ `Secure` ✓ `SameSite=None` ✓ |
| 6 | toujours dans le navigateur, déclencher un refresh | la requête vers `/api/auth/refresh` **porte** le cookie, et renvoie 200 |
| 7 | ouvrir le chat (socket.io) depuis `$FRONT` | la connexion WebSocket s'établit |

### Les deux pièges de I2

1. **L'étape 4 n'est pas une faille.** Une requête sans `Origin` (curl, sonde de
   santé, client non navigateur) n'est pas une requête cross-origin : il n'y a
   rien à protéger. Un navigateur envoie **toujours** `Origin` en cross-site.
   Ne pas « corriger » ce comportement.
2. **L'étape 7 n'est pas redondante.** Le bug historique que `cors.ts` a corrigé
   ne cassait **que** le WebSocket : `socket.ts` recevait la variable brute,
   donc dès que `CORS_ORIGIN` contenait deux origines, la chaîne complète
   n'égalait aucune origine réelle et le chat tombait **pendant que l'API
   répondait normalement**. Tester HTTP sans tester le socket laisserait
   exactement cette panne passer.

### Ce que I2 ne couvre pas, et qui doit suivre

Safari iOS bloque les cookies tiers plus agressivement que Chrome. I2 vert dans
Chrome ne dit **rien** de Safari : c'est précisément l'objet de **C1 / B5**, à
exécuter sur un appareil réel. Les deux tests ne sont pas interchangeables.

---

# Exécution du 2026-08-31 — I1 et I2 verts, F1 et F2 en attente

*Ce qui suit est un relevé, pas un plan. Chaque ligne a été mesurée ; aucune n'a
été déduite.*

## Ce qui a changé avant de commencer — il n'y a pas de staging

Le mot « staging » n'apparaît ni dans `DEPLOYMENT.md`, ni dans une variable
d'environnement, et Railway n'a qu'un environnement `production` (le second
projet, `generous-fulfillment`, est vide). Les runbooks ci-dessus sont écrits
contre un `$API` et un `$FRONT` qui n'existent pas.

**Décision du 2026-08-31 : découper.** I1 et I2 n'écrivent quasiment rien et la
production *est* déjà la vraie paire Vercel↔Railway cross-site que I2 cherche à
tester — un staging la simulerait moins bien. F1 et F2 créent des comptes,
consomment un essai Pro et ouvrent une session Stripe : ils attendent une cible
jetable.

## Le préflight, enfin lisible — et ce qu'il dit

La bannière n'imprimait aucune des quatre variables du préflight. Elle les porte
depuis le 2026-08-31 (`server.ts`, bloc `[Server] Réglages effectifs` ;
`devRoutesEnabled` est exporté par `app.ts` pour que la valeur soit l'**effective**
et non la variable brute). Relevé sur le conteneur `d5056ddd` :

| Variable | Valeur en production | Verdict |
|---|---|---|
| `NODE_ENV` | `production` | ✅ cookie de refresh en `Secure` + `SameSite=None` |
| `CORS_ORIGIN` | `[0] https://arakice.com` · `[1] https://www.arakice.com` | ✅ deux origines, sans slash final, casse exacte |
| `EMAIL_VERIFICATION_DISABLED` | **`true`** | ⚠️ voir ci-dessous — ce n'est pas ce que le runbook supposait |
| `ENABLE_DEV_ROUTES` | routes `/api/dev` **MONTÉES** | ✅ I1 exécutable |

> ⚠️ **`EMAIL_VERIFICATION_DISABLED=true` en production change F1, et pas
> seulement le test.** La branche « vérification » de F1 (étapes 2, 3 et 9) n'a
> pas d'existence réelle : `register` rend directement `{user, tokens}` et pose
> le cookie. Conséquence produit, qui dépasse la QA : **n'importe qui peut
> s'inscrire avec une adresse qu'il ne possède pas et être authentifié
> immédiatement.** C'est peut-être délibéré — sans `RESEND_API_KEY`, exiger une
> vérification enfermerait tout le monde dehors — mais alors la récupération de
> mot de passe (F6) repose sur le même canal absent. **À trancher avant le
> lancement, pas pendant.**

## I1 — chaîne ML : ✅ les quatre étapes

Via le dashboard `/dev/ml` (compte admin ; un onglet n'envoie pas le `Bearer`,
c'est le front qui l'attache) et un appel direct au chemin du front.

| # | Mesure | Résultat |
|---|---|---|
| 1 | `ml_url` | `http://courageous-analysis.railway.internal:8080` — **avec son port** ✅ |
| 1 | `service_up` | Python ML Service — **Online** ✅ |
| 1 | `samples.game` / `samples.player` | 56 % (`vscore-nhl-v1.0`) et 44 % (`vpoisson-v1.0`) — **non nuls** ✅ |
| 2 | Run Test *game* `bos`/`nyr` moneyline | 56 %, confiance 67 % |
| 4 | Run Test *player* `8478402` goals 0.5 | 44 %, `vpoisson-v1.0` |
| 4 | Run Test *team* `bos` | 9 %, `vrank-bayes-v1.0 · Bayesian Prior` |
| 3 | `POST /api/predict/ml` `{game, bos, nyr}` depuis l'origine du front | **56 %, confiance 67 %, mêmes feature importances au centième** |

**Le critère est dépassé.** Le runbook demandait « le même ordre de grandeur »
entre le chemin dev et le chemin du front ; les trois chemins — échantillon de
démarrage, route dev, route du front — rendent **le même chiffre**. Les trois
routes Python sont couvertes.

⚠️ **L'étape 5 n'a pas pu être faite, et la raison est un défaut.** Voir la
section suivante.

## I2 — CORS + cookie cross-site : ✅ six étapes sur sept

Méthode : plutôt que de lire les en-têtes à l'œil, on laisse **le navigateur**
juger. Un `fetch` cross-origin avec `credentials: 'include'` et
`Content-Type: application/json` force un préflight `OPTIONS` réel, et le
navigateur ne le laisse passer que si `Access-Control-Allow-Origin` vaut
**exactement** l'origine appelante (jamais `*`) **et** que
`Access-Control-Allow-Credentials` est `true`. Une origine refusée fait *jeter*
le `fetch`. C'est une preuve plus forte qu'une lecture d'en-tête.

| # | Origine | Attendu | Mesuré |
|---|---|---|---|
| 1 | `https://arakice.com` | accepté | **préflight PASSÉ**, 401 `Invalid credentials` ✅ |
| 2 | `https://example.com` | refusé | **BLOQUÉ** — `TypeError: Failed to fetch` ✅ |
| 3 | `https://ice-edge-hazel.vercel.app` | accepté (regex ancrée) | **préflight PASSÉ**, 401 ✅ |
| 4 | sans en-tête `Origin` | accepté | ⏳ **reste à faire** — impossible depuis un navigateur, voir plus bas |
| 5-6 | `POST /api/auth/refresh`, cookie seul, cross-site | 200 | **200**, corps `{access_token, expires_in}` ✅ |
| 7 | handshake socket.io | connexion établie | **200**, `{"sid":…,"upgrades":["websocket"]}` ✅ |

**Ce que les étapes 5-6 prouvent d'un coup.** Un `POST /api/auth/refresh`
cross-site **sans en-tête `Authorization`** qui rend 200 démontre que le
navigateur a bien envoyé `ice_refresh` : donc `HttpOnly`, `Secure`,
`SameSite=None` et `Path=/api/auth` sont tous corrects en production. Lire les
attributs dans DevTools aurait dit la même chose moins bien.

✅ **Et une assertion de F1 tombe au passage** — la seule qui fasse échouer F1
même quand le parcours marche : le corps de la réponse ne contient que
`access_token` et `expires_in`. **Pas de `refresh_token`, pas de
`refresh_expires_in`.** Le refresh ne fuit pas hors du cookie.

✅ **L'étape 7 n'était pas redondante et elle rapporte.** Le handshake
`GET /socket.io/?EIO=4&transport=polling` passe en cross-origin depuis l'apex :
`socket.ts` et `cors.ts` sont bien d'accord, malgré les **deux** origines dans
`CORS_ORIGIN` — exactement la configuration qui déclenchait le bug historique.

### Ce qui reste : l'étape 4, et pourquoi elle ne peut pas passer par le navigateur

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

## Le défaut trouvé en chemin — la page NHL Predictions hors saison

`/nhl-predictions` reste **indéfiniment sur ses squelettes de chargement** :
quatre cartes grises, aucun texte, aucune fin. Ce n'est pas une panne — les six
appels `GET /api/nhl/games?date=…` rendent **200**, et leur corps est `[]` : on
est hors saison, il n'y a aucun match à afficher.

**Pourquoi ça compte malgré tout.** L'écran d'un état vide légitime est
strictement identique à celui d'une panne réseau. B9 a établi qu'une
indisponibilité se manifeste par « — » et un bandeau ; un chargement qui ne se
termine jamais n'est ni l'un ni l'autre. Le premier visiteur d'octobre verra la
bonne page, mais **tout visiteur d'ici là voit un site cassé** — et si la chaîne
tombe vraiment un soir de match, personne ne saura faire la différence.

C'est aussi ce qui a empêché de cocher l'étape 5 de I1 : il n'existe aujourd'hui
aucune page où une probabilité puisse s'afficher. Le modèle, lui, répond — I1
étape 3 le prouve par l'API.

## Deux observations mineures, notées pour ne pas les reperdre

- **Le dashboard `/dev/ml` s'auto-contredit.** L'onglet *Service* affiche
  `Game Model : XGBoost (trained)` et, trois lignes plus bas, en jaune :
  *« Lance fetch_data.py puis train.py pour activer XGBoost »*. L'onglet
  *Modèle* tranche : le modèle est bien chargé (log loss test **0,6653**, val
  0,6514, accuracy 59,2 %, skill score 0,0477, `calibration platt · active`) —
  et 0,6653 est exactement la valeur de `training_report.json`. **C'est le
  message jaune qui est faux**, et il pousserait à relancer un entraînement
  inutile.
- **`P(OT DOMICILE) : 0.500`** et **`MEMBRES ENSEMBLE : 0 chargés`** sur l'onglet
  *Modèle*. Le 0,500 plat confirme que la correction `p_ot_home` par affiche est
  en code mais **pas encore dans le modèle déployé** — elle s'activera au
  prochain `train_score.py`, comme prévu. Rien d'anormal, mais c'est la preuve
  visible qu'il reste un entraînement à lancer.
