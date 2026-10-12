// ============================================================
//  Réparation d'`odds_log` à partir d'`odds_snapshots` (2026-10-12)
// ============================================================
// Avant le correctif du 2026-10-12 (`oddsLogger.service.ts`), trois défauts
// passaient dans `odds_log`, donc dans `odds_live_log.csv`, `odds.csv` et
// `nhl_games_v4.csv` (STATUS.md §3.5 P) :
//
//   1. l'OUVERTURE était la toute première observation, parfois cinq semaines
//      avant le match, chez un livre inconnu (avant la migration 038) ;
//   2. une partie de ces observations n'étaient pas des moneylines à deux
//      issues (marge 0.79-0.88) ;
//   3. les passes de 21 h 45 / 22 h 45 ET écrasaient la CLÔTURE avec des prix
//      EN DIRECT (1.00 / 31.00) — le score était dans la cote.
//
// Ce module reconstruit l'ouverture et la clôture d'un match avec les règles
// que le collecteur applique désormais, à partir de la série archivée :
//   • livre de collecte seulement (`bookmaker` dans la liste ; une ligne sans
//     livre est d'avant la 038 : on ne sait pas d'où elle vient, on l'écarte) ;
//   • observée le JOUR du match (heure de l'Est) et AVANT la mise au jeu ;
//   • paire plausible (`isValidTwoWay`).
// Rien de valide → prix NULL. Un trou est honnête ; un prix d'août déguisé en
// clôture ne l'est pas.
//
// Logique pure (aucun accès base) : testée dans `oddsLogRepair.test.ts`,
// appelée par `scripts/repair-odds-log.ts`.

import { isValidTwoWay } from './oddsLogger.service';

export interface SnapshotRow {
  game_date: string;            // YYYY-MM-DD (date de l'Est du match)
  home_team: string;
  away_team: string;
  observed_at: string | Date;
  commence_time: string | Date | null;
  bookmaker: string | null;
  home_ml: number | null; away_ml: number | null;
  total: number | null; total_over: number | null; total_under: number | null;
  puck_line_home: number | null; pl_home_price: number | null; pl_away_price: number | null;
}

/** Les colonnes de prix d'`odds_log` que la réparation réécrit. */
export interface RebuiltPrices {
  home_ml_open: number | null; away_ml_open: number | null;
  home_ml_close: number | null; away_ml_close: number | null;
  total_open: number | null; total_close: number | null;
  total_open_over: number | null; total_open_under: number | null;
  total_close_over: number | null; total_close_under: number | null;
  puck_line_home: number | null;
  pl_home_price_open: number | null; pl_away_price_open: number | null;
  pl_home_price: number | null; pl_away_price: number | null;
}

export const PRICE_COLUMNS: (keyof RebuiltPrices)[] = [
  'home_ml_open', 'away_ml_open', 'home_ml_close', 'away_ml_close',
  'total_open', 'total_close', 'total_open_over', 'total_open_under',
  'total_close_over', 'total_close_under',
  'puck_line_home', 'pl_home_price_open', 'pl_away_price_open', 'pl_home_price', 'pl_away_price',
];

const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));

function easternDate(d: string | Date): string {
  return new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/** Une observation est-elle admissible pour `odds_log` ? */
export function usableSnapshot(s: SnapshotRow, books: string[]): boolean {
  if (!s.bookmaker || !books.includes(s.bookmaker)) return false;
  if (!s.commence_time) return false;
  const obs = new Date(s.observed_at).getTime();
  if (!(obs < new Date(s.commence_time).getTime())) return false;
  return easternDate(s.observed_at) === s.game_date;
}

/** Ouverture et clôture d'un match, reconstruites depuis ses snapshots. */
export function rebuildPrices(snaps: SnapshotRow[], books: string[]): RebuiltPrices {
  const ok = snaps
    .filter((s) => usableSnapshot(s, books))
    .sort((a, b) => new Date(a.observed_at).getTime() - new Date(b.observed_at).getTime());

  const ml = ok.filter((s) => isValidTwoWay(num(s.home_ml), num(s.away_ml)));
  const tot = ok.filter((s) => num(s.total) != null && isValidTwoWay(num(s.total_over), num(s.total_under)));
  const pl = ok.filter((s) => {
    const line = num(s.puck_line_home);
    return line != null && Math.abs(Math.abs(line) - 1.5) < 1e-9
      && isValidTwoWay(num(s.pl_home_price), num(s.pl_away_price));
  });
  const first = <T>(a: T[]) => a[0];
  const last = <T>(a: T[]) => a[a.length - 1];

  return {
    home_ml_open: num(first(ml)?.home_ml), away_ml_open: num(first(ml)?.away_ml),
    home_ml_close: num(last(ml)?.home_ml), away_ml_close: num(last(ml)?.away_ml),
    total_open: num(first(tot)?.total), total_close: num(last(tot)?.total),
    total_open_over: num(first(tot)?.total_over), total_open_under: num(first(tot)?.total_under),
    total_close_over: num(last(tot)?.total_over), total_close_under: num(last(tot)?.total_under),
    puck_line_home: num(last(pl)?.puck_line_home),
    pl_home_price_open: num(first(pl)?.pl_home_price), pl_away_price_open: num(first(pl)?.pl_away_price),
    pl_home_price: num(last(pl)?.pl_home_price), pl_away_price: num(last(pl)?.pl_away_price),
  };
}

/** Colonnes qui changent entre la ligne actuelle et la reconstruction. */
export function diffPrices(current: Record<string, unknown>, rebuilt: RebuiltPrices): (keyof RebuiltPrices)[] {
  return PRICE_COLUMNS.filter((c) => {
    const a = num(current[c]);
    const b = rebuilt[c];
    if (a == null && b == null) return false;
    if (a == null || b == null) return true;
    return Math.abs(a - b) > 1e-9;
  });
}
