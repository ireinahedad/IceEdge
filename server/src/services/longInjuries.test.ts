import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Blessés de longue durée — la fusion À LA LECTURE.
 *
 * Ce qui est verrouillé ici : un joueur rangé dans `long_injuries` compte comme
 * absent pour le modèle IA (`getScratchesDay`) et pour le facteur Blessures des
 * règles (`getManualFactors`) sur TOUS les matchs de son équipe, sans ressaisie
 * — et ne se double pas quand il est aussi saisi pour le soir.
 */

const rows: Record<string, Record<string, unknown>> = {};
vi.mock('./manualData.service', () => ({
  getEntry:   vi.fn(async (kind: string, key: string) => rows[kind]?.[key] ?? null),
  mapEntries: vi.fn(async (kind: string) => rows[kind] ?? {}),
}));
vi.mock('./startingGoalies', () => ({ easternToday: () => '2026-10-10' }));

beforeEach(() => {
  for (const k of Object.keys(rows)) delete rows[k];
});

describe('getScratchesDay', () => {
  it('ajoute les blessés longue durée à une journée SANS saisie', async () => {
    rows.long_injuries = { TOR: { players: [{ player: 'Auston Matthews', impact: 0.06 }] } };
    const { getScratchesDay } = await import('./scratches');
    expect(await getScratchesDay('2026-10-10')).toEqual({ TOR: ['Auston Matthews'] });
  });

  it('fusionne sans doublon (casse ignorée) avec la saisie du soir', async () => {
    rows.scratches = { '2026-10-10': { TOR: ['auston matthews', 'Joseph Woll'] } };
    rows.long_injuries = { TOR: { players: [{ player: 'Auston Matthews', impact: 0.06 }] } };
    const { getScratchesDay } = await import('./scratches');
    expect(await getScratchesDay('2026-10-10')).toEqual({ TOR: ['auston matthews', 'Joseph Woll'] });
  });

  it('écarte une entrée malformée', async () => {
    rows.long_injuries = { MTL: { players: [{ player: '  ', impact: 0.06 }, { player: 'X', impact: 'fort' }] } };
    const { getScratchesDay } = await import('./scratches');
    expect(await getScratchesDay('2026-10-10')).toEqual({});
  });
});

describe('getManualFactors', () => {
  it('active le facteur Blessures sans AUCUNE saisie pour ce match', async () => {
    rows.long_injuries = { BOS: { players: [{ player: 'David Pastrnak', impact: 0.06 }] } };
    const { getManualFactors } = await import('./injuryStore');
    const f = await getManualFactors('BOS', 'TOR');
    expect(f.injuries.active).toBe(true);
    // Maison touchée de 6 points → faveur domicile 0.44.
    expect(f.injuries.homeProb).toBeCloseTo(0.44, 5);
    expect(f.lineup.active).toBe(false);
  });

  it('le poids saisi pour le match gagne, le joueur ne compte pas deux fois', async () => {
    rows.injuries = { 'TOR@BOS': { home: [{ player: 'david pastrnak', impact: 0.03 }], away: [] } };
    rows.long_injuries = { BOS: { players: [{ player: 'David Pastrnak', impact: 0.06 }] } };
    const { getManualFactors } = await import('./injuryStore');
    const f = await getManualFactors('BOS', 'TOR');
    expect(f.injuries.homeProb).toBeCloseTo(0.47, 5);
  });

  it('reste neutre quand rien n\'est saisi nulle part', async () => {
    const { getManualFactors } = await import('./injuryStore');
    const f = await getManualFactors('BOS', 'TOR');
    expect(f.injuries.active).toBe(false);
    expect(f.lineup.active).toBe(false);
  });
});
