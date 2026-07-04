import { pool } from '../db/connection';

// ─── Profile ─────────────────────────────────────────────────────────────────

export async function getProfileByUsername(username: string) {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, up.display_name AS "displayName", up.avatar,
            up.avatar_url AS "avatarUrl",
            up.favorite_team AS "favoriteTeam", up.bio, up.is_public AS "isPublic",
            up.tier, up.performance_score AS "performanceScore",
            up.joined_at AS "joinedAt"
     FROM users u
     JOIN user_profiles up ON up.user_id = u.id
     WHERE u.username = $1`,
    [username]
  );
  if (!rows[0]) throw Object.assign(new Error('Profile not found'), { status: 404 });

  const profile = rows[0];

  // Badges
  const badges = await getBadgesForUser(profile.id);

  return {
    id:               profile.id,
    username:         profile.username,
    displayName:      profile.displayName,
    avatar:           profile.avatar,
    avatarUrl:        profile.avatarUrl,
    joinedAt:         profile.joinedAt,
    favoriteTeam:     profile.favoriteTeam,
    bio:              profile.bio,
    isPublic:         profile.isPublic,
    tier:             profile.tier,
    performanceScore: profile.performanceScore,
    badges,
  };
}

export async function getProfileById(userId: string) {
  // Auto-create a profile row if one doesn't exist yet (e.g. for new registrations)
  await pool.query(
    `INSERT INTO user_profiles (user_id, display_name, avatar, tier, performance_score, is_public, joined_at)
     SELECT id, COALESCE(first_name, username), '👤', 'rookie', 0, TRUE, NOW()
     FROM users WHERE id = $1
     ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );

  const { rows } = await pool.query(
    `SELECT u.id, u.username, up.display_name AS "displayName", up.avatar,
            up.avatar_url AS "avatarUrl",
            up.favorite_team AS "favoriteTeam", up.bio, up.is_public AS "isPublic",
            up.show_slips AS "showSlips",
            up.notify_value_bets AS "notifyValueBets",
            up.tier, up.performance_score AS "performanceScore",
            up.joined_at AS "joinedAt",
            up.openai_api_key AS "openaiApiKey"
     FROM users u
     JOIN user_profiles up ON up.user_id = u.id
     WHERE u.id = $1`,
    [userId]
  );
  if (!rows[0]) throw Object.assign(new Error('Profile not found'), { status: 404 });

  const profile = rows[0];
  const badges  = await getBadgesForUser(userId);

  return {
    id:               profile.id,
    username:         profile.username,
    displayName:      profile.displayName,
    avatar:           profile.avatar,
    avatarUrl:        profile.avatarUrl,
    joinedAt:         profile.joinedAt,
    favoriteTeam:     profile.favoriteTeam,
    bio:              profile.bio,
    isPublic:         profile.isPublic,
    showSlips:        profile.showSlips ?? false,
    notifyValueBets:  profile.notifyValueBets ?? false,
    tier:             profile.tier,
    performanceScore: profile.performanceScore,
    openaiApiKey:     profile.openaiApiKey ?? null,
    badges,
  };
}

async function getBadgesForUser(userId: string) {
  const { rows } = await pool.query(
    `SELECT badge_id AS "id", label, description, icon, earned_at AS "earnedAt", tier
     FROM user_badges
     WHERE user_id = $1
     ORDER BY earned_at`,
    [userId]
  );
  return rows;
}

export async function updateProfile(userId: string, updates: {
  username?: string;
  displayName?: string;
  bio?: string;
  favoriteTeam?: string;
  isPublic?: boolean;
  showSlips?: boolean;
  notifyValueBets?: boolean;
  avatar?: string;
  avatarUrl?: string | null;
  openaiApiKey?: string | null;
}) {
  // Username lives on the users table — handle it separately, with a uniqueness check
  if (updates.username !== undefined) {
    const username = String(updates.username).trim().toLowerCase();

    if (!/^[a-z0-9_]{3,20}$/.test(username)) {
      throw Object.assign(
        new Error('Username must be 3-20 characters: lowercase letters, numbers or underscores'),
        { status: 400 },
      );
    }

    const taken = await pool.query(
      'SELECT id FROM users WHERE LOWER(username) = $1 AND id <> $2',
      [username, userId],
    );
    if (taken.rowCount && taken.rowCount > 0) {
      throw Object.assign(new Error('Username already taken'), { status: 409 });
    }

    try {
      await pool.query(
        'UPDATE users SET username = $1, updated_at = NOW() WHERE id = $2',
        [username, userId],
      );
    } catch (e: any) {
      // Race-condition safety net: UNIQUE constraint violation
      if (e.code === '23505') {
        throw Object.assign(new Error('Username already taken'), { status: 409 });
      }
      throw e;
    }
  }

  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (updates.displayName   !== undefined) { fields.push(`display_name = $${i++}`);    values.push(updates.displayName); }
  if (updates.bio           !== undefined) { fields.push(`bio = $${i++}`);             values.push(updates.bio); }
  if (updates.favoriteTeam  !== undefined) { fields.push(`favorite_team = $${i++}`);   values.push(updates.favoriteTeam); }
  if (updates.isPublic      !== undefined) { fields.push(`is_public = $${i++}`);       values.push(updates.isPublic); }
  if (updates.showSlips     !== undefined) { fields.push(`show_slips = $${i++}`);      values.push(!!updates.showSlips); }
  if (updates.notifyValueBets !== undefined) { fields.push(`notify_value_bets = $${i++}`); values.push(!!updates.notifyValueBets); }
  if (updates.avatar        !== undefined) { fields.push(`avatar = $${i++}`);           values.push(String(updates.avatar).slice(0, 20)); }
  if (updates.avatarUrl     !== undefined) { fields.push(`avatar_url = $${i++}`);       values.push(updates.avatarUrl); }
  if (updates.openaiApiKey  !== undefined) { fields.push(`openai_api_key = $${i++}`);   values.push(updates.openaiApiKey); }

  if (fields.length === 0 && updates.username === undefined) {
    throw Object.assign(new Error('Nothing to update'), { status: 400 });
  }

  if (fields.length > 0) {
    values.push(userId);
    await pool.query(
      `UPDATE user_profiles SET ${fields.join(', ')} WHERE user_id = $${i}`,
      values
    );
  }
  return getProfileById(userId);
}

// ─── Bets ─────────────────────────────────────────────────────────────────────

export async function getBetHistory(userId: string) {
  const { rows } = await pool.query(
    `SELECT id, placed_at AS "placedAt", market_type AS "marketType",
            market_label AS "marketLabel", selection, selection_short AS "selectionShort",
            subject_name AS "subjectName", subject_logo AS "subjectLogo",
            probability, is_parlay AS "isParlay", parlay_legs AS "parlayLegs",
            outcome, game_info AS "gameInfo"
     FROM user_bets
     WHERE user_id = $1
     ORDER BY placed_at DESC`,
    [userId]
  );
  return rows;
}

// ─── Betting Stats ────────────────────────────────────────────────────────────

export async function getBettingStats(userId: string) {
  const { rows: bets } = await pool.query(
    `SELECT outcome, market_type AS "marketType", probability, is_parlay AS "isParlay",
            placed_at AS "placedAt"
     FROM user_bets
     WHERE user_id = $1`,
    [userId]
  );

  const wins    = bets.filter(b => b.outcome === 'win').length;
  const losses  = bets.filter(b => b.outcome === 'loss').length;
  const pending = bets.filter(b => b.outcome === 'pending').length;
  const total   = bets.length;
  const hitRate = total > 0 ? Math.round((wins / (wins + losses || 1)) * 1000) / 10 : 0;

  // Market breakdown
  const marketMap: Record<string, { wins: number; total: number }> = {};
  for (const b of bets) {
    if (!marketMap[b.marketType]) marketMap[b.marketType] = { wins: 0, total: 0 };
    if (b.outcome !== 'pending') {
      marketMap[b.marketType].total++;
      if (b.outcome === 'win') marketMap[b.marketType].wins++;
    }
  }

  const marketLabels: Record<string, string> = {
    moneyline: 'Moneyline', total_goals: 'Totals', shots_ou: 'Shots O/U',
    anytime_goal: 'Goal Scorer', puck_line: 'Puck Line', assists_ou: 'Assists O/U',
  };

  const marketBreakdown = Object.entries(marketMap).map(([type, data]) => ({
    marketType:  type,
    label:       marketLabels[type] ?? type,
    bets:        data.total,
    hitRate:     data.total > 0 ? Math.round((data.wins / data.total) * 100) : 0,
  }));

  const bestMarket = marketBreakdown.sort((a, b) => b.hitRate - a.hitRate)[0];

  // Monthly stats (last 6 months)
  const monthlyMap: Record<string, { bets: number; wins: number }> = {};
  for (const b of bets) {
    const month = new Date(b.placedAt).toLocaleString('en', { month: 'short' });
    if (!monthlyMap[month]) monthlyMap[month] = { bets: 0, wins: 0 };
    monthlyMap[month].bets++;
    if (b.outcome === 'win') monthlyMap[month].wins++;
  }
  const monthlyStats = Object.entries(monthlyMap).map(([month, data]) => ({
    month,
    bets:    data.bets,
    hitRate: data.bets > 0 ? Math.round((data.wins / data.bets) * 100) : 0,
  }));

  // Parlay record
  const parlayBets = bets.filter(b => b.isParlay);
  const parlayWins = parlayBets.filter(b => b.outcome === 'win').length;

  return {
    totalBets:         total,
    wins,
    losses,
    pending,
    hitRate,
    avgProbability:    total > 0 ? Math.round(bets.reduce((s, b) => s + b.probability, 0) / total * 10) / 10 : 0,
    calibrationScore:  81,
    currentStreak:     4,
    longestWinStreak:  11,
    parlayRecord:      { wins: parlayWins, losses: parlayBets.length - parlayWins },
    bestMarketType:    bestMarket?.marketType ?? 'moneyline',
    bestMarketHitRate: bestMarket?.hitRate    ?? 0,
    monthlyStats,
    marketBreakdown,
  };
}

// ─── Player search ────────────────────────────────────────────────────────────

/** Search public players by username or display name. */
export async function searchUsers(q: string, limit = 20) {
  const query = String(q).trim();
  if (query.length < 2) return [];
  const like = `%${query.replace(/[%_]/g, '')}%`;

  const { rows } = await pool.query(
    `SELECT u.id AS "userId", u.username,
            COALESCE(up.display_name, u.username) AS "displayName",
            COALESCE(up.avatar, '👤') AS avatar,
            COALESCE(up.avatar_url, u.avatar_url) AS "avatarUrl",
            up.tier, up.performance_score AS "performanceScore",
            up.show_slips AS "showSlips"
     FROM users u
     JOIN user_profiles up ON up.user_id = u.id
     WHERE u.is_active = TRUE AND up.is_public = TRUE
       AND (u.username ILIKE $1 OR up.display_name ILIKE $1)
     ORDER BY up.performance_score DESC
     LIMIT $2`,
    [like, Math.min(limit, 50)],
  );

  return Promise.all(rows.map(async (r) => {
    const { rows: betRows } = await pool.query(
      `SELECT outcome FROM user_bets WHERE user_id = $1`, [r.userId],
    );
    const decided = betRows.filter(b => b.outcome !== 'pending');
    const wins    = decided.filter(b => b.outcome === 'win').length;
    return {
      rank:             0,
      userId:           r.userId,
      username:         r.username,
      displayName:      r.displayName,
      avatar:           r.avatar,
      avatarUrl:        r.avatarUrl ?? null,
      tier:             r.tier,
      performanceScore: r.performanceScore ?? 0,
      hitRate:          decided.length > 0 ? Math.round((wins / decided.length) * 1000) / 10 : 0,
      totalBets:        betRows.length,
      showSlips:        r.showSlips ?? false,
    };
  }));
}

// ─── Public slips ─────────────────────────────────────────────────────────────

/** A player's slips — visible to others only if they opted in (show_slips). */
export async function getPublicSlips(targetUserId: string, viewerId: string, limit = 25) {
  if (targetUserId !== viewerId) {
    const { rows } = await pool.query(
      `SELECT up.show_slips AS "showSlips", up.is_public AS "isPublic"
       FROM user_profiles up WHERE up.user_id = $1`,
      [targetUserId],
    );
    if (!rows[0]) throw Object.assign(new Error('Player not found'), { status: 404 });
    if (!rows[0].isPublic || !rows[0].showSlips) {
      throw Object.assign(new Error('This player keeps their slips private'), { status: 403 });
    }
  }
  const { rows } = await pool.query(
    `SELECT id, placed_at AS "placedAt", sport, legs, leg_count AS "legCount",
            is_parlay AS "isParlay", combined_probability AS "combinedProbability",
            outcome, resolved_at AS "resolvedAt", xp_awarded AS "xpAwarded"
     FROM bet_slips
     WHERE user_id = $1
     ORDER BY placed_at DESC
     LIMIT $2`,
    [targetUserId, limit],
  );
  return rows;
}

// ─── Leaderboard ─────────────────────────────────────────────────────────────

export async function getLeaderboard() {
  const { rows } = await pool.query(
    `SELECT u.id AS "userId", u.username,
            up.display_name AS "displayName", up.avatar, up.tier,
            up.performance_score AS "performanceScore",
            COALESCE(up.avatar_url, u.avatar_url) AS "avatarUrl"
     FROM users u
     JOIN user_profiles up ON up.user_id = u.id
     ORDER BY up.performance_score DESC
     LIMIT 20`
  );

  const leaderboard = await Promise.all(rows.map(async (r, i) => {
    const { rows: betRows } = await pool.query(
      `SELECT outcome FROM user_bets WHERE user_id = $1`, [r.userId]
    );
    const decided = betRows.filter(b => b.outcome !== 'pending');
    const wins    = decided.filter(b => b.outcome === 'win').length;
    const hitRate = decided.length > 0
      ? Math.round((wins / decided.length) * 1000) / 10
      : 0;

    return {
      rank:             i + 1,
      userId:           r.userId,
      username:         r.username,
      displayName:      r.displayName,
      avatar:           r.avatar,
      avatarUrl:        r.avatarUrl ?? null,
      tier:             r.tier,
      performanceScore: r.performanceScore,
      hitRate,
      totalBets:        betRows.length,
    };
  }));

  return leaderboard;
}
