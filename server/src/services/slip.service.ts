import { pool } from '../db/connection';

// ─── XP & Tier config ─────────────────────────────────────────────────────────

const XP_SINGLE_WIN  = 50;
const XP_PARLAY_2_3  = 100;
const XP_PARLAY_4UP  = 250;

// Tier thresholds (minimum XP required)
const TIER_THRESHOLDS: Record<string, number> = {
  rookie:  0,
  analyst: 100,
  sharp:   500,
  legend:  1500,
};

// Ordered tiers lowest→highest
const TIER_ORDER = ['rookie', 'analyst', 'sharp', 'legend'] as const;
type Tier = typeof TIER_ORDER[number];

function tierForXp(xp: number): Tier {
  for (let i = TIER_ORDER.length - 1; i >= 0; i--) {
    if (xp >= TIER_THRESHOLDS[TIER_ORDER[i]]) return TIER_ORDER[i];
  }
  return 'rookie';
}

// ─── Submit slip ──────────────────────────────────────────────────────────────

export interface SlipLeg {
  marketType:   string;
  subjectId?:   string;
  subjectName:  string;
  subjectLogo:  string;
  selection?:   string;
  line?:        number;
  probability:  number;
  oddsLabel:    string;
}

export async function submitSlip(
  userId:              string,
  legs:                SlipLeg[],
  sport:               string = 'hockey',
  combinedProbability: number | null = null,
) {
  if (!legs.length) throw Object.assign(new Error('Slip must have at least one leg'), { status: 400 });
  if (legs.length > 12) throw Object.assign(new Error('Max 12 legs per slip'), { status: 400 });

  const isParlay = legs.length > 1;
  const combined =
    combinedProbability ??
    Math.round(legs.reduce((acc, l) => acc * (l.probability / 100), 1) * 100);

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO bet_slips
       (user_id, sport, legs, leg_count, is_parlay, combined_probability, outcome)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, 'pending')
     RETURNING id`,
    [userId, sport, JSON.stringify(legs), legs.length, isParlay, combined],
  );

  return rows[0].id;
}

// ─── List slips for a user ────────────────────────────────────────────────────

export async function getSlips(userId: string, limit = 50) {
  const { rows } = await pool.query(
    `SELECT id, placed_at AS "placedAt", sport,
            legs, leg_count AS "legCount", is_parlay AS "isParlay",
            combined_probability AS "combinedProbability",
            outcome, resolved_at AS "resolvedAt", xp_awarded AS "xpAwarded"
     FROM bet_slips
     WHERE user_id = $1
     ORDER BY placed_at DESC
     LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

// ─── Resolve slip (win | loss) + award XP ────────────────────────────────────

export async function resolveSlip(
  slipId:  string,
  outcome: 'win' | 'loss',
  userId:  string,
): Promise<{ xpAwarded: number; newXp: number; newTier: Tier; tieredUp: boolean }> {
  // Load the slip
  const { rows: slipRows } = await pool.query(
    `SELECT id, user_id, is_parlay, leg_count, outcome
     FROM bet_slips
     WHERE id = $1`,
    [slipId],
  );
  const slip = slipRows[0];
  if (!slip) throw Object.assign(new Error('Slip not found'), { status: 404 });
  if (slip.user_id !== userId) throw Object.assign(new Error('Forbidden'), { status: 403 });
  if (slip.outcome !== 'pending') throw Object.assign(new Error('Slip already resolved'), { status: 400 });

  // Calculate XP
  let xpAwarded = 0;
  if (outcome === 'win') {
    if (!slip.is_parlay) {
      xpAwarded = XP_SINGLE_WIN;
    } else if (slip.leg_count <= 3) {
      xpAwarded = XP_PARLAY_2_3;
    } else {
      xpAwarded = XP_PARLAY_4UP;
    }
  }

  // Update slip
  await pool.query(
    `UPDATE bet_slips
     SET outcome = $1, resolved_at = NOW(), xp_awarded = $2
     WHERE id = $3`,
    [outcome, xpAwarded, slipId],
  );

  // Get current XP + tier
  await pool.query(
    `INSERT INTO user_profiles (user_id, xp, tier, performance_score)
     SELECT id, 0, 'rookie', 0 FROM users WHERE id = $1
     ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );

  const { rows: profileRows } = await pool.query<{ xp: number; tier: string }>(
    `SELECT xp, tier FROM user_profiles WHERE user_id = $1`,
    [userId],
  );
  const profile = profileRows[0] ?? { xp: 0, tier: 'rookie' };
  const prevTier = profile.tier as Tier;
  const newXp    = (profile.xp ?? 0) + xpAwarded;
  const newTier  = tierForXp(newXp);
  const tieredUp = TIER_ORDER.indexOf(newTier) > TIER_ORDER.indexOf(prevTier);

  // Update XP + tier + performance_score
  await pool.query(
    `UPDATE user_profiles
     SET xp = $1, tier = $2, performance_score = $1
     WHERE user_id = $3`,
    [newXp, newTier, userId],
  );

  // Award tier badge if tiered up
  if (tieredUp) {
    const TIER_BADGES: Record<Tier, { label: string; icon: string; description: string }> = {
      analyst: { label: 'Analyst',      icon: '📊', description: 'Reached Analyst tier' },
      sharp:   { label: 'Sharp Bettor', icon: '🎯', description: 'Reached Sharp tier'   },
      legend:  { label: 'Legend',       icon: '👑', description: 'Reached Legend tier'  },
      rookie:  { label: 'Rookie',       icon: '🌱', description: 'Welcome!'             },
    };
    const badge = TIER_BADGES[newTier];
    await pool.query(
      `INSERT INTO user_badges (user_id, badge_id, label, description, icon, earned_at, tier)
       VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, $6)
       ON CONFLICT (user_id, badge_id) DO NOTHING`,
      [userId, `tier_${newTier}`, badge.label, badge.description, badge.icon, newTier],
    );
  }

  return { xpAwarded, newXp, newTier, tieredUp };
}

// ─── Get a single slip ────────────────────────────────────────────────────────

export async function getSlip(slipId: string, userId: string) {
  const { rows } = await pool.query(
    `SELECT id, placed_at AS "placedAt", sport,
            legs, leg_count AS "legCount", is_parlay AS "isParlay",
            combined_probability AS "combinedProbability",
            outcome, resolved_at AS "resolvedAt", xp_awarded AS "xpAwarded"
     FROM bet_slips
     WHERE id = $1 AND user_id = $2`,
    [slipId, userId],
  );
  if (!rows[0]) throw Object.assign(new Error('Slip not found'), { status: 404 });
  return rows[0];
}
