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

router.get('/games/:id', async (req, res) => {
  try { res.json(await nhl.getGame(req.params.id)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Teams
router.get('/teams', async (_req, res) => {
  try { res.json(await nhl.getTeams()); }
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

router.get('/teams/:abbr/roster', async (req, res) => {
  try { res.json(await nhl.getTeamRoster(req.params.abbr)); }
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
