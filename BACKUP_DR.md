# Backup & Disaster Recovery Runbook

Scope: the PostgreSQL database is the only stateful, irreplaceable component. Everything else (server, client, ML service) is stateless and redeployable from git. NHL/odds data is re-fetchable from upstream APIs. **User accounts, profiles, bet slips, XP, chat, and subscriptions live only in Postgres — protect that.**

## Targets (proposed for ~1k users)

| Metric | Target | Meaning |
|---|---|---|
| **RPO** (max data loss) | ≤ 5 min | Point-in-time recovery, not just nightly dumps |
| **RTO** (max downtime) | ≤ 1 hour | Time to restore service after a disaster |
| Backup retention | **1 day** PITR on Neon (decided 2026-09-26; 7 days max on Launch, ~0.005 $/month at today's size) | A problem noticed more than 24 h later cannot be undone from Neon — the weekly off-provider dump (§2) is the only fallback |

## 1. Enable managed backups (do this now)

Production runs on **Neon** (see `DEPLOYMENT.md` §1) — confirm it's ON:

- **Neon (production):** Settings → History retention gives PITR by default; set the window to **≥ 7 days**. Branching also lets you restore into a throwaway branch and inspect before promoting.
- **Railway** (if you ever fall back to its Postgres plugin): daily snapshots only; enable/verify retention. No PITR.

> Whatever the host, confirm in the dashboard that at least one successful backup exists **today**. An unverified backup is not a backup.

## 2. Add an independent off-provider dump (defense in depth)

Managed backups protect against data corruption but not account loss or provider outage. Take a weekly logical dump to separate storage (e.g. S3/R2):

```bash
pg_dump "$DATABASE_URL" --format=custom --no-owner --file=iceedge-$(date +%F).dump
# upload iceedge-YYYY-MM-DD.dump to object storage with lifecycle expiry
```

Automate it (a scheduled job / GitHub Action with the connection string as a secret). Keep 4 weeks.

## 3. Restore procedure

**A. Point-in-time restore (data corruption / bad migration / accidental delete):**
1. In the host dashboard, choose *Restore* → pick a timestamp just before the incident.
2. Restore into a **new** database instance (never overwrite the live one blind).
3. Update `DATABASE_URL` on the server to point at the restored instance; redeploy.
4. Run smoke checks (below), then cut traffic over.

**B. From a logical dump (provider loss):**
```bash
# Provision a fresh Postgres, then:
pg_restore --no-owner --clean --if-exists --dbname="$NEW_DATABASE_URL" iceedge-YYYY-MM-DD.dump
# Re-apply any migrations newer than the dump:
cd server && npm run db:migrate:all
```

**C. Schema only (fresh environment):**
```bash
cd server && npm run db:migrate:all   # schema.sql + all migrations (idempotent)
```

## 4. Post-restore smoke checks

- [ ] `GET /health` returns 200 (liveness) and `GET /health/ready` returns 200 with `checks.db: "ok"` (readiness — runs `SELECT 1`; returns 503 if the DB is unreachable).
- [ ] A known user can log in.
- [ ] Bet-slip history and XP render for that user.
- [ ] Chat rooms + recent messages load.
- [ ] Pro user still shows Pro (`/subscription/me`).
- [ ] `ENCRYPTION_KEY` on the restored env matches the one used when the data was written (otherwise stored OpenAI keys won't decrypt).

## 5. Rehearse (before you rely on it)

Do a **restore drill** once before launch and quarterly after: restore the latest backup into a scratch database, run the smoke checks, and time it against the RTO. A backup you have never restored is a hope, not a plan.

### 5.1 Neon drill — step by step (Launch plan)

Neon facts (checked 2026-09-26, neon.com/docs/introduction/restore-window): the history
window is **1 day by default on Launch, 7 days maximum** (Scale: 30). Set it in
**Settings → Postgres → History window**. Retained history is billed at ~0.20 $/GB-month, on
top of normal storage.

1. **Settings → Postgres → History window**: check it is still **1 day** (the decided value).
2. Start a timer. **Branches → Create branch** from `production`, *Branch data and schema from a
   past point in time* ~1 h ago, name it `drill-YYYY-MM-DD`, keep *Auto-delete: after 1 day*.
3. **SQL Editor** → select the drill branch → run `server/scripts/restore-drill.sql`. Then the
   same on the production branch. Every count on the drill branch must be ≤ production and
   `last_migration` must match. Stop the timer: that is the restore time.
4. Leave the drill branch to auto-delete (its compute scales to zero after 5 min), or delete it.
5. Log the result below.

The production branch is **protected** (2026-09-26): an in-place Restore may ask you to unprotect it
first (Settings → General), then re-protect it. In a real incident, **Restore** on the production branch itself (Neon *instant restore*) keeps
the same connection string and saves the pre-restore state as a backup branch, so Railway's
`DATABASE_URL` does not change — only the §4 smoke checks are needed. Use a new branch + new
`DATABASE_URL` (§3.A) when you want to inspect before cutting over.

### 5.2 Rollback drill (app tier)

- **Railway** (project *harmonious-perception*, service `IceEdge`) → Deployments → ⋮ on the previous
  deployment → *Rollback*. It restores
  the **Docker image and the variables** of that deployment — a variable changed since is
  reverted too. Roll forward with ⋮ → *Rollback* on the newer deployment (reuses its image, no
  rebuild). Check the running banner, `/health/ready`, and `Clean shutdown complete` in the old
  container's log. Settings that make this work (set 2026-09-26): healthcheck path `/health/ready`,
  teardown draining 15 s — with draining 0 s the old container is killed before it can shut down.
- **Vercel** (project `ice-edge`) → Overview → Production Deployment → *Rollback* (Hobby: only to
  the immediately previous production deployment) → reason → *Continue* → *Confirm Rollback*.
  **After a rollback Vercel stops promoting new pushes to production** — the daily SEO Action's
  pages would silently stop going live. To undo on Hobby there is no "Undo Rollback" button on the
  tile: **Deployments → the newest deployment → ⋯ → Promote** (the dialog says *This action will
  undo the current Instant Rollback*). Done when the Overview shows again *To update your
  Production Deployment, push to the master branch.*
  Tabs opened on the other build get 404 on its lazy chunks; `main.tsx` reloads the page on
  `vite:preloadError`, so users just see one reload.

### 5.3 Drill log

| Date | What | Result | Time |
|---|---|---|---|
| 2026-09-26 | Neon history window | 6 h → 1 day (decided) | — |
| 2026-09-26 | Neon branch restore, production as of 05:04 UTC → `drill-2026-09-26` | Fork 0.62 s. `restore-drill.sql` identical on users (10), bet_slips (8), chat_messages (22), active Pro (3), migrations (37, last `037_bet_outcome_void.sql`), odds tables. Only refresh_tokens / email codes differ (cleanup job). **Pass** | ~2 min end to end |
| 2026-09-26 | Neon production branch protection | Enabled | — |
| 2026-09-26 | Railway rollback `d269448` → `c5c261f` → `d269448` | Each switch active < 10 s; 0 failed `/health/ready` out of 234 probes (1/s). **Pass** | < 10 s per switch |
| 2026-09-26 | Railway healthcheck + draining 15 s, redeploy | `SIGTERM received` → `Clean shutdown complete` (3 ms); 0 failed out of 152 probes. **Pass** | ~1.5 min build |
| 2026-09-26 | Vercel Instant Rollback `d269448` → `c5c261f`, then Promote `d269448` | arakice.com served the old entry (`index-DmgvMB2g.js`) ~8 s after confirming, the current one (`index-COmM-p6v.js`) ~7 s after Promote; 1 s of flapping between edges each time; 0 errors out of 211 probes (1/s). Auto-promotion back on. **Pass** | ~8 s each way |

## 6. Related risks tracked in the audit

- `ENCRYPTION_KEY` loss = permanent loss of stored OpenAI keys (users just re-enter them; not catastrophic, but note it).
- Migration ledger: done — `migrate-all.ts` records applied files in `schema_migrations`, so re-running `db:migrate:all` after a restore only applies what is missing.
- Restore drill and rollbacks (Neon, Railway, Vercel) first run 2026-09-26 (§5.3). Repeat quarterly.
