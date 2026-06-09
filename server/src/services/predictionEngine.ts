/**
 * predictionEngine.ts
 * Real probability estimates using live NHL Stats API data.
 *
 * Team markets  → Log5 formula (win% from standings)
 * Player props  → Poisson distribution (per-game rates from player stats)
 * Futures       → Standings-rank-based prior
 */
import { fetchTeams, fetchPlayerById } from './nhlApiClient';

// ── Math helpers ──────────────────────────────────────────────────────────────

/**
 * Log5 (Bill James): P(A beats B) given their independent win rates as fractions.
 * Handles edge cases where either rate is 0 or 1.
 */
function log5(wA: number, wB: number): number {
  const d = wA + wB - 2 * wA * wB;
  if (d === 0) return 0.5;
  return (wA - wA * wB) / d;
}

/**
 * Poisson P(X > line) — supports half-integer lines (e.g. 2.5).
 * P(X > line) = 1 - P(X <= floor(line))
 */
function poissonOver(lambda: number, line: number): number {
  const k = Math.floor(line);
  let cdf = 0;
  let term = Math.exp(-lambda);
  for (let i = 0; i <= k; i++) {
    cdf += term;
    term = (term * lambda) / (i + 1);
  }
  return Math.max(0.02, Math.min(0.98, 1 - cdf));
}

function poissonUnder(lambda: number, line: number): number {
  return 1 - poissonOver(lambda, line);
}

/** Clamp [3, 97] and return as integer percentage */
function pct(p: number): number {
  return Math.round(Math.max(3, Math.min(97, p * 100)));
}

// ── Team lookup ───────────────────────────────────────────────────────────────

export async function getTeam(id: string): Promise<any | null> {
  const teams = await fetchTeams();
  const norm = id.toLowerCase();
  return (
    teams.find(
      (t: any) =>
        t.id?.toLowerCase() === norm ||
        t.abbreviation?.toLowerCase() === norm
    ) ?? null
  );
}

// ── Moneyline & game markets ──────────────────────────────────────────────────

/**
 * Moneyline win probability using Log5 + home-ice adjustment.
 * teamId     = the team we're predicting for
 * opponentId = opponent (optional; defaults to league-average opponent)
 * isHome     = whether teamId has home ice
 */
export async function predictMoneyline(
  teamId: string,
  opponentId?: string,
  isHome = true
): Promise<number> {
  const [team, opp] = await Promise.all([
    getTeam(teamId),
    opponentId ? getTeam(opponentId) : null,
  ]);

  const wA = (team?.winPct ?? 50) / 100;
  const wB = (opp?.winPct  ?? 50) / 100;

  let p = log5(wA, wB);
  // Home-ice advantage: historically ~3 percentage points in NHL
  if (isHome) p = Math.min(0.95, p + 0.03);

  return pct(p);
}

/**
 * Over/Under total goals using combined Poisson.
 * λ = homeTeam.goalsForPerGame + awayTeam.goalsForPerGame
 */
export async function predictTotalGoals(
  line: number,
  selection: string,
  teamId?: string,
  opponentId?: string
): Promise<number> {
  const [team, opp] = await Promise.all([
    teamId     ? getTeam(teamId)     : null,
    opponentId ? getTeam(opponentId) : null,
  ]);

  // League average is ~6.0 combined goals/game; use 3.0 per side as default
  const homeGoals = team?.goalsForPerGame ?? 3.0;
  const awayGoals = opp?.goalsForPerGame  ?? 3.0;
  const lambda    = homeGoals + awayGoals;

  return pct(
    selection === 'over'
      ? poissonOver(lambda, line)
      : poissonUnder(lambda, line)
  );
}

/**
 * Puck line (-1.5): rough adjustment on moneyline.
 * In practice: favourite covers -1.5 roughly 55–65% as often as they win outright.
 * We apply a 0.60 multiplier to the moneyline probability.
 */
export async function predictPuckLine(
  teamId: string,
  opponentId?: string,
  isHome = true
): Promise<number> {
  const ml = await predictMoneyline(teamId, opponentId, isHome);
  return Math.max(5, Math.round(ml * 0.62));
}

// ── Player prop markets ───────────────────────────────────────────────────────

/** Anytime goal scorer: P(X >= 1) = 1 - e^(-λ) where λ = goals/game */
export async function predictAnytimeGoal(playerId: string): Promise<number> {
  const player = await fetchPlayerById(playerId);
  const lambda =
    player.gamesPlayed > 0
      ? player.goals / player.gamesPlayed
      : 0.25; // league avg forward
  return pct(1 - Math.exp(-lambda));
}

/** First goal scorer: much harder — roughly anytime / ~4 (average 6+ scorers/game) */
export async function predictFirstGoalScorer(playerId: string): Promise<number> {
  const anytime = await predictAnytimeGoal(playerId);
  return Math.max(3, Math.round(anytime / 4.5));
}

/** Shots on goal O/U using real shots/game */
export async function predictShotsOU(
  playerId: string,
  line: number,
  selection: string
): Promise<number> {
  const player = await fetchPlayerById(playerId);
  const lambda =
    player.gamesPlayed > 0 ? player.shots / player.gamesPlayed : 2.5;
  return pct(
    selection === 'over'
      ? poissonOver(lambda, line)
      : poissonUnder(lambda, line)
  );
}

/** Assists O/U using real assists/game */
export async function predictAssistsOU(
  playerId: string,
  line: number,
  selection: string
): Promise<number> {
  const player = await fetchPlayerById(playerId);
  const lambda =
    player.gamesPlayed > 0 ? player.assists / player.gamesPlayed : 0.3;
  return pct(
    selection === 'over'
      ? poissonOver(lambda, line)
      : poissonUnder(lambda, line)
  );
}

/** Points O/U using real points/game */
export async function predictPointsOU(
  playerId: string,
  line: number,
  selection: string
): Promise<number> {
  const player = await fetchPlayerById(playerId);
  const lambda =
    player.gamesPlayed > 0 ? player.points / player.gamesPlayed : 0.55;
  return pct(
    selection === 'over'
      ? poissonOver(lambda, line)
      : poissonUnder(lambda, line)
  );
}

/**
 * PP points: uses real ppPoints/game
 * Line is typically 0.5 (will they get at least 1 PP point?)
 */
export async function predictPPPoint(playerId: string): Promise<number> {
  const player = await fetchPlayerById(playerId);
  const lambda =
    player.gamesPlayed > 0 ? player.ppPoints / player.gamesPlayed : 0.15;
  return pct(1 - Math.exp(-lambda)); // P(at least 1)
}

/**
 * Stats not returned by the current player landing endpoint
 * (hits, blocks, TOI, faceoffs, goalie saves, PIM).
 * We use position-based Poisson defaults which reflect real NHL averages.
 * Replace with real data if/when a stats endpoint is integrated.
 */
export async function predictPositionBasedProp(
  playerId: string,
  propType: string,
  line: number,
  selection: string
): Promise<number> {
  let player: any = null;
  try { player = await fetchPlayerById(playerId); } catch { /* use defaults */ }

  const pos = player?.position ?? 'F';
  const isD = pos === 'D';

  // Position-based per-game rates (NHL averages from public tracking data)
  const DEFAULTS: Record<string, number> = {
    hits_ou:           isD ? 2.0 : 2.3,
    blocked_shots_ou:  isD ? 1.6 : 0.4,
    time_on_ice_ou:    isD ? 22  : 16,   // minutes
    faceoff_wins_ou:   pos === 'C' ? 10 : 2,
    penalty_minutes_ou: 0.4,
    goalie_saves_ou:   26,              // league avg ~27 saves/game
  };

  const lambda = DEFAULTS[propType] ?? 3.0;
  return pct(
    selection === 'over'
      ? poissonOver(lambda, line)
      : poissonUnder(lambda, line)
  );
}

// ── Futures ───────────────────────────────────────────────────────────────────

/**
 * Futures probability derived from conference standings rank.
 * propType: 'cup' | 'conf' | 'playoff'
 */
export async function predictFutures(
  teamId: string,
  propType: string
): Promise<number> {
  const teams = await fetchTeams();
  const team  = teams.find(
    (t: any) =>
      t.id?.toLowerCase() === teamId.toLowerCase() ||
      t.abbreviation?.toLowerCase() === teamId.toLowerCase()
  );
  if (!team) return 20;

  const conf = teams
    .filter((t: any) => t.conference === team.conference)
    .sort((a: any, b: any) => b.points - a.points);

  const rank = conf.findIndex((t: any) => t.id === team.id) + 1;

  if (propType === 'cup') {
    // Historical Cup win rates by regular-season rank (rough priors)
    if (rank === 1) return 28;
    if (rank <= 3)  return 18;
    if (rank <= 8)  return 10;
    return 4;
  }

  if (propType === 'conf') {
    if (rank <= 2)  return 35;
    if (rank <= 4)  return 22;
    if (rank <= 8)  return 12;
    return 5;
  }

  // playoff berth
  if (rank <= 3)  return 92;
  if (rank <= 8)  return 72;
  if (rank <= 11) return 38;
  return 12;
}

// ── Factor breakdown ──────────────────────────────────────────────────────────

/**
 * Builds a real factor breakdown for the UI.
 * type: 'team' | 'player'
 */
export async function buildRealFactors(
  type: string,
  id: string,
  probability: number
): Promise<any[]> {
  try {
    if (type === 'team') {
      const team = await getTeam(id);
      if (!team) throw new Error('not found');

      const gfDiff = team.goalsForPerGame - team.goalsAgainstPerGame;

      return [
        {
          icon: '📊',
          label: `Win rate: ${team.winPct}% (${team.wins}W-${team.losses}L-${team.otLosses}OTL)`,
          delta: team.winPct >= 58 ? 12 : team.winPct >= 52 ? 5 : team.winPct >= 48 ? 0 : -6,
        },
        {
          icon: '🏒',
          label: `Goal diff: ${gfDiff >= 0 ? '+' : ''}${gfDiff.toFixed(2)}/game`,
          delta: gfDiff >= 0.4 ? 8 : gfDiff >= 0 ? 2 : -5,
        },
        {
          icon: '📈',
          label: `Streak: ${team.streak || 'even'} · ${team.homeRecord} home`,
          delta: team.streak?.startsWith('W') ? 6 : team.streak?.startsWith('L') ? -5 : 0,
        },
        {
          icon: '⚡',
          label: `PP ${team.ppPct}% · PK ${team.pkPct}%`,
          delta: team.ppPct >= 22 ? 5 : team.ppPct >= 18 ? 1 : -3,
        },
      ];
    }

    // player type
    const player = await fetchPlayerById(id);
    const gpg    = player.gamesPlayed > 0 ? player.goals   / player.gamesPlayed : 0;
    const apg    = player.gamesPlayed > 0 ? player.assists / player.gamesPlayed : 0;
    const ppg    = player.gamesPlayed > 0 ? player.points  / player.gamesPlayed : 0;
    const spg    = player.gamesPlayed > 0 ? player.shots   / player.gamesPlayed : 0;

    return [
      {
        icon: '🎯',
        label: `Goals/game: ${gpg.toFixed(2)} (${player.goals} total)`,
        delta: gpg >= 0.5 ? 12 : gpg >= 0.3 ? 5 : -3,
      },
      {
        icon: '🏒',
        label: `Points/game: ${ppg.toFixed(2)} (${player.points} pts)`,
        delta: ppg >= 0.9 ? 10 : ppg >= 0.6 ? 4 : -2,
      },
      {
        icon: '📊',
        label: `Shots/game: ${spg.toFixed(1)} · Shot%: ${player.shotPct}%`,
        delta: spg >= 3.5 ? 6 : spg >= 2.5 ? 2 : -2,
      },
      {
        icon: '⚡',
        label: `PP points: ${player.ppPoints} · Assists: ${player.assists}`,
        delta: player.ppPoints >= 20 ? 5 : 0,
      },
    ];
  } catch {
    return [
      { icon: '📊', label: `${type} analysis`, delta: probability >= 55 ? 8 : -5 },
      { icon: '📈', label: 'Recent form', delta: 3 },
      { icon: '🏒', label: 'Matchup context', delta: 0 },
    ];
  }
}
