# ICEEDGE / ArakIce — Production Readiness & Scalability Audit

**Target:** ~1,000 active users, simple architecture, easy to scale later
**Date:** 2026-07-20
**Method:** Direct inspection of the actual codebase (server, client, ml, db). Every finding below cites real files. Where something is already done correctly, it is called out as such rather than re-recommended.

Priority scale: **Critical** (data loss / security / revenue / breaks under load) · **High** · **Medium** · **Low**
Difficulty: **Easy** (hours) · **Medium** (1–3 days) · **Hard** (week+)
Timing: **Before launch** · **Before 1k** · **Before 10k** · **Before 100k**

---

## Executive summary

This is a genuinely well-built codebase for its stage. The security fundamentals are strong: parameterized SQL throughout, bcrypt (cost 12), 15-minute JWTs with opaque rotating refresh tokens in an httpOnly cookie, email verification, account-enumeration protection, helmet, a CORS allowlist, tiered rate limiting, JWT-authenticated sockets with per-room access control, and production error sanitization. The database schema is clean (UUID PKs, FK cascades, `TIMESTAMPTZ`, ENUMs, sensible indexes including partial ones). The settlement engine is carefully written with per-run caching and double-settlement guards, and external NHL/Odds calls are already TTL-cached.

For **1,000 users on a single instance, the app is close to launch-ready.** The gaps that matter most are operational rather than architectural: **no error monitoring, no graceful shutdown, no automated tests or CI, a shallow health check, secrets committed to the repo, plaintext storage of user API keys, and a `/subscription/checkout` path that grants Pro for free.** None require re-architecting — they are additive.

The main thing standing between you and *horizontal* scaling is **shared state**: rate limiters, the NHL cache, and background-job scheduling all live in process memory. That is correct and simple for one instance, and the code is already structured (behind a `RateLimitStore` interface, with a stubbed Redis store) to swap in Redis when you add a second instance. You do not need to do that for 1k users.

---

## What is already done well (do NOT redo these)

- **SQL injection:** every query uses parameterized `$1, $2…` placeholders (`auth.service.ts`, `subscription.service.ts`, `chat` and `slip` services). No string interpolation into SQL. ✅
- **Password handling:** bcrypt with cost 12; hashes never returned (`toPublicUser` strips `password_hash`). ✅
- **Token model:** short-lived (15 min) access JWT + 64-byte random opaque refresh token, rotated on every refresh, revocable, stored server-side, delivered via httpOnly cookie scoped to `/api/auth`. `logout-all`, "remember me" TTLs. ✅ (`auth.service.ts`)
- **Auth hardening:** email verification gate, password reset revokes all sessions, forgot-password and resend don't reveal account existence, code attempt limits. ✅
- **HTTP hardening:** `helmet()`, CORS allowlist with explicit origins + a Vercel-preview regex, `trust proxy` in production, JSON body cap (5 MB). ✅ (`app.ts`)
- **Rate limiting:** three tiers (`apiLimiter` 300/min, `authLimiter` 15/15min counting only failures, `writeLimiter` 30/min) plus a per-user sliding-window limiter on chat actions. ✅
- **Realtime security:** sockets authenticate via JWT in the handshake; `join_room` checks `chatService.canRead` before subscribing, so private rooms never leak. ✅ (`socket.ts`)
- **DB access:** `pg` pool with configurable `max`, idle/connection timeouts, a pool error handler, and a startup connectivity check. ✅ (`db/connection.ts`)
- **Schema quality:** UUID PKs, `ON DELETE CASCADE`/`SET NULL` FKs, `TIMESTAMPTZ`, ENUM types, unique constraints, a partial index on unconsumed codes, `updated_at` trigger, and indexes on all the hot lookup columns (`bet_slips` on user/outcome/placed, `chat_messages` on room, etc.). ✅
- **Settlement job:** event-driven (polls only games referenced by pending slips → zero API calls when nothing is pending) with an hourly fallback, per-run caches, and an `UPDATE … WHERE outcome='pending'` guard against double settlement. ✅ (`settlement.service.ts`)
- **External API caching:** `nhlApiClient.ts` has an in-memory TTL cache with per-endpoint TTLs (30 s live, 5 min teams/games, 6 h final boxscores). ✅
- **Dev surface:** `/api/dev` requires `authenticate + requireRole('admin')` **and** isn't mounted at all in production unless `ENABLE_DEV_ROUTES=true`; the seed endpoint is dev-only. ✅
- **Error sanitization:** the global error handler hides 5xx internals in production. ✅
- **Frontend:** app is wrapped in an `ErrorBoundary`; Vercel config does SPA rewrite + immutable hashed-asset caching. ✅
- **Deployment:** multi-stage Docker build, production-only dependencies, `NODE_ENV=production`. ✅

---

## Critical — do before launch

| # | Recommendation | Why / Risk | Difficulty |
|---|---|---|---|
| C1 | **Rotate every secret and purge them from git history.** `PROJECT_CONTEXT.md` contains a real DB URL with password (`postgres:<REDACTED>@…`), and `.env` files exist on disk. | The password is in a committed doc. Anyone with repo access (now or in history) has your DB credentials, and reused passwords compound the blast radius. Generate a strong `JWT_SECRET`, new DB password, and rotate Google/Stripe/Resend/Odds keys. Move the connection string out of the markdown. | Easy |
| C2 | **Add graceful shutdown** (SIGTERM/SIGINT → stop accepting, `httpServer.close()`, `io.close()`, `pool.end()`). None exists in `server.ts`. | Every deploy/restart on Railway/Render kills in-flight requests and can interrupt a settlement mid-write. Required for zero-downtime deploys. | Easy |
| C3 | **Add error monitoring** (Sentry or equivalent) on both server and client. Today there are 49 `console.*` calls and no aggregation. | In production you will have **zero visibility** into crashes, unhandled rejections, or client white-screens. You'll be debugging blind. | Easy–Medium |
| C4 | **Fix the free-Pro hole OR wire Stripe.** `POST /api/subscription/checkout` with no `STRIPE_SECRET_KEY` calls `activateProDev()` and grants Pro to any authenticated user; `redeem`/`trial` also grant Pro without payment. | If you launch intending Pro to be paid, users get it for free. If you wire Stripe, the webhook **must** verify signatures (`STRIPE_WEBHOOK_SECRET`) before calling `upsert`. If launching Pro-free intentionally, this is fine — just be deliberate. | Medium |
| C5 | **Stop storing free-tier OpenAI keys in plaintext.** `user_profiles.openai_api_key TEXT` (migration 005) is stored and read back as clear text (`llm.routes.ts`). | A DB leak or backup exposure hands out users' OpenAI keys, which map to real billing. Encrypt at rest (app-level AES-GCM with a KMS/env key) or, better, don't persist them (prompt per session). | Medium |
| C6 | **Enable managed DB backups + document restore.** Confirm point-in-time recovery is on for your Postgres (Supabase/Railway) and write a one-page restore runbook. | Without verified backups, a bad migration or accidental delete is unrecoverable. Betting/XP history and accounts are irreplaceable. | Easy |

---

## High — do before launch or immediately after

| # | Recommendation | Why / Risk | Difficulty | Timing |
|---|---|---|---|---|
| H1 | **Deepen the health check.** `/health` returns `{status:'ok'}` without touching the DB. Add a `SELECT 1` (and optionally ML ping) and split liveness vs readiness. | A load balancer/orchestrator will route traffic to an instance whose DB is down because `/health` still says "ok". | Easy | Before launch |
| H2 | **Add uptime monitoring + alerting** (UptimeRobot / Better Stack) on `/health`, plus alerts from Sentry. | Right now you find out the app is down when a user tells you. | Easy | Before launch |
| H3 | **Introduce request validation at route boundaries** (zod). Validation today is ad-hoc `if (!name)`; types and sizes aren't checked. | Malformed/oversized payloads reach the DB and services. Notably the LLM `prompt` has **no length cap** → token-cost abuse; avatar base64 relies only on the 5 MB body limit. | Medium | Before launch |
| H4 | **Add LLM abuse controls:** per-user quota + a dedicated rate limit, a prompt-length cap, a `fetch` timeout via `AbortController`, and a retry/fallback. `llm.routes.ts` has none. | The Pro path bills **your** GitHub Models account. One user (or a leaked token) can run up cost or hang requests indefinitely (no timeout = tied-up connections). | Medium | Before launch |
| H5 | **Structured logging** (pino) with request IDs, replacing `console.*`. | At scale, unstructured console output is unsearchable and correlation across a request is impossible. | Easy–Medium | Before 1k |
| H6 | **Automated tests + CI.** There are **no tests** and **no `.github/workflows`**. Add smoke/integration tests for the money paths (auth, slip submit, settlement math) and a CI pipeline (typecheck → build → test). | The memory notes a build sandbox that truncates files and a previously corrupted type file — exactly the class of regression CI catches. No safety net for refactors. | Medium–Hard | Before 1k |
| H7 | **Harden the container:** run as non-root `USER`, add `HEALTHCHECK`, and use `tini`/`dumb-init` so Node gets signals (pairs with C2). Also fix `ml/python/Dockerfile` — `COPY ../models …` is outside the build context and will fail/no-op. | Root containers widen breach impact; missing init means SIGTERM isn't forwarded; the ML image likely never ships its models. | Easy | Before launch |
| H8 | **Store a hash of the refresh token, not the raw value.** `refresh_tokens.token` holds the raw 64-byte secret. | It's high-entropy (good), but a DB read leaks usable session tokens. Store `sha256(token)`; compare on lookup. | Easy–Medium | Before 10k |

---

## Medium — do as you approach 1k–10k

| # | Recommendation | Why / Risk | Difficulty | Timing |
|---|---|---|---|---|
| M1 | **Frontend code splitting / lazy routes.** The build is a single **750 KB** JS chunk (`client/dist/assets/index-*.js`); routes aren't `React.lazy`-loaded and heavy libs (recharts, motion, ogl/three) ship in the main bundle. | Slow first paint on mobile (the app is mobile-first). Split per route + `manualChunks` for the heavy libs. | Medium | Before 10k |
| M2 | **Migration versioning.** `migrate-all.ts` replays `schema.sql` + every file on each run, relying on `IF NOT EXISTS`. There's no `schema_migrations` ledger. | Works today, but it's fragile: a non-idempotent change or reordering silently corrupts state, and you can't tell what's applied. Adopt a tracking table or `node-pg-migrate`. | Medium | Before 10k |
| M3 | **DB housekeeping jobs.** Nothing prunes expired/revoked `refresh_tokens` or consumed `email_verification_codes`. | These tables grow unbounded; token lookups slowly degrade. Add a daily cleanup and an index on `refresh_tokens(expires_at)`. | Easy | Before 10k |
| M4 | **Wrap multi-write flows in transactions.** Register/Google-login do `INSERT user` then `ensureUserProfile` (and updates) as separate statements. | A failure between them leaves a user with no profile row (partially mitigated by later `ensureUserProfile` safety nets, but not clean). Use a single `pool` client + `BEGIN/COMMIT`. | Easy–Medium | Before 10k |
| M5 | **Stricter limits on sensitive auth-adjacent + promo endpoints.** `forgot-password`, `verify-email`, `resend` sit under `/api/auth` (covered by `authLimiter` ✅), but `/api/subscription/redeem` only has the broad `apiLimiter`. | Promo codes are brute-forceable at 300/min. Add a tight per-user/IP limit on `redeem`. | Easy | Before 1k |
| M6 | **Add a Content-Security-Policy** (helmet CSP on the API responses is limited value for a SPA; set CSP + security headers on the Vercel-served HTML). | Access token lives in `localStorage`, so XSS blast radius = session theft. React escapes by default, but CSP is defense-in-depth. | Medium | Before 10k |
| M7 | **Composite index for chat history pagination:** `chat_messages(room_id, sent_at DESC)`. Current index is `room_id` only. | Room history ordered by time will sort in memory as message volume grows. | Easy | Before 10k |

---

## Scaling to multiple instances (the one architectural theme)

Everything below is **correct and intentional for a single instance** and should NOT be changed for 1,000 users. It becomes necessary the moment you run **more than one** backend instance (for HA or load). The codebase is already shaped for this transition.

| # | Recommendation | Why / Risk | Difficulty | Timing |
|---|---|---|---|---|
| S1 | **Move rate-limit state to Redis.** Both `express-rate-limit` (in-memory default) and the chat `InMemoryRateLimitStore` are per-process. A `RedisRateLimitStore` stub already exists (`redisRateLimitStore.ts`) behind the `RateLimitStore` interface. | With N instances, effective limits become N× and reset on every deploy. The swap is one line per limiter thanks to the existing abstraction. | Medium | Before 10k / when >1 instance |
| S2 | **Shared cache in Redis.** `nhlApiClient` caches per-process, so each instance re-hits the NHL API. | Duplicated upstream calls; cache misses on every deploy. Back the cache with Redis when horizontal. | Medium | Before 10k |
| S3 | **Socket.IO Redis adapter** (`@socket.io/redis-adapter`). Currently a single in-process `io`; `io.to(room).emit` only reaches sockets on that instance. | With >1 instance, chat messages/`room_users` counts won't fan out across instances. | Medium | When >1 instance |
| S4 | **Single-owner background jobs.** `startSettlementJob` and `startValueBetScan` run `setInterval` in every process, and keep in-memory state (`knownFinal`, `lastAlertKey`). | On N instances they'd all poll the NHL API and scan in parallel (settlement writes are idempotent so no double-XP, but it's wasteful; value-bet pushes could duplicate). Elect a leader (Redis lock) or move jobs to a dedicated worker/queue (BullMQ). | Medium | Before 10k |
| S5 | **Connection pooling at the DB edge (PgBouncer / Supabase pooler).** Each instance opens up to `DB_POOL_MAX` connections. | Postgres connection limits are the classic wall when adding instances. Route through a transaction-mode pooler. | Medium | Before 100k |

---

## Area-by-area verdict

**Infrastructure** — Server is a stateless Express app *except* for the in-memory rate limiters, NHL cache, and interval jobs (see S1–S4). Reverse proxy / LB readiness is good (`trust proxy` set, health endpoint present but shallow — H1). Docker is multi-stage and lean but runs as root without an init or healthcheck (H7). No graceful shutdown (C2). Secrets via env/`.env` with a solid `.env.example`; but real secrets leaked into a committed doc (C1). Backups unverified (C6). DR runbook absent.

**Backend** — API is clean async/await with try/catch and consistent status codes. No obvious N+1: settlement batches with per-run caches, leaderboard is one query, value-bet scan caches per game. Pooling ✅. Caching ✅ for NHL. Gaps: validation (H3), LLM timeouts/quota (H4), logging (H5). Memory/CPU are fine at this scale; the ML inference is offloaded to a separate Python service (good decoupling).

**Database** — Schema quality is high (see "done well"). Missing pieces: housekeeping/retention (M3), migration ledger (M2), a couple of composite indexes (M7), and transactional multi-writes (M4). No archiving strategy yet — not needed until 100k (see roadmap).

**Auth & Security** — Among the strongest parts of the app. JWT/refresh/session model is correct and thoughtfully done. CSRF risk is low: state-changing calls use the `Authorization` header (not ambient cookies), and the refresh cookie is `sameSite=lax`, path-scoped. CORS is an allowlist. XSS: React escaping + helmet help; the residual risk is the `localStorage` access token (mitigate with CSP, M6). SQL injection: not present. Remaining items: raw refresh token storage (H8), plaintext OpenAI keys (C5), promo brute-force (M5).

**AI / LLM features** — Well-structured Pro/free key split with upstream-error sanitization and reasoning-model handling. Missing the operational guards that matter at scale: prompt-length cap, per-user quota, request timeout, retry/fallback (H4). Prompt-injection risk is low today (user's own prompt, output returned as text to the same user) — keep it that way by never rendering model output as HTML or feeding it into privileged logic. No prompt/embedding caching yet (a cost lever later, Low).

**Frontend** — Solid structure (context providers, services layer, `ErrorBoundary`). Main gap is bundle size / no code splitting (M1). Consider a per-route error boundary so one page crash doesn't blank the shell. Mobile-first `max-w-[430px]` is consistent. Accessibility and empty/loading-state polish are Low-priority follow-ups.

**Realtime** — Socket auth + room ACLs are correct. Disconnect cleanup recomputes room counts. For multi-instance, needs the Redis adapter (S3). Verify the client hook (`useChatSocket`) has reconnection/backoff (socket.io-client defaults are reasonable) and that listeners are removed on unmount to avoid leaks.

**Monitoring** — The biggest hole. No metrics, no error reporting, no uptime checks, shallow health, unstructured logs (C3, H1, H2, H5). This is the highest-leverage area to invest in before launch.

**DevOps** — No CI, no tests, no rollback strategy beyond redeploying a previous image, no explicit versioning (H6). Adding even a minimal GitHub Actions pipeline plus smoke tests dramatically de-risks changes.

**Code quality** — Consistent conventions, good comments explaining *why*, clear service boundaries. `PredictionPage.tsx` is flagged (by your own notes) as too long — worth splitting. The build-sandbox truncation quirk is documented in memory; keep builds/CI on a trusted machine.

**User experience** — Fallback-on-failure philosophy (mock data / null components) avoids hard crashes. Ensure error states are actually surfaced (not silently null) where the user needs feedback — the LLM banner fix is a good pattern to generalize.

---

## Staged roadmap

### 1) Must do before launch
- **C1** Rotate + purge all secrets from repo/history; strong `JWT_SECRET`.
- **C2** Graceful shutdown (SIGTERM → close HTTP/socket/pool).
- **C3** Error monitoring (Sentry) on server + client.
- **C4** Decide Pro monetization: wire Stripe with webhook signature verification, or deliberately gate/disable the free-Pro paths.
- **C5** Encrypt or stop persisting user OpenAI keys.
- **C6** Verify managed DB backups + restore runbook.
- **H1** DB-aware health check. **H2** Uptime + alerting. **H3** Request validation (start with auth + LLM + slips). **H4** LLM timeout + prompt cap + per-user limit. **H7** Non-root container, healthcheck, init; fix ML `COPY`.

### 2) Should do before 1,000 users
- **H5** Structured logging with request IDs.
- **H6** Minimal test suite (auth, slip submit, settlement math) + CI (typecheck/build/test).
- **M5** Tight limiter on promo `redeem`.
- Load-test the single instance (e.g. k6) at ~1k concurrent-ish traffic to size `DB_POOL_MAX` and instance resources.

### 3) Should do before 10,000 users
- **S1–S4** Introduce Redis: rate-limit store, shared NHL cache, Socket.IO adapter, single-owner background jobs — enabling a second instance behind the LB.
- **H8** Hash refresh tokens at rest.
- **M1** Frontend code splitting / lazy routes. **M2** Migration ledger. **M3** DB housekeeping + index. **M4** Transactional writes. **M6** CSP/security headers. **M7** Chat composite index.

### 4) Should do before 100,000 users
- **S5** DB connection pooler (PgBouncer/Supabase pooler) + evaluate read replicas for stats/leaderboard reads.
- Move background jobs to a dedicated worker + queue (BullMQ); consider autoscaling the web tier.
- Archiving/retention for `chat_messages` and settled `bet_slips` (partitioning or cold storage).
- Prompt/embedding caching for LLM cost control; CDN/image optimization for avatars.
- Formal DR drill (restore-from-backup rehearsal), SLOs, and dashboards.

---

*Scope note: this audit reviewed architecture, entrypoints, auth, DB schema/migrations, rate limiting, settlement/value-bet jobs, the LLM proxy, subscriptions, Docker/deploy config, and the client shell. It did not exhaustively read every prediction/stats service or the Python ML internals; those are lower-risk for production readiness but worth a follow-up pass for correctness before relying on them commercially.*
