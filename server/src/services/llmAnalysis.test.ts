import { describe, it, expect } from 'vitest';
import { buildGameFacts, type BetDescriptor } from './llmFacts';
import { EXPLAIN_BET_V2, validateAnalysis, renderAnalysisText, ungroundedNumbers, fallbackAnalysis } from './llmAnalysis';

const features: any = {
  home_team: 'COL', away_team: 'WPG',
  home_win_pct: 0.64, away_win_pct: 0.52, home_goals_for_pg: 3.4, away_goals_for_pg: 2.8,
  home_goals_against_pg: 2.7, away_goals_against_pg: 3.3,
  home_pp_pct: 27.4, away_pp_pct: 18, home_pk_pct: 82, away_pk_pct: 74.1,
  home_last10_win_pct: 0.7, away_last10_win_pct: 0.4, home_home_win_pct: 0.7, away_road_win_pct: 0.41,
  home_shots_for_pg: 31.2, away_shots_for_pg: 29, home_shots_against_pg: 27.5, away_shots_against_pg: 30.1,
  home_rest_days: 2, away_rest_days: 0, home_b2b: 0, away_b2b: 1, total_line_market: 5.5,
  home_goalie: 'A', away_goalie: 'B',
};
const over: BetDescriptor = { type: 'game', label: 'Over 5.5', propType: 'total_goals_over', line: 5.5, gameId: '1' };
const facts = (o: Record<string, unknown> = {}) => buildGameFacts({
  bet: over, features: { ...features, ...o }, lambdaHome: 3.4, lambdaAway: 2.63, locale: 'fr',
  result: { probability: 62, confidence: 70, model_version: 'v', model_type: 't', explanation: '', feature_importances: [] } as any,
});

describe('invites système', () => {
  it('tiennent sous la borne sur laquelle le plafond mensuel est calculé (2 000 caractères)', () => {
    expect(EXPLAIN_BET_V2.fr.length).toBeLessThan(2000);
    expect(EXPLAIN_BET_V2.en.length).toBeLessThan(2000);
  });
});

describe('ungroundedNumbers', () => {
  it('accepte un nombre des faits, virgule ou point, et son arrondi', () => {
    expect(ungroundedNumbers('Total attendu 6,03 contre 5,5', 'Total attendu 6,03 ... ligne de 5,5')).toEqual([]);
    expect(ungroundedNumbers('environ 6 buts', 'Total attendu 6,03')).toEqual([]);
  });
  it('refuse un nombre absent des faits', () => {
    expect(ungroundedNumbers('7,2 buts attendus', 'Total attendu 6,03')).toEqual([7.2]);
  });
});

describe('validateAnalysis', () => {
  const good = JSON.stringify({
    headline: 'Total attendu 6,03 contre une ligne de 5,5.',
    drivers: [
      { key: 'special_teams', text: 'AN COL 27,4 % face à une DN WPG de 74,1 %.' },
      { key: 'expected_total', text: 'COL 3,4 et WPG 2,63 buts attendus.' },
    ],
    followups: ['Et si le gardien change ?', 'Quelle marge sur la ligne ?', 'troisième ignorée'],
  });

  it('accepte une réponse ancrée, remet les facteurs dans l\'ordre du CODE et recolle niveau/sens', () => {
    const a = validateAnalysis(good, facts(), 'fr');
    expect(a.source).toBe('llm');
    expect(a.drivers[0]).toMatchObject({ key: 'expected_total', tier: 'major', side: 'for' });
    expect(a.followups).toHaveLength(2);
  });

  it('un chiffre inventé fait tomber sur le texte déterministe', () => {
    const bad = JSON.stringify({ headline: 'Total attendu 7,41 buts.', drivers: [{ key: 'expected_total', text: 'x 7,41' }] });
    const a = validateAnalysis(bad, facts(), 'fr');
    expect(a.source).toBe('fallback');
    expect(a.headline).toContain('6,03');
  });

  it('une clé inconnue est ignorée ; sans aucune clé valable : repli', () => {
    const bad = JSON.stringify({ headline: 'Total 6,03', drivers: [{ key: 'inventé', text: 'AN 27,4' }] });
    expect(validateAnalysis(bad, facts(), 'fr').source).toBe('fallback');
  });

  it('refuse « inconnu » / « N/D »', () => {
    const bad = JSON.stringify({ headline: 'Total attendu 6,03', drivers: [{ key: 'expected_total', text: 'Gardien inconnu 6,03' }] });
    expect(validateAnalysis(bad, facts(), 'fr').source).toBe('fallback');
  });

  it('du texte qui n\'est pas du JSON : repli, jamais une erreur', () => {
    expect(validateAnalysis('Analyse : bla bla', facts(), 'fr').source).toBe('fallback');
    expect(validateAnalysis('', facts(), 'fr').source).toBe('fallback');
  });

  it('tolère une clôture ```json', () => {
    expect(validateAnalysis('```json\n' + good + '\n```', facts(), 'fr').source).toBe('llm');
  });

  it('sans facteur MAJEUR, un seul moteur est gardé', () => {
    const f = facts();
    f.candidates = f.candidates.map(c => ({ ...c, tier: 'minor' as const }));
    f.dominant = false;
    const a = validateAnalysis(good, f, 'fr');
    expect(a.drivers).toHaveLength(1);
  });
});

describe('rendu et repli', () => {
  it('le texte rendu porte ▲ / ▼ / • et la réserve', () => {
    const a = validateAnalysis(JSON.stringify({
      headline: 'Total attendu 6,03.', drivers: [{ key: 'expected_total', text: 'Ligne de 5,5.' }],
    }), facts({ home_goalie: undefined, away_goalie: undefined }), 'fr');
    const t = renderAnalysisText(a);
    expect(t).toContain('▲ Ligne de 5,5.');
    expect(t).toContain('non confirmés');
  });

  it('le repli ne répète pas la même phrase en titre et en moteur', () => {
    const a = fallbackAnalysis(facts(), 'fr');
    expect(a.drivers.every(d => d.text !== a.headline)).toBe(true);
  });
});
