/**
 * mlApiClient.ts
 * HTTP client for the Python ML service (default: http://localhost:8000).
 * All methods throw on error so callers can fall back to rule-based.
 */

const ML_URL = process.env.ML_SERVICE_URL || 'http://localhost:8000';
const TIMEOUT_MS = 5000;

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
      headers: { 'Content-Type': 'application/json' },
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
