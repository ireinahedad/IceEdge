# ICEEDGE — Plan de finalisation

_Analyse d'écart : ce qui manque pour que l'app tourne, et ce qui reste à implémenter pour la rendre pleinement fonctionnelle._

Dernière mise à jour : 2026-07-04

---

## Résumé en une phrase

L'ossature est complète et fonctionne (auth, NHL live, prédictions règles + ML entraîné, chat temps réel, slips, best-bets). Ce qui manque n'est pas l'architecture mais **le câblage de bout en bout, quelques fonctionnalités inachevées, la qualité du modèle, et le déploiement.**

---

## Ce qui marche déjà (vérifié dans le code)

- **App shell** : React Router, contextes Auth/Bet/Sport, BottomNav, i18n EN/FR.
- **Auth** : email/password + Google OAuth, JWT.
- **Données NHL** : client API live (`api-web.nhle.com`) + fallback mock (`NHL_USE_MOCK`).
- **Moteur de prédiction** : règles (Log5, Poisson) sur tous les marchés + **modèle XGBoost entraîné** (`game_model.json`, `totals_model.json` présents).
- **Best Bets** : endpoint `GET /api/predict/best-bets` (tous marchés, tri par score, ML-first) + section repliable côté accueil.
- **Chat/Ligue** : rooms PostgreSQL + Socket.io temps réel.
- **Slips** : soumission, historique, résolution manuelle + XP/tiers/badges.
- **Backend** : toutes les routes montées, 404 + error handler globaux présents.

---

## P0 — Bloquant : faire tourner l'app localement

_Sans ça, rien ne s'affiche. C'est surtout de la config, pas du code._

1. **Base de données** — créer + peupler : `npm run db:migrate`, `npm run db:migrate:slips`, `npm run seed`. Vérifier que `server/.env` pointe sur `IceedgeDB` et que PostgreSQL tourne.
2. **Lancer les 3 services en parallèle** : client (`:5173`), server Node (`:3001`), service ML Python (`:8000`). L'app dégrade proprement si le ML est down, mais pour tout voir il faut les trois.
3. **Clés d'API** : `VITE_ODDS_API_KEY` (cotes Bet365) et `RAPIDAPI_KEY` (tennis) sont requises pour ces sections — sinon fallback/erreur silencieuse. Elles sont présentes dans tes `.env`, à valider.
4. **Corriger `seed.ts`** : la ligne 359 contient des caractères parasites (une longue série d'espaces invalides) qui font échouer `tsc`. À nettoyer.

**Effort : ~1–2 h, surtout de la vérification.**

---

## P1 — Fonctionnalités incomplètes (pour que ce soit *correct*)

1. **Règlement automatique des slips** — aujourd'hui les slips ne se règlent que si l'utilisateur clique « Vérifier les résultats » (`POST /api/slips/settle`). Il manque un déclencheur automatique (cron / `setInterval` au démarrage du serveur) qui règle les slips en attente quand les matchs se terminent. _Effort : ½ journée._
2. **Refresh tokens** — la table `refresh_tokens` existe et `JWT_REFRESH_SECRET` est référencé, mais il manque dans `server/.env` et le flux de rafraîchissement semble incomplet. À finir sinon les sessions expirent sans renouvellement. _Effort : ½ journée._
3. **Qualité du modèle ML** — le modèle est entraîné mais **sans réel pouvoir prédictif** : précision 0.549 vs taux de victoire domicile 0.540 (skill score ≈ 0.006). Il « fonctionne » techniquement mais n'apporte pas d'edge. Pistes : plus de features (blessures, gardien partant, repos), plus de saisons, calibration. _Effort : 1–3 jours, itératif._
4. **ML Tennis** — le service Python ne gère pas vraiment le tennis ; `/predict/ml` mappe le tennis sur le modèle joueur de hockey via des heuristiques de surface. À remplacer par un vrai modèle ou à assumer comme « règles seulement ». _Effort : variable._
5. **`bet_slips` vides au départ** — normal (données réelles), mais pour une démo, ajouter un `seedBetSlips()` optionnel. _Effort : 1 h._

---

## P2 — Reste à implémenter (features prévues, non commencées)

1. **Partage de slip** — bouton share après soumission, `SharePage`, `navigator.share()`. La route front existe en placeholder (`share.*` dans i18n). _Effort : ½ journée._
2. **EV / Opportunities (frontend)** — le calcul d'Expected Value existe côté serveur (`ev.service.ts`) mais aucune page ne l'expose. Construire l'écran qui liste les paris à valeur positive. _Effort : 1 journée._
3. **PWA** — manifest, service worker, icônes, installation « add to home screen » (l'app est mobile-first, c'est le cas d'usage naturel). _Effort : ½ journée._
4. **Error boundaries React** + page 404 côté frontend (le 404 backend existe déjà). _Effort : 2–3 h._

---

## P3 — Dette technique / nettoyage

1. **Supprimer les fichiers NestJS morts** — `server/src/main.ts`, `app.module.ts`, `app.controller.ts`, `app.service.ts`, `app.controller.spec.ts` : ce sont des restes de scaffolding NestJS, l'app tourne en réalité via `server.ts` + `app.ts` (Express). Ils sèment la confusion. _Effort : 15 min._
2. **Tests** — quasi inexistants (un seul spec vide). Ajouter des tests sur le moteur de prédiction (Log5/Poisson déterministes, faciles à tester) et les routes critiques. _Effort : itératif._
3. **Splitter `PredictionPage.tsx`** — trop long, à découper. _Effort : 2–3 h._

---

## P4 — Déploiement (mise en production)

Les fichiers existent déjà (`server/Dockerfile`, `ml/python/Dockerfile`, `client/vercel.json`, `.env.production`, `DEPLOYMENT.md`). Reste à exécuter :

1. **DB** → Supabase (ou Railway Postgres) : migrer le schéma, configurer `DATABASE_URL`.
2. **Backend + ML** → Railway (2 services). Attention aux origines CORS et à `ML_SERVICE_URL`.
3. **Frontend** → Vercel : variables `VITE_*` de prod pointant sur le backend Railway.
4. **Google OAuth** → ajouter les URLs de callback de prod dans la console Google Cloud.
5. **Checklist** : HTTPS, secrets JWT forts, rate-limiting, logs.

**Effort : 1 journée si tout se passe bien.**

---

## Ordre recommandé

1. **P0** (config + faire tourner) → tu vois l'app complète en local.
2. **P1.1 + P1.2** (auto-settlement + refresh tokens) → le cœur « paris » devient fiable.
3. **P2.1 + P2.2** (Share + EV) → valeur produit visible.
4. **P3.1** (nettoyage NestJS) → base saine.
5. **P4** (déploiement) → mise en ligne.
6. **P1.3** (qualité ML) → amélioration continue, en parallèle.

---

## Estimation globale

Pour une v1 **fonctionnelle et déployée** (P0 → P2 + P4, en laissant le ML « tel quel ») : **environ 4 à 6 jours de travail**. La montée en qualité du modèle ML est un chantier à part, itératif.
