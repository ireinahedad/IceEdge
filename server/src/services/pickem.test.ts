import { describe, it, expect } from 'vitest';
import { pickemLocked, pickemState, PICKEM_MIN_VOTES, GAME_ID_RE, TEAM_RE } from './pickem';

const T = (iso: string) => Date.parse(iso);
const game = (over: Record<string, unknown> = {}): any => ({
  home: 'STL', away: 'VGK', startMs: T('2026-10-24T00:00:00Z'), status: 'scheduled', ...over,
});

describe('pickemLocked — fermeture à la mise au jeu prévue', () => {
  it('ouvert avant, fermé à l’heure pile et après', () => {
    expect(pickemLocked(game(), T('2026-10-23T23:59:59Z'))).toBe(false);
    expect(pickemLocked(game(), T('2026-10-24T00:00:00Z'))).toBe(true);
  });
  it('live / final : fermé même si l’heure prévue est future (match avancé)', () => {
    expect(pickemLocked(game({ status: 'live' }), T('2026-10-23T20:00:00Z'))).toBe(true);
    expect(pickemLocked(game({ status: 'FINAL' }), T('2026-10-23T20:00:00Z'))).toBe(true);
  });
  it('heure inconnue : fermé (jamais de vote après coup)', () => {
    expect(pickemLocked(game({ startMs: NaN }), T('2026-10-23T20:00:00Z'))).toBe(true);
  });
});

describe('pickemState', () => {
  const now = T('2026-10-23T20:00:00Z');
  it('sous le minimum : nombres réels, pas de pourcentage', () => {
    const s = pickemState('2026020123', game(), { STL: 3, VGK: 6 }, null, now);
    expect(s).toMatchObject({ total: 9, enough: false, minVotes: PICKEM_MIN_VOTES, locked: false, myVote: null });
    expect(s.home).toEqual({ team: 'STL', votes: 3, pct: null });
    expect(s.away).toEqual({ team: 'VGK', votes: 6, pct: null });
    expect(s.startsAt).toBe('2026-10-24T00:00:00.000Z');
  });
  it('au minimum : pourcentages arrondis qui somment à 100', () => {
    const s = pickemState('1', game(), { STL: 1, VGK: 2, BOS: 50 }, 'VGK', now, 3);
    expect(s.total).toBe(3); // BOS n'est pas dans le match : ignoré
    expect([s.home.pct, s.away.pct]).toEqual([33, 67]);
    expect(s.myVote).toBe('VGK');
  });
  it('mon vote pour une équipe hors match → null', () => {
    expect(pickemState('1', game(), {}, 'BOS', now).myVote).toBeNull();
  });
  it('aucun vote', () => {
    expect(pickemState('1', game(), {}, null, now)).toMatchObject({ total: 0, enough: false });
  });
});

describe('formats', () => {
  it('identifiant LNH et abréviation', () => {
    expect(GAME_ID_RE.test('2026020123')).toBe(true);
    expect(GAME_ID_RE.test('12;DROP')).toBe(false);
    expect(TEAM_RE.test('VGK')).toBe(true);
    expect(TEAM_RE.test('vgk')).toBe(false);
  });
});
