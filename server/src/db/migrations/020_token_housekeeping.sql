-- 020_token_housekeeping.sql
-- M3 — DB housekeeping support.
-- Index refresh_tokens(expires_at) so the daily cleanup job (see
-- cleanup.service.ts) can prune expired/revoked rows without a full scan, and
-- so token-expiry lookups stay fast as the table grows.
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires
  ON refresh_tokens (expires_at);

-- Support pruning consumed / expired one-time codes efficiently.
CREATE INDEX IF NOT EXISTS idx_evc_expires
  ON email_verification_codes (expires_at);
