-- ============================================================
--  Migration 003 — Bet Slips + XP
-- ============================================================

-- XP column on user_profiles
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS xp INT NOT NULL DEFAULT 0;

-- Main bet_slips table
-- Each slip holds the full legs array as JSONB so we don't need
-- a separate legs table, while still being queryable.
CREATE TABLE IF NOT EXISTS bet_slips (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  placed_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  sport                VARCHAR(20)  NOT NULL DEFAULT 'hockey',

  -- Array of leg objects: { marketType, subjectId, subjectName, subjectLogo,
  --   selection, line, probability, oddsLabel }
  legs                 JSONB        NOT NULL DEFAULT '[]',
  leg_count            INT          NOT NULL DEFAULT 1,
  is_parlay            BOOLEAN      NOT NULL DEFAULT FALSE,
  combined_probability INT,           -- rounded %

  outcome              bet_outcome  NOT NULL DEFAULT 'pending',
  resolved_at          TIMESTAMPTZ,
  xp_awarded           INT          NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_bet_slips_user    ON bet_slips(user_id);
CREATE INDEX IF NOT EXISTS idx_bet_slips_outcome ON bet_slips(outcome);
CREATE INDEX IF NOT EXISTS idx_bet_slips_placed  ON bet_slips(placed_at DESC);
