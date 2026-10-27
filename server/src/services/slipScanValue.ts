/**
 * slipScanValue.ts — SCAN_TICKET_PLAN § 5 (S4). Le prix payé face à la probabilité du modèle.
 *
 * Pour un groupe du ticket (une jambe simple, ou un SGP dont UNE cote couvre plusieurs
 * jambes) et pour le ticket entier :
 *   - probabilité implicite BRUTE de la cote (marge incluse : c'est ce que le joueur paie) ;
 *   - cote juste = 1 / p_modèle, affichée dans le format du ticket ;
 *   - « taxe » = 1 − p_modèle × cote décimale payée (négative = le prix dépasse le juste prix).
 * Même définition que les cartes « Parlay Tax » (`content/parlayTax.ts`), pour qu'un
 * ticket scanné et une carte publiée donnent le même chiffre.
 *
 * Pour un SGP, p_modèle est la probabilité RAFFINÉE du groupe (corrélation du même
 * match, `/predict/parlay`), jamais le produit des jambes (§ 5).
 *
 * Les cotes ne sont JAMAIS une entrée du modèle : seulement un étalon.
 *
 * ⚠️ PARTAGÉ AVEC LE CLIENT, comme `slipScan.ts` : aucune dépendance Node, pas de réseau.
 */

import { oddsFormatOf, oddsToDecimal, type OddsFormat } from './slipScan';

export type PriceVerdictKind = 'tax' | 'fair' | 'value';

export interface PriceVerdict {
  /** Probabilité du modèle, 0–100. */
  modelPct: number;
  /** Probabilité implicite brute de la cote payée, 0–100, au dixième. */
  impliedPct: number;
  paidDecimal: number;
  fairDecimal: number;
  /** Cote juste dans le format du ticket (« 2.31 », « +852 »). */
  fairOdds: string;
  /** 1 − p×d en %, au dixième ; négatif = le prix payé dépasse le juste prix. */
  taxPct: number;
  /** ±1 point autour de zéro = « fair » : l'écart est sous la précision du modèle. */
  verdict: PriceVerdictKind;
}

/** Cote décimale → texte dans le format demandé (fractionnaire rendu en décimal). */
export function formatOdds(decimal: number, format: OddsFormat | null): string {
  if (format === 'american') {
    const a = decimal >= 2 ? Math.round((decimal - 1) * 100) : -Math.round(100 / (decimal - 1));
    return a > 0 ? `+${a}` : String(a);
  }
  return decimal.toFixed(2);
}

/** Verdict pour une probabilité du modèle (0–100) et une cote affichée ; null si illisible. */
export function priceVerdict(modelPct: number, paid: string | number, format?: OddsFormat | null): PriceVerdict | null {
  if (!Number.isFinite(modelPct) || modelPct <= 0 || modelPct >= 100) return null;
  const paidDecimal = typeof paid === 'number' ? paid : oddsToDecimal(paid);
  if (!paidDecimal || paidDecimal <= 1) return null;
  const fmt = format ?? (typeof paid === 'string' ? oddsFormatOf(paid) : 'decimal');
  const p = modelPct / 100;
  const fairDecimal = 1 / p;
  const taxPct = Math.round((1 - p * paidDecimal) * 1000) / 10;
  return {
    modelPct,
    impliedPct: Math.round(1000 / paidDecimal) / 10,
    paidDecimal,
    fairDecimal,
    fairOdds: formatOdds(fairDecimal, fmt),
    taxPct,
    verdict: taxPct > 1 ? 'tax' : taxPct < -1 ? 'value' : 'fair',
  };
}

/**
 * Probabilité du ticket entier : produit des groupes (des matchs différents sont
 * indépendants). null si un groupe manque ou si deux groupes portent sur le même match
 * (leur corrélation n'est pas chiffrée ici : on ne donne pas un chiffre faux).
 */
export function ticketModelPct(groups: { pct: number | null; gameId: string | null }[]): number | null {
  if (!groups.length || groups.some((g) => g.pct == null || !Number.isFinite(g.pct))) return null;
  const games = groups.map((g) => g.gameId).filter((g): g is string => !!g);
  if (new Set(games).size !== games.length) return null;
  const p = groups.reduce((acc, g) => acc * ((g.pct as number) / 100), 1);
  return Math.round(p * 1000) / 10;
}

/** Cote décimale payée pour le ticket : la cote totale affichée, sinon le produit des cotes des groupes. */
export function ticketPaidDecimal(totalOdds: string | null, groupOdds: (string | null)[]): number | null {
  if (totalOdds) return oddsToDecimal(totalOdds);
  if (!groupOdds.length || groupOdds.some((o) => !o)) return null;
  const ds = groupOdds.map((o) => oddsToDecimal(o as string));
  if (ds.some((d) => !d)) return null;
  return ds.reduce((a, d) => a * (d as number), 1);
}

/** Le maillon faible : la jambe la moins probable selon le modèle (null s'il y en a moins de 2). */
export function weakestLeg<K>(legs: { key: K; pct: number | null }[]): K | null {
  const known = legs.filter((l) => l.pct != null && Number.isFinite(l.pct)) as { key: K; pct: number }[];
  if (known.length < 2) return null;
  return known.reduce((a, b) => (b.pct < a.pct ? b : a)).key;
}
