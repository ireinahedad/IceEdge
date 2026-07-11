-- 015_refresh_remember.sql
-- Adds a "remember me" flag to refresh tokens so a persistent (long-lived)
-- session can be distinguished from a short one. Remembered tokens are issued
-- with a longer TTL and the flag is preserved across token rotation.
ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS remember BOOLEAN NOT NULL DEFAULT FALSE;
