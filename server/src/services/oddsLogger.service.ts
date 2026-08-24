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
// SÉRIE TEMPORELLE (A3, 2026-08-23) : chaque passe archive en plus son état
// dans `odds_snapshots` (migration 031). `odds_log` écrase — il ne garde qu'une
// ouverture et une clôture — alors que le CLV a besoin de savoir quel prix était
// affiché à un instant donné. Le calendrier des passes vit dans `SLOTS`, en bas
// de ce fichier, avec le raisonnement sur le quota qui lui donne sa forme.
//
// Activé via ODDS_LOG_ENABLED=true.
// Sans clé The Odds API (ODDS_API_KEY) le job se désactive proprement.

import { pool } from '../db/connection';
import { fetchRawOdds, fetchSpreadsOnly, type RawOddsEvent } from './oddsClient';
import { logger } from '../logger';
import { withJobLock } from './jobLock';
import * as oddsQuota from './oddsQuota';

/** Un appel Odds API + un upsert. Généreux pour un upstream lent. */
const LOCK_TTL_MS = 5 * 60 * 1000;

/**
 * Coût d'une passe, en crédits The Odds API : 1 par marché et par région.
 *
 * `full` demande h2h + spreads + totals ; `spreads` ne demande que la puck
 * line. C'est ce qui rend le calendrier d'A3 finançable — voir `SLOTS`.
 */
const COLLECT_COST: Record<PassKind, number> = { full: 3, spreads: 1 };

/** Quels marchés une passe demande. Stocké tel quel dans `odds_snapshots`. */
export type PassKind = 'full' | 'spreads';

/** L'état `active` d'une ligue change au plus une fois par jour. */
let seasonCache: { active: boolean; at: number } | null = null;
const SEASON_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * La NHL est-elle en cours ? Consulté avant toute dépense.
 *
 * `/v4/sports` est explicitement **hors quota** côté fournisseur : ce contrôle
 * est donc gratuit, et il évite de payer quatre appels par jour pendant les
 * quatre mois d'intersaison. En cas d'échec réseau on répond `true` — mieux
 * vaut une passe inutile qu'une saison entière ratée sur une erreur transitoire.
 */
async function isSeasonActive(): Promise<boolean> {
  if (seasonCache && Date.now() - seasonCache.at < SEASON_TTL_MS) {
    return seasonCache.active;
  }
  try {
    const res = await fetch(
      `https://api.the-odds-api.com/v4/sports?apiKey=${process.env.ODDS_API_KEY}`,
    );
    if (!res.ok) return true;
    const sports = (await res.json()) as Array<{ key: string; active: boolean }>;
    const nhl = sports.find((s) => s.key === 'icehockey_nhl');
    const active = nhl?.active !== false;
    seasonCache = { active, at: Date.now() };
    return active;
  } catch {
    return true;
  }
}

// Colonnes attendues par fetch_data_v4.py (identiques à odds.csv).
// `source` permet de distinguer ces lignes de celles de l'archive SBRO : les
// deux sources n'ont ni le même bookmaker ni la même marge, et un ROI qui
// n'apparaîtrait que d'un côté de la jointure serait un artefact de source.
const HEADER =
  'date,home_team,away_team,home_ml_open,away_ml_open,home_ml_close,away_ml_close,' +
  'total_open,total_close,total_open_over,total_open_under,' +
  'total_close_over,total_close_under,puck_line_home,pl_home_price,pl_away_price,source';

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
  /**
   * Mise au jeu, telle que renvoyée par l'API. Indispensable au CLV : les
   * matchs d'une même soirée commencent entre 19 h et 22 h 30 ET, donc le
   * « T−3 h » et le « dernier prix avant le début » sont propres à chaque
   * match et ne se déduisent pas de `date`.
   */
  commenceTime: string;
  homeMl: number | null; awayMl: number | null; total: number | null;
  // Marchés dérivés (2026-08-04). Sans ces PRIX, aucun ROI n'est calculable
  // sur les totaux ni la puck line — c'est-à-dire précisément les marchés que
  // le modèle de score price le mieux et les seuls encore ouverts.
  totalOver: number | null; totalUnder: number | null;
  puckLineHome: number | null;
  plHomePrice: number | null; plAwayPrice: number | null;
}

/** Convertit un événement en ligne loggable (cotes de clôture). */
function eventToRow(ev: RawOddsEvent): Row | null {
  const home = toAbbr(ev.home_team);
  const away = toAbbr(ev.away_team);
  if (!home || !away) return null;

  let homeMl: number | null = null, awayMl: number | null = null, total: number | null = null;
  let totalOver: number | null = null, totalUnder: number | null = null;
  let puckLineHome: number | null = null;
  let plHomePrice: number | null = null, plAwayPrice: number | null = null;

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
    const over  = totals.outcomes.find((o) => /over/i.test(o.name));
    const under = totals.outcomes.find((o) => /under/i.test(o.name));
    total = typeof over?.point === 'number' ? over!.point : null;
    totalOver  = over?.price  ?? null;
    totalUnder = under?.price ?? null;
  }

  // Puck line : `point` du côté domicile est SON handicap (−1.5 s'il est
  // favori, +1.5 sinon). On ne retient que la ligne standard : les lignes
  // alternatives (±2.5) sont un autre marché et les mélanger dans la même
  // colonne rendrait le règlement ambigu au moment du backtest.
  const spBook = pickBook(ev, 'spreads');
  const spreads = spBook?.markets.find((m) => m.key === 'spreads');
  if (spreads) {
    const oh = spreads.outcomes.find((o) => o.name.toLowerCase() === ev.home_team.toLowerCase());
    const oa = spreads.outcomes.find((o) => o.name.toLowerCase() === ev.away_team.toLowerCase());
    if (typeof oh?.point === 'number' && Math.abs(Math.abs(oh.point) - 1.5) < 1e-9) {
      puckLineHome = oh.point;
      plHomePrice  = oh.price ?? null;
      plAwayPrice  = oa?.price ?? null;
    }
  }

  // Une passe `spreads` ne ramène ni moneyline ni total : refuser la ligne sur
  // l'absence des deux jetterait exactement ce qu'on est venu chercher.
  if (homeMl == null && total == null && puckLineHome == null) return null;
  return {
    date: easternDate(ev.commence_time), home, away,
    commenceTime: ev.commence_time,
    homeMl, awayMl, total,
    totalOver, totalUnder, puckLineHome, plHomePrice, plAwayPrice,
  };
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
 * SNAPSHOTS (A3, 2026-08-23) — en plus de l'upsert ci-dessus, chaque passe
 * insère son état complet dans `odds_snapshots`. Le résumé ouverture/clôture
 * reste le contrat de `fetch_data_v4.py` et ne bouge pas ; la série temporelle
 * est ce que le CLV réclame, et elle ne coûte aucun crédit supplémentaire —
 * l'appel ramenait déjà ces prix, le collecteur les jetait.
 *
 * @param kind `full` (h2h + spreads + totals, 3 crédits) ou `spreads` (puck
 *             line seule, 1 crédit). Voir `SLOTS` pour le calendrier.
 * @returns nombre de lignes écrites ou mises à jour dans `odds_log`.
 */
export async function logTodaysOdds(kind: PassKind = 'full'): Promise<number> {
  // ── Deux garde-fous AVANT de dépenser le moindre crédit ───────────────────
  //
  // 1. La saison est-elle en cours ? L'endpoint /v4/sports est gratuit (il ne
  //    décompte aucun crédit) et porte un booléen `active` par ligue. Sans ce
  //    contrôle, l'intersaison — de juin à début octobre — brûle ~4 appels par
  //    jour pour ramener une liste vide, soit plus de 1 000 crédits sur un
  //    quota mensuel de 500. C'est l'économie la plus facile du lot.
  if (!(await isSeasonActive())) {
    logger.info('[OddsLogger] NHL inactive — aucun crédit dépensé.');
    return 0;
  }

  // 2. Reste-t-il assez de crédits SANS entamer la réserve des visiteurs ?
  //    Le collecteur cède toujours : une journée de collecte manquée est une
  //    perte pour le futur modèle, une page vide est une perte immédiate pour
  //    quelqu'un qui est là maintenant.
  if (!(await oddsQuota.collectorMaySpend(COLLECT_COST[kind]))) {
    logger.warn({ remaining: oddsQuota.remaining(), kind },
      '[OddsLogger] réserve visiteurs atteinte — collecte suspendue ce cycle.');
    return 0;
  }

  const events = kind === 'spreads' ? await fetchSpreadsOnly() : await fetchRawOdds();
  if (!events.length) return 0;

  // Un seul horodatage pour toute la passe, calculé ici et non par `NOW()`
  // ligne à ligne : c'est ce qui rend « l'état du marché à 18 h 45 »
  // regroupable, au lieu d'horodatages qui diffèrent de quelques millisecondes.
  const observedAt = new Date();

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
  // Les colonnes d'OUVERTURE reçoivent la même valeur à l'insertion et ne sont
  // jamais réécrites ; seules les colonnes de CLÔTURE sont mises à jour aux
  // passes suivantes. L'écart entre les deux EST le mouvement de cote, et
  // c'est lui qu'on cherche à capturer — pas seulement le prix final.
  const res = await pool.query(
    `INSERT INTO odds_log (game_date, home_team, away_team,
                           home_ml_open, away_ml_open, home_ml_close, away_ml_close,
                           total_open, total_close,
                           total_open_over, total_open_under,
                           total_close_over, total_close_under,
                           puck_line_home,
                           pl_home_price_open, pl_away_price_open,
                           pl_home_price, pl_away_price)
     SELECT * FROM unnest(
       $1::date[], $2::text[], $3::text[],
       $4::numeric[], $5::numeric[], $4::numeric[], $5::numeric[],
       $6::numeric[], $6::numeric[],
       $7::numeric[], $8::numeric[],
       $7::numeric[], $8::numeric[],
       $9::numeric[],
       $10::numeric[], $11::numeric[],
       $10::numeric[], $11::numeric[]
     )
     ON CONFLICT (game_date, home_team, away_team) DO UPDATE SET
       -- L'ouverture ne se réécrit JAMAIS quand elle existe (l'argument de
       -- gauche gagne) — mais elle se remplit si elle était nulle. Deux cas
       -- réels le demandent : un book qui n'a pas encore affiché un marché lors
       -- de la première passe, et une journée dont la première passe est une
       -- passe 'spreads' (démarrage du serveur en soirée), qui ne rapporte ni
       -- moneyline ni total. Sans ce rattrapage, ces colonnes restaient nulles
       -- pour toujours, puisque seules les colonnes de clôture étaient mises à
       -- jour.
       home_ml_open      = COALESCE(odds_log.home_ml_open,      EXCLUDED.home_ml_open),
       away_ml_open      = COALESCE(odds_log.away_ml_open,      EXCLUDED.away_ml_open),
       total_open        = COALESCE(odds_log.total_open,        EXCLUDED.total_open),
       total_open_over   = COALESCE(odds_log.total_open_over,   EXCLUDED.total_open_over),
       total_open_under  = COALESCE(odds_log.total_open_under,  EXCLUDED.total_open_under),
       pl_home_price_open = COALESCE(odds_log.pl_home_price_open, EXCLUDED.pl_home_price_open),
       pl_away_price_open = COALESCE(odds_log.pl_away_price_open, EXCLUDED.pl_away_price_open),
       home_ml_close     = COALESCE(EXCLUDED.home_ml_close,     odds_log.home_ml_close),
       away_ml_close     = COALESCE(EXCLUDED.away_ml_close,     odds_log.away_ml_close),
       total_close       = COALESCE(EXCLUDED.total_close,       odds_log.total_close),
       total_close_over  = COALESCE(EXCLUDED.total_close_over,  odds_log.total_close_over),
       total_close_under = COALESCE(EXCLUDED.total_close_under, odds_log.total_close_under),
       -- La ligne de puck line peut bouger (le favori change de camp) : on
       -- suit la dernière observée, comme pour la ligne de total.
       puck_line_home    = COALESCE(EXCLUDED.puck_line_home,    odds_log.puck_line_home),
       pl_home_price     = COALESCE(EXCLUDED.pl_home_price,     odds_log.pl_home_price),
       pl_away_price     = COALESCE(EXCLUDED.pl_away_price,     odds_log.pl_away_price),
       updated_at        = NOW()`,
    [
      rows.map((r) => r.date),
      rows.map((r) => r.home),
      rows.map((r) => r.away),
      rows.map((r) => r.homeMl),
      rows.map((r) => r.awayMl),
      rows.map((r) => r.total),
      rows.map((r) => r.totalOver),
      rows.map((r) => r.totalUnder),
      rows.map((r) => r.puckLineHome),
      rows.map((r) => r.plHomePrice),
      rows.map((r) => r.plAwayPrice),
    ],
  );

  await insertSnapshots(rows, observedAt, kind);
  return res.rowCount ?? 0;
}

/**
 * Archive l'état du marché à un instant donné (A3).
 *
 * Complémentaire de `odds_log`, qui écrase : ici rien n'est jamais réécrit, on
 * empile. C'est la seule forme qui permette de répondre à « quel prix était
 * affiché quand le modèle aurait misé, et où la ligne a-t-elle fini ? ».
 *
 * `ON CONFLICT DO NOTHING` plutôt qu'un upsert : deux exécutions concurrentes
 * du même créneau — que `withJobLock` empêche déjà — ne doivent pas se
 * réécrire l'une l'autre. Un snapshot est un fait observé, pas un état courant.
 *
 * Un échec ici ne fait pas échouer la passe : `odds_log` est déjà écrit, et
 * c'est lui qui alimente le pipeline ML existant. Perdre un point de série
 * temporelle est regrettable, perdre la clôture du jour l'est bien davantage.
 */
async function insertSnapshots(
  rows: Row[], observedAt: Date, kind: PassKind,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO odds_snapshots (game_date, home_team, away_team,
                                   observed_at, commence_time, markets,
                                   home_ml, away_ml, total,
                                   total_over, total_under,
                                   puck_line_home, pl_home_price, pl_away_price)
       SELECT * FROM unnest(
         $1::date[], $2::text[], $3::text[],
         $4::timestamptz[], $5::timestamptz[], $6::text[],
         $7::numeric[], $8::numeric[], $9::numeric[],
         $10::numeric[], $11::numeric[],
         $12::numeric[], $13::numeric[], $14::numeric[]
       )
       ON CONFLICT (game_date, home_team, away_team, observed_at) DO NOTHING`,
      [
        rows.map((r) => r.date),
        rows.map((r) => r.home),
        rows.map((r) => r.away),
        rows.map(() => observedAt),
        rows.map((r) => r.commenceTime),
        rows.map(() => kind),
        rows.map((r) => r.homeMl),
        rows.map((r) => r.awayMl),
        rows.map((r) => r.total),
        rows.map((r) => r.totalOver),
        rows.map((r) => r.totalUnder),
        rows.map((r) => r.puckLineHome),
        rows.map((r) => r.plHomePrice),
        rows.map((r) => r.plAwayPrice),
      ],
    );
  } catch (err: any) {
    logger.warn({ err: err?.message, kind },
      '[OddsLogger] snapshot non archivé — odds_log reste à jour');
  }
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
            total_open, total_close,
            total_open_over, total_open_under,
            total_close_over, total_close_under,
            puck_line_home, pl_home_price, pl_away_price
       FROM odds_log
      ORDER BY game_date ASC, home_team ASC`,
  );
  const num = (v: unknown) => (v == null ? '' : Number(v).toFixed(4));
  const lines = rows.map((r: any) => [
    r.date, r.home_team, r.away_team,
    num(r.home_ml_open), num(r.away_ml_open), num(r.home_ml_close), num(r.away_ml_close),
    num(r.total_open), num(r.total_close),
    num(r.total_open_over), num(r.total_open_under),
    num(r.total_close_over), num(r.total_close_under),
    num(r.puck_line_home), num(r.pl_home_price), num(r.pl_away_price),
    'oddsapi:live',
  ].join(','));
  return [HEADER, ...lines].join('\n') + '\n';
}

// ── Calendrier de collecte ───────────────────────────────────────────────────
//
// CE QUI A CHANGÉ ET POURQUOI (A3, 2026-08-23). L'ancienne version faisait
// `setInterval(6 h)` amorcé au démarrage du processus : la phase dépendait donc
// de l'heure du dernier déploiement Railway. Rien ne garantissait qu'une passe
// tombe près d'une mise au jeu, et le dernier prix observé avant un match de
// 19 h ET pouvait dater de six heures. Or le CLV se mesure CONTRE la clôture :
// une « clôture » à T−5 h n'en est pas une, et toute la mesure s'en trouvait
// faussée dans le sens optimiste (une ligne qui a moins bougé paraît plus
// souvent du bon côté).
//
// LE BUDGET COMMANDE LA FORME. Quota gratuit 500 crédits/mois, dont 150
// réservés aux visiteurs (`ODDS_USER_RESERVE`) : il reste 350 pour la collecte.
// Quatre passes complètes par jour en coûtaient 12, soit 360 — au-dessus du
// budget, la collecte s'arrêtait donc vers la fin de chaque mois de saison.
//
// Ici : deux passes complètes + quatre passes `spreads` = **10 crédits/jour,
// 300/mois**, sous le budget pour la première fois, avec deux fois plus
// d'observations. C'est possible parce que The Odds API facture au marché et
// que la puck line est le seul marché encore vivant (A2 : le moneyline est
// clos, les totaux sont condamnés à −2.75 % de ROI).
//
// CE QU'ON PERD, ASSUMÉ : le moneyline et les totaux n'ont plus de clôture
// stricte, leur dernier prix est celui de 17 h. Ils gardent leur ouverture, ce
// qui suffit à mesurer le mouvement — et aucune stratégie vivante ne les price.
//
// LES HEURES. 11 h ET : les lignes du soir sont affichées, c'est l'ouverture
// utile. 17 h ET : dernière passe complète avant les matchs. 18 h 45 / 19 h 45 :
// juste avant les créneaux de 19 h et 20 h, qui portent la majorité du
// calendrier. 21 h 45 / 22 h 45 : les matchs de la côte Ouest.
const SLOTS: Array<{ hour: number; minute: number; kind: PassKind }> = [
  { hour: 11, minute: 0,  kind: 'full'    },
  { hour: 17, minute: 0,  kind: 'full'    },
  { hour: 18, minute: 45, kind: 'spreads' },
  { hour: 19, minute: 45, kind: 'spreads' },
  { hour: 21, minute: 45, kind: 'spreads' },
  { hour: 22, minute: 45, kind: 'spreads' },
];

const ET = 'America/New_York';

/** Minutes écoulées depuis minuit, heure murale de l'Est. */
function easternMinutesNow(now: Date): number {
  const [h, m] = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET, hour12: false, hour: '2-digit', minute: '2-digit',
  }).format(now).split(':').map(Number);
  // `en-CA` rend minuit « 24:00 » plutôt que « 00:00 ».
  return (h % 24) * 60 + m;
}

/**
 * Prochain créneau et délai jusqu'à lui.
 *
 * Le calcul se fait en minutes d'horloge murale de l'Est, puis le délai est
 * appliqué comme une durée réelle. Aux deux bascules d'heure d'été de l'année,
 * l'écart entre les deux vaut une heure : un créneau tombe alors une heure trop
 * tôt ou trop tard, une fois. Le calendrier se recale au créneau suivant, et
 * une observation légèrement décalée deux fois par an ne change rien à une
 * mesure de CLV. La solution exacte demanderait une dépendance de cron, ce que
 * ce dépôt n'a pour aucun de ses autres jobs planifiés.
 */
function nextSlot(now: Date): { delayMs: number; kind: PassKind } {
  const cur = easternMinutesNow(now);
  const mins = SLOTS.map((s) => ({ at: s.hour * 60 + s.minute, kind: s.kind }));
  const next = mins.find((s) => s.at > cur) ?? { ...mins[0], at: mins[0].at + 1440 };
  return { delayMs: (next.at - cur) * 60_000, kind: next.kind };
}

let timer: NodeJS.Timeout | null = null;

/**
 * Lance la collecte quotidienne des cotes (idempotente, verrouillée).
 *
 * Chaque créneau se replanifie après son exécution plutôt que de tourner sur
 * un intervalle fixe : c'est ce qui permet d'espacer inégalement les passes
 * (une le matin, quatre serrées le soir) et de rester calé sur l'heure de
 * l'Est, à laquelle le calendrier NHL est écrit.
 */
export function startOddsLogger(): void {
  if (process.env.ODDS_LOG_ENABLED !== 'true') return;
  if (!process.env.ODDS_API_KEY) {
    logger.warn('[OddsLogger] ODDS_API_KEY absent — logging désactivé.');
    return;
  }

  // Sans verrou, N instances consomment N× le quota The Odds API pour produire
  // exactement les mêmes lignes — c'est le job dont la duplication coûte
  // directement de l'argent.
  const run = async (kind: PassKind) => {
    try {
      await withJobLock('odds-logger', LOCK_TTL_MS, () => logTodaysOdds(kind));
    } catch (err: any) {
      logger.warn({ err: err?.message, kind }, '[OddsLogger] échec');
    }
  };

  const schedule = () => {
    const { delayMs, kind } = nextSlot(new Date());
    timer = setTimeout(() => {
      // On replanifie AVANT d'attendre la passe : une collecte lente ou en
      // échec ne doit pas décaler ni interrompre le calendrier.
      schedule();
      void run(kind);
    }, delayMs);
    timer.unref?.();
  };

  logger.info({ slots: SLOTS.length, creditsPerDay: SLOTS.reduce(
    (n, s) => n + COLLECT_COST[s.kind], 0) }, '[OddsLogger] calendrier armé');
  schedule();

  // Vérification de mise en service, explicitement opt-in.
  //
  // L'ancienne version lançait une passe 20 s après chaque démarrage. Railway
  // redéploie souvent : c'étaient 3 crédits offerts à chaque déploiement, pour
  // une donnée que le créneau suivant aurait ramenée de toute façon. Le
  // calendrier ne fait donc plus rien au boot — mais il faut bien pouvoir
  // constater UNE fois que la chaîne complète fonctionne, sans attendre 11 h ET.
  // D'où cette variable, à poser le temps d'un déploiement puis à retirer.
  if (process.env.ODDS_LOG_RUN_AT_BOOT === 'true') {
    logger.warn('[OddsLogger] ODDS_LOG_RUN_AT_BOOT — passe de vérification, '
      + 'à retirer après contrôle (3 crédits par démarrage).');
    setTimeout(() => void run('full'), 20_000).unref?.();
  }
}

/**
 * Arrête la boucle de collecte.
 *
 * **Aucun appelant aujourd'hui — gardée exprès** (décision du 2026-08-10). Sans
 * elle, un test qui démarre le collecteur laisse un `setTimeout` en vie et le
 * runner ne rend jamais la main. À brancher aussi dans l'arrêt gracieux le jour
 * où la collecte devient longue.
 */
export function stopOddsLogger(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
