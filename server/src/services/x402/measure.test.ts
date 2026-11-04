import { describe, it, expect } from 'vitest';
import { analyze, classify, etDay, type Payment } from './measure';

const H = 3_600_000, D = 24 * H;
const NOW = Date.parse('2026-12-31T12:00:00Z'); // jeudi
const p = (from: string, timeMs: number, usd = 0.1, x402 = true): Payment =>
  ({ tx: `0x${Math.round(timeMs).toString(16)}${from.slice(2, 6)}`, block: 1, timeMs, from, amount: BigInt(Math.round(usd * 1e6)), x402 });

describe('classify', () => {
  it('une fois / contrôleur (un seul jour ou rythme fixe) / revient', () => {
    expect(classify([NOW]).kind).toBe('single');
    expect(classify([NOW, NOW + H, NOW + 2 * H]).kind).toBe('checker');                    // même jour
    expect(classify(Array.from({ length: 10 }, (_, i) => NOW - i * D)).kind).toBe('checker'); // chaque jour à la même heure
    // jours entiers distincts, heures variées de 0 à 6 h avant 07:00 ET : même jour ET
    const at = (days: number[]) => days.map((d, i) => NOW - d * D - ((i * 5) % 7) * H);
    const irregular = at([0, 1, 2, 5, 6, 9]);
    const c = classify(irregular);
    expect(c.kind).toBe('returning');
    expect(c.activeDays).toBe(6);
    expect(c.intervalCv).toBeGreaterThan(0.15);
  });

  it('jours comptés à l\'heure de l\'Est (un match du soir reste le même jour)', () => {
    expect(etDay(Date.parse('2026-11-05T03:30:00Z'))).toBe('2026-11-04');
  });
});

describe('analyze', () => {
  const OWN = '0xaaaa000000000000000000000000000000000001';
  const BOT = '0xbbbb000000000000000000000000000000000002';
  const REAL = '0xcccc000000000000000000000000000000000003';

  it('aucun payeur extérieur → couper les routes payantes ; Ireina et les virements non x402 exclus', () => {
    const r = analyze([p(OWN, NOW - D), p(OWN, NOW - 2 * D), p(REAL, NOW - D, 5, false)], { exclude: [OWN.toUpperCase()], nowMs: NOW });
    expect(r.verdict).toBe('cut_paid_routes_keep_record');
    expect(r.excluded).toEqual({ payments: 2, usd: 0.2 });
    expect(r.nonX402Transfers).toHaveLength(1);
    expect(r.totals.payers).toBe(0);
  });

  it('seulement un contrôleur à rythme fixe → laisser tourner, revoir dans 6 mois', () => {
    const pays = Array.from({ length: 20 }, (_, i) => p(BOT, NOW - i * D));
    const r = analyze(pays, { exclude: [OWN], nowMs: NOW });
    expect(r.payers[0].kind).toBe('checker');
    expect(r.verdict).toBe('keep_running_review_in_6_months');
  });

  it('un payeur qui revient sur ≥ 10 jours de match → continuer', () => {
    const days = [0, 1, 3, 4, 6, 8, 9, 12, 14, 16, 19].map((d, i) => NOW - d * D - ((i * 5) % 7) * H);
    const r = analyze(days.map((t) => p(REAL, t)), { exclude: [OWN], nowMs: NOW });
    expect(r.payers[0]).toMatchObject({ kind: 'returning', payments: 11 });
    expect(r.payers[0].activeDays).toBeGreaterThanOrEqual(10);
    expect(r.verdict).toBe('continue');
  });

  it('≥ 10 $/semaine sur les 4 dernières semaines complètes → continuer ; la semaine en cours ne compte pas', () => {
    const lastWeeks = Array.from({ length: 28 }, (_, i) => p(`0x${(i % 7).toString().padStart(40, 'd')}`, NOW - (4 + i) * D, 1.5));
    const thisWeek = [p(REAL, NOW - H, 1000)];
    const r = analyze([...lastWeeks, ...thisWeek], { exclude: [], nowMs: NOW });
    expect(r.weeks).toHaveLength(4);
    expect(r.avgWeekUsd).toBeGreaterThanOrEqual(10);
    expect(r.weeks.reduce((a, w) => a + w.usd, 0)).toBeLessThan(1000);
    expect(r.verdict).toBe('continue');
  });
});
