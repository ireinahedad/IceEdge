/**
 * nhl/moneypuck.ts — Corsi et Fenwick de la saison, lus chez MoneyPuck.
 *
 * L'API NHL n'expose le Corsi/Fenwick qu'à 5 contre 5 et en pourcentage
 * (`team/percentages`, `team/summaryshooting`). Le moteur de règles a besoin du
 * VOLUME de Fenwick toutes situations, pour et contre — c'est la variante
 * mesurée gagnante contre les tirs cadrés (2026-10-02, 14 saisons, log-loss de
 * la victoire −0,00096, z −3,6, meilleure sur 12 saisons sur 14 ; le Fenwick à
 * 5 c. 5 seul ne bat pas les tirs). MoneyPuck publie les deux dans un CSV de
 * saison mis à jour chaque nuit — la même source que l'entraînement du modèle.
 *
 * Données : MoneyPuck.com — à créditer partout où elles s'affichent.
 *
 * Deux fichiers, un appel chacun, mis en cache 3 h :
 *   • teams.csv   (~100 Ko) — une ligne par équipe et par situation ;
 *   • skaters.csv (~3,5 Mo) — CF%/FF% « sur la glace » de chaque patineur.
 *
 * Tout échec rend une table vide après coup (cache négatif de 5 min) : les
 * appelants retombent alors sur les tirs cadrés, comme avant.
 */

import { USE_MOCK, currentSeason, fetchText, getCached, setCached } from './core';

const MP_BASE = 'https://moneypuck.com/moneypuck/playerData/seasonSummary';
const TTL_OK_MS   = 3 * 60 * 60_000;
const TTL_PAST_MS = 24 * 60 * 60_000;   // saison terminée : le fichier ne bouge plus
const TTL_FAIL_MS = 5 * 60_000;
const ttlFor = (y: string) => (y < mpSeasonOf() ? TTL_PAST_MS : TTL_OK_MS);

/** Abréviations historiques de MoneyPuck → abréviations NHL de l'app. */
const MP_ABBR: Record<string, string> = {
  'T.B': 'TBL', 'N.J': 'NJD', 'S.J': 'SJS', 'L.A': 'LAK', ARI: 'UTA', PHX: 'UTA',
};
const normAbbr = (a: string) => {
  const up = (a ?? '').trim().toUpperCase();
  return MP_ABBR[up] ?? up;
};

/** « 20262027 » (NHL) → « 2026 » (MoneyPuck, année de début). */
export function mpSeasonOf(season: string = currentSeason()): string {
  return /^\d{8}$/.test(season) ? season.slice(0, 4) : season;
}

/**
 * Parseur CSV minimal (guillemets RFC 4180 compris). Les fichiers MoneyPuck
 * n'en contiennent pas aujourd'hui, mais un nom de joueur avec une virgule ne
 * doit pas décaler toutes les colonnes de la ligne.
 */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift() ?? [];
  return { header, rows };
}

/** Accès par NOM de colonne. `teams.csv` a deux colonnes « team » : la première gagne. */
function columns(header: string[]) {
  const idx = new Map<string, number>();
  header.forEach((h, i) => { if (!idx.has(h)) idx.set(h, i); });
  return {
    str: (r: string[], name: string) => r[idx.get(name) ?? -1] ?? '',
    num: (r: string[], name: string) => {
      const v = Number(r[idx.get(name) ?? -1]);
      return Number.isFinite(v) ? v : NaN;
    },
    has: (name: string) => idx.has(name),
  };
}

const pct1 = (f: number, a: number) => (f + a > 0 ? Math.round((f / (f + a)) * 1000) / 10 : null);
const per = (x: number, gp: number) => (gp > 0 && Number.isFinite(x) ? Math.round((x / gp) * 100) / 100 : null);

export interface MpTeamSeason {
  gamesPlayed: number;
  /** Toutes situations, par match. */
  fenwickForPg: number | null;
  fenwickAgainstPg: number | null;
  corsiForPg: number | null;
  corsiAgainstPg: number | null;
  /** Pourcentages 0–100, une décimale. 5 c. 5 = la référence analytique. */
  corsiPct5v5: number | null;
  fenwickPct5v5: number | null;
  corsiPct: number | null;
  fenwickPct: number | null;
}

/** Corsi/Fenwick de chaque équipe pour la saison (défaut : en cours). */
export async function fetchMoneyPuckTeams(season?: string): Promise<Record<string, MpTeamSeason>> {
  if (USE_MOCK) return {};
  const y = mpSeasonOf(season);
  const key = `mp_teams_${y}`;
  const hit = getCached<Record<string, MpTeamSeason>>(key);
  if (hit) return hit;

  let out: Record<string, MpTeamSeason> = {};
  try {
    const text = await fetchText(`${MP_BASE}/${y}/regular/teams.csv`, 'MoneyPuck teams.csv', 'moneypuck');
    out = parseTeamsCsv(text);
    setCached(key, out, Object.keys(out).length ? ttlFor(y) : TTL_FAIL_MS);
  } catch {
    setCached(key, out, TTL_FAIL_MS);
  }
  return out;
}

export function parseTeamsCsv(text: string): Record<string, MpTeamSeason> {
  const { header, rows } = parseCsv(text);
  const c = columns(header);
  const bySit: Record<string, Record<string, string[]>> = {};
  for (const r of rows) {
    const abbr = normAbbr(c.str(r, 'team'));
    const sit = c.str(r, 'situation');
    if (!abbr || !sit) continue;
    (bySit[abbr] ??= {})[sit] = r;
  }
  const out: Record<string, MpTeamSeason> = {};
  for (const [abbr, sits] of Object.entries(bySit)) {
    const all = sits.all;
    if (!all) continue;
    const gp = c.num(all, 'games_played');
    if (!(gp >= 1)) continue;
    const ev = sits['5on5'];
    out[abbr] = {
      gamesPlayed: gp,
      fenwickForPg:     per(c.num(all, 'unblockedShotAttemptsFor'), gp),
      fenwickAgainstPg: per(c.num(all, 'unblockedShotAttemptsAgainst'), gp),
      corsiForPg:       per(c.num(all, 'shotAttemptsFor'), gp),
      corsiAgainstPg:   per(c.num(all, 'shotAttemptsAgainst'), gp),
      corsiPct:   pct1(c.num(all, 'shotAttemptsFor'), c.num(all, 'shotAttemptsAgainst')),
      fenwickPct: pct1(c.num(all, 'unblockedShotAttemptsFor'), c.num(all, 'unblockedShotAttemptsAgainst')),
      corsiPct5v5:   ev ? pct1(c.num(ev, 'shotAttemptsFor'), c.num(ev, 'shotAttemptsAgainst')) : null,
      fenwickPct5v5: ev ? pct1(c.num(ev, 'unblockedShotAttemptsFor'), c.num(ev, 'unblockedShotAttemptsAgainst')) : null,
    };
  }
  return out;
}

export interface MpSkaterSeason {
  team: string;
  gamesPlayed: number;
  /** CF% / FF% de l'équipe quand il est sur la glace, à 5 c. 5 (0–100). */
  onIceCorsiPct: number | null;
  onIceFenwickPct: number | null;
}

/** CF%/FF% sur la glace (5 c. 5) de chaque patineur, par identifiant NHL. */
export async function fetchMoneyPuckSkaters(season?: string): Promise<Record<string, MpSkaterSeason>> {
  if (USE_MOCK) return {};
  const y = mpSeasonOf(season);
  const key = `mp_skaters_${y}`;
  const hit = getCached<Record<string, MpSkaterSeason>>(key);
  if (hit) return hit;

  let out: Record<string, MpSkaterSeason> = {};
  try {
    const text = await fetchText(`${MP_BASE}/${y}/regular/skaters.csv`, 'MoneyPuck skaters.csv', 'moneypuck');
    out = parseSkatersCsv(text);
    setCached(key, out, Object.keys(out).length ? ttlFor(y) : TTL_FAIL_MS);
  } catch {
    setCached(key, out, TTL_FAIL_MS);
  }
  return out;
}

export function parseSkatersCsv(text: string): Record<string, MpSkaterSeason> {
  const { header, rows } = parseCsv(text);
  const c = columns(header);
  const out: Record<string, MpSkaterSeason> = {};
  for (const r of rows) {
    if (c.str(r, 'situation') !== '5on5') continue;
    const id = c.str(r, 'playerId').trim();
    const gp = c.num(r, 'games_played');
    if (!id || !(gp >= 1)) continue;
    out[id] = {
      team: normAbbr(c.str(r, 'team')),
      gamesPlayed: gp,
      onIceCorsiPct:   pct1(c.num(r, 'OnIce_F_shotAttempts'), c.num(r, 'OnIce_A_shotAttempts')),
      onIceFenwickPct: pct1(c.num(r, 'OnIce_F_unblockedShotAttempts'), c.num(r, 'OnIce_A_unblockedShotAttempts')),
    };
  }
  return out;
}
