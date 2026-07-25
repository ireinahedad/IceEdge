// ============================================================
//  Odds logger — journalise les cotes NHL du jour pour le ML
// ============================================================
// The Odds API n'archive pas l'historique gratuitement (les cotes publiques
// s'arrêtent en 2022-23). Pour pouvoir réentraîner et backtester le modèle sur
// les saisons récentes, on capture chaque jour les cotes de clôture NHL et on
// les ajoute à ml/data/odds_live_log.csv — le format exact que fetch_data_v4.py
// fusionne dans le dataset d'entraînement.
//
// Activé via ODDS_LOG_ENABLED=true. Chemin surchargeable via ODDS_LOG_PATH.
// Sans clé The Odds API (ODDS_API_KEY) le job se désactive proprement.

import fs from 'fs';
import path from 'path';
import { fetchRawOdds, type RawOddsEvent } from './oddsClient';
import { logger } from '../logger';

// Colonnes attendues par fetch_data_v4.py (identiques à odds.csv).
const HEADER =
  'date,home_team,away_team,home_ml_open,away_ml_open,home_ml_close,away_ml_close,total_open,total_close';

// The Odds API renvoie les noms complets → abréviations NHL (= celles du spine).
const NAME_TO_ABBR: Record<string, string> = {
  'anaheim ducks': 'ANA', 'arizona coyotes': 'UTA', 'utah hockey club': 'UTA',
  'utah mammoth': 'UTA', 'boston bruins': 'BOS', 'buffalo sabres': 'BUF',
  'calgary flames': 'CGY', 'carolina hurricanes': 'CAR', 'chicago blackhawks': 'CHI',
  'colorado avalanche': 'COL', 'columbus blue jackets': 'CBJ', 'dallas stars': 'DAL',
  'detroit red wings': 'DET', 'edmonton oilers': 'EDM', 'florida panthers': 'FLA',
  'los angeles kings': 'LAK', 'minnesota wild': 'MIN', 'montreal canadiens': 'MTL',
  'montréal canadiens': 'MTL', 'nashville predators': 'NSH', 'new jersey devils': 'NJD',
  'new york islanders': 'NYI', 'new york rangers': 'NYR', 'ottawa senators': 'OTT',
  'philadelphia flyers': 'PHI', 'pittsburgh penguins': 'PIT', 'san jose sharks': 'SJS',
  'seattle kraken': 'SEA', 'st louis blues': 'STL', 'st. louis blues': 'STL',
  'tampa bay lightning': 'TBL', 'toronto maple leafs': 'TOR', 'vancouver canucks': 'VAN',
  'vegas golden knights': 'VGK', 'washington capitals': 'WSH', 'winnipeg jets': 'WPG',
};

function toAbbr(name: string): string | null {
  return NAME_TO_ABBR[(name || '').toLowerCase().trim()] ?? null;
}

/** Date locale (Est) du match au format YYYY-MM-DD — cohérent avec le spine NHL. */
function easternDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function pickBook(ev: RawOddsEvent, market: string) {
  const withMkt = ev.bookmakers.filter((b) => b.markets.some((m) => m.key === market));
  if (!withMkt.length) return null;
  return withMkt.find((b) => b.key === 'bet365') ?? withMkt[0];
}

interface Row {
  date: string; home: string; away: string;
  homeMl: number | null; awayMl: number | null; total: number | null;
}

/** Convertit un événement en ligne loggable (cotes de clôture). */
function eventToRow(ev: RawOddsEvent): Row | null {
  const home = toAbbr(ev.home_team);
  const away = toAbbr(ev.away_team);
  if (!home || !away) return null;

  let homeMl: number | null = null, awayMl: number | null = null, total: number | null = null;

  const h2hBook = pickBook(ev, 'h2h');
  const h2h = h2hBook?.markets.find((m) => m.key === 'h2h');
  if (h2h) {
    const oh = h2h.outcomes.find((o) => o.name.toLowerCase() === ev.home_team.toLowerCase());
    const oa = h2h.outcomes.find((o) => o.name.toLowerCase() === ev.away_team.toLowerCase());
    homeMl = oh?.price ?? null;
    awayMl = oa?.price ?? null;
  }

  const totBook = pickBook(ev, 'totals');
  const totals = totBook?.markets.find((m) => m.key === 'totals');
  if (totals) {
    const over = totals.outcomes.find((o) => /over/i.test(o.name));
    total = typeof over?.point === 'number' ? over!.point : null;
  }

  if (homeMl == null && total == null) return null;
  return { date: easternDate(ev.commence_time), home, away, homeMl, awayMl, total };
}

function csvPath(): string {
  if (process.env.ODDS_LOG_PATH) return process.env.ODDS_LOG_PATH;
  // Par défaut : <repo>/ml/data/odds_live_log.csv (serveur lancé depuis server/)
  return path.resolve(process.cwd(), '..', 'ml', 'data', 'odds_live_log.csv');
}

/** Clés (date+home+away) déjà présentes, pour ne rien dupliquer. */
function existingKeys(file: string): Set<string> {
  const keys = new Set<string>();
  if (!fs.existsSync(file)) return keys;
  const lines = fs.readFileSync(file, 'utf8').split('\n').slice(1);
  for (const l of lines) {
    const [date, home, away] = l.split(',');
    if (date && home && away) keys.add(`${date}|${home}|${away}`);
  }
  return keys;
}

/** Capture les cotes du jour et les ajoute au CSV (idempotent par jour). */
export async function logTodaysOdds(): Promise<number> {
  const events = await fetchRawOdds();
  if (!events.length) return 0;

  const file = csvPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, HEADER + '\n');

  const seen = existingKeys(file);
  const num = (v: number | null) => (v == null ? '' : v.toFixed(4));
  const newLines: string[] = [];

  for (const ev of events) {
    const r = eventToRow(ev);
    if (!r) continue;
    const key = `${r.date}|${r.home}|${r.away}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // open = close (un seul snapshot par jour) → remplit les deux colonnes
    newLines.push([
      r.date, r.home, r.away,
      num(r.homeMl), num(r.awayMl), num(r.homeMl), num(r.awayMl),
      num(r.total), num(r.total),
    ].join(','));
  }

  if (newLines.length) fs.appendFileSync(file, newLines.join('\n') + '\n');
  return newLines.length;
}

let timer: NodeJS.Timeout | null = null;

/** Lance le logging quotidien des cotes (idempotent, dédup par jour). */
export function startOddsLogger(): void {
  if (process.env.ODDS_LOG_ENABLED !== 'true') return;
  if (!process.env.ODDS_API_KEY) {
    logger.warn('[OddsLogger] ODDS_API_KEY absent — logging désactivé.');
    return;
  }

  const run = async () => {
    try {
      await logTodaysOdds();
    } catch (err: any) {
      logger.warn({ err: err?.message }, '[OddsLogger] échec');
    }
  };
  // Plusieurs passes/jour pour attraper les matchs affichés tard + cotes de clôture
  timer = setInterval(run, 6 * 60 * 60 * 1000);
  setTimeout(run, 20_000);
}

export function stopOddsLogger(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
