/**
 * injuries.routes.ts
 * CRUD admin sur la saisie manuelle des blessures/alignements (data/injuries.json).
 * Lecture ouverte (le facteur est déjà public via les prédictions) ; écriture
 * réservée aux admins (authenticate + requireRole('admin')).
 *
 * Clé de match = "AWAY@HOME" (abréviations majuscules).
 */
import { Router, Request, Response } from 'express';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { authenticate, requireRole } from '../middleware/auth.middleware';

const router = Router();
const FILE = join(__dirname, '..', 'data', 'injuries.json');

interface InjuriesFile { games: Record<string, any>; [k: string]: any }

function readFile(): InjuriesFile {
  try {
    const data = JSON.parse(readFileSync(FILE, 'utf8'));
    if (!data.games) data.games = {};
    return data;
  } catch {
    return { games: {} };
  }
}
function writeFile(data: InjuriesFile): void {
  writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/** GET /api/injuries — toutes les entrées (games). */
router.get('/', (_req: Request, res: Response) => {
  res.json(readFile().games);
});

/** GET /api/injuries/:key — une entrée. */
router.get('/:key', (req: Request, res: Response) => {
  res.json(readFile().games[req.params.key.toUpperCase()] ?? null);
});

/** PUT /api/injuries/:key — upsert (admin). Corps = { home?, away?, lineupAdj?, lineupNote? }. */
router.put('/:key', authenticate, requireRole('admin'), (req: Request, res: Response) => {
  const key = req.params.key.toUpperCase();
  const body = req.body ?? {};
  const entry: any = {};
  if (Array.isArray(body.home))       entry.home = body.home;
  if (Array.isArray(body.away))       entry.away = body.away;
  if (typeof body.lineupAdj === 'number') entry.lineupAdj = body.lineupAdj;
  if (typeof body.lineupNote === 'string') entry.lineupNote = body.lineupNote;

  const data = readFile();
  data.games[key] = entry;
  writeFile(data);
  res.json({ ok: true, key, entry });
});

/** DELETE /api/injuries/:key — supprime une entrée (admin). */
router.delete('/:key', authenticate, requireRole('admin'), (req: Request, res: Response) => {
  const key = req.params.key.toUpperCase();
  const data = readFile();
  delete data.games[key];
  writeFile(data);
  res.json({ ok: true, key });
});

export default router;
