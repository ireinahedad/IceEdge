/**
 * k de la binomiale négative du modèle joueur pour UNE cadence : par profil
 * quand le paquet en porte un pour cette stat (`playerDispersionTiers`,
 * `explore_players/dispersion.py`, 2026-10-16), sinon le k unique de la stat.
 * `null` = Poisson. Module sans dépendance : partagé par la page du match
 * (`playerRates.ts`), le prop isolé (`playerModelPrediction.ts`) et les
 * meilleurs paris (`bestBets.service.ts`).
 */
export interface PlayerDispersionSource {
  playerDispersion?:      Record<string, number | null>;
  playerDispersionTiers?: Record<string, { cuts: number[]; k: Array<number | null> }>;
}

export function playerModelK(b: PlayerDispersionSource, stat: string, rate: number): number | null {
  const t = b.playerDispersionTiers?.[stat];
  if (t && Array.isArray(t.cuts) && Array.isArray(t.k) && t.k.length === t.cuts.length + 1) {
    let i = 0;
    while (i < t.cuts.length && rate >= t.cuts[i]) i++;
    return t.k[i] ?? null;
  }
  return b.playerDispersion?.[stat] ?? null;
}

/**
 * P(X ≥ n) lue sur une échelle [P(X ≥ 1), P(X ≥ 2), …] (pénalités en nombre).
 * n ≤ 0 → 1 ; au-delà de l'échelle → 0.
 */
export function ladderAtLeast(ladder: number[], n: number): number {
  if (n <= 0) return 1;
  return n <= ladder.length ? ladder[n - 1] : 0;
}
