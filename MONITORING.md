# Monitoring & Alerting (H2)

Goal: find out the app is down from a monitor, not from a user. Two layers —
uptime checks on the health endpoints, and error alerts from Sentry.

## Endpoints

The API exposes two health routes (see `server/src/app.ts`):

- `GET /health` — **liveness**. Returns `200 {"status":"ok"}` with no
  dependencies. Use this for the orchestrator's restart probe.
- `GET /health/ready` — **readiness**. Runs `SELECT 1`; returns
  `200 {"status":"ok","checks":{"db":"ok"}}` when Postgres is reachable, or
  `503 {"status":"unavailable","checks":{"db":"down"}}` when it isn't. Use this
  for uptime monitoring and the load balancer's routing probe.

The Python ML service exposes `GET /health`.

## Uptime monitoring (UptimeRobot or Better Stack)

Create HTTP(S) monitors, 1–5 min interval:

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
- `/health/ready` opens a short DB round-trip on each hit; a 1–5 min interval is
  fine, sub-10s intervals are unnecessary load.
