/**
 * mlApiClient.ts
 * HTTP client for the Python ML service (default: http://localhost:8000).
 * All methods throw on error so callers can fall back to rule-based.
 *
 * Auth: the ML service is not user-aware and must only be reachable by this
 * backend. It should sit on Railway's private network (no public domain), and
 * every inference call carries the shared secret `ML_API_TOKEN` in `X-ML-Token`
 * as a second, independent barrier. See ml/python/ml_service.py.
 */

import { logger } from '../logger';
import { timeUpstream } from '../metrics';

/** Normalise `ML_SERVICE_URL` and shout about the two ways it's usually wrong.
 *  Railway's dashboard displays the internal address bare — `svc.railway.internal` —
 *  and pasting it as-is makes `fetch` throw "Failed to parse URL", which the route
 *  turns into a generic 503: the real cause never surfaces. Private networking
 *  also has no proxy, so the port is mandatory (uvicorn binds `$PORT`, 8080 on
 *  Railway); omitting it silently means port 80 and a refused connection. */
function resolveMlUrl(): string {
  const raw = (process.env.ML_SERVICE_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return 'http://localhost:8000';

  let url = raw;
  if (!/^https?:\/\//i.test(url)) {
    logger.warn({ ML_SERVICE_URL: raw }, '[ML] ML_SERVICE_URL sans schéma — "http://" ajouté. Corrige la variable.');
    url = `http://${url}`;
  }
  if (/\.railway\.internal(\/|$)/i.test(url) && !/:\d+(\/|$)/.test(url)) {
    logger.warn({ ML_SERVICE_URL: url }, '[ML] Adresse interne sans port — le réseau privé n\'a pas de proxy, ajoute le port écouté par uvicorn (souvent :8080).');
  }
  return url;
}

/** Base URL of the ML service. Exported so callers doing raw fetches (dev routes)
 *  don't re-derive it from the env and re-introduce the parsing bug. */
export const ML_URL = resolveMlUrl();
const TIMEOUT_MS = 5000;

// Without the token every call gets a 401 and the app silently degrades to
// rule-based predictions — a failure mode that looks like "the model is meh"
// rather than a misconfiguration. Say it out loud at boot.
if (process.env.NODE_ENV === 'production'
    && process.env.ML_DISABLED !== 'true'
    && !process.env.ML_API_TOKEN) {
  logger.warn('[ML] ML_API_TOKEN absent — le service ML rejettera les appels (401).');
}

/** Headers for a call to the ML service. The token is omitted when unset so a
 *  local run without `ML_API_TOKEN` still works (the service also skips the
 *  check when it has no token — but refuses to boot that way in production). */
export function mlHeaders(base: Record<string, string> = {}): Record<string, string> {
  const token = process.env.ML_API_TOKEN;
  return token ? { ...base, 'X-ML-Token': token } : base;
}

export interface MLFeatureImportance {
  name:       string;
  importance: number;
  direction:  'positive' | 'negative';
}

export interface MLPredictionResult {
  probability:          number;   // integer, 5–95
  confidence:           number;   // integer, 40–95
  feature_importances:  MLFeatureImportance[];
  model_version:        string;
  model_type:           string;
  explanation:          string;
}

// Point d'étranglement unique des trois méthodes publiques : compter ici suffit
// à voir toute la charge envoyée au service Python, qui n'a que 2 workers et
// sature avant le process Node.
async function mlPost<T>(path: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await timeUpstream('ml', async () => {
      const res = await fetch(`${ML_URL}${path}`, {
        method:  'POST',
        headers: mlHeaders({ 'Content-Type': 'application/json' }),
        body:    JSON.stringify(body),
        signal:  controller.signal,
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => res.statusText);
        throw new Error(`ML service ${res.status}: ${msg}`);
      }
      return res.json() as Promise<T>;
    });
  } finally {
    clearTimeout(timer);
  }
}

export const mlApiClient = {
  /** Game-outcome prediction (moneyline / puck-line / totals) */
  predictGame:   (features: unknown) => mlPost<MLPredictionResult>('/predict/game',   features),
  /** Player prop prediction (goals / assists / points / shots / pp_point) */
  predictPlayer: (features: unknown) => mlPost<MLPredictionResult>('/predict/player', features),
  /** Team futures prediction (cup / conf / playoff) */
  predictTeam:   (features: unknown) => mlPost<MLPredictionResult>('/predict/team',   features),
};
