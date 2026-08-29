/**
 * Prediction / ML Model API Service
 *
 * Configure the prediction server via environment variable:
 *   VITE_PREDICTION_API_URL=https://your-ml-server.com/api
 *
 * ⚠️ THERE IS NO LOCAL FALLBACK, AND THERE MUST NEVER BE ONE.
 * When the API is unconfigured, unreachable, or answers with an error, every
 * method here throws `PredictionUnavailableError`. Callers must render an
 * unavailable state — never a number.
 *
 * Why this rule exists: until 2026-08-29 this file shipped `buildMockPrediction`
 * and friends, which invented a probability from hardcoded team win rates and
 * derived a full American odds label from it (`-150`, `+230`). Both were rendered
 * exactly like a real model output, under the label "Cote", the moment the API
 * blinked. A wrong number that looks right is worse than no number at all.
 *
 * Server endpoints:
 *   POST /api/predict/single       → PredictionResponse
 *   POST /api/predict/parlay       → ParlayPredictionResponse
 *   POST /api/predict/player-prop  → PlayerPropResponse
 *   GET  /api/predict/best-bets    → BestBetsResponse
 */

import type {
  PredictionRequest,
  PredictionResponse,
  ParlayPredictionRequest,
  ParlayPredictionResponse,
  BetMarketType,
} from "./../types/bet";

const BASE_URL = import.meta.env.VITE_PREDICTION_API_URL || "";

// ─── Error type ───────────────────────────────────────────────────────────────

export type PredictionUnavailableReason =
  | "not_configured" // VITE_PREDICTION_API_URL absent from the build
  | "network"        // fetch itself failed — offline, DNS, CORS, timeout
  | "http"           // the server answered, but not with a prediction
  | "bad_response";  // 2xx with a body we can't read as JSON

/**
 * The single failure type this service raises. It carries enough for the UI to
 * say something true ("service indisponible" vs "hors ligne") without ever
 * needing to guess a value.
 */
export class PredictionUnavailableError extends Error {
  readonly reason: PredictionUnavailableReason;
  readonly status?: number;

  constructor(reason: PredictionUnavailableReason, message: string, status?: number) {
    super(message);
    this.name = "PredictionUnavailableError";
    this.reason = reason;
    this.status = status;
  }
}

export function isPredictionUnavailable(e: unknown): e is PredictionUnavailableError {
  return e instanceof PredictionUnavailableError;
}

/** i18n key describing a failure, for the UI to render. */
export function predictionErrorKey(e: unknown): string {
  if (!isPredictionUnavailable(e)) return "pred.unavailable";
  switch (e.reason) {
    case "not_configured": return "pred.unavailableNotConfigured";
    case "network":        return "pred.unavailableOffline";
    default:               return "pred.unavailable";
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!BASE_URL) {
    throw new PredictionUnavailableError(
      "not_configured",
      "VITE_PREDICTION_API_URL is not set in this build"
    );
  }

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch (cause) {
    throw new PredictionUnavailableError(
      "network",
      `Prediction API unreachable: ${String(cause)}`
    );
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new PredictionUnavailableError(
      "http",
      `Prediction API error ${res.status}: ${detail}`,
      res.status
    );
  }

  try {
    return (await res.json()) as T;
  } catch (cause) {
    throw new PredictionUnavailableError(
      "bad_response",
      `Prediction API returned an unreadable body: ${String(cause)}`,
      res.status
    );
  }
}

const post = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: "POST", body: JSON.stringify(body) });

const get = <T>(path: string): Promise<T> => request<T>(path, { method: "GET" });

// ─── Best Bets ────────────────────────────────────────────────────────────────

export interface ApiBestBet {
  id:             string;
  subjectType:    "game" | "player";
  marketType:     BetMarketType;
  marketLabel:    string;
  subjectId:      string;
  subjectName:    string;
  subjectLogo:    string;
  teamAbbr:       string | null;
  label:          string;
  selection:      string;
  selectionValue: string;
  selectionShort: string;
  context:        string;
  line:           number | null;
  gameId:         string | null;
  teamId:         string | null;
  playerId:       string | null;
  rulePct:        number;
  mlPct:          number | null;
  score:          number;
  source:         "ml" | "rules";
  confidence:     "very_high" | "high" | "medium" | "low" | "very_low";
}

export interface BestBetsResponse {
  bets: ApiBestBet[];
  meta: { generatedAt: string; source: string; mlAvailable: boolean; scanned: number };
}

// ─── Prediction service ───────────────────────────────────────────────────────

export const predictionApiService = {
  /**
   * Top individual bets across all markets, ranked by prediction score.
   * ML-first with rule fallback — that arbitration happens server-side, on real
   * data. Throws `PredictionUnavailableError`.
   */
  getBestBets: async (
    opts: { limit?: number; source?: "ml" | "rules"; days?: number; players?: number } = {}
  ): Promise<BestBetsResponse> => {
    const qs = new URLSearchParams();
    if (opts.limit   != null) qs.set("limit",   String(opts.limit));
    if (opts.source  != null) qs.set("source",  opts.source);
    if (opts.days    != null) qs.set("days",    String(opts.days));
    if (opts.players != null) qs.set("players", String(opts.players));
    const q = qs.toString();
    return get<BestBetsResponse>(`/predict/best-bets${q ? `?${q}` : ""}`);
  },

  /**
   * Win/hit probability for a single bet market.
   * Throws `PredictionUnavailableError` — there is no local estimation.
   */
  getSinglePrediction: (req: PredictionRequest): Promise<PredictionResponse> =>
    post<PredictionResponse>("/predict/single", req),

  /**
   * Combined probability for a multi-leg parlay. The server accounts for
   * correlated legs; multiplying client-side would assume independence and
   * quietly overstate the parlay, so there is no fallback.
   * Throws `PredictionUnavailableError`.
   */
  getParlayPrediction: (
    req: ParlayPredictionRequest
  ): Promise<ParlayPredictionResponse> =>
    post<ParlayPredictionResponse>("/predict/parlay", req),
};

// ─── Factor / player-prop types ───────────────────────────────────────────────

export interface CalcFactor {
  icon: string;
  label: string;
  delta: number;
}

export interface PlayerPropRequest {
  playerId: string;
  playerName: string;
  propType: "goals" | "points" | "assists" | "award";
  line: number;
  season: string;
  currentGoals?: number;
  currentPoints?: number;
  currentAssists?: number;
  gamesPlayed?: number;
}

export interface PlayerPropResponse {
  probability: number;
  /** Only present when the server has a real price to show. Never synthesised. */
  oddsLabel?: string;
  factors: CalcFactor[];
  betNote: string;
}

export const factorsApiService = {
  /**
   * Season prop probability for a player.
   * POST /api/predict/player-prop
   * Throws `PredictionUnavailableError`.
   */
  getPlayerProp: (req: PlayerPropRequest): Promise<PlayerPropResponse> =>
    post<PlayerPropResponse>("/predict/player-prop", req),
};
