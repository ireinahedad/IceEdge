import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Le critère des value bets — UN seul, partagé par l'accueil et l'alerte push
 * (décision du user, 2026-10-02). Ces tests verrouillent ce que le user a
 * tranché : match pas commencé, modèle de score obligatoire,
 * marge retirée, bande 2–6 % au vainqueur, règle A2 (−1.5, ≥ 4 %) à la puck line.
 */

const NOW = Date.parse('2026-10-15T20:00:00Z');
const LATER = '2026-10-15T23:00:00Z';
const EARLIER = '2026-10-15T19:00:00Z';

const GAMES: any[] = [];
const GOALIES: Record<string, string> = {};
/** Prix par `<marché>|<équipe>|<ligne>`. */
const PRICES: Record<string, number> = {};
/** Résultat du paquet ML par clé de question, par match. */
const BUNDLES: Record<string, Record<string, any>> = {};
const query = vi.fn(async (..._a: unknown[]) => ({ rows: [] }));

vi.mock('../db/connection', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('./nhlApiClient', () => ({ fetchGamesByDate: vi.fn(async () => GAMES) }));
vi.mock('./startingGoalies', () => ({
  getStartingGoalies: vi.fn(async () => GOALIES),
  easternToday: () => '2026-10-15',
}));
vi.mock('./oddsClient', () => ({
  priceForSelection: vi.fn(async (q: any) => {
    const price = PRICES[`${q.marketType}|${q.selectionValue}|${q.line ?? ''}`];
    return price ? { price, bookmaker: 'betrivers', bookTitle: 'BetRivers' } : null;
  }),
}));
vi.mock('./gameMlBundle', () => ({
  // Copie de la clé réelle (`gameMlBundle.ts`) — le test de ce module-là la verrouille.
  mlBundleKey: (market: string, line: number | null | undefined, selection: string | null | undefined, home: boolean) =>
    `${market}|${line ?? ''}|${(selection ?? '').trim().toLowerCase()}|${home ? 'h' : 'a'}`,
  getGameMlBundle: vi.fn(async (id: string) => {
    if (!BUNDLES[id]) throw new Error('ml down');
    return { byKey: BUNDLES[id] };
  }),
}));

import { judgeSelection, computeValueBets, rules, notStarted } from './valueBets.service';

/** Réponse du modèle de score (probabilité entière 5–95, comme le service Python). */
const score = (pct: number) => ({ probability: pct, probability_score_model: 55 });

function game(id: string, home: string, away: string, start = LATER, status = 'scheduled') {
  return { id, gameDate: '2026-10-15', startTimeUTC: start, status,
           homeTeam: { abbreviation: home }, awayTeam: { abbreviation: away } };
}

beforeEach(() => {
  GAMES.length = 0;
  for (const o of [GOALIES, PRICES, BUNDLES]) for (const k of Object.keys(o)) delete (o as any)[k];
  query.mockClear();
  delete process.env.VALUE_BET_MIN_EDGE;
  delete process.env.VALUE_BET_MAX_EDGE;
  delete process.env.VALUE_BET_MIN_EV;
});

describe('judgeSelection — le critère pur', () => {
  it('retire la marge du livre avant de mesurer l’edge', () => {
    // 1.91 / 1.91 : 52,4 % bruts de chaque côté, 50 % une fois la marge retirée.
    const j = judgeSelection('moneyline', 0.53, 1.91, 1.91)!;
    expect(j.marketProb).toBeCloseTo(0.5, 10);
    expect(j.edge).toBeCloseTo(0.03, 10);
    expect(j.ev).toBeCloseTo(0.53 * 1.91 - 1, 10);
  });

  it('vainqueur : bande [2 %, 6 %] — le 5 points bruts de l’ancien accueil (≈ 7 dé-viggés) est rejeté', () => {
    expect(judgeSelection('moneyline', 0.519, 1.91, 1.91)).toBeNull();   // 1,9 %
    expect(judgeSelection('moneyline', 0.52, 2.0, 2.0)).not.toBeNull();   // 2 % pile, EV ≥ 0
    expect(judgeSelection('moneyline', 0.56, 1.91, 1.91)).not.toBeNull(); // 6 % pile
    expect(judgeSelection('moneyline', 0.57, 1.91, 1.91)).toBeNull();    // 7 % : info manquée
  });

  it('puck line : règle A2, ≥ 4 % et SANS plafond', () => {
    const fair = { minus: 2.6, plus: 1.5 };   // marché ≈ 36,6 % pour le −1.5
    const m = (1 / 2.6) / (1 / 2.6 + 1 / 1.5);
    expect(judgeSelection('puck_line', m + 0.039, fair.minus, fair.plus)).toBeNull();
    expect(judgeSelection('puck_line', m + 0.04, fair.minus, fair.plus)).not.toBeNull();
    expect(judgeSelection('puck_line', m + 0.12, fair.minus, fair.plus)).not.toBeNull();
  });

  it('un edge positif à EV négative chez ce livre n’est pas une value', () => {
    // Marge lourde : 1.80 / 1.80 → marché 50 %, modèle 53 % (edge 3 %) mais 0,53 × 1,80 < 1.
    expect(judgeSelection('moneyline', 0.53, 1.80, 1.80)).toBeNull();
  });

  it('les variables Railway vides ou illisibles retombent sur les défauts', () => {
    process.env.VALUE_BET_MIN_EDGE = '';
    process.env.VALUE_BET_MAX_EDGE = 'abc';
    const r = rules();
    expect(r.moneyline).toEqual({ minEdge: 0.02, maxEdge: 0.06 });
    expect(r.puck_line).toEqual({ minEdge: 0.04, maxEdge: null });
  });
});

describe('notStarted', () => {
  it('exige le statut ET une heure de mise au jeu future', () => {
    expect(notStarted(game('1', 'TOR', 'MTL'), NOW)).toBe(true);
    expect(notStarted(game('1', 'TOR', 'MTL', EARLIER), NOW)).toBe(false);
    expect(notStarted(game('1', 'TOR', 'MTL', LATER, 'live'), NOW)).toBe(false);
    expect(notStarted({ ...game('1', 'TOR', 'MTL'), startTimeUTC: null }, NOW)).toBe(false);
  });
});

describe('computeValueBets', () => {
  /** TOR (domicile) favori au vainqueur ; MTL (visiteur) donne 1,5 but. */
  function seedGame(id = 'g1') {
    GAMES.push(game(id, 'TOR', 'MTL'));
    Object.assign(PRICES, {
      'moneyline|TOR|': 1.91, 'moneyline|MTL|': 1.91,
      'puck_line|MTL|-1.5': 2.6, 'puck_line|TOR|1.5': 1.5,
    });
    BUNDLES[id] = {
      'moneyline|||h': score(53),          // edge +3 % → retenu
      'moneyline|||a': score(47),          // edge −3 % → rejeté
      'puck_line|-1.5||a': score(42),      // MTL −1.5 : marché 36,6 %, edge 5,4 % → retenu
    };
  }

  it('sans gardiens saisis, les value bets sont calculés quand même (gardien habituel)', async () => {
    seedGame();
    const bets = await computeValueBets(NOW);
    expect(bets.map((b) => b.id)).toEqual(['g1-puck_line-MTL', 'g1-moneyline-TOR']);
  });

  it('retient le vainqueur et la jambe −1.5, triés par edge, avec la cote minimale', async () => {
    seedGame();
    Object.assign(GOALIES, { TOR: 'Joseph Woll', MTL: 'Sam Montembeault' });
    const bets = await computeValueBets(NOW);
    expect(bets.map((b) => b.id)).toEqual(['g1-puck_line-MTL', 'g1-moneyline-TOR']);

    const [pl, ml] = bets;
    expect(pl).toMatchObject({ market: 'puck_line', team: 'MTL', opponent: 'TOR', isHome: false, line: -1.5, price: 2.6 });
    expect(pl.edge).toBeCloseTo(0.42 - (1 / 2.6) / (1 / 2.6 + 1 / 1.5), 10);
    expect(ml).toMatchObject({ market: 'moneyline', team: 'TOR', isHome: true, line: null, bookTitle: 'BetRivers' });
    expect(ml.minOdds).toBeCloseTo(1 / 0.53, 10);
  });

  it('l’edge se calcule sur la probabilité NON arrondie quand le service l’envoie', async () => {
    seedGame();
    Object.assign(GOALIES, { TOR: 'Joseph Woll', MTL: 'Sam Montembeault' });
    // Affiché 52 % dans les deux cas. Exact 51,6 % → edge 1,6 % < 2 % : rejeté.
    // L'entier seul (52 % → 2 %) l'aurait retenu.
    BUNDLES.g1['moneyline|||h'] = { probability: 52, probability_exact: 0.516, probability_score_model: 52 };
    expect((await computeValueBets(NOW)).some((b) => b.id === 'g1-moneyline-TOR')).toBe(false);

    // Exact 52,4 % → edge 2,4 % : retenu, et edge / EV / cote minimale exacts.
    BUNDLES.g1['moneyline|||h'] = { probability: 52, probability_exact: 0.524, probability_score_model: 52 };
    const ml = (await computeValueBets(NOW)).find((b) => b.id === 'g1-moneyline-TOR')!;
    expect(ml.modelProb).toBe(0.524);
    expect(ml.edge).toBeCloseTo(0.024, 10);
    expect(ml.ev).toBeCloseTo(0.524 * 1.91 - 1, 10);
    expect(ml.minOdds).toBeCloseTo(1 / 0.524, 10);
  });

  it('service ML sans `probability_exact` → repli sur l’entier, comme avant', async () => {
    seedGame();
    Object.assign(GOALIES, { TOR: 'Joseph Woll', MTL: 'Sam Montembeault' });
    const ml = (await computeValueBets(NOW)).find((b) => b.id === 'g1-moneyline-TOR')!;
    expect(ml.modelProb).toBe(0.53);
  });

  it('un match commencé est exclu, même avec tout le reste', async () => {
    seedGame();
    GAMES[0].startTimeUTC = EARLIER;
    Object.assign(GOALIES, { TOR: 'A', MTL: 'B' });
    expect(await computeValueBets(NOW)).toEqual([]);
  });

  it('sans le modèle de score (repli heuristique), pas de value bet', async () => {
    seedGame();
    Object.assign(GOALIES, { TOR: 'A', MTL: 'B' });
    BUNDLES.g1['moneyline|||h'] = { probability: 53, probability_score_model: null };
    BUNDLES.g1['puck_line|-1.5||a'] = { probability: 42 };
    expect(await computeValueBets(NOW)).toEqual([]);
  });

  it('paquet ML en panne : le match est ignoré, rien ne lève', async () => {
    seedGame();
    Object.assign(GOALIES, { TOR: 'A', MTL: 'B' });
    delete BUNDLES.g1;
    expect(await computeValueBets(NOW)).toEqual([]);
  });

  it('sans prix du livre, le modèle n’est même pas réveillé', async () => {
    seedGame();
    Object.assign(GOALIES, { TOR: 'A', MTL: 'B' });
    for (const k of Object.keys(PRICES)) delete PRICES[k];
    const { getGameMlBundle } = await import('./gameMlBundle');
    (getGameMlBundle as any).mockClear();
    expect(await computeValueBets(NOW)).toEqual([]);
    expect(getGameMlBundle).not.toHaveBeenCalled();
  });

  it('journalise chaque sélection retenue (premier prix = celui du CLV)', async () => {
    seedGame();
    Object.assign(GOALIES, { TOR: 'A', MTL: 'B' });
    await computeValueBets(NOW);
    expect(query).toHaveBeenCalledTimes(2);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/ON CONFLICT \(game_id, market, team\) DO UPDATE/);
    // home_team / away_team suivent le MATCH, pas la sélection.
    expect(params.slice(0, 9)).toEqual(['g1', '2026-10-15', 'TOR', 'MTL', LATER, 'puck_line', 'MTL', -1.5, 'betrivers']);
    expect(params[9]).toBe(2.6);
  });

  it('un journal en panne ne retire pas les value bets', async () => {
    seedGame();
    Object.assign(GOALIES, { TOR: 'A', MTL: 'B' });
    query.mockRejectedValueOnce(new Error('relation "value_bet_log" does not exist'));
    expect((await computeValueBets(NOW)).length).toBe(2);
  });
});
