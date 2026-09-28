import { describe, it, expect } from 'vitest';
import {
  parseSlipCommand, validateIntent, normalizeCommand,
  TEAM_ALIASES, TEAM_ALIAS_INDEX, SLIP_COMMAND_MAX_LENGTH, SLIP_COMMAND_MAX_PARTS,
} from './slipCommand';
import type { SlipContext, SlipGame, SlipPlayer, SlipParseResult, SlipIntent } from './slipCommand';
import { MARKET_LINES } from './marketLines';

/**
 * Ce que ce fichier prouve : une phrase devient la BONNE intention, ou un
 * échec explicite — jamais une devinette.
 *
 * Le client importe ce module tel quel (comme `parlay.ts`) ; il n'a pas de
 * runner de tests, donc ces tests couvrent aussi le champ de commande du
 * coupon.
 */

// ── Contexte de test ────────────────────────────────────────────────────────

const TODAY = '2026-10-10';
const TOMORROW = '2026-10-11';

const games: SlipGame[] = [
  { id: 'g-mtl-tor', homeAbbr: 'TOR', awayAbbr: 'MTL', date: TODAY, startTime: '7:00 PM ET' },
  { id: 'g-bos-nyr', homeAbbr: 'BOS', awayAbbr: 'NYR', date: TODAY },
  { id: 'g-lak-vgk', homeAbbr: 'LAK', awayAbbr: 'VGK', date: TODAY },
  { id: 'g-tbl-fla', homeAbbr: 'TBL', awayAbbr: 'FLA', date: TODAY },
  { id: 'g-ott-mtl', homeAbbr: 'MTL', awayAbbr: 'OTT', date: TOMORROW },
  { id: 'g-njd-van', homeAbbr: 'NJD', awayAbbr: 'VAN', date: TOMORROW },
  { id: 'g-car-nyi', homeAbbr: 'CAR', awayAbbr: 'NYI', date: TOMORROW },
  { id: 'g-min-stl', homeAbbr: 'MIN', awayAbbr: 'STL', date: TOMORROW },
  { id: 'g-edm-cgy', homeAbbr: 'EDM', awayAbbr: 'CGY', date: '2026-10-12' },
];

const players: SlipPlayer[] = [
  { id: '1', name: 'Nick Suzuki', teamAbbr: 'MTL', position: 'C' },
  { id: '2', name: 'Cole Caufield', teamAbbr: 'MTL', position: 'R' },
  { id: '3', name: 'Sam Montembeault', teamAbbr: 'MTL', position: 'G' },
  { id: '4', name: 'Juraj Slafkovský', teamAbbr: 'MTL', position: 'L' },
  { id: '5', name: 'Auston Matthews', teamAbbr: 'TOR', position: 'C' },
  { id: '6', name: 'Jack Hughes', teamAbbr: 'NJD', position: 'C' },
  { id: '7', name: 'Luke Hughes', teamAbbr: 'NJD', position: 'D' },
  { id: '8', name: 'Quinn Hughes', teamAbbr: 'VAN', position: 'D' },
  { id: '9', name: 'Sebastian Aho', teamAbbr: 'CAR', position: 'C' },
  { id: '10', name: 'Sebastian Aho', teamAbbr: 'NYI', position: 'D' },
  { id: '11', name: 'Brayden Point', teamAbbr: 'TBL', position: 'C' },
  { id: '12', name: 'Connor McDavid', teamAbbr: 'EDM', position: 'C' },
  { id: '13', name: 'Pierre-Luc Dubois', teamAbbr: 'WSH', position: 'C' },
  { id: '14', name: 'Joel Eriksson Ek', teamAbbr: 'MIN', position: 'C' },
  { id: '15', name: 'Dylan Larkin', teamAbbr: 'DET', position: 'C' },
];

// Les lignes réelles, celles de l'écran (source unique : marketLines.ts).
const lines: SlipContext['lines'] = MARKET_LINES;

const ctx: SlipContext = { games, players, today: TODAY, lines };

const parse = (text: string, c: SlipContext = ctx) => parseSlipCommand(text, c);

function intents(r: SlipParseResult): SlipIntent[] {
  if (!r.ok) throw new Error(`échec inattendu : ${JSON.stringify(r)}`);
  return r.intents;
}
const one = (text: string, c?: SlipContext) => {
  const list = intents(parse(text, c));
  expect(list).toHaveLength(1);
  return list[0];
};

const moneylineMtl: SlipIntent = {
  subjectType: 'team', subjectId: 'mtl', marketType: 'moneyline', selection: 'mtl', gameId: 'g-mtl-tor',
};

// ── Normalisation ───────────────────────────────────────────────────────────

describe('normalisation', () => {
  it('accents, casse, apostrophes et tirets', () => {
    expect(normalizeCommand("  Le CANADIEN l'emporte à Montréal ")).toBe('le canadien l emporte a montreal');
    expect(normalizeCommand('Pierre-Luc Dubois')).toBe('pierre luc dubois');
  });
  it('virgule décimale, o/u collés, .5, signe de puck line', () => {
    expect(normalizeCommand('u6,5')).toBe('under 6.5');
    expect(normalizeCommand('o6.5')).toBe('over 6.5');
    expect(normalizeCommand('Suzuki over .5 points')).toBe('suzuki over 0.5 points');
    expect(normalizeCommand('Habs -1.5')).toBe('habs -1.5');
  });
  it('MIN et CAR ne sont des équipes qu\'en majuscules, et « 60 MIN » reste des minutes', () => {
    expect(normalizeCommand('MIN gagne')).toBe('minnesota gagne');
    expect(normalizeCommand('CAR gagne')).toBe('carolina gagne');
    expect(normalizeCommand('gagne en 60 min')).toBe('gagne en 60 min');
    expect(normalizeCommand('Habs gagne en 60 MIN')).toBe('habs gagne en 60 min');
  });
  it('une phrase entièrement en majuscules ne transforme pas CAR en équipe', () => {
    expect(normalizeCommand('HABS GAGNE CAR ILS SONT BONS')).toBe('habs gagne car ils sont bons');
  });
});

// ── Table des surnoms ───────────────────────────────────────────────────────

describe('table des surnoms', () => {
  it('couvre les 32 équipes', () => {
    expect(Object.keys(TEAM_ALIASES)).toHaveLength(32);
  });

  it('les SEULES collisions sont « new york » et « ny »', () => {
    const collisions = [...TEAM_ALIAS_INDEX.entries()].filter(([, a]) => a.length > 1).map(([k]) => k).sort();
    expect(collisions).toEqual(['new york', 'ny']);
  });

  it('kings / knights / rangers / islanders ne se confondent pas', () => {
    expect(TEAM_ALIAS_INDEX.get('kings')).toEqual(['LAK']);
    expect(TEAM_ALIAS_INDEX.get('knights')).toEqual(['VGK']);
    expect(TEAM_ALIAS_INDEX.get('golden knights')).toEqual(['VGK']);
    expect(TEAM_ALIAS_INDEX.get('rangers')).toEqual(['NYR']);
    expect(TEAM_ALIAS_INDEX.get('islanders')).toEqual(['NYI']);
    expect(TEAM_ALIAS_INDEX.get('new york rangers')).toEqual(['NYR']);
  });

  // Chaque alias, de bout en bout : « <alias> gagne » → moneyline de SA équipe.
  const cases = Object.entries(TEAM_ALIASES).flatMap(([abbr, aliases]) =>
    [...aliases, abbr.toLowerCase()].map((alias) => [abbr, alias] as const));
  it.each(cases)('%s ← « %s gagne »', (abbr, alias) => {
    const solo: SlipContext = { ...ctx, games: [{ id: 'g', homeAbbr: abbr, awayAbbr: 'ZZZ', date: TODAY }] };
    const r = parse(`${alias} gagne`, solo);
    if (alias === 'min' || alias === 'car' || TEAM_ALIAS_INDEX.get(alias)!.length > 1) {
      // « new york », « ny » : ambigus ; « min », « car » : mots courants en minuscules.
      expect(r.ok).toBe(false);
      return;
    }
    expect(intents(r)).toEqual([{
      subjectType: 'team', subjectId: abbr.toLowerCase(), marketType: 'moneyline', selection: abbr.toLowerCase(), gameId: 'g',
    }]);
  });

  it('les noms complets de NAME_TO_ABBR passent aussi', () => {
    expect(one('Montréal Canadiens gagne')).toEqual(moneylineMtl);
    expect(one('St. Louis Blues gagne demain').subjectId).toBe('stl');
    expect(one('Utah Mammoth win', { ...ctx, games: [{ id: 'u', homeAbbr: 'UTA', awayAbbr: 'SEA', date: TODAY }] }).subjectId).toBe('uta');
  });

  it('« New York gagne » est ambigu, avec les deux candidats', () => {
    const r = parse('New York gagne');
    expect(r).toMatchObject({ ok: false, reason: 'ambiguous', detail: { kind: 'team' } });
    if (!r.ok && r.detail?.kind === 'team') expect(r.detail.candidates.sort()).toEqual(['NYI', 'NYR']);
  });
});

// ── Motifs d'équipe et de match ─────────────────────────────────────────────

describe('marchés d\'équipe', () => {
  it.each([
    'Canadien gagne ce soir', 'canadiens gagnent', 'Habs ML', 'habs moneyline', 'victoire du CH',
    'les Glorieux l\'emportent ce soir', 'Habs win tonight', 'MTL to win', 'Canadien bat Toronto',
  ])('moneyline (D2) : « %s »', (text) => {
    expect(one(text)).toEqual(moneylineMtl);
  });

  it('temps réglementaire, en fr et en en, et « gagne en 60 minutes »', () => {
    for (const text of ['Habs en temps réglementaire', 'Canadien gagne en 60 minutes', 'MTL regulation', 'habs gagne en 60 MIN']) {
      expect(one(text)).toEqual({ ...moneylineMtl, marketType: 'regulation_result' });
    }
  });

  it('puck line', () => {
    for (const text of ['Habs -1.5', 'Canadien puck line', 'MTL -1,5 ce soir']) {
      expect(one(text)).toEqual({ ...moneylineMtl, marketType: 'puck_line' });
    }
  });

  it('total d\'équipe', () => {
    expect(one('Habs over 2.5')).toEqual({
      subjectType: 'team', subjectId: 'mtl', marketType: 'team_total_goals', selection: 'over', line: 2.5, gameId: 'g-mtl-tor',
    });
    expect(one('Canadien moins de 3,5 buts')).toMatchObject({ marketType: 'team_total_goals', selection: 'under', line: 3.5 });
    expect(one('MTL u2.5 goals')).toMatchObject({ marketType: 'team_total_goals', selection: 'under', line: 2.5 });
  });

  it('un adversaire nommé choisit l\'affiche, et la sélection reste la PREMIÈRE équipe', () => {
    expect(one('Canadien contre Ottawa gagne')).toEqual({ ...moneylineMtl, gameId: 'g-ott-mtl' });
    expect(one('Toronto bat Montréal')).toEqual({ ...moneylineMtl, subjectId: 'tor', selection: 'tor' });
  });
});

describe('marchés de match', () => {
  const total = (sel: 'over' | 'under', line: number, gameId = 'g-mtl-tor'): SlipIntent =>
    ({ subjectType: 'game', subjectId: gameId, marketType: 'total_goals', selection: sel, line, gameId });

  it('total avec les deux équipes', () => {
    expect(one('Habs Leafs over 6.5')).toEqual(total('over', 6.5));
    expect(one('MTL @ TOR plus de 5.5 buts')).toEqual(total('over', 5.5));
    expect(one('Montreal vs Toronto u6')).toEqual(total('under', 6));
  });

  it('les deux équipes marquent / BTTS', () => {
    for (const text of ['Habs Leafs les deux équipes marquent', 'MTL TOR btts', 'Canadien both teams to score']) {
      expect(one(text)).toEqual({ subjectType: 'game', subjectId: 'g-mtl-tor', marketType: 'both_teams_score', selection: 'yes', gameId: 'g-mtl-tor' });
    }
  });

  it('prolongation / OT', () => {
    for (const text of ['Habs va en prolo', 'Canadien Toronto en prolongation', 'MTL game goes to OT', 'habs overtime']) {
      expect(one(text)).toEqual({ subjectType: 'game', subjectId: 'g-mtl-tor', marketType: 'game_to_ot', selection: 'yes', gameId: 'g-mtl-tor' });
    }
  });

  it('un total sans équipe ni morceau précédent demande le match', () => {
    expect(parse('over 6.5')).toMatchObject({ ok: false, reason: 'ambiguous', detail: { kind: 'game_missing' } });
  });
});

// ── Joueurs ─────────────────────────────────────────────────────────────────

describe('paris joueurs (D1)', () => {
  const p = (subjectId: string, marketType: SlipIntent['marketType'], selection = 'yes', line?: number, gameId = 'g-mtl-tor'): SlipIntent =>
    ({ subjectType: 'player', subjectId, marketType, selection, ...(line !== undefined ? { line } : {}), gameId });

  it('buteur', () => {
    for (const text of ['Suzuki marque', 'Nick Suzuki but ce soir', 'Suzuki to score', 'suzuki anytime', 'Suzuki buteur']) {
      expect(one(text)).toEqual(p('1', 'anytime_goal'));
    }
  });

  it('premier but', () => {
    for (const text of ['Suzuki premier but', 'Caufield marque le premier but', 'Caufield first goal scorer']) {
      expect(one(text).marketType).toBe('first_goal_scorer');
    }
  });

  it('tirs, points, passes', () => {
    expect(one('Suzuki over 2.5 tirs')).toEqual(p('1', 'shots_ou', 'over', 2.5));
    expect(one('Suzuki plus de 2,5 tirs au but')).toEqual(p('1', 'shots_ou', 'over', 2.5));
    expect(one('Matthews o3.5 shots on goal')).toEqual(p('5', 'shots_ou', 'over', 3.5));
    expect(one('Suzuki under 1.5 points')).toEqual(p('1', 'points_ou', 'under', 1.5));
    expect(one('Suzuki over 0.5 passes')).toEqual(p('1', 'assists_ou', 'over', 0.5));
    expect(one('Suzuki o0.5 assists')).toEqual(p('1', 'assists_ou', 'over', 0.5));
  });

  it('arrêts du gardien', () => {
    expect(one('Montembeault over 26.5 arrêts')).toEqual(p('3', 'goalie_saves_ou', 'over', 26.5));
    expect(one('Montembeault u24.5 saves')).toEqual(p('3', 'goalie_saves_ou', 'under', 24.5));
  });

  it('un gardien n\'a pas de tirs, un patineur pas d\'arrêts', () => {
    expect(parse('Suzuki over 26.5 arrets')).toMatchObject({ ok: false, reason: 'unsupported', detail: { kind: 'position' } });
    expect(parse('Montembeault over 1.5 tirs')).toMatchObject({ ok: false, reason: 'unsupported', detail: { kind: 'position' } });
  });

  it('accents et traits d\'union dans les noms', () => {
    expect(one('Slafkovsky marque')).toEqual(p('4', 'anytime_goal'));
    expect(one('Juraj Slafkovský marque')).toEqual(p('4', 'anytime_goal'));
    expect(one('Eriksson Ek marque', { ...ctx, today: TODAY })).toEqual(p('14', 'anytime_goal', 'yes', undefined, 'g-min-stl'));
  });

  it('Brayden Point : trouvable par son nom complet, jamais pris pour le mot « points »', () => {
    expect(one('Brayden Point over 0.5 points')).toEqual(p('11', 'points_ou', 'over', 0.5, 'g-tbl-fla'));
    expect(one('Suzuki over 1.5 points')).toEqual(p('1', 'points_ou', 'over', 1.5));
  });

  it('homonymes : « Hughes » est ambigu, avec les trois candidats', () => {
    const r = parse('Hughes marque');
    expect(r).toMatchObject({ ok: false, reason: 'ambiguous', detail: { kind: 'player' } });
    if (!r.ok && r.detail?.kind === 'player') expect(r.detail.candidates.map((c) => c.id).sort()).toEqual(['6', '7', '8']);
  });

  it('un nom complet partagé (« Sebastian Aho ») se tranche par l\'équipe nommée', () => {
    expect(parse('Sebastian Aho marque')).toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(one('Aho des Hurricanes marque')).toEqual(p('9', 'anytime_goal', 'yes', undefined, 'g-car-nyi'));
    expect(one('Quinn Hughes over 0.5 passes')).toEqual(p('8', 'assists_ou', 'over', 0.5, 'g-njd-van'));
  });

  it('un adversaire nommé filtre le match du joueur', () => {
    expect(one('Suzuki marque contre Ottawa')).toEqual(p('1', 'anytime_goal', 'yes', undefined, 'g-ott-mtl'));
    expect(parse('Suzuki marque contre Boston')).toMatchObject({ ok: false, reason: 'no_game' });
  });

  it('joueur dont l\'équipe ne joue pas', () => {
    expect(parse('Pierre-Luc Dubois marque')).toMatchObject({ ok: false, reason: 'no_game', detail: { kind: 'no_game', window: 'next' } });
  });

  it('marché de joueur sans ligne : on demande la ligne', () => {
    expect(parse('Suzuki over tirs')).toMatchObject({ ok: false, reason: 'ambiguous', detail: { kind: 'line_missing', market: 'shots_ou' } });
  });
});

// ── Quel match (§ 3.5) ──────────────────────────────────────────────────────

describe('fenêtre de temps', () => {
  it('sans précision : le prochain match', () => {
    expect(one('Canadien gagne').gameId).toBe('g-mtl-tor');
  });
  it('« demain » / tomorrow', () => {
    expect(one('Canadien gagne demain').gameId).toBe('g-ott-mtl');
    expect(one('Habs win tomorrow').gameId).toBe('g-ott-mtl');
  });
  it('« ce soir » pour une équipe qui joue demain : no_game, jamais le match de demain', () => {
    expect(parse('Edmonton gagne ce soir')).toMatchObject({ ok: false, reason: 'no_game', detail: { kind: 'no_game', window: 'today' } });
    expect(one('Edmonton gagne').gameId).toBe('g-edm-cgy');
  });
  it('équipe sans aucun match à venir', () => {
    expect(parse('Dallas gagne')).toMatchObject({ ok: false, reason: 'no_game' });
  });
  it('le jour vient de ctx.today (date NHL), pas de l\'horloge', () => {
    expect(one('Canadien gagne ce soir', { ...ctx, today: TOMORROW }).gameId).toBe('g-ott-mtl');
  });
  it('un match passé n\'est jamais choisi', () => {
    const c = { ...ctx, games: [{ id: 'old', homeAbbr: 'MTL', awayAbbr: 'BOS', date: '2026-10-01' }, ...games] };
    expect(one('Canadien gagne', c).gameId).toBe('g-mtl-tor');
  });
  it('« ce soir » ET « demain » dans le même morceau : incompris', () => {
    expect(parse('Habs gagne ce soir ou demain').ok).toBe(false);
  });
  it('ctx.today mal formé est une erreur de programmation', () => {
    expect(() => parse('Habs gagne', { ...ctx, today: '10/10/2026' })).toThrow(TypeError);
  });
});

// ── Lignes (MARKET_DEFINITIONS.lineOptions) ─────────────────────────────────

describe('lignes autorisées', () => {
  it('ligne hors lineOptions : unsupported, avec les lignes proposées', () => {
    expect(parse('Habs Leafs over 8.5')).toMatchObject({
      ok: false, reason: 'unsupported',
      detail: { kind: 'line', market: 'total_goals', line: 8.5, options: [4.5, 5.0, 5.5, 6.0, 6.5, 7.0] },
    });
    expect(parse('Montembeault over 27.5 arrets')).toMatchObject({ ok: false, reason: 'unsupported', detail: { kind: 'line', line: 27.5 } });
  });
  it('« Habs over 6.5 » : ligne du total du MATCH sur une équipe → on demande lequel (décision du 2026-09-28)', () => {
    expect(parse('Habs over 6.5')).toMatchObject({
      ok: false, reason: 'ambiguous', chunk: 'habs over 6.5',
      detail: { kind: 'total_scope', team: 'MTL', line: 6.5, gameId: 'g-mtl-tor' },
    });
    // Une ligne permise nulle part reste un refus sur le total d'équipe.
    expect(parse('Habs over 8.5')).toMatchObject({ ok: false, reason: 'unsupported', detail: { kind: 'line', market: 'team_total_goals' } });
    // L'équipe qui ne joue pas ce soir : no_game passe avant la question.
    expect(parse('Dallas over 6.5')).toMatchObject({ ok: false, reason: 'no_game' });
  });
  it('un marché sans table de lignes n\'en autorise aucune', () => {
    expect(parse('Suzuki over 2.5 tirs', { ...ctx, lines: {} })).toMatchObject({ ok: false, reason: 'unsupported' });
  });
  it('total sans ligne : on demande la ligne', () => {
    expect(parse('Habs Leafs over')).toMatchObject({ ok: false, reason: 'ambiguous', detail: { kind: 'line_missing', market: 'total_goals' } });
  });
});

// ── Phrases multiples (§ 3.6) ───────────────────────────────────────────────

describe('plusieurs demandes', () => {
  it('« Habs ML et over 6.5 » : le total hérite du match', () => {
    expect(intents(parse('Habs ML et over 6.5'))).toEqual([
      moneylineMtl,
      { subjectType: 'game', subjectId: 'g-mtl-tor', marketType: 'total_goals', selection: 'over', line: 6.5, gameId: 'g-mtl-tor' },
    ]);
  });

  it('séparateurs : et, and, +, virgule, &', () => {
    for (const text of ['Habs ML and o6.5', 'Habs ML + over 6.5', 'Habs ML, over 6.5', 'Habs ML & over 6.5']) {
      expect(intents(parse(text))).toHaveLength(2);
    }
  });

  it('le morceau suivant hérite du match demandé « demain »', () => {
    const list = intents(parse('Canadien gagne demain et les deux équipes marquent'));
    expect(list.map((i) => i.gameId)).toEqual(['g-ott-mtl', 'g-ott-mtl']);
  });

  it('héritage de l\'équipe (« et en temps réglementaire ») et du joueur (« et over 2.5 tirs »)', () => {
    expect(intents(parse('Canadien gagne ce soir et en temps reglementaire')).map((i) => i.marketType))
      .toEqual(['moneyline', 'regulation_result']);
    expect(intents(parse('Suzuki marque et over 2.5 tirs'))).toEqual([
      { subjectType: 'player', subjectId: '1', marketType: 'anytime_goal', selection: 'yes', gameId: 'g-mtl-tor' },
      { subjectType: 'player', subjectId: '1', marketType: 'shots_ou', selection: 'over', line: 2.5, gameId: 'g-mtl-tor' },
    ]);
  });

  it('trois sujets différents dans une phrase', () => {
    const list = intents(parse('Canadien gagne, Matthews over 3.5 tirs et Kings ML'));
    expect(list.map((i) => [i.marketType, i.subjectId])).toEqual([['moneyline', 'mtl'], ['shots_ou', '5'], ['moneyline', 'lak']]);
  });

  it('« Suzuki marque et gagne » ne dit pas QUI gagne : incompris', () => {
    expect(parse('Suzuki marque et gagne')).toMatchObject({ ok: false, reason: 'unknown', chunk: 'gagne' });
  });

  it('un morceau qui échoue fait échouer TOUTE la phrase', () => {
    const r = parse('Canadien gagne et Dallas gagne');
    expect(r).toMatchObject({ ok: false, reason: 'no_game', chunk: 'dallas gagne' });
  });

  it('une même jambe demandée deux fois n\'apparaît qu\'une fois', () => {
    expect(intents(parse('Habs ML et Canadien gagne'))).toEqual([moneylineMtl]);
  });

  it(`au-delà de ${SLIP_COMMAND_MAX_PARTS} demandes : unsupported`, () => {
    const text = Array(SLIP_COMMAND_MAX_PARTS + 1).fill('Habs ML').join(' et ');
    expect(parse(text)).toMatchObject({ ok: false, reason: 'unsupported', detail: { kind: 'too_many' } });
  });
});

// ── Ce que l'analyseur REFUSE de lire ───────────────────────────────────────

describe('refus explicites (passent au LLM)', () => {
  it.each([
    'Canadien ne gagne pas',     // négation : jamais l'inverse de la demande
    'Canadien perd',
    'Habs lose',
    'Habs ou Leafs gagne',       // alternative
    'match nul',                 // pas de nul en v1
    'Habs gagne 3-2',            // score exact : chiffre non lu
    'Habs +1.5',                 // puck line alternative
    'Habs ML over 6.5',          // deux marchés sans séparateur
    'Habs gagne en prolongation',
    'Suzuki gagne',              // un joueur ne « gagne » pas
    'Suzuki 3 tirs',             // ni over ni under
    'Habs',                      // aucun marché
    'bonjour',
  ])('« %s » → unknown', (text) => {
    expect(parse(text)).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it('texte vide ou blanc', () => {
    expect(parse('')).toEqual({ ok: false, reason: 'unknown', chunk: '' });
    expect(parse('   ,  ')).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it(`texte de plus de ${SLIP_COMMAND_MAX_LENGTH} caractères`, () => {
    expect(parse('Habs ML '.repeat(40))).toMatchObject({ ok: false, reason: 'unsupported', detail: { kind: 'too_long' } });
  });
});

// ── Validateur (§ 3.7) — il reçoit aussi la sortie du LLM ───────────────────

describe('validateIntent', () => {
  const ok = (i: unknown) => validateIntent(i, ctx);

  it('accepte une intention correcte et n\'en garde que les champs connus', () => {
    const r = ok({ ...moneylineMtl, probability: 99, extra: 'x' });
    expect(r).toEqual({ ok: true, intent: moneylineMtl });
  });

  it.each([
    ['forme', null, 'shape'],
    ['forme', [], 'shape'],
    ['forme', { ...moneylineMtl, subjectId: 42 }, 'shape'],
    ['forme', { ...moneylineMtl, subjectType: 'coach' }, 'shape'],
    ['forme', { ...moneylineMtl, line: 'six' }, 'shape'],
    ['forme', { ...moneylineMtl, line: Number.NaN }, 'shape'],
    ['marché hors v1', { ...moneylineMtl, marketType: 'winning_margin' }, 'market'],
    ['match inventé', { ...moneylineMtl, gameId: 'g-fake' }, 'game'],
    ['équipe hors du match', { ...moneylineMtl, subjectId: 'bos', selection: 'bos' }, 'subject'],
    ['abréviation en majuscules', { ...moneylineMtl, subjectId: 'MTL', selection: 'MTL' }, 'subject'],
    ['sélection ≠ équipe sujet', { ...moneylineMtl, selection: 'tor' }, 'selection'],
    ['ligne sur un moneyline', { ...moneylineMtl, line: 1.5 }, 'line'],
    ['total : sujet ≠ match', { subjectType: 'game', subjectId: 'g-bos-nyr', marketType: 'total_goals', selection: 'over', line: 6.5, gameId: 'g-mtl-tor' }, 'subject'],
    ['total : ligne absente', { subjectType: 'game', subjectId: 'g-mtl-tor', marketType: 'total_goals', selection: 'over', gameId: 'g-mtl-tor' }, 'line'],
    ['total : sélection « yes »', { subjectType: 'game', subjectId: 'g-mtl-tor', marketType: 'total_goals', selection: 'yes', line: 6.5, gameId: 'g-mtl-tor' }, 'selection'],
    ['BTTS : sélection « no »', { subjectType: 'game', subjectId: 'g-mtl-tor', marketType: 'both_teams_score', selection: 'no', gameId: 'g-mtl-tor' }, 'selection'],
    ['joueur inconnu', { subjectType: 'player', subjectId: '999', marketType: 'anytime_goal', selection: 'yes', gameId: 'g-mtl-tor' }, 'subject'],
    ['joueur hors du match', { subjectType: 'player', subjectId: '12', marketType: 'anytime_goal', selection: 'yes', gameId: 'g-mtl-tor' }, 'subject'],
    ['marché joueur sur une équipe', { subjectType: 'team', subjectId: 'mtl', marketType: 'anytime_goal', selection: 'yes', gameId: 'g-mtl-tor' }, 'subject'],
    ['arrêts d\'un patineur', { subjectType: 'player', subjectId: '1', marketType: 'goalie_saves_ou', selection: 'over', line: 24.5, gameId: 'g-mtl-tor' }, 'position'],
  ])('%s', (_label, input, code) => {
    expect(ok(input)).toMatchObject({ ok: false, code });
  });

  it('sans poste connu, le contrôle de poste est sauté', () => {
    const c = { ...ctx, players: [{ id: '1', name: 'Nick Suzuki', teamAbbr: 'MTL' }] };
    expect(validateIntent({ subjectType: 'player', subjectId: '1', marketType: 'goalie_saves_ou', selection: 'over', line: 24.5, gameId: 'g-mtl-tor' }, c).ok).toBe(true);
  });

  it('toute intention rendue par l\'analyseur passe le validateur', () => {
    const phrases = [
      'Canadien gagne ce soir', 'Habs -1.5', 'Habs over 2.5', 'Habs Leafs over 6.5', 'MTL TOR btts', 'Habs en prolo',
      'Suzuki marque', 'Caufield premier but', 'Suzuki over 2.5 tirs', 'Suzuki under 1.5 points',
      'Suzuki over 0.5 passes', 'Montembeault over 26.5 arrets', 'Habs ML et over 6.5',
    ];
    for (const text of phrases) {
      for (const i of intents(parse(text))) expect(validateIntent(i, ctx)).toEqual({ ok: true, intent: i });
    }
  });
});

// ── Choix cliquables (étape 3) ──────────────────────────────────────────────

describe('choix cliquables : chaque choix, ré-analysé, lève l\'ambiguïté', () => {
  const choicesOf = (text: string) => {
    const r = parse(text);
    if (r.ok) throw new Error('échec attendu');
    return r.choices ?? [];
  };

  it('« Hughes » : un choix par Hughes, chacun donne SON joueur', () => {
    const cs = choicesOf('Hughes over 0.5 passes');
    expect(cs.map((c) => c.kind === 'player' && c.id).sort()).toEqual(['6', '7', '8']);
    for (const c of cs) {
      if (c.kind !== 'player') throw new Error(c.kind);
      expect(one(c.text)).toMatchObject({ subjectType: 'player', subjectId: c.id, marketType: 'assists_ou', line: 0.5 });
    }
  });

  it('« Sebastian Aho » : le choix de Carolina passe par « carolina », pas par « car »', () => {
    const cs = choicesOf('Sebastian Aho marque');
    const car = cs.find((c) => c.kind === 'player' && c.teamAbbr === 'CAR')!;
    expect(car.text).toContain('carolina');
    expect(one(car.text).subjectId).toBe('9');
    const nyi = cs.find((c) => c.kind === 'player' && c.teamAbbr === 'NYI')!;
    expect(one(nyi.text).subjectId).toBe('10');
  });

  it('« New York gagne » : Rangers ou Islanders', () => {
    const cs = choicesOf('New York gagne');
    expect(cs.map((c) => c.kind === 'team' && c.abbr).sort()).toEqual(['NYI', 'NYR']);
    const nyr = cs.find((c) => c.kind === 'team' && c.abbr === 'NYR')!;
    expect(one(nyr.text)).toMatchObject({ subjectId: 'nyr', marketType: 'moneyline', gameId: 'g-bos-nyr' });
  });

  it('ligne manquante : une ligne par option, chacune valide', () => {
    const cs = choicesOf('Suzuki over tirs');
    expect(cs.map((c) => c.kind === 'line' && c.line)).toEqual([1.5, 2.5, 3.5, 4.5, 5.5]);
    for (const c of cs) expect(one(c.text)).toMatchObject({ marketType: 'shots_ou', selection: 'over', line: (c as { line: number }).line });
  });

  it('ligne refusée : les lignes permises, qui passent', () => {
    const cs = choicesOf('Montembeault over 27.5 arrets');
    expect(cs).toHaveLength(6);
    expect(one(cs[2].text)).toMatchObject({ marketType: 'goalie_saves_ou', line: 24.5 });
  });

  it('« Habs over 6.5 » : total du match, ou une ligne du total des Canadiens', () => {
    const cs = choicesOf('Habs over 6.5');
    expect(cs[0]).toMatchObject({ kind: 'game_total', line: 6.5 });
    expect(one(cs[0].text)).toMatchObject({ subjectType: 'game', marketType: 'total_goals', line: 6.5, gameId: 'g-mtl-tor' });
    const teamLines = cs.slice(1);
    expect(teamLines.map((c) => c.kind === 'line' && c.line)).toEqual([1.5, 2.0, 2.5, 3.0, 3.5]);
    expect(one(teamLines[2].text)).toMatchObject({ subjectType: 'team', marketType: 'team_total_goals', selection: 'over', line: 2.5 });
  });

  it('dans une phrase double, le choix garde l\'autre morceau', () => {
    const cs = choicesOf('Habs ML et Hughes marque');
    const quinn = cs.find((c) => c.kind === 'player' && c.id === '8')!;
    expect(intents(parse(quinn.text)).map((i) => [i.marketType, i.subjectId])).toEqual([['moneyline', 'mtl'], ['anytime_goal', '8']]);
  });

  it('pas de choix quand il n\'y a rien à choisir', () => {
    for (const text of ['Dallas gagne', 'over 6.5', 'Suzuki over 26.5 arrets', 'bonjour']) {
      const r = parse(text);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.choices).toBeUndefined();
    }
  });
});
