import { describe, it, expect } from 'vitest';
import { americanToDecimal, decimalToAmerican, fmtAmerican, parseOdds, hedge } from './arbCalc';

describe('cotes américaines ↔ décimales', () => {
  it('convertit dans les deux sens', () => {
    expect(americanToDecimal(108)).toBeCloseTo(2.08, 10);
    expect(americanToDecimal(-110)).toBeCloseTo(1.9091, 4);
    expect(americanToDecimal(-100)).toBe(2);
    expect(decimalToAmerican(2.08)).toBe(108);
    expect(decimalToAmerican(1.95)).toBe(-105);
    expect(decimalToAmerican(2)).toBe(100);
    expect(fmtAmerican(2.5)).toBe('+150');
    expect(fmtAmerican(1.5)).toBe('-200');
  });

  it('refuse une cote américaine entre −100 et +100', () => {
    expect(() => americanToDecimal(50)).toThrow();
    expect(() => americanToDecimal(-99)).toThrow();
  });
});

describe('parseOdds (saisie à la main)', () => {
  it('reconnaît décimal, virgule, américain signé et ≥ 100 sans signe', () => {
    expect(parseOdds('2.08')).toBe(2.08);
    expect(parseOdds('2,08')).toBe(2.08);
    expect(parseOdds('+108')).toBeCloseTo(2.08, 10);
    expect(parseOdds('-110')).toBeCloseTo(1.9091, 4);
    expect(parseOdds('150')).toBe(2.5);
  });

  it('refuse le reste', () => {
    for (const bad of ['abc', '1', '0.5', '-50', '', '2.0.1']) {
      expect(() => parseOdds(bad)).toThrow();
    }
  });
});

describe('hedge (1er pari déjà placé)', () => {
  it('la cote a baissé mais l\'arbitrage tient : petit profit', () => {
    // 490 $ placés à 2.08 → paie 1019.20 $. L'Under est passé de 2.00 à 1.95.
    const h = hedge(490, 2.08, [1.95], 1);
    expect(h.stakes[0]).toBeCloseTo(522.67, 2);
    expect(h.result).toBeCloseTo(6.53, 2);
    expect(h.stakesRounded[0] % 1).toBe(0);
    expect(h.resultRounded).toBeGreaterThan(0);
  });

  it('la cote s\'est effondrée : perte garantie, chiffrée', () => {
    const h = hedge(490, 2.08, [1.8], 1);
    expect(h.result).toBeLessThan(0);
    expect(h.result).toBeCloseTo(1019.2 - 490 - 1019.2 / 1.8, 2);
  });

  it('3 issues : couvre les deux restantes au même paiement', () => {
    const h = hedge(434, 2.35, [4.6, 2.95], 0);
    expect(h.stakes[0] * 4.6).toBeCloseTo(434 * 2.35, 1);
    expect(h.stakes[1] * 2.95).toBeCloseTo(434 * 2.35, 1);
  });

  it('refuse les entrées invalides', () => {
    expect(() => hedge(0, 2, [2])).toThrow();
    expect(() => hedge(100, 2, [])).toThrow();
    expect(() => hedge(100, 2, [1])).toThrow();
  });
});
