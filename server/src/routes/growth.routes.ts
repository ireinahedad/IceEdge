/**
 * growth.routes.ts — mesure de l'entonnoir (2026-11-20, migration 055).
 *
 *   POST /api/growth/event        { name, props? }   — étape côté client
 *        Compte facultatif : un visiteur déconnecté compte aussi (user_id NULL,
 *        aucun identifiant de visiteur, donc rien qui exige un consentement de
 *        plus que Clarity ; le client n'envoie de toute façon qu'avec l'accord).
 *        Noms filtrés par liste blanche (`CLIENT_EVENTS`) : pas de table fourre-tout.
 *
 *   POST /api/growth/attribution  { source, medium?, campaign?, landing? }
 *        Provenance premier contact d'un compte NEUF (< 3 jours), posée une fois.
 *
 * Réponse 204 dans tous les cas utiles : le client n'attend rien et ne réessaie pas.
 */

import { Router, Request, Response } from 'express';
import { authenticate, optionalAuthenticate } from '../middleware/auth.middleware';
import { CLIENT_EVENTS, saveSignupSource, trackEvent } from '../services/growth.service';

const router = Router();
const CLIENT_SET = new Set<string>(CLIENT_EVENTS);

router.post('/event', optionalAuthenticate, (req: Request, res: Response) => {
  const name = typeof req.body?.name === 'string' ? req.body.name : '';
  if (!CLIENT_SET.has(name)) {
    res.status(400).json({ error: 'Unknown event' });
    return;
  }
  const props = req.body?.props && typeof req.body.props === 'object' ? req.body.props : undefined;
  void trackEvent(req.user?.sub ?? null, name as (typeof CLIENT_EVENTS)[number], props);
  res.status(204).end();
});

router.post('/attribution', authenticate, async (req: Request, res: Response) => {
  await saveSignupSource(req.user!.sub, {
    source: req.body?.source,
    medium: req.body?.medium,
    campaign: req.body?.campaign,
    landing: req.body?.landing,
  });
  res.status(204).end();
});

export default router;
