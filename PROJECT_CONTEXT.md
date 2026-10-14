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
- Verify that what you are implementing is secure
- At the end of each session, update `STATUS.md` (what remains) — and this file only if the
  architecture, conventions or setup changed. Session logs are not kept here: Git is the log
  (old logs: `git show 0916b52:PROJECT_CONTEXT.md`).

Last updated: 2026-10-04 (recalage de niveau des buts, plan de rattrapage des cotes)

# Project Overview

## Goal

**ICEEDGE** — Application mobile-first de prédictions sportives NHL.
(Le tennis a été retiré du produit le 2026-08-24 : pages, API et marchés supprimés.)
Permet aux utilisateurs de consulter des prédictions basées sur des règles statistiques et un modèle ML (XGBoost), de construire des slips de paris, de rejoindre des ligues avec chat en temps réel, et de suivre leur performance.

## Tech Stack

- **Frontend:** React 18 + Vite + TypeScript + Tailwind CSS (mobile-first, `max-w-[430px]`)
- **Backend:** Node.js + Express + TypeScript (`ts-node-dev`)
- **Database:** PostgreSQL (`IceedgeDB` sur `localhost:5432`)
- **Authentication:** JWT (localStorage) + Google OAuth
- **Real-time:** Socket.io (WebSocket pour le chat)
- **ML Service:** Python 3.14 + FastAPI + XGBoost (port 8000, processus séparé)
- **API externe:** NHL Stats API (`api-web.nhle.com/v1`), The Odds API (Bet365)
- **Hosting:** Production sur arakice.com — Vercel (front) + Railway (Node + ML Python) + Neon (PostgreSQL) + Cloudflare R2. Voir `DEPLOYMENT.md`

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
│   │   │   └── SportContext.tsx   # thème (mono-sport depuis le retrait du tennis)
│   │   ├── components/
│   │   │   ├── HockeyLanding.tsx
│   │   │   ├── StatsPage.tsx
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
│   │   │   └── bookmakers.ts        # Liens affiliés Bet365 / Stake
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
        ├── score_model.json       # Poisson empilé — price TOUS les marchés dérivés
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

# API

## Base URL
`http://localhost:3001/api`

## Routes

### Auth
| Route | Description |
|-------|-------------|
| `POST /auth/login` | Email + password (+ `remember`) → access token + cookie refresh |
| `POST /auth/register` | Créer un compte (vérif. email) |
| `POST /auth/refresh` | Rotation via cookie httpOnly `ice_refresh` |
| `POST /auth/logout` | Révoque le refresh token courant |
| `POST /auth/logout-all` | Révoque tous les refresh tokens de l'utilisateur (auth requise) |
| `GET /auth/google` | Redirect OAuth Google |
| `GET /auth/google/callback` | Callback OAuth → access token + cookie refresh |

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
| `GET /chat/rooms` | Salons publics + mes salons privés |
| `POST /chat/rooms` | Créer un salon (nom, icône, description, isPrivate, **color**) |
| `GET /chat/rooms/:id/messages` | Historique messages |
| `POST /chat/rooms/:id/messages` | Envoyer + emit Socket.io `new_message` |
| `DELETE /chat/rooms/:id/messages/:msgId` | Supprimer **son** message + emit `message_deleted` |
| `POST /chat/rooms/:id/join` · `/join` (code) · `/leave` · `/pin` | Adhésion / épinglage |
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

`postgresql://postgres:<DB_PASSWORD>@localhost:5432/IceedgeDB`

> ⚠️ Never commit real credentials to this file. Use a local `server/.env` (git-ignored). If a secret leaks: `STATUS.md` §6.

## Tables

```sql
users              -- id, email, password_hash, google_id, created_at
refresh_tokens     -- id, user_id, token, expires_at, revoked, remember, created_at
user_profiles      -- user_id, display_name, avatar_url, xp, tier, streak
user_badges        -- user_id, badge_type, earned_at
user_bets          -- id, user_id, market_type, legs (JSON), probability, outcome, xp_earned
chat_rooms         -- id, name, icon, description, color, is_private, join_code, created_by, member_count
chat_messages      -- id, room_id, user_id, username, display_name, avatar, tier, text, tag, reply_to_*, sent_at
chat_room_members  -- room_id, user_id, role (admin|member), pinned, joined_at
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
DATABASE_URL=postgresql://postgres:<DB_PASSWORD>@localhost:5432/IceedgeDB
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

- **Access token (15 min) en localStorage + refresh token en cookie httpOnly** (`ice_refresh`, path `/api/auth`, rotation à chaque refresh) — le refresh token ne transite jamais par JS/localStorage/URL (XSS-safe). Durée 7 j, ou 30 j avec « Rester connecté »
- **Socket.io** pour le chat — évite le polling, messages instantanés
- **Python séparé pour le ML** (FastAPI :8000) — découplage, permet de déployer le ML indépendamment
- **Fallback systématique** — si API/ML down, le frontend ne casse pas (mock data, null components)
- **XGBoost natif** (format `.json`) sans scikit-learn — compatibilité Python 3.14
- **Split temporel** pour le train/test (par date) — évite le data leakage sur données sportives
- **`??` vs `||`** dans featureEngineering — utiliser `||` pour les champs numériques qui peuvent être `0` (ex: pkPct)
- **`ge=0`** dans les Pydantic models — ne pas contraindre des valeurs qui peuvent être 0 côté NHL API

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

# Notes

- Le modèle ML utilise les **mêmes features** que `featureEngineering.ts` — si on ajoute une feature en Python, l'ajouter aussi côté TS
- La NHL API retourne parfois `pkPct = 0` quand les données ne sont pas encore disponibles en début de saison — toujours utiliser `|| defaultValue` (pas `??`) pour les champs numériques
- `scikit-learn` ne compile pas sur Python 3.14 — rester sur XGBoost natif + numpy/pandas
- Les modèles `.pkl` (joblib) ont été remplacés par `.json` (format natif XGBoost) pour la compatibilité Python 3.14
- Le split train/test se fait **par date** (temporel), pas aléatoirement — important pour éviter le data leakage en données sportives
