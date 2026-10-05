import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildGameMarkets, buildGameMarketsWithStatus, buildLiveModelMarkets, buildPrematchGameMarkets,
  boxscoreLiveInfo, liveCtxFromDetail, marginDistribution, computeLiveModelGroups,
  buildPlayerMarkets,
} from './nhlPredictions';
import { fetchPlayerById } from './nhlApiClient';

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
const { TEAM, DETAILS } = vi.hoisted(() => ({
  /** Feuilles de match des scénarios en direct, par identifiant de match. */
  DETAILS: {} as Record<string, any>,
  TEAM: (abbr: string, gf: number, ga: number, win: number) => ({
    id: abbr.toLowerCase(), abbreviation: abbr, name: `${abbr} Club`,
    winPct: win, gamesPlayed: 60, goalsForPerGame: gf, goalsAgainstPerGame: ga,
    ppPct: 21, pkPct: 80, points: 70, conference: 'East', streak: 'W2',
    homeRecord: '20-10-0', wins: 30, losses: 20, otLosses: 5,
  }),
}));

vi.mock('./nhlApiClient', () => ({
  fetchGameById: vi.fn(async (id: string) => ({
    id,
    // Sans feuille de match : pas de statut, comme avant (avant-match).
    ...(DETAILS[id] ? { status: DETAILS[id].listed ?? DETAILS[id].status } : {}),
    ...(DETAILS[id]?.startTimeUTC ? { startTimeUTC: DETAILS[id].startTimeUTC } : {}),
    homeTeam: { abbreviation: 'TOR', name: 'Toronto' },
    awayTeam: { abbreviation: 'MTL', name: 'Montreal' },
  })),
  fetchGameDetail: vi.fn(async (id: string) => {
    if (!DETAILS[id]) throw new Error('not found');
    return DETAILS[id];
  }),
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
                      'p1-o05', 'p1-o15', 'p1-o25', 'p2-o05', 'p2-o15', 'p2-o25',
                      'p3-o05', 'p3-o15', 'p3-o25']) {
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
    // Idem pour la 2e et la 3e : chaque période a ses buts dans SA carte.
    for (const n of [2, 3]) {
      const g = groups.find(x => x.id === `p${n}`)!;
      expect(g.options.map(o => o.id)).toEqual(expect.arrayContaining([`p${n}-o05`, `p${n}-o15`, `p${n}-o25`]));
      expect(g.tables!.some(t => t.title === `${n === 2 ? '2nd' : '3rd'} Period Goals`)).toBe(true);
    }
    // La 2e période compte plus de buts que la 1re (PERIOD_DIST).
    expect(pctOf('p2-o15')).toBeGreaterThan(pctOf('p1-o15'));
    expect(groups.find(g => g.id === 'p1goals')).toBeUndefined();
  });

  it('écart de victoire : par 1 + par 2 + par 3+ = victoire ; par 2 + par 3+ = −1.5', async () => {
    const { pctOf } = await load();
    const sum = pctOf('wm-1') + pctOf('wm-2') + pctOf('wm-3p');
    expect(Math.abs(sum - (pctOf('ml-home') + pctOf('ml-home-ot')))).toBeLessThanOrEqual(2);
    expect(Math.abs(pctOf('wm-2') + pctOf('wm-3p') - pctOf('pl-home-m15'))).toBeLessThanOrEqual(1);
  });
});

// ─── Match en cours ───────────────────────────────────────────────────────────

/** Feuille de match minimale, au format de `fetchGameDetail`. */
function detail(
  status: 'live' | 'final', period: number, clock: string, home: number, away: number,
  byPeriod: Array<[number, number]>, extra: Record<string, unknown> = {},
) {
  return {
    status, period, clock, periodType: period > 3 ? 'OT' : 'REG', inIntermission: false,
    home: { score: home }, away: { score: away },
    periods: byPeriod.map(([h, a], i) => ({ label: String(i + 1), home: h, away: a })),
    ...extra,
  };
}

describe('liveCtxFromDetail — état du match', () => {
  it('pas commencé → null (la page garde l\'avant-match)', () => {
    expect(liveCtxFromDetail({ status: 'scheduled', period: null })).toBeNull();
    expect(liveCtxFromDetail({ status: 'live', period: null, home: { score: 0 }, away: { score: 0 } })).toBeNull();
    expect(liveCtxFromDetail(null)).toBeNull();
  });

  it('temps restant : (3 − période) × 1200 + horloge ; f pondéré par période', () => {
    const c = liveCtxFromDetail(detail('live', 2, '10:00', 1, 0, [[1, 0], [0, 0]]))!;
    expect(c.state.secondsLeftReg).toBe(1200 + 600);
    expect(c.state.inOvertime).toBe(false);
    // Moitié de la 2e (0.365 / 2) + toute la 3e (0.330).
    expect(c.state.f).toBeCloseTo(0.365 / 2 + 0.330, 10);
    // À la mise au jeu : tout reste à jouer.
    expect(liveCtxFromDetail(detail('live', 1, '20:00', 0, 0, []))!.state.f).toBeCloseTo(1, 10);
  });

  it('entracte = fin de période (l\'horloge y affiche la pause)', () => {
    const c = liveCtxFromDetail(detail('live', 1, '17:45', 1, 1, [[1, 1]], { inIntermission: true }))!;
    expect(c.clockSec).toBe(0);
    expect(c.state.secondsLeftReg).toBe(2400);
    expect(c.label).toContain('entracte');
  });

  it('prolongation, fusillade, prolongation des séries', () => {
    expect(liveCtxFromDetail(detail('live', 4, '03:00', 2, 2, [[1, 0], [0, 1], [1, 1]]))!.state)
      .toMatchObject({ inOvertime: true, secondsLeftReg: 0, f: 0 });
    expect(liveCtxFromDetail(detail('live', 5, '00:00', 2, 2, [[1, 0], [0, 1], [1, 1]], { periodType: 'SO' }))!.label)
      .toContain('fusillade');
    expect(liveCtxFromDetail(detail('live', 6, '12:00', 1, 1, [[1, 0], [0, 1], [0, 0]]))!.state.inOvertime).toBe(true);
  });

  it('match terminé en prolongation : nul à 60 minutes, vainqueur connu', () => {
    const c = liveCtxFromDetail(detail('final', 4, '00:00', 3, 2, [[1, 0], [0, 1], [1, 1]], { lastPeriodType: 'OT' }))!;
    expect(c.final).toBe(true);
    expect(c.state).toMatchObject({ homeScore: 2, awayScore: 2, inOvertime: true });
    expect(c.otWinnerHome).toBe(true);
  });

  it('match terminé, buts par période incohérents : repli sur le score final', () => {
    const c = liveCtxFromDetail(detail('final', 4, '00:00', 3, 2, [], { lastPeriodType: 'SO' }))!;
    expect(c.state).toMatchObject({ homeScore: 3, awayScore: 2, inOvertime: false });
    expect(c.otWinnerHome).toBeUndefined();
  });
});

describe('buildGameMarkets — en direct', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  /** Un identifiant par scénario : le cache de 30 s est indexé par match. */
  const load = async (id: string, d: any) => {
    DETAILS[id] = d;
    const { groups, status } = await buildGameMarketsWithStatus(id);
    const byId = new Map(groups.flatMap(g => g.options.map(o => [o.id, o] as const)));
    const pctOf = (oid: string) => { const o = byId.get(oid); expect(o, oid).toBeDefined(); return o!.rulePct; };
    return { groups, status, byId, pctOf };
  };

  it('mené 4–0 en 3e, 5 minutes à jouer : la victoire suit le score', async () => {
    const { pctOf, status } = await load('L-4-0', detail('live', 3, '05:00', 0, 4, [[0, 2], [0, 1], [0, 1]]));
    expect(status).toBe('live');
    expect(pctOf('mw-away')).toBeGreaterThanOrEqual(95);
    expect(pctOf('mw-home')).toBeLessThanOrEqual(5);
  });

  it('0–0 à la mise au jeu : Moneyline, Match Betting et prolongation = avant-match', async () => {
    const pre = new Map((await buildGameMarkets('2026020001')).flatMap(g => g.options.map(o => [o.id, o.rulePct] as const)));
    const { pctOf } = await load('L-start', detail('live', 1, '20:00', 0, 0, []));
    for (const id of ['mw-home', 'mw-away', 'ml-home', 'ml-away', 'ml-home-ot', 'ml-away-ot', 'ot-yes', 'p3-draw']) {
      expect(Math.abs(pctOf(id) - pre.get(id)!), id).toBeLessThanOrEqual(1);
    }
  });

  it('en direct aussi, chaque tuile porte son marché ML (le client n\'a plus de repli)', async () => {
    const { groups } = await load('L-ml', detail('live', 2, '08:00', 1, 2, [[1, 0], [0, 2]]));
    const missing = groups
      .flatMap(g => g.options.map(o => ({ id: o.id, ml: o.ml })))
      .filter(o => !o.ml && !(o.id in NO_ML_BY_DESIGN));
    expect(missing).toEqual([]);
  });

  it('marchés décidés : période terminée, BTTS acquis, Over atteint', async () => {
    const { pctOf } = await load('L-decided', detail('live', 2, '12:34', 2, 1, [[1, 0], [1, 1]]));
    // 1–0 après la 1re.
    expect([pctOf('p1-home'), pctOf('p1-draw'), pctOf('p1-away')]).toEqual([100, 0, 0]);
    expect(pctOf('btts-yes')).toBe(100);
    expect(pctOf('btts-no')).toBe(0);
    expect(pctOf('o25')).toBe(100);
    expect(pctOf('u25')).toBe(0);
    // Un seul but en 1re : Over 0.5 gagné, Over 1.5 perdu.
    expect(pctOf('p1-o05')).toBe(100);
    expect(pctOf('p1-o15')).toBe(0);
    // 2e en cours, déjà 2 buts dedans (3–1 au total, 1–0 après la 1re) :
    // Over 0.5 et Over 1.5 de la 2e sont acquis, Over 2.5 reste ouvert.
    expect(pctOf('p2-o05')).toBe(100);
    expect(pctOf('p2-o15')).toBe(100);
    expect(pctOf('p2-o25')).toBeLessThan(100);
    // Un score déjà dépassé ne peut plus sortir.
    expect(pctOf('sc-home-1-0')).toBe(0);
    expect(pctOf('tt-home-o15')).toBe(100);
  });

  it('partitions à 100 en direct', async () => {
    const { groups, pctOf } = await load('L-partition', detail('live', 2, '08:00', 1, 1, [[0, 1], [1, 0]]));
    const near100 = (x: number, tol: number, what: string) => {
      expect(x, what).toBeGreaterThanOrEqual(100 - tol);
      expect(x, what).toBeLessThanOrEqual(100 + tol);
    };
    near100(pctOf('ml-home') + pctOf('ml-away') + pctOf('ml-home-ot') + pctOf('ml-away-ot'), 2, 'Match Betting');
    near100(pctOf('mw-home') + pctOf('mw-away'), 0, 'Moneyline');
    near100(pctOf('p2-home') + pctOf('p2-draw') + pctOf('p2-away'), 2, 'P2');
    near100(pctOf('p3-home') + pctOf('p3-draw') + pctOf('p3-away'), 2, 'P3');
    for (const tag of ['15', '25', '35']) {
      near100(pctOf(`pl-home-m${tag}`) + pctOf(`pl-away-p${tag}`), 1, `puck ${tag}`);
      near100(pctOf(`pl-away-m${tag}`) + pctOf(`pl-home-p${tag}`), 1, `puck ${tag}`);
    }
    for (const tag of ['25', '35', '45', '55', '65', '75']) near100(pctOf(`o${tag}`) + pctOf(`u${tag}`), 1, `total ${tag}`);
    const cs = groups.find(g => g.id === 'correctscore')!;
    near100(cs.options.reduce((s, o) => s + o.rulePct, 0), 1.5, 'score exact');
    // −1.5 ≤ victoire ; P3 = Match Betting.
    expect(pctOf('pl-home-m15')).toBeLessThanOrEqual(pctOf('ml-home') + pctOf('ml-home-ot'));
    expect(pctOf('p3-draw')).toBe(pctOf('ot-yes'));
  });

  it('aucune tuile en direct ne porte de facteurs (le client afficherait l\'avant-match)', async () => {
    const { groups } = await load('L-nofactors', detail('live', 1, '15:00', 1, 0, [[1, 0]]));
    const withFactors = groups.flatMap(g => g.options).filter(o => o.factors || o.pctScale != null || o.factorGroup);
    expect(withFactors.map(o => o.id)).toEqual([]);
    // Le ML et les notes restent.
    expect(groups.flatMap(g => g.options).every(o => o.id.endsWith('-draw') || o.ml)).toBe(true);
    expect(groups.find(g => g.id === 'moneyline')!.options[0].ruleNote).toContain('en direct');
  });

  it('prolongation en cours : plus de victoire en temps réglementaire', async () => {
    const { pctOf } = await load('L-ot', detail('live', 4, '03:00', 2, 2, [[1, 0], [0, 1], [1, 1]]));
    expect(pctOf('ml-home')).toBe(0);
    expect(pctOf('ml-away')).toBe(0);
    expect(pctOf('ot-yes')).toBe(100);
    expect(pctOf('ml-home-ot') + pctOf('ml-away-ot')).toBe(100);
    expect(pctOf('mw-home')).toBe(pctOf('ml-home-ot'));
  });

  it('match terminé : tout est décidé, statut final', async () => {
    const { groups, status, pctOf } = await load('F-ot', detail('final', 4, '00:00', 3, 2, [[1, 0], [0, 1], [1, 1]], { lastPeriodType: 'OT' }));
    expect(status).toBe('final');
    const undecided = groups.flatMap(g => g.options).filter(o => o.rulePct !== 0 && o.rulePct !== 100);
    expect(undecided.map(o => o.id)).toEqual([]);
    expect(pctOf('ml-home-ot')).toBe(100);
    expect(pctOf('p3-draw')).toBe(100);
    expect(pctOf('sc-home-3-2')).toBe(100);
    expect(pctOf('wm-1')).toBe(100);
  });

  it('match commencé, feuille illisible : avant-match SANS drapeau `live`, cache court', async () => {
    DETAILS['F-nodetail'] = { status: 'final' };   // statut lu, feuille illisible
    const f = await buildGameMarketsWithStatus('F-nodetail');
    expect(f.status).toBe('live');                 // surtout pas figé 6 h
    expect(f.liveLabel).toBeUndefined();
    expect(f.groups.flatMap(g => g.options).some(o => o.live)).toBe(false);
    DETAILS['L-nodetail'] = { status: 'live', period: 2 };   // pas de score
    expect((await buildGameMarketsWithStatus('L-nodetail')).groups.flatMap(g => g.options).some(o => o.live)).toBe(false);
  });

  it('en direct, chaque tuile recalculée porte `live`', async () => {
    DETAILS['L-flag'] = detail('live', 2, '08:00', 1, 0, [[1, 0]]);
    const { groups } = await buildGameMarketsWithStatus('L-flag');
    expect(groups.flatMap(g => g.options).every(o => o.live === true)).toBe(true);
  });

  it('heure de mise au jeu passée, feuille « pas commencé » : avant-match au cache court', async () => {
    DETAILS['S-late'] = { listed: 'scheduled', status: 'scheduled', startTimeUTC: '2026-01-01T00:00:00Z' };
    const { status, liveLabel } = await buildGameMarketsWithStatus('S-late');
    expect(status).toBe('live');
    expect(liveLabel).toBeUndefined();
  });

  it('heure de mise au jeu passée : la feuille est lue même si le statut dit « à venir »', async () => {
    DETAILS['S-started'] = { ...detail('live', 1, '12:00', 1, 0, [[1, 0]]), listed: 'scheduled', startTimeUTC: '2026-01-01T00:00:00Z' };
    const { status, liveLabel } = await buildGameMarketsWithStatus('S-started');
    expect(status).toBe('live');
    expect(liveLabel).toContain('1–0');
  });

  it('la liste d\'avant-match du paquet ML ne dépend pas de l\'état du match', async () => {
    DETAILS['F-prematch'] = { status: 'final' };   // feuille illisible
    const groups = await buildPrematchGameMarkets('F-prematch');
    expect(groups.find(g => g.id === 'moneyline')!.options[0].factors).toBeDefined();
  });
});

describe('buildLiveModelMarkets — le ML en direct', () => {
  it('mise au jeu : les chiffres du modèle ML, tels quels', async () => {
    DETAILS['M-start'] = detail('live', 1, '20:00', 0, 0, []);
    const { groups, liveLabel } = await buildLiveModelMarkets('M-start', { preHome: 0.62, ot: 0.21, lambdaT: 6.2 });
    const byId = new Map(groups.flatMap(g => g.options.map(o => [o.id, o.rulePct] as const)));
    expect(liveLabel).toBeDefined();
    expect(Math.abs(byId.get('mw-home')! - 62)).toBeLessThanOrEqual(1);
    expect(Math.abs(byId.get('ot-yes')! - 21)).toBeLessThanOrEqual(1);
  });

  it('mené 0–3 à 5 minutes de la fin : le favori du modèle ne l\'est plus', async () => {
    DETAILS['M-late'] = detail('live', 3, '05:00', 0, 3, [[0, 1], [0, 1], [0, 1]]);
    const { groups } = await buildLiveModelMarkets('M-late', { preHome: 0.7, ot: 0.22, lambdaT: 6.2 });
    const home = groups.find(g => g.id === 'moneyline')!.options[0].rulePct;
    expect(home).toBeLessThanOrEqual(3);
  });

  it('match pas commencé : pas d\'état, le paquet garde l\'avant-match', async () => {
    const res = await buildLiveModelMarkets('2026020001', { preHome: 0.6, ot: 0.2, lambdaT: 6 });
    expect(res.liveLabel).toBeUndefined();
  });
});

describe('boxscoreLiveInfo — ce que reçoivent les grilles joueur', () => {
  it('part restante, premier buteur hors fusillade', () => {
    const d = {
      ...detail('live', 2, '10:00', 1, 1, [[1, 0], [0, 1]]),
      scoring: [{ period: '1', playerId: '8478402' }, { period: '2', playerId: '8471675' }],
    };
    const info = boxscoreLiveInfo(d)!;
    expect(info.f).toBeCloseTo(0.365 / 2 + 0.330, 10);
    expect(info.firstScorerId).toBe('8478402');
  });

  it('prolongation : temps restant inconnu (null) ; fusillade et match terminé : 0', () => {
    expect(boxscoreLiveInfo(detail('live', 4, '03:00', 2, 2, [[1, 0], [0, 1], [1, 1]]))!.f).toBeNull();
    expect(boxscoreLiveInfo({ ...detail('live', 5, '00:00', 2, 2, [[1, 0], [0, 1], [1, 1]]), periodType: 'SO' })!.f).toBe(0);
    expect(boxscoreLiveInfo(detail('final', 3, '00:00', 3, 1, [[1, 0], [1, 1], [1, 0]]))!.f).toBe(0);
  });

  it('pas de but : pas de premier buteur ; feuille illisible : null', () => {
    expect(boxscoreLiveInfo(detail('live', 1, '15:00', 0, 0, []))!.firstScorerId).toBeNull();
    expect(boxscoreLiveInfo({ status: 'live' })).toBeNull();
  });
});

describe('effets de score mesurés (phase 2)', () => {
  const sides = { home: { score: 0, abbr: 'COL' }, away: { score: 0, abbr: 'LAK' } };
  const at = (period: number, clock: string, h: number, a: number) =>
    ({ ...detail('live', period, clock, h, a, []), home: { ...sides.home, score: h }, away: { ...sides.away, score: a } });

  it('le direct lit les effets mesurés', () => {
    expect(liveCtxFromDetail(at(1, '20:00', 0, 0))!.state.effects).toBeTruthy();
  });

  it("à la mise au jeu, victoire et prolongation redisent l'avant-match du modèle", () => {
    const live = liveCtxFromDetail(at(1, '20:00', 0, 0))!;
    const opt = (id: string) => computeLiveModelGroups({ preHome: 0.58, ot: 0.22, lambdaT: 6.1 }, live)
      .flatMap(g => g.options).find(o => o.id === id)!;
    expect(opt('mw-home').rulePct).toBe(58);
    expect(opt('ot-yes').rulePct).toBe(22);
  });

  it("facteur d'équipe des paris joueur : 1 but d'écart à 2 min de la fin > f, nul < f", () => {
    const lead = boxscoreLiveInfo(at(3, '02:00', 2, 1))!;
    expect(lead.fTeam!.LAK).toBeGreaterThan(lead.f! * 1.5); // attaquant supplémentaire
    expect(lead.fTeam!.COL).toBeGreaterThan(lead.f! * 1.5); // filet désert
    const tie = boxscoreLiveInfo(at(3, '02:00', 2, 2))!;
    expect(tie.fTeam!.COL).toBeLessThan(tie.f!);
    // Prolongation et match terminé : pas de facteur (la grille garde f).
    expect(boxscoreLiveInfo({ ...at(4, '03:00', 2, 2), periodType: 'OT' })!.fTeam).toBeUndefined();
  });
});

/**
 * Volume de tirs des règles : Fenwick toutes situations (MoneyPuck) depuis le
 * 2026-10-02, tirs cadrés en repli. Mesuré : log-loss de la victoire −0,00030
 * (12 saisons sur 14) pour le λ tel qu'écrit ici.
 */
describe('volume de tirs — Fenwick, repli sur les tirs cadrés', () => {
  const shotPace = (groups: Awaited<ReturnType<typeof buildGameMarkets>>) =>
    groups.flatMap(g => g.options).find(o => o.id === 'o55')!.factors!.find(f => f.id === 'shotPace')!;

  it('sans MoneyPuck : tirs cadrés, libellé inchangé', async () => {
    const groups = await buildGameMarkets('2026020951');
    expect(shotPace(groups).label).toBe('Rythme de tirs');
  });

  it('avec le Fenwick des deux équipes : le facteur le dit, et plus de volume = plus de buts', async () => {
    const api = await import('./nhlApiClient');
    const ff = (f: number, a: number) => ({ ppPct: 21, pkPct: 80, shotsForPg: 30, shotsAgainstPg: 30, faceoffPct: 50,
                                            fenwickForPg: f, fenwickAgainstPg: a });
    vi.mocked(api.fetchTeamSummaryStats).mockResolvedValueOnce({ TOR: ff(42.7, 42.7), MTL: ff(42.7, 42.7) } as any);
    const flat = shotPace(await buildGameMarkets('2026020952'));
    vi.mocked(api.fetchTeamSummaryStats).mockResolvedValueOnce({ TOR: ff(50, 42.7), MTL: ff(48, 50) } as any);
    const busy = shotPace(await buildGameMarkets('2026020953'));
    expect(flat.label).toBe('Rythme de tirs (Fenwick)');
    expect(busy.value).toBeGreaterThan(flat.value);
  });
});


describe('buildPlayerMarkets — mises en échec, blocs et pénalités du JOUEUR', () => {
  const D = (blockedShots: number | undefined, hits: number | undefined, penaltyMinutes: number) => ({
    id: '1', name: 'Test D', position: 'D', gamesPlayed: 40,
    goals: 4, assists: 16, points: 20, shots: 60, ppPoints: 3,
    blockedShots, hits, penaltyMinutes,
  });
  const pctOf = async (player: any, id: string) => {
    vi.mocked(fetchPlayerById).mockResolvedValueOnce(player);
    const groups = await buildPlayerMarkets('1');
    return groups.flatMap(g => g.options).find(o => o.id === id)!;
  };

  it('deux défenseurs aux cadences différentes n\'ont plus le même pourcentage', async () => {
    const blocker = await pctOf(D(100, 40, 10), 'blk-o15');   // 2,5 blocs/match
    const light   = await pctOf(D(24, 40, 10),  'blk-o15');   // 0,6 bloc/match
    expect(blocker.rulePct).toBeGreaterThan(light.rulePct + 20);
    expect((await pctOf(D(100, 40, 10), 'blk-o05')).ruleNote).toContain('100 blocks in 40 GP');
  });

  it('rétrécit vers la position en début de saison, retombe dessus sans donnée', async () => {
    // 2 matchs, 10 mises en échec : 5/match brut, mais (10 + 2,2×10)/12 ≈ 2,67.
    const early = await pctOf({ ...D(2, 10, 0), gamesPlayed: 2 }, 'hits-o25');
    const pos   = await pctOf(D(undefined, undefined, 0), 'hits-o25');
    expect(early.rulePct).toBeGreaterThan(pos.rulePct);
    expect(early.rulePct).toBeLessThan(80);
    expect((await pctOf(D(undefined, undefined, 0), 'hits-o15')).ruleNote).toContain('Position avg 2.20 hits');
  });
});
