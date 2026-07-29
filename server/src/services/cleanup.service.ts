/**
 * cleanup.service.ts
 * ------------------------------------------------------------------
 * M3 — DB housekeeping. Prunes rows that are safe to delete once expired so the
 * auth tables don't grow unbounded (which slowly degrades token/code lookups):
 *   • refresh_tokens          — expired, OR revoked more than a grace window ago
 *   • email_verification_codes — consumed, OR expired
 *
 * Runs once shortly after boot and then daily. Best-effort: a failed run is
 * logged and retried on the next tick, never crashes the process.
 */

import { pool } from '../db/connection';
import { logger } from '../logger';
import { withJobLock } from './jobLock';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Deux DELETE : quelques secondes au pire. TTL large pour absorber une base froide. */
const LOCK_TTL_MS = 10 * 60 * 1000;
// Keep revoked tokens for a short window (audit / debugging) before pruning.
const REVOKED_GRACE_DAYS = Number(process.env.TOKEN_CLEANUP_GRACE_DAYS) || 7;

export async function runCleanup(): Promise<{ tokens: number; codes: number }> {
  const tokensRes = await pool.query(
    `DELETE FROM refresh_tokens
      WHERE expires_at < NOW()
         OR (revoked = TRUE AND created_at < NOW() - ($1 || ' days')::interval)`,
    [String(REVOKED_GRACE_DAYS)],
  );
  const codesRes = await pool.query(
    `DELETE FROM email_verification_codes
      WHERE consumed = TRUE OR expires_at < NOW()`,
  );
  const tokens = tokensRes.rowCount ?? 0;
  const codes  = codesRes.rowCount ?? 0;
  return { tokens, codes };
}

/** Schedules the cleanup: once ~1 min after boot, then every 24h. Returns the
 *  interval handle so callers/tests can stop it. Errors are swallowed. */
export function startCleanupJob(): NodeJS.Timeout {
  // Le nettoyage est idempotent (DELETE conditionnels) : le verrou n'évite pas
  // une corruption, il évite que N instances fassent N fois le même DELETE au
  // même instant — soit N× le compute Neon pour un seul résultat utile.
  const tick = () => {
    withJobLock('cleanup', LOCK_TTL_MS, runCleanup)
      .catch((err) => logger.error({ err: err?.message }, '[cleanup] failed'));
  };
  setTimeout(tick, 60_000).unref();
  const handle = setInterval(tick, DAY_MS);
  handle.unref();
  return handle;
}
