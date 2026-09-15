/**
 * bestBets.service.ts
 * ------------------------------------------------------------------
 * Scans upcoming NHL games + top players across ALL bet markets,
 * scores every individual bet with the rule engine, then enriches the
 * strongest candidates with the ML model. The "display" score is
 * ML-first (falls back to rules when the ML service is unavailable).
 *
 * Returns the top-N individual bets sorted by prediction score.
 * Powers GET /api/predict/best-bets and the homepage "Best Bets" list.
 */

import {
  fetchGamesByDate,
  fetchLiveGames,
  fetchTopPlayers,
} from './nhlApiClient';
import {
  predictMoneyline,
  predictTotalGoals,
  predictPuckLine,
  predictAnytimeGoal,
  predictShotsOU,
  predictPointsOU,
  predictPPPoint,
} from './predictionEngine';
import {
  buildGameFeatures,
  buildPlayerPropFeatures,
} from './featureEngineering';
import { mlApiClient } from './mlApiClient';
import { TtlCache } from './ttlCache';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BestBet {
  id:             string;
  subjectType:    'game' | 'player';
  marketType:     string;
  marketLabel:    string;
  subjectId:      string;   // game id or player id
  subjectName:    string;   // "BOS vs NYR" or "Connor McDavid"
  subjectLogo:    string;   // emoji fallback
  teamAbbr:       string | null;  // for building a team logo client-side
  label:          string;   // "BOS to win", "Over 5.5", "McDavid anytime goal"
  selection:      string;
  /** Machine-readable selection ('over' | 'under' | 'yes' | team abbr) — required for automatic settlement. */
  selectionValue: string;
  selectionShort: string;
  context:        string;   // "vs NYR · 7:00 PM ET"
  line:           number | null;
  gameId:         string | null;
  teamId:         string | null;
  playerId:       string | null;
  rulePct:        number;
  mlPct:          number | null;
  score:          number;   // display score = mlPct ?? rulePct
  source:         'ml' | 'rules';
  confidence:     'very_high' | 'high' | 'medium' | 'low' | 'very_low';
}

interface Candidate extends Omit<BestBet, 'mlPct' | 'score' | 'source' | 'confidence'> {
  // how to build ML features for this candidate
  ml:
    | { kind: 'game'; homeId: string; awayId: string; marketType: string; line?: number }
    | { kind: 'player'; playerId: string; propType: string; line: number; selection: string }
    | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function confidenceFor(pct: number): BestBet['confidence'] {
  if (pct >= 70) return 'very_high';
  if (pct >= 60) return 'high';
  if (pct >= 50) return 'medium';
  if (pct >= 40) return 'low';
  return 'very_low';
}

/** Fetch upcoming games: live + today + the next few days, de-duplicated. */
async function fetchUpcomingGames(days: number): Promise<any[]> {
  const dates: string[] = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }

  const results = await Promise.allSettled([
    fetchLiveGames(),
    ...dates.map((d) => fetchGamesByDate(d)),
  ]);

  const all: any[] = [];
  for (const r of results) if (r.status === 'fulfilled') all.push(...r.value);

  // De-dup by game id, drop finished games
  const seen = new Set<string>();
  const games: any[] = [];
  for (const g of all) {
    if (seen.has(g.id)) continue;
    if (g.status === 'final') continue;
    seen.add(g.id);
    games.push(g);
  }
  return games;
}

// ─── Candidate builders (rule scores) ─────────────────────────────────────────

async function buildGameCandidates(g: any): Promise<Candidate[]> {
  const home = g.homeTeam?.abbreviation ?? g.homeTeam?.id ?? '';
  const away = g.awayTeam?.abbreviation ?? g.awayTeam?.id ?? '';
  if (!home || !away) return [];

  const homeLc = String(home).toLowerCase();
  const awayLc = String(away).toLowerCase();
  const when   = g.startTime || g.period || '';
  const matchup = `${home} vs ${away}`;
  const line   = g.overUnder ?? 5.5;

  const [homeMl, awayMl, overPct, pl] = await Promise.all([
    predictMoneyline(homeLc, awayLc, true),
    predictMoneyline(awayLc, homeLc, false),
    predictTotalGoals(line, 'over', homeLc, awayLc),
    predictPuckLine(homeLc, awayLc, true),
  ]);
  const underPct = Math.max(3, 100 - overPct);

  const ctxHome = `vs ${away}${when ? ` · ${when}` : ''}`;
  const ctxAway = `vs ${home}${when ? ` · ${when}` : ''}`;

  return [
    {
      id: `bb-${g.id}-ml-home`, subjectType: 'game', marketType: 'moneyline', marketLabel: 'Moneyline',
      subjectId: g.id, subjectName: matchup, subjectLogo: g.homeTeam?.emoji ?? '🏒', teamAbbr: home,
      label: `${home} to win`, selection: `${home} to win`, selectionValue: homeLc, selectionShort: `${home} ML`,
      context: ctxHome, line: null, gameId: g.id, teamId: homeLc, playerId: null, rulePct: homeMl,
      ml: { kind: 'game', homeId: homeLc, awayId: awayLc, marketType: 'moneyline' },
    },
    {
      id: `bb-${g.id}-ml-away`, subjectType: 'game', marketType: 'moneyline', marketLabel: 'Moneyline',
      subjectId: g.id, subjectName: matchup, subjectLogo: g.awayTeam?.emoji ?? '🏒', teamAbbr: away,
      label: `${away} to win`, selection: `${away} to win`, selectionValue: awayLc, selectionShort: `${away} ML`,
      context: ctxAway, line: null, gameId: g.id, teamId: awayLc, playerId: null, rulePct: awayMl,
      ml: { kind: 'game', homeId: awayLc, awayId: homeLc, marketType: 'moneyline' },
    },
    {
      id: `bb-${g.id}-over`, subjectType: 'game', marketType: 'total_goals', marketLabel: 'Total Goals O/U',
      subjectId: g.id, subjectName: matchup, subjectLogo: '📈', teamAbbr: null,
      label: `Over ${line}`, selection: `Over ${line}`, selectionValue: 'over', selectionShort: `O${line}`,
      context: matchup, line, gameId: g.id, teamId: null, playerId: null, rulePct: overPct,
      ml: { kind: 'game', homeId: homeLc, awayId: awayLc, marketType: 'total_goals_over', line },
    },
    {
      id: `bb-${g.id}-under`, subjectType: 'game', marketType: 'total_goals', marketLabel: 'Total Goals O/U',
      subjectId: g.id, subjectName: matchup, subjectLogo: '📉', teamAbbr: null,
      label: `Under ${line}`, selection: `Under ${line}`, selectionValue: 'under', selectionShort: `U${line}`,
      context: matchup, line, gameId: g.id, teamId: null, playerId: null, rulePct: underPct,
      ml: { kind: 'game', homeId: homeLc, awayId: awayLc, marketType: 'total_goals_under', line },
    },
    {
      id: `bb-${g.id}-pl-home`, subjectType: 'game', marketType: 'puck_line', marketLabel: 'Puck Line',
      subjectId: g.id, subjectName: matchup, subjectLogo: g.homeTeam?.emoji ?? '🏒', teamAbbr: home,
      label: `${home} -1.5`, selection: `${home} -1.5`, selectionValue: homeLc, selectionShort: `${home} -1.5`,
      context: ctxHome, line: -1.5, gameId: g.id, teamId: homeLc, playerId: null, rulePct: pl,
      ml: { kind: 'game', homeId: homeLc, awayId: awayLc, marketType: 'puck_line', line: -1.5 },
    },
  ];
}

async function buildPlayerCandidates(
  p: any,
  game: { matchup: string; when: string; gameId: string },
): Promise<Candidate[]> {
  const pid  = String(p.id);
  const name = p.name ?? 'Player';
  const abbr = (p.teamId ?? '').toUpperCase() || null;
  const logo = '🏒';
  const ctx  = `${game.matchup}${game.when ? ` · ${game.when}` : ''}`;

  const [atg, shots, points, pp] = await Promise.all([
    predictAnytimeGoal(pid).catch(() => 0),
    predictShotsOU(pid, 2.5, 'over').catch(() => 0),
    predictPointsOU(pid, 0.5, 'over').catch(() => 0),
    predictPPPoint(pid).catch(() => 0),
  ]);

  const mk = (
    suffix: string, marketType: string, marketLabel: string, label: string,
    short: string, line: number | null, rulePct: number,
    selectionValue: string, ml: Candidate['ml'],
  ): Candidate => ({
    id: `bb-p-${pid}-${suffix}`, subjectType: 'player', marketType, marketLabel,
    subjectId: pid, subjectName: name, subjectLogo: logo, teamAbbr: abbr,
    label, selection: label, selectionValue, selectionShort: short, context: ctx,
    line, gameId: game.gameId, teamId: null, playerId: pid, rulePct, ml,
  });

  return [
    mk('atg', 'anytime_goal', 'Anytime Goal', `${name} anytime goal`, 'ATG', null, atg, 'yes',
      { kind: 'player', playerId: pid, propType: 'goals', line: 0.5, selection: 'over' }),
    mk('shots', 'shots_ou', 'Shots O/U', `${name} over 2.5 shots`, 'O2.5 SOG', 2.5, shots, 'over',
      { kind: 'player', playerId: pid, propType: 'shots', line: 2.5, selection: 'over' }),
    mk('points', 'points_ou', 'Points O/U', `${name} over 0.5 points`, 'O0.5 PTS', 0.5, points, 'over',
      { kind: 'player', playerId: pid, propType: 'points', line: 0.5, selection: 'over' }),
    mk('pp', 'pp_point', 'PP Point', `${name} power-play point`, 'PPP', 0.5, pp, 'yes',
      { kind: 'player', playerId: pid, propType: 'pp_point', line: 0.5, selection: 'over' }),
  ];
}

// ─── ML enrichment ─────────────────────────────────────────────────────────────

async function mlScore(c: Candidate): Promise<number | null> {
  if (!c.ml) return null;
  try {
    if (c.ml.kind === 'game') {
      const feats = await buildGameFeatures(c.ml.homeId, c.ml.awayId, c.ml.marketType, c.ml.line);
      const res = await mlApiClient.predictGame(feats);
      return typeof res?.probability === 'number' ? Math.round(res.probability) : null;
    } else {
      const feats = await buildPlayerPropFeatures(c.ml.playerId, c.ml.propType, c.ml.line, c.ml.selection);
      const res = await mlApiClient.predictPlayer(feats);
      return typeof res?.probability === 'number' ? Math.round(res.probability) : null;
    }
  } catch {
    return null; // ML service down → fall back to rules
  }
}

// ─── Public API ────────────────────────────────────────────────────────────────

export interface BestBetsOptions {
  limit?:       number;   // how many bets to return (default 15)
  source?:      'ml' | 'rules';  // preferred display score (default 'ml')
  days?:        number;   // look-ahead window in days (default 2 = tonight + tomorrow)
  maxPlayers?:  number;   // how many top players to scan (default 15)
  mlDepth?:     number;   // how many top candidates to enrich with ML (default 30)
}

interface NormalizedOptions {
  limit:      number;
  source:     'ml' | 'rules';
  days:       number;
  maxPlayers: number;
  mlDepth:    number;
}

export interface BestBetsResult {
  bets: BestBet[];
  meta: { generatedAt: string; source: string; mlAvailable: boolean; scanned: number };
}

/**
 * Borne chaque option dans un intervalle sûr. C'est aussi ce qui rend l'espace
 * des clés de cache fini : une requête ne peut pas fabriquer une clé arbitraire.
 */
function normalizeOptions(opts: BestBetsOptions): NormalizedOptions {
  const num = (v: number | undefined, dflt: number, lo: number, hi: number) =>
    Math.min(Math.max(Number.isFinite(v as number) ? Math.trunc(v as number) : dflt, lo), hi);
  return {
    limit:      num(opts.limit,      15, 1, 50),
    source:     opts.source === 'rules' ? 'rules' : 'ml',
    days:       num(opts.days,        2, 1,  7),
    maxPlayers: num(opts.maxPlayers, 15, 0, 40),
    mlDepth:    num(opts.mlDepth,    30, 0, 60),
  };
}

/**
 * Cache de réponse, TTL 60 s.
 *
 * Un seul appel à `computeBestBets` déclenche des dizaines de requêtes HTTP
 * sortantes (NHL API + jusqu'à `mlDepth` prédictions ML). Sans cache, le coût
 * est linéaire au nombre de visiteurs et sature le service Python bien avant
 * le CPU du serveur Node. `TtlCache.wrap` dédoublonne également les requêtes
 * concurrentes : 500 arrivées simultanées sur un cache froid (typiquement
 * juste après un redéploiement) ne déclenchent qu'UNE exécution.
 *
 * L'objet retourné est partagé entre appelants — il ne doit pas être muté.
 */
const BEST_BETS_TTL = 60_000;
const bestBetsCache = new TtlCache<BestBetsResult>(BEST_BETS_TTL, 50, 'best-bets');

export async function getBestBets(opts: BestBetsOptions = {}): Promise<BestBetsResult> {
  const o = normalizeOptions(opts);
  const key = `${o.limit}|${o.days}|${o.maxPlayers}|${o.source}|${o.mlDepth}`;
  return bestBetsCache.wrap(key, () => computeBestBets(o));
}

async function computeBestBets(o: NormalizedOptions): Promise<BestBetsResult> {
  const { limit, source, days, maxPlayers, mlDepth } = o;

  // 1. Gather subjects (only games tonight / next `days` days)
  const [games, allPlayers] = await Promise.all([
    fetchUpcomingGames(days).catch(() => []),
    maxPlayers > 0 ? fetchTopPlayers().catch(() => []) : Promise.resolve([]),
  ]);

  // Which teams actually play in this window → team abbr (lowercase) → game info.
  // Player props are ONLY built for players whose team appears here.
  // gameId is required so a player-prop bet placed from here can later be
  // auto-settled — without it, settlement can never look up the boxscore.
  const teamGame = new Map<string, { matchup: string; when: string; gameId: string }>();
  for (const g of games) {
    const home = String(g.homeTeam?.abbreviation ?? g.homeTeam?.id ?? '').toLowerCase();
    const away = String(g.awayTeam?.abbreviation ?? g.awayTeam?.id ?? '').toLowerCase();
    if (!home || !away) continue;
    const matchup = `${home.toUpperCase()} vs ${away.toUpperCase()}`;
    const when    = g.startTime || g.period || '';
    if (!teamGame.has(home)) teamGame.set(home, { matchup, when, gameId: String(g.id) });
    if (!teamGame.has(away)) teamGame.set(away, { matchup, when, gameId: String(g.id) });
  }

  // Keep only players whose team is playing, then cap to maxPlayers.
  const playingPlayers = allPlayers
    .filter((p: any) => teamGame.has(String(p.teamId ?? '').toLowerCase()))
    .slice(0, maxPlayers);

  // 2. Build candidates with rule scores
  const candidateGroups = await Promise.all([
    ...games.map((g) => buildGameCandidates(g).catch(() => [] as Candidate[])),
    ...playingPlayers.map((p: any) =>
      buildPlayerCandidates(p, teamGame.get(String(p.teamId).toLowerCase())!).catch(() => [] as Candidate[]),
    ),
  ]);
  const candidates: Candidate[] = candidateGroups.flat();

  // 3. Rank by rule score, enrich the strongest with ML (bounds ML calls)
  candidates.sort((a, b) => b.rulePct - a.rulePct);
  // Skip ML entirely when it's disabled (deferred deployment) — avoids wasted
  // calls to an absent Python service and keeps the endpoint fast on rules.
  const mlDisabled = process.env.ML_DISABLED === 'true';
  const toEnrich = (source === 'ml' && !mlDisabled) ? candidates.slice(0, mlDepth) : [];
  const mlResults = await Promise.all(toEnrich.map((c) => mlScore(c)));
  const mlAvailable = mlResults.some((r) => r != null);
  const mlById = new Map<string, number | null>();
  toEnrich.forEach((c, i) => mlById.set(c.id, mlResults[i]));

  // 4. Finalise: display score = ML if present else rules
  const bets: BestBet[] = candidates.map((c) => {
    const mlPct = mlById.has(c.id) ? mlById.get(c.id)! : null;
    const useMl = source === 'ml' && mlPct != null;
    const score = useMl ? mlPct : c.rulePct;
    const { ml, ...rest } = c;
    return {
      ...rest,
      mlPct,
      score,
      source: useMl ? 'ml' : 'rules',
      confidence: confidenceFor(score),
    };
  });

  // 5. Sort by final display score (best prediction first) and trim
  bets.sort((a, b) => b.score - a.score);

  return {
    bets: bets.slice(0, limit),
    meta: {
      generatedAt: new Date().toISOString(),
      source,
      mlAvailable,
      scanned: candidates.length,
    },
  };
}
