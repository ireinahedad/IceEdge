-- 021_refresh_token_hash.sql
-- H8 — Store a SHA-256 hash of the refresh token instead of the raw secret.
-- From this migration on, auth.service stores sha256(token) (64 hex chars) and
-- looks tokens up by hash. Pre-existing rows hold the RAW 64-byte token (128 hex
-- chars) and can no longer be matched, so we revoke them; affected users simply
-- re-authenticate. Filtering on length(token)=128 keeps this idempotent — it
-- only ever touches legacy raw rows, never the new hashed ones (length 64).
UPDATE refresh_tokens
   SET revoked = TRUE
 WHERE revoked = FALSE
   AND length(token) = 128;
