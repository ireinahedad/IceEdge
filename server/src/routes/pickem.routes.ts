/**
 * pickem.routes.ts — pick'em ICEEDGE (NEWS_CONSENSUS_PLAN.md, F3, session A).
 *
 *   GET  /api/pickem/today     public : tous les matchs du jour (+ mes votes si connecté)
 *   GET  /api/pickem/leaderboard?week=current|previous   public : classement (+ ma ligne)
 *   GET  /api/pickem/:gameId   public : totaux (+ mon vote si connecté)
 *   POST /api/pickem/:gameId   connecté : { team: 'VGK' } — vote ou change de vote
 *
 * Monté avec `writeLimiter` (qui laisse passer les GET) et `noStore` : la
 * réponse porte le vote de la personne connectée, elle ne doit pas être mise
 * en cache par un intermédiaire.
 */

import { Router, type Request, type Response } from 'express';
import { authenticate, optionalAuthenticate } from '../middleware/auth.middleware';
import { sendError } from '../httpError';
import { getPickem, castPickem, getPickemDay, getPickemLeaderboard } from '../services/pickem.service';
import { GAME_ID_RE, TEAM_RE } from '../services/pickem';

const router = Router();

function gameIdOf(req: Request, res: Response): string | null {
  const id = String(req.params.gameId ?? '');
  if (!GAME_ID_RE.test(id)) { res.status(400).json({ error: 'gameId invalide' }); return null; }
  return id;
}

// Avant `/:gameId`, qui refuserait « today » / « leaderboard » (400).
router.get('/leaderboard', optionalAuthenticate, async (req: Request, res: Response) => {
  const week = String(req.query.week ?? 'current');
  if (week !== 'current' && week !== 'previous') { res.status(400).json({ error: 'week : current | previous' }); return; }
  try {
    res.json(await getPickemLeaderboard(week === 'previous' ? -1 : 0, req.user?.sub));
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/today', optionalAuthenticate, async (req: Request, res: Response) => {
  try {
    res.json(await getPickemDay(req.user?.sub));
  } catch (err) {
    sendError(res, err);
  }
});

router.get('/:gameId', optionalAuthenticate, async (req: Request, res: Response) => {
  const gameId = gameIdOf(req, res);
  if (!gameId) return;
  try {
    res.json(await getPickem(gameId, req.user?.sub));
  } catch (err) {
    sendError(res, err);
  }
});

router.post('/:gameId', authenticate, async (req: Request, res: Response) => {
  const gameId = gameIdOf(req, res);
  if (!gameId) return;
  const team = String((req.body as any)?.team ?? '').trim().toUpperCase();
  if (!TEAM_RE.test(team)) { res.status(400).json({ error: 'team : abréviation LNH (ex. VGK)' }); return; }
  try {
    res.json(await castPickem(req.user!.sub, gameId, team));
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
