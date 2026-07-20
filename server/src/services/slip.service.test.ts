import { describe, it, expect } from 'vitest';
import { xpForOutcome } from './slip.service';

// Settlement math is a money path — pin the risk-based XP formula so a refactor
// can't silently change payouts. (Pure function, no DB.)
describe('xpForOutcome', () => {
  it('awards more XP for riskier (lower-probability) wins', () => {
    expect(xpForOutcome('win', 20)).toBeGreaterThan(xpForOutcome('win', 80));
  });

  it('floors a win at +10 XP even for near-certain bets', () => {
    expect(xpForOutcome('win', 99)).toBe(10);
  });

  it('penalises safe losses more, flooring at -5', () => {
    expect(xpForOutcome('loss', 10)).toBe(-5);   // -max(5, round(10/2)) = -5
    expect(xpForOutcome('loss', 80)).toBe(-40);  // -max(5, round(80/2)) = -40
  });

  it('defaults to 50% when probability is null', () => {
    expect(xpForOutcome('win', null)).toBe(100); // round((100-50)*2) = 100
  });

  it('clamps out-of-range probabilities into 1..99', () => {
    expect(xpForOutcome('win', 0)).toBe(xpForOutcome('win', 1));
    expect(xpForOutcome('win', 150)).toBe(xpForOutcome('win', 99));
  });
});
