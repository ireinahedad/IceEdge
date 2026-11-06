// node --test examples/*.test.mjs
// Fixtures follow the documented shapes (Kalshi trade-api v2 markets, Polymarket Gamma events);
// field names are the ones the docs give, values are made up, except the "live shape" test
// (timings and fields as returned by the live API on 2026-11-05).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEAMS, teamFromText, teamFromKalshiTicker, kalshiPrice, polymarketPrices, matchKalshi, matchPolymarket, row } from './compare-markets.mjs';

const game = { gameId: '2026020236', home: 'TOR', away: 'UTA', startTimeUTC: '2026-11-04T00:00:00.000Z', probabilities: { homeWin: 0.41944 } };

test('32 teams, and team names resolve from city, nickname, full name or code', () => {
  assert.equal(Object.keys(TEAMS).length, 32);
  for (const [txt, abbr] of [['Toronto', 'TOR'], ['Maple Leafs', 'TOR'], ['Toronto Maple Leafs', 'TOR'], ['Utah Mammoth', 'UTA'],
    ['Montréal Canadiens', 'MTL'], ['St. Louis Blues', 'STL'], ['St Louis', 'STL'], ['New York Rangers', 'NYR'], ['Islanders', 'NYI'],
    ['New York R', 'NYR'], ['LA', 'LAK'], ['Los Angeles', 'LAK'], ['Vegas Golden Knights', 'VGK'], ['TB', 'TBL'], ['Columbus', 'CBJ']]) {
    assert.equal(teamFromText(txt), abbr, txt);
  }
  assert.equal(teamFromText('New York'), null); // ambiguous
  assert.equal(teamFromText(''), null);
  assert.equal(teamFromKalshiTicker('KXNHLGAME-26NOV04UTATOR-TOR'), 'TOR');
  assert.equal(teamFromKalshiTicker('KXNHLGAME-26NOV04LAVEG-VEG'), 'VGK');
});

test('kalshiPrice: dollar fields first, cents as fallback, last trade if no two-sided quote', () => {
  assert.deepEqual(kalshiPrice({ yes_bid_dollars: '0.4000', yes_ask_dollars: '0.4400' }), { price: 0.42, how: 'mid' });
  assert.deepEqual(kalshiPrice({ yes_bid: 40, yes_ask: 44 }), { price: 0.42, how: 'mid' });
  assert.deepEqual(kalshiPrice({ yes_bid_dollars: '0', yes_ask_dollars: '0.4400', last_price_dollars: '0.4300' }), { price: 0.43, how: 'last' });
  assert.equal(kalshiPrice({}), null);
});

const kalshi = (team, bid, ask, close = '2026-11-04T03:00:00Z', event = 'KXNHLGAME-26NOV03UTATOR') =>
  ({ ticker: `${event}-${team}`, event_ticker: event, yes_sub_title: TEAMS[team][0], yes_bid_dollars: bid, yes_ask_dollars: ask, close_time: close });

test('matchKalshi pairs the two team markets of the right event', () => {
  const markets = [
    kalshi('TOR', '0.4500', '0.4700'), kalshi('UTA', '0.5300', '0.5500'),
    kalshi('TOR', '0.6000', '0.6200', '2026-11-08T03:00:00Z', 'KXNHLGAME-26NOV07BOSTOR'), // another TOR game, later
    kalshi('BOS', '0.3800', '0.4000', '2026-11-08T03:00:00Z', 'KXNHLGAME-26NOV07BOSTOR'),
  ];
  const q = matchKalshi(game, markets);
  assert.equal(q.ref, 'KXNHLGAME-26NOV03UTATOR');
  assert.equal(q.home, 0.46);
  assert.equal(q.away, 0.54);
  assert.equal(matchKalshi(game, markets.slice(2)), null);
});

test('matchKalshi on the live shape (2026-11-05): end = puck drop + 3 h, close = puck drop + 48 h', () => {
  // Field layout and timings copied from the live API on 2026-11-05 (KXNHLGAME-26NOV05UTAMTL).
  const live = (team, bid, ask) => ({
    ticker: `KXNHLGAME-26NOV05UTAMTL-${team}`, event_ticker: 'KXNHLGAME-26NOV05UTAMTL', yes_sub_title: TEAMS[team][0],
    occurrence_datetime: '2026-11-06T03:00:00Z', expected_expiration_time: '2026-11-06T03:00:00Z', close_time: '2026-11-08T00:00:00Z',
    yes_bid_dollars: bid, yes_ask_dollars: ask, last_price_dollars: '0.4800', status: 'active',
  });
  const markets = [live('MTL', '0.4700', '0.4800'), live('UTA', '0.5200', '0.5300')];
  const mtl = { home: 'MTL', away: 'UTA', startTimeUTC: '2026-11-06T00:00:00Z', probabilities: { homeWin: 0.5 } };
  assert.equal(matchKalshi(mtl, markets).home, 0.475);
  // A start time a few minutes earlier used to fall outside the old 48 h close window: it must still match.
  assert.equal(matchKalshi({ ...mtl, startTimeUTC: '2026-11-05T23:55:00Z' }, markets).home, 0.475);
  // The same two teams two days later is another game.
  assert.equal(matchKalshi({ ...mtl, startTimeUTC: '2026-11-08T00:00:00Z' }, markets), null);
});

const poly = (outcomes, prices, extra = {}) => ({
  slug: 'nhl-uta-tor-2026-11-03', startTime: '2026-11-04T00:00:00Z',
  markets: [{ outcomes: JSON.stringify(outcomes), outcomePrices: JSON.stringify(prices), sportsMarketType: 'moneyline', closed: false, ...extra }],
});

test('polymarketPrices / matchPolymarket: moneyline only, both teams, near puck drop', () => {
  assert.deepEqual(polymarketPrices(poly(['Mammoth', 'Maple Leafs'], ['0.55', '0.46']).markets[0]), { UTA: 0.55, TOR: 0.46 });
  assert.equal(polymarketPrices(poly(['Mammoth', 'Maple Leafs'], ['0.55', '0.46'], { sportsMarketType: 'spreads' }).markets[0]), null);
  assert.equal(polymarketPrices(poly(['Over', 'Under'], ['0.5', '0.5']).markets[0]), null);
  const q = matchPolymarket(game, [poly(['Utah Mammoth', 'Toronto Maple Leafs'], ['0.55', '0.46'])]);
  assert.deepEqual([q.home, q.away, q.ref], [0.46, 0.55, 'nhl-uta-tor-2026-11-03']);
  const wrongDay = { ...poly(['Mammoth', 'Maple Leafs'], ['0.5', '0.5']), startTime: '2026-11-06T00:00:00Z' };
  assert.equal(matchPolymarket(game, [wrongDay]), null);
  const gst = poly(['Mammoth', 'Maple Leafs'], ['0.5', '0.5'], { gameStartTime: '2026-11-04 00:00:00+00' });
  assert.equal(matchPolymarket(game, [{ ...gst, startTime: null }]).home, 0.5);
});

test('row: gap = model − market, plus the two-sided sum', () => {
  const r = row(game, { venue: 'Kalshi', ref: 'x', home: 0.46, away: 0.56 });
  assert.equal(r.gap, Math.round((0.41944 - 0.46) * 1e4) / 1e4);
  assert.equal(r.marketSum, 1.02);
  assert.equal(row(game, null).gap, null);
});
