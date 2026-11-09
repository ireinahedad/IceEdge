/**
 * geo.routes.ts — GET /api/geo → { country, region, sportsbookEligible, minAge }
 *
 * Public, no auth, no IP returned. `private, no-store` + `Vary`: the answer
 * depends on the visitor, so no shared cache (Cloudflare, Vercel) may keep it.
 * See `services/geo.ts` for where the location comes from.
 */

import { Router } from 'express';
import { geoFromHeaders } from '../services/geo';

const router = Router();

router.get('/', (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.set('Vary', 'CF-IPCountry, CF-Region-Code');
  res.json(geoFromHeaders(req.headers));
});

export default router;
