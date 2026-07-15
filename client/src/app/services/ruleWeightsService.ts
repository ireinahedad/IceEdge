/**
 * ruleWeightsService.ts
 * Poids des facteurs des règles hockey, réglables par l'utilisateur.
 * Stockés dans localStorage (par appareil) et injectés dans les requêtes de
 * prédiction en query params. Le serveur applique ces poids s'ils sont fournis,
 * sinon il utilise les valeurs par défaut (testées comme les plus fiables).
 */

export interface FactorWeights {
  quality:  number;
  homeIce:  number;
  fatigue:  number;
  odds:     number;
  injuries: number;
  lineup:   number;
}

/** Valeurs par défaut — identiques au serveur (predictionFactors.ts). */
export const DEFAULT_WEIGHTS: FactorWeights = {
  quality:  0.30,
  homeIce:  0.10,
  fatigue:  0.10,
  odds:     0.28,
  injuries: 0.14,
  lineup:   0.08,
};

/** Métadonnées d'affichage (ordre, libellé, description). */
export const WEIGHT_META: Array<{ id: keyof FactorWeights; label: string; desc: string }> = [
  { id: 'quality',  label: 'Qualité d’équipe', desc: 'Win% de la saison + forme des 10 derniers matchs.' },
  { id: 'homeIce',  label: 'Avantage domicile',     desc: 'Jouer à domicile, ajusté par les splits domicile/route.' },
  { id: 'fatigue',  label: 'Épuisement',            desc: 'Repos et back-to-back d’une équipe contre l’autre.' },
  { id: 'odds',     label: 'Cote du marché',        desc: 'Cote de clôture dé-viggée. Le meilleur prédicteur, mais volontairement non dominant.' },
  { id: 'injuries', label: 'Blessures',             desc: 'Blessures / joueurs manquants saisis manuellement (si renseignés).' },
  { id: 'lineup',   label: 'Alignement',            desc: 'Nouvel alignement / trios remaniés saisis manuellement (si renseignés).' },
];

/** Couleur par facteur — partagée entre les pie charts (prédiction & paramètres). */
export const FACTOR_COLORS: Record<keyof FactorWeights, string> = {
  quality:  '#9BF019',
  homeIce:  '#90C9F0',
  fatigue:  '#F0B429',
  odds:     '#F06292',
  injuries: '#B388FF',
  lineup:   '#4DD0E1',
};

const STORAGE_KEY = 'iceedge.ruleWeights';
const QUERY_KEYS: Record<keyof FactorWeights, string> = {
  quality: 'wQuality', homeIce: 'wHomeIce', fatigue: 'wFatigue',
  odds: 'wOdds', injuries: 'wInjuries', lineup: 'wLineup',
};

/** Poids courants (personnalisés si sauvegardés, sinon défauts). */
export function getWeights(): FactorWeights {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_WEIGHTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_WEIGHTS, ...parsed };
  } catch {
    return { ...DEFAULT_WEIGHTS };
  }
}

export function saveWeights(w: FactorWeights): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(w));
}

export function resetWeights(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function isCustom(): boolean {
  return localStorage.getItem(STORAGE_KEY) != null;
}

/**
 * Hydrate le localStorage depuis les poids sauvegardés sur le compte (profil).
 * Appelé au chargement du profil pour que les poids suivent l'utilisateur
 * d'un appareil à l'autre. `null` = compte sur les valeurs par défaut.
 */
export function applyServerWeights(w: Record<string, number> | null | undefined): void {
  if (w && typeof w === 'object') {
    saveWeights({ ...DEFAULT_WEIGHTS, ...(w as Partial<FactorWeights>) } as FactorWeights);
  } else {
    resetWeights();
  }
}

/** Query string — conservé pour compat ; les poids sont désormais appliqués côté client. */
export function weightsQuery(): string {
  return '';
}

// ── Poids par famille de pari (nouveau modèle) ──────────────────────────────────
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

/** Hydrate le store depuis les poids du compte (profil). */
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
