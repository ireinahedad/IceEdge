/**
 * news.routes.ts — fil de nouvelles par match, en lecture publique.
 *
 *   GET /api/news?teams=VGK,STL[&hours=36]
 *
 * Public comme `/api/nhl` : ce ne sont que des liens vers des publications
 * publiques. La saisie (lien collé) est dans `manual.routes.ts`, réservée aux admins.
 */

import { Router } from 'express';
import { publicCache, TTL } from '../middleware/httpCache.middleware';
import { sendError } from '../httpError';
import { listNews } from '../services/newsSync.service';

const router = Router();
const ABBR_RE = /^[A-Z]{2,4}$/;

router.get('/', publicCache(TTL.LIVE * 4), async (req, res) => {
  const teams = String(req.query.teams ?? '')
    .split(',').map((t) => t.trim().toUpperCase()).filter((t) => ABBR_RE.test(t));
  if (teams.length === 0 || teams.length > 4) {
    res.status(400).json({ error: 'teams : 1 à 4 abréviations LNH séparées par des virgules (ex. VGK,STL)' });
    return;
  }
  const hours = Math.min(72, Math.max(1, Number(req.query.hours) || 36));
  try {
    res.json({ items: await listNews([...new Set(teams)], hours) });
  } catch (err) {
    sendError(res, err);
  }
});

export default router;
