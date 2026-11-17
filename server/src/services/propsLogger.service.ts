// ============================================================
//  Props logger — journalise les cotes de props JOUEUR pour le ML
// ============================================================
// POURQUOI (2026-11-16). Le modèle joueur (section 5 du document technique)
// prédit neuf statistiques et sert des marchés plus / moins, mais il n'a aucune
// référence de marché : le jeu de données ne contient que des cotes de match.
// Il n'est donc jugé que contre une règle simple, là où le modèle de match se
// mesure contre la cote de clôture. The Odds API ne vend pas d'historique de
// props pour la LNH ; la seule façon d'en avoir est d'en capturer à partir de
// maintenant, et chaque semaine non collectée est perdue définitivement.
//
// CE QUI DIFFÈRE DU COLLECTEUR DE COTES DE MATCH (`oddsLogger.service.ts`) :
// les props ne sortent pas de l'endpoint par ligue mais de l'endpoint PAR
// ÉVÉNEMENT, un appel par match. Le coût suit donc le nombre de matchs du soir,
// et non plus un forfait par passe. D'où trois garde-fous empilés :
//
//   1. la liste des événements (`/v4/sports/{sport}/events`) est GRATUITE
//      côté fournisseur : on sait combien de matchs il y a avant de dépenser ;
//   2. un plafond quotidien propre (`ODDS_PROPS_DAILY_BUDGET`), parce qu'un
//      soir à 15 matchs coûte deux fois un soir à 7 ;
//   3. la réserve visiteur d'`oddsQuota`, qui reste prioritaire : la collecte
//      cède toujours le pas au proxy public.
//
// QUAND LE BUDGET NE COUVRE PAS TOUS LES MATCHS, l'ordre de passage TOURNE avec
// la date (`rotate`). Sans cela, la troncature tomberait toujours sur les mêmes
// matchs — ceux dont la mise au jeu est la plus tardive — et l'échantillon
// serait biaisé par construction, ce qui est plus coûteux qu'une couverture
// partielle mais uniforme.
//
// Activé via ODDS_PROPS_ENABLED=true. Sans ODDS_API_KEY, le job se désactive
// proprement, comme le collecteur de cotes de match.

import { pool } from '../db/connection';
import { collectorBookParam } from './oddsClient';
import { toAbbr } from './oddsTeamNames';
import { logger } from '../logger';
import { recordUpstream } from '../metrics';
import { withJobLock } from './jobLock';
import * as oddsQuota from './oddsQuota';

const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const SPORT_KEY = 'icehockey_nhl';
const FETCH_TIMEOUT_MS = Number(process.env.ODDS_FETCH_TIMEOUT_MS) || 8_000;
const LOCK_TTL_MS = 10 * 60 * 1000;

function readPositive(name: string, dflt: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/**
 * Marchés demandés, dans l'ordre de priorité du modèle joueur.
 *
 * L'endpoint facture les marchés RENVOYÉS × les régions : quatre marchés chez
 * un livre valent quatre crédits par match, et un marché que le livre ne cote
 * pas ne coûte rien. Le défaut couvre les quatre statistiques que le modèle
 * sert et que les livres américains cotent le plus largement.
 *
 * `player_assists`, `player_blocked_shots`, `player_power_play_points`,
 * `player_goal_scorer_anytime` et `player_goal_scorer_first` existent aussi
 * (clés vérifiées dans la documentation du fournisseur le 2026-11-16) et le
 * modèle les sert : les ajouter à `ODDS_PROPS_MARKETS` augmente le coût d'un
 * crédit par marché ET PAR MATCH. À 7 matchs et 2 passes, chaque marché ajouté
 * coûte ~14 crédits/jour, soit ~420/mois.
 *
 * Les mises en échec et les minutes de pénalité, que le modèle sert aussi, ne
 * sont pas proposées par The Odds API pour la LNH : elles resteront sans
 * référence de marché.
 */
const PROPS_MARKETS: string[] = ((process.env.ODDS_PROPS_MARKETS ?? '').trim()
  || 'player_points,player_shots_on_goal,player_goals,player_total_saves')
  .split(',').map((m) => m.trim()).filter(Boolean);

/**
 * Plafond quotidien, en crédits. Défaut 60 : de quoi couvrir un soir ordinaire
 * (7 matchs × 4 marchés = 28 crédits) en deux passes, ouverture et clôture.
 * Un soir à 15 matchs dépasse ce plafond — la rotation décide alors quels
 * matchs sont servis, et le compte des sautés part dans les logs.
 */
const PROPS_DAILY_BUDGET = readPositive('ODDS_PROPS_DAILY_BUDGET', 60);

/**
 * Horizon : les matchs de LA soirée en cours, et eux seuls.
 *
 * On ne price pas un match déjà commencé (`t > now`), mais le plafond haut
 * compte autant. Les matchs de la LNH commencent entre 00 h et 03 h 30 UTC,
 * soit 8 à 12 h après la passe d'ouverture de 15 h 25 UTC. À 36 h, cette passe
 * ramassait AUSSI la soirée du lendemain (32 à 36 h), avec deux conséquences :
 * le budget partait sur des matchs qui seraient de toute façon pricés le
 * lendemain, et la rotation pouvait faire sauter des matchs de ce soir au
 * profit de ceux de demain — or une paire ouverture/clôture n'a de sens que si
 * les deux passes décrivent la même soirée.
 *
 * 18 h couvre la soirée (12 h au plus) et les matchs d'après-midi (18 h UTC,
 * 2 h 35 après la passe), sans atteindre la soirée suivante. Les matchs
 * d'après-midi gardent une ouverture mais pas de clôture : à 23 h 15 UTC ils
 * ont déjà commencé, et `t > now` les écarte — c'est voulu.
 */
const HORIZON_MS = 18 * 60 * 60_000;

/** Coût supposé du premier appel, avant d'avoir vu `x-requests-last`. */
const FIRST_CALL_ESTIMATE = Math.max(1, PROPS_MARKETS.length);

export type PropsPassKind = 'open' | 'close';

let spentDay = '';
let spentToday = 0;
/** Dernier coût réel observé, par match : l'estimation du prochain appel. */
const lastCost = new Map<string, number>();

function budgetState(): number {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== spentDay) { spentDay = day; spentToday = 0; }
  return spentToday;
}

async function getJson(url: string): Promise<{ ok: boolean; status: number; body: any; headers: Headers | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, { signal: controller.signal });
    recordUpstream('odds', Date.now() - started, res.ok);
    // Y compris en erreur : un 429 porte le solde, et c'est le moment où il
    // compte le plus.
    oddsQuota.observe(res.headers);
    const body = res.ok ? await res.json() : null;
    return { ok: res.ok, status: res.status, body, headers: res.headers };
  } catch (err: any) {
    recordUpstream('odds', Date.now() - started, false);
    // ⚠️ Jamais l'URL ni l'erreur brute : la clé est dans la query string.
    logger.warn({ name: err?.name }, '[PropsLogger] appel en échec');
    return { ok: false, status: 0, body: null, headers: null };
  }
}

interface EventRow { id: string; home: string; away: string; commence: string }

/**
 * Les matchs à venir, avec leur identifiant The Odds API.
 *
 * `/v4/sports/{sport}/events` est explicitement HORS QUOTA côté fournisseur :
 * ce recensement est gratuit, et c'est lui qui permet de connaître la facture
 * avant de l'engager.
 */
export async function fetchUpcomingEvents(): Promise<EventRow[]> {
  if (!process.env.ODDS_API_KEY) return [];
  const url = `${ODDS_BASE}/sports/${SPORT_KEY}/events?apiKey=${process.env.ODDS_API_KEY}`;
  const { ok, status, body } = await getJson(url);
  if (!ok || !Array.isArray(body)) {
    if (status === 401 || status === 403) {
      logger.error({ status }, '[PropsLogger] ⚠️ ODDS_API_KEY refusée — collecte de props hors service');
    }
    return [];
  }
  const now = Date.now();
  return body
    .map((e: any) => ({
      id: String(e?.id ?? ''),
      home: toAbbr(e?.home_team) ?? '',
      away: toAbbr(e?.away_team) ?? '',
      commence: String(e?.commence_time ?? ''),
    }))
    .filter((e: EventRow) => {
      const t = Date.parse(e.commence);
      return e.id && e.home && e.away && Number.isFinite(t) && t > now && t - now < HORIZON_MS;
    })
    .sort((a: EventRow, b: EventRow) => Date.parse(a.commence) - Date.parse(b.commence));
}

/**
 * Fait tourner l'ordre de passage avec le jour, pour que la troncature par
 * budget ne tombe pas toujours sur les mêmes matchs.
 */
export function rotate<T>(items: T[], day = new Date()): T[] {
  if (items.length < 2) return items.slice();
  const n = Math.floor(day.getTime() / 86_400_000) % items.length;
  return [...items.slice(n), ...items.slice(0, n)];
}

export interface PropRow {
  gameDate: string; home: string; away: string; commence: string;
  bookmaker: string; market: string; player: string;
  line: number | null; over: number | null; under: number | null;
}

/**
 * Aplatit la réponse d'un match en lignes (livre × marché × joueur × seuil).
 *
 * Les marchés plus / moins arrivent en deux `outcomes` (« Over » / « Under »)
 * qui partagent `description` (le joueur) et `point` (le seuil) ; les marchés
 * oui / non en « Yes » / « No » sans `point`. Les deux formes se rangent dans
 * les mêmes colonnes, documentées dans la migration 054.
 */
export function flattenEventProps(ev: any, gameDate: string,
                                  home: string, away: string): PropRow[] {
  const out = new Map<string, PropRow>();
  for (const bk of ev?.bookmakers ?? []) {
    for (const mk of bk?.markets ?? []) {
      for (const oc of mk?.outcomes ?? []) {
        const player = String(oc?.description ?? '').trim();
        if (!player) continue;              // un prop sans joueur n'est pas exploitable
        const line = Number.isFinite(Number(oc?.point)) ? Number(oc.point) : null;
        const key = `${bk.key}|${mk.key}|${player}|${line ?? 'nil'}`;
        const row = out.get(key) ?? {
          gameDate, home, away, commence: String(ev?.commence_time ?? ''),
          bookmaker: String(bk.key), market: String(mk.key), player,
          line, over: null, under: null,
        };
        const side = String(oc?.name ?? '').toLowerCase();
        const price = Number(oc?.price);
        if (!Number.isFinite(price)) continue;
        if (side === 'over' || side === 'yes') row.over = price;
        else if (side === 'under' || side === 'no') row.under = price;
        out.set(key, row);
      }
    }
  }
  return [...out.values()];
}

async function writeProps(rows: PropRow[], observedAt: Date, kind: PropsPassKind): Promise<number> {
  if (!rows.length) return 0;
  const res = await pool.query(
    `INSERT INTO props_snapshots (game_date, home_team, away_team, observed_at,
                                  commence_time, pass_kind, bookmaker, market,
                                  player, line, over_price, under_price)
     SELECT * FROM unnest(
       $1::date[], $2::text[], $3::text[], $4::timestamptz[],
       $5::timestamptz[], $6::text[], $7::text[], $8::text[],
       $9::text[], $10::numeric[], $11::numeric[], $12::numeric[]
     )
     ON CONFLICT DO NOTHING`,
    [
      rows.map((r) => r.gameDate), rows.map((r) => r.home), rows.map((r) => r.away),
      rows.map(() => observedAt), rows.map((r) => r.commence || null),
      rows.map(() => kind), rows.map((r) => r.bookmaker), rows.map((r) => r.market),
      rows.map((r) => r.player), rows.map((r) => r.line),
      rows.map((r) => r.over), rows.map((r) => r.under),
    ],
  );
  return res.rowCount ?? 0;
}

/**
 * Une passe : recense les matchs, price ce que le budget permet, écrit.
 *
 * @returns nombre de lignes écrites.
 */
export async function collectProps(kind: PropsPassKind = 'open'): Promise<number> {
  if (!process.env.ODDS_API_KEY || !PROPS_MARKETS.length) return 0;
  const events = await fetchUpcomingEvents();
  if (!events.length) {
    logger.info({ kind }, '[PropsLogger] aucun match à venir — rien à collecter');
    return 0;
  }

  const observedAt = new Date();            // identique pour toute la passe
  const markets = PROPS_MARKETS.join(',');
  let written = 0, priced = 0, skipped = 0;

  for (const ev of rotate(events, observedAt)) {
    const estimate = lastCost.get(ev.id) ?? FIRST_CALL_ESTIMATE;
    if (budgetState() + estimate > PROPS_DAILY_BUDGET) { skipped++; continue; }
    if (!(await oddsQuota.collectorMaySpend(estimate))) { skipped++; continue; }

    const params = new URLSearchParams({
      apiKey: String(process.env.ODDS_API_KEY),
      bookmakers: collectorBookParam(),
      markets,
      oddsFormat: 'decimal',
    });
    const { ok, status, body, headers } = await getJson(
      `${ODDS_BASE}/sports/${SPORT_KEY}/events/${encodeURIComponent(ev.id)}/odds?${params}`);

    // Coût RÉEL de l'appel, tel que le fournisseur le facture ; à défaut,
    // l'estimation. Une réponse vide ne coûte rien chez lui — et `x-requests-last`
    // vaut alors 0, ce que cette lecture reprend telle quelle.
    const last = Number(headers?.get?.('x-requests-last'));
    const cost = Number.isFinite(last) && last >= 0 ? last : estimate;
    budgetState();
    spentToday += cost;
    lastCost.set(ev.id, Math.max(1, cost));

    if (!ok) {
      logger.warn({ status, kind }, '[PropsLogger] match non pricé');
      continue;
    }
    priced++;
    const gameDate = (ev.commence || observedAt.toISOString()).slice(0, 10);
    const rows = flattenEventProps(body, gameDate, ev.home, ev.away);
    try {
      written += await writeProps(rows, observedAt, kind);
    } catch (err: any) {
      // Comme `insertSnapshots` : on avale pour ne pas perdre la passe entière
      // sur un match. Le contrôle de migration au démarrage couvre le cas où
      // la table manque — sans lui, cette ligne cacherait une saison vide.
      logger.error({ err: err?.message, kind }, '[PropsLogger] écriture refusée');
    }
  }

  logger.info({ kind, events: events.length, priced, skipped, written,
                spent: spentToday, budget: PROPS_DAILY_BUDGET },
              '[PropsLogger] passe terminée');
  if (skipped) {
    logger.warn({ skipped, budget: PROPS_DAILY_BUDGET },
                '[PropsLogger] matchs sautés faute de budget — ODDS_PROPS_DAILY_BUDGET');
  }
  return written;
}

/**
 * Calendrier. `open` vise le prix du matin — le même repère que l'ouverture
 * DraftKings du backfill (15:25 UTC) — et `close` la dernière observation avant
 * la mise au jeu de la majorité des matchs. Deux passes suffisent pour un CLV :
 * un prix pris et un prix de clôture.
 */
const SLOTS: Array<{ hour: number; minute: number; kind: PropsPassKind }> = [
  { hour: 15, minute: 25, kind: 'open'  },
  { hour: 23, minute: 15, kind: 'close' },
];

/** Prochain créneau, en UTC — les heures ci-dessus sont des heures UTC. */
export function nextPropsSlot(now: Date): { delayMs: number; kind: PropsPassKind } {
  let best: { delayMs: number; kind: PropsPassKind } | null = null;
  for (let day = 0; day <= 1; day++) {
    for (const s of SLOTS) {
      const t = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + day,
                         s.hour, s.minute, 0, 0);
      const delayMs = t - now.getTime();
      if (delayMs > 0 && (!best || delayMs < best.delayMs)) best = { delayMs, kind: s.kind };
    }
  }
  return best ?? { delayMs: 60 * 60_000, kind: 'open' };
}

let timer: NodeJS.Timeout | null = null;

export function startPropsLogger(): void {
  if (process.env.ODDS_PROPS_ENABLED !== 'true') {
    // Ligne bruyante, pas un `return` muet — même raison que pour
    // `startOddsLogger` : un drapeau resté à false ne se rattrape pas.
    logger.warn('[PropsLogger] ⚠️ ODDS_PROPS_ENABLED≠true — AUCUNE cote de props collectée. '
      + 'Le modèle joueur restera sans référence de marché, et ces journées sont perdues.');
    return;
  }
  if (!process.env.ODDS_API_KEY) {
    logger.warn('[PropsLogger] ODDS_API_KEY absent — collecte de props désactivée.');
    return;
  }

  const run = async (kind: PropsPassKind) => {
    try {
      await withJobLock('props-logger', LOCK_TTL_MS, () => collectProps(kind));
    } catch (err: any) {
      logger.warn({ err: err?.message, kind }, '[PropsLogger] échec');
    }
  };

  const schedule = () => {
    const { delayMs, kind } = nextPropsSlot(new Date());
    timer = setTimeout(() => {
      schedule();                           // replanifié AVANT d'attendre la passe
      void run(kind);
    }, delayMs);
    timer.unref?.();
  };

  logger.info({ slots: SLOTS.length, markets: PROPS_MARKETS,
                budgetPerDay: PROPS_DAILY_BUDGET }, '[PropsLogger] calendrier armé');
  schedule();

  // Contrôle de mise en service de la 054, au démarrage : `collectProps` avale
  // ses erreurs d'écriture match par match, donc sans ce contrôle une migration
  // oubliée laisserait la collecte tourner toute la saison sur une table
  // absente, logs au vert et table vide.
  void pool
    .query(`SELECT to_regclass('public.props_snapshots') AS t`)
    .then(({ rows }) => {
      if (!rows[0]?.t) {
        logger.error('[PropsLogger] ⛔ table `props_snapshots` INTROUVABLE — migration 054 '
          + 'non appliquée. Chaque passe échouera EN SILENCE. Lancer `npm run db:migrate:all`.');
      }
    })
    .catch(() => { /* base indisponible au démarrage : le job le dira à la première passe */ });
}

export function stopPropsLogger(): void {
  if (timer) { clearTimeout(timer); timer = null; }
}

/**
 * Export au format lu côté ML (`ml/data/props_snapshots_live.csv`).
 *
 * Fichier à part, réécrit en entier : il n'existe aucun backfill de props à
 * protéger, mais la forme reste celle de `exportOddsSnapshotsCsv` pour que les
 * deux séries se lisent de la même façon.
 */
export async function exportPropsSnapshotsCsv(): Promise<string> {
  const { rows } = await pool.query(
    `SELECT game_date, home_team, away_team, observed_at, commence_time,
            pass_kind, bookmaker, market, player, line, over_price, under_price
       FROM props_snapshots
      ORDER BY game_date, home_team, away_team, observed_at, bookmaker, market, player`);
  const head = 'date,home_team,away_team,observed_at,commence_time,pass_kind,'
    + 'bookmaker,market,player,line,over_price,under_price';
  const esc = (v: any) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = rows.map((r: any) => [
    String(r.game_date).slice(0, 10), r.home_team, r.away_team,
    r.observed_at?.toISOString?.() ?? r.observed_at,
    r.commence_time?.toISOString?.() ?? r.commence_time ?? '',
    r.pass_kind, r.bookmaker, r.market, r.player,
    r.line ?? '', r.over_price ?? '', r.under_price ?? '',
  ].map(esc).join(','));
  return [head, ...body].join('\n') + '\n';
}

/** État du budget — pour `/api/dev/data-health`. */
export function propsBudgetState() {
  return { day: spentDay || null, spent: budgetState(), budget: PROPS_DAILY_BUDGET,
           markets: PROPS_MARKETS, slots: SLOTS.length };
}

/** Remise à zéro du compteur de budget, pour les tests. */
export function __resetPropsBudgetForTests(): void {
  spentDay = ''; spentToday = 0; lastCost.clear();
}
