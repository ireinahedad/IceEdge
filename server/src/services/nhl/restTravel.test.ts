import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Repos d'avant-match envoyé au service ML (`fetchTeamRestInfo`).
 *
 * Le cas verrouillé ici : une équipe qui n'a encore joué AUCUN match cette
 * saison. À l'entraînement (`build_dataset.py::add_schedule`), le premier match
 * d'une saison a `rest_days = 7` (plafond) ; le service recevait le repli
 * générique de 2 jours. Cf. ml/INCOHERENCES_ML.md §1.
 */

const schedule: { games: any[] } = { games: [] };
let fail = false;

vi.mock('./core', () => ({
  getCached: () => null,
  setCached: () => undefined,
  fetchNHL: async () => {
    if (fail) throw new Error('NHL down');
    return schedule;
  },
}));

import { fetchTeamRestInfo, SEASON_START_REST } from './restTravel';

const game = (date: string, gameType = 2, gameState = 'OFF') =>
  ({ gameDate: date, gameType, gameState, homeTeam: { abbrev: 'TOR' } });

beforeEach(() => {
  vi.useFakeTimers();
  // Midi à New York : « aujourd'hui » vaut le 2026-10-08 en heure de l'Est.
  vi.setSystemTime(new Date('2026-10-08T16:00:00Z'));
  schedule.games = [];
  fail = false;
});
afterEach(() => { vi.useRealTimers(); });

describe('fetchTeamRestInfo', () => {
  it('début de saison (calendrier publié, aucun match joué) → repos au plafond, comme à l\'entraînement', async () => {
    schedule.games = [
      game('2026-09-28', 1),                       // présaison jouée : ne compte pas
      game('2026-10-08', 2, 'FUT'),                // le match d'ouverture, ce soir
      game('2026-10-10', 2, 'FUT'),
    ];
    const info = await fetchTeamRestInfo('TOR');
    expect(info).toEqual({ restDays: 7, b2b: 0, dense3in4: 0 });
    expect(info).toEqual(SEASON_START_REST);
  });

  it('calendrier vide → repli « inconnu » (2 jours), pas le début de saison', async () => {
    schedule.games = [];
    expect((await fetchTeamRestInfo('TOR')).restDays).toBe(2);
  });

  it('panne de l\'API → repli « inconnu » (2 jours)', async () => {
    fail = true;
    expect((await fetchTeamRestInfo('TOR')).restDays).toBe(2);
  });

  it('a joué hier → dos-à-dos', async () => {
    schedule.games = [game('2026-10-05'), game('2026-10-07'), game('2026-10-08', 2, 'FUT')];
    expect(await fetchTeamRestInfo('TOR')).toEqual({ restDays: 1, b2b: 1, dense3in4: 2 });
  });

  it('long repos → plafonné à 7', async () => {
    schedule.games = [game('2026-09-20')];
    expect((await fetchTeamRestInfo('TOR')).restDays).toBe(7);
  });
});
