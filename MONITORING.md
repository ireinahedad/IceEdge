# Monitoring & Alerting (H2)

Goal: find out the app is down from a monitor, not from a user. Two layers —
uptime checks on the health endpoints, and error alerts from Sentry.

## Endpoints

The API exposes two health routes (see `server/src/app.ts`):

- `GET /health` — **liveness**. Returns `200 {"status":"ok"}` with no
  dependencies. Use this for the orchestrator's restart probe.
- `GET /health/ready` — **readiness**. Returns
  `200 {"status":"ok","checks":{"db":"ok"},"cached":false}` when Postgres is
  reachable, or `503 {"status":"unavailable","checks":{"db":"down"}}` when it
  isn't. Use this for uptime monitoring and the load balancer's routing probe.
  A successful `SELECT 1` is cached for `READINESS_DB_TTL_MS` (10 min by
  default); `"cached":true` means the answer came from that cache rather than a
  fresh round-trip. Failures are never cached, so an outage and a recovery are
  both seen at the real probe cadence.

The Python ML service exposes `GET /health`.

## Uptime monitoring (UptimeRobot or Better Stack)

Create HTTP(S) monitors, **5 min interval** (not 1 min — see the note on Neon
below):

1. **API readiness** — `https://<backend>/health/ready`, expect HTTP `200`.
   This is the important one: it goes red if the DB is down even while the
   process is up.
2. **API liveness** — `https://<backend>/health`, expect `200`. Distinguishes
   "process dead" from "DB down".
3. **ML service** — `https://<ml>/health`, expect `200`.
4. **Frontend** — `https://<vercel-domain>/`, expect `200`.

Set alert contacts (email/SMS/Slack) on each monitor. In Better Stack you can
assert on the response body (`"db":"ok"`) for a stricter readiness check.

## Sentry alerts

Sentry is already wired (`server/src/instrument.ts`, activated when
`SENTRY_DSN` is set). Add alert rules in the Sentry project:

- Notify on a **new** issue (first occurrence of an unseen error).
- Notify when an issue's **event rate spikes** (e.g. > N events / minute).
- Route to the same Slack/email channel as the uptime alerts.

## Notes

- Health probes are excluded from request logging (see `logger.ts`) so they
  don't flood logs.
- **Probe interval vs. Neon scale-to-zero.** Neon suspends the compute after
  5 min of inactivity and the free plan only covers 100 CU-hours/month — less
  than a calendar month of always-on compute. An uncached `SELECT 1` every
  1–5 min would keep the database awake permanently and blow that budget, so
  `/health/ready` caches successful checks for `READINESS_DB_TTL_MS` (10 min).
  Keep the monitor at 5 min: it detects a dead process or a dead HTTP surface
  immediately, and a DB outage within at most 10 min. Real user traffic fails
  instantly and surfaces through Sentry, so the cache does not hide a
  user-visible outage. See `DEPLOYMENT.md` § "Budget compute".
