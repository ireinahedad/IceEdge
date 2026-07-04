-- ============================================================
--  Migration 010 — Reuse verification codes for password reset
-- ============================================================
-- Adds a `purpose` discriminator to email_verification_codes so the same
-- table can hold both email-confirmation codes and password-reset codes.

ALTER TABLE email_verification_codes
  ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'email_verify';
-- purpose ∈ ('email_verify', 'password_reset')
