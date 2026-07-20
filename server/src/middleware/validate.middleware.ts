/**
 * validate.middleware.ts
 * ------------------------------------------------------------------
 * H3 — Request validation at route boundaries. Wraps a zod schema into an
 * Express middleware that parses+validates the request body BEFORE it reaches
 * the handler, so malformed/oversized payloads are rejected with a clean 400
 * (matching the existing `{ error }` shape) instead of hitting the DB/services.
 * On success, req.body is replaced with the parsed (typed, stripped) value.
 */

import { Request, Response, NextFunction } from 'express';
import type { ZodSchema } from 'zod';

export function validateBody(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const message = result.error.issues
        .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
        .join('; ');
      return res.status(400).json({ error: message || 'Invalid request body' });
    }
    req.body = result.data;
    return next();
  };
}
