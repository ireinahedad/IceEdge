/**
 * metrics.ts — les mesures du jeu d'évaluation de l'« Analyse IA ».
 *
 * Chaque mesure répond à un défaut CONSTATÉ de l'ancienne analyse :
 *
 *   • `ungrounded`      — un chiffre que personne n'a donné au modèle (le « 6,03
 *                         buts attendus » sorti de nulle part) ;
 *   • `generic`         — « équilibré », « solide », « à vérifier », « Verdict » ;
 *   • `driversWithoutNumber` — une puce qui ne dit rien de mesurable ;
 *   • `restatesProbability`  — un titre qui répète le % déjà affiché ;
 *   • longueur          — un lecteur pressé ne lit pas 40 mots par puce ;
 *   • spécificité       — deux matchs différents ne doivent pas recevoir la
 *                         même analyse (similarité de Jaccard entre titres).
 *
 * PUR : aucune entrée-sortie.
 */

import type { Analysis } from '../llmAnalysis';
import { ungroundedNumbers, restatesProbability, contradictsMarket, GENERIC_PHRASES } from '../llmAnalysis';
import type { Facts } from '../llmFacts';

export { GENERIC_PHRASES };

export const words = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;
const hasNumber = (s: string): boolean => /\d/.test(s);

export interface Limits { headlineWords: number; driverWords: number }
/** Réponse du modèle : serrée. Repli déterministe (phrases du code) : plus large. */
export const LLM_LIMITS: Limits = { headlineWords: 18, driverWords: 20 };
export const FALLBACK_LIMITS: Limits = { headlineWords: 32, driverWords: 32 };

export interface Score {
  failures: string[];
  pass: boolean;
  headlineWords: number;
  maxDriverWords: number;
  drivers: number;
}

export function scoreAnalysis(a: Analysis, facts: Facts, limits: Limits = LLM_LIMITS): Score {
  const failures: string[] = [];
  const body = [a.headline, ...a.drivers.map(d => d.text)].join(' ');

  const bad = ungroundedNumbers(body, facts.text);
  if (bad.length) failures.push(`chiffres hors faits : ${bad.join(', ')}`);

  const generic = GENERIC_PHRASES.filter(re => re.test(body)).map(re => re.source);
  if (generic.length) failures.push(`formules génériques : ${generic.join(', ')}`);

  const silent = a.drivers.filter(d => !hasNumber(d.text)).length;
  if (silent) failures.push(`${silent} puce(s) sans chiffre`);

  if (restatesProbability(a.headline, a.summary.modelPct)) failures.push('le titre ne fait que répéter la probabilité');

  const hw = words(a.headline);
  if (hw > limits.headlineWords) failures.push(`titre trop long (${hw} mots)`);
  const dw = Math.max(0, ...a.drivers.map(d => words(d.text)));
  if (dw > limits.driverWords) failures.push(`puce trop longue (${dw} mots)`);

  if (a.drivers.length > 3) failures.push('plus de 3 moteurs');
  if (!a.dominant && a.drivers.length > 1) failures.push('aucun facteur majeur mais plusieurs moteurs');

  if (contradictsMarket(a.headline, a.summary.edgePts)) failures.push('« suit le marché » alors que le modèle s\'en écarte de 4 pts ou plus');

  const texts = a.drivers.map(d => d.text);
  if (new Set(texts).size !== texts.length || texts.includes(a.headline)) failures.push('texte répété');

  return { failures, pass: failures.length === 0, headlineWords: hw, maxDriverWords: dw, drivers: a.drivers.length };
}

/** Texte libre (ancienne analyse) : mêmes défauts, mesurés sur le texte entier. */
export function scoreFreeText(text: string, promptText: string): { failures: string[]; pass: boolean } {
  const failures: string[] = [];
  const bad = ungroundedNumbers(text, promptText);
  if (bad.length) failures.push(`chiffres hors prompt : ${bad.join(', ')}`);
  const generic = GENERIC_PHRASES.filter(re => re.test(text)).map(re => re.source);
  if (generic.length) failures.push(`formules génériques : ${generic.join(', ')}`);
  return { failures, pass: failures.length === 0 };
}

// ─── Cohérence d'un bloc FAITS sur données réelles ───────────────────────────

/**
 * Contrôles qu'aucune fixture ne peut faire : le bloc bâti sur la sortie RÉELLE
 * du modèle tient-il debout ? Rend la liste des anomalies (vide = tout va bien).
 */
export function sanityCheckFacts(facts: Facts, result: { probability?: number; feature_importances?: Array<{ name: string; importance: number }> } | null): string[] {
  const out: string[] = [];
  const s = facts.summary;
  if (!result) out.push('aucun résultat ML pour cette tuile');
  if (s.modelPct != null && (s.modelPct < 0 || s.modelPct > 100)) out.push(`modelPct hors 0–100 : ${s.modelPct}`);
  if (s.modelPct != null && s.marketPct != null && s.edgePts !== s.modelPct - s.marketPct) out.push(`écart incohérent : ${s.edgePts} ≠ ${s.modelPct} − ${s.marketPct}`);
  if (s.fairOdds != null && s.modelPct) {
    const exp = 100 / s.modelPct;
    if (Math.abs(exp - s.fairOdds) > 0.02) out.push(`cote juste ${s.fairOdds} ≠ 100/${s.modelPct}`);
  }
  const imps = (result?.feature_importances ?? []).filter(f => f.name.startsWith('factor.'));
  if (imps.length) {
    const sum = imps.reduce((a, f) => a + f.importance, 0);
    // La liste est tronquée (« autres » omis) : sous 1 est normal, au-dessus ne l'est pas.
    if (sum > 1.03 || sum < 0.8) out.push(`parts des facteurs : somme ${sum.toFixed(2)} ≠ 1`);
  } else if (result && facts.family !== 'free') {
    out.push('pas de décomposition factor.* (classifieur global ?) : les candidats viennent des stats brutes');
  }
  if (facts.candidates.length === 0) out.push('aucun candidat');
  if (facts.dominant !== facts.candidates.some(c => c.tier === 'major')) out.push('dominant incohérent avec les niveaux');
  const keys = facts.candidates.map(c => c.key);
  if (new Set(keys).size !== keys.length) out.push('clés de candidats en double');
  for (const c of facts.candidates) if (!/\d/.test(c.evidence)) out.push(`candidat « ${c.key} » sans chiffre`);
  for (const c of facts.candidates) if (/(?:^|[^\d,.])0 %/.test(c.evidence) && !/pèse|carries/.test(c.evidence)) out.push(`candidat « ${c.key} » avec une stat à 0 % (échantillon minuscule ?)`);
  if (/NaN|undefined|null|Infinity/.test(facts.text)) out.push('NaN / undefined dans le texte du bloc');
  return out;
}

// ─── Questions de suivi ──────────────────────────────────────────────────────

/** Aveu explicite d'une donnée absente du bloc FAITS. */
const MISSING_RE = /(ne contient pas|n'a pas|n'ai pas|pas de donn|aucune donn|pas (?:d'|de )?(?:info|stat)|manque|does not (?:contain|include)|doesn't (?:contain|include)|no .*data|not in the (?:block|data)|missing)/i;
const STAKING_RE = /\b(je (?:te )?(?:conseille|recommande)|mise(?:z|r)?\b|parie(?:z|r)? (?:sur|gros)|bet (?:on|big)|i recommend|stake)\b/i;

export interface FollowupCase { question: string; /** La réponse n'est PAS dans les faits : l'aveu est attendu, pas un chiffre. */ unanswerable?: boolean }

export function scoreFollowup(answer: string, promptText: string, c: FollowupCase): { failures: string[]; pass: boolean } {
  const failures: string[] = [];
  const a = answer.trim();
  if (!a) return { failures: ['réponse vide'], pass: false };
  const bad = ungroundedNumbers(a, promptText);
  if (bad.length) failures.push(`chiffres hors faits : ${bad.join(', ')}`);
  const sentences = a.split(/(?<=[.!?])\s+/).filter(Boolean).length;
  if (sentences > 5 || words(a) > 90) failures.push(`trop long (${sentences} phrases, ${words(a)} mots)`);
  if (STAKING_RE.test(a)) failures.push('conseil de mise');
  if (c.unanswerable) {
    if (!MISSING_RE.test(a)) failures.push('n\'avoue pas la donnée manquante');
  } else if (!/\d/.test(a) && !MISSING_RE.test(a)) {
    // Pas de chiffre n'est acceptable seulement si le modèle avoue honnêtement
    // que le bloc ne contient pas la donnée (ex. sensibilité gardien absente).
    failures.push('aucun chiffre');
  }
  return { failures, pass: failures.length === 0 };
}

// ─── Ancienne analyse (texte libre) : ce qu'elle disait vraiment ─────────────

export interface LegacySections { analysis: string[]; verify: string[]; verdict: string | null; confidence: string | null }

/** Découpe « Analyse / À vérifier / Verdict — Confiance » de l'ancien format. */
export function legacySections(text: string): LegacySections {
  const bullets = (s: string) => s.split('\n').map(l => l.trim()).filter(l => l.startsWith('-')).map(l => l.replace(/^-\s*/, ''));
  const [head, rest = ''] = text.split(/À vérifier\s*:/i);
  const [verify] = rest.split(/Verdict\s*:/i);
  return {
    analysis: bullets(head),
    verify: bullets(verify),
    verdict: /Verdict\s*:\s*([^—\-\n]+)/i.exec(text)?.[1]?.trim() ?? null,
    confidence: /Confiance\s*:\s*([^\s.\n]+)/i.exec(text)?.[1]?.trim() ?? null,
  };
}

export interface LegacyStats {
  analyses: number;
  bullets: number;
  bulletsWithNumberRate: number;
  verifyItemsPerAnalysis: number;
  verdicts: Record<string, number>;
  confidences: Record<string, number>;
  /** Contenu générique, HORS étiquettes du format (« À vérifier », « Verdict »). */
  genericInContent: number;
  /** Paires opposées (dom./ext., Over/Under) dont le côté visiteur / Under reçoit « À éviter ». */
  oppositeSideAvoided: number;
  oppositePairs: number;
}

export function legacyStats(rows: Array<{ id: string; text: string }>): LegacyStats {
  const secs = new Map(rows.map(r => [r.id, legacySections(r.text)] as const));
  let bullets = 0, withNum = 0, verify = 0, generic = 0;
  const verdicts: Record<string, number> = {}, confidences: Record<string, number> = {};
  for (const s of secs.values()) {
    for (const b of s.analysis) { bullets++; if (hasNumber(b)) withNum++; if (GENERIC_PHRASES.some(re => re.test(b))) generic++; }
    verify += s.verify.length;
    if (s.verdict) verdicts[s.verdict] = (verdicts[s.verdict] ?? 0) + 1;
    if (s.confidence) confidences[s.confidence] = (confidences[s.confidence] ?? 0) + 1;
  }
  let pairs = 0, avoided = 0;
  for (const [id] of secs) {
    const m = /^(.*):(ml-home|over)$/.exec(id);
    if (!m) continue;
    const other = secs.get(`${m[1]}:${m[2] === 'ml-home' ? 'ml-away' : 'under'}`);
    if (!other) continue;
    pairs++;
    if (/éviter/i.test(other.verdict ?? '')) avoided++;
  }
  const n = secs.size || 1;
  return {
    analyses: secs.size, bullets, bulletsWithNumberRate: bullets ? withNum / bullets : 0,
    verifyItemsPerAnalysis: verify / n, verdicts, confidences, genericInContent: generic,
    oppositeSideAvoided: avoided, oppositePairs: pairs,
  };
}

// ─── Spécificité ──────────────────────────────────────────────────────────────

const tokens = (s: string): Set<string> =>
  new Set(s.toLowerCase().replace(/[^\p{L}\p{N},.]+/gu, ' ').split(/\s+/).filter(t => t.length > 1));

export function jaccard(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export interface SpecItem { id: string; game: string; text: string }

/**
 * Similarité moyenne et pire paire ENTRE matchs différents. Deux analyses du
 * même match (Over / Under, dom. / ext.) ont le droit de se ressembler.
 */
export function specificity(items: SpecItem[]): { mean: number; worst: { a: string; b: string; sim: number } | null; pairs: number } {
  let sum = 0, pairs = 0;
  let worst: { a: string; b: string; sim: number } | null = null;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (items[i].game === items[j].game) continue;
      const sim = jaccard(items[i].text, items[j].text);
      sum += sim; pairs++;
      if (!worst || sim > worst.sim) worst = { a: items[i].id, b: items[j].id, sim };
    }
  }
  return { mean: pairs ? sum / pairs : 0, worst, pairs };
}
