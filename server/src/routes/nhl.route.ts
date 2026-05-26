import { Router } from 'express';
import { NHLService } from '../services/nhl.service';

const router = Router();
const nhl    = new NHLService();

// Games
router.get('/games', async (req, res) => {
  try { res.json(await nhl.getGamesByDate(req.query.date as string)); }
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

router.get('/players/:id', async (req, res) => {
  try { res.json(await nhl.getPlayer(req.params.id)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

router.get('/players/:id/stats', async (req, res) => {
  try { res.json(await nhl.getPlayerStats(req.params.id)); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

// Standings
router.get('/standings', async (_req, res) => {
  try { res.json(await nhl.getStandings()); }
  catch (err: any) { res.status(err.status ?? 500).json({ error: err.message }); }
});

export default router;
