import { describe, it, expect } from 'vitest';
import { buildGameFacts, type BetDescriptor } from './llmFacts';
import { systemPromptFor, LANGUAGE_RULE } from './llmPrompts';
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
    for (const task of ['explain_bet', 'ask_followup'] as const) {
      expect(systemPromptFor(task, 'fr').length).toBeLessThan(2000);
      expect(systemPromptFor(task, 'en').length).toBeLessThan(2000);
    }
  });

  it('imposent explicitement la langue de l\'app, quelle que soit la langue de la question', () => {
    for (const locale of ['fr', 'en'] as const) {
      expect(EXPLAIN_BET_V2[locale]).toContain(LANGUAGE_RULE[locale]);
      expect(systemPromptFor('explain_bet', locale).endsWith(LANGUAGE_RULE[locale])).toBe(true);
      expect(systemPromptFor('ask_followup', locale).endsWith(LANGUAGE_RULE[locale])).toBe(true);
    }
    expect(LANGUAGE_RULE.fr).toMatch(/en français/);
    expect(LANGUAGE_RULE.en).toMatch(/in English/);
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

describe('validateAnalysis — « aucun facteur majeur » démenti par le code', () => {
  it('rejette une thèse qui nie le facteur majeur alors qu\'il y en a un', () => {
    const facts: any = {
      family: 'sided', summary: {}, status: [], tags: [], caveat: null, dominant: true, text: 'Modèle 62 % · Calendrier : repos 2 j',
      candidates: [{ key: 'schedule', tier: 'major', side: 'for', share: 0.5, evidence: 'Calendrier : repos 2 j' }],
    };
    const raw = JSON.stringify({ headline: 'Aucun facteur majeur ne tranche', drivers: [{ key: 'schedule', text: 'Repos 2 j' }], followups: [] });
    expect(validateAnalysis(raw, facts, 'fr').source).toBe('fallback');
    const ok = JSON.stringify({ headline: 'Le calendrier porte le pari : 2 j de repos', drivers: [{ key: 'schedule', text: 'Repos 2 j' }], followups: [] });
    expect(validateAnalysis(ok, facts, 'fr').source).toBe('llm');
  });
});

describe('validateAnalysis — questions de suivi inventées', () => {
  it('écarte une question qui cite un chiffre absent des faits', () => {
    const facts: any = { family: 'sided', summary: {}, status: [], tags: [], caveat: null, dominant: true, text: 'Modèle 62 % · Calendrier : repos 2 j',
      candidates: [{ key: 'schedule', tier: 'major', side: 'for', share: 0.5, evidence: 'Calendrier : repos 2 j' }] };
    const raw = JSON.stringify({ headline: 'Le calendrier porte le pari : 2 j de repos', drivers: [{ key: 'schedule', text: 'Repos 2 j' }],
      followups: ['Le score de 2–0 change-t-il cette estimation ?', 'Et si le repos tombe à 2 j ?'] });
    expect(validateAnalysis(raw, facts, 'fr').followups).toEqual(['Et si le repos tombe à 2 j ?']);
  });
});

describe('nouvelles : leurs chiffres ne valent pas ancrage', () => {
  const withNews = () => buildGameFacts({
    bet: over, features, lambdaHome: 3.4, lambdaAway: 2.63, locale: 'fr', now: Date.parse('2026-10-23T22:30:00Z'),
    result: { probability: 62, confidence: 70, model_version: 'v', model_type: 't', explanation: '', feature_importances: [] } as any,
    news: [{ team: 'WPG', author: 'Jets', postedAt: '2026-10-23T22:00:00Z', excerpt: 'Scheifele out until game 49', flags: ['lineup'] }],
  });

  it('« 49 » est dans l’invite mais pas dans les chiffres autorisés', () => {
    const f = withNews();
    expect(f.text).toContain('until game 49');
    expect(ungroundedNumbers('absent 49 matchs', f.text)).toEqual([]);
    expect(ungroundedNumbers('absent 49 matchs', f.groundText!)).toEqual([49]);
  });

  it('même réponse : acceptée sans le chiffre de la nouvelle, refusée avec', () => {
    const f = withNews();
    const c = f.candidates[0];
    const ok = (headline: string) => JSON.stringify({ headline, drivers: [{ key: c.key, text: c.evidence }], followups: [] });
    expect(validateAnalysis(ok(`Scheifele absent ; ${c.evidence}`), f, 'fr').source).toBe('llm');
    expect(validateAnalysis(ok(`Scheifele absent 49 matchs ; ${c.evidence}`), f, 'fr').source).toBe('fallback');
  });
});
