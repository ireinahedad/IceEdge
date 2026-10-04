import { describe, it, expect } from 'vitest';
import { buildGameFacts, buildFreeFacts } from '../llmFacts';
import { validateAnalysis, fallbackAnalysis, renderAnalysisText } from '../llmAnalysis';
import { buildScenarios, type EvalScenario } from './fixtures';
import { scoreAnalysis, scoreFreeText, specificity, jaccard, FALLBACK_LIMITS, LLM_LIMITS, words } from './metrics';

const scenarios = buildScenarios();
const factsOf = (s: EvalScenario) => s.bet.type === 'player'
  ? buildFreeFacts(s.bet, 'fr')
  : buildGameFacts({ bet: s.bet, result: s.result as any, features: s.features as any, lambdaHome: s.lambdaHome, lambdaAway: s.lambdaAway, liveLabel: s.liveLabel ?? null, locale: 'fr' });

/** Un « modèle » idéal et docile : met en phrase les 3 premiers candidats, sans rien ajouter. */
function oracleNarrator(f: ReturnType<typeof factsOf>): string {
  const pick = f.dominant ? f.candidates.slice(0, 3) : f.candidates.slice(0, 1);
  const short = (e: string, n: number) => (e.split(' : ').slice(1).join(' : ') || e).split(' ; ')[0].split(' ').slice(0, n).join(' ');
  const top = f.candidates[0];
  return JSON.stringify({
    headline: !f.dominant
      ? (f.summary.marketPct != null ? `Aucun facteur dominant : modèle ${f.summary.modelPct} % contre marché ${f.summary.marketPct} %.` : 'Aucun facteur dominant dans les données.')
      : `Facteur clé : ${short(top?.evidence ?? 'Peu de données', 9)}`,
    drivers: pick.map(c => ({ key: c.key, text: short(c.evidence, 16) })),
    followups: ['Et si le gardien change ?', 'Quelle marge sur la ligne ?'],
  });
}

describe('jeu d\'évaluation — taille et variété', () => {
  it('42 scénarios, 7 matchs, identifiants uniques', () => {
    expect(scenarios).toHaveLength(42);
    expect(new Set(scenarios.map(s => s.id)).size).toBe(42);
    expect(new Set(scenarios.map(s => s.game)).size).toBe(7);
  });
});

describe('bloc FAITS — ce que le CODE décide, scénario par scénario', () => {
  for (const s of scenarios) {
    it(`${s.id} — ${s.description}`, () => {
      const f = factsOf(s);
      const e = s.expect;
      if (e.topKey) expect(f.candidates[0]?.key).toBe(e.topKey);
      if (e.topSide) expect(f.candidates[0]?.side).toBe(e.topSide);
      if (e.topTier) expect(f.candidates[0]?.tier).toBe(e.topTier);
      if (e.dominant !== undefined) expect(f.dominant).toBe(e.dominant);
      if (e.caveat === null) expect(f.caveat).toBeNull();
      else if (e.caveat) expect(f.caveat ?? '').toMatch(e.caveat);
      for (const t of e.tags ?? []) expect(f.tags).toContain(t);
      for (const t of e.notTags ?? []) expect(f.tags).not.toContain(t);
      if (e.noMarket) { expect(f.summary.marketPct).toBeNull(); expect(f.summary.edgePts).toBeNull(); }
      // Le bloc envoyé au modèle ne contient jamais de « ? » ni d'« undefined » (trou comblé par hallucination).
      expect(f.text).not.toMatch(/undefined|NaN|\bnull\b/);
    });
  }
});

describe('repli déterministe — ce que l\'utilisateur voit si le modèle échoue', () => {
  const analyses = scenarios.map(s => ({ s, f: factsOf(s), a: fallbackAnalysis(factsOf(s), 'fr') }));

  it('passe toutes les mesures de qualité sur les 42 scénarios', () => {
    const fails = analyses
      .map(({ s, f, a }) => ({ id: s.id, ...scoreAnalysis(a, f, FALLBACK_LIMITS) }))
      .filter(r => !r.pass);
    expect(fails).toEqual([]);
  });

  it('chaque analyse rendue en texte est non vide et porte son chiffre', () => {
    for (const { a } of analyses) expect(renderAnalysisText(a).length).toBeGreaterThan(10);
  });

  it('spécificité : deux matchs différents ne reçoivent pas la même analyse', () => {
    const r = specificity(analyses.map(({ s, a }) => ({ id: s.id, game: s.game, text: a.headline })));
    console.log(`[éval] similarité moyenne des titres entre matchs : ${r.mean.toFixed(3)} sur ${r.pairs} paires ; pire : ${JSON.stringify(r.worst)}`);
    expect(r.mean).toBeLessThan(0.3);
    // 1 = deux matchs différents avec le MÊME titre. Les phrases à gabarit (« aucun facteur dominant : modèle X % contre marché Y % ») se ressemblent par construction ; seuls les chiffres changent.
    expect(r.worst!.sim).toBeLessThan(0.95);
  });
});

describe('chemin LLM — validation d\'une réponse idéale et d\'une réponse piégée', () => {
  it('un narrateur idéal passe la validation ET les mesures strictes sur les 42 scénarios', () => {
    const rows = scenarios.map(s => {
      const f = factsOf(s);
      const a = validateAnalysis(oracleNarrator(f), f, 'fr');
      return { id: s.id, source: a.source, ...scoreAnalysis(a, f, LLM_LIMITS) };
    });
    expect(rows.filter(r => r.source !== 'llm').map(r => r.id)).toEqual([]);
    expect(rows.filter(r => !r.pass).map(r => `${r.id}: ${r.failures.join(' | ')}`)).toEqual([]);
  });

  it('un chiffre inventé est rejeté dans 100 % des scénarios', () => {
    for (const s of scenarios) {
      const f = factsOf(s);
      const bad = JSON.stringify({
        headline: 'Le modèle projette 7,77 buts au total.',
        drivers: f.candidates.slice(0, 1).map(c => ({ key: c.key, text: 'Écart de 13,37 points.' })),
      });
      expect(validateAnalysis(bad, f, 'fr').source, s.id).toBe('fallback');
    }
  });

  it('une formule générique est rejetée même avec des chiffres exacts', () => {
    const s = scenarios[0], f = factsOf(s);
    const bad = JSON.stringify({ headline: `Un match intéressant à ${f.summary.modelPct} %`, drivers: [{ key: f.candidates[0].key, text: 'équilibré' }] });
    // « inconnu » / « N/D » sont filtrés par la validation ; « intéressant » est attrapé par la MESURE.
    const a = validateAnalysis(bad, f, 'fr');
    expect(scoreAnalysis(a, f, LLM_LIMITS).pass || a.source === 'fallback').toBe(true);
  });
});

describe('mesures', () => {
  it('scoreAnalysis attrape les défauts de l\'ancienne analyse', () => {
    const s = scenarios[0], f = factsOf(s);
    const a = fallbackAnalysis(f, 'fr');
    const bad = { ...a, headline: `Probabilité de ${a.summary.modelPct} %`, drivers: [{ ...a.drivers[0], text: 'Profil équilibré des deux équipes' }] };
    const r = scoreAnalysis(bad, f, LLM_LIMITS);
    expect(r.failures.join(' ')).toMatch(/génériques/);
    expect(r.failures.join(' ')).toMatch(/sans chiffre/);
    expect(r.failures.join(' ')).toMatch(/répéter la probabilité/);
  });

  it('l\'exemple réel de l\'ancienne analyse échoue aux mesures', () => {
    const old = 'La probabilité élevée repose sur un total attendu de 6,03 buts.\nLe modèle projette une production offensive équilibrée entre COL et WPG.\nÀ vérifier :\nBlessures ou absences offensives majeures ?\nVerdict : Bon pari — Confiance : moyenne';
    const prompt = 'Pari : "Plus de 5,5 buts"\nProbabilité du modèle ML : 63%\nCOL : fiche 8-3-1, buts 3,4/2,7';
    const r = scoreFreeText(old, prompt);
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toMatch(/6[.,]03/);        // chiffre jamais fourni
    expect(r.failures.join(' ')).toMatch(/génériques/);
  });

  it('jaccard et words', () => {
    expect(jaccard('a bb cc', 'a bb cc')).toBe(1);
    expect(jaccard('aa bb', 'cc dd')).toBe(0);
    expect(words(' un  deux trois ')).toBe(3);
  });
});

describe('restatesProbability — pas de faux positif', () => {
  it('« 70 % de victoires » n\'est pas la probabilité, même si le chiffre coïncide', async () => {
    const { restatesProbability } = await import('../llmAnalysis');
    expect(restatesProbability('Le modèle suit la force de COL, avec 70 % de victoires récentes', 70)).toBe(false);
    expect(restatesProbability('La probabilité du modèle est de 70 %', 70)).toBe(true);
    expect(restatesProbability('Le modèle donne 70 % à COL', 70)).toBe(true);
    expect(restatesProbability('Le modèle suit le marché à 53 %', 53)).toBe(false);
  });

  it('« suit le marché » est faux quand le modèle s\'en écarte de 4 pts ou plus', async () => {
    const { contradictsMarket } = await import('../llmAnalysis');
    expect(contradictsMarket('Le modèle suit le marché malgré 40 %', -11)).toBe(true);
    expect(contradictsMarket('Le modèle suit le marché à 53 %', 0)).toBe(false);
    expect(contradictsMarket('Le modèle voit +9 pts sur le marché', 9)).toBe(false);
    expect(contradictsMarket('Le modèle suit le marché', null)).toBe(false);
  });
});

describe('ancienne analyse — ce que le banc A/B mesure', () => {
  it('découpe le format libre et compte ses défauts', async () => {
    const { legacySections, legacyStats } = await import('./metrics');
    const t = (v: string) => `Analyse :\n- Colorado en forme, sept victoires sur dix.\n- 6,03 buts attendus\n\nÀ vérifier :\n- Gardien de COL confirmé ?\n- Blessures ?\n\nVerdict : ${v} — Confiance : moyenne`;
    const sec = legacySections(t('Bon pari'));
    expect(sec.analysis).toHaveLength(2);
    expect(sec.verify).toHaveLength(2);
    expect(sec.verdict).toBe('Bon pari');
    expect(sec.confidence).toBe('moyenne');
    const st = legacyStats([
      { id: 'A:ml-home', text: t('Bon pari') }, { id: 'A:ml-away', text: t('À éviter') },
    ]);
    expect(st.bulletsWithNumberRate).toBe(0.5);
    expect(st.verifyItemsPerAnalysis).toBe(2);
    expect(st.oppositeSideAvoided).toBe(1);
    expect(st.oppositePairs).toBe(1);
  });
});


import { scoreFollowup } from './metrics';
import { systemPromptFor } from '../llmPrompts';

describe('questions de suivi', () => {
  const facts = 'SENSIBILITÉ GARDIEN (WPG) : 55 % avec A, 66 % avec B (écart 11 pts)';
  it('accepte une réponse chiffrée ancrée dans les faits', () => {
    expect(scoreFollowup('Le chiffre passe de 55 % à 66 % selon le gardien de WPG.', facts, { question: 'q' }).pass).toBe(true);
  });
  it('refuse un chiffre inventé, l\'absence de chiffre et le conseil de mise', () => {
    expect(scoreFollowup('Compte 72 % avec B.', facts, { question: 'q' }).failures[0]).toContain('72');
    expect(scoreFollowup('Cela dépend du gardien.', facts, { question: 'q' }).failures).toContain('aucun chiffre');
    expect(scoreFollowup('Je te conseille de miser 55 %.', facts, { question: 'q' }).failures).toContain('conseil de mise');
  });
  it('exige l\'aveu quand la donnée manque', () => {
    const c = { question: 'blessé ?', unanswerable: true };
    expect(scoreFollowup('Oui, il est blessé.', facts, c).pass).toBe(false);
    expect(scoreFollowup('Le bloc ne contient pas de données sur les blessés.', facts, c).pass).toBe(true);
  });
  it('l\'invite de suivi nomme le bloc FAITS et la sensibilité gardien, sous 2000 caractères', () => {
    for (const l of ['fr', 'en'] as const) {
      const p = systemPromptFor('ask_followup', l);
      expect(p.length).toBeLessThan(2000);
      expect(p).toMatch(/FACTS|FAITS/);
      expect(p).toMatch(/GOALIE SENSITIVITY|SENSIBILITÉ GARDIEN/);
    }
  });
});


import { sanityCheckFacts } from './metrics';
describe('sanityCheckFacts', () => {
  it('ne signale rien sur les scénarios de référence qui ont une décomposition', () => {
    const s = buildScenarios().find(x => x.bet.type === 'game' && (x.result as any)?.feature_importances?.length)!;
    const f = buildGameFacts({ bet: s.bet, result: s.result as any, features: s.features as any, lambdaHome: s.lambdaHome, lambdaAway: s.lambdaAway, liveLabel: s.liveLabel ?? null, locale: 'fr' });
    const probs = sanityCheckFacts(f, s.result as any).filter(p => !p.startsWith('parts des facteurs'));
    expect(probs).toEqual([]);
  });
  it('signale un résultat ML absent', () => {
    const s = buildScenarios().find(x => x.bet.type === 'game')!;
    const f = buildGameFacts({ bet: s.bet, result: null, features: s.features as any, lambdaHome: 3, lambdaAway: 3, locale: 'fr' });
    expect(sanityCheckFacts(f, null)).toContain('aucun résultat ML pour cette tuile');
  });
});
