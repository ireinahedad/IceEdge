import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Le facteur arbitre, contre un VRAI billet Scouting the Refs.
 *
 * `__fixtures__/str-2025-11-18.html` est un extrait verbatim du billet du
 * 18/11/2025 : deux matchs avec leurs officiels, le match dont les officiels ne
 * sont pas annoncés (« Referees and Linesmen TBD »), et la légende de bas de
 * tableau. Les trois sont là exprès — les deux derniers sont précisément ce que
 * l'ancien parseur transformait en NOMS D'ARBITRES INVENTÉS :
 *
 *   [ { abbrs: ['DAL','NYI'], refs: ['Linesmen TBD'] },
 *     { abbrs: ['SJS','UTA'], refs: ["'s rank among active officials."] } ]
 *
 * Deux entrées pour huit matchs, et zéro vrai arbitre. Ces chaînes seraient
 * sorties à l'écran par `RefFactor.note`. D'où les assertions négatives : elles
 * valent autant que les positives.
 */

const FIXTURE = readFileSync(join(__dirname, '__fixtures__', 'str-2025-11-18.html'), 'utf8');
const DATE = '2025-11-18';

// Les signatures portent leurs arguments : sans eux, `mockImplementation`
// avec un paramètre `kind` ne compile pas (`tsc` compare les arités).
const manual = {
  getEntry:   vi.fn(async (_kind: string, _key: string): Promise<any> => null),
  mapEntries: vi.fn(async (_kind: string): Promise<any> => ({})),
  setEntry:   vi.fn(async (..._args: any[]): Promise<void> => {}),
};
vi.mock('./manualData.service', () => manual);

/** Réponse WP crédible : le billet du jour, noyé parmi d'autres. */
function strResponse(date = DATE, html = FIXTURE) {
  return [
    { date: `${date}T13:18:42`, title: { rendered: 'Today’s NHL Referees and Linespersons – 11/18/25' }, content: { rendered: html } },
    { date: `${date}T09:00:00`, title: { rendered: 'PWHL Eliminates Coach’s Challenges' }, content: { rendered: '<p>rien</p>' } },
  ];
}

function stubFetch(payload: unknown) {
  const spy = vi.fn(async () => ({ ok: true, json: async () => payload } as any));
  vi.stubGlobal('fetch', spy);
  return spy;
}

async function freshStore() {
  vi.resetModules();
  return import('./refereeStore');
}

beforeEach(() => {
  vi.clearAllMocks();
  manual.getEntry.mockImplementation(async () => null);
  manual.mapEntries.mockImplementation(async () => ({}));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('facteur arbitre — lecture du billet', () => {
  it('rend les deux VRAIS arbitres du match', async () => {
    stubFetch(strResponse());
    const { getGameRefFactor } = await freshStore();
    const f = await getGameRefFactor('TOR', 'STL', DATE);
    expect(f.refs).toEqual(['Corey Syvret', 'Michael Markovic']);
    expect(f.source).toBe('scrape');
  });

  it('le match « TBD » ne produit AUCUN arbitre', async () => {
    // C'est la ligne « Referees and Linesmen TBD » : l'ancien parseur en tirait
    // un arbitre nommé « Linesmen TBD ».
    stubFetch(strResponse());
    const { getGameRefFactor } = await freshStore();
    const f = await getGameRefFactor('DAL', 'NYI', DATE);
    expect(f.refs).toEqual([]);
    expect(f.source).toBe('none');
    expect(f.multiplier).toBe(1.0);
  });

  it("la légende du tableau ne devient pas un arbitre", async () => {
    // « Number in orange/parentheses indicated referee's rank among active
    // officials. » → l'ancien parseur en tirait « 's rank among active officials. »
    stubFetch(strResponse());
    const { getGameRefFactor } = await freshStore();
    const tous = [
      await getGameRefFactor('TOR', 'STL', DATE),
      await getGameRefFactor('SJS', 'UTA', DATE),
      await getGameRefFactor('DAL', 'NYI', DATE),
    ].flatMap(f => f.refs);
    expect(tous.join(' ')).not.toMatch(/rank|TBD|official/i);
    for (const nom of tous) expect(nom).toMatch(/^[A-Z][a-zA-Z.'-]+ [A-Z][a-zA-Z.'-]+$/);
  });

  it('ne prend jamais un juge de ligne pour un arbitre', async () => {
    stubFetch(strResponse());
    const { getGameRefFactor } = await freshStore();
    const f = await getGameRefFactor('TOR', 'STL', DATE);
    // Shandor Alphonso #52 et Michel Cormier #76 sont les LINESPERSONS du même tableau.
    expect(f.refs).not.toContain('Shandor Alphonso');
    expect(f.refs).not.toContain('Michel Cormier');
  });

  it("n'applique JAMAIS les arbitres d'un autre jour", async () => {
    // L'ancien `?? posts[0]` faisait exactement ça, en silence.
    stubFetch(strResponse('2025-11-17'));
    const { getGameRefFactor } = await freshStore();
    const f = await getGameRefFactor('TOR', 'STL', DATE);
    expect(f.source).toBe('none');
    expect(f.multiplier).toBe(1.0);
  });

  it('un billet illisible rend neutre, sans lever', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('réseau'); }));
    const { getGameRefFactor } = await freshStore();
    await expect(getGameRefFactor('TOR', 'STL', DATE)).resolves.toMatchObject({ multiplier: 1.0, source: 'none' });
  });
});

describe('facteur arbitre — la tendance et son dénominateur', () => {
  it('mémorise les PP Opp/Gm carrière relevés dans ref_tendency_auto', async () => {
    stubFetch(strResponse());
    const { getGameRefFactor } = await freshStore();
    await getGameRefFactor('TOR', 'STL', DATE);

    const ecrits = Object.fromEntries(
      manual.setEntry.mock.calls.map((c: any[]) => [c[1], c[2]]),
    );
    // Colonne CARRIÈRE du billet : « 5.7 (10) | 5.6 (37) » → 5.6, pas 5.7.
    expect(ecrits['corey syvret']).toMatchObject({ name: 'Corey Syvret', ppPerGame: 5.6 });
    expect(ecrits['michael markovic']).toMatchObject({ ppPerGame: 6.7 });
    expect(manual.setEntry.mock.calls.every((c: any[]) => c[0] === 'ref_tendency_auto')).toBe(true);
  });

  it('la saisie humaine écrase le relevé automatique', async () => {
    manual.mapEntries.mockImplementation(async (kind: string) =>
      kind === 'ref_tendency_auto' ? { 'corey syvret': { name: 'Corey Syvret', ppPerGame: 5.6 } }
    : kind === 'ref_tendency'      ? { 'corey syvret': { name: 'Corey Syvret', ppPerGame: 9.0 } }
    : {});
    stubFetch(strResponse());
    const { getGameRefFactor } = await freshStore();
    const f = await getGameRefFactor('TOR', 'STL', DATE);
    // Deux arbitres : 9.0 (saisi) et 6.7 (relevé) → moyenne 7.85, au-dessus de
    // toute référence plausible → le multiplicateur bute sur sa borne haute.
    expect(f.multiplier).toBe(1.2);
  });

  it('le dénominateur est la moyenne des tendances connues, pas le 6,2 semé', async () => {
    // 12 arbitres à 6.0 : la moyenne de référence vaut 6.0, pas 6.2.
    // Noms alphabétiques : `normalizeRefName` retire les chiffres, donc
    // « Ref 1 » et « Ref 2 » deviendraient la MÊME clé.
    const pop: Record<string, any> = {};
    for (const n of ['alfa','bravo','charlie','delta','echo','foxtrot','golf','hotel','india','juliett','kilo','lima']) {
      pop[`ref ${n}`] = { name: `Ref ${n}`, ppPerGame: 6.0 };
    }
    pop['corey syvret']     = { name: 'Corey Syvret', ppPerGame: 6.0 };
    pop['michael markovic'] = { name: 'Michael Markovic', ppPerGame: 6.6 };
    manual.mapEntries.mockImplementation(async (kind: string) => (kind === 'ref_tendency_auto' ? pop : {}));
    manual.getEntry.mockImplementation(async (kind: string) =>
      (kind === 'ref_config' ? { avgPpPerGame: 6.2 } : null));

    stubFetch(strResponse());
    const { getGameRefFactor } = await freshStore();
    const f = await getGameRefFactor('TOR', 'STL', DATE);

    const league = (12 * 6.0 + 6.0 + 6.6) / 14;          // ≈ 6.043
    expect(f.multiplier).toBeCloseTo(((6.0 + 6.6) / 2) / league, 5);
    // Avec le 6,2 semé en dur, on aurait eu un chiffre différent — et sur la
    // colonne saison, une remise constante pour tout le monde.
    expect(f.multiplier).not.toBeCloseTo(((6.0 + 6.6) / 2) / 6.2, 5);
  });

  it('sous MIN_POP arbitres connus, on retombe sur ref_config', async () => {
    manual.mapEntries.mockImplementation(async (kind: string) => (kind === 'ref_tendency_auto'
      ? { 'corey syvret': { name: 'Corey Syvret', ppPerGame: 6.2 }, 'michael markovic': { name: 'Michael Markovic', ppPerGame: 6.2 } }
      : {}));
    manual.getEntry.mockImplementation(async (kind: string) =>
      (kind === 'ref_config' ? { avgPpPerGame: 6.2 } : null));
    stubFetch(strResponse());
    const { getGameRefFactor } = await freshStore();
    const f = await getGameRefFactor('TOR', 'STL', DATE);
    expect(f.multiplier).toBeCloseTo(1.0, 5);
  });
});
