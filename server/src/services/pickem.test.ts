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

// ── Session B ────────────────────────────────────────────────────────────────
import {
  weekBoundsET, etMidnightUtc, modelPick, rankWeek, PICKEM_MIN_WEEK_PICKS,
} from './pickem';

describe('semaine lundi → dimanche (heure de l’Est)', () => {
  it('minuit ET en UTC, été comme hiver', () => {
    expect(new Date(etMidnightUtc('2026-10-19')).toISOString()).toBe('2026-10-19T04:00:00.000Z');
    expect(new Date(etMidnightUtc('2026-12-07')).toISOString()).toBe('2026-12-07T05:00:00.000Z');
  });
  it('samedi 24 oct. (ET) → semaine du 19 au 25 ; la précédente du 12 au 18', () => {
    const now = T('2026-10-24T15:00:00Z');
    expect(weekBoundsET(now)).toMatchObject({ monday: '2026-10-19', sunday: '2026-10-25' });
    expect(weekBoundsET(now, -1)).toMatchObject({ monday: '2026-10-12', sunday: '2026-10-18' });
  });
  it('dimanche 23 h ET est encore dans la semaine ; lundi 00 h 30 ET ouvre la suivante', () => {
    expect(weekBoundsET(T('2026-10-26T03:00:00Z')).monday).toBe('2026-10-19');
    expect(weekBoundsET(T('2026-10-26T04:30:00Z')).monday).toBe('2026-10-26');
  });
  it('semaine du passage à l’heure d’hiver : 7 jours + 1 h', () => {
    const w = weekBoundsET(T('2026-11-04T15:00:00Z'));
    expect(w.monday).toBe('2026-11-02');
    expect(w.end - w.start).toBe(7 * 24 * 3600_000);
    const w2 = weekBoundsET(T('2026-10-28T15:00:00Z'));
    expect(w2.end - w2.start).toBe(7 * 24 * 3600_000 + 3600_000);
  });
});

describe('choix du modèle', () => {
  it('au-dessus de 50 % : domicile ; en dessous : visiteur ; égalité : domicile', () => {
    expect(modelPick(62, 'STL', 'VGK')).toBe('STL');
    expect(modelPick(41.5, 'STL', 'VGK')).toBe('VGK');
    expect(modelPick(50, 'STL', 'VGK')).toBe('STL');
  });
});

describe('classement de la semaine', () => {
  const row = (username: string, wins: number, picks: number): any => ({
    userId: username, username, displayName: null, avatar: null, avatarUrl: null, wins, picks,
  });
  it(`minimum ${PICKEM_MIN_WEEK_PICKS} picks ; tri par taux puis victoires ; égalités au même rang`, () => {
    const r = rankWeek([row('a', 9, 9), row('b', 14, 18), row('c', 7, 10), row('d', 14, 18), row('e', 15, 20)]);
    expect(r.map((x) => [x.username, x.rank, x.pct])).toEqual([
      ['b', 1, 78], ['d', 1, 78], ['e', 3, 75], ['c', 4, 70],
    ]);
  });
});

// ── Session C ────────────────────────────────────────────────────────────────
import { reminderDue, reminderPayload } from './pickem';

describe('rappel « votes fermés dans 1 h »', () => {
  const first = T('2026-10-24T23:00:00Z'); // 19 h ET
  it('au tour qui ouvre la fenêtre (−1 h), toléré jusqu’à −30 min, une fois par jour', () => {
    expect(reminderDue(first - 70 * 60_000, first, null).due).toBe(false);
    expect(reminderDue(first - 60 * 60_000, first, null)).toEqual({ due: true, day: '2026-10-24' });
    expect(reminderDue(first - 45 * 60_000, first, null).due).toBe(true);
    expect(reminderDue(first - 30 * 60_000, first, null).due).toBe(false);
    expect(reminderDue(first - 60 * 60_000, first, '2026-10-24').due).toBe(false);
    expect(reminderDue(first - 60 * 60_000, null, null).due).toBe(false);
  });
  it('texte bilingue, vouvoiement, lien vers le chat', () => {
    const p = reminderPayload({ away: 'VGK', home: 'STL' }, 7);
    expect(p.fr.body).toBe('VGK @ STL ouvre la soirée (7 matchs). Faites vos choix avant la mise au jeu.');
    expect(p.en.title).toBe("Pick'em: picks lock in 1 h");
    expect(reminderPayload({ away: 'VGK', home: 'STL' }, 1).fr.body).toBe('VGK @ STL commence dans 1 h. Faites votre choix avant la mise au jeu.');
    expect(p.fr.url).toBe('/league');
  });
});
