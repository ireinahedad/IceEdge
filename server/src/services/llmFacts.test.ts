import { describe, it, expect } from 'vitest';
import { buildGameFacts, buildFreeFacts, marketFamily, type BetDescriptor } from './llmFacts';

/** Features minimales d'un COL–WPG : seuls les champs lus par `llmFacts` comptent. */
const features = (over: Record<string, unknown> = {}): any => ({
  home_team: 'COL', away_team: 'WPG',
  home_win_pct: 0.64, away_win_pct: 0.52,
  home_goals_for_pg: 3.4, away_goals_for_pg: 2.8,
  home_goals_against_pg: 2.7, away_goals_against_pg: 3.3,
  home_pp_pct: 27.4, away_pp_pct: 18.0, home_pk_pct: 82.0, away_pk_pct: 74.1,
  home_last10_win_pct: 0.7, away_last10_win_pct: 0.4,
  home_home_win_pct: 0.7, away_road_win_pct: 0.41,
  home_shots_for_pg: 31.2, away_shots_for_pg: 29.0, home_shots_against_pg: 27.5, away_shots_against_pg: 30.1,
  home_rest_days: 2, away_rest_days: 0, home_b2b: 0, away_b2b: 1,
  home_odds_decimal: 1.8, away_odds_decimal: 2.05,
  total_line_market: 5.5,
  ...over,
});

const result = (over: Record<string, unknown> = {}): any => ({
  probability: 62, confidence: 70, model_version: 'v', model_type: 't', explanation: 'e',
  feature_importances: [
    { name: 'factor.schedule', importance: 0.5, direction: 'positive' },
    { name: 'factor.goalie', importance: 0.3, direction: 'negative' },
    { name: 'factor.team_strength', importance: 0.15, direction: 'positive' },
    { name: 'factor.home_ice', importance: 0.05, direction: 'positive' },
  ],
  probability_std: 3.1, uncertainty: 0.2,
  ...over,
});

const ml: BetDescriptor = { type: 'game', label: 'COL', propType: 'moneyline', isHome: true, gameId: '1' };

describe('buildGameFacts — marchés vainqueur', () => {
  it('classe les facteurs du modèle, écarte les négligeables, et oriente pour/contre', () => {
    const f = buildGameFacts({ bet: ml, result: result(), features: features({ home_goalie: 'A' }), lambdaHome: 3.4, lambdaAway: 2.6, locale: 'fr' });
    expect(f.family).toBe('sided');
    expect(f.candidates.map(c => c.key)).toEqual(['schedule', 'goalie', 'team_strength']);
    expect(f.candidates[0]).toMatchObject({ tier: 'major', side: 'for' });
    expect(f.candidates[1]).toMatchObject({ tier: 'major', side: 'against' });   // pousse vers le visiteur
    expect(f.candidates[2].tier).toBe('minor');
    expect(f.dominant).toBe(true);
  });

  it('le sujet visiteur inverse le sens des facteurs', () => {
    const f = buildGameFacts({ bet: { ...ml, label: 'WPG', isHome: false }, result: result(), features: features({ home_goalie: 'A' }), lambdaHome: 3, lambdaAway: 3, locale: 'fr' });
    expect(f.candidates.find(c => c.key === 'schedule')!.side).toBe('against');
    expect(f.candidates.find(c => c.key === 'goalie')!.side).toBe('for');
  });

  it('calcule marché sans marge, écart, cote juste et valeur', () => {
    const f = buildGameFacts({ bet: { ...ml, bookOdds: 1.85 }, result: result(), features: features(), lambdaHome: 3, lambdaAway: 3, locale: 'fr' });
    // 1/1.8 = .5556 ; 1/2.05 = .4878 → 53,2 % sans marge
    expect(f.summary.marketPct).toBe(53);
    expect(f.summary.marketKind).toBe('no_vig');
    expect(f.summary.edgePts).toBe(9);
    expect(f.summary.fairOdds).toBe(1.61);
    expect(f.summary.valuePct).toBe(14.7);            // 1,85 × 0,62 − 1
    expect(f.tags).toContain('above_market');
    expect(f.text).toContain('écart modèle − marché : +9 pts');
  });

  it('sans facteur MAJEUR : le dit, et garde un seul moteur au repli', () => {
    const r = result({ feature_importances: [{ name: 'factor.schedule', importance: 0.2, direction: 'positive' }] });
    const f = buildGameFacts({ bet: ml, result: r, features: features(), lambdaHome: 3, lambdaAway: 3, locale: 'fr' });
    expect(f.dominant).toBe(false);
    expect(f.text).toContain('Aucun facteur MAJEUR');
  });

  it('étiquette « models_disagree » et réserve quand les deux modèles divergent', () => {
    const r = result({ probability_score_model: 62, probability_classifier: 48 });
    const f = buildGameFacts({ bet: ml, result: r, features: features({ home_goalie: 'A', away_goalie: 'B' }), lambdaHome: 3, lambdaAway: 3, locale: 'fr' });
    expect(f.tags).toContain('models_disagree');
    expect(f.caveat).toContain('divergent');
  });

  it('réserve gardien quand un gardien pèse et n\'est pas confirmé ; aucune quand tout est confirmé', () => {
    const pending = buildGameFacts({ bet: ml, result: result(), features: features(), lambdaHome: 3, lambdaAway: 3, locale: 'fr' });
    expect(pending.caveat).toContain('Gardiens partants non confirmés');
    expect(pending.tags).toContain('goalie_dependent');
    const oneKnown = buildGameFacts({ bet: ml, result: result(), features: features({ home_goalie: 'Georgiev' }), lambdaHome: 3, lambdaAway: 3, locale: 'fr' });
    expect(oneKnown.caveat).toContain('Gardien de WPG non confirmé');
    const done = buildGameFacts({ bet: ml, result: result(), features: features({ home_goalie: 'A', away_goalie: 'B' }), lambdaHome: 3, lambdaAway: 3, locale: 'fr' });
    expect(done.caveat).toBeNull();
  });

  it('marché inconnu et pas de chiffre : repli sur le chiffre du client, sans inventer d\'écart', () => {
    const f = buildGameFacts({ bet: { ...ml, propType: 'puck_line', mlPct: 55 }, result: null, features: features(), lambdaHome: null, lambdaAway: null, locale: 'fr' });
    expect(f.summary.modelPct).toBe(55);
    expect(f.summary.edgePts).toBeNull();
  });

  it('en direct : pas de statut ni de réserve, étiquette live', () => {
    const f = buildGameFacts({ bet: ml, result: result({ live: true }), features: features(), lambdaHome: 3, lambdaAway: 3, liveLabel: '2e période 2-1', locale: 'fr' });
    expect(f.status).toEqual([]);
    expect(f.caveat).toBeNull();
    expect(f.tags).toContain('live');
    expect(f.text).toContain('2e période 2-1');
  });
});

describe('buildGameFacts — totaux', () => {
  const over: BetDescriptor = { type: 'game', label: 'Over 5.5', propType: 'total_goals_over', line: 5.5, gameId: '1' };

  it('le total attendu comparé à la ligne est MAJEUR et POUR un Over', () => {
    const f = buildGameFacts({ bet: over, result: result({ feature_importances: [] }), features: features(), lambdaHome: 3.4, lambdaAway: 2.63, locale: 'fr' });
    expect(f.family).toBe('totals');
    const top = f.candidates[0];
    expect(top).toMatchObject({ key: 'expected_total', tier: 'major', side: 'for' });
    expect(top.evidence).toContain('6,03');
    expect(top.evidence).toContain('+0,53');
  });

  it('même total, pari Under : le facteur est CONTRE', () => {
    const f = buildGameFacts({ bet: { ...over, label: 'Under 5.5', propType: 'total_goals_under' }, result: result(), features: features(), lambdaHome: 3.4, lambdaAway: 2.63, locale: 'fr' });
    expect(f.candidates[0].side).toBe('against');
  });

  it('un écart faible à la ligne est SECONDAIRE', () => {
    const f = buildGameFacts({ bet: over, result: result(), features: features(), lambdaHome: 2.9, lambdaAway: 2.7, locale: 'fr' });
    expect(f.candidates.find(c => c.key === 'expected_total')!.tier).toBe('minor');
  });

  it('les gardiens non confirmés valent une réserve sur un total aussi', () => {
    const f = buildGameFacts({ bet: over, result: result(), features: features(), lambdaHome: 3.4, lambdaAway: 2.63, locale: 'fr' });
    expect(f.caveat).toContain('non confirmé');
  });

  it('marketFamily : le vainqueur est « sided », le reste « totals »', () => {
    expect(marketFamily('moneyline')).toBe('sided');
    expect(marketFamily('total_goals_over')).toBe('totals');
    expect(marketFamily('game_to_ot')).toBe('totals');
  });
});

describe('buildFreeFacts — joueur / équipe', () => {
  it('chaque ligne du client devient un candidat numéroté, sans classement inventé', () => {
    const f = buildFreeFacts({ type: 'player', label: 'Suzuki 1+ point', mlPct: 58, bookOdds: 1.9, extraFacts: ['Saison : 12 MJ, 14 PTS', 'Ligne 0,5 : 1,17 pt/match'] }, 'fr');
    expect(f.candidates.map(c => c.key)).toEqual(['d1', 'd2']);
    expect(f.candidates.every(c => c.tier === 'minor' && c.side === 'neutral')).toBe(true);
    expect(f.summary.valuePct).toBe(10.2);
    expect(f.text).toContain('[d1]');
  });
});

describe('parseBetDescriptor', () => {
  it('borne, nettoie et rejette', async () => {
    const { parseBetDescriptor } = await import('./llmFacts');
    expect(parseBetDescriptor(null)).toBeNull();
    expect(parseBetDescriptor({ type: 'x', label: 'a' })).toBeNull();
    expect(parseBetDescriptor({ type: 'game', label: '   ' })).toBeNull();
    const b = parseBetDescriptor({
      type: 'game', label: 'Over\u0000 5.5\n', gameId: '2025020001', line: 5.5, bookOdds: 1.91, mlPct: 62,
      extraFacts: ['ok', '', 'x'.repeat(1000), ...Array(20).fill('l')],
    })!;
    expect(b.label).toBe('Over 5.5');
    expect(b.extraFacts!.length).toBe(8);
    expect(b.extraFacts![1].length).toBe(240);
  });
  it('écarte une cote ou un pourcentage absurdes', async () => {
    const { parseBetDescriptor } = await import('./llmFacts');
    const b = parseBetDescriptor({ type: 'team', label: 'x', bookOdds: 0.5, mlPct: 140 })!;
    expect(b.bookOdds).toBeNull();
    expect(b.mlPct).toBeNull();
  });
});

describe('buildGameFacts — sensibilité au gardien', () => {
  const gs = { side: 'away' as const, team: 'WPG', lowPct: 55, highPct: 66, lowGoalie: 'Hellebuyck', highGoalie: 'Brossoit', swingPts: 11 };

  it('chiffre la réserve et ajoute la ligne SENSIBILITÉ GARDIEN', () => {
    const f = buildGameFacts({ bet: ml, result: result(), features: features({ home_goalie: 'A' }), lambdaHome: 3, lambdaAway: 3, locale: 'fr', goalieSensitivity: gs });
    expect(f.caveat).toBe('Gardien de WPG non confirmé : de 55 % (Hellebuyck) à 66 % (Brossoit).');
    expect(f.summary.goalieSwingPts).toBe(11);
    expect(f.tags).toContain('goalie_dependent');
    expect(f.text).toContain('SENSIBILITÉ GARDIEN (WPG) : 55 % avec Hellebuyck, 66 % avec Brossoit (écart 11 pts)');
  });

  it('un écart < 2 pts mesuré : la réserve dit que l\'effet est faible', () => {
    const f = buildGameFacts({ bet: ml, result: result(), features: features({ home_goalie: 'A' }), lambdaHome: 3, lambdaAway: 3, locale: 'fr', goalieSensitivity: { ...gs, swingPts: 1, highPct: 56 } });
    expect(f.caveat).toContain('effet mesuré sur ce chiffre est faible');
  });

  it('sans sensibilité, rien ne change', () => {
    const f = buildGameFacts({ bet: ml, result: result(), features: features({ home_goalie: 'A' }), lambdaHome: 3, lambdaAway: 3, locale: 'fr' });
    expect(f.text).not.toContain('SENSIBILITÉ');
    expect(f.summary.goalieSwingPts).toBeUndefined();
  });
});

describe('buildGameFacts — leçons du premier vrai match (DET–WPG, début de saison)', () => {
  const real = (over: Record<string, unknown>, bet: Partial<BetDescriptor> = {}) =>
    buildGameFacts({ bet: { ...ml, gameId: '2026020035', ...bet }, result: result(), features: features({ home_goalie: 'A', away_goalie: 'B', ...over }), lambdaHome: 2.8, lambdaAway: 2.89, locale: 'fr' });

  it('début de saison : pas de bilans présentés comme des faits, réserve dédiée', () => {
    const f = real({});
    expect(f.caveat).toContain('Début de saison');
    expect(f.candidates.find(c => c.key === 'team_strength')!.evidence).toContain('pas encore parlants');
    expect(f.text).not.toContain('gagne 70 % à domicile');
  });

  it('en cours de saison, les stats redeviennent des preuves', () => {
    const f = real({}, { gameId: '2026020900' });
    expect(f.caveat).toBeNull();
    expect(f.candidates.find(c => c.key === 'team_strength')!.evidence).toContain('% de victoires');
  });

  it('tuile « en temps réglementaire » : pas de comparaison au moneyline', () => {
    const f = real({}, { optId: 'ml-home' });
    expect(f.summary.marketPct).toBeNull();
    expect(f.summary.edgePts).toBeNull();
  });

  it('puck line « domicile +1,5 » (posée comme visiteur −1,5 : non) garde le sens du domicile', () => {
    const away = real({}, { propType: 'puck_line', line: -1.5, selection: 'no', isHome: false });
    expect(away.candidates.find(c => c.key === 'schedule')!.side).toBe('for');   // pousse vers le domicile
  });

  it('total d\'équipe : on compare le λ de l\'équipe, pas le total du match', () => {
    const f = real({}, { propType: 'team_total_goals', line: 0.5, selection: 'over', isHome: true, label: 'DET Over 0.5' });
    expect(f.candidates[0].key).toBe('expected_team_goals');
    expect(f.candidates[0].evidence).toContain('2,80 contre une ligne de 0,5');
  });

  it('prolongation : candidat « équilibre », pas de total', () => {
    const f = real({}, { propType: 'ot_so_winner' });
    expect(f.candidates.map(c => c.key)).toEqual(['closeness']);
    expect(f.summary.marketLine).toBeNull();
  });
});

describe('buildGameFacts — sensibilité quand les deux gardiens manquent', () => {
  const gsA = { side: 'away' as const, team: 'WPG', lowPct: 50, highPct: 61, lowGoalie: 'W1', highGoalie: 'W2', swingPts: 11 };
  const gsH = { side: 'home' as const, team: 'COL', lowPct: 58, highPct: 60, lowGoalie: 'C2', highGoalie: 'C1', swingPts: 2 };
  it('une réserve qui chiffre les deux côtés et une ligne FAITS par côté', () => {
    const f = buildGameFacts({ bet: ml, result: result(), features: features(), lambdaHome: 3, lambdaAway: 3, locale: 'fr', goalieSensitivities: [gsA, gsH] });
    expect(f.caveat).toBe('Gardiens non confirmés : si WPG change, 50 % (W1) → 61 % (W2) ; si COL change, 58 % (C2) → 60 % (C1).');
    expect(f.text).toContain('SENSIBILITÉ GARDIEN (WPG)');
    expect(f.text).toContain('SENSIBILITÉ GARDIEN (COL)');
    expect(f.summary.goalieSwingPts).toBe(11);
  });
  it('sans effet ≥ 2 pts, réserve qualitative', () => {
    const f = buildGameFacts({ bet: ml, result: result(), features: features(), lambdaHome: 3, lambdaAway: 3, locale: 'fr', goalieSensitivities: [{ ...gsA, swingPts: 1, highPct: 51 }] });
    expect(f.caveat).toBe('Gardiens non confirmés, mais l\'effet mesuré sur ce chiffre est faible (1 pt au plus).');
    expect(f.text).toContain('(écart 1 pt)');
  });
  it('ligne alternative : la ligne principale du marché est présentée comme telle', () => {
    const f = buildGameFacts({ bet: { ...ml, propType: 'total_goals_over', line: 2.5, label: 'Over 2.5' }, result: result(), features: features({ home_goalie: 'A', away_goalie: 'B' }), lambdaHome: 2.8, lambdaAway: 2.9, locale: 'fr' });
    expect(f.text).toContain('Ligne principale du marché : 5,5 (ce pari est sur une autre ligne, 2,5)');
  });
});

describe('buildGameFacts — absents officiels', () => {
  it('nomme les absents sans les compter ni en tirer un avantage (importance inconnue)', () => {
    const r = result({ feature_importances: [{ name: 'factor.lineup', importance: 0.4, direction: 'positive' }, { name: 'factor.schedule', importance: 0.3, direction: 'positive' }] });
    const f = buildGameFacts({ bet: ml, result: r, features: features({ home_goalie: 'A', away_goalie: 'B', home_scratches: ['Dylan Larkin', 'Marco Kasper'], away_scratches: [] }), lambdaHome: 3, lambdaAway: 3, locale: 'fr' });
    const c = f.candidates.find(x => x.key === 'lineup')!;
    expect(c.side).toBe('neutral');
    expect(c.tier).toBe('minor');
    expect(c.evidence).toContain('COL Dylan Larkin, Marco Kasper ; WPG aucun');
    expect(c.evidence).not.toMatch(/\d (contre|vs)/);
  });
});
