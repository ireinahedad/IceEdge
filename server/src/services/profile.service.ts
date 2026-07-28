import { pool } from '../db/connection';
import { encryptSecret, decryptSecret } from './crypto.util';
import { TtlCache } from './ttlCache';

// ─── Statistiques de paris (agrégation partagée) ─────────────────────────────

interface BetStats { decided: number; wins: number; total: number }

const EMPTY_BET_STATS: BetStats = { decided: 0, wins: 0, total: 0 };

/**
 * Compte les paris de PLUSIEURS utilisateurs en une seule requête agrégée.
 *
 * Remplace le N+1 qui faisait une requête `SELECT outcome FROM user_bets
 * WHERE user_id = $1` par utilisateur affiché, puis comptait en JavaScript :
 * 21 allers-retours Postgres pour un leaderboard de 20, et tout l'historique
 * de paris rapatrié à chaque appel pour produire deux entiers.
 *
 * Ici le comptage est fait par Postgres et seule une ligne par utilisateur
 * transite. Sert le leaderboard et la recherche de joueurs.
 *
 * Un utilisateur sans aucun pari n'apparaît pas dans le GROUP BY — l'appelant
 * retombe sur EMPTY_BET_STATS (même résultat qu'avant : hitRate 0, total 0).
 *
 * `outcome` est nullable : un NULL n'est compté ni dans `decided` ni dans
 * `wins` (un pari sans issue n'est pas tranché). L'ancien code JS comptait un
 * NULL comme tranché-mais-perdu, ce qui faussait le taux de réussite à la
 * baisse ; en pratique la colonne est toujours renseignée.
 */
async function fetchBetStats(userIds: string[]): Promise<Map<string, BetStats>> {
  const stats = new Map<string, BetStats>();
  if (userIds.length === 0) return stats;

  const { rows } = await pool.query(
    `SELECT user_id AS "userId",
            COUNT(*) FILTER (WHERE outcome <> 'pending') AS decided,
            COUNT(*) FILTER (WHERE outcome = 'win')      AS wins,
            COUNT(*)                                     AS total
       FROM user_bets
      WHERE user_id = ANY($1::uuid[])
      GROUP BY user_id`,
    [userIds],
  );

  // COUNT(*) revient en bigint → chaîne côté pg ; Number() la normalise.
  for (const r of rows) {
    stats.set(String(r.userId), {
      decided: Number(r.decided),
      wins:    Number(r.wins),
      total:   Number(r.total),
    });
  }
  return stats;
}

/** Taux de réussite en pourcentage, une décimale (0 si aucun pari tranché). */
function hitRateOf(s: BetStats): number {
  return s.decided > 0 ? Math.round((s.wins / s.decided) * 1000) / 10 : 0;
}

// ─── Profile ─────────────────────────────────────────────────────────────────

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
            up.value_bet_min_ev_pct AS "valueBetMinEvPct",
            up.tier, up.performance_score AS "performanceScore",
            up.joined_at AS "joinedAt",
            up.openai_api_key AS "openaiApiKey",
            up.rule_weights AS "ruleWeights"
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
    valueBetMinEvPct: profile.valueBetMinEvPct ?? 0,
    tier:             profile.tier,
    performanceScore: profile.performanceScore,
    // Stored encrypted at rest — decrypt for the owner (legacy plaintext passes through).
    openaiApiKey:     profile.openaiApiKey ? decryptSecret(profile.openaiApiKey) : null,
    ruleWeights:      profile.ruleWeights ?? null,
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
  valueBetMinEvPct?: number;
  avatar?: string;
  avatarUrl?: string | null;
  openaiApiKey?: string | null;
  ruleWeights?: Record<string, number> | null;
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
  if (updates.valueBetMinEvPct !== undefined) {
    // Clamp to a sane 0–50 % range; ignore non-numeric input.
    const pct = Math.round(Number(updates.valueBetMinEvPct));
    const safe = Number.isFinite(pct) ? Math.min(50, Math.max(0, pct)) : 0;
    fields.push(`value_bet_min_ev_pct = $${i++}`); values.push(safe);
  }
  if (updates.avatar        !== undefined) { fields.push(`avatar = $${i++}`);           values.push(String(updates.avatar).slice(0, 20)); }
  if (updates.avatarUrl     !== undefined) { fields.push(`avatar_url = $${i++}`);       values.push(updates.avatarUrl); }
  if (updates.openaiApiKey  !== undefined) { fields.push(`openai_api_key = $${i++}`);   values.push(updates.openaiApiKey == null ? null : encryptSecret(updates.openaiApiKey)); }
  if (updates.ruleWeights   !== undefined) { fields.push(`rule_weights = $${i++}`);      values.push(updates.ruleWeights === null ? null : JSON.stringify(updates.ruleWeights)); }

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

/**
 * URL d'avatar courante d'un utilisateur.
 * Sert à supprimer l'objet précédent sur R2 quand l'avatar est remplacé.
 */
export async function getAvatarUrl(userId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT COALESCE(up.avatar_url, u.avatar_url) AS "avatarUrl"
       FROM users u
       LEFT JOIN user_profiles up ON up.user_id = u.id
      WHERE u.id = $1`,
    [userId],
  );
  return rows[0]?.avatarUrl ?? null;
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

  // Une seule requête agrégée pour tous les résultats (au lieu d'une par joueur).
  const stats = await fetchBetStats(rows.map((r) => String(r.userId)));

  return rows.map((r) => {
    const s = stats.get(String(r.userId)) ?? EMPTY_BET_STATS;
    return {
      rank:             0,
      userId:           r.userId,
      username:         r.username,
      displayName:      r.displayName,
      avatar:           r.avatar,
      avatarUrl:        r.avatarUrl ?? null,
      tier:             r.tier,
      performanceScore: r.performanceScore ?? 0,
      hitRate:          hitRateOf(s),
      totalBets:        s.total,
      showSlips:        r.showSlips ?? false,
    };
  });
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

export interface LeaderboardEntry {
  rank:             number;
  userId:           string;
  username:         string;
  displayName:      string | null;
  avatar:           string | null;
  avatarUrl:        string | null;
  tier:             string | null;
  performanceScore: number;
  hitRate:          number;
  totalBets:        number;
}

/**
 * Cache 60 s du classement complet.
 *
 * L'endpoint `/api/leaderboard` est public et non authentifié : sans cache,
 * chaque visiteur déclenchait 21 allers-retours Postgres. Le classement est
 * identique pour tout le monde et n'a pas besoin d'être à la seconde — une
 * exécution par minute suffit, quel que soit le trafic. `wrap` dédoublonne en
 * prime les requêtes concurrentes sur un cache froid.
 *
 * Le tableau retourné est partagé entre appelants — il ne doit pas être muté.
 */
const LEADERBOARD_TTL = 60_000;
const leaderboardCache = new TtlCache<LeaderboardEntry[]>(LEADERBOARD_TTL, 1);

export async function getLeaderboard(): Promise<LeaderboardEntry[]> {
  return leaderboardCache.wrap('top20', computeLeaderboard);
}

/** Invalidation manuelle (tests, règlement de paris). */
export function clearLeaderboardCache(): void {
  leaderboardCache.clear();
}

async function computeLeaderboard(): Promise<LeaderboardEntry[]> {
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

  // 21 requêtes → 2 : le comptage des paris est fait par Postgres, en une fois.
  const stats = await fetchBetStats(rows.map((r) => String(r.userId)));

  return rows.map((r, i) => {
    const s = stats.get(String(r.userId)) ?? EMPTY_BET_STATS;
    return {
      rank:             i + 1,
      userId:           r.userId,
      username:         r.username,
      displayName:      r.displayName,
      avatar:           r.avatar,
      avatarUrl:        r.avatarUrl ?? null,
      tier:             r.tier,
      performanceScore: r.performanceScore,
      hitRate:          hitRateOf(s),
      totalBets:        s.total,
    };
  });
}
