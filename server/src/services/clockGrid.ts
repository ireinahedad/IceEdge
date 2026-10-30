// ============================================================
//  clockGrid — caler les jobs de fond sur l'horloge murale
// ============================================================
// Neon suspend le compute après 5 min SANS requête. Chaque job périodique
// (règlement, value bets, news, warmup ML…) réveille la base et la garde
// allumée ≥ 5 min. Tant que chaque job partait de l'heure de démarrage du
// process, leurs réveils tombaient à des instants dispersés et chaque réveil
// ouvrait SA PROPRE fenêtre de 5 min : la base ne dormait presque jamais.
//
// Calés sur la même grille (:00 / :15 / :30 / :45 UTC), les réveils se
// superposent et partagent une seule fenêtre. Voir DEPLOYMENT.md, « Budget
// compute ».

export const QUARTER_MS = 15 * 60_000;
export const HOUR_MS = 60 * 60_000;

/**
 * Marge absorbant la gigue des timers : un tick prévu à 13:00:00 qui part à
 * 13:00:00.004 et redemande « dans 60 min » doit tomber à 14:00, pas à 14:15.
 */
const SLACK_MS = 30_000;
const MIN_MS = 1_000;

/**
 * Délai (ms) jusqu'au premier point de la grille situé à `delayMs` (± 30 s)
 * ou après. La grille est comptée depuis l'époque Unix, donc en UTC : avec
 * `gridMs` = 15 min ou 1 h elle tombe aussi sur les quarts d'heure ET et Bali.
 */
export function onClockGrid(delayMs: number, now = Date.now(), gridMs = QUARTER_MS): number {
  const target = Math.ceil((now + delayMs - SLACK_MS) / gridMs) * gridMs;
  return Math.max(MIN_MS, target - now);
}

/** Grille naturelle d'une période : l'heure pour ≥ 1 h, sinon la période elle-même. */
export function gridFor(periodMs: number): number {
  return periodMs >= HOUR_MS ? HOUR_MS : Math.max(periodMs, 60_000);
}
