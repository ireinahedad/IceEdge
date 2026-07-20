/**
 * logger.ts
 * ------------------------------------------------------------------
 * H5 — Structured logging (pino). One JSON line per event in production
 * (searchable, correlatable), pretty-printed in dev. `httpLogger` attaches a
 * per-request child logger (req.log) and a request id (req.id, echoed in the
 * x-request-id response header) so every log line for a request can be tied
 * together. Prefer `logger`/`req.log` over console.* in new code.
 */

import pino from 'pino';
import pinoHttp from 'pino-http';
import { randomUUID } from 'crypto';

const isProd = process.env.NODE_ENV === 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  // Pretty output in dev only; prod stays as raw JSON for log aggregators.
  transport: isProd ? undefined : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } },
  // Never log credentials.
  redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'], remove: true },
});

export const httpLogger = pinoHttp({
  logger,
  // Reuse an upstream request id if the proxy set one, else generate a UUID.
  genReqId: (req, res) => {
    const hdr = req.headers['x-request-id'];
    const id = (Array.isArray(hdr) ? hdr[0] : hdr) || randomUUID();
    res.setHeader('x-request-id', id);
    return id;
  },
  // Don't spam logs with health-probe traffic.
  autoLogging: {
    ignore: (req) => req.url === '/health' || req.url === '/health/ready',
  },
});
