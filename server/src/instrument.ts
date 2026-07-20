/**
 * instrument.ts — Sentry initialisation.
 *
 * MUST be imported before anything else in server.ts (right after
 * `dotenv/config`) so Sentry can auto-instrument HTTP, Express and pg.
 *
 * No-op when SENTRY_DSN is unset, so local dev and CI stay quiet.
 * Configure with:
 *   SENTRY_DSN=...                       (from your Sentry project settings)
 *   SENTRY_TRACES_SAMPLE_RATE=0.1        (fraction of requests traced; optional)
 */

import * as Sentry from '@sentry/node';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE) || 0.1,
    // Don't send PII by default.
    sendDefaultPii: false,
  });
  console.log('[Sentry] initialised');
}
