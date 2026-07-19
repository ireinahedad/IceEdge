-- ============================================================
--  Migration 018 — Per-user minimum +EV threshold (Pro)
-- ============================================================
-- Minimum expected-value edge (in whole percent) a value bet must have before
-- the user is notified. 0 = notify on any positive edge. The value-bet scan
-- computes the edge once globally, then only pushes to users whose threshold is
-- met. Neutral and safe for everyone; only actionable by Pro subscribers.

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS value_bet_min_ev_pct SMALLINT NOT NULL DEFAULT 0;
