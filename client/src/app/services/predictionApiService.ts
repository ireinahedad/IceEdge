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
import { authedFetch } from "./authService";

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
  /** Le match du pari (jour NHL, mise au jeu, domicile / visiteur). Optionnel : serveur plus ancien. */
  game?:          { date: string | null; startTimeUTC: string | null; home: string; away: string } | null;
}

// ─── Best Parlay ──────────────────────────────────────────────────────────────

/**
 * Un combiné construit par le serveur (`bestParlays.service.ts`) avec les
 * jambes de « Meilleurs paris » : mêmes objets, mêmes %. Le client ne combine
 * rien — il affiche.
 */
/**
 * Forme d'un combiné : `moneyline` / `mixed` pour ceux de l'accueil, les autres
 * pour la page « Plus de parlays » (2026-10-11).
 */
export type ParlayKind = "moneyline" | "mixed" | "same_game" | "same_team" | "same_market";

export interface ApiBestParlay {
  id:                  string;
  kind:                ParlayKind;
  /** « Plus de parlays » : ce que les jambes ont en commun (`TOR`, `MTL@TOR`, `shots_ou`). */
  group?:              string | null;
  locked?:             false;
  legs:                ApiBestBet[];
  /** 0–100 au dixième, corrélations comprises (même calcul que le coupon). */
  probability:         number;
  assumesIndependence: boolean;
  coherentPairs:       number;
  /** Produit des prix du livre, quand toutes les jambes sont cotées et sur des matchs différents. */
  bookPrice:           number | null;
}

/** Combiné Pro vu par un non-abonné : la forme seulement, aucun contenu. */
export interface ApiLockedParlay {
  id:       string;
  kind:     ParlayKind;
  locked:   true;
  legCount: number;
}

export interface BestParlaysResponse {
  parlays: (ApiBestParlay | ApiLockedParlay)[];
  meta: { generatedAt: string; day: string | null; mlAvailable: boolean; freeCount: number; total: number };
}

/**
 * Page « Plus de parlays » (2026-10-11) : en tête les combinés de l'accueil
 * (tous cotés), puis 2 à 8 jambes — même match, même équipe, même type,
 * mélangés — dont des jambes sans cote. Une seule journée.
 */
export interface MoreParlaysResponse {
  featured: (ApiBestParlay | ApiLockedParlay)[];
  more:     (ApiBestParlay | ApiLockedParlay)[];
  meta: { generatedAt: string; day: string | null; mlAvailable: boolean; freeCount: number; total: number };
}

// ─── Value bets (Pro) ─────────────────────────────────────────────────────────

/**
 * Un value bet, tel que le CALCULE le serveur (`valueBets.service.ts`). Le
 * client ne juge plus rien : l'accueil et l'alerte push lisent le même critère.
 * Probabilités en fraction 0–1, cotes en décimal.
 */
export interface ApiValueBet {
  id:           string;
  gameId:       string;
  gameDate:     string;
  startTimeUTC: string | null;
  market:       "moneyline" | "puck_line";
  team:         string;
  opponent:     string;
  isHome:       boolean;
  line:         number | null;
  modelProb:    number;
  marketProb:   number;
  edge:         number;
  ev:           number;
  price:        number;
  bookmaker:    string;
  bookTitle:    string;
  /** Seuil de rentabilité selon le modèle (1 / modelProb), en décimal. */
  minOdds:      number;
}

export interface ValueBetsResponse {
  bets: ApiValueBet[];
  meta: { generatedAt: string };
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
    opts: { limit?: number; source?: "ml" | "rules"; days?: number; players?: number; date?: string } = {}
  ): Promise<BestBetsResponse> => {
    const qs = new URLSearchParams();
    if (opts.limit   != null) qs.set("limit",   String(opts.limit));
    if (opts.source  != null) qs.set("source",  opts.source);
    if (opts.days    != null) qs.set("days",    String(opts.days));
    if (opts.players != null) qs.set("players", String(opts.players));
    // Jour choisi sur l'accueil (AAAA-MM-JJ) : le serveur ne garde que ses matchs.
    if (opts.date)            qs.set("date",    opts.date);
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

  /**
   * Les value bets du moment — réservé aux Pro, d'où la requête AUTHENTIFIÉE
   * (`authedFetch`), contrairement au reste de ce service. Throws
   * `PredictionUnavailableError` (402 = l'abonnement n'est plus actif).
   */
  /**
   * « Best Parlay » de l'accueil. Requête AUTHENTIFIÉE quand une session
   * existe (`authedFetch` n'ajoute rien sinon) : c'est le serveur qui décide,
   * sur l'abonnement, quels combinés sont envoyés en entier. Appelée une seule
   * fois, à la première ouverture de la section. Throws `PredictionUnavailableError`.
   */
  /** Page « Plus de parlays » pour un jour (AAAA-MM-JJ). Throws `PredictionUnavailableError`. */
  getMoreParlays: async (date?: string): Promise<MoreParlaysResponse> => {
    let res: Response;
    try {
      res = await authedFetch(`/predict/more-parlays${date ? `?date=${encodeURIComponent(date)}` : ""}`);
    } catch (cause) {
      throw new PredictionUnavailableError("network", `More parlays unreachable: ${String(cause)}`);
    }
    if (!res.ok) {
      throw new PredictionUnavailableError("http", `More parlays error ${res.status}`, res.status);
    }
    try {
      return (await res.json()) as MoreParlaysResponse;
    } catch (cause) {
      throw new PredictionUnavailableError("bad_response", `More parlays unreadable: ${String(cause)}`, res.status);
    }
  },

  getBestParlays: async (date?: string): Promise<BestParlaysResponse> => {
    let res: Response;
    try {
      res = await authedFetch(`/predict/best-parlays${date ? `?date=${encodeURIComponent(date)}` : ""}`);
    } catch (cause) {
      throw new PredictionUnavailableError("network", `Best parlays unreachable: ${String(cause)}`);
    }
    if (!res.ok) {
      throw new PredictionUnavailableError("http", `Best parlays error ${res.status}`, res.status);
    }
    try {
      return (await res.json()) as BestParlaysResponse;
    } catch (cause) {
      throw new PredictionUnavailableError("bad_response", `Best parlays unreadable: ${String(cause)}`, res.status);
    }
  },

  getValueBets: async (): Promise<ValueBetsResponse> => {
    let res: Response;
    try {
      res = await authedFetch("/predict/value-bets");
    } catch (cause) {
      throw new PredictionUnavailableError("network", `Value bets unreachable: ${String(cause)}`);
    }
    if (!res.ok) {
      throw new PredictionUnavailableError("http", `Value bets error ${res.status}`, res.status);
    }
    try {
      return (await res.json()) as ValueBetsResponse;
    } catch (cause) {
      throw new PredictionUnavailableError("bad_response", `Value bets unreadable: ${String(cause)}`, res.status);
    }
  },
};

