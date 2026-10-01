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
 *   GET  /api/predict/best-bets    → BestBetsResponse
 */

import type {
  PredictionRequest,
  PredictionResponse,
  ParlayPredictionRequest,
  ParlayPredictionResponse,
  BetMarketType,
} from "./../types/bet";
import { env } from "../env";
import { fetchWithTimeout } from "./http";

const BASE_URL = env.predictionApiUrl;

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
class PredictionUnavailableError extends Error {
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
    res = await fetchWithTimeout(`${BASE_URL}${path}`, {
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
  /** Vrai prix du livre d'affichage (BetRivers), `null` si non coté.
   *  Optionnel : un serveur plus ancien ne l'envoie pas. */
  bookPrice?:     number | null;
  bookTitle?:     string | null;
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
   *
   * Throws `PredictionUnavailableError` — there is no local estimation. Le
   * serveur répond 422 quand son moteur ne sait pas calculer ce marché avec ce
   * corps (écart de victoire sans seau, période non précisée, marché inconnu) :
   * c'est un `reason: "http"` ici, donc un état « indisponible » à l'écran, et
   * c'est exactement ce qu'on veut. Il servait 12, 24, 38 ou 50 avant.
   *
   * La réponse peut porter un `caveat` : le chiffre est bon, mais il y a
   * quelque chose à dire dessus (moyenne de ligue, estimateur partagé…). Les
   * appelants doivent l'afficher.
   */
  getSinglePrediction: (req: PredictionRequest): Promise<PredictionResponse> =>
    post<PredictionResponse>("/predict/single", req),

  /**
   * Combined probability for a multi-leg parlay.
   *
   * ⚠️ CETTE DOCSTRING A MENTI. Elle affirmait « The server accounts for
   * correlated legs », et le schéma acceptait même un champ `correlation` pour
   * le faire croire. La route multipliait les jambes et appliquait 0,95 — rien
   * d'autre. « Domicile gagne » + « Extérieur gagne » sur le même match
   * répondait 22,8 % pour un événement impossible.
   *
   * Ce que la route fait VRAIMENT depuis le 2026-09-13 (`services/parlay.ts`) :
   * elle reconnaît les jambes incompatibles (→ 0), les doublons et les
   * implications, multiplie le reste, et signale par `assumesIndependence`
   * quand des jambes d'un même match n'ont pas de relation logique connue —
   * le seul cas où le chiffre reste approximatif.
   *
   * Le coupon de l'application n'appelle PLUS cette route : il calcule la même
   * chose hors ligne en important `server/src/services/parlay.ts` directement.
   * Cette méthode reste pour les appels externes.
   *
   * Throws `PredictionUnavailableError`.
   */
  getParlayPrediction: (
    req: ParlayPredictionRequest
  ): Promise<ParlayPredictionResponse> =>
    post<ParlayPredictionResponse>("/predict/parlay", req),
};

