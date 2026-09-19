/**
 * bench/endpoints.ts — les endpoints critiques, en un seul endroit.
 *
 * « Critique » a un sens précis ici : une requête entrante GRATUITE y déclenche
 * un appel sortant FACTURÉ ou limité en quota (The Odds API, l'API NHL, le
 * service ML Python à deux workers), ou un accès base. Ce sont les seuls
 * endroits où le nombre de visiteurs peut se transformer en facture.
 *
 * La séquence `LANDING` rejoue ce que `HockeyLanding` demande au chargement —
 * c'est le profil du scénario S1 de l'audit, celui qui décide du lancement.
 */

export interface Endpoint {
  /** Identifiant court, pour les tableaux. */
  id: string;
  path: string;
  /** Amont que cet endpoint peut faire payer. */
  pays: Array<'odds' | 'nhl' | 'ml' | 'sql'>;
}

const today = () => new Date().toISOString().slice(0, 10);

export const LANDING: Endpoint[] = [
  { id: 'best-bets',   path: '/api/predict/best-bets?limit=15',                 pays: ['nhl', 'ml', 'odds', 'sql'] },
  { id: 'games-live',  path: '/api/nhl/games/live',                             pays: ['nhl'] },
  { id: 'games-date',  path: `/api/nhl/games?date=${today()}`,                  pays: ['nhl'] },
  { id: 'odds-h2h',    path: '/api/odds/bet365/icehockey_nhl?markets=h2h',      pays: ['odds'] },
  { id: 'odds-totals', path: '/api/odds/bet365/icehockey_nhl?markets=totals',   pays: ['odds'] },
  { id: 'leaderboard', path: '/api/leaderboard',                                pays: ['sql'] },
];

/** Endpoints supplémentaires exercés par les bancs de cache et de N+1. */
export const AUTRES: Endpoint[] = [
  { id: 'teams',       path: '/api/nhl/teams',                                  pays: ['nhl'] },
  { id: 'standings',   path: '/api/nhl/standings',                              pays: ['nhl'] },
  { id: 'players',     path: '/api/nhl/players',                                pays: ['nhl'] },
  { id: 'pred-game',   path: '/api/nhl/predictions/team/bos',                   pays: ['nhl'] },
];

export const TOUS: Endpoint[] = [...LANDING, ...AUTRES];
