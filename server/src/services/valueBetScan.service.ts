// ============================================================
//  Value-bet scan job
// ============================================================
// Periodically looks for a standout value bet and pushes it to Pro users who
// opted into value-bet notifications. Enabled via PUSH_SCAN_ENABLED=true.
//
// True +EV: we compare the model's win probability against the REAL bookmaker
// payout (decimal odds from The Odds API via oddsClient). A bet is +EV when the
// expected return per unit staked is positive:
//     EV = modelProb × decimalOdds − 1        (> 0  ⇒ value)
// Scope = moneyline + totals (over/under) — the two markets the odds feed prices.
// For totals we only compute EV when the book's line matches the bet's line,
// otherwise model prob and payout would refer to different lines. An alert
// requires BOTH a positive edge (EV ≥ MIN_EV) AND a strong model score
// (≥ SCORE_THRESHOLD) — the double filter keeps thin, noise-driven edges out.

import { pool } from '../db/connection';
import { getBestBets } from './bestBets.service';
import { fetchGameById } from './nhlApiClient';
import { fetchOddsImplied, fetchTotalsOdds } from './oddsClient';
import { sendToUser, pushEnabled } from './push.service';

const SCORE_THRESHOLD = 65;           // only alert on strong model picks
// Minimum expected-value edge (fraction of stake) to qualify. 0 = any positive
// edge; override with VALUE_BET_MIN_EV (e.g. 0.05 for +5%).
const MIN_EV = Number(process.env.VALUE_BET_MIN_EV) || 0;
// How many top moneyline candidates (by score) to price against real odds.
const MAX_PRICED = 10;

let lastAlertKey: string | null = null;
let timer: NodeJS.Timeout | null = null;

interface ValueBet {
  key: string;
  label: string;
  context: string;
  score: number;    // model win probability (%)
  odds: number;     // real decimal odds from the book
  book: string;     // bookmaker key (e.g. 'bet365')
  evPct: number;    // expected-value edge, rounded to whole %
}

// Markets we can price against real odds. Others are excluded from the +EV scan.
const PRICED_MARKETS = new Set(['moneyline', 'total_goals']);

/**
 * Scans strong moneyline/totals picks and prices each against the real odds from
 * the bookmaker feed. Returns the single best genuine +EV bet, or null.
 */
async function findTopValueBet(): Promise<ValueBet | null> {
  // Pull a wide slate, then keep only strong priceable picks (double filter #1).
  const { bets } = await getBestBets({ limit: 40, source: 'ml' });
  const candidates = bets
    .filter((b) => PRICED_MARKETS.has(b.marketType) && b.score >= SCORE_THRESHOLD && b.gameId)
    .slice(0, MAX_PRICED);
  if (candidates.length === 0) return null;

  // Real odds (h2h + totals) + resolved home side, cached per game so all of a
  // game's picks share one lookup. `null` = looked up, nothing usable available.
  interface PricedGame {
    h2h: Awaited<ReturnType<typeof fetchOddsImplied>>;
    totals: Awaited<ReturnType<typeof fetchTotalsOdds>>;
    homeAbbr: string;
  }
  const gameCache = new Map<string, PricedGame | null>();

  async function priceGame(gameId: string): Promise<PricedGame | null> {
    if (gameCache.has(gameId)) return gameCache.get(gameId)!;
    const game = await fetchGameById(gameId);
    const homeName = game.homeTeam?.name ?? game.homeTeam?.abbreviation ?? '';
    const awayName = game.awayTeam?.name ?? game.awayTeam?.abbreviation ?? '';
    const [h2h, totals] = await Promise.all([
      fetchOddsImplied(homeName, awayName),
      fetchTotalsOdds(homeName, awayName),
    ]);
    const priced: PricedGame | null = (h2h || totals)
      ? { h2h, totals, homeAbbr: String(game.homeTeam?.abbreviation ?? '').toLowerCase() }
      : null;
    gameCache.set(gameId, priced);
    return priced;
  }

  /** Real decimal odds for a bet's exact selection, or null if not priceable. */
  function oddsForBet(bet: (typeof candidates)[number], priced: PricedGame): { odds: number; book: string } | null {
    if (bet.marketType === 'moneyline') {
      if (!priced.h2h) return null;
      const isHomePick = bet.teamAbbr?.toLowerCase() === priced.homeAbbr;
      return { odds: isHomePick ? priced.h2h.homeOdds : priced.h2h.awayOdds, book: priced.h2h.bookmaker };
    }
    // total_goals: only valid when the book's line matches the bet's line.
    if (!priced.totals || bet.line == null || priced.totals.line !== bet.line) return null;
    const isOver = bet.selectionValue === 'over';
    return { odds: isOver ? priced.totals.overOdds : priced.totals.underOdds, book: priced.totals.bookmaker };
  }

  let best: ValueBet | null = null;

  for (const bet of candidates) {
    try {
      const priced = await priceGame(bet.gameId!);
      if (!priced) continue;   // no real price for this game → can't compute +EV

      const priceInfo = oddsForBet(bet, priced);
      if (!priceInfo || priceInfo.odds <= 1) continue;

      const modelProb = bet.score / 100;
      const ev = modelProb * priceInfo.odds - 1;        // true expected value
      if (ev < MIN_EV) continue;                         // double filter #2: +EV

      if (!best || ev > best.evPct / 100) {
        best = {
          key: bet.id,
          label: bet.label,
          context: bet.context,
          score: Math.round(bet.score),
          odds: priceInfo.odds,
          book: priceInfo.book,
          evPct: Math.round(ev * 100),
        };
      }
    } catch (err: any) {
      console.warn(`[ValueBetScan] pricing failed for ${bet.id}:`, err?.message);
    }
  }

  return best;
}

/** A recipient plus their personal minimum-EV threshold (in whole %). */
interface OptedInUser { userId: string; minEvPct: number; }

/** Users who are Pro AND opted into value-bet notifications AND have a device. */
async function optedInUsers(): Promise<OptedInUser[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT ps.user_id, up.value_bet_min_ev_pct
       FROM push_subscriptions ps
       JOIN user_profiles up ON up.user_id = ps.user_id
       JOIN subscriptions  s ON s.user_id  = ps.user_id
      WHERE up.notify_value_bets = TRUE
        AND s.plan = 'pro'
        AND s.status IN ('active','trialing')
        AND (s.current_period_end IS NULL OR s.current_period_end > NOW())`,
  );
  return rows.map((r) => ({ userId: r.user_id, minEvPct: Number(r.value_bet_min_ev_pct) || 0 }));
}

async function runScan(): Promise<void> {
  try {
    const vb = await findTopValueBet();
    if (!vb || vb.key === lastAlertKey) return;   // nothing new to alert
    lastAlertKey = vb.key;

    // Only notify users whose personal min-EV threshold is met by this bet.
    const recipients = (await optedInUsers()).filter((u) => vb.evPct >= u.minEvPct);
    if (recipients.length === 0) return;

    const payload = {
      title: '🔥 Value bet détecté',
      body: `${vb.label} · +${vb.evPct}% EV · cote ${vb.odds.toFixed(2)} (${vb.book}) · modèle ${vb.score}%`,
      url: '/',
    };
    await Promise.all(recipients.map((u) => sendToUser(u.userId, payload)));
    console.log(
      `[ValueBetScan] Alerted ${recipients.length} user(s): ${vb.label} ` +
      `(+${vb.evPct}% EV @ ${vb.odds.toFixed(2)} ${vb.book})`,
    );
  } catch (err: any) {
    console.warn('[ValueBetScan] scan failed:', err?.message);
  }
}

export function startValueBetScan(): void {
  if (process.env.PUSH_SCAN_ENABLED !== 'true') return;
  if (!pushEnabled()) {
    console.warn('[ValueBetScan] push not configured — scan not started.');
    return;
  }
  const minutes = Number(process.env.PUSH_SCAN_INTERVAL_MIN) || 30;
  console.log(`[ValueBetScan] Scanning every ${minutes} min for value bets.`);
  timer = setInterval(runScan, minutes * 60 * 1000);
  // Kick off one scan shortly after boot.
  setTimeout(runScan, 15_000);
}
