# ArakIce / ICEEDGE — Project status

**Single source of truth for what is done and what remains. Updated 2026-09-30 (season start).**

Built by reading every planning doc in the repo (plus the deleted `RESTE_A_FAIRE.md`,
recovered from Git) and checking each claim against the code and the Git log.

| Mark | Meaning |
|---|---|
| ✔ | Verified today in the code or the Git history |
| 📄 | Stated as done in the docs, but it lives in a console, in production or in a mailbox — could not be checked from the repo |

> **Rule of this file.** New work goes into §3. When something is finished, move it to §1
> in one line. Do not open a to-do list anywhere else (`PROJECT_CONTEXT.md`, audits, plans):
> two lists always drift apart. That is how `RESTE_A_FAIRE.md` got lost on 2026-09-16
> (deleted inside an unrelated commit, `4d1cbcd`).

---

## 0. Where things stand

- **The web app is live** on arakice.com: Vercel (front), Railway (Node + Python ML), Neon
  (Postgres), Cloudflare R2 (avatars), Cloudflare DNS/proxy. 📄
- **All the pre-iOS web work is shipped** (env hardening, platform flags, token transport,
  refresh stampede fix, chat moderation, 18 batches of pre-freeze fixes). ✔
- **iOS has not started, and the web is NOT frozen.** Support mailbox recovered (2026-09-25).
  The `pre-ios-freeze` tag (put on `1244bac` on 2026-09-26) was **removed on 2026-09-28**: web
  work continues freely until iOS actually starts; re-tag the freeze point at that moment.
- **The NHL 2026-27 regular season started on 2026-09-29** (84 games per team, back from 82;
  preseason ran 09-19 → 09-26). The season-start tasks are in §3.2; what is left there is
  console work (Railway) and checks on the live site.

---

## 1. DONE

### Launch, production, deployment
- ✔ Production stack and deployment runbook (`DEPLOYMENT.md`): Neon pooled endpoint, Railway
  Node + private ML service, Vercel, R2, Google OAuth.
- ✔ Graceful shutdown (SIGTERM), liveness `/health` + readiness `/health/ready`, non-root
  Dockerfile with tini and healthcheck.
- ✔ Migration ledger (`schema_migrations` in `migrate-all.ts`), DB cleanup job
  (`cleanup.service.ts`).
- ✔ Env validation: a missing `VITE_*` URL fails the Vercel build instead of pointing at
  localhost (R7).
- ✔ Manual inputs (goalies, scratches, injuries, referees) moved to the database (migration
  034), editable from the phone (Profile → Settings → Manual input).
- ✔ `/nhl-predictions` infinite render loop fixed (commit `ee9b880`, 2026-09-16).
- ✔ **No more hard-coded percentages on the prediction pages** (2026-09-24, *not yet committed
  or deployed*). `/nhl-predictions` is now a game picker over the real match view
  (`GamePrediction`); the match, team and player pages show only server-computed rule
  percentages — skeleton while loading, error + "Retry" if the server fails, never a local
  number. Fake "Ask LLM" answer removed. Client `typecheck` and `vite build` pass (fresh Linux
  install).
- ✔ Redis adapter for Socket.io shipped and resolved in the lockfile (`@socket.io/redis-adapter`,
  `ioredis`). Inactive until `REDIS_URL` is set, which is fine at one instance.
- 📄 All migrations (through 037) applied to Neon — confirmed by you on 2026-09-24. Cloudflare account recovered (2026-09-16), TLS 1.2
  minimum, `www` → apex redirect in place, `support@arakice.com` forwards to Gmail.

- ✔ Live-site walk (2026-09-26): `/nhl-predictions`, team (WSH), skater (Ovechkin), goalie
  (Thompson) all served by the server, match/team numbers consistent (52 = 38 + 14). Found the
  player-prop inflation (§3.1).
- ✔ Transactional email via Resend on `arakice.com` (2026-09-26): password reset received and
  used on production. Covers the reset code (F6), the sign-up code, and the account-deletion code
  for Google-only accounts (no password to re-authenticate with).
- ✔ Sentry fell back to the **Developer** (free) plan after the Business trial — checked 2026-09-26.
  Watch Stats → Usage: once the monthly quota is spent, new errors are dropped until the reset.
- ✔ Moderation queue (`arakice.com/dev/moderation`) opened and emptied — 2026-09-26.
- ✔ Admin card shows "a key is saved", and it survives a bio edit (034 regression check) — 2026-09-26.
- ✔ `npm audit fix` in `server/` (2026-09-26, commit `c5c261f`): express 4.22.3,
  body-parser 1.20.8, qs 6.16.0. With the Sentry bump below, `npm audit --omit=dev` = **0**.
- ✔ Decision 2026-09-26: **no staging environment**. QA F1/F2 run on production with throwaway accounts.
- ✔ `pre-ios-freeze` tag pushed (on `1244bac`), 2026-09-26 — **removed 2026-09-28** (decision: web not frozen yet).
- ✔ Railway checked on the running banner (2026-09-26): Node and ML on the same commit (bundle +
  player model live), `NHL_USE_MOCK` false, `ML_DISABLED` false, `API_RATE_LIMIT` default,
  `NODE_ENV=production`, `CORS_ORIGIN` correct, no `DORMANT`, probes OK. `ENABLE_DEV_ROUTES=true`
  **on purpose** (see §6). *(Correction 2026-09-26, afternoon: the service had **no** healthcheck path
  set — added then, see below.)*
- ✔ **Backups & rollback drill** (2026-09-26, `BACKUP_DR.md` §5.3):
  - Neon history window 6 h → **1 day** (your choice; 7 days would cost ~0.005 $/month). Production
    branch now **protected** (can't be deleted or reset by mistake).
  - Neon restore drill: branch `drill-2026-09-26` from production as of 1 h earlier, forked in 0.62 s,
    fingerprint (`server/scripts/restore-drill.sql`) identical to production on every user table —
    10 users, 8 slips, 22 chat messages, 3 Pro, 37 migrations. ~2 min end to end. The branch
    auto-deletes on 2026-09-27 14:05 WITA.
  - Railway rollback `d269448` → `c5c261f` → `d269448`: each switch active in < 10 s, **0 failed**
    `/health/ready` probes out of 234 (1/s).
  - Vercel Instant Rollback `d269448` → `c5c261f` → Promote `d269448`: ~8 s each way, 0 errors out
    of 211 probes on arakice.com, auto-promotion of `master` back on. (Hobby has no "Undo Rollback"
    button: Deployments → newest → ⋯ → Promote.)
  - Railway settings: healthcheck `/health/ready`, teardown draining **15 s** (was 0 s: old
    containers were killed on SIGTERM, before any shutdown log). Next deploy logged `SIGTERM received`
    → `Clean shutdown complete`, 0 failed probes out of 152.
- ✔ **2026-09-26 batch deployed** (`d269448`, Railway auto-deploys `master`): built from
  `server/Dockerfile` on `node:24-alpine`, `[Sentry] ✅ armé`, `ODDS_API_KEY acceptée`, R2 and Redis OK.
  Player-prop fix live: Ovechkin 2+ goals **6 %**, 3+ points **4 %**, 3+ assists 3 %
  (`/api/nhl/predictions/player/8471214`).
- ✔ Running banner shows `EMAIL_VERIFICATION_DISABLED: false` and `SOCKET_ADAPTER: redis`
  (`REDIS_URL` set — a Redis service runs in the Railway project).

### Technical deadlines + dynamic QA (2026-09-26, deployed in `d269448`)
- ✔ **Node 24** everywhere: `server/Dockerfile` (`node:24-alpine`, both stages), CI and the SEO
  Action. 623/623 server tests, client typecheck + build pass under Node 24.21.
- ✔ **GitHub Actions** `checkout@v7`, `setup-node@v7`, `gitleaks-action@v3` (Node 24 runtimes; no
  input changes). Triggers untouched.
- ✔ **`@sentry/node` 8 → 10.75** (not 11: v10 already clears the OpenTelemetry advisories, and 11.0.0
  had just shipped with a data-collection default that sends bodies, cookies and SQL). Same API
  (`init`, `setupExpressErrorHandler`); an event was received end to end by a local Sentry stub.
- ✔ **`pg` v9 ready**: `pinSslMode()` (`db/pgUrl.ts`) rewrites `sslmode=require|prefer|verify-ca` to
  `verify-full` in the three pools — exactly today's behaviour, kept after pg v9, and pg's boot
  SECURITY WARNING goes away. No Railway change needed.
- ✔ **Dynamic QA campaign on a local production-mode stack** — 90/90 after fixes, script in
  `loadtest/qa-dynamic/`, report in `QA_TEST_PLAN.md` § « Exécution du 2026-09-26 ». Covered: F1,
  F2 (webhook path), F3, F6, S1 IDOR with two accounts, S2 tampered JWT / refresh replay, I1, I3,
  I5, P3, P5, R1 (ML killed), R3 (Postgres killed), R5 (SIGTERM under traffic), the two moderation
  cases never walked, a local backup/restore rehearsal, static SEO meta on 214 pages, Lighthouse.
- ✔ Six defects found and fixed, each with a test:
  1. a logged-out device's rotated refresh token could be replayed for 10 s while another device
     was signed in (`sessionStillAlive` now requires a token born after the rotation);
  2. `PATCH /users/:id` let the owner change their email with no verification (stolen access
     token → attacker's email → "forgot password" → takeover) and 500'd on duplicates — now
     admin-only, strict zod schema, 409;
  3. `writeLimiter` counted reads — the 31st `GET /api/slips` in a minute got 429;
  4. Sentry never saw the 500s of the 93 handlers that answer through `sendError` — now reported
     (except 501/503, announced outages that would drain the Developer-plan quota);
  5. once reported, events carried `authorization` and the `ice_refresh` **cookie** (7–30-day
     refresh token) — scrubbed in `beforeSend`;
  6. every deploy ended in `exit(1)` "Error during shutdown" (`io.close()` already closes the HTTP
     server) and never closed the pool.
- ✔ **Landing no longer downloads recharts + d3.** React had been bundled *inside* the `charts`
  chunk, so every page preloaded it. React now has its own chunk: `/` 337 → 230 KiB, Lighthouse
  mobile 79 → 84, LCP 4.0 → 3.5 s (local build, simulated slow 4G).
- ✔ `/dev/ml` yellow "run fetch_data.py then train.py" tip now appears only when a model is
  really missing (it came from the ML service's `/health`, not from the client).

### Security
- ✔ In-app account deletion (Apple 5.1.1(v), Loi 25): `DeleteAccountSheet` in Settings, re-auth,
  `accountDeletion.service.ts` + tests (`1244bac`, 2026-09-25).
- ✔ `npm audit` 2026-09-26: `client/` 0. `server/` runtime (`--omit=dev`) **0** after `qs` and
  Sentry 10. What remains is vitest/vite — dev-only, not shipped.
- ✔ Pre-freeze security batch closed: Vercel preview CORS regex, internal error leaks
  (`httpError.ts`, 93 handlers), OpenAI key no longer returned by `/users/me`, Google
  `email_verified` check, push unsubscribe IDOR, zod on `/api/predict/*` + limiter,
  server-side `systemPrompt`, access token out of the URL + Sentry scrubbing, full zod
  validation, 8 s timeout on the odds proxy, `NHL_USE_MOCK` needs a second switch in prod.
- ✔ Auth: hashed refresh tokens, atomic rotation with grace window (033), client refresh
  coalescing, native token mode refused from browser origins, `logout-all`.
- ✔ Encrypted user OpenAI keys (AES-256-GCM), Stripe webhook signature + idempotency,
  promo `redeemLimiter`, CSP + HSTS on Vercel, gitleaks in CI.
- ✔ Mock odds endpoints removed; no invented predictions on the server
  (`PredictionUnavailableError`).

### iOS readiness (web side)
- ✔ `platform.ts` flags: no Google login, no bookmaker links, no Stripe, no BYOK, no web
  push, no service worker, no dev routes, no Pro page in the iOS build.
- ✔ Server-side native token path (`X-Client: native`).
- ✔ Chat moderation (Guideline 1.2): filter, report, block/unblock, admin queue, guidelines
  in Terms §7 (migration 032). 📄 Walked on production on 2026-09-04.
- ✔ Safe areas (`viewport-fit=cover`, BottomNav), 16 px inputs, 44 pt tap targets, 11 px
  text floor, iOS touch settings, chat resync on foreground, persisted bet slip, request
  timeouts + "Retry" states, `/share/:id` removed, "demo mode" Stripe notice removed.

### Payments
- ✔ Stripe checkout + webhook (web only), free trial, promo codes, cancel from Settings.
- 📄 Stripe is configured in production.
- ✔ Pro "public slips" feature built (migrations 029/030). **Inert** until
  `PUBLIC_SLIPS_SINCE` is set (see §3.2).

### SEO
- ✔ Daily match pages (`/match/…`, `/fr/match/…`) generated by the `seo-gameday` GitHub
  Action. The bot has committed pages every day through 2026-09-22.
- ✔ `sitemap-games.xml` exists and is listed in `robots.txt`.
- ✔ Perpetual pages (`seo-gen.mjs`), `/props/` allowlist, server-rendered hub links.

### Testing
- ✔ Server test suite and client `typecheck` wired into CI (last recorded run: 542 tests /
  39 files, 2026-09-21 — not re-run for this review).
- ✔ Load-test campaign finished (`RAPPORT_TESTS_CHARGE_2026-09-18.md`): 14 benches,
  scenarios S1–S7 covered, 8 production defects found and fixed.
- ✔ QA I1 (ML chain) and I2 (CORS + cross-site cookie, 6 of 7 steps) green on production
  (2026-08-31). Security and resilience campaigns validated statically (2026-07-27).

### Product and ML (recent)
- ✔ Match page tables (puck line, totals, BTTS, exact score, periods) with a consistent
  final-score law; settlement handles `correct_score`, BTTS lines, period draws, `void` (037).
- ✔ One ML bundle request per page (match, team, player); player XGBoost model trained and
  committed (`ml/models/player/*`).
- ✔ Stats page, bet win/lost confirmation, profile info, slip sharing into chat (036),
  public chat readable without an account.
- ✔ ML research items closed: S1, S2, S3, S5, A2 (measured), A3 (CLV tooling + moneyline
  measure), A5 (closed, inconclusive), A1bis (live odds collection code).
- ✔ Content engine (mine → check → render → video → log) and daily recap script.
- ✔ **Live match predictions, phase 1** (2026-09-30, *committed, not yet deployed*): during a
  game the match page's rule markets start from the current score and the time left
  (`finalScoreGrid(…, live)`, `liveCtxFromDetail`, `computeGameMarkets(…, live)`), refreshed
  every 30 s; decided markets show 100/0; finished games show the decided final state (6 h cache).
  The 7 `PlayerPropGrid`s share one boxscore/roster request.
- ✔ **Live predictions, phase 2 part 1** (2026-10-01, *committed, not yet deployed*):
  · **ML live**: the ML bundle runs the model's own pre-game numbers (home win, P(OT), λ) through
    the same score + time-left grid (`buildLiveModelMarkets`, `gameMlBundle.applyLive`, 30 s cache).
    ML toggle is back during games.
  · **Live player props** (rules + ML): reached thresholds = 100, otherwise P(≥ k − done) on the
    time left (`box.live.f`, `boxscoreLiveInfo`); first scorer settled from the first goal;
    players not on the game sheet hidden.
  · **Live vs pre-game display** (owner's choice): during a game, numbers recalculated on the game
    state carry `live: true` and show in **solid white**; everything else (game state unreadable,
    player props in OT, ML inputs missing, bookmaker odds, numbers not refreshed for 90 s) shows the
    **pre-game value, paler**, under a note at the top of the page. No "data unavailable" banner.
    `X-Stale-Response` now exposed by CORS; a stale copy is refused while live.
  · `fetchHeadToHead` (data only — its weight is not measured yet).
- ✔ **Live predictions, phase 2 part 2** (2026-10-01, local session, *committed, not yet deployed*):
  · **Measured score effects**: MoneyPuck shot files → 106 198 timed regulation goals
    (`fetch_live_goals.py`), out-of-sample pre-game λ (`live_pregame.py`), exposure maximum likelihood
    per (score gap × time slice, fine late P3), shrinkage chosen by leave-one-season-out
    (`calibrate_live.py` → `prediction/liveEffects.json`, trained 2012-13 → 2022-23). Last minute: team
    up one ×7.35 (empty net), down one ×2.61, tied ×0.64.
  · **Engine** `evolveLiveScore` (score DP, 10 s steps) behind `finalScoreGrid` and `liveCalibration`;
    player props get `box.live.fTeam` for goals/assists/points.
  · **Replay** (`server/scripts/replay-live.ts`, real engine, 3 903 games 2023-26, 5 moments, 10
    questions): log-loss −2.19 %, 23 cells better / 2 worse of 50; at 2 min left puck line −27 %, total
    −21 %. The 2 worse are puck-drop totals (+0.1–0.2 %, pre-game λ bias). → **Activated** (`LIVE_EFFECTS`).
  · **Head-to-head measured, not kept** (`measure_h2h.py`: moneyline log-loss +0.00006, deviance better
    on 64 % of seasons < 70 % rule). Nothing wired, ML or rules.
- ✔ **Corsi/Fenwick, official lineup, returning players** (2026-10-02, *not committed*):
  · **Measured first** (14 seasons, walk-forward). XGBoost moneyline already used Corsi% 5v5, not shots;
    Fenwick / score-adjusted / shots instead: no measurable difference (|z| < 1.2) → unchanged.
    Rules engine: shots on goal → **Fenwick all situations** (MoneyPuck `teams.csv`, team for + opponent
    against), λ as written: win log-loss −0.00030, 12/14 seasons. Shots stay as fallback.
  · **Returning player**: team form recomputed on games *with* him → no gain (4 thresholds); closing
    lines do not under-price the returning team (8+ games out: −2.6 pts vs market, z −1.9). Real gap
    fixed instead: a player out > 25 games had left the served roster, so the ML could not count him on
    his return (same for players who changed teams: CGY had 15 of 18 dressed skaters known). New
    league-wide `skater_pool` in `inference_state.json` (+ NHL `id`s); with the official lineup the
    service sums exactly the dressed skaters, like training does (SEA–CGY: 18/18 known).
  · **Official lineup** (`officialLineup.ts`), timing measured live on 2026-10-01: NHL `rosterSpots` =
    23-man roster at T−2 h; `right-rail` scratches published piecemeal from ~T−30 min; final 20 dressed
    only at T−9 to T−7 min. Scratches fill tonight's absents as soon as published; the final lineup goes
    to the ML and brings a long-term injured player back (AI + rules). Manual daily input still wins.
    Starting goalie is never published → stays manual. Measures: `measure_shot_metrics.py`,
    `measure_returnee.py` (reports in `ml/models/`). `inference_state.json` regenerated (only additions).
  · **Stats pages**: Corsi % / Fenwick % 5v5 (teams: table, comparison, trends) and on-ice CF%/FF%
    (player pages), credited to MoneyPuck.

---

## 2. PARTIALLY DONE

| Item | What is done | What is missing |
|---|---|---|
| **Redis / multi-instance** | ✔ Socket.io adapter shipped and **active** (Redis service on Railway, `REDIS_URL` set — checked 2026-09-26) | `RedisRateLimitStore` not written; rate limiters are per process. Needed only before a 2nd instance. |
| **Public slips (Pro)** | ✔ Code + migrations | Switch-on procedure (§3.2). |
| **Cloudflare in front of the API** | 📄 Proxy and cache headers in place | Check that it actually caches what the headers allow. |
| **Budget alerts** | ✔ Thresholds written in `MONITORING.md` | Set them in each console (Railway, Neon, Odds API, LLM, Stripe, Sentry, R2). |
| **Load testing** | ✔ In-process benches, all green | Real visitor latency against a pre-prod (`loadtest/s1-landing.js`) never run — there is no pre-prod. |
| **QA** | ✔ I1, I2 (6/7), static campaigns; ✔ dynamic campaign on a local stack (2026-09-26, 90/90) | What needs the real world: devices (C1–C3), Google (I4), the NHL API (I6), Railway/Neon latency (P1, P2, P5), Neon restore drill (§3.7). |
| **Client tests** | ✔ `typecheck` in CI | No test runner in `client/`. The socket block filter (`visibleMessages` in `RoomChat`) has no guard. |
| **Google auth token in URL** | ✔ Fragment + Sentry scrubbing | ✔ The `?access_token=` fallback in `AuthCallback.tsx` is still there; remove it now that the deploy window is over. |
| **SEO match pages** | ✔ Generated and deployed daily | Link `/match` from the app (✔ nothing links to it), submit `sitemap-games.xml` in Search Console, translate `/matchup/`, `/props/` and hubs to French. |
| **Content engine** | ✔ Pipeline + daily recap copying to Google Drive | Recap files are **uncommitted** (`daily-recap.cmd`, `install-daily-recap.ps1`, logos, edits to `COMMANDS.md`, templates, scripts). Commit them and install the scheduled task. |
| **Manual input — absent goalie** | ✔ Stored in DB | A goalie entered in both "Injuries" and "Tonight's lineups" may count twice. Check on a real case. |

---

## 3. STILL TO DO

### 3.1 Before the iOS freeze / before launch — blocking

- [ ] **Email verification — test it** (decided 2026-09-26): ✔ `EMAIL_VERIFICATION_DISABLED=false` is already
      in the running banner. Left: sign up with a throwaway address and check the code arrives. Resend is live since 2026-09-26, so nothing
      else blocks it. Accounts created while it was off were marked verified at sign-up (`auth.service.ts`),
      so nobody gets locked out; an older unverified account gets in through "forgot password".
      Also confirm the `_dmarc` TXT exists (`p=none`, reports to `support.arakice@gmail.com`).
- [ ] **Critical QA**: F1 (full auth cycle), F2 (Pro gating end to end), C1 (iOS Safari:
      login → prediction → payment on a real iPhone). Runbooks in `QA_TEST_PLAN.md`. **On production**
      with 2–3 throwaway accounts (no staging, §6); F2 gets Pro through a promo code, not a real payment.
      ✔ 2026-09-26: F1, F2 (webhook path), F6 and the dynamic security checks already pass on a local
      production-mode stack (§3.7) — on production only the real-world parts remain (sign-up code,
      promo redeem, C1).
- [ ] **Rotate the Odds API key — 2026-09-29, when the paid plan is bought.** The key that once sat in
      `DEPLOYMENT.md` (still in Git history) **is the live one** (confirmed 2026-09-26). Regenerate it in
      the dashboard, paste the new one in Railway, Deploy, and check the banner line
      `ODDS_API_KEY acceptée`. (The DB password that leaked was a local one — no rotation needed;
      history purge was abandoned on purpose.)

### 3.2 At the start of the NHL 2026-27 season (started 2026-09-29)

- [x] **Model % back on the home page game cards** — `SHOW_MODEL_PCT_ON_HOME = true` in
      `LandingCards.tsx` (2026-09-30, *not yet committed or deployed*). Only the live-card bar and
      the edge badge still read that flag.
- [x] **84-game season** — `POST /api/predict/player-prop` (season-long props) projected pace and
      "games remaining" on 82, and read LAST season's totals as this season's for any player
      who had not played yet (`pickSeasonRow` falls back to the previous season): a player
      with 82 GP last year showed "2 games remaining". Now `REGULAR_SEASON_GAMES = 84` and only
      `statsSeason === currentSeason()` counts (`ml.routes.ts`, 2026-09-30, *not yet committed*).
      Left on 82 on purpose: the GP-based confidence scale in `ml_service.py` (heuristic, capped).
- [x] **ML data** — dataset, `inference_state.json` and `player_state.json` go to 2026-04-16, the
      last day of 2025-26 (✔ `games_spine.csv` ends on game `2025021312`); score model v2 retrained
      2026-09-27 with the per-matchup OT share (`p_ot_model`). Nothing newer exists until 2026-27
      games are played → next step is the monthly retrain (§3.5).
- [ ] **Turn on public slips** — decided 2026-09-30: open **today**, no real users yet (test
      accounts only). Migrations 029/030 ✔ already on Neon (everything through 037). Left, on your
      side: `npm run notify:slips -- --date 2026-09-30` (dry run only — if it lists only test
      accounts, no `--send`), then Railway → Node service →
      `PUBLIC_SLIPS_SINCE=2026-09-30T00:00:00Z` → Deploy, then the checks of `DEPLOYMENT.md` §7.
- [ ] **`DORMANT` off** — check the Railway banner has no `DORMANT=true` (`DEPLOYMENT.md` §1):
      with it on, bets placed since the season opener are not settled and the odds logger sleeps.
- [ ] **Odds logger (A1bis)**: check the banner (`ODDS_API_KEY acceptée`, `slots: 6`, no
      `DORMANT=true`), then `/dev/ml` → Data → "Série temporelle des cotes": `passes_today = 6`,
      `with_puckline > 0`. Scheduled check-ins were set for 2026-09-22 and 2026-10-13 — read
      their result. In October, consider `ODDS_LOG_RUN_AT_BOOT=true`.
- [ ] **SEO**: `npm run seo:gen` once games are played (stats are still 2025-26); redo the Search
      Console export and revise `client/scripts/props-allowlist.json` (mirror every change in
      the exclusion regex of `client/vercel.json`); click "Validate fix" on "Redirect error",
      re-read indexing around 2026-10-16.

### 3.3 At the first sale

- [ ] Vercel Pro (Hobby forbids commercial use).
- [ ] Sentry: move off the Developer plan if the monthly error quota gets close (Stats → Usage).
- [ ] Raise Railway's hard limit (25 $) and the GitHub Models budget (0 $ blocks Pro LLM calls).
- [ ] Verify Cloudflare caching in front of `api.arakice.com`.
- [ ] After launch: empty `PRO_PROMO_CODES`, redeploy, check an old code returns 400.

### 3.4 iOS app — `APPLE_PLAN.md` (nothing started)

✔ No Capacitor dependency, no `client/ios/`.

- [ ] Phase 0 — Apple account on an address you control, 2FA, Developer Program (Individual),
      Small Business Program, app record, API key.
- [ ] Phase 1 — legal: public privacy URL, EULA, age rating (expect 18+), privacy manifest.
- [ ] Phase 2 — gambling (Option A: no bookmaker links on iOS — flags already done); iOS copy
      and in-app disclaimer; decide whether the public site's betting framing is softened (R10).
- [ ] Phase 3 — Capacitor shell; native `tokenStore` (`@capacitor/preferences`) — without it
      the session dies every 15 min; CORS for `capacitor://localhost`; `build:ios` without
      SEO pages (R9); `AppShell` → `100dvh` and keyboard handling (✔ still `h-screen`, no
      `visualViewport`), tested on a real iPhone.
- [ ] On a real notched iPhone: every page (safe areas now active), the chat input row, tap
      targets, lock the screen 5 min and come back, airplane mode, very slow network.
- [ ] Phase 4 — native features (APNs push first, share sheet, offline, haptics, universal links).
- [ ] Phase 5 — IAP (deferred: v1 ships without Pro on iOS). Decide before submitting whether
      locked Pro sections without a call-to-action are acceptable.
- [ ] Phase 6 — in-app account deletion: ✔ built on the web (`1244bac`); check it in the iOS shell.
- [ ] Phases 7–9 — cloud macOS CI, store assets, TestFlight, submission.

### 3.5 ML — `ml/REFACTOR_PLAN.md`

- [ ] **Decision A1**: pay one month of The Odds API (~59 $) for the 2023–2026 backfill, or wait
      for live collection (~2029 for a puck-line verdict). Commands ready in the plan.
- [ ] A2 puck-line rule stays frozen — **do not bet on it** until A1 or a season of live data.
- [ ] S4: γ (stretch λ gap) after the 2026-27 season; then measure ⑤ and demote the classifier.
      The six `base_prob` markets are ~7 pts too low on clear favourites — do not bet on them.
- [ ] A4 (goalie confirmation window) and A6 (team totals, OT, ±2.5) — after A1/A2.
- [ ] Re-train monthly during the season.

- [ ] **Live predictions — power play in progress** (not done, nothing invented): MoneyPuck shot files
      have no time-on-PP, so the PP multiplier cannot be measured from them. Needs penalties from the NHL
      play-by-play (`v1/gamecenter/{id}/play-by-play`, ~1 300 games/season), then the same exposure
      likelihood as `calibrate_live.py` and a replay. `situationCode` is checked (2026-09-30) and the game
      sheet already carries `situation.secondsRemaining`. Also not through the engine yet: P1/P2 cards,
      BTTS. Detail: `LIVE_PREDICTIONS_PLAN.md`.
- [ ] **Pre-game score model level drift** (found 2026-10-01): observed regulation goals / λ = 0.96 on
      2022-25 (λ ~4 % too high), 1.03 on 2017-21. Pre-game "over" totals run high (P(>5.5) 60 % predicted,
      56 % observed on 2023-26). Fix on the pre-game side (in-season level recalibration), then re-measure.
- [ ] Deploy live predictions (phase 1 + phase 2): merge `claude/laughing-davinci-3ver59`
      into `master` — Railway (Node) and Vercel redeploy from GitHub. No Python, no migration
      (`liveEffects.json` ships with the Node code). Check on the live site during a game: numbers
      move every 30 s (rules AND ML), a finished period shows 100/0, player cells drop to what is left
      to reach, and late in P3 with a one-goal gap the puck line / totals rise (pulled goalie).

### 3.6 Scalability — only on trigger (`AUDIT_SCALABILITE_COUTS.md` §3)

| # | What | Trigger |
|---|---|---|
| D | `RedisRateLimitStore` + set `REDIS_URL` | before a 2nd instance |
| Q | 2nd Railway instance (no sticky sessions; keep `transports: ['websocket']`) | CPU > ~70 % |
| U | ML service RAM: 2 uvicorn workers don't fit in 512 MB | before the first real peak |
| E | Move old data-URI avatars to R2 | ~500 users with avatars |
| I | Client request cache (TanStack Query) | Railway bill becomes visible |
| 7 bis | Neon: scale-to-zero vs always-on — decide | off-season |
| R, S, T, V, W | per-user API limiter, cache keys, LLM prompt cache, log sampling, Tailwind purge | see audit |

~~Open question: `writeLimiter` per IP.~~ Settled: it is keyed per account since 2026-08-24
(`userOrIpKey`), and since 2026-09-26 it no longer counts reads.

### 3.7 QA campaigns still to run — `QA_TEST_PLAN.md`

✔ Everything that can run without the real world passed on 2026-09-26 (see §1). What is left
needs a device, a third party or production:

- [ ] **After deploying the 2026-09-26 batch** (deployed; ✔ `Clean shutdown complete` in the Railway
      log since draining = 15 s): log in, refresh, log out on arakice.com (the rotation change); open
      `/stats/chart` once (new `react` chunk); trigger one 500 and check the Sentry event shows
      `authorization: [Filtered]` and `cookie: [Filtered]`.
- [ ] **C1–C3** on real devices: iPhone Safari, Android Chrome, desktop browsers, PWA push.
- [ ] **I4** Google OAuth end to end on the real domain; **I6** once the NHL API has games.
- [ ] **P1 / P2 / P5 against Railway + Neon** (check `DATABASE_URL` uses `-pooler` first);
      **Lighthouse on arakice.com** — local LCP is still 3.5 s on simulated slow 4G.
- [x] **Neon restore drill** and Railway + Vercel rollbacks — 2026-09-26 (§1).
- [ ] **UptimeRobot** probes `HEAD https://api.arakice.com/` every few minutes and gets **404** (seen in
      the Railway log). Point the monitor at `/health/ready` (expects 200) or it reports the API down.
- [ ] Re-run `npm run moderation:dry-run` once the chat has real traffic.

### 3.8 Technical deadlines

✔ Code side done on 2026-09-26 (§1): Node 24, Actions v7/v7/v3, Sentry 10, `pg` sslmode pinned.
Left, in consoles:

- [ ] **Vercel → Settings → Build and Deployment → Node.js Version: 24.x** (the client builds and
      type-checks on 24; Vercel ignores the Dockerfile and CI).
- [x] Railway: build log `FROM node:24-alpine`, `[Sentry] ✅ armé` prints — 2026-09-26.
- [ ] `@sentry/node` 11 — later, not before its first patch releases. Its `dataCollection`
      default sends request bodies, cookies and SQL: set it explicitly when upgrading.

### 3.9 Cloudflare / accounts — all manual, in your own sessions

- [ ] R1 · `ireinahedad24@gmail.com` → myaccount.google.com → Security → *Recovery email* and
      *Recovery phone*: both must be ones you control today (not the dead iCloud / support
      addresses). Also note the backup codes (2-Step Verification → Backup codes).
- [ ] R6 (optional) · *Full (strict)* for `arakice.com` and `www` only. First check that Vercel's
      certificate is valid behind the proxy: Vercel → Project → Settings → Domains shows both with
      a valid certificate, and `curl -vI https://arakice.com` shows a Let's Encrypt/Vercel cert
      issued < 90 days ago. Then Cloudflare → Rules → Configuration Rules → hostname
      `arakice.com` or `www.arakice.com` → SSL *Strict*. Leave the zone default on *Full*.
      **Never** for `api` (Railway).
- [ ] R8 (optional, not before launch) · `cdn.arakice.com` for R2 — together with an `UPDATE` of
      `avatar_url`, or not at all.
- [ ] R9 · Close the old `Ireinahedad@icloud.com's Account` on Cloudflare (irreversible). Before:
      it must own no zone, no R2 bucket, no Workers and no billing — check each tab, then
      delete it from the account settings (if the option is missing, Cloudflare support does it
      on request from that account's email).

### 3.10 Low-priority code polish (post-freeze)

- Player hits / blocks / penalty-minute rules on the server use **position averages**, not the
  player's own numbers (`POSITION_DEFAULTS` in `nhlPredictions.ts`; the real values are in
  `nhl_player_stats`). Now that the player page shows the server's numbers, wire them in.
- `buildGameGroups` (`gameMarkets.tsx`) and the local tiles of `TeamPrediction.tsx` still carry
  placeholder `rulePct` values in the source. They are never displayed any more (overwritten by
  the server or dropped), but could be stripped.

- Goalie page header shows skater stats (G / A / PTS / +/-, and "1 A · 0 PTS"): show GAA / SV% / W.

Two routers on `/api/users` (rule written in `app.ts`) · hard-coded Pro price in `ProPage.tsx`
(✔ now `5,99 $`, not localised) · tu/vous mix in French strings · `backdrop-filter` on the nav
(measure on a device first) · `crypto.randomUUID()` for chat temp ids ·
`/api/predict/markets/game/:id` ignores `:id` · `ruleWeightsService` localStorage without
try/catch · tennis bets stuck "pending" in the DB (manual SQL) · server starts without a DB
(readiness returns 503) · friendship/following feature (deferred after the freeze, own plan).

### 3.11 Content engine — `content/HANDOFF.md` §8

- [ ] Commit the daily-recap work and install the scheduled task (`install-daily-recap.ps1`).
- [ ] Re-read TikTok/Instagram rules on betting-related content before the first post.
- [ ] Check `#utahmammoth` against the franchise's official account.
- [ ] Add `faceoffs_taken` to `build-content-insights.ts`.

### 3.12 Real bet365 odds + Best Bets ranking (added 2026-09-25)

Context: **The Odds API has no bet365 for the NHL.** Its only bet365 key is `bet365_au`
(Australia, AFL/NRL only). So `oddsClient.ts` never finds `bet365` and `pickBookmaker` falls back
to *the first book in the list* — the odds behind EV and value-bet alerts come from an arbitrary
book that can change per game. The client proxy (`odds.routes.ts`) returns zero odds while
`ODDS_BOOKMAKERS` / `ODDS_REGIONS` are unset.

Cheapest providers with bet365 (approx., converted at ~1 £ ≈ 1.35 US$, ~1 US$ ≈ 1.37 CA$ — check at checkout):

| Provider | Plan | ≈ US$/mo | ≈ CA$/mo | bet365 NHL + props |
|---|---|---|---|---|
| odds-api.io | Solo (2 books) | 65 | ~89 | **yes — confirmed 2026-09-25** |
| SharpAPI | Hobby (5 books) | 79 | ~108 | NHL yes, props not stated |
| SportsGameOdds | Pro | 299 | ~410 | yes (7-day trial) |

- [x] **Email odds-api.io** — answered 2026-09-25 (support bot), and checked against their public
      coverage sheet (tab "Coverage", row `Bet365 | Ice Hockey | Player Props: Yes | Pre-match: Yes |
      Live: Yes | All markets on sportsbook`). Solo = **65 US$/mo (£49)**, 2 books, bet365 counts as one.
      Region: bet365 is a single **"global"** feed — the sheet has no Canada/Ontario bet365 variant.
- [ ] **Test with the free key first** (odds-api.io/dashboard, no card; 2 books, 100 req/h,
      pre-match only — live needs a paid plan): pick bet365 + a second book, pull one NHL event,
      check the moneyline / puck line / totals / player-prop keys and compare a few prices with
      bet365.ca by hand (the "global" feed may differ from Canadian prices).
- [ ] Choose the 2nd book. The sheet also lists **`bet365 NJ`** (US feed) with the exact NHL
      markets we use (Anytime Goalscorer, Points O/U, Shots on Goal O/U, Power Play Points O/U) —
      useful if the "global" `Bet365` prop keys turn out messy. No Pinnacle in their catalogue;
      the sharp option for NHL is **Circa** (ML / spread / totals, pre-match only).
- [ ] Subscribe to Solo, then replace The Odds API in `server/src/services/oddsClient.ts` and
      `server/src/routes/odds.routes.ts` (keep the cache / quota / stale-fallback behaviour).
- [ ] Make `pickBookmaker` deterministic (one configured book, never "first in list") and
      expose which book priced each bet.
- [ ] **Best Bets ranking**: once real odds exist on every market, rank by expected value
      (`probability × real odds`) and show the real bet365 odds instead of the fair odds
      (`100 / pct`). Update the explanation line (`home.bbExplainMl` / `home.bbExplainRules`).
      Until then the list stays ranked by probability.
- [ ] Commit the Best Bets UX rework (2026-09-25, `BestBetsSection.tsx` + i18n — *not yet
      committed*): one exclusive tier selector, new rows, translated labels, max 2 bets per
      game, Rules / AI toggle. Check it on the live site with a Pro account.

---

## 4. NO LONGER RELEVANT

| Item | Why |
|---|---|
| Local market list of `/nhl-predictions` (`computeRulePrediction`, `askLLMForMarket`, ~40 i18n notes) | Replaced by the server match view on 2026-09-24. |
| Root `package.json` (`ogl`), `client/README.md` (Figma boilerplate), `_to_delete/`, `.claude-tmp/`, `Claude outputs/` | Deleted on 2026-09-24. |
| Native Google OAuth (`ASWebAuthenticationSession`) and Sign in with Apple | Google login is removed from the iOS build (decided 2026-09-03). |
| Native share of `SharePage.tsx` (APPLE_PLAN 4.3 / R11 as written) | `/share/:id` page was deleted; sharing is an image. |
| Paid marketplace between users / Stripe Connect | Abandoned: Stripe prohibits paid sports forecasting. |
| Tennis (pages, API, markets, TTL line O) | Tennis removed from the product on 2026-08-24. |
| Git history purge (`SECRET_ROTATION.md` §3) | Abandoned on purpose: private repo, dead keys, would break cited SHAs. |
| DB password rotation | The leaked password was for the local DB only. |
| `PRODUCTION_READINESS_AUDIT.md` roadmap (C1–C6, H1–H8, M1–M7, S3–S5) | All done or superseded by `AUDIT_SCALABILITE_COUTS.md`. |
| "ML frontend connection" debugging, "train XGBoost", "deploy", "Section 6/7" in `PROJECT_CONTEXT.md` | From June–July; the model is trained and the app is deployed. |
| "Stub `redisRateLimitStore.ts` exists" | Removed on 2026-09-15 — it must be written from scratch (§3.6). |
| "Cloudflare in front of Railway postponed" (audit line 11) | The proxy is in place; only cache verification remains. |
| `loadtest/README.md` §7 "S2–S7 not scripted" | Covered by the in-process benches (`loadtest/bench/`). |
| Supabase | Production database is Neon. |
| `/dev/ml` "run fetch_data.py then train.py" warning | Came from the ML service's `/health`; now only shown when a model is missing (2026-09-26). |

---

## 5. Could not verify from here

Everything that lives outside the repo: what is set in Railway / Vercel / Neon / Cloudflare /
Sentry / Stripe consoles; which migrations are applied to Neon; whether the latest commits are
deployed (this clone has no remote-tracking branches); whether CI is green right now (the
local `node_modules` are Windows-only, so tests and builds were not run for this review);
how the rebuilt prediction pages look with real data (built and type-checked, but not
opened in a browser — there is no pre-prod and this session cannot reach the API); Search Console state; results of the 2026-09-22
odds-logger check.

---

## 6. Rules not to undo

Carried over from `RESTE_A_FAIRE.md`, `PRE_IOS_PLAN.md` and the pre-freeze audit.

**Production and consoles**
- A value typed in Railway is not a value in service until "Deploy" — trust only the
  `[Server] Réglages effectifs` banner of the **running** container.
- `NHL_USE_MOCK=true` silently stops all settlement; `DORMANT=true` silently stops odds collection.
- DNS: `api` → `zhynah7t.up.railway.app`; apex CNAME `cname.vercel-dns.com`; never import a
  zone from a scan; never delete the `google-site-verification` TXT.
- Cloudflare: zone in *Full*, never *Full (strict)* for `api`, never *Always Use HTTPS*.
- ML service stays *Unexposed* (no public domain); ignore Railway's agent suggestion.
- Where things are: Neon project **ArakIce** is in the **llgarage** organization; Railway project
  **harmonious-perception** (services `IceEdge`, `courageous-analysis`, Redis) is in the
  **ireinahedad's Projects** workspace. Other Neon/Railway accounts you see are not ArakIce.
- Railway `IceEdge`: keep healthcheck `/health/ready` and teardown draining 15 s. A **Rollback**
  restores the image *and the variables* of that deployment.
- Vercel: after any Instant Rollback, **Promote** the newest deployment again, or `master` pushes
  (and the daily SEO pages) stop going live.
- Neon production branch is **protected**: an in-place Restore may require unprotecting it first
  (Settings → General); re-protect afterwards.
- Sentry: do not follow the "Configure Express SDK" wizard; `SENTRY_TRACES_SAMPLE_RATE` absent on purpose.
  Keep `beforeSend: scrubEvent` in `instrument.ts` — without it events carry the refresh cookie.
- `db:migrate:all` applies the whole backlog — check the target line and `PUBLIC_SLIPS_SINCE` first.
- `ENABLE_DEV_ROUTES=true` in production is **intentional** (decided 2026-09-26): the moderation
  queue (`/api/dev/reports`) and `/dev/ml` live under `/api/dev`. Every route there requires
  `authenticate` + `requireRole('admin')`. Turning it off breaks moderation.
- No staging (decided 2026-09-26): QA on production uses throwaway accounts, and Pro is granted by
  promo code, never by a real payment. Delete the throwaway accounts afterwards (Settings → delete).
- Test auth on the real domain, not on a `*.vercel.app` preview (third-party cookie there).
- The support Gmail is `support.arakice@gmail.com`; the dead one was `arakice.support@gmail.com`. Do not "fix" one into the other.

**Code**
- No local prediction fallback, ever: on failure show "—" and a banner.
- Rule percentages come from the server only (`/predictions/game|team|player`). A tile with no
  server number is hidden; add new markets in `nhlPredictions.ts`, never as a client list.
- Live game markets carry NO `factors` / `pctScale`: the client would otherwise recompute every
  tile from pre-game factors and user weights, erasing the score. A new game market must handle
  the `live` branch of `computeGameMarkets` (value from the live grid, 0/100 when decided).
- Live predictions are informational only: never let them touch settlement, `locks_at` or the
  started-game refusal in `slip.service.ts`.
- Live display rule (owner, 2026-10-01): a number recalculated on the game state = `live: true` =
  solid white; anything computed before the game is shown paler under the top-of-page note —
  never passed off as live. No new model constant that is not measured on real games.
- `useNHLData` must return stable functions (`useCallback`) — unstable ones caused the `/nhl-predictions` loop.
- Never put a secret behind `VITE_`; never log the Odds API URL (key in query string).
- `sendError` reports 5xx to Sentry except 501/503 — do not add 503 (one event per request
  during an outage). `writeLimiter` skips GET/HEAD/OPTIONS on purpose.
- `PATCH /users/:id` is admin-only: an owner email change without verification is an account
  takeover path. Profile edits go through `PATCH /users/me`.
- `vite.config.ts`: React keeps its own chunk, listed before `charts` — otherwise Rollup puts
  React inside `charts` and every page downloads recharts.
- Grace-window liveness means "a token born after this rotation", not "any live token".
- `ci.yml`: keep `master` in the triggers, do not widen to all branches.
- Removing a route does not remove its chunk: use `const X = flag ? lazy(...) : null`.
- Refresh-token rotation: the grace window is three mechanisms (in-flight promise, DB
  fallback, `sessionStillAlive`) — read `PRE_IOS_PLAN.md` R3bis.2 before touching it.
  Never make the server rotation stricter without the client coalescing.
- Chat moderation decisions (reports cascade with the message, block routes have no
  `requireOwnerOrAdmin` on purpose, block list is one-way, hidden = hidden for the author
  too, socket not filtered server-side) — see `PRE_IOS_PLAN.md` R4.
- Chat length limit lives in three places (`RoomChat`, `chat.service.ts`, zod schema).
- Prove a typecheck is active by inserting a deliberate error.
- Tennis stays removed; `SportContext` stays mono-sport.
- SEO hubs render their links server-side; never go back to JS rendering. Never put
  `[skip ci]` in the SEO Action's commit message (Vercel would skip the deploy).
- Split big files by script with three checks (syntax, internal imports, line multiset).

**Repo**
- `git config core.autocrlf input`; `npm ci`, never `npm install`.
- Tests/builds run in a fresh Linux install (cloud container), not through the bridge.
- Through the bridge, use `git --no-optional-locks status`: a plain `git status` writes
  `.git/index.lock`, and the bridge cannot delete it — your next Windows `git` then fails.
- Dynamic QA: `loadtest/qa-dynamic/` against a local stack only (the script refuses Neon /
  arakice.com).

---

## 7. Document map

| Document | Role | Status |
|---|---|---|
| `STATUS.md` | This file — what is done and what remains | **live** |
| `PROJECT_CONTEXT.md` | Architecture, conventions, session log | live (history) |
| `DEPLOYMENT.md`, `MONITORING.md`, `BACKUP_DR.md`, `SECRET_ROTATION.md`, `SAISIE_MANUELLE.md` | Runbooks | live |
| `APPLE_PLAN.md` | iOS roadmap | live, not started |
| `PRE_IOS_PLAN.md` | Completed web plan, kept because ~20 source files cite its decisions | completed (design record) |
| `AUDIT_SCALABILITE_COUTS.md`, `QA_TEST_PLAN.md`, `ml/REFACTOR_PLAN.md`, `LIVE_PREDICTIONS_PLAN.md` | Detailed plans behind §3.5–3.7 | live |
| `RAPPORT_TESTS_CHARGE_2026-09-18.md`, `loadtest/*` | Load-test report and procedure | reference |
| `loadtest/qa-dynamic/` | Dynamic QA script (local stack) behind §3.7 | live |
| `content/*` | Content engine docs | live |
| `AUDIT_PRE_FREEZE_IOS.md`, `PRODUCTION_READINESS_AUDIT.md` | Deleted 2026-09-24 (still in Git history); open items transferred here | removed |
| `RESTE_A_FAIRE.md` | Deleted 2026-09-16 in `4d1cbcd`; content transferred here | replaced by this file |
