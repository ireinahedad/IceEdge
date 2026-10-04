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

import type { Candidate, CandidateSide, CandidateTier, Facts, FactsLocale, FactsSummary, FactTag, StatusItem } from './llmFacts';

// ─── Invite système ───────────────────────────────────────────────────────────

export const EXPLAIN_BET_V2: Record<FactsLocale, string> = {
  fr:
    "Tu rédiges la note d'un pari LNH dans une app de prédictions. Le lecteur compare plusieurs paris en quelques secondes.\n" +
    "Tu es le NARRATEUR d'un modèle : écris UNIQUEMENT à partir du bloc FAITS. Aucune connaissance extérieure " +
    "(joueurs, blessures, classement, historique) : elle est périmée. N'invente aucun chiffre ; reprends ceux des FAITS.\n" +
    "Les facteurs sont déjà classés. Choisis 2 à 3 clés dans CANDIDATS, dans l'ordre donné ; ne reclasse rien. " +
    "Respecte le sens indiqué (POUR / CONTRE le pari).\n" +
    'Réponds en JSON strict : {"headline":"...","drivers":[{"key":"...","text":"..."}],"followups":["...","..."]}\n' +
    "- headline : la thèse du pari, ≤ 14 mots, portée par le chiffre décisif. Ne répète pas la probabilité (déjà affichée), " +
    "ne donne ni verdict ni conseil de mise.\n" +
    "- text : ≤ 14 mots = facteur + chiffre + comparaison (adversaire, ligne ou moyenne) + effet sur CE pari.\n" +
    "- followups : 2 questions courtes (≤ 10 mots) que le lecteur poserait sur ce pari.\n" +
    "Interdits : phrase sans chiffre ; « équilibré », « solide », « intéressant », « à surveiller » ; « inconnu », « N/D » ; " +
    "reformuler la RÉSERVE.\n" +
    "Si aucun facteur n'est MAJEUR, dis-le dans headline (ex. le modèle suit le marché) et ne garde qu'un seul moteur. " +
    "Plus court vaut mieux que rempli. Chiffres au format français (virgule).",
  en:
    "You write the note for an NHL bet in a predictions app. The reader compares several bets in seconds.\n" +
    "You are the NARRATOR of a model: write ONLY from the FACTS block. No outside knowledge " +
    "(players, injuries, standings, history): it is stale. Invent no number; reuse those in FACTS.\n" +
    "Factors are already ranked. Pick 2 to 3 keys from CANDIDATES, in the given order; rank nothing yourself. " +
    "Respect the stated direction (FOR / AGAINST the bet).\n" +
    'Reply in strict JSON: {"headline":"...","drivers":[{"key":"...","text":"..."}],"followups":["...","..."]}\n' +
    "- headline: the bet's thesis, ≤14 words, carried by the decisive number. Do not repeat the probability (already shown), " +
    "give no verdict or staking advice.\n" +
    "- text: ≤14 words = factor + number + comparison (opponent, line or average) + effect on THIS bet.\n" +
    "- followups: 2 short questions (≤10 words) the reader would ask about this bet.\n" +
    "Forbidden: a sentence without a number; 'balanced', 'solid', 'interesting', 'worth watching'; 'unknown', 'N/A'; " +
    "rewording the CAVEAT.\n" +
    "If no factor is MAJOR, say so in headline (e.g. the model follows the market) and keep a single driver. " +
    "Shorter beats filled. Numbers in plain English format.",
};

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

const BANNED = /\b(inconnu|non précisé|non spécifié|n\/a|n\/d|unknown|not specified|unclear)\b/i;

/**
 * Valide la réponse du modèle contre les faits. Rend toujours une `Analysis` :
 * la réponse du modèle si elle tient, sinon le repli déterministe.
 */
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
      if (!c || !text || seen.has(c.key)) continue;
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
      && ungroundedNumbers(body, facts.text).length === 0
      && !BANNED.test(body);
    if (ok) {
      const followups = (Array.isArray(j.followups) ? j.followups : [])
        .filter((q: unknown): q is string => typeof q === 'string' && q.trim().length > 3)
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
      ? (facts.tags.includes('with_market')
          ? (fr ? 'Aucun facteur dominant : le modèle suit le marché.' : 'No dominant factor: the model follows the market.')
          : (fr ? 'Aucun facteur dominant dans les données.' : 'No dominant factor in the data.'))
      : clip(top[0].evidence, 140);
  const drivers: AnalysisDriver[] = (facts.dominant ? top.slice(1) : top).map(c => ({ key: c.key, tier: c.tier, side: c.side, text: clip(c.evidence, 140) }));
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
