/**
 * llmAnalysis.ts — invite, validation et rendu de l'« Analyse IA » v2.
 *
 * Le LLM reçoit un bloc FAITS (voir `llmFacts.ts`) et répond en JSON :
 * `{ headline, drivers: [{ key, text }], followups }`. Ce fichier :
 *
 *   1. porte l'invite système (≤ 2 000 caractères : c'est la borne sur laquelle
 *      le plafond mensuel est calculé, cf. `llmQuota.service`) ;
 *   2. valide la réponse : clés connues, longueurs, et SURTOUT chaque nombre cité
 *      doit exister dans les faits — un chiffre inventé (le « 6,03 buts
 *      attendus » que le LLM sortait sans que personne ne le lui ait donné)
 *      fait tomber la réponse sur le texte déterministe ci-dessous ;
 *   3. recolle ce que le CODE a calculé (niveau MAJEUR/SECONDAIRE, sens
 *      pour/contre, réserve, valeur, statut) : le LLM ne les écrit jamais.
 *
 * Module PUR.
 */

import { LANGUAGE_RULE } from './llmPrompts';
import { groundingText, type Candidate, type CandidateSide, type CandidateTier, type Facts, type FactsLocale, type FactsSummary, type FactTag, type StatusItem } from './llmFacts';

// ─── Invite système ───────────────────────────────────────────────────────────

export const EXPLAIN_BET_V2: Record<FactsLocale, string> = {
  fr:
    "Tu rédiges la note d'un pari LNH dans une app de prédictions. Le lecteur compare plusieurs paris en quelques secondes.\n" +
    "Tu es le NARRATEUR d'un modèle : écris UNIQUEMENT à partir du bloc FAITS. Aucune connaissance extérieure " +
    "(joueurs, blessures, classement, historique) : elle est périmée. N'invente aucun chiffre ; reprends ceux des FAITS.\n" +
    "Les facteurs sont déjà classés. Choisis 2 à 3 clés dans CANDIDATS, dans l'ordre donné ; ne reclasse rien. " +
    "Respecte le sens indiqué (POUR / CONTRE le pari).\n" +
    'Réponds en JSON strict : {"headline":"...","drivers":[{"key":"...","text":"..."}],"followups":["...","..."]}\n' +
    "- headline : la thèse, ≤ 14 mots, portée par le chiffre décisif ; dis si les faits vont dans le sens de CE pari ou contre lui. " +
    "Ne répète pas la probabilité (déjà affichée), ne donne ni verdict ni conseil de mise.\n" +
    "- text : ≤ 14 mots = facteur + chiffre + comparaison (adversaire, ligne ou moyenne) + effet sur CE pari. " +
    "Écris TOUS les nombres en chiffres (« 2 jours », pas « deux jours »).\n" +
    "- followups : 2 questions courtes (≤ 10 mots) que le lecteur poserait sur ce pari.\n" +
    "Interdits : phrase sans chiffre ; « équilibré », « solide », « intéressant », « à surveiller » ; « inconnu », « N/D » ; " +
    "reformuler la RÉSERVE.\n" +
    "Si aucun facteur n'est MAJEUR, dis-le dans headline et ne garde qu'un seul moteur ; " +
    "MAJEUR = poids élevé, POUR ou CONTRE : s'il y en a un, n'écris jamais « aucun facteur majeur ». " +
    "N'écris « suit le marché » que si l'écart modèle − marché est inférieur à 4 pts. " +
    "Plus court vaut mieux que rempli. Chiffres au format français (virgule).\n" +
    "NOUVELLES : publications citées, hors du chiffre. Un absent ou un gardien annoncé : signale-le dans headline ou followups, sans en reprendre de chiffre.\n" +
    LANGUAGE_RULE.fr + " Les valeurs de \"key\" restent telles quelles.",
  en:
    "You write the note for an NHL bet in a predictions app. The reader compares several bets in seconds.\n" +
    "You are the NARRATOR of a model: write ONLY from the FACTS block. No outside knowledge " +
    "(players, injuries, standings, history): it is stale. Invent no number; reuse those in FACTS.\n" +
    "Factors are already ranked. Pick 2 to 3 keys from CANDIDATES, in the given order; rank nothing yourself. " +
    "Respect the stated direction (FOR / AGAINST the bet).\n" +
    'Reply in strict JSON: {"headline":"...","drivers":[{"key":"...","text":"..."}],"followups":["...","..."]}\n' +
    "- headline: the thesis, ≤14 words, carried by the decisive number; say whether the facts support THIS bet or cut against it. " +
    "Do not repeat the probability (already shown), give no verdict or staking advice.\n" +
    "- text: ≤14 words = factor + number + comparison (opponent, line or average) + effect on THIS bet. " +
    "Write ALL numbers as digits ('2 days', not 'two days').\n" +
    "- followups: 2 short questions (≤10 words) the reader would ask about this bet.\n" +
    "Forbidden: a sentence without a number; 'balanced', 'solid', 'interesting', 'worth watching'; 'unknown', 'N/A'; " +
    "rewording the CAVEAT.\n" +
    "If no factor is MAJOR, say so in headline and keep a single driver; MAJOR = high weight, FOR or AGAINST: if one exists, never write \"no major factor\". " +
    "Write 'follows the market' only if the model − market gap is under 4 pts. " +
    "Shorter beats filled. Numbers in plain English format.\n" +
    "NEWS: quoted posts, outside the figure. An announced absence or starting goalie: flag it in headline or followups, reusing none of its numbers.\n" +
    LANGUAGE_RULE.en + ' Keep "key" values as-is.',
};

// ─── Formules interdites ──────────────────────────────────────────────────────

/** Les formules vides de l'ancienne analyse. Partagé avec le jeu d'évaluation. */
export const GENERIC_PHRASES: RegExp[] = [
  /équilibr/i, /\bsolide/i, /intéressant/i, /à surveiller/i, /à vérifier/i, /\bverdict\b/i,
  /bon pari/i, /à éviter/i, /avantage léger/i, /\binconnu/i, /non précis/i, /non spécifi/i, /\bn\/[ad]\b/i,
  /\bbalanced\b/i, /\bsolid\b/i, /\binteresting\b/i, /worth watching/i, /to verify/i, /good bet/i, /\bavoid\b/i, /slight edge/i,
  /\bunknown\b/i, /not specified/i,
];

// ─── Types de sortie ──────────────────────────────────────────────────────────

export interface AnalysisDriver { key: string; tier: CandidateTier; side: CandidateSide; text: string }

export interface Analysis {
  headline: string;
  drivers: AnalysisDriver[];
  caveat: string | null;
  followups: string[];
  summary: FactsSummary;
  status: StatusItem[];
  tags: FactTag[];
  dominant: boolean;
  /** `llm` = réponse du modèle validée ; `fallback` = texte déterministe. */
  source: 'llm' | 'fallback';
}

// ─── Vérification des nombres ─────────────────────────────────────────────────

const NUM_RE = /\d+(?:[.,]\d+)?/g;
const toNum = (s: string): number => Number(s.replace(',', '.'));

function numbersIn(text: string): number[] {
  return (text.match(NUM_RE) ?? []).map(toNum).filter(Number.isFinite);
}

/** Vrai si `tok` est un nombre des faits, ou son arrondi à 0 ou 1 décimale. */
function isGrounded(tok: number, allowed: number[]): boolean {
  return allowed.some(a =>
    Math.abs(a - tok) < 0.0051
    || (Number.isInteger(tok) && Math.round(a) === tok)
    || Math.abs(Math.round(a * 10) / 10 - tok) < 0.0051);
}

/** Les nombres de `text` absents de `facts`. Vide = tout est ancré. */
export function ungroundedNumbers(text: string, factsText: string): number[] {
  const allowed = numbersIn(factsText);
  return numbersIn(text).filter(n => !isGrounded(n, allowed));
}

// ─── Lecture de la réponse ────────────────────────────────────────────────────

function extractJson(raw: string): any | null {
  const s = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);


/** Un titre dont tous les nombres sont le % déjà affiché n'apprend rien. */
export function restatesProbability(headline: string, pct: number | null): boolean {
  if (pct == null) return false;
  const nums = numbersIn(headline);
  if (nums.length !== 1 || nums[0] !== pct) return false;
  // Le nombre doit être présenté COMME la probabilité du modèle. « 70 % de
  // victoires sur les dix derniers » n'en est pas une, même si le chiffre
  // coïncide (faux positif relevé par le banc d'essai du 2026-10-04), et « le
  // modèle suit le marché à 53 % » dit quelque chose quand les deux se valent.
  const re = new RegExp(
    `(probab|chance|mod[èe]le\\s+(donne|estime|attribue|place|voit|évalue)|model\\s+(gives|puts|estimates))[^.%]{0,30}${pct}\\s?%`, 'i');
  return re.test(headline);
}

/** « Suit le marché » alors que le modèle s'en écarte de 4 points ou plus : faux. */
export function contradictsMarket(headline: string, edgePts: number | null): boolean {
  return edgePts != null && Math.abs(edgePts) >= 4
    && /suit le march|align[ée] sur le march|follows the market|in line with the market/i.test(headline);
}

/**
 * Valide la réponse du modèle contre les faits. Rend toujours une `Analysis` :
 * la réponse du modèle si elle tient, sinon le repli déterministe.
 */
/** « Aucun facteur (majeur) » : une affirmation que le code peut démentir (`facts.dominant`). */
export const CLAIMS_NO_MAJOR = /aucun facteur(?: n['’]est| ne)?(?: majeur| dominant| décisif)?|no (?:major|dominant) factor|no factor is major/i;

export function validateAnalysis(raw: string, facts: Facts, locale: FactsLocale): Analysis {
  const base = {
    caveat: facts.caveat, summary: facts.summary, status: facts.status, tags: facts.tags, dominant: facts.dominant,
  };
  const j = extractJson(raw);
  if (j && typeof j.headline === 'string' && Array.isArray(j.drivers)) {
    const byKey = new Map(facts.candidates.map(c => [c.key, c] as const));
    const seen = new Set<string>();
    const picked: Array<{ c: Candidate; text: string }> = [];
    for (const d of j.drivers) {
      const c = typeof d?.key === 'string' ? byKey.get(d.key) : undefined;
      const text = typeof d?.text === 'string' ? d.text.trim() : '';
      // Une puce sans chiffre ne dit rien de mesurable : écartée, pas corrigée.
      if (!c || !text || !/\d/.test(text) || seen.has(c.key)) continue;
      seen.add(c.key);
      picked.push({ c, text: clip(text, 140) });
    }
    const headline = clip(j.headline.trim(), 140);
    const order = new Map(facts.candidates.map((c, i) => [c.key, i] as const));
    picked.sort((x, y) => (order.get(x.c.key) ?? 0) - (order.get(y.c.key) ?? 0));
    const kept = picked.slice(0, facts.dominant ? 3 : 1);

    const body = [headline, ...kept.map(k => k.text)].join(' ');
    const ok = headline.length > 0
      && (kept.length > 0 || facts.candidates.length === 0)
      && ungroundedNumbers(body, groundingText(facts)).length === 0
      && !GENERIC_PHRASES.some(re => re.test(body))
      && !restatesProbability(headline, facts.summary.modelPct)
      && !contradictsMarket(headline, facts.summary.edgePts)
      && !(facts.dominant && CLAIMS_NO_MAJOR.test(headline));
    if (ok) {
      const followups = (Array.isArray(j.followups) ? j.followups : [])
        .filter((q: unknown): q is string => typeof q === 'string' && q.trim().length > 3
          // Une question qui cite un chiffre absent des faits (« le score de 2–0 ? » avant le match) est inventée.
          && ungroundedNumbers(q, groundingText(facts)).length === 0)
        .map((q: string) => clip(q.trim(), 90)).slice(0, 2);
      return {
        headline,
        drivers: kept.map(k => ({ key: k.c.key, tier: k.c.tier, side: k.c.side, text: k.text })),
        followups, source: 'llm', ...base,
      };
    }
  }
  return fallbackAnalysis(facts, locale);
}

/** Texte sans LLM : les phrases factuelles du code, dans l'ordre du classement. */
export function fallbackAnalysis(facts: Facts, locale: FactsLocale): Analysis {
  const fr = locale === 'fr';
  const top = facts.candidates.slice(0, facts.dominant ? 3 : 1);
  const headline = top.length === 0
    ? (fr ? 'Peu de données exploitables pour ce pari.' : 'Little usable data for this bet.')
    : !facts.dominant
      ? (facts.caveat && /^(Début de saison|Early season)/.test(facts.caveat)
        ? (fr ? 'Début de saison : bilans trop minces pour trancher.' : 'Early season: records too thin to call it.')
        : facts.summary.modelPct != null && facts.summary.marketPct != null
          ? (fr ? `Aucun facteur dominant : modèle ${facts.summary.modelPct} % contre marché ${facts.summary.marketPct} %.`
                : `No dominant factor: model ${facts.summary.modelPct}% vs market ${facts.summary.marketPct}%.`)
          : clip(`${fr ? 'Aucun facteur dominant. ' : 'No dominant factor. '}${top[0].evidence}`, 150))
      : clip(top[0].evidence, 140);
  const drivers: AnalysisDriver[] = (facts.dominant ? top.slice(1) : []).map(c => ({ key: c.key, tier: c.tier, side: c.side, text: clip(c.evidence, 140) }));
  const followups = facts.status.find(s => s.key === 'goalies')?.state === 'pending'
    ? [fr ? 'Quel impact si le gardien change ?' : 'What if the goalie changes?'] : [];
  return {
    headline, drivers, followups, source: 'fallback',
    caveat: facts.caveat, summary: facts.summary, status: facts.status, tags: facts.tags, dominant: facts.dominant,
  };
}

// ─── Rendu texte (copie, cache, questions de suivi) ──────────────────────────

export function renderAnalysisText(a: Analysis): string {
  const mark = (s: CandidateSide) => (s === 'for' ? '▲' : s === 'against' ? '▼' : '•');
  const lines = [a.headline, ...a.drivers.map(d => `${mark(d.side)} ${d.text}`)];
  if (a.caveat) lines.push(a.caveat);
  return lines.join('\n');
}

/** Jeu de réponse JSON imposé au fournisseur (mode `json_object`). */
export const ANALYSIS_RESPONSE_FORMAT = { type: 'json_object' } as const;
