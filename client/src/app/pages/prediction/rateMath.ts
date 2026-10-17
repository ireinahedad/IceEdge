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

/**
 * P(X ≥ k) du modèle : sur l'échelle [P(X ≥ 1), P(X ≥ 2), …] quand le serveur
 * en fournit une (pénalités en nombre, 2026-10-16), sinon la binomiale négative.
 */
export function modelAtLeast(lambda: number, k: number, disp: number | null, ladder?: number[]): number {
  if (ladder && ladder.length) return k <= 0 ? 1 : k <= ladder.length ? ladder[k - 1] : 0;
  return nbAtLeast(lambda, k, disp);
}

/**
 * Pénalités en nombre, sur une part `f` du match (2026-10-17) : P(minutes ≥
 * `need`) quand le nombre de pénalités suit BN(mu·f, k·f) (Poisson si
 * k = null) et que chacune dure `dur[i]` minutes avec probabilité `mix[i]`.
 * À f = 1, c'est exactement l'échelle d'avant-match du serveur.
 */
export function pimCompoundAtLeast(
  p: { mu: number; k: number | null; dur: number[]; mix: number[] }, need: number, f = 1,
): number {
  if (need <= 0) return 1;
  const m = Math.max(1e-9, p.mu * f);
  const k = p.k == null || !Number.isFinite(p.k) ? null : p.k * f;
  const NMAX = 8;
  // P(N = n), n = 0…NMAX (la queue est rangée dans NMAX).
  const pn: number[] = [];
  if (k == null) {
    let t = Math.exp(-m); pn.push(t);
    for (let n = 1; n <= NMAX; n++) { t *= m / n; pn.push(t); }
  } else {
    const q = m / (k + m);
    let t = Math.pow(k / (k + m), k); pn.push(t);
    for (let n = 1; n <= NMAX; n++) { t *= ((n - 1 + k) / n) * q; pn.push(t); }
  }
  pn[NMAX] += Math.max(0, 1 - pn.reduce((a, b) => a + b, 0));
  // P(somme des durées = s) pour s < need, par convolutions successives.
  let conv = new Array(need).fill(0); conv[0] = 1;
  let below = pn[0];                                   // N = 0 → 0 minute (< need)
  for (let n = 1; n <= NMAX; n++) {
    const next = new Array(need).fill(0);
    for (let s = 0; s < need; s++) {
      if (!conv[s]) continue;
      for (let i = 0; i < p.dur.length; i++) {
        const t = s + p.dur[i];
        if (t < need) next[t] += conv[s] * p.mix[i];
      }
    }
    conv = next;
    below += pn[n] * conv.reduce((a, b) => a + b, 0);
  }
  return Math.max(0, Math.min(1, 1 - below));
}

/** P(X > line) côté « over », ou son complément côté « under ». En %. */
export function ratePct(lambda: number, line: number, disp: number | null, side: "over" | "under",
                        ladder?: number[]): number {
  const over = modelAtLeast(lambda, Math.floor(line) + 1, disp, ladder);
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
export function dispersionFor(
  resp: PlayerRatesResponse, source: "model" | "rules" | undefined, stat: RateStat,
  rowK?: Partial<Record<RateStat, number | null>>,
): number | null {
  if (source === "model") {
    // Dispersion par profil (mises en échec) : le k propre au joueur prime.
    if (rowK && stat in rowK) return rowK[stat] ?? null;
    const k = resp.modelDispersion?.[stat];
    return k === undefined ? (resp.dispersion?.[stat] ?? null) : k;
  }
  return resp.dispersion?.[stat] ?? null;
}

/**
 * Clés i18n du libellé et de la note, selon la source de la cadence. Les arrêts
 * d'un gardien « modèle » viennent du modèle de TIRS (piste 3), pas du modèle
 * joueur : leur note ne parle pas de temps de glace.
 */
export function rateLabels(source: "model" | "rules" | undefined, stat?: RateStat): { model: string; note: string } {
  if (source === "model" && stat === "saves") return { model: "prop.shotsModel", note: "prop.shotsModelNote" };
  return source === "model"
    ? { model: "prop.playerModel", note: "prop.playerModelNote" }
    : { model: "prop.mlModel", note: "prop.mlNote" };
}

/** Sous ce pourcentage, une case affiche « <3% ». */
export const BELOW_FLOOR = 3;
