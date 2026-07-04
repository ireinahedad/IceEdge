-- ============================================================
--  Migration 012 — Value-bet notification preference (Pro)
-- ============================================================
-- Per-user toggle for receiving value-bet (+EV) notifications. The toggle is
-- only actionable by Pro subscribers (enforced in the app), but the column is
-- neutral and safe for everyone.

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS notify_value_bets BOOLEAN NOT NULL DEFAULT FALSE;
