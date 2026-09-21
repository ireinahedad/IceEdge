import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildGameMarkets, marginDistribution } from './nhlPredictions';

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

/**
 * La loi des écarts est une PARTITION, et son camp compte.
 *
 * Ce que ce bloc ferme : les trois tuiles « Winning Margin » comptaient
 * « quelqu'un gagne par N », les deux camps confondus, puis retiraient les
 * matchs allant en prolongation (`× regAdj`). Le moteur qui fournit le
 * pourcentage affiché — `prediction/marginPeriods.ts` — répond tout autre
 * chose : « LE SUJET gagne par N », prolongation COMPRISE, puisqu'un nul après
 * 60 minutes se termine toujours par un but d'écart. Les deux se
 * contredisaient, sur une tuile dont le libellé ne disait même pas de quelle
 * équipe il parlait.
 *
 * Rien ne le signalait : `PredictionSheet` remplace `rulePct` par la réponse du
 * moteur, donc l'écart ne se voyait que dans la grille avant ouverture et en
 * repli quand l'appel échoue.
 */
describe('marginDistribution — la loi des écarts', () => {
  it('les six seaux et le nul réglementaire somment à 1', () => {
    const m = marginDistribution(3.54, 2.55);
    const total = m.tie
      + m.homeBy1 + m.homeBy2 + m.homeBy3plus
      + m.awayBy1 + m.awayBy2 + m.awayBy3plus;
    // Cinq décimales, et pas plus : la grille s'arrête à 15 buts par équipe, et
    // la queue de Poisson au-delà pèse ~1e-6 à ces cadences. Ce n'est pas du
    // bruit d'arrondi qu'on tolère, c'est une troncature assumée — aucune équipe
    // n'a jamais marqué seize buts dans un match de la LNH.
    expect(total).toBeCloseTo(1, 5);
  });

  it('le nul réglementaire est rendu, pas jeté', () => {
    // C'est LA masse qui manquait : elle appartient à « par 1 » une fois la
    // prolongation jouée, et c'est elle qui fait de « par 1 » l'écart le plus
    // fréquent du hockey. L'ancienne version la laissait tomber au sol.
    const m = marginDistribution(3.0, 3.0);
    expect(m.tie).toBeGreaterThan(0.1);
  });

  it('« par 2+ » est bien la somme de « par 2 » et « par 3+ »', () => {
    const m = marginDistribution(3.54, 2.55);
    expect(m.homeBy2plus).toBeCloseTo(m.homeBy2 + m.homeBy3plus, 12);
  });

  it('les seaux penchent du côté de la meilleure cadence', () => {
    const m = marginDistribution(4.2, 2.0);
    expect(m.homeBy3plus).toBeGreaterThan(m.awayBy3plus);
    expect(m.homeBy1 + m.homeBy2 + m.homeBy3plus)
      .toBeGreaterThan(m.awayBy1 + m.awayBy2 + m.awayBy3plus);
  });
});

describe('les tuiles d\'écart disent de QUI elles parlent', () => {
  it('chaque libellé porte l\'équipe sujet', async () => {
    const groups = await buildGameMarkets('2026020001');
    const margin = groups.find(g => g.id === 'margin')!;
    // « Win by 1 » ne disait pas qui gagne, alors que le pari porte sur le
    // domicile depuis toujours (`gm(...)` met l'abréviation locale en sujet).
    for (const o of margin.options) {
      expect(o.label, `tuile ${o.id}`).toMatch(/^TOR by (1|2|3\+)$/);
    }
    const subjects = margin.options.map(o => o.ml?.subjectId);
    expect(new Set(subjects)).toEqual(new Set(['TOR']));
  });
});

/**
 * Tableaux de la page match (sept. 2026) — les chiffres des RÈGLES doivent se
 * tenir entre eux. Ce que chaque test ferme :
 *   · deux côtés d'une même ligne (Over/Under, Yes/No, −x / +x adverse) qui ne
 *     totalisent pas 100 ;
 *   · une partition (score exact, qui mène après une période) qui ne fait pas
 *     100 — l'ancienne carte de période totalisait ~125 % ;
 *   · des lignes qui ne décroissent pas (−2.5 plus probable que −1.5) ;
 *   · la carte de la 3e période qui contredit Match Betting.
 */
describe('tableaux de la page match — cohérence des règles', () => {
  const load = async () => {
    const groups = await buildGameMarkets('2026020001');
    const byId = new Map(groups.flatMap(g => g.options.map(o => [o.id, o] as const)));
    const pctOf = (id: string) => { const o = byId.get(id); expect(o, id).toBeDefined(); return o!.rulePct; };
    return { groups, byId, pctOf };
  };

  it('chaque case de tableau pointe vers une option existante', async () => {
    const { groups } = await load();
    for (const g of groups) {
      const ids = new Set(g.options.map(o => o.id));
      for (const t of g.tables ?? []) for (const r of t.rows) {
        expect(r.cells.length, `${g.id} ${r.label}`).toBe(t.columns.length);
        for (const c of r.cells) if (c) expect(ids.has(c), `${g.id} → ${c}`).toBe(true);
      }
    }
  });

  it('total du match : 2.5 → 7.5, Over + Under = 100, Over décroît', async () => {
    const { pctOf } = await load();
    let prev = 101;
    for (const tag of ['25', '35', '45', '55', '65', '75']) {
      expect(pctOf(`o${tag}`) + pctOf(`u${tag}`), tag).toBeGreaterThanOrEqual(99);
      expect(pctOf(`o${tag}`) + pctOf(`u${tag}`), tag).toBeLessThanOrEqual(101);
      expect(pctOf(`o${tag}`)).toBeLessThanOrEqual(prev);
      prev = pctOf(`o${tag}`);
    }
  });

  it('puck line : −x domicile + +x visiteur = 100 (et inversement), −x décroît', async () => {
    const { pctOf, byId } = await load();
    let prevH = 101, prevA = 101;
    for (const tag of ['15', '25', '35']) {
      const s1 = pctOf(`pl-home-m${tag}`) + pctOf(`pl-away-p${tag}`);
      const s2 = pctOf(`pl-away-m${tag}`) + pctOf(`pl-home-p${tag}`);
      expect(s1).toBeGreaterThanOrEqual(99); expect(s1).toBeLessThanOrEqual(101);
      expect(s2).toBeGreaterThanOrEqual(99); expect(s2).toBeLessThanOrEqual(101);
      expect(pctOf(`pl-home-m${tag}`)).toBeLessThanOrEqual(prevH);
      expect(pctOf(`pl-away-m${tag}`)).toBeLessThanOrEqual(prevA);
      prevH = pctOf(`pl-home-m${tag}`); prevA = pctOf(`pl-away-m${tag}`);
    }
    // −1.5 ne dépasse jamais la victoire du même camp (tuiles Match Betting).
    const homeWin = pctOf('ml-home') + pctOf('ml-home-ot');
    expect(pctOf('pl-home-m15')).toBeLessThanOrEqual(homeWin);
    // La ligne voyage dans le marché, pas seulement dans le libellé.
    expect(byId.get('pl-home-m25')!.ml).toMatchObject({ propType: 'puck_line', line: -2.5, subjectId: 'TOR' });
    expect(byId.get('pl-away-p25')!.ml).toMatchObject({ propType: 'puck_line', line: -2.5, subjectId: 'TOR', selection: 'no' });
  });

  it('les deux marquent 1+/2+/3+ : Yes + No = 100, Yes décroît', async () => {
    const { pctOf, byId } = await load();
    let prev = 101;
    for (const [y, n] of [['btts-yes', 'btts-no'], ['btts2-yes', 'btts2-no'], ['btts3-yes', 'btts3-no']]) {
      expect(pctOf(y) + pctOf(n)).toBeGreaterThanOrEqual(99);
      expect(pctOf(y) + pctOf(n)).toBeLessThanOrEqual(101);
      expect(pctOf(y)).toBeLessThan(prev);
      prev = pctOf(y);
    }
    expect(byId.get('btts-yes')!.ml!.line).toBeUndefined();
    expect(byId.get('btts3-no')!.ml).toMatchObject({ line: 2.5, selection: 'no' });
  });

  it('buts par équipe : Over + Under = 100 pour chaque camp et chaque ligne', async () => {
    const { pctOf } = await load();
    for (const side of ['home', 'away']) for (const tag of ['05', '15', '25', '35', '45']) {
      const s = pctOf(`tt-${side}-o${tag}`) + pctOf(`tt-${side}-u${tag}`);
      expect(s, `${side} ${tag}`).toBeGreaterThanOrEqual(99);
      expect(s, `${side} ${tag}`).toBeLessThanOrEqual(101);
    }
  });

  it('score exact : les cases d\'un camp somment à sa victoire, le tableau à 100', async () => {
    const { groups, pctOf } = await load();
    const cs = groups.find(g => g.id === 'correctscore')!;
    const home = cs.options.filter(o => o.id.startsWith('sc-home')).reduce((s, o) => s + o.rulePct, 0);
    const away = cs.options.filter(o => o.id.startsWith('sc-away')).reduce((s, o) => s + o.rulePct, 0);
    expect(home + away).toBeGreaterThan(98.5);
    expect(home + away).toBeLessThan(101.5);
    // Tolérance : arrondis au dixième de 11 cases, et arrondis entiers des
    // quatre tuiles Match Betting.
    expect(Math.abs(home - (pctOf('ml-home') + pctOf('ml-home-ot')))).toBeLessThan(2);
    // Pas de plancher à 3 % : un blanchissage 4-0 du visiteur vaut bien moins.
    expect(pctOf('sc-away-4-0')).toBeLessThan(3);
    // Sélection en ordre domicile–visiteur.
    expect(cs.options.find(o => o.id === 'sc-away-3-1')!.ml).toMatchObject({ propType: 'correct_score', selection: '1-3' });
  });

  it('périodes 1 et 2 : domicile + égalité + visiteur = 100', async () => {
    const { pctOf } = await load();
    for (const n of [1, 2]) {
      const s = pctOf(`p${n}-home`) + pctOf(`p${n}-draw`) + pctOf(`p${n}-away`);
      expect(s, `P${n}`).toBeGreaterThanOrEqual(97);
      expect(s, `P${n}`).toBeLessThanOrEqual(103);
    }
    // Moins d'égalités après deux périodes qu'après une (buts cumulés).
    expect(pctOf('p2-draw')).toBeLessThan(pctOf('p1-draw'));
  });

  it('période 3 = Match Betting : mener après 60 min = gagner en temps réglementaire', async () => {
    const { pctOf, groups } = await load();
    expect(pctOf('p3-home')).toBe(pctOf('ml-home'));
    expect(pctOf('p3-away')).toBe(pctOf('ml-away'));
    expect(pctOf('p3-draw')).toBe(pctOf('ot-yes'));
    // Les buts de la 1re période vivent dans la carte de la 1re période.
    const p1 = groups.find(g => g.id === 'p1')!;
    expect(p1.options.map(o => o.id)).toEqual(expect.arrayContaining(['p1-o05', 'p1-o15', 'p1-o25']));
    expect(groups.find(g => g.id === 'p1goals')).toBeUndefined();
  });

  it('écart de victoire : par 1 + par 2 + par 3+ = victoire ; par 2 + par 3+ = −1.5', async () => {
    const { pctOf } = await load();
    const sum = pctOf('wm-1') + pctOf('wm-2') + pctOf('wm-3p');
    expect(Math.abs(sum - (pctOf('ml-home') + pctOf('ml-home-ot')))).toBeLessThanOrEqual(2);
    expect(Math.abs(pctOf('wm-2') + pctOf('wm-3p') - pctOf('pl-home-m15'))).toBeLessThanOrEqual(1);
  });
});
