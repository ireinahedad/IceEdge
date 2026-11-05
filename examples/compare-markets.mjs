#!/usr/bin/env node
// compare-markets.mjs — read-only example: the morning ArakIce probabilities next to
// public prediction-market prices, and the gap between them.
//
//   node examples/compare-markets.mjs                 # today (US Eastern), Kalshi + Polymarket
//   node examples/compare-markets.mjs --date=2026-11-05 --source=kalshi
//   node examples/compare-markets.mjs --json          # machine-readable output
//
// Node >= 20, no install, no account, no API key. It only READS public endpoints:
//   • model : data/YYYY/YYYY-MM-DD.json from this repository (local clone, else raw.githubusercontent.com)
//   • Kalshi: GET https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXNHLGAME&status=open
//   • Polymarket: GET https://gamma-api.polymarket.com/events?tag_slug=nhl&closed=false
//
// It places no orders and has no code to do so. A gap is a difference between two
// estimates, not a recommendation: market prices include the venue's margin and
// fees, which this script does not remove. Check whether these venues are legal
// and available where you live.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO = 'ireinahedad/arakice-nhl-predictions';
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const POLY = 'https://gamma-api.polymarket.com';

// ── Teams ───────────────────────────────────────────────────────────────────
// NHL abbreviation → [city, nickname, other codes seen on venues].
export const TEAMS = {
  ANA: ['Anaheim', 'Ducks'], BOS: ['Boston', 'Bruins'], BUF: ['Buffalo', 'Sabres'],
  CGY: ['Calgary', 'Flames'], CAR: ['Carolina', 'Hurricanes'], CHI: ['Chicago', 'Blackhawks'],
  COL: ['Colorado', 'Avalanche'], CBJ: ['Columbus', 'Blue Jackets', 'CLB'], DAL: ['Dallas', 'Stars'],
  DET: ['Detroit', 'Red Wings'], EDM: ['Edmonton', 'Oilers'], FLA: ['Florida', 'Panthers'],
  LAK: ['Los Angeles', 'Kings', 'LA'], MIN: ['Minnesota', 'Wild'], MTL: ['Montreal', 'Canadiens', 'MON'],
  NSH: ['Nashville', 'Predators', 'NAS'], NJD: ['New Jersey', 'Devils', 'NJ'], NYI: ['New York', 'Islanders'],
  NYR: ['New York', 'Rangers'], OTT: ['Ottawa', 'Senators'], PHI: ['Philadelphia', 'Flyers'],
  PIT: ['Pittsburgh', 'Penguins'], SJS: ['San Jose', 'Sharks', 'SJ'], SEA: ['Seattle', 'Kraken'],
  STL: ['St. Louis', 'Blues'], TBL: ['Tampa Bay', 'Lightning', 'TB'], TOR: ['Toronto', 'Maple Leafs'],
  UTA: ['Utah', 'Mammoth', 'UTAH'], VAN: ['Vancouver', 'Canucks'], VGK: ['Vegas', 'Golden Knights', 'VEG'],
  WSH: ['Washington', 'Capitals', 'WAS'], WPG: ['Winnipeg', 'Jets'],
};

const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const CODE = new Map(Object.entries(TEAMS).flatMap(([abbr, [, , ...codes]]) => [abbr, ...codes].map((c) => [c.toUpperCase(), abbr])));

/** The NHL abbreviation named in a short text ("Toronto", "Maple Leafs", "TOR"…), or null if unclear. */
export function teamFromText(text) {
  const t = ` ${norm(text)} `;
  if (!t.trim()) return null;
  const code = CODE.get(String(text).trim().toUpperCase());
  if (code) return code;
  const byNick = Object.entries(TEAMS).filter(([, [, nick]]) => t.includes(` ${norm(nick)} `));
  if (byNick.length === 1) return byNick[0][0];
  const byCity = Object.entries(TEAMS).filter(([, [city]]) => t.includes(` ${norm(city)} `));
  if (byCity.length === 1) return byCity[0][0];
  if (/ new york r( |$)/.test(t)) return 'NYR';
  if (/ new york i( |$)/.test(t)) return 'NYI';
  return null;
}

/** Last segment of a Kalshi market ticker, e.g. KXNHLGAME-26NOV04UTATOR-TOR → TOR. */
export const teamFromKalshiTicker = (ticker) => CODE.get(String(ticker ?? '').split('-').pop()?.toUpperCase()) ?? null;

// ── Prices ──────────────────────────────────────────────────────────────────
const num = (x) => (x == null || x === '' ? null : Number(x));
const valid = (p) => (Number.isFinite(p) && p > 0 && p < 1 ? p : null);

/** Kalshi market → YES price (0–1): bid/ask midpoint, else last trade. Dollar fields first (cents are deprecated). */
export function kalshiPrice(m) {
  const d = (k) => num(m[`${k}_dollars`]) ?? (num(m[k]) == null ? null : num(m[k]) / 100);
  const bid = d('yes_bid'), ask = d('yes_ask');
  if (valid(bid) && valid(ask) && ask >= bid) return { price: Math.round(((bid + ask) / 2) * 1e4) / 1e4, how: 'mid' };
  const last = valid(d('last_price'));
  return last ? { price: last, how: 'last' } : null;
}

const parseList = (x) => { try { return Array.isArray(x) ? x : JSON.parse(x ?? '[]'); } catch { return []; } };

/** Polymarket moneyline market → { [abbr]: price } for both teams, or null. */
export function polymarketPrices(m) {
  if (m.sportsMarketType && m.sportsMarketType !== 'moneyline') return null;
  const outcomes = parseList(m.outcomes), prices = parseList(m.outcomePrices).map(Number);
  if (outcomes.length !== 2 || prices.length !== 2) return null;
  const teams = outcomes.map(teamFromText);
  if (!teams[0] || !teams[1] || teams[0] === teams[1]) return null;
  if (!valid(prices[0]) || !valid(prices[1])) return null;
  return { [teams[0]]: prices[0], [teams[1]]: prices[1] };
}

// ── Matching ────────────────────────────────────────────────────────────────
const HOURS = 3600_000;
const near = (iso, startMs, beforeH, afterH) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) && t >= startMs - beforeH * HOURS && t <= startMs + afterH * HOURS;
};

/** Kalshi: the two team markets of one event that match the game → home YES price. */
export function matchKalshi(game, markets) {
  const start = Date.parse(game.startTimeUTC);
  const byEvent = new Map();
  for (const m of markets) {
    // A game market closes after the game: keep the ones closing within 2 days of puck drop.
    if (!near(m.close_time ?? m.expected_expiration_time, start, 0, 48)) continue;
    const team = teamFromKalshiTicker(m.ticker) ?? teamFromText(m.yes_sub_title);
    if (!team) continue;
    if (!byEvent.has(m.event_ticker)) byEvent.set(m.event_ticker, new Map());
    byEvent.get(m.event_ticker).set(team, m);
  }
  for (const [event, teams] of byEvent) {
    if (teams.size !== 2 || !teams.has(game.home) || !teams.has(game.away)) continue;
    const h = kalshiPrice(teams.get(game.home)), a = kalshiPrice(teams.get(game.away));
    if (!h) continue;
    return { venue: 'Kalshi', ref: event, home: h.price, away: a?.price ?? null, how: h.how };
  }
  return null;
}

/** Polymarket: the moneyline market of an event naming both teams, starting near puck drop. */
export function matchPolymarket(game, events) {
  const start = Date.parse(game.startTimeUTC);
  for (const ev of events) {
    for (const m of ev.markets ?? []) {
      if (m.closed === true) continue;
      const when = m.gameStartTime ? new Date(String(m.gameStartTime).replace(' ', 'T').replace(/\+00$/, 'Z')).toISOString() : ev.startTime;
      if (!near(when, start, 12, 12)) continue;
      const p = polymarketPrices(m);
      if (!p || p[game.home] == null || p[game.away] == null) continue;
      return { venue: 'Polymarket', ref: ev.slug ?? m.slug ?? null, home: p[game.home], away: p[game.away], how: 'price' };
    }
  }
  return null;
}

/** One comparison row. Gap = model − market, in probability points, on the raw market price. */
export function row(game, quote) {
  const model = game.probabilities.homeWin;
  if (!quote) return { game: `${game.away} @ ${game.home}`, model, market: null, gap: null };
  const sum = quote.away == null ? null : quote.home + quote.away;
  return {
    game: `${game.away} @ ${game.home}`,
    venue: quote.venue,
    model,
    market: Math.round(quote.home * 1e4) / 1e4,
    marketSum: sum == null ? null : Math.round(sum * 1e4) / 1e4, // > 1 = the venue's margin
    gap: Math.round((model - quote.home) * 1e4) / 1e4,
    ref: quote.ref,
  };
}

// ── I/O ─────────────────────────────────────────────────────────────────────
async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'arakice-compare-example' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
  return res.json();
}

async function modelDay(date) {
  const here = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', date.slice(0, 4), `${date}.json`);
  if (existsSync(here)) return JSON.parse(readFileSync(here, 'utf8'));
  const res = await fetch(`https://raw.githubusercontent.com/${REPO}/main/data/${date.slice(0, 4)}/${date}.json`, { signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`raw.githubusercontent.com: HTTP ${res.status}`);
  return res.json();
}

async function kalshiMarkets() {
  const out = [];
  let cursor = '';
  for (let page = 0; page < 10; page++) {
    const j = await getJson(`${KALSHI}/markets?series_ticker=KXNHLGAME&status=open&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    out.push(...(j.markets ?? []));
    cursor = j.cursor;
    if (!cursor) break;
  }
  return out;
}

async function polymarketEvents() {
  const out = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await getJson(`${POLY}/events?tag_slug=nhl&closed=false&limit=100&offset=${offset}`);
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    if (page.length < 100) break;
  }
  return out;
}

const pct = (p) => (p == null ? '   —  ' : `${(p * 100).toFixed(1).padStart(5)}%`);
const pts = (g) => (g == null ? '    —' : `${g >= 0 ? '+' : '−'}${Math.abs(g * 100).toFixed(1).padStart(4)}`);

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? 'true']));
  const date = args.date ?? new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date=YYYY-MM-DD');
  const sources = String(args.source ?? 'kalshi,polymarket').split(',');

  const day = await modelDay(date);
  if (!day?.games?.length) { console.log(`No published probabilities for ${date} (published around 15:00 UTC on game days).`); return; }
  const now = Date.now();
  const games = day.games.filter((g) => Date.parse(g.startTimeUTC) > now);

  const venues = [];
  if (sources.includes('kalshi')) {
    try { const m = await kalshiMarkets(); venues.push((g) => matchKalshi(g, m)); } catch (e) { console.error(`Kalshi skipped: ${e.message}`); }
  }
  if (sources.includes('polymarket')) {
    try { const ev = await polymarketEvents(); venues.push((g) => matchPolymarket(g, ev)); } catch (e) { console.error(`Polymarket skipped: ${e.message}`); }
  }

  const rows = games.flatMap((g) => (venues.length ? venues.map((v) => row(g, v(g))) : [row(g, null)]));
  if (args.json) { console.log(JSON.stringify({ date, modelFrozenAt: day.frozenAt, rows }, null, 2)); return; }

  console.log(`ArakIce model (published ${day.frozenAt ?? '?'}) vs public market prices — ${date}, upcoming games only`);
  console.log('P = probability the HOME team wins. Gap = model − market, in points. Market prices include the venue margin (Sum above 1).\n');
  console.log('Game          Venue        Model   Market    Gap   Sum (home+away price)');
  for (const r of rows) {
    console.log(`${r.game.padEnd(13)} ${(r.venue ?? '—').padEnd(11)} ${pct(r.model)}  ${pct(r.market)}  ${pts(r.gap)}   ${r.marketSum == null ? '' : r.marketSum.toFixed(3)}`);
  }
  const skipped = day.games.length - games.length;
  if (skipped) console.log(`\n${skipped} game(s) already started: not shown.`);
  console.log('\nRead-only example. No orders, no advice. Model estimates; not financial, legal or betting advice.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
