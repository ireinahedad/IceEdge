/**
 * ruleWeightsService.ts
 * Poids des facteurs des règles hockey, réglables par l'utilisateur.
 * Stockés dans localStorage (par appareil) et appliqués côté client.
 *
 * ⚠️ Un **modèle par famille de pari** a remplacé l'ancien modèle à six facteurs
 * globaux (`FactorWeights`, `DEFAULT_WEIGHTS`, `WEIGHT_META`, `getWeights`,
 * `saveWeights`, `isCustom`, `applyServerWeights`…), supprimé le 2026-08-10 :
 * il n'avait plus aucun appelant depuis le retrait de `RulesWeightsCard`.
 * Ne pas le réintroduire — `RuleFactorEditor` est le seul éditeur.
 */

/** Query string — conservé pour compat ; les poids sont appliqués côté client. */
export function weightsQuery(): string {
  return '';
}

// ── Poids par famille de pari ───────────────────────────────────────────────
// Chaque famille (match, totals, period, margin, ot, player_off, player_phys,
// goalie) a ses propres facteurs et poids, ajustables dans la carte de règle.

export interface SimpleFactor { id: string; label: string; weight: number; value: number; }

const COLOR_MAP: Record<string, string> = {
  quality: '#9BF019', homeIce: '#90C9F0', fatigue: '#F0B429', odds: '#F06292',
  injuries: '#B388FF', lineup: '#4DD0E1', offense: '#9BF019', defense: '#F06292',
  shotPace: '#90C9F0', specialTeams: '#F0B429', model: '#B388FF', periodAD: '#4DD0E1',
  forceGap: '#9BF019', expectedTotal: '#F0B429', balance: '#90C9F0', lowTotal: '#F06292',
  playerRate: '#9BF019', shotVolume: '#90C9F0', oppDefense: '#F06292', availability: '#B388FF',
  positionAvg: '#F0B429', teamStrength: '#9BF019', teamDefense: '#90C9F0', oppAttack: '#F06292',
};
const PALETTE = ['#9BF019', '#90C9F0', '#F0B429', '#F06292', '#B388FF', '#4DD0E1'];

/** Couleur stable pour un facteur (par id), avec repli déterministe. */
export function factorColor(id: string): string {
  if (COLOR_MAP[id]) return COLOR_MAP[id];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

type FamilyStore = Record<string, Record<string, number>>;
const FAMILY_KEY = 'iceedge.factorWeights';

export function loadFamilyStore(): FamilyStore {
  try { return JSON.parse(localStorage.getItem(FAMILY_KEY) || '{}'); } catch { return {}; }
}

/** Poids courants d'une famille (overrides sauvegardés, sinon poids par défaut des facteurs). */
export function getFamilyWeights(family: string, factors: SimpleFactor[]): Record<string, number> {
  const stored = loadFamilyStore()[family] || {};
  const out: Record<string, number> = {};
  for (const f of factors) out[f.id] = stored[f.id] != null ? stored[f.id] : f.weight;
  return out;
}

export function saveFamilyWeights(family: string, weights: Record<string, number>): FamilyStore {
  const store = loadFamilyStore();
  store[family] = weights;
  localStorage.setItem(FAMILY_KEY, JSON.stringify(store));
  return store;
}

export function resetFamilyWeights(family: string): FamilyStore {
  const store = loadFamilyStore();
  delete store[family];
  localStorage.setItem(FAMILY_KEY, JSON.stringify(store));
  return store;
}

/**
 * Hydrate le store depuis les poids du compte (profil).
 *
 * ⚠️ **Aucun appelant aujourd'hui — la synchro entre appareils ne fonctionne pas.**
 * Le serveur a pourtant tout ce qu'il faut : colonne `user_profiles.rule_weights`
 * (migration 017), lue en `ruleWeights` et écrivable via `PATCH /api/profile`.
 * Il manque uniquement les deux bouts côté client : appeler cette fonction au
 * chargement du profil, et pousser le store vers l'API quand `RuleFactorEditor`
 * sauvegarde. Gardée exprès plutôt que supprimée comme code mort : le trou est
 * dans le câblage, pas dans cette fonction.
 */
export function applyServerFamilyWeights(map: unknown): void {
  if (map && typeof map === 'object') localStorage.setItem(FAMILY_KEY, JSON.stringify(map));
}

/** Score (0-100) = moyenne pondérée des facteurs avec les poids fournis. */
export function blendFactors(factors: SimpleFactor[], weights: Record<string, number>): number {
  let wsum = 0, acc = 0;
  for (const f of factors) {
    const w = weights[f.id] ?? f.weight;
    wsum += w; acc += w * f.value;
  }
  wsum = wsum || 1;
  return Math.round(Math.max(3, Math.min(97, (acc / wsum) * 100)));
}
