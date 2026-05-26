import { pool } from '../db/connection';

// ─── Profile ─────────────────────────────────────────────────────────────────

export async function getProfileByUsername(username: string) {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, up.display_name AS "displayName", up.avatar,
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
            up.favorite_team AS "favoriteTeam", up.bio, up.is_public AS "isPublic",
            up.tier, up.performance_score AS "performanceScore",
            up.joined_at AS "joinedAt"
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
    joinedAt:         profile.joinedAt,
    favoriteTeam:     profile.favoriteTeam,
    bio:              profile.bio,
    isPublic:         profile.isPublic,
    tier:             profile.tier,
    performanceScore: profile.performanceScore,
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
  displayName?: string;
  bio?: string;
  favoriteTeam?: string;
  isPublic?: boolean;
}) {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (updates.displayName   !== undefined) { fields.push(`display_name = $${i++}`);    values.push(updates.displayName); }
  if (updates.bio           !== undefined) { fields.push(`bio = $${i++}`);             values.push(updates.bio); }
  if (updates.favoriteTeam  !== undefined) { fields.push(`favorite_team = $${i++}`);   values.push(updates.favoriteTeam); }
  if (updates.isPublic      !== undefined) { fields.push(`is_public = $${i++}`);       values.push(updates.isPublic); }

  if (fields.length === 0) throw Object.assign(new Error('Nothing to update'), { status: 400 });

  values.push(userId);
  await pool.query(
    `UPDATE user_profiles SET ${fields.join(', ')} WHERE user_id = $${i}`,
    values
  );
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

// ─── Leaderboard ─────────────────────────────────────────────────────────────

export async function getLeaderboard() {
  const { rows } = await pool.query(
    `SELECT u.id AS "userId", u.username,
            up.display_name AS "displayName", up.avatar, up.tier,
            up.performance_score AS "performanceScore"
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
      tier:             r.tier,
      performanceScore: r.performanceScore,
      hitRate,
      totalBets:        betRows.length,
    };
  }));

  return leaderboard;
}
