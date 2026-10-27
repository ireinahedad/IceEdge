import { describe, it, expect } from 'vitest';
import { priceVerdict, formatOdds, ticketModelPct, ticketPaidDecimal, weakestLeg } from './slipScanValue';

/** SCAN_TICKET_PLAN § 5 (S4) — prix payé face au modèle, même définition que les cartes « Parlay Tax ». */

describe('priceVerdict', () => {
  it('même chiffre que la carte « Parlay Tax » : 10,5 % payé +600 → juste +852, taxe 26,5 %', () => {
    const v = priceVerdict(10.5, '+600')!;
    expect(v.fairOdds).toBe('+852');
    expect(v.taxPct).toBe(26.5);
    expect(v.impliedPct).toBe(14.3);
    expect(v.verdict).toBe('tax');
  });
  it('cote décimale (bet365) : juste prix affiché en décimal', () => {
    const v = priceVerdict(40, '1.83')!;
    expect(v.fairOdds).toBe('2.50');
    expect(v.taxPct).toBe(26.8);
  });
  it('signe moins Unicode et prix au-dessus du juste prix', () => {
    const v = priceVerdict(60, '−130')!;  // juste −150, payé −130
    expect(v.fairOdds).toBe('-150');
    expect(v.verdict).toBe('value');
    expect(v.taxPct).toBeLessThan(0);
  });
  it('±1 point = au juste prix', () => {
    expect(priceVerdict(50, '2.00')!.verdict).toBe('fair');
  });
  it('illisible ou impossible → null', () => {
    expect(priceVerdict(0, '+600')).toBeNull();
    expect(priceVerdict(100, '+600')).toBeNull();
    expect(priceVerdict(50, 'abc')).toBeNull();
    expect(priceVerdict(50, '+50')).toBeNull();
  });
});

describe('formatOdds', () => {
  it('américain et décimal', () => {
    expect(formatOdds(2.95, 'american')).toBe('+195');
    expect(formatOdds(1.5, 'american')).toBe('-200');
    expect(formatOdds(2.5, 'decimal')).toBe('2.50');
    expect(formatOdds(2.5, null)).toBe('2.50');
  });
});

describe('ticket', () => {
  it('produit des groupes de matchs différents', () => {
    expect(ticketModelPct([{ pct: 50, gameId: 'a' }, { pct: 40, gameId: 'b' }])).toBe(20);
  });
  it('groupe manquant ou deux groupes du même match → pas de chiffre', () => {
    expect(ticketModelPct([{ pct: 50, gameId: 'a' }, { pct: null, gameId: 'b' }])).toBeNull();
    expect(ticketModelPct([{ pct: 50, gameId: 'a' }, { pct: 40, gameId: 'a' }])).toBeNull();
    expect(ticketModelPct([])).toBeNull();
  });
  it('cote payée : la totale affichée, sinon le produit des groupes', () => {
    expect(ticketPaidDecimal('+195', [null, null, null])).toBeCloseTo(2.95, 6);
    expect(ticketPaidDecimal(null, ['1.83', '1.36'])).toBeCloseTo(2.4888, 4);
    expect(ticketPaidDecimal(null, ['1.83', null])).toBeNull();
  });
});

describe('weakestLeg', () => {
  it('la jambe la moins probable, seulement à partir de 2 jambes chiffrées', () => {
    expect(weakestLeg([{ key: 'a', pct: 70 }, { key: 'b', pct: 45 }, { key: 'c', pct: null }])).toBe('b');
    expect(weakestLeg([{ key: 'a', pct: 70 }, { key: 'c', pct: null }])).toBeNull();
  });
});
