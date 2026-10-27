import { describe, it, expect } from 'vitest';
import {
  americanToDecimal, decimalToAmerican, formatAmerican, parseAmerican,
  parlayTax, taxHeadline, gradeReply, gradeComplianceProblems, DISCLAIMER_FR,
} from './parlayTax';
import { DISCLAIMER } from './parlayPosts';

/** Taxe d'un combiné — semaine 1 du plan « The Parlay Tax Engine ». */

describe('conversions de cotes', () => {
  it('américaine → décimale', () => {
    expect(americanToDecimal(600)).toBe(7);
    expect(americanToDecimal(100)).toBe(2);
    expect(americanToDecimal(-200)).toBe(1.5);
    expect(americanToDecimal(-130)).toBeCloseTo(1.7692, 4);
  });
  it('décimale → américaine', () => {
    expect(decimalToAmerican(7)).toBe(600);
    expect(decimalToAmerican(2)).toBe(100);
    expect(decimalToAmerican(1.5)).toBe(-200);
  });
  it('refuse une cote hors format', () => {
    expect(() => americanToDecimal(50)).toThrow();
    expect(() => decimalToAmerican(1)).toThrow();
  });
  it('lit les cotes telles que sur les tickets', () => {
    expect(parseAmerican('+600')).toBe(600);
    expect(parseAmerican('600')).toBe(600);
    expect(parseAmerican('-130')).toBe(-130);
    expect(parseAmerican('−130')).toBe(-130); // signe moins Unicode (DraftKings)
    expect(() => parseAmerican('abc')).toThrow();
    expect(() => parseAmerican('+50')).toThrow();
  });
  it('affiche le signe', () => {
    expect(formatAmerican(852)).toBe('+852');
    expect(formatAmerican(-130)).toBe('−130');
  });
});

describe('parlayTax', () => {
  it('chiffre l’exemple du plan : 10,5 % payé +600', () => {
    const t = parlayTax(10.5, 600);
    expect(t.fairAmerican).toBe(852);
    expect(t.expectedReturn).toBeCloseTo(0.735, 6);
    expect(t.taxPct).toBe(26.5);
    expect(t.bookImpliedPct).toBe(14.3);
    expect(t.verdict).toBe('tax');
    expect(taxHeadline(t)).toBe('27% parlay tax');
  });
  it('un prix au-dessus du juste prix = valeur, taxe négative', () => {
    const t = parlayTax(20, 500); // juste +400, payé +500
    expect(t.taxPct).toBe(-20);
    expect(t.verdict).toBe('value');
    expect(taxHeadline(t)).toBe('Pays 20% over fair');
  });
  it('±1 point = au juste prix (sous la précision du modèle)', () => {
    expect(parlayTax(50, 100).verdict).toBe('fair');
    expect(parlayTax(50.4, 100).verdict).toBe('fair');
  });
  it('refuse une probabilité impossible', () => {
    expect(() => parlayTax(0, 600)).toThrow();
    expect(() => parlayTax(100, 600)).toThrow();
    expect(() => parlayTax(NaN, 600)).toThrow();
  });
});

describe('réponse sous le post', () => {
  it('≤ 280 caractères, mention 18+, aucun lien, aucun bookmaker', () => {
    const r = gradeReply({ tax: parlayTax(10.5, 600), weakestLeg: 'Over 6.5' });
    expect(r.length).toBeLessThanOrEqual(280);
    expect(r).toContain(DISCLAIMER);
    expect(r).toContain('Weakest leg: Over 6.5.');
    expect(gradeComplianceProblems([r])).toEqual([]);
  });
  it('la jambe faible saute d’abord si le texte est trop long', () => {
    const r = gradeReply({ tax: parlayTax(10.5, 600), weakestLeg: 'x'.repeat(200) });
    expect(r.length).toBeLessThanOrEqual(280);
    expect(r).not.toContain('Weakest leg');
  });
  it('signale bookmaker, promesse et lien', () => {
    const p = gradeComplianceProblems(['Lock of the night on DraftKings https://x.co']);
    expect(p.length).toBe(3);
  });
});

describe('version française', () => {
  it('titre et réponse en français, ≤ 280 caractères, mention 18+ française', () => {
    const t = parlayTax(10.5, 600);
    expect(taxHeadline(t, 'fr')).toBe('Taxe de 27\u00a0% sur le combiné');
    expect(taxHeadline(parlayTax(20, 500), 'fr')).toBe('Paie 20\u00a0% de plus que le juste prix');
    const r = gradeReply({ tax: t, weakestLeg: 'Plus de 6.5 buts', lang: 'fr' });
    expect(r.length).toBeLessThanOrEqual(280);
    expect(r).toContain('Cote juste +852 contre +600 payé');
    expect(r).toContain('10,5\u00a0%');
    expect(r).toContain('Maillon faible : Plus de 6.5 buts.');
    expect(r).toContain(DISCLAIMER_FR);
    expect(gradeComplianceProblems([r])).toEqual([]);
  });
  it('bloque les promesses en français', () => {
    expect(gradeComplianceProblems(['Pari garanti ce soir']).length).toBe(1);
    expect(gradeComplianceProblems(['Garantie sur facture']).length).toBe(1);
  });
});
