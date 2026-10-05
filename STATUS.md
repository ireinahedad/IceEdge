# ArakIce / ICEEDGE — Project status

**Single source of truth for what remains. Updated 2026-10-05 (finished work removed from all docs).**

Finished work is not kept here: it lives in the Git history. The last version that listed
everything done (§1 « DONE », §4 « No longer relevant ») is `git show 0916b52:STATUS.md`.

| Mark | Meaning |
|---|---|
| ✔ | Verified today in the code or the Git history |
| 📄 | Stated as done in the docs, but it lives in a console, in production or in a mailbox — could not be checked from the repo |

> **Rule of this file.** New work goes into §3. When something is finished, **delete its line**
> (the commit that finishes it is the record). Do not open a to-do list anywhere else (`PROJECT_CONTEXT.md`, audits, plans):
> two lists always drift apart. That is how `RESTE_A_FAIRE.md` got lost on 2026-09-16
> (deleted inside an unrelated commit, `4d1cbcd`).

---

## 0. Where things stand

- **The web app is live** on arakice.com: Vercel (front), Railway (Node + Python ML), Neon
  (Postgres), Cloudflare R2 (avatars), Cloudflare DNS/proxy. 📄
- **All the pre-iOS web work is shipped**; nothing blocks the launch or the iOS start
  (C1 on a real iPhone passed 2026-10-05).
- **iOS has not started, and the web is NOT frozen.** Tag the freeze point when iOS starts (§3.4).
- **The NHL 2026-27 regular season started on 2026-09-29** (84 games per team).

---

## 2. PARTIALLY DONE

| Item | What is done | What is missing |
|---|---|---|
| **Redis / multi-instance** | ✔ Socket.io adapter shipped and **active** (Redis service on Railway, `REDIS_URL` set — checked 2026-09-26) | `RedisRateLimitStore` not written; rate limiters are per process. Needed only before a 2nd instance. |
| **Cloudflare in front of the API** | 📄 Proxy and cache headers in place | Check that it actually caches what the headers allow. |
| **Budget alerts** | ✔ Thresholds written in `MONITORING.md` | Neon (6 $) and R2 (5 $) are set. Left: Railway usage limits, LLM provider hard limit, Stripe webhook failure alert, Sentry spend cap. |
| **Load testing** | ✔ In-process benches, all green | Real visitor latency against a pre-prod (`loadtest/s1-landing.js`) never run — there is no pre-prod. |
| **QA** | ✔ I1, I2 (6/7), static campaigns; ✔ dynamic campaign on a local stack (2026-09-26, 90/90) | What needs the real world: devices (C2–C3), Google (I4), Railway/Neon latency (P1, P2, P5), Neon restore drill (§3.7). |
| **Client tests** | ✔ `typecheck` in CI | No test runner in `client/`. The socket block filter (`visibleMessages` in `RoomChat`) has no guard. |
| **SEO match pages** | ✔ Generated and deployed daily | Link `/match` from the app (✔ nothing links to it), submit `sitemap-games.xml` in Search Console, translate `/matchup/`, `/props/` and hubs to French. |
| **Content engine** | ✔ Pipeline + daily recap copying to Google Drive | ✔ Recap files committed. Install the scheduled task (§3.11). |

---

## 3. STILL TO DO

### 3.2 At the start of the NHL 2026-27 season (started 2026-09-29)

- [ ] **SEO follow-up**: re-read indexing in Search Console around 2026-10-16 (click "Validate fix"
      on "Redirect error" if still listed); revise `client/scripts/props-allowlist.json` from that
      export (mirror every change in the exclusion regex of `client/vercel.json`).

### 3.3 At the first sale

- [ ] Vercel Pro (Hobby forbids commercial use).
- [ ] Sentry: move off the Developer plan if the monthly error quota gets close (Stats → Usage).
- [ ] Raise Railway's hard limit (25 $) and the GitHub Models budget (0 $ blocks Pro LLM calls).
- [ ] Verify Cloudflare caching in front of `api.arakice.com`.
- [ ] After launch: empty `PRO_PROMO_CODES`, redeploy, check an old code returns 400.

### 3.4 iOS app — `APPLE_PLAN.md` (nothing started)

- [ ] When iOS starts: `git tag pre-ios-freeze && git push origin pre-ios-freeze`, then Phase 0.

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

- [ ] **Odds backfill (A1), one range per month on the 1st, ≤ 10 000 credits each** (the key is shared
      with the app: display proxy up to ~4 300/month + collection ~300). Commands in
      `ml/REFACTOR_PLAN.md` §A1, all with `--odds-api-budget 10000 --odds-api-keep 6000`:
      2026-11-01 2023-24 part A (2023-10-10 → 2024-01-14, ~9 300) · 2026-12-01 2023-24 part B
      (2024-01-15 → 2024-04-18, ~9 000) · 2027-01-01 end of 2022-23 part A (2022-11-28 → 2023-02-12,
      ~7 200 — SBRO stops 2022-11-27, no source has it) · 2027-02-01 part B (2023-02-13 → 2023-04-14,
      ~6 300). Stopped by a cap → same command next month (cache = free). Then `build_dataset.py` and
      `--clv` / `--derived` on 4 modern seasons instead of 2.
- [ ] A2 puck-line rule stays frozen — **do not bet on it** until A1 or a season of live data.
- [ ] S4: γ (stretch λ gap) after the 2026-27 season; then measure ⑤ and demote the classifier.
      The six `base_prob` markets are ~7 pts too low on clear favourites — do not bet on them.
- [ ] A4 (goalie confirmation window) and A6 (team totals, OT, ±2.5) — after A1/A2.
- [ ] Re-train monthly during the season.
- [ ] **Weekly data refresh**: ✔ task installed (2026-10-05). After each run, commit + push `ml/models/inference_state.json`, `elo_ratings.json` and
      `level_layer.json` (goal-level k of the season).
- [ ] Re-run `live_pregame.py && measure_level.py` once 2026-27 is over (adds a season to the level
      measure), and re-run `server/scripts/replay-live.ts`: the 2 puck-drop totals cells should no
      longer be worse.
- [ ] Re-run `backtest_walkforward.py --correction --write-layer` after each retrain (the layer sits
      on the score model's output; a new model needs a new layer).

- [ ] **Live predictions — power play in progress** (not done, nothing invented): MoneyPuck shot files
      have no time-on-PP, so the PP multiplier cannot be measured from them. Needs penalties from the NHL
      play-by-play (`v1/gamecenter/{id}/play-by-play`, ~1 300 games/season), then the same exposure
      likelihood as `calibrate_live.py` and a replay. `situationCode` is checked (2026-09-30) and the game
      sheet already carries `situation.secondsRemaining`. Also not through the engine yet: P1/P2 cards,
      BTTS. Detail: `LIVE_PREDICTIONS_PLAN.md`.

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

✔ Everything that can run without the real world passed on 2026-09-26. What is left
needs a device, a third party or production:

- [ ] **After deploying the 2026-09-26 batch** (deployed; ✔ `Clean shutdown complete` in the Railway
      log since draining = 15 s): log in, refresh, log out on arakice.com (the rotation change); open
      `/stats/chart` once (new `react` chunk); trigger one 500 and check the Sentry event shows
      `authorization: [Filtered]` and `cookie: [Filtered]`.
- [ ] **C2–C3** on real devices: Android Chrome, desktop browsers, PWA push (C1 iPhone Safari ✔ 2026-10-05).
- [ ] **I4** Google OAuth end to end on the real domain. (✔ **I6** 2026-10-05 on the real NHL API, 34/34 — `loadtest/qa-dynamic/i6.ts`.)
- [ ] **P1 / P2 / P5 against Railway + Neon** (check `DATABASE_URL` uses `-pooler` first);
      **Lighthouse on arakice.com** — local LCP is still 3.5 s on simulated slow 4G.
- [ ] Re-run `npm run moderation:dry-run` once the chat has real traffic.

### 3.8 Technical deadlines

- [ ] `@sentry/node` 11 — later, not before its first patch releases. Its `dataCollection`
      default sends request bodies, cookies and SQL: set it explicitly when upgrading.

### 3.9 Cloudflare / accounts — all manual, in your own sessions

- [ ] R6 (optional) · *Full (strict)* for `arakice.com` and `www` only. First check that Vercel's
      certificate is valid behind the proxy: Vercel → Project → Settings → Domains shows both with
      a valid certificate, and `curl -vI https://arakice.com` shows a Let's Encrypt/Vercel cert
      issued < 90 days ago. Then Cloudflare → Rules → Configuration Rules → hostname
      `arakice.com` or `www.arakice.com` → SSL *Strict*. Leave the zone default on *Full*.
      **Never** for `api` (Railway).
- [ ] R8 (optional, not before launch) · `cdn.arakice.com` for R2 — together with an `UPDATE` of
      `avatar_url`, or not at all.

### 3.10 Low-priority code polish (post-freeze)

- Kept on purpose: two routers on `/api/users` (merge moves public URLs — after the iOS freeze,
  see `app.ts`) · server starting without a DB (readiness 503 keeps Railway from routing to it —
  correct) · `backdrop-filter` on the nav (measure on a device first) · friendship/following
  feature (own plan).

### 3.11 Content engine — `content/HANDOFF.md` §8

- [ ] Install the daily-recap scheduled task (`install-daily-recap.ps1`) — the files are committed.
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

---

### 3.13 Bet builder IA (natural-language slip) — leftovers
- [ ] Check migration 039 is on Neon (`npm run db:migrate:all` is idempotent — run it if unsure).
- [ ] On production, try the 6 real phrases with the real model: a team, a total, a player, a
      goalie, a double phrase, and one only the LLM understands (e.g. « Suzuki 3+ tirs »).

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

Carried over from `RESTE_A_FAIRE.md`, `PRE_IOS_PLAN.md` (deleted — `git show 0916b52:PRE_IOS_PLAN.md`) and the pre-freeze audit.

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
- User-facing French is in « vous » everywhere (decided 2026-10-05). Only admin pages
  (`/dev/*`) and text addressed to the model itself stay in « tu ».
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
  fallback, `sessionStillAlive`) — read R3bis.2 of `git show 0916b52:PRE_IOS_PLAN.md` before touching it.
  Never make the server rotation stricter without the client coalescing.
- Chat moderation decisions (reports cascade with the message, block routes have no
  `requireOwnerOrAdmin` on purpose, block list is one-way, hidden = hidden for the author
  too, socket not filtered server-side) — see R4 of `git show 0916b52:PRE_IOS_PLAN.md`.
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

| Document | Role |
|---|---|
| `STATUS.md` | This file — what remains |
| `PROJECT_CONTEXT.md` | Architecture, conventions, API, setup |
| `DEPLOYMENT.md`, `MONITORING.md`, `BACKUP_DR.md`, `SECRET_ROTATION.md`, `SAISIE_MANUELLE.md` | Runbooks |
| `APPLE_PLAN.md` | iOS roadmap (not started) |
| `AUDIT_SCALABILITE_COUTS.md`, `QA_TEST_PLAN.md`, `ml/REFACTOR_PLAN.md`, `LIVE_PREDICTIONS_PLAN.md` | Detail behind §3.5–3.7 — open items only |
| `ml/EXPLICATION_ML.md` | How every ML number is computed |
| `loadtest/*`, `loadtest/qa-dynamic/` | Load-test and dynamic QA procedures |
| `content/*` | Content engine docs |

**Finished documents are deleted; Git keeps them.** Code comments still cite some of them — read
them with `git show <commit>:<path>`:

| Document | Read it with |
|---|---|
| `PRE_IOS_PLAN.md` (web work before iOS: R2–R7, R3bis auth, R4 chat moderation) | `git show 0916b52:PRE_IOS_PLAN.md` |
| `SLIP_COMMANDE_PLAN.md` (Bet builder IA design) | `git show 0916b52:SLIP_COMMANDE_PLAN.md` |
| `RAPPORT_TESTS_CHARGE_2026-09-18.md` (load-test report) | `git show 0916b52:RAPPORT_TESTS_CHARGE_2026-09-18.md` |
| `ml/INCOHERENCES_ML.md` (21 ML train/serve fixes, « INCOHERENCES_ML §N ») | `git show ad0eba9:ml/INCOHERENCES_ML.md` |
| Full versions of the trimmed plans, `STATUS.md` §1 « DONE » | `git show 0916b52:<path>` |
| `AUDIT_PRE_FREEZE_IOS.md`, `PRODUCTION_READINESS_AUDIT.md` | deleted 2026-09-24 |
| `RESTE_A_FAIRE.md` | `git show 4d1cbcd~1:RESTE_A_FAIRE.md` |
