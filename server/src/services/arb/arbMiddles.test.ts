import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ArbEvent } from './arbScanner';
import {
  findMiddles, fitMarket, marketDists, iceedgeDists, legReturn, probIn, Bucket, Dists,
} from './arbMiddles';
import { finalScoreGrid, totalOver, gridSum } from '../prediction/finalScore';

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, '__fixtures__', 'arb-sample.json'), 'utf8'),
) as { now: string; events: ArbEvent[] };
const NOW = new Date(fixture.now);

const ev = (books: ArbEvent['bookmakers']): ArbEvent => ({
  id: 'e1', commence_time: '2026-10-24T23:00:00Z',
  home_team: 'Toronto Maple Leafs', away_team: 'Boston Bruins', bookmakers: books,
});
/** Loi des totaux uniforme sur 3..8 : P(6) = 1/6. */
const uniformTotals: Bucket[] = [3, 4, 5, 6, 7, 8].map((k) => ({ lo: k, hi: k, p: 1 / 6 }));

describe('legReturn (règlement)', () => {
  it('Over/Under avec et sans push', () => {
    expect(legReturn('over', 5.5, 2, 6)).toBe(2);
    expect(legReturn('over', 5.5, 2, 5)).toBe(0);
    expect(legReturn('over', 6, 2, 6)).toBe(1);   // ligne entière : remboursé
    expect(legReturn('under', 6.5, 2, 6)).toBe(2);
    expect(legReturn('under', 6.5, 2, 7)).toBe(0);
  });
  it('handicaps : domicile −1.5 couvre à +2, visiteur +2.5 couvre jusqu\'à −2', () => {
    expect(legReturn('home', -1.5, 2.5, 2)).toBe(2.5);
    expect(legReturn('home', -1.5, 2.5, 1)).toBe(0);
    expect(legReturn('away', 2.5, 1.4, 2)).toBe(1.4);   // domicile gagne par 2 : le visiteur +2.5 couvre
    expect(legReturn('away', 2.5, 1.4, 3)).toBe(0);
    expect(legReturn('away', 1, 1.9, 1)).toBe(1);       // push
  });
});

describe('findMiddles — cas construits', () => {
  const books = (o: number, u: number) => [
    { key: 'a', title: 'A', markets: [{ key: 'totals', outcomes: [{ name: 'Over', price: o, point: 5.5 }] }] },
    { key: 'b', title: 'B', markets: [{ key: 'alternate_totals', outcomes: [{ name: 'Under', price: u, point: 6.5 }] }] },
  ];

  it('Over 5.5 / Under 6.5 à 2.00 : EV = P(6) × 1000 $, fenêtre « 6 buts »', () => {
    const model = new Map<string, Dists>([['e1', { total: uniformTotals, source: 'test' }]]);
    const [m] = findMiddles([ev(books(2, 2))], { now: NOW, model, maxQuoteAgeSec: 0 });
    expect(m.window).toBe('6 buts');
    expect(m.windowValues).toEqual([6]);
    expect(m.legs.map((l) => l.stakeRounded)).toEqual([500, 500]);
    expect(m.pMiddle).toBeCloseTo(1 / 6, 10);
    expect(m.ev).toBeCloseTo(1000 / 6, 1);
    expect(m.worstCase).toBe(0);
    expect(m.bestCase).toBe(1000);
    expect(m.riskFree).toBe(true);
    expect(m.breakeven).toBe(0);
  });

  it('seuil = Σ − 1 : sous le seuil → pas signalé, au-dessus → signalé', () => {
    // 1.80 / 1.80 : Σ = 1.111 → il faut P(6) > 11.1 %. Uniforme : 16.7 % → signalé.
    const model = new Map<string, Dists>([['e1', { total: uniformTotals, source: 'test' }]]);
    const [m] = findMiddles([ev(books(1.8, 1.8))], { now: NOW, model, maxQuoteAgeSec: 0 });
    expect(m.breakeven).toBeCloseTo(0.1111, 4);
    expect(m.riskFree).toBe(false);
    expect(m.ev).toBeGreaterThan(0);
    // P(6) = 5 % → espérance négative → rien.
    const thin: Bucket[] = [{ lo: 0, hi: 5, p: 0.6 }, { lo: 6, hi: 6, p: 0.05 }, { lo: 7, hi: 99, p: 0.35 }];
    const none = findMiddles([ev(books(1.8, 1.8))], {
      now: NOW, model: new Map([['e1', { total: thin, source: 'test' }]]), maxQuoteAgeSec: 0,
    });
    expect(none).toHaveLength(0);
  });

  it('demi-middle Over 5.5 + Under 6 : à 6 buts, gagné + remboursé, compté dans la fenêtre', () => {
    // Cas réel du 1er scan (Ducks @ Flyers) : affiché « fenêtre vide, P = 0 % » avant la correction.
    const model = new Map([['e1', { total: uniformTotals, source: 'test' }]]);
    const [m] = findMiddles([ev([
      { key: 'a', title: 'A', markets: [{ key: 'totals', outcomes: [{ name: 'Over', price: 1.8, point: 5.5 }] }] },
      { key: 'b', title: 'B', markets: [{ key: 'totals', outcomes: [{ name: 'Under', price: 1.95, point: 6 }] }] },
    ])], { now: NOW, model, maxQuoteAgeSec: 0, minEvPct: -100 });
    expect(m.windowValues).toEqual([6]);
    expect(m.window).toBe('6 buts (Under 6 remboursé)');
    expect(m.pMiddle).toBeCloseTo(1 / 6, 10);
    const [over, under] = m.legs.map((l) => l.stakeRounded);
    // À 6 buts : l'Over paie, l'Under rend sa mise.
    expect(m.bestCase).toBeCloseTo(over * 1.8 + under - (over + under), 2);
    // Seuil : −L̄ / (W̄ − L̄), cohérent avec l'espérance calculée.
    const L = (m.ev - m.pMiddle * m.bestCase) / (1 - m.pMiddle);
    expect(m.breakeven).toBeCloseTo(-L / (m.bestCase - L), 6);
    expect(m.breakeven).toBeGreaterThan(0);
  });

  it('seau ambigu (loi trop grossière pour la ligne) → ignoré', () => {
    const coarse: Bucket[] = [{ lo: 0, hi: 5, p: 0.5 }, { lo: 6, hi: 99, p: 0.5 }];
    const model = new Map([['e1', { total: coarse, source: 'test' }]]);
    expect(findMiddles([ev(books(2, 2))], { now: NOW, model, maxQuoteAgeSec: 0 })).toHaveLength(0);
  });

  it('spread : domicile −1.5 + visiteur +2.5 → fenêtre « gagne par 2 »', () => {
    const margin: Bucket[] = [-3, -2, -1, 1, 2, 3].map((d) => ({ lo: d, hi: d, p: 1 / 6 }));
    const model = new Map([['e1', { margin, source: 'test' }]]);
    const [m] = findMiddles([ev([
      { key: 'a', title: 'A', markets: [{ key: 'spreads', outcomes: [{ name: 'Toronto Maple Leafs', price: 2.6, point: -1.5 }] }] },
      { key: 'b', title: 'B', markets: [{ key: 'alternate_spreads', outcomes: [{ name: 'Boston Bruins', price: 1.45, point: 2.5 }] }] },
    ])], { now: NOW, model, maxQuoteAgeSec: 0 });
    expect(m.kind).toBe('spreads');
    expect(m.windowValues).toEqual([2]);
    expect(m.window).toBe('Toronto Maple Leafs gagne par 2');
  });

  it('lignes identiques (arbitrage classique) et fenêtres inversées ne sont pas des middles', () => {
    const model = new Map([['e1', { total: uniformTotals, source: 'test' }]]);
    const r = findMiddles([ev([
      { key: 'a', markets: [{ key: 'totals', outcomes: [{ name: 'Over', price: 2.1, point: 6.5 }] }] },
      { key: 'b', markets: [{ key: 'totals', outcomes: [{ name: 'Under', price: 2.1, point: 6.5 }, { name: 'Under', price: 3, point: 5.5 }] }] },
    ])], { now: NOW, model, maxQuoteAgeSec: 0 });
    expect(r).toHaveLength(0);
  });
});

describe('loi du marché (finalScoreGrid)', () => {
  it('reproduit le total et la moneyline dé-viggés du consensus', () => {
    const e = fixture.events.find((x) => x.id === 'evt-tor-bos')!;
    const fit = fitMarket(e, NOW)!;
    expect(fit.line).toBe(6.5);
    const g = finalScoreGrid(fit.lambdaT * fit.homeShare, fit.lambdaT * (1 - fit.homeShare), 0.5);
    expect(totalOver(g, 6.5)).toBeCloseTo(fit.pOver!, 3);
    expect(gridSum(g, (h, a) => h > a)).toBeCloseTo(fit.pHome!, 3);
    const d = marketDists(e, NOW)!;
    expect(d.total!.reduce((s, b) => s + b.p, 0)).toBeCloseTo(1, 6);
    expect(probIn(d.margin!, 0, 0)).toBe(0);   // jamais de nul au score final
    const p6 = probIn(d.total!, 6, 6);
    expect(p6).toBeGreaterThan(0.08);
    expect(p6).toBeLessThan(0.2);
  });
});

describe('loi arakiceML (réponse de /predictions/game/:id)', () => {
  const groups = [
    { id: 'moneyline', options: [{ id: 'mw-home', rulePct: 55 }, { id: 'mw-away', rulePct: 45 }] },
    { id: 'totals', options: [
      { id: 'o25', rulePct: 93 }, { id: 'u25', rulePct: 7 }, { id: 'o35', rulePct: 82 },
      { id: 'o45', rulePct: 66 }, { id: 'o55', rulePct: 48 }, { id: 'o65', rulePct: 31 }, { id: 'o75', rulePct: 18 }] },
    { id: 'puckline', options: [
      { id: 'pl-home-m15', rulePct: 36 }, { id: 'pl-home-p15', rulePct: 72 }, { id: 'pl-home-m25', rulePct: 20 },
      { id: 'pl-home-m35', rulePct: 9 }, { id: 'pl-away-m15', rulePct: 28 }, { id: 'pl-away-m25', rulePct: 14 },
      { id: 'pl-away-m35', rulePct: 6 }] },
  ];
  it('les différences donnent P(total = k) et P(écart = d)', () => {
    const d = iceedgeDists(groups)!;
    expect(d.source).toBe('arakiceML');
    expect(probIn(d.total!, 6, 6)).toBeCloseTo(0.17, 6);       // 48 − 31
    expect(probIn(d.total!, 8, 99)).toBeCloseTo(0.18, 6);
    expect(probIn(d.margin!, 2, 2)).toBeCloseTo(0.16, 6);      // 36 − 20
    expect(probIn(d.margin!, 1, 1)).toBeCloseTo(0.19, 6);      // 55 − 36
    expect(probIn(d.margin!, -2, -2)).toBeCloseTo(0.14, 6);
    expect(d.margin!.reduce((s, b) => s + b.p, 0)).toBeCloseTo(1, 6);
  });
  it('réponse incomplète → null', () => {
    expect(iceedgeDists([{ id: 'other', options: [] }])).toBeNull();
    expect(iceedgeDists('pas un tableau')).toBeNull();
  });
});

describe('findMiddles sur la démo (loi du marché)', () => {
  const r = findMiddles(fixture.events, { now: NOW });
  it('trouve Over 5.5 DraftKings + Under 6.5 Pinnacle, fenêtre 6 buts, espérance positive', () => {
    const m = r.find((x) => x.kind === 'totals')!;
    expect(m).toBeDefined();
    expect(m.legs.map((l) => `${l.bookmaker}:${l.side}`)).toEqual(['draftkings:Over 5.5', 'pinnacle:Under 6.5']);
    expect(m.window).toBe('6 buts');
    expect(m.source).toBe('marché');
    expect(m.breakeven).toBeCloseTo(m.impliedSum - 1, 3);   // mises arrondies : à 0.1 pt près
    expect(m.pMiddle).toBeGreaterThan(m.breakeven!);
    expect(m.ev).toBeGreaterThan(0);
    expect(m.riskFree).toBe(false);
    expect(m.warnings[0]).toContain('Pas sans risque');
  });
  it('ignore les matchs commencés et respecte le filtre de livres', () => {
    expect(r.some((x) => x.eventId === 'evt-det-chi')).toBe(false);
    const noDk = findMiddles(fixture.events, { now: NOW, books: ['fanduel', 'pinnacle', 'betmgm'] });
    expect(noDk.some((x) => x.legs.some((l) => l.bookmaker === 'draftkings'))).toBe(false);
  });
  it('le modèle prime sur le marché quand il est fourni, et le marché reste affiché', () => {
    const model = new Map<string, Dists>([['evt-tor-bos', { total: uniformTotals, source: 'arakiceML' }]]);
    const m = findMiddles(fixture.events, { now: NOW, model }).find((x) => x.kind === 'totals')!;
    expect(m.source).toBe('arakiceML');
    expect(m.pMiddle).toBeCloseTo(1 / 6, 6);
    expect(m.pMiddleMarket).toBeGreaterThan(0);
  });
});
