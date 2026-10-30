import { describe, it, expect } from 'vitest';
import { onClockGrid, gridFor, QUARTER_MS, HOUR_MS } from './clockGrid';

const T = (iso: string) => Date.parse(iso);

describe('onClockGrid', () => {
  it('rounds up to the next quarter', () => {
    const now = T('2026-10-30T12:07:00Z');
    expect(now + onClockGrid(15 * 60_000, now)).toBe(T('2026-10-30T12:30:00Z'));
  });
  it('absorbs timer jitter instead of skipping a slot', () => {
    const now = T('2026-10-30T12:00:00Z') + 4;
    expect(now + onClockGrid(HOUR_MS, now, HOUR_MS)).toBe(T('2026-10-30T13:00:00Z'));
  });
  it('keeps an already-aligned target', () => {
    const now = T('2026-10-30T12:00:00Z');
    expect(onClockGrid(30 * 60_000, now)).toBe(30 * 60_000);
  });
  it('never returns less than 1 s', () => {
    const now = T('2026-10-30T12:00:10Z');
    expect(onClockGrid(0, now)).toBeGreaterThanOrEqual(1_000);
  });
  it('gridFor', () => {
    expect(gridFor(90 * 60_000)).toBe(HOUR_MS);
    expect(gridFor(QUARTER_MS)).toBe(QUARTER_MS);
    expect(gridFor(30 * 60_000)).toBe(30 * 60_000);
  });
});
