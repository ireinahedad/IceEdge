import 'dotenv/config';
import { pool } from './connection';
console.log(process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':********@'));

const SQL = `
-- XP column on user_profiles
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS xp INT NOT NULL DEFAULT 0;

-- bet_slips table
CREATE TABLE IF NOT EXISTS bet_slips (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  placed_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  sport                VARCHAR(20)  NOT NULL DEFAULT 'hockey',
  legs                 JSONB        NOT NULL DEFAULT '[]',
  leg_count            INT          NOT NULL DEFAULT 1,
  is_parlay            BOOLEAN      NOT NULL DEFAULT FALSE,
  combined_probability INT,
  outcome              bet_outcome  NOT NULL DEFAULT 'pending',
  resolved_at          TIMESTAMPTZ,
  xp_awarded           INT          NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_bet_slips_user    ON bet_slips(user_id);
CREATE INDEX IF NOT EXISTS idx_bet_slips_outcome ON bet_slips(outcome);
CREATE INDEX IF NOT EXISTS idx_bet_slips_placed  ON bet_slips(placed_at DESC);
`;

(async () => {
  try {
    console.log('[migrate] Connecting to DB...');
    await pool.query(SQL);
    console.log('[migrate] ✓ bet_slips table and xp column are ready');
  } catch (err: any) {
    console.error('[migrate] ✗ Failed:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
