import { describe, it, expect } from 'vitest';
import { isEndgame, liveRefreshMs, ENDGAME_REFRESH_MS, LIVE_REFRESH_MS } from './liveRefresh';

describe('liveRefresh — rythme du direct', () => {
  it('fin de match = 3e période à 5 min ou moins, ou prolongation', () => {
    expect(isEndgame(3, '05:00')).toBe(true);
    expect(isEndgame(3, '05:01')).toBe(false);
    expect(isEndgame(3, '00:12')).toBe(true);
    expect(isEndgame(2, '01:00')).toBe(false);
    expect(isEndgame(1, '00:30')).toBe(false);
    expect(isEndgame(4, '04:00', 'OT')).toBe(true);
    expect(isEndgame(3, '00:00', 'OT')).toBe(true);
    expect(isEndgame(5, null, 'SO')).toBe(true);
  });

  it('secondes numériques acceptées (contexte en direct)', () => {
    expect(isEndgame(3, 299)).toBe(true);
    expect(isEndgame(3, 301)).toBe(false);
  });

  it('entracte : jamais la fin de match (l\'horloge est celle de la pause)', () => {
    expect(isEndgame(2, '03:00', 'REG', true)).toBe(false);
  });

  it('horloge illisible en 3e : on rafraîchit vite, par prudence', () => {
    expect(isEndgame(3, null)).toBe(true);
    expect(isEndgame(null, '01:00')).toBe(false);
  });

  it('durées', () => {
    expect(liveRefreshMs(3, '02:00')).toBe(ENDGAME_REFRESH_MS);
    expect(liveRefreshMs(2, '02:00')).toBe(LIVE_REFRESH_MS);
    expect(ENDGAME_REFRESH_MS).toBe(10_000);
    expect(LIVE_REFRESH_MS).toBe(30_000);
  });
});
