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

const ML_URL = process.env.ML_SERVICE_URL || 'http://localhost:8000';
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

async function mlPost<T>(path: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
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
