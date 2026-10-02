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
// Alignement officiel NHL : vide par défaut (pas publié), rempli par les tests
// qui en ont besoin. Jamais de réseau ici.
const official: Record<string, unknown> = {};
vi.mock('./officialLineup', async (orig) => ({
  ...(await orig<typeof import('./officialLineup')>()),
  getOfficialLineupsDay: vi.fn(async () => official),
}));

beforeEach(() => {
  for (const k of Object.keys(rows)) delete rows[k];
  for (const k of Object.keys(official)) delete official[k];
});

/** Un alignement : `dressed` habillés, `scratches` absents officiels. */
function lineup(abbr: string, dressed: string[], scratches: string[] = [], confirmed = true) {
  const p = (name: string, i: number) => ({ id: 8_480_000 + i, name, pos: 'C' });
  return { gameId: 2026020100, abbr, confirmed,
           dressed: dressed.map(p), scratches: scratches.map((n, i) => p(n, 100 + i)) };
}

describe('alignement officiel du soir (API NHL)', () => {
  it('un blessé de longue durée HABILLÉ revient au jeu — ni absent pour l\'IA, ni pour les règles', async () => {
    rows.long_injuries = { TOR: { players: [{ player: 'Auston Matthews', impact: 0.06, until: '2026-10-20' }] } };
    official.TOR = lineup('TOR', ['Auston Matthews', 'William Nylander']);
    const { getScratchesDay } = await import('./scratches');
    expect(await getScratchesDay('2026-10-10')).toEqual({});
    const { getManualFactors } = await import('./injuryStore');
    expect((await getManualFactors('TOR', 'BOS')).injuries.active).toBe(false);
  });

  it('la feuille d\'un match commencé (« A. Matthews ») suffit à le reconnaître', async () => {
    rows.long_injuries = { TOR: { players: [{ player: 'Auston Matthews', impact: 0.06 }] } };
    official.TOR = lineup('TOR', ['A. Matthews']);
    const { getScratchesDay } = await import('./scratches');
    expect(await getScratchesDay('2026-10-10')).toEqual({});
  });

  it('ajoute les absents officiels, et la saisie du jour reste prioritaire', async () => {
    rows.scratches = { '2026-10-10': { TOR: ['William Nylander'] } };
    official.TOR = lineup('TOR', ['Auston Matthews', 'William Nylander'], ['Ryan Reaves']);
    const { getLineupDay } = await import('./scratches');
    const day = await getLineupDay('2026-10-10');
    expect(day.scratches).toEqual({ TOR: ['William Nylander', 'Ryan Reaves'] });
    // Nylander, déclaré absent à la main, est retiré des habillés envoyés au modèle.
    expect(day.dressed.TOR.names).toEqual(['Auston Matthews']);
    expect(day.dressed.TOR.ids).toEqual([8_480_000]);
  });

  it('absents publiés mais alignement pas définitif : absents ajoutés, rien d\'autre', async () => {
    rows.long_injuries = { TOR: { players: [{ player: 'Auston Matthews', impact: 0.06 }] } };
    official.TOR = lineup('TOR', ['Auston Matthews', 'William Nylander'], ['Ryan Reaves'], false);
    const { getLineupDay } = await import('./scratches');
    // Matthews figure dans l'EFFECTIF, pas encore dans un alignement : toujours absent.
    expect(await getLineupDay('2026-10-10')).toEqual({ scratches: { TOR: ['Auston Matthews', 'Ryan Reaves'] }, dressed: {} });
  });

  it('sans alignement publié : rien ne change (aucun habillé transmis)', async () => {
    rows.long_injuries = { TOR: { players: [{ player: 'Auston Matthews', impact: 0.06 }] } };
    const { getLineupDay } = await import('./scratches');
    expect(await getLineupDay('2026-10-10')).toEqual({ scratches: { TOR: ['Auston Matthews'] }, dressed: {} });
  });
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

describe('date de fin (`until`)', () => {
  it('une entrée expirée ne compte plus, ni pour l\'IA ni pour les règles', async () => {
    rows.long_injuries = { TOR: { players: [
      { player: 'Auston Matthews', impact: 0.06, until: '2026-10-09', source: 'auto' },
      { player: 'Joseph Woll', impact: 0.12, until: '2026-10-10', source: 'auto' },
    ] } };
    const { getScratchesDay } = await import('./scratches');
    // Le 10 : Matthews est expiré (fin le 9), Woll compte encore (fin le 10, incluse).
    expect(await getScratchesDay('2026-10-10')).toEqual({ TOR: ['Joseph Woll'] });
    const { getManualFactors } = await import('./injuryStore');
    const f = await getManualFactors('TOR', 'BOS');
    expect(f.injuries.homeProb).toBeCloseTo(0.38, 5);
  });

  it('getScratchesDay expire à la date DEMANDÉE, pas à aujourd\'hui', async () => {
    rows.long_injuries = { TOR: { players: [{ player: 'Auston Matthews', impact: 0.06, until: '2026-10-12' }] } };
    const { getScratchesDay } = await import('./scratches');
    expect(await getScratchesDay('2026-10-13')).toEqual({});
    expect(await getScratchesDay('2026-10-12')).toEqual({ TOR: ['Auston Matthews'] });
  });
});

describe('mergeManualSave — ce que l\'écran d\'admin envoie', () => {
  const auto = { player: 'Auston Matthews', impact: 0.06, since: '2026-09-28', until: '2026-10-20', source: 'auto' as const };

  it('une entrée auto renvoyée telle quelle reste auto, même par un vieux client sans `source`', async () => {
    const { mergeManualSave } = await import('./longInjuries');
    expect(mergeManualSave({ players: [auto] }, [{ player: 'Auston Matthews', impact: 0.06, since: '2026-09-28' }]))
      .toEqual({ players: [auto] });
  });

  it('une importance changée à la main en fait une entrée manuelle', async () => {
    const { mergeManualSave } = await import('./longInjuries');
    expect(mergeManualSave({ players: [auto] }, [{ player: 'Auston Matthews', impact: 0.03, since: '2026-09-28' }]))
      .toEqual({ players: [{ player: 'Auston Matthews', impact: 0.03, since: '2026-09-28' }] });
  });

  it('une entrée auto retirée est notée dans `dismissed`, une manuelle non', async () => {
    const { mergeManualSave } = await import('./longInjuries');
    const manual = { player: 'Joseph Woll', impact: 0.12 };
    expect(mergeManualSave({ players: [auto, manual] }, []))
      .toEqual({ players: [], dismissed: [{ player: 'Auston Matthews', since: '2026-09-28' }] });
  });
});

describe('mergeAutoSync — la synchro d\'une équipe', () => {
  const a = (player: string, since = '2026-09-28') => ({ player, impact: 0.05, since, until: '2026-10-20', source: 'auto' as const });

  it('ne touche jamais une entrée manuelle, même pour le même joueur', async () => {
    const { mergeAutoSync } = await import('./longInjuries');
    const manual = { player: 'Auston Matthews', impact: 0.03, since: '2026-09-20' };
    expect(mergeAutoSync({ players: [manual] }, [a('auston matthews'), a('Joseph Woll')]))
      .toEqual({ players: [manual, a('Joseph Woll')] });
  });

  it('remplace ses propres entrées : un joueur que la source ne liste plus disparaît', async () => {
    const { mergeAutoSync } = await import('./longInjuries');
    expect(mergeAutoSync({ players: [a('Auston Matthews')] }, [a('Joseph Woll')])).toEqual({ players: [a('Joseph Woll')] });
    expect(mergeAutoSync({ players: [a('Auston Matthews')] }, [])).toBeNull();
  });

  it('ne remet pas un joueur retiré à la main pour la MÊME blessure, le remet pour une nouvelle', async () => {
    const { mergeAutoSync } = await import('./longInjuries');
    const existing = { players: [], dismissed: [{ player: 'Auston Matthews', since: '2026-09-28' }] };
    expect(mergeAutoSync(existing, [a('Auston Matthews')]))
      .toEqual({ players: [], dismissed: [{ player: 'Auston Matthews', since: '2026-09-28' }] });
    // Nouvelle note (autre date) : il revient, et le rejet périmé est élagué.
    expect(mergeAutoSync(existing, [a('Auston Matthews', '2026-10-05')]))
      .toEqual({ players: [a('Auston Matthews', '2026-10-05')] });
  });
});

describe('mergeAutoSync — joueur hors de la page lue', () => {
  const a = (player: string, until: string) => ({ player, impact: 0.05, since: '2026-09-17', until, source: 'auto' as const });

  it('garde une entrée auto que le prédicat protège (note sortie de la page, fin pas passée)', async () => {
    const { mergeAutoSync } = await import('./longInjuries');
    const existing = { players: [a('Nick Bjugstad', '2027-03-16'), a('Joueur Revenu', '2026-10-20')] };
    const unseen = new Set(['nick bjugstad']);
    expect(mergeAutoSync(existing, [], (p) => unseen.has(p.player.toLowerCase())))
      .toEqual({ players: [a('Nick Bjugstad', '2027-03-16')] });
  });

  it('une nouvelle note sur la page remplace l\'ancienne entrée, le prédicat n\'y change rien', async () => {
    const { mergeAutoSync } = await import('./longInjuries');
    const fresh = { ...a('Nick Bjugstad', '2026-10-05'), since: '2026-09-30' };
    expect(mergeAutoSync({ players: [a('Nick Bjugstad', '2027-03-16')] }, [fresh], () => true))
      .toEqual({ players: [fresh] });
  });
});
