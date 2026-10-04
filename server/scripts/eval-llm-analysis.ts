/**
 * eval-llm-analysis.ts — banc d'essai EN DIRECT de l'« Analyse IA ».
 *
 * Fait tourner le VRAI modèle sur les 42 scénarios de `src/services/llmEval` et
 * les passe aux mêmes mesures que le test déterministe : chiffres hors faits,
 * formules génériques, puces sans chiffre, titre qui répète la probabilité,
 * longueur, spécificité entre matchs, taux de repli.
 *
 * Usage :
 *   OPENAI_API_KEY=sk-… npm run eval:llm
 *   npm run eval:llm -- --legacy        # ancienne invite libre, mêmes scénarios (A/B)
 *   npm run eval:llm -- --real          # les matchs RÉELS figés (llmEval/real/*.json) au lieu des 42 scénarios
 *   npm run eval:llm -- --followups     # questions de suivi (tâche ask_followup) sur le bloc FAITS
 *   npm run eval:llm -- --n=10          # les 10 premiers scénarios seulement
 *   npm run eval:llm -- --locale=en
 *   LLM_PRO_MODEL=gpt-5.6-luna npm run eval:llm
 *
 * Coût : ≤ 42 requêtes (≈ 1 000 tokens chacune). Rien n'est écrit en base ; le
 * rapport JSON va dans `server/eval-reports/`.
 *
 * ⚠️ Les scénarios sont SYNTHÉTIQUES : ce banc prouve que le modèle suit la
 * consigne (ancrage, sens, concision), pas qu'une analyse est « juste » sur un
 * vrai match. Pour cela, relire à la main un échantillon de sorties.
 */

import { promises as fs } from 'fs';
import fsSync from 'fs';
import path from 'path';
import { buildGameFacts, buildFreeFacts, type Facts } from '../src/services/llmFacts';
import { EXPLAIN_BET_V2, validateAnalysis, type Analysis } from '../src/services/llmAnalysis';
import { EXPLAIN_BET_LEGACY_FR } from './lib/legacyPrompt';
import { buildScenarios, type EvalScenario } from '../src/services/llmEval/fixtures';
import { systemPromptFor } from '../src/services/llmPrompts';
import { scoreFollowup, type FollowupCase } from '../src/services/llmEval/metrics';
import { scoreAnalysis, scoreFreeText, specificity, legacyStats, legacySections, LLM_LIMITS, FALLBACK_LIMITS } from '../src/services/llmEval/metrics';

const arg = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const LEGACY = flag('legacy');
const FOLLOWUPS = flag('followups');
const REAL = flag('real');
const LOCALE = (arg('locale') === 'en' ? 'en' : 'fr') as 'fr' | 'en';
const LIMIT = Number(arg('n')) || Infinity;
const MODEL = process.env.LLM_PRO_MODEL || 'gpt-5.6-luna';
const KEY = process.env.OPENAI_API_KEY?.trim();

/** Matchs réels figés par `check-real-facts.ts --freeze`, mis au format des scénarios. */
function realScenarios(): EvalScenario[] {
  const dir = path.join(__dirname, '..', 'src', 'services', 'llmEval', 'real');
  if (!fsSync.existsSync(dir)) return [];
  return fsSync.readdirSync(dir).filter(f => f.endsWith('.json'))
    .flatMap(f => JSON.parse(fsSync.readFileSync(path.join(dir, f), 'utf8')) as any[])
    .map(c => ({ ...c, game: `${c.features?.home_team}-${c.features?.away_team}`, id: c.id }) as EvalScenario);
}

function factsOf(s: EvalScenario): Facts {
  return s.bet.type === 'player'
    ? buildFreeFacts(s.bet, LOCALE)
    : buildGameFacts({
        bet: s.bet, result: s.result as any, features: s.features as any,
        lambdaHome: s.lambdaHome, lambdaAway: s.lambdaAway, liveLabel: s.liveLabel ?? null, locale: LOCALE,
        goalieSensitivities: (s as any).goalieSensitivities ?? ((s as any).goalieSensitivity ? [(s as any).goalieSensitivity] : []),
      });
}

/** L'ancien message utilisateur : le pari, le % ML et les stats de saison — rien d'autre. */
function legacyPrompt(s: EvalScenario, f: Facts): string {
  const t = s.features as any;
  const team = (a: string, side: 'home' | 'away') =>
    `${a} : buts ${String(t[`${side}_goals_for_pg`]).replace('.', ',')}/${String(t[`${side}_goals_against_pg`]).replace('.', ',')} pour/contre, ` +
    `AN ${t[`${side}_pp_pct`]} % DN ${t[`${side}_pk_pct`]} %, 10 derniers ${Math.round(t[`${side}_last10_win_pct`] * 10)}-${10 - Math.round(t[`${side}_last10_win_pct`] * 10)}`;
  const data = t.home_team ? `\nDonnées de l'application:\n${team(t.home_team, 'home')}\n${team(t.away_team, 'away')}\n` : '';
  return `L'application a déjà calculé une probabilité statistique pour ce pari. Donne le contexte que les chiffres ne captent pas.\n\n` +
    `Pari : "${s.bet.label}"\nProbabilité du modèle ML : ${f.summary.modelPct ?? 'indisponible'}%\n${data}` +
    `\nUtilise les « Données de l'application » ci-dessus comme des faits. Énumère les facteurs clés hors statistiques et signale seulement ce que je dois vérifier avant de parier.`;
}

async function chat(system: string, user: string, json: boolean): Promise<string> {
  const reasoning = /(^|\/)(gpt-5|gpt-6|o1|o3|o4)/.test(MODEL);
  const body: Record<string, unknown> = { model: MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  if (reasoning) { body.max_completion_tokens = 512; body.reasoning_effort = process.env.LLM_REASONING_EFFORT || 'none'; }
  else { body.max_tokens = 512; body.temperature = 0.3; }
  if (json) body.response_format = { type: 'json_object' };
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as any)?.choices?.[0]?.message?.content ?? '';
}

interface Row {
  id: string; game: string; source: string; pass: boolean; failures: string[];
  headline: string; drivers: string[]; raw?: string;
}

const FOLLOWUP_CASES: Record<'fr' | 'en', FollowupCase[]> = {
  fr: [
    { question: 'Et si le gardien change ?' },
    { question: 'Pourquoi le modèle est différent du marché ?' },
    { question: 'Quel est le principal risque de ce pari ?' },
    { question: 'Le meilleur marqueur de l\'équipe est-il blessé ?', unanswerable: true },
  ],
  en: [
    { question: 'What if the goalie changes?' },
    { question: 'Why does the model differ from the market?' },
    { question: 'What is the main risk of this bet?' },
    { question: 'Is the team\'s top scorer injured?', unanswerable: true },
  ],
};

async function runFollowups(scenarios: EvalScenario[]): Promise<void> {
  const rows: Row[] = [];
  for (const s of scenarios) {
    if (s.bet.type === 'player') continue;
    const f = factsOf(s);
    for (const c of FOLLOWUP_CASES[LOCALE]) {
      const prompt = `${LOCALE === 'fr' ? 'Pari' : 'Bet'} : "${s.bet.label}"\n\n${f.text}\n\n` +
        `${LOCALE === 'fr' ? 'Ton analyse précédente' : 'Your previous analysis'} :\n${f.candidates[0]?.evidence ?? ''}\n\n` +
        `${LOCALE === 'fr' ? 'Nouvelle question' : 'New question'} : ${c.question}`;
      try {
        const answer = await chat(systemPromptFor('ask_followup', LOCALE), prompt, false);
        const sc = scoreFollowup(answer, prompt, c);
        rows.push({ id: `${s.id} · ${c.question}`, game: s.game, source: 'followup', pass: sc.pass, failures: sc.failures, headline: answer, drivers: [] });
      } catch (err: any) {
        rows.push({ id: `${s.id} · ${c.question}`, game: s.game, source: 'error', pass: false, failures: [String(err?.message ?? err)], headline: '', drivers: [] });
      }
      process.stdout.write(rows[rows.length - 1].pass ? '.' : 'x');
    }
  }
  process.stdout.write('\n\n');
  const summary = {
    mode: 'followups', model: MODEL, locale: LOCALE, cases: rows.length,
    passed: rows.filter(r => r.pass).length, errors: rows.filter(r => r.source === 'error').length,
  };
  console.log(JSON.stringify(summary, null, 2));
  for (const r of rows.filter(x => !x.pass)) console.log(`\n✗ ${r.id}\n  ${r.failures.join('\n  ')}\n  « ${r.headline} »`);
  const dir = path.join(__dirname, '..', 'eval-reports');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-followups.json`);
  await fs.writeFile(file, JSON.stringify({ summary, rows }, null, 2));
  console.log(`\nRapport : ${file}`);
}

async function main(): Promise<void> {
  if (!KEY) { console.error('OPENAI_API_KEY absente — rien à évaluer.'); process.exit(1); }
  const scenarios = (REAL ? realScenarios() : buildScenarios()).slice(0, LIMIT);
  if (REAL && !scenarios.length) { console.error('Aucun match réel figé : lance d\'abord check:facts -- --game=<id> --freeze'); process.exit(1); }
  if (FOLLOWUPS) return runFollowups(scenarios);
  const rows: Row[] = [];

  for (const s of scenarios) {
    const f = factsOf(s);
    try {
      if (LEGACY) {
        const prompt = legacyPrompt(s, f);
        const raw = await chat(EXPLAIN_BET_LEGACY_FR, prompt, false);
        // Les étiquettes du format (« À vérifier », « Verdict ») ne comptent pas
        // comme « générique » ici : on juge le CONTENU, le format se lit dans
        // `legacyStats`. Le « titre » est la 1re puce, pas le mot « Analyse : ».
        const sec = legacySections(raw);
        const sc = scoreFreeText(sec.analysis.join('\n'), prompt);
        rows.push({ id: s.id, game: s.game, source: 'legacy', pass: sc.pass, failures: sc.failures, headline: sec.analysis[0] ?? '', drivers: sec.analysis.slice(1), raw });
      } else {
        const raw = await chat(EXPLAIN_BET_V2[LOCALE], f.text, true);
        const a: Analysis = validateAnalysis(raw, f, LOCALE);
        // Un repli est un ÉCHEC du modèle (ou de l'invite), pas un succès du code.
        const sc = scoreAnalysis(a, f, a.source === 'llm' ? LLM_LIMITS : FALLBACK_LIMITS);
        const failures = a.source === 'fallback' ? ['réponse rejetée par la validation → repli', ...sc.failures] : sc.failures;
        rows.push({ id: s.id, game: s.game, source: a.source, pass: failures.length === 0, failures, headline: a.headline, drivers: a.drivers.map(d => d.text), raw });
      }
    } catch (err: any) {
      rows.push({ id: s.id, game: s.game, source: 'error', pass: false, failures: [String(err?.message ?? err)], headline: '', drivers: [] });
    }
    process.stdout.write(rows[rows.length - 1].pass ? '.' : 'x');
  }
  process.stdout.write('\n\n');

  const ok = rows.filter(r => r.source !== 'error');
  const spec = specificity(ok.map(r => ({ id: r.id, game: r.game, text: r.headline })));
  const summary = {
    mode: LEGACY ? 'legacy' : REAL ? 'v2-real' : 'v2', model: MODEL, locale: LOCALE, scenarios: rows.length,
    passed: rows.filter(r => r.pass).length,
    fallbackRate: LEGACY ? null : rows.filter(r => r.source === 'fallback').length / rows.length,
    errors: rows.filter(r => r.source === 'error').length,
    meanTitleSimilarity: Number(spec.mean.toFixed(3)),
    worstPair: spec.worst,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (LEGACY) console.log(JSON.stringify({ legacyStats: legacyStats(ok.map(r => ({ id: r.id, text: r.raw ?? '' }))) }, null, 2));
  for (const r of rows.filter(x => !x.pass)) console.log(`\n✗ ${r.id} [${r.source}]\n  ${r.failures.join('\n  ')}\n  « ${r.headline} »`);

  const dir = path.join(__dirname, '..', 'eval-reports');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${summary.mode}.json`);
  await fs.writeFile(file, JSON.stringify({ summary, rows }, null, 2));
  console.log(`\nRapport : ${file}`);
}

main().catch(err => { console.error(err); process.exit(1); });
