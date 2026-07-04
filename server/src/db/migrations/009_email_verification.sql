-- ============================================================
--  Migration 009 — Email verification for password sign-ups
-- ============================================================
-- Adds an `email_verified` flag on users and a table that stores
-- short-lived, single-use confirmation codes sent by email.
-- Google / OAuth accounts are considered verified on creation.

-- 1. Flag on the users table -------------------------------------------------
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;

-- Existing Google accounts (google_id set) are already trusted.
UPDATE users SET email_verified = TRUE WHERE google_id IS NOT NULL;

-- 2. Verification codes ------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_verification_codes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT        NOT NULL,            -- bcrypt hash of the 6-digit code
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed    BOOLEAN     NOT NULL DEFAULT FALSE,
  attempts    INT         NOT NULL DEFAULT 0,  -- failed verification attempts
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_evc_user_active
  ON email_verification_codes (user_id)
  WHERE consumed = FALSE;
