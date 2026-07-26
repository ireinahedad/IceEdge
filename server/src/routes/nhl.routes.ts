import { Router } from 'express';
import { NHLService } from '../services/nhl.service';
import { buildGameMarkets, buildTeamMarkets, buildPlayerMarkets } from '../services/nhlPredictions';
import { FactorWeights } from '../services/predictionFactors';

const router = Router();
const nhl    = new NHLService();

// Games
router.get('/games', async (req, res) => {
  try { res.json(await nhl.getGamesByDate(req.query.date as string)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Calendrier : tous les matchs entre deux dates (YYYY-MM-DD) incluses.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** NHL season id, e.g. 20252026. */
const SEASON_ID = /^\d{8}$/;
router.get('/games/range', async (req, res) => {
  const start = String(req.query.start ?? '');
  const end   = String(req.query.end ?? '');
  if (!ISO_DATE.test(start) || !ISO_DATE.test(end) || end < start) {
    res.status(400).json({ error: 'Invalid start/end (expected YYYY-MM-DD, end >= start)' });
    return;
  }
  try { res.json(await nhl.getGamesRange(start, end)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Ancre du calendrier : date courante + bornes de saison selon l'API NHL.
router.get('/schedule/anchor', async (_req, res) => {
  try { res.json(await nhl.getScheduleAnchor()); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

router.get('/games/live', async (_req, res) => {
  try { res.json(await nhl.getLiveGames()); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Charts: full detail for one game (landing + boxscore merged).
// Before '/games/:id' so "detail" isn't captured as an id.
router.get('/games/:id/detail', async (req, res) => {
  try { res.json(await nhl.getGameDetail(req.params.id)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

router.get('/games/:id', async (req, res) => {
  try { res.json(await nhl.getGame(req.params.id)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Teams
router.get('/teams', async (_req, res) => {
  try { res.json(await nhl.getTeams()); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Charts: every team's season summary (All Teams page). Declared before the
// '/teams/:id/...' routes so "season-summary" isn't captured as a team id.
router.get('/teams/season-summary', async (req, res) => {
  const season = req.query.season != null ? String(req.query.season) : undefined;
  if (season != null && !SEASON_ID.test(season)) {
    res.status(400).json({ error: 'Invalid season (expected 8-digit seasonId, e.g. 20252026)' });
    return;
  }
  try { res.json(await nhl.getAllTeamsSeason(season)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

router.get('/teams/:id/stats', async (req, res) => {
  try { res.json(await nhl.getTeamStats(req.params.id)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

router.get('/teams/:id/last/:n', async (req, res) => {
  try { res.json(await nhl.getTeamLastNGames(req.params.id, parseInt(req.params.n))); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Players
router.get('/players/search', async (req, res) => {
  try { res.json(await nhl.searchPlayers(req.query.q as string ?? '')); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

router.get('/players', async (_req, res) => {
  try { res.json(await nhl.getAllPlayerStats()); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Charts: league leaders for a season (top N by a chosen metric).
// Declared before '/players/:id' so "leaders" isn't swallowed as an id.
// Every input is whitelisted or clamped downstream: `season` must be an
// 8-digit id, `sort` is looked up in a fixed map, `limit` is clamped 1–100.
type LeaderQuery =
  | { ok: true; season?: string; view: 'skater' | 'goalie'; sort: string; limit: number }
  | { ok: false };

function parseLeaderQuery(q: any): LeaderQuery {
  const season = q.season != null ? String(q.season) : undefined;
  if (season != null && !SEASON_ID.test(season)) return { ok: false };
  const limit = Number(q.limit ?? 20);
  return {
    ok: true,
    season,
    view: q.view === 'goalie' ? 'goalie' : 'skater',
    sort: String(q.sort ?? ''),
    limit: Number.isFinite(limit) ? limit : 20,
  };
}

const BAD_SEASON = { error: 'Invalid season (expected 8-digit seasonId, e.g. 20252026)' };

router.get('/players/leaders', async (req, res) => {
  const p = parseLeaderQuery(req.query);
  if (!p.ok) { res.status(400).json(BAD_SEASON); return; }
  try { res.json(await nhl.getPlayerLeaders(p.season, p.view, p.sort, p.limit)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

router.get('/teams/:abbr/roster', async (req, res) => {
  try { res.json(await nhl.getTeamRoster(req.params.abbr)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Bet365-style charts: last 6 seasons of per-player stats (skaters + goalies).
router.get('/teams/:abbr/player-seasons', async (req, res) => {
  try { res.json(await nhl.getTeamPlayerSeasons(req.params.abbr)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Charts: per-opponent player splits for a season (avg-per-game-vs-team column).
router.get('/teams/:abbr/opponent-splits/:season', async (req, res) => {
  if (!SEASON_ID.test(req.params.season)) {
    res.status(400).json({ error: 'Invalid season (expected 8-digit seasonId, e.g. 20252026)' });
    return;
  }
  try { res.json(await nhl.getTeamOpponentSplits(req.params.abbr, req.params.season)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Charts: official team stats for a season + per-opponent GF/GA/W from schedule.
router.get('/teams/:abbr/season-official/:season', async (req, res) => {
  if (!SEASON_ID.test(req.params.season)) {
    res.status(400).json({ error: 'Invalid season (expected 8-digit seasonId, e.g. 20252026)' });
    return;
  }
  try { res.json(await nhl.getTeamSeasonOfficial(req.params.abbr, req.params.season)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

router.get('/players/:id', async (req, res) => {
  try { res.json(await nhl.getPlayer(req.params.id)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

router.get('/players/:id/stats', async (req, res) => {
  try { res.json(await nhl.getPlayerStats(req.params.id)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Parse les poids personnalisés depuis la query (?wQuality=&wHomeIce=&...).
// Retourne undefined si aucun n'est fourni → le moteur utilise les poids par défaut.
function parseWeights(q: any): FactorWeights | undefined {
  const keys: Array<[keyof FactorWeights, string]> = [
    ['quality', 'wQuality'], ['homeIce', 'wHomeIce'], ['fatigue', 'wFatigue'],
    ['odds', 'wOdds'], ['injuries', 'wInjuries'], ['lineup', 'wLineup'],
  ];
  if (!keys.some(([, qk]) => q[qk] != null)) return undefined;
  const w: any = {};
  for (const [k, qk] of keys) {
    const v = Number(q[qk]);
    w[k] = Number.isFinite(v) && v >= 0 ? v : 0;
  }
  return w as FactorWeights;
}

// Predictions
router.get('/predictions/game/:gameId', async (req, res) => {
  try { res.json(await buildGameMarkets(req.params.gameId, parseWeights(req.query))); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

router.get('/predictions/team/:abbr', async (req, res) => {
  try { res.json(await buildTeamMarkets(req.params.abbr)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

router.get('/predictions/player/:playerId', async (req, res) => {
  try { res.json(await buildPlayerMarkets(req.params.playerId)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Standings
router.get('/standings', async (_req, res) => {
  try { res.json(await nhl.getStandings()); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

export default router;
