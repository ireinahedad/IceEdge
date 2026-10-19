/**
 * Rythme de rafraîchissement d'un match EN DIRECT (`ml/EXPLICATION_ML.md` §10.2).
 *
 * Le rejeu de fraîcheur (`server/scripts/replay-live-staleness.ts`) montre qu'un
 * chiffre en retard de 30 s ne coûte presque rien en milieu de match (+0,8 % de
 * log-loss) mais +19 % dans les deux dernières minutes, où un but change tout.
 * D'où deux rythmes : 30 s pendant la partie, 10 s en FIN de match (3e période
 * à 5 minutes ou moins de la fin, ou prolongation). Tous les caches du direct —
 * page `landing` de la NHL, feuille de match, paquet ML en direct, en-tête HTTP,
 * client — lisent ce même rythme, sinon le plus lent d'entre eux décide.
 */

export const LIVE_REFRESH_MS    = 30_000;
export const ENDGAME_REFRESH_MS = 10_000;
/** Fin de match : à partir de 5 minutes de la fin de la 3e période. */
export const ENDGAME_SECONDS    = 300;

/** « MM:SS » → secondes ; null si illisible. */
function clockSeconds(clock: unknown): number | null {
  if (typeof clock !== 'string' || !clock.includes(':')) return null;
  const [m, s] = clock.split(':').map(Number);
  return Number.isFinite(m) && Number.isFinite(s) ? m * 60 + s : null;
}

/**
 * Le match est-il dans sa fin (3e période à ≤ 5 min, ou prolongation) ?
 * Entracte : faux (l'horloge affiche le décompte de la pause, pas du jeu).
 * Horloge illisible en 3e : vrai, par prudence (mieux vaut rafraîchir trop).
 */
export function isEndgame(period: unknown, clock: unknown, periodType?: unknown, inIntermission?: boolean): boolean {
  const p = Number(period);
  if (!Number.isFinite(p) || inIntermission) return false;
  const type = String(periodType ?? 'REG').toUpperCase();
  if (type === 'OT' || type === 'SO' || p > 3) return true;
  if (p < 3) return false;
  const left = typeof clock === 'number' ? clock : clockSeconds(clock);
  return left === null || left <= ENDGAME_SECONDS;
}

/** Durée de validité d'une donnée de match en direct. */
export function liveRefreshMs(period: unknown, clock: unknown, periodType?: unknown, inIntermission?: boolean): number {
  return isEndgame(period, clock, periodType, inIntermission) ? ENDGAME_REFRESH_MS : LIVE_REFRESH_MS;
}
