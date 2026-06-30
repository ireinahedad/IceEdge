# ICEEDGE — App Plan

> Mobile-first sports prediction app (430px max-width)
> Stack: React + Vite + TypeScript + Tailwind (frontend) · Node/Express + PostgreSQL (backend)
> Sports: NHL Hockey + Tennis

---

## What's Implemented

### App Shell
- React Router with 8 routes (`/`, `/stats`, `/stats/prediction/:type/:id`, `/bet`, `/league`, `/profile`, `/login`, `/auth/callback`)
- `SportContext` — hockey/tennis toggle with full theme (accent color, background, glow)
- `AuthContext` — JWT stored in localStorage, rehydrated on mount
- `BetContext` — bet legs state, parlay probability (calls backend or naive multiplication fallback)
- `BottomNav` — links to all 5 main screens

### Auth
- Email/password login + register via `LoginPage` + `authService`
- Google OAuth — full flow: Google → backend callback → `AuthCallback` → `setSession`
- JWT in localStorage, rehydration on mount (decodes payload, no extra API call)
- Auth middleware on all protected backend routes (`/api/slips`, `/api/profile`, etc.)

### Home Screen — `HockeyLanding`
- Shows today's NHL live/upcoming games with win % predictions
- Shows upcoming tennis matches (RapidAPI or fallback mock data)
- Live Bet365 odds via `oddsApiService` when `VITE_ODDS_API_KEY` is set
- Affiliate links to Bet365 via `affiliateService`
- Sport switcher (hockey ↔ tennis) that changes the whole theme
- MarketSelectorSheet accessible from every game card

### Stats Page — `StatsPage`
**Hockey mode (3 tabs):**
- **By Team** — all 32 teams with record, streak, conference; search; tap → PredictionPage
- **By Game** — today's games (API) + Stanley Cup season futures (built from standings)
- **By Player** — pick a team → see full roster (via `/api/nhl/teams/:abbr/roster`); tap → PredictionPage

**Tennis mode (4 tabs):**
- **By Player** — ATP + WTA rankings (RapidAPI + FALLBACK_ATP/WTA static data)
- **By Match** — live matches + fixtures with 3-day lookahead fallback; each card shows 3 bettable markets
- **By Surface** — Clay/Hard/Grass breakdown with top performer + win % bar
- **By Tournament** — Grand Slam schedule (RapidAPI + static fallback)

### Prediction Detail — `PredictionPage`
Route: `/stats/prediction/:type/:id`
Handles: `team`, `player`, `game`, `tennis-player`, `ngames`, `future`
- Animated `WinGauge` (SVG, counts up on load)
- `CalculatedBreakdown` — waterfall of factors that explain the prediction
- `ReasonBar` — stat bars that animate in
- Add-to-slip button (opens MarketSelectorSheet)
- Falls back to mock predictions if `VITE_PREDICTION_API_URL` isn't connected to a real ML model

### Bet Builder — `BetBuilderPage`
- Animated probability gauge (color-coded: green/blue/yellow/red)
- Leg cards with remove button
- Combined probability via backend `/predict/parlay` (or naive multiplication fallback)
- **Submit slip** → `POST /api/slips` (requires JWT)
- **Slip history** → `GET /api/slips` — shows past predictions with outcome badges
- **Resolve slip** → `PATCH /api/slips/:id/resolve` — win/loss, awards XP
- MarketSelectorSheet: 3-step flow (pick subject → pick market category → configure line/selection)
- `predictionApiService.getSinglePrediction` called per market to get probability

### League — `LeaguePage`
- **Leaderboard tab** — ranked list of users by XP/tier (`FullLeaderboard` component)
- **Chat tab** — PostgreSQL-backed chat rooms; `ChatTab` + `MessageBubble` components
- Unread badge count on tab
- Backend: `chat.routes`, `chat.service` — rooms, messages, reactions all in DB

### Profile — `ProfilePage`
- **Overview tab** — avatar, tier badge, stats (total bets, win rate, XP, streak), badges grid, calibration card, market breakdown chart
- **History tab** — full bet history list with outcomes
- Tier system: `rookie → analyst → sharp → legend` (configured in `TIER_CONFIG`)
- `ProfileComponents`: `StatPill`, `ScoreRing`, `HitRateChart`, `MarketBreakdown`, `BadgeGrid`, `BetHistoryList`, `CalibrationCard`
- Backend: `profile.routes`, `profile.service`, `user.service`

### Backend API
All routes are on `localhost:3001/api/`:

| Route group | Endpoints |
|---|---|
| `/auth` | login, register, logout, refresh, Google OAuth |
| `/nhl` | games, live games, teams, team stats, last N games, roster, players, standings, predictions |
| `/tennis` | live matches, fixtures, rankings, tournaments |
| `/slips` | submit, list, get, resolve (XP) |
| `/profile` | get/update profile, leaderboard, chat rooms |
| `/chat` | rooms, messages, post message, reactions |
| `/ml` | predict/single, predict/parlay, predict/factors (currently stubs) |
| `/odds` | Bet365 odds proxy |
| `/opportunities` | EV bet finder (built, no frontend yet) |

### Database Schema (PostgreSQL)
Tables: `users`, `refresh_tokens`, `nhl_teams`, `nhl_team_stats`, `nhl_games`, `nhl_players`, `nhl_player_stats`, `nhl_odds`, `user_profiles`, `user_badges`, `user_bets`, `chat_rooms`, `chat_messages`, `chat_reactions`

---

## What's Broken / Incomplete

| # | Issue | Location |
|---|---|---|
| 1 | `LastNGamesSection` component defined but **never rendered** anywhere | `StatsPage.tsx` |
| 2 | `NHLPredictionsPage.tsx` exists but **not in routes** | `components/NHLPredictionsPage.tsx` |
| 3 | `TennisPredictionsPage.tsx` exists but **not in routes** | `components/TennisPredictionsPage.tsx` |
| 4 | `SharePage.tsx` exists but **not in routes** | `components/SharePage.tsx` |
| 5 | Root `components/LeaguePage.tsx` is a **duplicate** not used in routes (routes uses `league/LeaguePage.tsx`) | `components/LeaguePage.tsx` |
| 6 | Chat is **HTTP only** — messages don't appear in real time, need WebSocket | `chat.service.ts` |
| 7 | ML/prediction backend (`ml.routes.ts`) is **stub** — no real model connected | `server/src/routes/ml.routes.ts` |
| 8 | Bet365 affiliate code is **placeholder** (`365_XXXXXXX`) | `client/.env` |
| 9 | EV/Opportunities feature has **no frontend** | `opportunities.service.ts` exists |
| 10 | `StatsPage` errors: file was growing past 1358 lines — needs **splitting into sub-files** | `StatsPage.tsx` |

---

## Implementation Plan

Work through these sections in order. Each section is independently shippable.

---

### Section 1 — Codebase Cleanup ✅ DONE
**Goal:** Remove dead code, fix file confusion, make the project navigable.

- [x] `NHLPredictionsPage.tsx` — kept (NHL market explorer). Route: `/predictions/nhl`. Entry banner in StatsPage "By Game" tab.
- [x] `TennisPredictionsPage.tsx` — kept (tennis market explorer). Route: `/predictions/tennis`.
- [x] Root `components/LeaguePage.tsx` — deleted. Routes use `league/LeaguePage.tsx`.
- [x] `SharePage.tsx` — written + route `/share/:slipId`. Shows slip legs, odds, share/clipboard button.
- [x] `StatsPage.tsx` split into 4 files: `StatsPage.tsx`, `TennisStatsPage.tsx`, `PlayersTab.tsx`, `LastNGamesSection.tsx`
- [x] `LastNGamesSection` added as 4th "By Form" tab (uses nhlApiService stats, winPct fallback, no stub prediction calls)
- [x] `opportunities.service.ts` + `opportunities.routes.ts` — deleted from backend; `app.ts` cleaned up

---

### Section 2 — Stats → Prediction Flow (end-to-end) ✅ DONE
**Goal:** Every card in Stats taps through to a working Prediction detail page.

- [x] All 6 PredictionPage types verified: `team`, `game`, `player`, `ngames`, `future`, `tennis-player` — all load real API data with fallbacks
- [x] Fixed StatsPage `onAdd` — TeamCard and GameCard now call `openAdd()` → opens `MarketSelectorSheet` with preselected subject
- [x] `LastNGamesSection` as 4th "By Form" tab ← done in Section 1
- [x] Tennis ranking cards navigate to `/stats/prediction/tennis-player/:id` (in TennisStatsPage)
- [x] Full path: Stats → tap card → PredictionPage → header "Add to Slip" → MarketSelectorSheet → BetContext → `/bet`
- [x] Fixed `BetRec` — was toggling local state only; now navigates to `/bet`
- [x] Fixed PredictionPage header "Add to Slip" button — added `px-3 py-2`, removed duplicate `gap` class

---

### Section 3 — Prediction Backend (Rule-Based First, ML Later) ✅ DONE
**Goal:** Replace all mock prediction fallbacks with real computed predictions from the backend.

- [x] `POST /api/predict/single` — dispatches via `computeProbability()` using real `predictionEngine.ts` functions (Log5, Poisson); returns `{ probability, confidence, factors, oddsLabel, modelVersion, generatedAt }`
- [x] `POST /api/predict/parlay` — multiplies leg probabilities with 5% correlation haircut
- [x] `POST /api/predict/factors` — calls `buildRealFactors()` with real team/player stats; returns `{ basePct, factors: [{icon,label,delta}], finalPct }`
- [x] `POST /api/predict/player-prop` — real pace/rate calculations using `fetchPlayerById`
- [x] `POST /api/predict/futures` — standings-rank-based priors via `predictFutures()`
- [x] `VITE_PREDICTION_API_URL=http://localhost:3001/api` set in `client/.env`; frontend `predictionApiService.ts` calls `/predict/*` which resolves correctly; falls back to mock if server down

---

### Section 4 — Bet Builder Polish ✅ DONE
**Goal:** The full bet-placing loop works flawlessly, including auth gating.

- [x] If user tries to submit a slip while logged out → `navigate('/login?returnTo=/bet')` (no more error toast)
- [x] After login/register → `LoginPage` reads `returnTo` param and redirects back (default `/`)
- [x] Each `LegCard` shows American odds label (e.g. `-150`) derived from probability via `toOddsLabel()`
- [x] Gauge area shows implied parlay odds pill (e.g. `+450`) below the probability for 1 or more legs
- [x] "Clear" button opens confirmation modal (shows leg count, Cancel + Clear All buttons)
- [x] Resolve flow already implemented: Mark Won/Lost → `PATCH /api/slips/:id/resolve` → XP badge shows on slip card
- [x] Fix "matchs" typo in StatsPage → "matches" ← done

---

### Section 5 — Real-Time Chat (WebSocket) ✅ DONE
**Goal:** Chat messages appear instantly without refresh.

- [x] `socket.io` installed on backend; `socket.io-client` installed on frontend
- [x] `server/src/socket.ts` — singleton `io` + `initSocket(httpServer)` helper
- [x] `server/src/server.ts` — switched from `app.listen` to `createServer(app)` + `initSocket`
- [x] `server/src/routes/chat.routes.ts` — emits `io.to(roomId).emit('new_message', msg)` after every POST
- [x] `client/src/app/hooks/useChatSocket.ts` — connects, joins room, listens for `new_message`; exposes `initMessages`, `appendOptimistic`, `confirmMessage`
- [x] `ChatTab` `RoomChat` — uses hook; HTTP history seeds on mount; own sends go optimistic then confirm; remote messages appear via socket without refresh
- [x] Online user count shown in room header (live dot green when connected, falls back to memberCount)
- [x] `VITE_SOCKET_URL=http://localhost:3001` in `client/.env`

---

### Section 6 — Share Feature
**Goal:** Users can share their bet slip as a screenshot/link.

- [ ] Add `/share/:slipId` route → `SharePage.tsx`
- [ ] `SharePage` shows slip summary (legs, combined %, sport badge) styled for screenshot
- [ ] Add share button to `BetBuilderPage` (after submitting)
- [ ] Implement native share via `navigator.share()` (mobile PWA)
- [ ] Fallback: copy link to clipboard

---

### Section 7 — EV / Opportunities Feature
**Goal:** Surface +EV bets to users (backend already built, needs a frontend).

- [ ] Add an "Opportunities" tab or section to `HockeyLanding` (home screen)
- [ ] Call `GET /api/opportunities` to fetch positive-EV bets
- [ ] Display as cards: market, our probability vs bookmaker implied, edge %
- [ ] Tap card → opens MarketSelectorSheet pre-filled with that bet
- [ ] Add to `BottomNav` if it becomes a full page

---

### Section 8 — Production Readiness
**Goal:** Ship to real users.

- [ ] Replace all `localhost:3001` env vars with production server URL
- [ ] Replace `VITE_BET365_AFFILIATE_CODE=365_XXXXXXX` with real partner code
- [ ] Add PWA manifest + app icons (hockey puck / app logo)
- [ ] Add error boundaries around each major page (so one crash doesn't kill everything)
- [ ] Audit all loading states — every API call should have a skeleton or spinner
- [ ] Add a "not found" (404) route
- [ ] Add Google Analytics or Plausible for usage tracking
- [ ] Set `NODE_ENV=production` and configure CORS for prod domain
- [ ] Run DB migrations on prod PostgreSQL
- [ ] Configure Google OAuth redirect URI for prod domain

---

## Quick Reference — File Map

```
client/src/app/
├── App.tsx                    # Root: providers + AppShell
├── routes.tsx                 # All routes
├── context/
│   ├── AuthContext.tsx        # JWT auth state
│   ├── BetContext.tsx         # Bet legs + parlay probability
│   └── SportContext.tsx       # Hockey/Tennis toggle + theme
├── components/
│   ├── HockeyLanding.tsx      # Home screen (/)
│   ├── StatsPage.tsx          # Stats (/stats) ← needs splitting
│   ├── PredictionPage.tsx     # Prediction detail (/stats/prediction/:type/:id)
│   ├── BetBuilderPage.tsx     # Bet slip (/bet)
│   ├── MarketSelectorSheet.tsx # Add-bet modal (used everywhere)
│   ├── LoginPage.tsx          # Login/register (/login)
│   ├── AuthCallback.tsx       # Google OAuth redirect (/auth/callback)
│   ├── BottomNav.tsx          # Navigation bar
│   ├── league/
│   │   ├── LeaguePage.tsx     # Leaderboard + chat (/league)
│   │   ├── LeagueHeader.tsx
│   │   ├── FullLeaderBoard.tsx
│   │   └── chat/ChatTab.tsx
│   └── profile/
│       ├── ProfilePage.tsx    # Profile (/profile)
│       └── ProfileComponents.tsx
├── services/
│   ├── nhlApiService.ts       # → GET /api/nhl/*
│   ├── tennisApiService.ts    # → RapidAPI tennis (via backend proxy)
│   ├── predictionApiService.ts # → POST /api/ml/predict/* (+ mock fallback)
│   ├── slipApiService.ts      # → /api/slips
│   ├── oddsApiService.ts      # → The Odds API (Bet365 live odds)
│   ├── affiliateService.ts    # Bet365 affiliate deep links
│   ├── authService.ts         # → /api/auth
│   └── userService.ts         # → /api/profile
└── data/
    ├── hockeyData.ts          # Static team/player reference data
    ├── betMarkets.ts          # Market definitions + categories
    └── teamEmoji.ts           # Team emoji + probToOdds helper

server/src/
├── server.ts / app.ts         # Express entry point
├── routes/
│   ├── nhl.route.ts           # /api/nhl/*
│   ├── tennis.route.ts        # /api/tennis/*
│   ├── slip.routes.ts         # /api/slips/*
│   ├── auth.routes.ts         # /api/auth/*
│   ├── ml.routes.ts           # /api/ml/predict/* ← STUB, needs implementing
│   ├── chat.routes.ts         # /api/chat/*
│   ├── profile.routes.ts      # /api/profile/*
│   ├── odds.route.ts          # /api/odds/*
│   └── opportunities.routes.ts # /api/opportunities/* (no frontend yet)
├── services/
│   ├── nhl.service.ts         # NHL API client + DB queries
│   ├── nhlApiClient.ts        # NHL public API HTTP calls
│   ├── nhlPredictions.ts      # Rule-based market predictions ← use this for Section 3
│   ├── predictionEngine.ts    # Core prediction math
│   ├── tennisApiClient.ts     # RapidAPI tennis
│   ├── slip.service.ts        # Slip CRUD + XP logic
│   ├── chat.service.ts        # Chat rooms + messages
│   ├── profile.service.ts     # User profile + leaderboard
│   ├── ev.service.ts          # EV calculation
│   └── opportunities.service.ts # +EV bet finder
└── db/
    ├── schema.sql             # Full PostgreSQL schema
    └── migrations/            # 002_google_auth, 003_bet_slips
```
