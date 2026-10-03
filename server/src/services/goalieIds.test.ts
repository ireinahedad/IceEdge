import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Gardien partant saisi (un nom) → identifiant NHL envoyé au service ML.
 * Cf. ml/INCOHERENCES_ML.md §3 : par nom, une orthographe différente faisait
 * passer le titulaire pour un gardien de relève.
 */

const goalies = vi.fn();
vi.mock('./nhlApiClient', () => ({ fetchTeamGoalies: (abbr: string) => goalies(abbr) }));

import { resolveGoalieId } from './goalieIds';

beforeEach(() => {
  goalies.mockReset();
  goalies.mockResolvedValue([
    { id: 8480045, name: 'Ukko-Pekka Luukkonen' },
    { id: 8482447, name: 'Jakub Dobeš' },
    { id: 8478470, name: 'Sam Montembeault' },
  ]);
});

describe('resolveGoalieId', () => {
  it('nom identique à l\'effectif NHL', async () => {
    expect(await resolveGoalieId('MTL', 'Jakub Dobeš')).toBe(8482447);
  });

  it('sans accents, casse et espaces différents', async () => {
    expect(await resolveGoalieId('MTL', '  jakub   DOBES ')).toBe(8482447);
  });

  it('initiale + nom de famille, quand il est unique', async () => {
    expect(await resolveGoalieId('MTL', 'S. Montembeault')).toBe(8478470);
  });

  it('prénom différent (surnom) mais nom de famille unique', async () => {
    expect(await resolveGoalieId('MTL', 'Samuel Montembeault')).toBe(8478470);
  });

  it('introuvable → undefined (le service retombe sur le nom)', async () => {
    expect(await resolveGoalieId('MTL', 'Carey Price')).toBeUndefined();
  });

  it('initiale ambiguë → undefined, on ne devine pas', async () => {
    goalies.mockResolvedValue([
      { id: 1, name: 'Jake Allen' },
      { id: 2, name: 'Jordan Allen' },
    ]);
    expect(await resolveGoalieId('NJD', 'J. Allen')).toBeUndefined();
    expect(await resolveGoalieId('NJD', 'Jake Allen')).toBe(1);
  });

  it('effectif indisponible ou nom vide → undefined, sans lever', async () => {
    goalies.mockRejectedValue(new Error('NHL down'));
    expect(await resolveGoalieId('MTL', 'Jakub Dobeš')).toBeUndefined();
    expect(await resolveGoalieId('MTL', '')).toBeUndefined();
    expect(await resolveGoalieId('MTL', undefined)).toBeUndefined();
  });
});
