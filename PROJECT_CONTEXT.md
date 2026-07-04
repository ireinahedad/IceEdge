# PROJECT_CONTEXT.md

---

# CLAUDE_INSTRUCTIONS

When continuing this project:
- Read this file before generating any code.
- Never rewrite working code unless requested.
- Reuse existing architecture.
- Prefer modifying existing files over creating new ones.
- Explain major architectural changes before implementing them.
- If information is missing, ask instead of assuming.
- Keep code clean, modular, and production-ready.
- At the end of each session, update PROJECT_CONTEXT.md.

Last updated: 2026-07-04

## Session 2026-07-04 — P1 terminés

1. **Règlement auto des slips** (`settlement.service.ts`) : job événementiel — toutes les 2 min, SQL léger sur les gameIds des slips pending, poll du statut de CES matchs seulement, règlement dès qu'un match passe FINAL. Fallback complet toutes les 60 min + passe de rattrapage 30 s après boot. Aucune requête API quand rien n'est en attente.
2. **Refresh tokens → cookie httpOnly** : cookie `ice_refresh` (httpOnly, sameSite=lax, path=/api/auth, 7 j, secure en prod). Rotation à chaque refresh (déjà en DB). Le refresh token ne transite plus ni dans le JSON, ni dans localStorage, ni dans l'URL du callback Google. Ajouts : `cookie-parser` (package.json), CORS `credentials:true`, client en `credentials:'include'` (authService, AuthContext, AuthCallback). **⚠️ `npm install` requis dans server/.**
3. **ML v3** : features ELO (base 1500, K=6, avantage glace 50, régression 30 % inter-saisons, multiplicateur marge) calculées dans `train.py` sans leakage + `elo_ratings.json` pour l'inférence ; split temporel 3 voies (train/val/test) — early stopping et calibration de Platt sur val, test vierge ; baselines honnêtes dans `training_report.json`. `ml_service.py` charge ELO + calibration, `featureEngineering.ts` envoie `home_team`/`away_team`. **⚠️ Relancer `fetch_data.py` (CSV local incomplet : 726 matchs) puis `train.py`.**
4. Fixes : `seed.ts` (6701 octets NUL supprimés → tsc OK), `main.ts` exclu du tsconfig (vestige NestJS, import inexistant), cast `openAiRes` dans `llm.routes.ts`. `tsc --noEmit` passe.

---

# Project Overview

## Goal

**ICEEDGE** — Application mobile-first de prédictions sportives (NHL + Tennis).
Permet aux utilisateurs de consulter des prédictions basées sur des règles statistiques et un modèle ML (XGBoost), de construire des slips de paris, de rejoindre des ligues avec chat en temps réel, et de suivre leur performance.

## Tech Stack

- **Frontend:** React 18 + Vite + TypeScript + Tailwind CSS (mobile-first, `max-w-[430px]`)
- **Backend:** Node.js + Express + TypeScript (`ts-node-dev`)
- **Database:** PostgreSQL (`IceedgeDB` sur `localhost:5432`)
- **Authentication:** JWT (localStorage) + Google OAuth
- **Real-time:** Socket.io (WebSocket pour le chat)
- **ML Service:** Python 3.14 + FastAPI + XGBoost (port 8000, processus séparé)
- **API externe:** NHL Stats API (`api-web.nhle.com/v1`), RapidAPI Tennis, The Odds API (Bet365)
- **Hosting:** Local dev — pas encore déployé

---

# Architecture

## Folder Structure

```
ICEEDGE/
├── client/                        # React frontend (Vite)
│   ├── src/app/
│   │   ├── App.tsx                # Root: providers + AppShell
│   │   ├── routes.tsx             # React Router (11 routes)
│   │   ├── context/
│   │   │   ├── AuthContext.tsx    # JWT auth state
│   │   │   ├── BetContext.tsx     # Legs + parlay probability
│   │   │   └── SportContext.tsx   # Hockey/Tennis toggle + thème
│   │   ├── components/
│   │   │   ├── HockeyLanding.tsx
│   │   │   ├── StatsPage.tsx
│   │   │   ├── TennisStatsPage.tsx
│   │   │   ├── PlayersTab.tsx
│   │   │   ├── PredictionPage.tsx
│   │   │   ├── BetBuilderPage.tsx
│   │   │   ├── MarketSelectorSheet.tsx
│   │   │   ├── NHLPredictionsPage.tsx
│   │   │   ├── MLPredictionCard.tsx   # ← composant ML réutilisable
│   │   │   ├── LoginPage.tsx
│   │   │   ├── AuthCallback.tsx
│   │   │   ├── BottomNav.tsx
│   │   │   ├── league/
│   │   │   │   ├── LeaguePage.tsx
│   │   │   │   └── chat/ChatTab.tsx
│   │   │   └── profile/
│   │   │       ├── ProfilePage.tsx
│   │   │       └── ProfileComponents.tsx
│   │   ├── hooks/
│   │   │   └── useChatSocket.ts   # Socket.io client hook
│   │   ├── services/
│   │   │   ├── nhlApiService.ts
│   │   │   ├── predictionApiService.ts
│   │   │   ├── slipApiService.ts
│   │   │   ├── oddsApiService.ts
│   │   │   ├── authService.ts
│   │   │   └── affiliateService.ts
│   │   └── data/
│   │       ├── betMarkets.ts      # Définitions des 40+ marchés
│   │       └── teamEmoji.ts
│   └── .env                       # Variables Vite
├── server/                        # Express backend
│   └── src/
│       ├── server.ts              # HTTP + WebSocket entry
│       ├── app.ts                 # Express routes mounting
│       ├── socket.ts              # Socket.io singleton
│       ├── routes/
│       │   ├── auth.routes.ts
│       │   ├── nhl.route.ts
│       │   ├── ml.routes.ts       # /api/predict/* (règles + proxy ML)
│       │   ├── chat.routes.ts
│       │   ├── slip.routes.ts
│       │   ├── profile.routes.ts
│       │   ├── tennis.route.ts
│       │   └── odds.route.ts
│       ├── services/
│       │   ├── predictionEngine.ts    # Log5, Poisson, futures
│       │   ├── featureEngineering.ts  # NHL API → vecteurs de features
│       │   ├── mlApiClient.ts         # HTTP bridge → Python :8000
│       │   ├── nhlApiClient.ts        # NHL public API client
│       │   └── ...
│       └── db/
│           ├── schema.sql
│           └── connection.ts
└── ml/                            # Service Python ML
    ├── python/
    │   ├── ml_service.py          # FastAPI :8000 (règles + XGBoost si .json dispo)
    │   ├── fetch_data.py          # Collecte NHL API historique → data/nhl_games.csv
    │   ├── train.py               # Pipeline XGBoost → models/*.json
    │   └── requirements.txt
    ├── data/
    │   └── nhl_games.csv          # ~3600 matchs (généré par fetch_data.py)
    └── models/
        ├── game_model.json        # XGBoost moneyline (si entraîné)
        ├── totals_model.json      # XGBoost total de buts (si entraîné)
        └── training_report.json
```

## Important Files

| Fichier | Rôle |
|---------|------|
| `client/src/app/components/MLPredictionCard.tsx` | Composant ML réutilisable + `MLSection` auto-fetch |
| `client/src/app/hooks/useChatSocket.ts` | Hook Socket.io chat temps réel |
| `server/src/services/predictionEngine.ts` | Math règle-based (Log5, Poisson) |
| `server/src/services/featureEngineering.ts` | Convertit stats NHL en vecteurs pour Python |
| `server/src/services/mlApiClient.ts` | Proxy HTTP Node.js → Python :8000 |
| `server/src/routes/ml.routes.ts` | `/api/predict/*` — dispatch règles + ML |
| `server/src/socket.ts` | Socket.io singleton + gestion des rooms |
| `ml/python/ml_service.py` | FastAPI ML — charge XGBoost si .json dispo, sinon fallback LR |
| `ml/python/fetch_data.py` | Collecte 3 saisons de matchs NHL via `api-web.nhle.com` |
| `ml/python/train.py` | Entraîne XGBoost (sans scikit-learn) — Python 3.14 compatible |

---

# Coding Standards

- **Naming:** PascalCase composants, camelCase variables/functions, kebab-case fichiers de routes
- **Composants:** Functional components + hooks uniquement. Pas de classes.
- **Style:** Tailwind uniquement. Classes inline. Pas de CSS séparé.
- **Mobile-first:** Tous les layouts dans `max-w-[430px]`. Pas de breakpoints desktop.
- **Couleurs:** Background `#0a1014`, cards `#111a1f`, accent dynamique via `SportContext`
- **State:** React Context pour état global (Auth, Bet, Sport). `useState` local pour UI.
- **API calls:** Services dédiés dans `client/src/app/services/`. Jamais de `fetch` direct dans les composants sauf `MLSection`.
- **Erreurs:** Fallback silencieux côté frontend (ML down → `null`, API down → mock data)
- **Backend routes:** `async/await` + try/catch + `res.status(xxx).json()`
- **TypeScript:** Strict. Interfaces définies pour toutes les shapes d'API.

---

# Features

## ✅ Complétées

- **App shell** — React Router 11 routes, SportContext, AuthContext, BetContext, BottomNav
- **Auth** — Email/password + Google OAuth, JWT localStorage, `returnTo` param
- **Home** — HockeyLanding avec matchs en direct, odds Bet365, switcher hockey/tennis
- **Stats Hockey** — By Team, By Game, By Player, By Form (LastNGames)
- **Stats Tennis** — By Player, By Match, By Surface, By Tournament
- **Prediction Page** — 6 types: team, game, player, ngames, future, tennis-player
- **Bet Builder** — Legs, parlay gauge, odds labels américains, confirmation clear, auth gate
- **Slip resolve** — PATCH /api/slips/:id/resolve → XP badge
- **League/Chat** — Rooms PostgreSQL + Socket.io temps réel + compteur online
- **NHLPredictionsPage** — 40+ marchés bet365, game pills horizontaux (pas de form vide)
- **Prediction Backend** — Log5, Poisson, futures règle-based, tous les marchés
- **ML Pipeline** — FastAPI Python, featureEngineering TS, proxy Node.js, `MLSection` UI
- **MLPredictionCard** — Violet card avec gauge, feature importances, comparaison règles vs ML
- **ML sur toutes les pages** — PredictionPage (6 handlers) + NHLPredictionsPage (BetPredictionCard)
- **XGBoost training** — fetch_data.py (NHL API historique) + train.py (sans scikit-learn)

## 🚧 En cours

### ML Frontend Connection
Problème actuel : `MLSection` affiche une erreur rouge "ML indisponible" quand le service Python retourne une erreur.

Étapes pour déboguer :
1. S'assurer que Python service tourne : `cd ml/python && python ml_service.py`
2. Tester : `curl -X POST http://localhost:8000/health`
3. Vérifier `F12 → Console` dans le navigateur pour le message exact de `[MLSection] fetch failed:`
4. Vérifier que le Node.js (`npm run dev` dans `server/`) tourne aussi

Erreurs déjà corrigées :
- `pk_pct` validé à 0 par Pydantic → `|| 80` dans featureEngineering.ts + `ge=0` dans Pydantic
- `KeyError: 'moneyline'` dans predict_team → `.get(f.prop_type, f.prop_type)`

## 📋 Todo

### High
- Connecter ML au frontend (déboguer la chaîne frontend → Node.js → Python)
- Entraîner le modèle XGBoost : `python fetch_data.py --seasons 3 && python train.py`

### Medium
- **Section 6 — Share** : bouton share après submit slip, `SharePage`, `navigator.share()`
- **Section 7 — EV/Opportunities** : frontend pour `/api/opportunities` (backend existe)
- TennisPredictionsPage — ML section (type tennis pas géré dans Python ML)

### Low
- **Section 8 — Production** : variables d'env prod, PWA manifest, error boundaries, Google Analytics
- Splitter `PredictionPage.tsx` (trop long)
- 404 route

---

# API

## Base URL
`http://localhost:3001/api`

## Routes

### Auth
| Route | Description |
|-------|-------------|
| `POST /auth/login` | Email + password → JWT |
| `POST /auth/register` | Créer un compte |
| `GET /auth/google` | Redirect OAuth Google |
| `GET /auth/google/callback` | Callback OAuth → JWT |

### NHL
| Route | Description |
|-------|-------------|
| `GET /nhl/games` | Matchs du jour |
| `GET /nhl/games/live` | Matchs en direct |
| `GET /nhl/teams` | 32 équipes + standings |
| `GET /nhl/teams/:abbr/stats` | Stats d'une équipe |
| `GET /nhl/teams/:abbr/roster` | Roster complet |
| `GET /nhl/players` | Top 50 joueurs |
| `GET /nhl/players/:id` | Stats d'un joueur |

### Predictions
| Route | Description |
|-------|-------------|
| `POST /predict/single` | Probabilité règle-based pour un marché |
| `POST /predict/parlay` | Combinaison de legs |
| `POST /predict/factors` | Facteurs explicatifs |
| `POST /predict/player-prop` | Prop joueur saison |
| `POST /predict/futures` | Futures équipe |
| `POST /predict/ml` | **Proxy → Python :8000** (XGBoost ou fallback LR) |

### Chat / Social
| Route | Description |
|-------|-------------|
| `GET /chat/rooms` | Liste des rooms |
| `GET /chat/rooms/:id/messages` | Historique messages |
| `POST /chat/rooms/:id/messages` | Envoyer + emit Socket.io |
| `GET /users/leaderboard` | Classement XP |

### Slips
| Route | Description |
|-------|-------------|
| `POST /slips` | Soumettre un slip (JWT requis) |
| `GET /slips` | Historique user |
| `PATCH /slips/:id/resolve` | Marquer win/loss + XP |

## Python ML Service (port 8000)
| Route | Description |
|-------|-------------|
| `POST /predict/game` | Moneyline, puck-line, totaux |
| `POST /predict/player` | Props joueur |
| `POST /predict/team` | Futures équipe |
| `GET /health` | Status + modèles chargés |

---

# Database

`postgresql://postgres:mike1970@localhost:5432/IceedgeDB`

## Tables

```sql
users              -- id, email, password_hash, google_id, created_at
refresh_tokens     -- id, user_id, token, expires_at
user_profiles      -- user_id, display_name, avatar_url, xp, tier, streak
user_badges        -- user_id, badge_type, earned_at
user_bets          -- id, user_id, market_type, legs (JSON), probability, outcome, xp_earned
chat_rooms         -- id, name, sport, description, member_count
chat_messages      -- id, room_id, user_id, content, created_at
chat_reactions     -- id, message_id, user_id, emoji
nhl_teams          -- id, abbreviation, name, conference, division, ...
nhl_team_stats     -- team_id, season, wins, losses, goals_for, goals_against, ...
nhl_games          -- id, home_team_id, away_team_id, date, status, score_home, score_away
nhl_players        -- id, team_id, name, position, number
nhl_player_stats   -- player_id, season, goals, assists, points, shots, ...
nhl_odds           -- game_id, market, home_odds, away_odds, bookmaker
```

---

# Environment Variables

## `client/.env`
```
VITE_NHL_API_URL=http://localhost:3001/api/nhl
VITE_PROFILE_API_URL=http://localhost:3001/api
VITE_PREDICTION_API_URL=http://localhost:3001/api
VITE_SOCKET_URL=http://localhost:3001
VITE_ODDS_API_KEY=<the-odds-api-key>
VITE_BET365_AFFILIATE_CODE=365_XXXXXXX    # À remplacer par le vrai code
```

## `server/.env` (à créer si absent)
```
DATABASE_URL=postgresql://postgres:mike1970@localhost:5432/IceedgeDB
JWT_SECRET=<secret>
JWT_REFRESH_SECRET=<secret>
GOOGLE_CLIENT_ID=<id>
GOOGLE_CLIENT_SECRET=<secret>
GOOGLE_CALLBACK_URL=http://localhost:3001/api/auth/google/callback
CORS_ORIGIN=http://localhost:5173
ML_SERVICE_URL=http://localhost:8000
```

---

# Décisions architecturales

- **JWT dans localStorage** (pas de cookie httpOnly) — simplifie l'auth mobile PWA
- **Socket.io** pour le chat — évite le polling, messages instantanés
- **Python séparé pour le ML** (FastAPI :8000) — découplage, permet de déployer le ML indépendamment
- **Fallback systématique** — si API/ML down, le frontend ne casse pas (mock data, null components)
- **XGBoost natif** (format `.json`) sans scikit-learn — compatibilité Python 3.14
- **Split temporel** pour le train/test (par date) — évite le data leakage sur données sportives
- **`??` vs `||`** dans featureEngineering — utiliser `||` pour les champs numériques qui peuvent être `0` (ex: pkPct)
- **`ge=0`** dans les Pydantic models — ne pas contraindre des valeurs qui peuvent être 0 côté NHL API

---

# Known Bugs

- `MLSection` retourne `null` silencieusement si Python service down → maintenant montre un bandeau rouge avec le message d'erreur exact
- `pk_pct = 0` depuis NHL API déclenchait une erreur 422 Pydantic → corrigé dans featureEngineering.ts et ml_service.py
- `KeyError: 'moneyline'` dans `predict_team` quand `prop_type` n'est pas cup/conf/playoff → corrigé avec `.get()`
- `NHLPredictionsPage` montrait une page vide si aucun match sélectionné → remplacé le dropdown par des pills horizontaux avec auto-select

---

# Démarrage du projet

```bash
# 1. Frontend
cd ICEEDGE/client
npm run dev               # → http://localhost:5173

# 2. Backend Node.js
cd ICEEDGE/server
npm run dev               # → http://localhost:3001

# 3. Service ML Python
cd ICEEDGE/ml/python
python ml_service.py      # → http://localhost:8000

# 4. (Optionnel) Entraîner le modèle
python fetch_data.py --seasons 3   # ~8 min
python train.py                    # ~30 sec
# Redémarrer ml_service.py ensuite

# 5. Base de données
cd ICEEDGE/server
npm run db:migrate        # Crée les tables
npm run seed              # (optionnel) données de test
```

---

# Recent Changes

## 2026-06-30
- Créé `ml/python/fetch_data.py` — collecte NHL API historique (3 saisons, ~3600 matchs)
- Créé `ml/python/train.py` — XGBoost sans scikit-learn (Python 3.14 compatible), split temporel
- Mis à jour `ml/python/ml_service.py` — charge `game_model.json` + `totals_model.json` si disponibles
- Corrigé `featureEngineering.ts` — `|| 80` au lieu de `?? 80` pour pkPct (0 = données manquantes)
- Corrigé Pydantic — `ge=0` au lieu de `ge=50` pour pk_pct (validait `0` comme invalide)
- Corrigé `predict_team` — `KeyError: 'moneyline'` → `.get()` avec défaut
- `MLSection` — affiche maintenant l'erreur exacte (bandeau rouge) au lieu de `null` silencieux
- `NHLPredictionsPage` — remplacé dropdown `GameSelector` par pills horizontaux (plus de page vide)
- `BetPredictionCard` — branché `MLSection` sur chaque carte de marché (remplace placeholder "À venir")
- Créé fichiers de déploiement : `server/Dockerfile`, `ml/python/Dockerfile`, `client/vercel.json`, `client/.env.production`, `server/.env.example`
- Créé `DEPLOYMENT.md` — guide complet Supabase + Railway + Vercel (étapes, env vars, OAuth, checklist)

## Sessions précédentes
- Sections 1–5 complètes (voir PLAN.md pour détail)
- Section 3 : predictionEngine.ts (Log5, Poisson), featureEngineering.ts, mlApiClient.ts
- Section 4 : auth gate returnTo, odds labels américains, parlay implied odds, clear confirmation
- Section 5 : Socket.io chat temps réel (server/socket.ts + useChatSocket hook)
- ML : ml_service.py FastAPI, MLPredictionCard.tsx, MLSection intégré dans PredictionPage + NHLPredictionsPage

---

# Next Session Prompt

```
Contexte : Application ICEEDGE (mobile-first NHL prediction app).
Lire PROJECT_CONTEXT.md pour l'état complet du projet.

Objectif actuel :
1. Vérifier ML frontend : F12 → Console → "[MLSection] fetch failed:"
   - 3 services requis : client (:5173), server (:3001), ml (:8000)
2. Entraîner le modèle XGBoost si pas encore fait :
   cd ml/python && python fetch_data.py --seasons 3 && python train.py
3. Déploiement : suivre DEPLOYMENT.md (Supabase → Railway → Vercel)
4. Ensuite : Section 6 (Share feature) ou Section 7 (EV/Opportunities frontend)

Règles :
- Ne pas réécrire du code existant sauf si nécessaire
- Réutiliser les composants existants (MLSection, MLPredictionCard, etc.)
- Garder max-w-[430px] mobile-first
- Tout nouveau endpoint Python doit gérer pk_pct=0 (ge=0 dans Pydantic)
```

---

# Notes

- Le modèle ML utilise les **mêmes features** que `featureEngineering.ts` — si on ajoute une feature en Python, l'ajouter aussi côté TS
- La NHL API retourne parfois `pkPct = 0` quand les données ne sont pas encore disponibles en début de saison — toujours utiliser `|| defaultValue` (pas `??`) pour les champs numériques
- `scikit-learn` ne compile pas sur Python 3.14 — rester sur XGBoost natif + numpy/pandas
- Les modèles `.pkl` (joblib) ont été remplacés par `.json` (format natif XGBoost) pour la compatibilité Python 3.14
- Le split train/test se fait **par date** (temporel), pas aléatoirement — important pour éviter le data leakage en données sportives
