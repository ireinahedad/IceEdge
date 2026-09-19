import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildGameMarkets } from './nhlPredictions';

/**
 * Ce que ce fichier prouve : CHAQUE tuile de la page match annonce le marché ML
 * qu'elle représente.
 *
 * Le bug était silencieux et coûtait une fonctionnalité entière. La page affiche
 * les tuiles du SERVEUR, mais `GamePrediction.tsx` y rattachait les `mlProps` du
 * CLIENT en faisant correspondre les identifiants — or les deux fichiers n'ont
 * jamais nommé les options pareil :
 *
 *     client            serveur
 *     ou-over           o55
 *     ou-under          u55
 *     wm-h1 / wm-a1     wm-1
 *     p1-over           p1-o05
 *     first-home        (n'existe pas)
 *
 * 17 identifiants côté client ne tombaient sur rien. `Map.get` rend `undefined`
 * pour une clé absente, donc rien ne signalait quoi que ce soit : Total Goals,
 * Winning Margin, Goal Scorer et 1er Période Buts s'affichaient normalement, et
 * le sélecteur ML ne faisait simplement rien dessus.
 *
 * Le serveur annonce maintenant le marché sur chaque tuile (`option.ml`). Ce
 * test est ce qui empêche le trou de revenir : renommer une option ne peut plus
 * détacher son ML en silence, parce que le ML ne dépend plus du nom.
 */

// `vi.hoisted` : les fabriques de `vi.mock` sont remontées au-dessus des
// déclarations, donc un `const` ordinaire serait dans sa zone morte au moment
// où la fabrique s'exécute. (Le tsconfig est en commonjs — pas de `await`
// de premier niveau pour contourner.)
const { TEAM } = vi.hoisted(() => ({
  TEAM: (abbr: string, gf: number, ga: number, win: number) => ({
    id: abbr.toLowerCase(), abbreviation: abbr, name: `${abbr} Club`,
    winPct: win, gamesPlayed: 60, goalsForPerGame: gf, goalsAgainstPerGame: ga,
    ppPct: 21, pkPct: 80, points: 70, conference: 'East', streak: 'W2',
    homeRecord: '20-10-0', wins: 30, losses: 20, otLosses: 5,
  }),
}));

vi.mock('./nhlApiClient', () => ({
  fetchGameById: vi.fn(async () => ({
    id: '2026020001',
    homeTeam: { abbreviation: 'TOR', name: 'Toronto' },
    awayTeam: { abbreviation: 'MTL', name: 'Montreal' },
  })),
  fetchTeamByAbbr: vi.fn(async (a: string) =>
    a === 'TOR' ? TEAM('TOR', 3.3, 2.8, 58) : TEAM('MTL', 2.8, 3.2, 44)),
  fetchTeamSummaryStats: vi.fn(async () => ({})),
  fetchTeamRestInfo: vi.fn(async () => ({ restDays: 2, b2b: 0, dense3in4: 0 })),
  fetchTeamTravel: vi.fn(async () => null),
  fetchTeams: vi.fn(async () => [TEAM('TOR', 3.3, 2.8, 58), TEAM('MTL', 2.8, 3.2, 44)]),
  fetchPlayerById: vi.fn(async () => ({})),
}));
vi.mock('./oddsClient',   () => ({ fetchOddsImplied: vi.fn(async () => null) }));
vi.mock('./injuryStore',  () => ({ getManualFactors: vi.fn(async () => ({ injuries: null, lineup: null })) }));
vi.mock('./refereeStore', () => ({ getGameRefFactor: vi.fn(async () => 1) }));


/**
 * Tuiles sans marché ML, et pourquoi. Toute AUTRE tuile sans `ml` fait échouer
 * le test — c'est le point : l'omission doit être délibérée et écrite ici.
 */
const NO_ML_BY_DESIGN: Record<string, string> = {
  'p1-draw': "égalité après la 1re période — aucun marché correspondant",
  'p2-draw': "égalité après la 2e période — aucun marché correspondant",
};

describe('buildGameMarkets — chaque tuile porte son marché ML', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('aucune tuile ne perd son ML', async () => {
    const groups = await buildGameMarkets('2026020001');
    const missing = groups
      .flatMap(g => g.options.map(o => ({ group: g.id, id: o.id, ml: o.ml })))
      .filter(o => !o.ml && !(o.id in NO_ML_BY_DESIGN));
    expect(missing).toEqual([]);
  });

  it('les groupes autrefois muets ont maintenant un ML', async () => {
    const groups = await buildGameMarkets('2026020001');
    const byId = new Map(groups.flatMap(g => g.options.map(o => [o.id, o] as const)));
    // Les quatre familles que l'appariement par identifiant ratait entièrement.
    for (const id of ['o55', 'u55', 'o65', 'u65', 'wm-1', 'wm-2', 'wm-3p',
                      'p1-o05', 'p1-o15', 'p1-o25']) {
      expect(byId.get(id)?.ml, `tuile ${id}`).toBeDefined();
    }
  });

  it('les deux côtés d\'un même match ne réclament pas tous deux la glace', async () => {
    const groups = await buildGameMarkets('2026020001');
    const byId = new Map(groups.flatMap(g => g.options.map(o => [o.id, o] as const)));
    const home = byId.get('ml-home')!.ml!;
    const away = byId.get('ml-away')!.ml!;
    expect(home.isHome).toBe(true);
    expect(away.isHome).toBe(false);
    // Sujet et adversaire échangés, pas seulement le drapeau.
    expect(away.subjectId).toBe(home.opponentId);
    expect(away.opponentId).toBe(home.subjectId);
  });

  /**
   * Le marché Match Betting est une PARTITION.
   *
   * Ce qu'il remplace ne l'était pas : « maison gagne », « OT/SO », « visiteur
   * gagne » se recoupaient (une victoire en prolongation compte dans la
   * première ET la deuxième), et les trois pourcentages totalisaient ~122 %
   * sous la forme d'un marché à trois voies — où l'on choisit UNE issue.
   *
   * Les quatre tuiles doivent totaliser 100. La tolérance ne couvre que les
   * arrondis à l'entier (quatre tuiles, ±0,5 chacune) et l'écrêtage de `pct`
   * à [3, 97], qui mord sur une affiche très déséquilibrée.
   */
  it('les quatre tuiles de Match Betting partitionnent les issues', async () => {
    const groups = await buildGameMarkets('2026020001');
    const match = groups.find(g => g.id === 'match')!;
    expect(match.options.map(o => o.id)).toEqual(
      ['ml-home', 'ml-away', 'ml-home-ot', 'ml-away-ot'],
    );
    const sum = match.options.reduce((s, o) => s + o.rulePct, 0);
    expect(sum).toBeGreaterThanOrEqual(96);
    expect(sum).toBeLessThanOrEqual(104);
  });

  it('les tuiles réglementaires valent moins que la victoire totale', async () => {
    const groups = await buildGameMarkets('2026020001');
    const byId = new Map(groups.flatMap(g => g.options.map(o => [o.id, o] as const)));
    const reg = byId.get('ml-home')!.rulePct;
    const ot  = byId.get('ml-home-ot')!.rulePct;
    // « gagne en 60 min » + « gagne en OT/SO » = « gagne ». La tuile
    // réglementaire seule doit donc être strictement plus basse : c'est
    // exactement ce que `pctScale` garantit, et ce qu'un recalage naïf des
    // facteurs (`setFactors` écrase `rulePct`) détruisait.
    expect(ot).toBeGreaterThan(0);
    expect(reg).toBeLessThan(reg + ot);
  });

  it('chaque seau d\'écart demande SA taille', async () => {
    const groups = await buildGameMarkets('2026020001');
    const byId = new Map(groups.flatMap(g => g.options.map(o => [o.id, o] as const)));
    const sizes = ['wm-1', 'wm-2', 'wm-3p'].map(id => byId.get(id)!.ml!.selection);
    // Trois tuiles, trois questions différentes. Avant, aucune ne posait de
    // question du tout.
    expect(new Set(sizes).size).toBe(3);
    expect(sizes).toEqual(['1', '2', '3+']);
  });
});
