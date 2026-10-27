/**
 * parlayTax.ts — la « taxe » d'un combiné : l'écart entre la cote payée et la cote juste.
 *
 * Plan de croissance « The Parlay Tax Engine » (Claude Doc, 2026-10-27), semaine 1 :
 * on note à la main des combinés NHL publics et on répond avec une carte. Ce module
 * est PUR (aucun réseau) pour que le futur correcteur public (/grade) et les bots
 * réutilisent exactement le même calcul que les cartes de la semaine 1.
 *
 * Définitions (par 1 $ misé) :
 *   - cote décimale payée  d  (depuis la cote américaine du ticket) ;
 *   - p = probabilité arakiceML du combiné, corrélations comprises (coupon de l'app) ;
 *   - retour espéré        p × d ;
 *   - taxe                 1 − p × d   (négative = le livre paie PLUS que le juste prix) ;
 *   - cote juste           1 / p.
 */

import { BOOKS, DISCLAIMER, PROMISES } from './parlayPosts';

/** Cote américaine → décimale. Accepte uniquement |cote| ≥ 100 (format américain valide). */
export function americanToDecimal(american: number): number {
  if (!Number.isFinite(american) || Math.abs(american) < 100) {
    throw new Error(`Cote américaine invalide : ${american} (attendu ≥ +100 ou ≤ −100)`);
  }
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

/** Cote décimale → américaine, arrondie à l'unité. 2.0 → +100. */
export function decimalToAmerican(decimal: number): number {
  if (!Number.isFinite(decimal) || decimal <= 1) {
    throw new Error(`Cote décimale invalide : ${decimal} (attendu > 1)`);
  }
  return decimal >= 2 ? Math.round((decimal - 1) * 100) : -Math.round(100 / (decimal - 1));
}

/** +852 / −130 (vrai signe moins, comme sur les tickets). */
export function formatAmerican(american: number): string {
  return american > 0 ? `+${american}` : `−${Math.abs(american)}`;
}

/** « +600 », « 600 », « -130 », « −130 » (signe moins Unicode des tickets DraftKings). */
export function parseAmerican(text: string): number {
  const clean = String(text).trim().replace(/[−–—]/g, '-').replace(/^\+/, '');
  if (!/^-?\d+$/.test(clean)) throw new Error(`Cote illisible : « ${text} »`);
  const n = Number(clean);
  americanToDecimal(n); // valide
  return n;
}

export type TaxVerdict = 'tax' | 'fair' | 'value';

export interface ParlayTax {
  modelPct: number;
  paidAmerican: number;
  paidDecimal: number;
  /** Probabilité implicite du prix payé, 0–100. */
  bookImpliedPct: number;
  fairDecimal: number;
  fairAmerican: number;
  /** Retour espéré par 1 $ misé (0.735 = 73,5 ¢). */
  expectedReturn: number;
  /** 1 − p×d en %, au dixième. Négatif = le prix payé dépasse le juste prix. */
  taxPct: number;
  /** ±1 point autour de zéro = « fair » : en deçà, l'écart est sous la précision du modèle. */
  verdict: TaxVerdict;
}

export function parlayTax(modelPct: number, paidAmerican: number): ParlayTax {
  if (!Number.isFinite(modelPct) || modelPct <= 0 || modelPct >= 100) {
    throw new Error(`Probabilité du modèle invalide : ${modelPct} (attendu entre 0 et 100, exclus)`);
  }
  const p = modelPct / 100;
  const paidDecimal = americanToDecimal(paidAmerican);
  const fairDecimal = 1 / p;
  const expectedReturn = p * paidDecimal;
  const taxPct = Math.round((1 - expectedReturn) * 1000) / 10;
  const verdict: TaxVerdict = taxPct > 1 ? 'tax' : taxPct < -1 ? 'value' : 'fair';
  return {
    modelPct,
    paidAmerican,
    paidDecimal,
    bookImpliedPct: Math.round((100 / paidDecimal) * 10) / 10,
    fairDecimal,
    fairAmerican: decimalToAmerican(fairDecimal),
    expectedReturn,
    taxPct,
    verdict,
  };
}

export type GradeLang = 'en' | 'fr';

/** Mention légale française, pendant de DISCLAIMER (parlayPosts.ts). */
export const DISCLAIMER_FR = '18+ (21+ É.-U.). Pas un conseil de pari. Jouez de façon responsable.';

export const disclaimerFor = (lang: GradeLang) => (lang === 'fr' ? DISCLAIMER_FR : DISCLAIMER);

/** 10.5 → « 10,5 » en français (virgule décimale). */
export const num = (n: number, lang: GradeLang) => (lang === 'fr' ? String(n).replace('.', ',') : String(n));

/** « 27 % » en français (espace insécable avant %), « 27% » en anglais. */
export const pctText = (n: number, lang: GradeLang) => (lang === 'fr' ? `${num(n, lang)}\u00a0%` : `${n}%`);

/** Phrase-titre de la carte et de la réponse. */
export function taxHeadline(t: ParlayTax, lang: GradeLang = 'en'): string {
  const tax = Math.round(t.taxPct);
  if (lang === 'fr') {
    if (t.verdict === 'tax') return `Taxe de ${pctText(tax, lang)} sur le combiné`;
    if (t.verdict === 'value') return `Paie ${pctText(-tax, lang)} de plus que le juste prix`;
    return 'Prix à peu près juste';
  }
  if (t.verdict === 'tax') return `${tax}% parlay tax`;
  if (t.verdict === 'value') return `Pays ${-tax}% over fair`;
  return 'Priced about fair';
}

export interface ReplyInput {
  tax: ParlayTax;
  /** Libellé de la jambe la plus faible (probabilité du modèle la plus basse), optionnel. */
  weakestLeg?: string;
  lang?: GradeLang;
}

/**
 * Réponse sous le post (X / Bluesky / Reddit) : ≤ 280 caractères, aucun lien
 * (les liens coûtent cher sur l'API X et sont interdits sur Reddit), mention 18+.
 * La jambe faible saute d'abord si le texte dépasse.
 */
export function gradeReply({ tax, weakestLeg, lang = 'en' }: ReplyInput): string {
  const fair = formatAmerican(tax.fairAmerican), paid = formatAmerican(tax.paidAmerican);
  const head = lang === 'fr'
    ? `Cote juste ${fair} contre ${paid} payé : ${taxHeadline(tax, lang).toLowerCase()}.`
    : `Fair odds ${fair} vs ${paid} paid: ${taxHeadline(tax, lang).toLowerCase()}.`;
  const model = lang === 'fr'
    ? `arakiceML lui donne ${pctText(tax.modelPct, lang)} de chances (corrélations comprises) ; le prix implique ${pctText(tax.bookImpliedPct, lang)}.`
    : `arakiceML gives it ${tax.modelPct}% to hit (correlations included); the price implies ${tax.bookImpliedPct}%.`;
  const weak = weakestLeg ? (lang === 'fr' ? ` Maillon faible : ${weakestLeg}.` : ` Weakest leg: ${weakestLeg}.`) : '';
  const legal = disclaimerFor(lang);
  const full = `${head} ${model}${weak} ${legal}`;
  return full.length <= 280 ? full : `${head} ${model} ${legal}`;
}

/** Promesses interdites en français (les listes anglaises viennent de parlayPosts.ts). */
export const PROMISES_FR = ['garanti', 'garantie', 'garantis', 'argent facile', 'sans risque', 'coup sûr', 'pari sûr'];

/** Garde-fous du contenu (mêmes listes que les vidéos) : liste vide = publiable. */
export function gradeComplianceProblems(texts: string[]): string[] {
  const problems: string[] = [];
  for (const text of texts) {
    const low = text.toLowerCase();
    for (const w of [...PROMISES, ...PROMISES_FR, ...BOOKS]) {
      const re = new RegExp(`(^|[^a-z0-9à-ÿ])${w.replace(/[.*+?^${}()|[\]\\']/g, '\\$&')}([^a-z0-9à-ÿ]|$)`);
      if (re.test(low)) problems.push(`« ${w} » dans : ${text.slice(0, 60)}`);
    }
    if (/https?:\/\//i.test(text)) problems.push(`lien dans : ${text.slice(0, 60)}`);
  }
  return problems;
}
