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

/** Query string ('?wQuality=..&..') si des poids personnalisés existent, sinon ''. */
export function weightsQuery(): string {
  if (!isCustom()) return '';
  const w = getWeights();
  const params = new URLSearchParams();
  (Object.keys(QUERY_KEYS) as Array<keyof FactorWeights>).forEach(k => {
    params.set(QUERY_KEYS[k], String(w[k]));
  });
  return `?${params.toString()}`;
}
