/**
 * predictionFactors.ts
 * Modèle de règles « boîte de verre » : combine plusieurs facteurs indépendants
 * en une probabilité de victoire domicile par MOYENNE PONDÉRÉE, et expose le
 * détail du calcul pour l'affichage utilisateur.
 *
 *   prob finale = Σ(poids × valeur) / Σ(poids)   sur les seuls facteurs actifs
 *
 * Chaque facteur estime P(victoire domicile) de son propre point de vue (0–1,
 * 0.5 = neutre). C'est volontairement STATIQUE et transparent : les règles ne
 * s'améliorent pas toutes seules — c'est le rôle du modèle ML, qui reprend les
 * mêmes features mais apprend et finit par les dépasser.
 *
 * ── Poids ──────────────────────────────────────────────────────────────────────
 * Non calibrables statistiquement sur nhl_games.csv (ni cote, ni blessure, ni
 * alignement dans l'historique). Valeurs par défaut choisies pour rester lisibles
 * et modérées : la cote de clôture n'est pas dominante, ce qui garde les règles
 * en-dessous d'un ML bien entraîné plutôt que de simplement recopier le marché.
 * Ré-ajustables librement (ex. via les paramètres utilisateur).
 */

export const FACTOR_WEIGHTS = {
  quality:  0.30,  // qualité d'équipe (win% saison + forme L10)
  homeIce:  0.10,  // avantage de jouer à domicile
  fatigue:  0.10,  // épuisement : repos & back-to-back, une équipe vs l'autre
  odds:     0.28,  // cote de clôture du marché (dé-viggée)
  injuries: 0.14,  // blessures (saisie manuelle)
  lineup:   0.08,  // nouvel alignement / joueurs manquants (saisie manuelle)
} as const;

export type FactorWeights = Record<keyof typeof FACTOR_WEIGHTS, number>;

export interface ManualFactor { active: boolean; homeProb: number; note?: string }

export interface FactorInputs {
  quality:   number;                 // 0–1, toujours actif
  homeIce:   number;                 // 0–1, toujours actif
  fatigue:   number;                 // 0–1, toujours actif
  odds?:     number | null;          // 0–1, actif si cote dispo
  injuries?: ManualFactor | null;    // actif si blessures saisies
  lineup?:   ManualFactor | null;    // actif si alignement/joueur manquant saisi
}

export interface FactorLine {
  id:     keyof typeof FACTOR_WEIGHTS;
  label:  string;
  weight: number;   // poids brut (avant renormalisation)
  value:  number;   // 0–1
}

export interface BlendResult {
  homeProb: number;
  lines:    FactorLine[];
}

const LABELS: Record<keyof typeof FACTOR_WEIGHTS, string> = {
  quality:  'Qualité',
  homeIce:  'Domicile',
  fatigue:  'Épuisement',
  odds:     'Cote marché',
  injuries: 'Blessures',
  lineup:   'Alignement',
};

function clamp01(x: number): number { return Math.max(0.03, Math.min(0.97, x)); }

/**
 * Facteur "avantage domicile" dérivé des splits domicile/route :
 * base ~0.55 (taux de victoire à domicile NHL), modulée si l'équipe locale
 * surperforme chez elle et/ou si la visiteuse est faible à l'extérieur.
 */
export function homeIceFactor(homeOverall: number, homeSplit: number,
                              awayOverall: number, awaySplit: number): number {
  const local = homeSplit - homeOverall;   // surperformance maison à domicile
  const road  = awaySplit - awayOverall;   // surperformance visiteur à l'extérieur
  return clamp01(0.55 + 0.5 * (local - road));
}

/**
 * Facteur "épuisement" : repos et back-to-back d'une équipe vs l'autre.
 * 0.5 neutre ; >0.5 favorise la maison (mieux reposée).
 */
export function fatigueFactor(hRest: number, aRest: number,
                              hB2b: 0 | 1, aB2b: 0 | 1): number {
  let f = 0.5;
  f += 0.02 * Math.max(-3, Math.min(3, hRest - aRest)); // différentiel de repos
  f -= 0.06 * hB2b;   // maison en back-to-back
  f += 0.06 * aB2b;   // visiteur en back-to-back
  return clamp01(f);
}

/** Moyenne pondérée sur les facteurs actifs (poids renormalisés). */
export function blendHomeProb(input: FactorInputs, weights: FactorWeights = FACTOR_WEIGHTS): BlendResult {
  const lines: FactorLine[] = [
    { id: 'quality', label: LABELS.quality, weight: weights.quality, value: input.quality },
    { id: 'homeIce', label: LABELS.homeIce, weight: weights.homeIce, value: input.homeIce },
    { id: 'fatigue', label: LABELS.fatigue, weight: weights.fatigue, value: input.fatigue },
  ];
  if (input.odds != null) {
    lines.push({ id: 'odds', label: LABELS.odds, weight: weights.odds, value: input.odds });
  }
  if (input.injuries?.active) {
    lines.push({ id: 'injuries', label: LABELS.injuries, weight: weights.injuries, value: input.injuries.homeProb });
  }
  if (input.lineup?.active) {
    lines.push({ id: 'lineup', label: LABELS.lineup, weight: weights.lineup, value: input.lineup.homeProb });
  }

  const wsum = lines.reduce((s, l) => s + l.weight, 0) || 1;
  const homeProb = clamp01(lines.reduce((s, l) => s + l.weight * l.value, 0) / wsum);
  return { homeProb, lines };
}

/**
 * Formate le détail pour affichage, façon :
 *   "Qualité 0.33×61% + Domicile 0.11×55% + Cote marché 0.31×64% = 60%"
 * (poids renormalisés sur les facteurs actifs).
 */
export function formatBreakdown(res: BlendResult): string {
  const wsum = res.lines.reduce((s, l) => s + l.weight, 0) || 1;
  const parts = res.lines.map(l =>
    `${l.label} ${(l.weight / wsum).toFixed(2)}×${Math.round(l.value * 100)}%`);
  return `${parts.join(' + ')} = ${Math.round(res.homeProb * 100)}%`;
}
