// Combinés publiés en vidéo — MARKETING_PLAN.md Phase B. Voir services/parlayLog.service.ts.
//
// Les routes d'écriture sont appelées par GitHub Actions avec l'en-tête
// `X-Cron-Secret` (= `CONTENT_CRON_SECRET`, même valeur dans Railway et dans
// les secrets GitHub). Sans la variable, elles répondent 503 : rien n'est
// ouvert par défaut. Les lectures sont publiques et ne montrent QUE ce qui est
// gelé — jamais les combinés Pro.
import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import { sendError } from '../httpError';
import * as ParlayLog from '../services/parlayLog.service';

const router = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const POSTED_KINDS: readonly ParlayLog.PostedKind[] = ['youtube_pick', 'youtube_result', 'tiktok_pick', 'tiktok_result'];

const sha = (s: string) => crypto.createHash('sha256').update(s).digest();

/** Compare l'en-tête au secret en temps constant (hachés : longueurs égales). */
export function requireCronSecret(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.CONTENT_CRON_SECRET;
  if (!secret) return res.status(503).json({ error: 'Content cron is not configured' });
  const given = String(req.get('x-cron-secret') ?? '');
  if (!given || !crypto.timingSafeEqual(sha(given), sha(secret))) {
    return res.status(401).json({ error: 'Invalid cron secret' });
  }
  return next();
}

function dateParam(raw: unknown): string | null {
  return typeof raw === 'string' && DATE_RE.test(raw) && !Number.isNaN(Date.parse(raw)) ? raw : null;
}

// POST /content/parlays/freeze  { date? } — gèle les 2 combinés gratuits du jour.
router.post('/parlays/freeze', requireCronSecret, async (req: Request, res: Response) => {
  try {
    const raw = req.body?.date ?? req.query.date;
    const date = raw == null ? ParlayLog.etToday() : dateParam(raw);
    if (!date) return res.status(400).json({ error: 'Invalid date (YYYY-MM-DD)' });
    const out = await ParlayLog.freezeDailyParlays(date);
    return res.status(out.created ? 201 : 200).json(out);
  } catch (err) { return sendError(res, err, { context: '[content/freeze]' }); }
});

// POST /content/parlays/settle — force une passe de règlement (le job horaire le fait aussi).
router.post('/parlays/settle', requireCronSecret, async (_req: Request, res: Response) => {
  try { return res.json(await ParlayLog.settlePendingParlays()); }
  catch (err) { return sendError(res, err, { context: '[content/settle]' }); }
});

// GET /content/parlays/record — bilan cumulé depuis le lancement.
router.get('/parlays/record', async (_req: Request, res: Response) => {
  try { return res.json(await ParlayLog.getParlayRecord()); }
  catch (err) { return sendError(res, err, { context: '[content/record]' }); }
});

// GET /content/parlays?date=YYYY-MM-DD — ce qui est gelé ce jour-là (défaut : aujourd'hui ET).
router.get('/parlays', async (req: Request, res: Response) => {
  try {
    const date = req.query.date == null ? ParlayLog.etToday() : dateParam(req.query.date);
    if (!date) return res.status(400).json({ error: 'Invalid date (YYYY-MM-DD)' });
    return res.json({ date, parlays: await ParlayLog.getParlaysForDate(date) });
  } catch (err) { return sendError(res, err, { context: '[content/parlays]' }); }
});

// POST /content/parlays/:date/posted  { kind, videoId? } — drapeau de publication.
router.post('/parlays/:date/posted', requireCronSecret, async (req: Request, res: Response) => {
  try {
    const date = dateParam(req.params.date);
    if (!date) return res.status(400).json({ error: 'Invalid date (YYYY-MM-DD)' });
    const kind = req.body?.kind;
    if (!POSTED_KINDS.includes(kind)) return res.status(400).json({ error: `kind must be one of ${POSTED_KINDS.join(', ')}` });
    const videoId = typeof req.body?.videoId === 'string' && /^[\w-]{1,64}$/.test(req.body.videoId)
      ? req.body.videoId : undefined;
    return res.json(await ParlayLog.markParlaysPosted(date, kind, videoId));
  } catch (err) { return sendError(res, err, { context: '[content/posted]' }); }
});

export default router;
