// « Scanner un ticket » — SCAN_TICKET_PLAN S3. L'OCR et l'analyse du ticket se font
// sur l'appareil ; le serveur ne fait que COMPTER les scans gratuits (D2 : 3 par jour,
// illimité en Pro). Aucune image, aucun texte de ticket n'arrive ici.
import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { sendError } from '../httpError';
import { isPro } from '../services/subscription.service';
import { consumeScan, refundScan, getScanUsage } from '../services/scanQuota.service';

const router = Router();

/** Admin = Pro, comme `requirePro`. */
const proFor = async (req: Request) => req.user!.role === 'admin' || (await isPro(req.user!.sub));

// GET /api/scan/usage — scans gratuits restants aujourd'hui (null = illimité, Pro).
router.get('/usage', authenticate, async (req: Request, res: Response) => {
  try {
    return res.json(await getScanUsage(req.user!.sub, await proFor(req)));
  } catch (err: any) { return sendError(res, err); }
});

// POST /api/scan/start — décompte UN scan, au moment où l'analyse démarre.
// 429 `scan_quota` quand les scans gratuits du jour sont épuisés ; 503 si la base ne répond pas.
router.post('/start', authenticate, async (req: Request, res: Response) => {
  try {
    const v = await consumeScan(req.user!.sub, await proFor(req));
    if (!v.allowed) {
      return v.reason === 'db'
        ? res.status(503).json({ error: 'scan_unavailable' })
        : res.status(429).json({ error: 'scan_quota', limit: v.limit, resetsAt: v.resetsAt });
    }
    return res.status(201).json(v);
  } catch (err: any) { return sendError(res, err); }
});

// POST /api/scan/refund — l'analyse n'a pas pu démarrer (aucune jambe ajoutée) : le scan est rendu.
router.post('/refund', authenticate, async (req: Request, res: Response) => {
  try {
    if (!(await proFor(req))) await refundScan(req.user!.sub);
    return res.json({ ok: true });
  } catch (err: any) { return sendError(res, err); }
});

export default router;
