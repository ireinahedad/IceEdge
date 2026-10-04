/**
 * fixtures.ts — le jeu d'évaluation de l'« Analyse IA » v2.
 *
 * 42 scénarios SYNTHÉTIQUES mais réalistes : 6 matchs × 6 types de pari, plus 6
 * cas limites. Ils servent à deux choses :
 *
 *   1. le test déterministe (`llmEval.test.ts`, dans la CI) : le bloc FAITS
 *      classe-t-il, oriente-t-il et réserve-t-il comme prévu ? le repli
 *      déterministe et la validation tiennent-ils sur chaque scénario ?
 *   2. le banc d'essai EN DIRECT (`scripts/eval-llm-analysis.ts`) : le vrai
 *      modèle, avec l'invite v2 ou l'ancienne (`--legacy`), sur les mêmes
 *      entrées, mesuré par les mêmes métriques.
 *
 * Les attentes (`expect`) ne portent que sur ce que le CODE décide — niveau,
 * sens, réserve, étiquettes —, jamais sur le texte du modèle.
 *
 * ⚠️ Données inventées : à remplacer, au fil du temps, par des matchs réels
 * figés (la route peut journaliser le bloc FAITS). Un jeu synthétique prouve la
 * mécanique ; seul un jeu réel prouve la qualité.
 */

import type { BetDescriptor, FactTag } from '../llmFacts';

export interface EvalScenario {
  id: string;
  /** Un match = un groupe : la spécificité se mesure ENTRE matchs différents. */
  game: string;
  description: string;
  bet: BetDescriptor;
  features: Record<string, unknown>;
  result: Record<string, unknown> | null;
  lambdaHome: number | null;
  lambdaAway: number | null;
  liveLabel?: string;
  expect: {
    topKey?: string;
    topSide?: 'for' | 'against' | 'neutral';
    topTier?: 'major' | 'minor';
    dominant?: boolean;
    /** `null` = aucune réserve attendue ; une RegExp = la réserve doit la satisfaire. */
    caveat?: RegExp | null;
    tags?: FactTag[];
    notTags?: FactTag[];
    noMarket?: boolean;
  };
}

interface Matchup {
  h: string; a: string;
  hw: number; aw: number; hgf: number; hga: number; agf: number; aga: number;
  hpp: number; app: number; hpk: number; apk: number;
  hl10: number; al10: number; hhome: number; aroad: number;
  hsf: number; asf: number; hsa: number; asa: number;
  hrest: number; arest: number; hb2b: 0 | 1; ab2b: 0 | 1;
  hodds: number; aodds: number; line: number;
  lamH: number; lamA: number;
}

const MATCHUPS: Matchup[] = [
  { h: 'COL', a: 'WPG', hw: .64, aw: .52, hgf: 3.4, hga: 2.7, agf: 2.8, aga: 3.3, hpp: 27.4, app: 18.0, hpk: 82.0, apk: 74.1, hl10: .7, al10: .4, hhome: .70, aroad: .41, hsf: 31.2, asf: 29.0, hsa: 27.5, asa: 30.1, hrest: 2, arest: 0, hb2b: 0, ab2b: 1, hodds: 1.80, aodds: 2.05, line: 5.5, lamH: 3.4, lamA: 2.63 },
  { h: 'TOR', a: 'MTL', hw: .58, aw: .44, hgf: 3.2, hga: 3.0, agf: 2.7, aga: 3.4, hpp: 23.1, app: 19.5, hpk: 79.0, apk: 77.2, hl10: .6, al10: .5, hhome: .61, aroad: .38, hsf: 30.4, asf: 28.1, hsa: 29.0, asa: 31.5, hrest: 1, arest: 1, hb2b: 0, ab2b: 0, hodds: 1.62, aodds: 2.35, line: 6.0, lamH: 3.3, lamA: 2.75 },
  { h: 'BOS', a: 'NYR', hw: .55, aw: .57, hgf: 2.9, hga: 2.6, agf: 3.1, aga: 2.8, hpp: 21.0, app: 24.2, hpk: 81.5, apk: 80.3, hl10: .5, al10: .6, hhome: .56, aroad: .50, hsf: 29.5, asf: 30.8, hsa: 27.0, asa: 28.4, hrest: 3, arest: 2, hb2b: 0, ab2b: 0, hodds: 2.00, aodds: 1.85, line: 5.5, lamH: 2.85, lamA: 2.95 },
  { h: 'EDM', a: 'CGY', hw: .60, aw: .46, hgf: 3.6, hga: 3.1, agf: 2.6, aga: 2.9, hpp: 28.8, app: 17.4, hpk: 76.0, apk: 82.9, hl10: .8, al10: .3, hhome: .66, aroad: .39, hsf: 32.0, asf: 27.6, hsa: 30.2, asa: 29.4, hrest: 2, arest: 2, hb2b: 0, ab2b: 0, hodds: 1.55, aodds: 2.50, line: 6.5, lamH: 3.9, lamA: 2.9 },
  { h: 'VGK', a: 'SEA', hw: .62, aw: .41, hgf: 3.3, hga: 2.5, agf: 2.5, aga: 3.5, hpp: 22.6, app: 16.8, hpk: 83.4, apk: 75.0, hl10: .6, al10: .3, hhome: .68, aroad: .35, hsf: 31.0, asf: 26.9, hsa: 26.1, asa: 31.8, hrest: 1, arest: 0, hb2b: 0, ab2b: 1, hodds: 1.50, aodds: 2.65, line: 5.5, lamH: 3.1, lamA: 2.2 },
  { h: 'FLA', a: 'TBL', hw: .59, aw: .56, hgf: 3.1, hga: 2.8, agf: 3.2, aga: 2.9, hpp: 24.0, app: 26.3, hpk: 80.1, apk: 79.4, hl10: .6, al10: .7, hhome: .62, aroad: .52, hsf: 30.0, asf: 31.4, hsa: 28.3, asa: 28.9, hrest: 2, arest: 3, hb2b: 0, ab2b: 0, hodds: 1.95, aodds: 1.90, line: 6.0, lamH: 3.05, lamA: 3.0 },
];

const feat = (m: Matchup, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  home_team: m.h, away_team: m.a,
  home_win_pct: m.hw, away_win_pct: m.aw,
  home_goals_for_pg: m.hgf, away_goals_for_pg: m.agf, home_goals_against_pg: m.hga, away_goals_against_pg: m.aga,
  home_pp_pct: m.hpp, away_pp_pct: m.app, home_pk_pct: m.hpk, away_pk_pct: m.apk,
  home_last10_win_pct: m.hl10, away_last10_win_pct: m.al10,
  home_home_win_pct: m.hhome, away_road_win_pct: m.aroad,
  home_shots_for_pg: m.hsf, away_shots_for_pg: m.asf, home_shots_against_pg: m.hsa, away_shots_against_pg: m.asa,
  home_rest_days: m.hrest, away_rest_days: m.arest, home_b2b: m.hb2b, away_b2b: m.ab2b,
  home_odds_decimal: m.hodds, away_odds_decimal: m.aodds, total_line_market: m.line,
  ...over,
});

const imp = (name: string, importance: number, direction: 'positive' | 'negative') => ({ name: `factor.${name}`, importance, direction });
const result = (pct: number, importances: unknown[], over: Record<string, unknown> = {}) => ({
  probability: pct, confidence: 70, model_version: 'eval', model_type: 'score', explanation: '',
  feature_importances: importances, probability_std: 3.0, uncertainty: 0.25, ...over,
});

export function buildScenarios(): EvalScenario[] {
  const out: EvalScenario[] = [];
  for (const m of MATCHUPS) {
    const game = `${m.h}-${m.a}`;
    const base = { game, features: feat(m), lambdaHome: m.lamH, lambdaAway: m.lamA };
    const sided = [imp('schedule', .40, 'positive'), imp('team_strength', .28, 'positive'), imp('goalie', .22, 'negative'), imp('home_ice', .10, 'positive')];
    const totalsBet = (over: boolean): BetDescriptor => ({
      type: 'game', gameId: game, propType: over ? 'total_goals_over' : 'total_goals_under', line: m.line,
      label: `${over ? 'Plus' : 'Moins'} de ${String(m.line).replace('.', ',')} buts`,
    });
    const gap = m.lamH + m.lamA - m.line;

    out.push({
      ...base, id: `${game}:ml-home`, description: 'vainqueur, sujet à domicile, calendrier dominant',
      bet: { type: 'game', gameId: game, propType: 'moneyline', isHome: true, label: `${m.h} gagne` },
      result: result(60, sided),
      expect: { topKey: 'schedule', topSide: 'for', topTier: 'major', dominant: true, caveat: /gardien/i, tags: ['goalie_dependent'] },
    });
    out.push({
      ...base, id: `${game}:ml-away`, description: 'vainqueur, sujet visiteur : les sens s\'inversent',
      bet: { type: 'game', gameId: game, propType: 'moneyline', isHome: false, label: `${m.a} gagne` },
      result: result(40, sided),
      expect: { topKey: 'schedule', topSide: 'against', dominant: true },
    });
    out.push({
      ...base, id: `${game}:over`, description: 'Over : le total attendu contre la ligne',
      bet: totalsBet(true), result: result(55, []),
      expect: { topKey: 'expected_total', topSide: gap > 0 ? 'for' : 'against', caveat: /gardien/i },
    });
    out.push({
      ...base, id: `${game}:under`, description: 'Under : même total, sens inverse',
      bet: totalsBet(false), result: result(45, []),
      expect: { topKey: 'expected_total', topSide: gap > 0 ? 'against' : 'for' },
    });
    out.push({
      ...base, id: `${game}:ml-flat`, description: 'aucun facteur dominant : le modèle suit le marché',
      bet: { type: 'game', gameId: game, propType: 'moneyline', isHome: true, label: `${m.h} gagne` },
      result: result(Math.round(100 * (1 / m.hodds) / (1 / m.hodds + 1 / m.aodds)),
        [imp('schedule', .2, 'positive'), imp('home_ice', .15, 'positive'), imp('team_strength', .12, 'negative')]),
      expect: { dominant: false, topTier: 'minor' },
    });
    out.push({
      ...base, id: `${game}:goalies-known`, description: 'gardiens connus : aucune réserve de gardien',
      features: feat(m, { home_goalie: 'Gardien A', away_goalie: 'Gardien B', home_dressed_ids: [1], away_dressed_ids: [2] }),
      bet: { type: 'game', gameId: game, propType: 'moneyline', isHome: true, label: `${m.h} gagne` },
      result: result(58, sided),
      expect: { caveat: null, notTags: ['goalie_dependent'] },
    });
  }

  const m0 = MATCHUPS[0];
  const g0 = `${m0.h}-${m0.a}`;
  const b0 = { game: g0, features: feat(m0, { home_goalie: 'Gardien A', away_goalie: 'Gardien B' }), lambdaHome: m0.lamH, lambdaAway: m0.lamA };
  const mlHome: BetDescriptor = { type: 'game', gameId: g0, propType: 'moneyline', isHome: true, label: `${m0.h} gagne` };
  out.push({
    ...b0, id: 'edge:models-disagree', description: 'le classifieur et le modèle de score divergent de 14 pts',
    bet: mlHome, result: result(62, [imp('team_strength', .5, 'positive')], { probability_score_model: 62, probability_classifier: 48 }),
    expect: { tags: ['models_disagree'], caveat: /divergent/ },
  });
  out.push({
    ...b0, id: 'edge:live', description: 'match en cours : ni statut, ni réserve',
    bet: mlHome, result: result(71, [imp('team_strength', .5, 'positive')], { live: true }), liveLabel: '2e période, 2-1',
    expect: { tags: ['live'], caveat: null },
  });
  out.push({
    ...b0, id: 'edge:long-shot', description: 'pari à 22 % : étiquette « faible probabilité »',
    bet: { ...mlHome, isHome: false, label: `${m0.a} gagne en 60 min` }, result: result(22, [imp('team_strength', .4, 'negative')]),
    expect: { tags: ['long_shot'] },
  });
  out.push({
    ...b0, id: 'edge:no-odds', description: 'aucune cote : pas de marché, pas d\'écart',
    features: feat(m0, { home_odds_decimal: undefined, away_odds_decimal: undefined, home_goalie: 'A', away_goalie: 'B' }),
    bet: mlHome, result: result(60, [imp('team_strength', .5, 'positive')]),
    expect: { noMarket: true, notTags: ['above_market', 'below_market', 'with_market'] },
  });
  out.push({
    ...b0, id: 'edge:above-market', description: 'modèle bien au-dessus du marché',
    bet: mlHome, result: result(70, [imp('team_strength', .5, 'positive')]),
    expect: { tags: ['above_market'] },
  });
  out.push({
    game: 'Suzuki-MTL', id: 'edge:player-prop', description: 'pari joueur : lignes du client, pas de classement du modèle',
    bet: {
      type: 'player', label: 'Nick Suzuki 1+ point', mlPct: 58, bookOdds: 1.9,
      extraFacts: [
        'Saison de Nick Suzuki (MTL) : 12 MJ, 5 B, 9 A, 14 PTS (1,17 pt/match)',
        'Cadence : 1,17 point/match contre une ligne de 0,5',
        'Utilisation : 20,1 min/match, tirs 11,2 %, +3',
        'Adversaire — TOR : fiche 8-3-1, 10 derniers 6-3-1, buts pour/contre 3,20/3,00, AN 23,1 %, DN 79,0 %',
      ],
    },
    features: {}, result: null, lambdaHome: null, lambdaAway: null,
    expect: { dominant: false },
  });
  return out;
}
