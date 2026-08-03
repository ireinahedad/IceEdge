// ============================================================
//  Odds logger — journalise les cotes NHL du jour pour le ML
// ============================================================
// The Odds API n'archive pas l'historique gratuitement (les cotes publiques
// s'arrêtent en 2022-23). Pour pouvoir réentraîner et backtester le modèle sur
// les saisons récentes, on capture chaque jour les cotes de clôture NHL.
//
// STOCKAGE : table `odds_log` (migration 027), et non plus un CSV. Le disque de
// Railway est éphémère : le fichier disparaissait à chaque déploiement, donc le
// job donnait l'illusion de collecter sans jamais rien accumuler. L'export vers
// le format attendu par fetch_data_v4.py se fait à la demande
// (`npm run odds:export`), depuis une donnée qui, elle, survit.
//
// Activé via ODDS_LOG_ENABLED=true.
// Sans clé The Odds API (ODDS_API_KEY) le job se désactive proprement.

import { pool } from '../db/connection';
import { fetchRawOdds, type RawOddsEvent } from './oddsClient';
import { logger } from '../logger';
import { withJobLock } from './jobLock';

/** Un appel Odds API + un upsert. Généreux pour un upstream lent. */
const LOCK_TTL_MS = 5 * 60 * 1000;

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

/**
 * Capture les cotes du jour dans `odds_log`.
 *
 * IDEMPOTENCE — la clé primaire (game_date, home_team, away_team) la porte : le
 * job peut tourner autant de fois qu'on veut, y compris depuis deux instances,
 * sans créer de doublon. C'est ce qui remplace la relecture intégrale du CSV à
 * chaque exécution, dont le coût croissait avec la saison.
 *
 * OUVERTURE / CLÔTURE — la première passe d'une journée écrit les deux ; les
 * suivantes ne mettent à jour que la clôture. Le mouvement de cote entre la
 * première observation et la dernière est le signal que le CSV ne pouvait pas
 * capturer (il écrivait open = close et n'y revenait jamais).
 *
 * @returns nombre de lignes écrites ou mises à jour.
 */
export async function logTodaysOdds(): Promise<number> {
  const events = await fetchRawOdds();
  if (!events.length) return 0;

  const rows: Row[] = [];
  const seen = new Set<string>();
  for (const ev of events) {
    const r = eventToRow(ev);
    if (!r) continue;
    // The Odds API peut renvoyer deux entrées pour le même match (marchés
    // séparés) : on garde la première, la clé primaire ferait le reste mais
    // autant ne pas envoyer deux fois la même ligne.
    const key = `${r.date}|${r.home}|${r.away}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(r);
  }
  if (!rows.length) return 0;

  // Un seul aller-retour pour toute la journée : `unnest` déplie les tableaux
  // en lignes côté Postgres. Une boucle d'INSERT aurait fait ~15 requêtes pour
  // une donnée qui tient dans une.
  const res = await pool.query(
    `INSERT INTO odds_log (game_date, home_team, away_team,
                           home_ml_open, away_ml_open, home_ml_close, away_ml_close,
                           total_open, total_close)
     SELECT * FROM unnest(
       $1::date[], $2::text[], $3::text[],
       $4::numeric[], $5::numeric[], $4::numeric[], $5::numeric[],
       $6::numeric[], $6::numeric[]
     )
     ON CONFLICT (game_date, home_team, away_team) DO UPDATE SET
       home_ml_close = COALESCE(EXCLUDED.home_ml_close, odds_log.home_ml_close),
       away_ml_close = COALESCE(EXCLUDED.away_ml_close, odds_log.away_ml_close),
       total_close   = COALESCE(EXCLUDED.total_close,   odds_log.total_close),
       updated_at    = NOW()`,
    [
      rows.map((r) => r.date),
      rows.map((r) => r.home),
      rows.map((r) => r.away),
      rows.map((r) => r.homeMl),
      rows.map((r) => r.awayMl),
      rows.map((r) => r.total),
    ],
  );
  return res.rowCount ?? 0;
}

/**
 * Rend le journal au format CSV attendu par `fetch_data_v4.py`.
 *
 * Le format de sortie est inchangé — c'est le stockage qui a bougé, pas le
 * contrat avec le pipeline ML. Utilisé par `npm run odds:export`.
 */
export async function exportOddsLogCsv(): Promise<string> {
  const { rows } = await pool.query(
    `SELECT to_char(game_date, 'YYYY-MM-DD') AS date, home_team, away_team,
            home_ml_open, away_ml_open, home_ml_close, away_ml_close,
            total_open, total_close
       FROM odds_log
      ORDER BY game_date ASC, home_team ASC`,
  );
  const num = (v: unknown) => (v == null ? '' : Number(v).toFixed(4));
  const lines = rows.map((r: any) => [
    r.date, r.home_team, r.away_team,
    num(r.home_ml_open), num(r.away_ml_open), num(r.home_ml_close), num(r.away_ml_close),
    num(r.total_open), num(r.total_close),
  ].join(','));
  return [HEADER, ...lines].join('\n') + '\n';
}

let timer: NodeJS.Timeout | null = null;

/** Lance le logging quotidien des cotes (idempotent, dédup par jour). */
export function startOddsLogger(): void {
  if (process.env.ODDS_LOG_ENABLED !== 'true') return;
  if (!process.env.ODDS_API_KEY) {
    logger.warn('[OddsLogger] ODDS_API_KEY absent — logging désactivé.');
    return;
  }

  // Sans verrou, N instances consomment N× le quota The Odds API pour produire
  // exactement les mêmes lignes — c'est le job dont la duplication coûte
  // directement de l'argent.
  const run = async () => {
    try {
      await withJobLock('odds-logger', LOCK_TTL_MS, logTodaysOdds);
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
