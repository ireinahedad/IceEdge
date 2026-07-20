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

const DAY_MS = 24 * 60 * 60 * 1000;
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
  if (tokens || codes) {
    console.log(`[cleanup] pruned ${tokens} refresh token(s), ${codes} verification code(s)`);
  }
  return { tokens, codes };
}

/** Schedules the cleanup: once ~1 min after boot, then every 24h. Returns the
 *  interval handle so callers/tests can stop it. Errors are swallowed. */
export function startCleanupJob(): NodeJS.Timeout {
  const tick = () => { runCleanup().catch((err) => console.error('[cleanup] failed:', err?.message)); };
  setTimeout(tick, 60_000).unref();
  const handle = setInterval(tick, DAY_MS);
  handle.unref();
  return handle;
}
