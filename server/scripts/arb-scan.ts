/**
 * arb-scan.ts — Scanner d'arbitrages NHL entre bookmakers (outil perso, hors app).
 *
 *   npm run arb:scan                         → 1 scan, marchés principaux (h2h, spreads, totals) ≈ 3 crédits
 *   npm run arb:scan -- --demo               → données fictives, 0 crédit (pour tester)
 *   npm run arb:scan -- --watch 120          → re-scan toutes les 120 s (Ctrl+C pour arrêter)
 *   npm run arb:scan -- --extras             → + marchés par match : 3-way, alternatifs, périodes, totaux d'équipe
 *   npm run arb:scan -- --props              → + props joueurs (points, buts, tirs, arrêts…)
 *   npm run arb:scan -- --bankroll 500 --round 5 --min 1 --books draftkings,fanduel,pinnacle
 *
 * Toute la logique de détection est dans `src/services/arb/arbScanner.ts` (pure,
 * testée). Ce script ne fait que : récupérer les cotes, protéger le quota,
 * afficher, journaliser, alerter.
 *
 * COÛT (The Odds API). Jusqu'à 10 livres = le prix d'UNE région.
 *   • marchés principaux : 3 crédits par scan (1 appel pour tous les matchs) ;
 *   • --extras / --props : 1 crédit PAR MARCHÉ RENVOYÉ et PAR MATCH (appel par
 *     match) — 8 matchs × 10 marchés ≈ 80 crédits. Limité aux matchs des
 *     `--horizon` prochaines heures (défaut 12) et mis en cache
 *     `ARB_EXTRAS_TTL_MIN` minutes (défaut 60) pour ne pas les repayer à chaque scan.
 *     → à lancer ponctuellement, pas en surveillance serrée.
 *
 * Variables (server/.env) :
 *   ARB_ODDS_API_KEY     clé dédiée au scanner (recommandé) ; à défaut ODDS_API_KEY,
 *                        celle de l'app — le plancher ci-dessous protège alors son quota
 *   ARB_MIN_REMAINING    le scanner n'appelle plus l'API sous ce solde (défaut 3000)
 *   ARB_BOOKS            livres comparés, séparés par des virgules (défaut : 10 livres US + CA)
 *   ARB_EXTRA_MARKETS    marchés de --extras (défaut ci-dessous)
 *   ARB_PROP_MARKETS     marchés de --props (défaut ci-dessous)
 *   ARB_EXTRAS_TTL_MIN   cache des marchés par match, en minutes (défaut 60)
 *   ARB_DISCORD_WEBHOOK  webhook Discord : alerte à chaque NOUVEL arbitrage (facultatif)
 *   ARB_LOG_FILE         journal JSONL (défaut server/arb-log.jsonl, ignoré par git)
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { findArbs, ArbEvent, ArbOpportunity, ArbBookmaker } from '../src/services/arb/arbScanner';

const ODDS_BASE = 'https://api.the-odds-api.com/v4';
const API_KEY = (process.env.ARB_ODDS_API_KEY || process.env.ODDS_API_KEY || '').trim();
const KEY_IS_SHARED = !process.env.ARB_ODDS_API_KEY && !!process.env.ODDS_API_KEY;

/** 10 livres = coût d'une région. Livres vérifiés sur la NHL (probe_odds_books.py). */
const DEFAULT_BOOKS = [
  'draftkings', 'fanduel', 'betmgm', 'williamhill_us', 'betrivers',
  'fanatics', 'pinnacle', 'bet99_ca_on', 'playnow_ca', 'betano_ca_on',
];
const FEATURED_MARKETS = 'h2h,spreads,totals';
const DEFAULT_EXTRA_MARKETS = [
  'h2h_3_way', 'alternate_spreads', 'alternate_totals', 'team_totals', 'btts',
  'totals_p1', 'totals_p2', 'totals_p3', 'h2h_3_way_p1', 'h2h_3_way_p2', 'h2h_3_way_p3',
].join(',');
const DEFAULT_PROP_MARKETS = [
  'player_points', 'player_goals', 'player_assists', 'player_shots_on_goal', 'player_total_saves',
].join(',');

function readNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const MIN_REMAINING = readNum('ARB_MIN_REMAINING', 3000);
const EXTRAS_TTL_MS = readNum('ARB_EXTRAS_TTL_MIN', 60) * 60_000;
const DISCORD_WEBHOOK = (process.env.ARB_DISCORD_WEBHOOK || '').trim();
const LOG_FILE = path.resolve(process.env.ARB_LOG_FILE || path.resolve(__dirname, '..', 'arb-log.jsonl'));
const FIXTURE = path.resolve(__dirname, '..', 'src', 'services', 'arb', '__fixtures__', 'arb-sample.json');

// ─── Arguments ───────────────────────────────────────────────────────────────

interface Args {
  demo: boolean;
  watch: number;       // secondes entre deux scans ; 0 = un seul scan
  extras: boolean;
  props: boolean;
  bankroll: number;
  round: number;
  min: number;
  books: string[];
  sport: string;
  horizonH: number;    // --extras/--props : seulement les matchs dans les N prochaines heures
  log: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    demo: false, watch: 0, extras: false, props: false, bankroll: 1000, round: 1, min: 0.5,
    books: (process.env.ARB_BOOKS || '').split(',').map((s) => s.trim()).filter(Boolean),
    sport: 'icehockey_nhl', horizonH: 12, log: true,
  };
  if (!a.books.length) a.books = DEFAULT_BOOKS.slice();

  const num = (flag: string, v: string | undefined): number => {
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n) || n < 0) throw new Error(`${flag} attend un nombre positif`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    switch (f) {
      case '--demo': a.demo = true; break;
      case '--watch': a.watch = num(f, argv[++i]); break;
      case '--extras': a.extras = true; break;
      case '--props': a.props = true; break;
      case '--bankroll': a.bankroll = num(f, argv[++i]); break;
      case '--round': a.round = num(f, argv[++i]); break;
      case '--min': a.min = num(f, argv[++i]); break;
      case '--horizon': a.horizonH = num(f, argv[++i]); break;
      case '--sport': a.sport = String(argv[++i] || a.sport); break;
      case '--books': a.books = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--no-log': a.log = false; break;
      case '-h': case '--help':
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
        process.exit(0);
        break;
      default: throw new Error(`Option inconnue : ${f} (voir --help)`);
    }
  }
  if (a.watch > 0 && a.watch < 30) throw new Error('--watch : 30 s minimum (quota)');
  if (a.books.length < 2) throw new Error('Il faut au moins 2 livres pour comparer');
  return a;
}

// ─── Appels The Odds API, avec garde-fou de quota ────────────────────────────

let remaining: number | null = null;
let spentThisScan = 0;

function observe(res: Response): void {
  const rem = Number(res.headers.get('x-requests-remaining'));
  if (res.headers.get('x-requests-remaining') !== null && Number.isFinite(rem)) remaining = rem;
  const last = Number(res.headers.get('x-requests-last'));
  if (res.headers.get('x-requests-last') !== null && Number.isFinite(last)) spentThisScan += last;
}

/** Vrai si dépenser `cost` crédits laisse au moins `ARB_MIN_REMAINING`. */
function maySpend(cost: number): boolean {
  return remaining === null || remaining - cost >= MIN_REMAINING;
}

async function oddsGet<T>(pathAndQuery: string): Promise<T | null> {
  const url = `${ODDS_BASE}${pathAndQuery}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    observe(res);
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      console.error(`  ✗ The Odds API ${res.status} : ${body}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.error(`  ✗ Réseau : ${(err as Error).message}`);
    return null;
  }
}

/** Lit le solde sans rien dépenser (l'endpoint /sports ne compte pas dans le quota). */
async function primeQuota(): Promise<void> {
  await oddsGet<unknown>(`/sports?apiKey=${encodeURIComponent(API_KEY)}`);
}

const extrasCache = new Map<string, { at: number; bookmakers: ArbBookmaker[] }>();

async function fetchEvents(args: Args): Promise<ArbEvent[]> {
  const books = args.books.join(',');
  const regionsBilled = Math.ceil(args.books.length / 10);
  const featuredCost = 3 * regionsBilled;
  if (!maySpend(featuredCost)) {
    console.warn(`  ⏸ Solde ${remaining} − ${featuredCost} < plancher ${MIN_REMAINING} : scan sauté.`);
    return [];
  }
  const q = new URLSearchParams({
    apiKey: API_KEY, bookmakers: books, markets: FEATURED_MARKETS,
    oddsFormat: 'decimal', dateFormat: 'iso',
  });
  const events = (await oddsGet<ArbEvent[]>(`/sports/${args.sport}/odds?${q}`)) ?? [];
  if (!args.extras && !args.props) return events;

  const markets = [
    args.extras ? (process.env.ARB_EXTRA_MARKETS || DEFAULT_EXTRA_MARKETS) : '',
    args.props ? (process.env.ARB_PROP_MARKETS || DEFAULT_PROP_MARKETS) : '',
  ].filter(Boolean).join(',');
  const worstCost = markets.split(',').length * regionsBilled;
  const now = Date.now();
  const horizon = now + args.horizonH * 3_600_000;

  for (const ev of events) {
    const start = Date.parse(ev.commence_time);
    if (!ev.id || !(start > now) || start > horizon) continue;

    const cached = extrasCache.get(ev.id);
    if (cached && now - cached.at < EXTRAS_TTL_MS) {
      ev.bookmakers = [...ev.bookmakers, ...cached.bookmakers];
      continue;
    }
    if (!maySpend(worstCost)) {
      console.warn(`  ⏸ Plancher de crédits atteint : marchés par match arrêtés (${ev.away_team} @ ${ev.home_team} et suivants).`);
      break;
    }
    const qe = new URLSearchParams({
      apiKey: API_KEY, bookmakers: books, markets, oddsFormat: 'decimal', dateFormat: 'iso',
    });
    const body = await oddsGet<{ bookmakers?: ArbBookmaker[] }>(
      `/sports/${args.sport}/events/${encodeURIComponent(ev.id)}/odds?${qe}`);
    const extra = body?.bookmakers ?? [];
    extrasCache.set(ev.id, { at: now, bookmakers: extra });
    ev.bookmakers = [...ev.bookmakers, ...extra];
  }
  return events;
}

// ─── Affichage ───────────────────────────────────────────────────────────────

function until(iso: string, now: Date): string {
  const min = Math.round((Date.parse(iso) - now.getTime()) / 60_000);
  if (min < 60) return `dans ${min} min`;
  const h = Math.floor(min / 60);
  return `dans ${h} h ${String(min % 60).padStart(2, '0')}`;
}

const money = (x: number): string => `${x.toFixed(2)} $`;

function marketLabel(o: ArbOpportunity): string {
  return [o.market, o.subject, o.line !== undefined && !o.market.includes('spread') ? o.line : undefined]
    .filter((x) => x !== undefined && x !== '').join(' ');
}

function printOpp(o: ArbOpportunity, i: number, now: Date): void {
  const flag = o.suspect ? ' [SUSPECT]' : '';
  console.log(`\n[${i + 1}] +${o.profitPct.toFixed(2)} %${flag}  ${o.match}  —  ${marketLabel(o)}  —  ${until(o.commenceTime, now)}`);
  for (const l of o.legs) {
    console.log(`    ${l.side.padEnd(30)} @ ${l.price.toFixed(2).padStart(5)}  ${l.bookmakerTitle.padEnd(14)} → miser ${l.stakeRounded} $`);
  }
  const totalRounded = o.legs.reduce((s, l) => s + l.stakeRounded, 0);
  console.log(`    Profit garanti : ${money(o.guaranteedProfit)} sur ${o.bankroll} $` +
    (o.guaranteedProfitRounded !== o.guaranteedProfit
      ? ` (mises arrondies : ${money(o.guaranteedProfitRounded)} sur ${totalRounded} $)` : ''));
  for (const w of o.warnings) console.log(`    ! ${w}`);
}

function discordText(o: ArbOpportunity, now: Date): string {
  const lines = [
    `**+${o.profitPct.toFixed(2)} %**${o.suspect ? ' ⚠️ SUSPECT' : ''} ${o.match} — ${marketLabel(o)} (${until(o.commenceTime, now)})`,
    ...o.legs.map((l) => `• ${l.side} @ ${l.price.toFixed(2)} — ${l.bookmakerTitle} → ${l.stakeRounded} $`),
    `Profit : ${money(o.guaranteedProfitRounded)} / ${o.bankroll} $`,
    ...o.warnings.map((w) => `> ${w}`),
  ];
  return lines.join('\n').slice(0, 1900);
}

async function alertDiscord(opps: ArbOpportunity[], now: Date): Promise<void> {
  if (!DISCORD_WEBHOOK) return;
  for (const o of opps.slice(0, 5)) {   // 5 max par scan : limite de débit Discord
    try {
      await fetch(DISCORD_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: discordText(o, now) }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch (err) {
      console.error(`  ✗ Discord : ${(err as Error).message}`);
    }
  }
}

// ─── Boucle ──────────────────────────────────────────────────────────────────

const alreadyAlerted = new Set<string>();

async function scanOnce(args: Args): Promise<void> {
  spentThisScan = 0;
  let events: ArbEvent[];
  let now = new Date();

  if (args.demo) {
    const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { now: string; events: ArbEvent[] };
    events = fx.events;
    now = new Date(fx.now);
  } else {
    events = await fetchEvents(args);
  }

  const { opportunities, stats } = findArbs(events, {
    now, bankroll: args.bankroll, roundTo: args.round, minProfitPct: args.min,
    books: args.books,
  });

  const credits = args.demo ? 'démo, 0 crédit'
    : `${spentThisScan} crédit(s) utilisé(s), solde ${remaining ?? '?'}`;
  console.log(`\n── Scan ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC · ${stats.events} matchs · ` +
    `${stats.groupsCompared} marchés comparés · ${credits}`);
  if (stats.quotesSkippedStale) console.log(`   (${stats.quotesSkippedStale} cote(s) trop vieille(s) ignorée(s))`);

  if (!opportunities.length) {
    console.log(`   Aucun arbitrage ≥ ${args.min} %.` +
      (stats.closest ? ` Le plus proche : ${stats.closest.label} (Σ = ${stats.closest.impliedSum})` : ''));
  }
  opportunities.forEach((o, i) => printOpp(o, i, now));

  if (args.demo) return;

  const fresh = opportunities.filter((o) => !alreadyAlerted.has(o.id));
  fresh.forEach((o) => alreadyAlerted.add(o.id));
  if (args.log && fresh.length) {
    const at = new Date().toISOString();
    fs.appendFileSync(LOG_FILE, fresh.map((o) => JSON.stringify({ at, ...o })).join('\n') + '\n');
  }
  await alertDiscord(fresh, now);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.demo) {
    if (!API_KEY) throw new Error('Aucune clé : pose ARB_ODDS_API_KEY (ou ODDS_API_KEY) dans server/.env, ou lance --demo');
    if (args.books.length > 10) {
      console.warn(`! ${args.books.length} livres = ${Math.ceil(args.books.length / 10)} régions facturées : chaque appel coûte plus cher.`);
    }
    if (KEY_IS_SHARED) {
      console.warn(`! Clé partagée avec l'app (ODDS_API_KEY) : arrêt automatique sous ${MIN_REMAINING} crédits restants.`);
    }
    await primeQuota();
  }
  console.log('Rappel : vérifie chaque cote dans l\'appli du livre avant de miser (l\'API a du retard),');
  console.log('et que les deux livres règlent le marché pareil (prolongation, tirs de barrage, joueur absent).');

  await scanOnce(args);
  if (args.watch > 0 && !args.demo) {
    console.log(`\nSurveillance toutes les ${args.watch} s — Ctrl+C pour arrêter.`);
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await new Promise((r) => setTimeout(r, args.watch * 1000));
      await scanOnce(args);
    }
  }
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exitCode = 1;
});
