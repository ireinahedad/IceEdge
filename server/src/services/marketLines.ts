/**
 * marketLines.ts — les lignes proposées pour les marchés plus/moins.
 *
 * Une seule source, lue par le CLIENT (`client/src/app/data/betMarkets.ts`,
 * les boutons de ligne de la feuille « + Ajouter ») et par le SERVEUR (la
 * validation de ce que rend le LLM pour le Bet builder IA, `slipCommand`).
 * Décision du user, 2026-09-28 : déplacer plutôt que recopier — deux copies
 * finiraient par diverger, et le serveur accepterait alors une ligne que
 * l'écran ne propose pas (ou l'inverse).
 *
 * Ne portent ici que les six marchés que la commande en langage naturel sait
 * lire (SLIP_COMMANDE_PLAN.md § 3.4). Les autres lignes restent dans
 * `betMarkets.ts` tant qu'aucun code serveur n'en a besoin.
 *
 * ⚠️ PARTAGÉ AVEC LE CLIENT, comme `parlay.ts` : aucun import, et
 * `client/vite.config.ts` doit l'autoriser dans `server.fs.allow`.
 */

export const MARKET_LINES = {
  total_goals:      [4.5, 5.0, 5.5, 6.0, 6.5, 7.0],
  team_total_goals: [1.5, 2.0, 2.5, 3.0, 3.5],
  shots_ou:         [1.5, 2.5, 3.5, 4.5, 5.5],
  assists_ou:       [0.5, 1.5, 2.5],
  points_ou:        [0.5, 1.5, 2.5, 3.5],
  goalie_saves_ou:  [20.5, 22.5, 24.5, 26.5, 28.5, 30.5],
} as const satisfies Record<string, readonly number[]>;
