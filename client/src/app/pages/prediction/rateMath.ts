/**
 * rateMath.ts — d'une CADENCE par match à la probabilité d'un seuil.
 *
 * Partagé par les grilles de paris joueur (`PlayerPropGrid`) et la page d'un
 * joueur (`PlayerPrediction`) : les deux lisent les cadences de
 * `/predictions/player-rates/...` et doivent en tirer le même chiffre pour le
 * même pari.
 */
import type { MLPredictionResult } from "../../components/MLPredictionCard";
import type { PlayerRatesResponse, RateStat } from "../../services/nhlApiService";

/**
 * P(X ≥ k) pour une binomiale négative de moyenne λ, dispersion `disp`
 * (`null` = Poisson).
 */
export function nbAtLeast(lambda: number, k: number, disp: number | null): number {
  if (k <= 0) return 1;
  const lam = Math.max(1e-6, lambda);
  let term: number, cdf: number;
  if (disp == null || !Number.isFinite(disp)) {
    term = Math.exp(-lam); cdf = term;
    for (let i = 1; i < k; i++) { term *= lam / i; cdf += term; }
  } else {
    const q = lam / (disp + lam);
    term = Math.pow(disp / (disp + lam), disp); cdf = term;
    for (let n = 0; n < k - 1; n++) { term *= ((n + disp) / (n + 1)) * q; cdf += term; }
  }
  return Math.max(0, 1 - cdf);
}

/** P(X > line) côté « over », ou son complément côté « under ». En %. */
export function ratePct(lambda: number, line: number, disp: number | null, side: "over" | "under"): number {
  const over = nbAtLeast(lambda, Math.floor(line) + 1, disp);
  return Math.min(97, Math.round((side === "under" ? 1 - over : over) * 100));
}

/** Résultat ML « maison » à poser dans `BetOpt.mlPreset`. */
export function presetResult(probability: number, modelType: string, explanation: string): MLPredictionResult {
  return { probability, confidence: null, feature_importances: [], model_type: modelType, explanation };
}

/**
 * La dispersion à utiliser pour UNE ligne : celle du modèle joueur si la
 * cadence vient de lui, celle de la règle sinon. Les deux ne sont pas
 * interchangeables — le modèle, qui connaît le temps de glace, laisse beaucoup
 * moins de variance inexpliquée (buts, passes, points : Poisson).
 */
export function dispersionFor(resp: PlayerRatesResponse, source: "model" | "rules" | undefined, stat: RateStat): number | null {
  if (source === "model") {
    const k = resp.modelDispersion?.[stat];
    return k === undefined ? (resp.dispersion?.[stat] ?? null) : k;
  }
  return resp.dispersion?.[stat] ?? null;
}

/** Clés i18n du libellé et de la note, selon la source de la cadence. */
export function rateLabels(source: "model" | "rules" | undefined): { model: string; note: string } {
  return source === "model"
    ? { model: "prop.playerModel", note: "prop.playerModelNote" }
    : { model: "prop.mlModel", note: "prop.mlNote" };
}

/** Sous ce pourcentage, une case affiche « <3% ». */
export const BELOW_FLOOR = 3;
