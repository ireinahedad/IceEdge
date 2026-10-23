import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  findArbs, impliedSum, profitPct, arbStakes, roundStakes, bestRoundedStakes, worstCaseProfit, ArbEvent,
} from './arbScanner';

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, '__fixtures__', 'arb-sample.json'), 'utf8'),
) as { now: string; events: ArbEvent[] };
const NOW = new Date(fixture.now);

const ev = (over: Partial<ArbEvent>): ArbEvent => ({
  id: 'e1', commence_time: '2026-10-24T23:00:00Z',
  home_team: 'Toronto Maple Leafs', away_team: 'Boston Bruins', bookmakers: [], ...over,
});

describe('calcul', () => {
  it('Over 2.08 / Under 2.00 → ≈ +1.96 % et paiements égaux', () => {
    const prices = [2.08, 2.0];
    expect(impliedSum(prices)).toBeCloseTo(0.98077, 4);
    expect(profitPct(prices)).toBeCloseTo(1.96, 2);
    const stakes = arbStakes(prices, 1000);
    expect(stakes[0]).toBeCloseTo(490.2, 1);
    expect(stakes[1]).toBeCloseTo(509.8, 1);
    expect(stakes[0] * 2.08).toBeCloseTo(stakes[1] * 2.0, 6);
    expect(worstCaseProfit(stakes, prices)).toBeCloseTo(19.61, 2);
  });

  it('arrondi au pas demandé, jamais à 0', () => {
    expect(roundStakes([490.2, 509.8], 5)).toEqual([490, 510]);
    expect(roundStakes([1.2], 5)).toEqual([5]);
  });

  it('meilleur arrondi : garde un profit là où l\'arrondi naïf le perd', () => {
    // 3-way de la démo, bankroll 300, pas de 5 $ : l'arrondi au plus proche
    // donne une perte de 1 $.
    const prices = [2.35, 4.6, 2.95];
    const stakes = arbStakes(prices, 300);
    expect(worstCaseProfit(roundStakes(stakes, 5), prices)).toBeLessThan(0);
    const best = bestRoundedStakes(stakes, prices, 5);
    best.forEach((s) => expect(s % 5).toBe(0));
    expect(worstCaseProfit(best, prices)).toBeGreaterThan(0);
  });
});

describe('findArbs sur les données démo', () => {
  const { opportunities, stats } = findArbs(fixture.events, { now: NOW });
  const find = (market: string, eventId: string) =>
    opportunities.find((o) => o.market === market && o.eventId === eventId);

  it('trouve le total 6.5 : Over FanDuel ↔ Under Pinnacle', () => {
    const o = find('totals', 'evt-tor-bos');
    expect(o).toBeDefined();
    expect(o!.line).toBe(6.5);
    expect(o!.profitPct).toBeCloseTo(1.96, 2);
    const over = o!.legs.find((l) => l.side.startsWith('Over'))!;
    const under = o!.legs.find((l) => l.side.startsWith('Under'))!;
    expect([over.bookmaker, over.price]).toEqual(['fanduel', 2.08]);
    expect([under.bookmaker, under.price]).toEqual(['pinnacle', 2.0]);
    expect(o!.legs.reduce((s, l) => s + l.stake, 0)).toBeCloseTo(1000, 1);
    expect(o!.pushPossible).toBe(false);
  });

  it('3-way : prend la meilleure cote des 3 issues chez 3 livres', () => {
    const o = find('h2h_3_way', 'evt-tor-bos')!;
    expect(o.legs).toHaveLength(3);
    expect(new Set(o.legs.map((l) => l.bookmaker))).toEqual(new Set(['pinnacle', 'fanduel', 'draftkings']));
    expect(o.profitPct).toBeCloseTo(1.84, 2);
  });

  it('prop joueur appariée par joueur + ligne', () => {
    const o = find('player_shots_on_goal', 'evt-tor-bos')!;
    expect(o.subject).toBe('Auston Matthews');
    expect(o.profitPct).toBeCloseTo(2.26, 2);
  });

  it('ligne entière → pushPossible', () => {
    const o = find('totals', 'evt-mtl-edm')!;
    expect(o.line).toBe(6);
    expect(o.pushPossible).toBe(true);
  });

  it('cote anormale → suspect, en tête de liste', () => {
    expect(opportunities[0].eventId).toBe('evt-sea-vgk');
    expect(opportunities[0].suspect).toBe(true);
  });

  it('ignore : match commencé, cote périmée, ligne en quart, profit sous le seuil', () => {
    expect(opportunities.some((o) => o.eventId === 'evt-det-chi')).toBe(false);
    expect(stats.eventsSkippedTime).toBe(1);
    // BET99 (2 h) aurait créé un faux +6 % sur le h2h Montréal–Edmonton.
    expect(stats.quotesSkippedStale).toBe(2);
    expect(stats.quotesSkippedQuarterLine).toBe(2);
    expect(find('h2h', 'evt-mtl-edm')).toBeUndefined();  // +0.19 % < 0.5 %
    expect(opportunities).toHaveLength(5);
  });

  it('seuil à 0 → le petit arbitrage Montréal–Edmonton apparaît', () => {
    const r = findArbs(fixture.events, { now: NOW, minProfitPct: 0 });
    const o = r.opportunities.find((x) => x.market === 'h2h' && x.eventId === 'evt-mtl-edm')!;
    expect(o.profitPct).toBeCloseTo(0.19, 2);
  });

  it('filtre de livres : sans Pinnacle, le total 6.5 n\'est plus un arbitrage', () => {
    const r = findArbs(fixture.events, { now: NOW, books: ['draftkings', 'fanduel', 'betmgm'] });
    expect(r.opportunities.some((o) => o.market === 'totals' && o.eventId === 'evt-tor-bos')).toBe(false);
  });

  it('nearest : marchés non signalés, du plus proche au moins proche', () => {
    expect(stats.nearest.length).toBeGreaterThan(0);
    expect(stats.nearest.length).toBeLessThanOrEqual(5);
    // Le h2h Montréal–Edmonton (+0.19 %, sous le seuil) est le plus proche.
    expect(stats.nearest[0].label).toContain('Montréal Canadiens · h2h');
    expect(stats.nearest[0].gapPct).toBeLessThan(0);
    // Puis le spread −1.5 Toronto–Boston (Σ ≈ 1.0006).
    expect(stats.nearest[1].label).toContain('spreads');
    expect(stats.nearest[1].impliedSum).toBeCloseTo(1.0006, 4);
    for (let i = 1; i < stats.nearest.length; i++) {
      expect(stats.nearest[i].impliedSum).toBeGreaterThanOrEqual(stats.nearest[i - 1].impliedSum);
    }
    // Aucun arbitrage signalé ne figure dans la liste.
    expect(stats.nearest.some((n) => n.label.includes('Seattle'))).toBe(false);
    expect(findArbs(fixture.events, { now: NOW, nearCount: 1 }).stats.nearest).toHaveLength(1);
  });

  it('le spread −1.5 / +1.5 est comparé (proche mais pas arbitrage)', () => {
    expect(find('spreads', 'evt-tor-bos')).toBeUndefined();
    const r = findArbs(fixture.events, { now: NOW, minProfitPct: -5 });
    const s = r.opportunities.find((o) => o.market === 'spreads');
    expect(s).toBeUndefined(); // Σ ≥ 1 → jamais signalé, même avec un seuil négatif
  });
});

describe('appariement', () => {
  it('spread : Domicile −1.5 s\'apparie avec Visiteur +1.5, pas avec Visiteur −1.5', () => {
    const events = [ev({
      bookmakers: [
        { key: 'a', markets: [{ key: 'spreads', outcomes: [
          { name: 'Toronto Maple Leafs', price: 3.0, point: -1.5 },
          { name: 'Boston Bruins', price: 1.3, point: 1.5 }] }] },
        { key: 'b', markets: [{ key: 'spreads', outcomes: [
          { name: 'Toronto Maple Leafs', price: 1.3, point: 1.5 },
          { name: 'Boston Bruins', price: 1.6, point: -1.5 }] }] },
        { key: 'c', markets: [{ key: 'spreads', outcomes: [
          { name: 'Toronto Maple Leafs', price: 2.2, point: -1.5 },
          { name: 'Boston Bruins', price: 1.6, point: 1.5 }] }] },
      ],
    })];
    const { opportunities } = findArbs(events, { now: NOW, maxQuoteAgeSec: 0 });
    expect(opportunities).toHaveLength(1);
    const o = opportunities[0];
    expect(o.line).toBe(-1.5);
    expect(o.legs.map((l) => `${l.bookmaker}:${l.side}`).sort())
      .toEqual(['a:Toronto Maple Leafs -1.5', 'c:Boston Bruins +1.5']);
  });

  it('h2h avec un « Draw » chez un livre → groupe à 3 issues ignoré (pas de faux 2-way)', () => {
    const events = [ev({
      bookmakers: [
        { key: 'a', markets: [{ key: 'h2h', outcomes: [
          { name: 'Toronto Maple Leafs', price: 2.5 }, { name: 'Boston Bruins', price: 2.5 }] }] },
        { key: 'b', markets: [{ key: 'h2h', outcomes: [
          { name: 'Toronto Maple Leafs', price: 2.6 }, { name: 'Draw', price: 4.0 },
          { name: 'Boston Bruins', price: 2.6 }] }] },
      ],
    })];
    const { opportunities, stats } = findArbs(events, { now: NOW, maxQuoteAgeSec: 0 });
    expect(opportunities).toHaveLength(0);
    expect(stats.groupsCompared).toBe(0);
  });

  it('3-way incomplet (pas de nul) → ignoré', () => {
    const events = [ev({
      bookmakers: [{ key: 'a', markets: [{ key: 'h2h_3_way', outcomes: [
        { name: 'Toronto Maple Leafs', price: 5 }, { name: 'Boston Bruins', price: 5 }] }] }],
    })];
    expect(findArbs(events, { now: NOW, maxQuoteAgeSec: 0 }).opportunities).toHaveLength(0);
  });

  it('team_totals : appariés par équipe, jamais entre équipes', () => {
    const events = [ev({
      bookmakers: [
        { key: 'a', markets: [{ key: 'team_totals', outcomes: [
          { name: 'Over', description: 'Toronto Maple Leafs', price: 2.2, point: 3.5 },
          { name: 'Under', description: 'Boston Bruins', price: 2.2, point: 3.5 }] }] },
        { key: 'b', markets: [{ key: 'team_totals', outcomes: [
          { name: 'Under', description: 'Toronto Maple Leafs', price: 1.95, point: 3.5 }] }] },
      ],
    })];
    const { opportunities } = findArbs(events, { now: NOW, maxQuoteAgeSec: 0 });
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].subject).toBe('Toronto Maple Leafs');
  });

  it('même livre des deux côtés → avertissement', () => {
    const events = [ev({
      bookmakers: [{ key: 'a', markets: [{ key: 'totals', outcomes: [
        { name: 'Over', price: 2.1, point: 5.5 }, { name: 'Under', price: 2.1, point: 5.5 }] }] }],
    })];
    const o = findArbs(events, { now: NOW, maxQuoteAgeSec: 0 }).opportunities[0];
    expect(o.warnings.some((w) => w.includes('même livre'))).toBe(true);
  });

  it('ignore les cotes invalides (≤ 1, NaN)', () => {
    const events = [ev({
      bookmakers: [
        { key: 'a', markets: [{ key: 'totals', outcomes: [
          { name: 'Over', price: 1, point: 5.5 }, { name: 'Under', price: Number.NaN, point: 5.5 }] }] },
      ],
    })];
    expect(findArbs(events, { now: NOW, maxQuoteAgeSec: 0 }).stats.groupsCompared).toBe(0);
  });
});
