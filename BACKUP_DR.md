# Backup & Disaster Recovery Runbook

Scope: the PostgreSQL database is the only stateful, irreplaceable component. Everything else (server, client, ML service) is stateless and redeployable from git. NHL/odds data is re-fetchable from upstream APIs. **User accounts, profiles, bet slips, XP, chat, and subscriptions live only in Postgres — protect that.**

## Targets (proposed for ~1k users)

| Metric | Target | Meaning |
|---|---|---|
| **RPO** (max data loss) | ≤ 5 min | Point-in-time recovery, not just nightly dumps |
| **RTO** (max downtime) | ≤ 1 hour | Time to restore service after a disaster |
| Backup retention | ≥ 7 days PITR + 30-day daily snapshots | |

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

## 6. Related risks tracked in the audit

- `ENCRYPTION_KEY` loss = permanent loss of stored OpenAI keys (users just re-enter them; not catastrophic, but note it).
- No migration ledger yet (audit item M2) — after a restore, re-running `db:migrate:all` relies on idempotent `IF NOT EXISTS` guards. Adopt a tracking table to make restores deterministic.
