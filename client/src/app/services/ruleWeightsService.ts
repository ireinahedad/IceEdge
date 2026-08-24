/**
 * ruleWeightsService.ts
 * Poids des facteurs des règles hockey, réglables par l'utilisateur.
 * Appliqués côté client depuis localStorage ; rattachés au compte quand une
 * session existe (voir « Synchro avec le compte » plus bas).
 *
 * ⚠️ Un **modèle par famille de pari** a remplacé l'ancien modèle à six facteurs
 * globaux (`FactorWeights`, `DEFAULT_WEIGHTS`, `WEIGHT_META`, `getWeights`,
 * `saveWeights`, `isCustom`, `applyServerWeights`…), supprimé le 2026-08-10 :
 * il n'avait plus aucun appelant depuis le retrait de `RulesWeightsCard`.
 * Ne pas le réintroduire — `RuleFactorEditor` est le seul éditeur.
 */

import { getAccessToken } from './authService';
import { profileApiService } from './userService';

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

export type FamilyStore = Record<string, Record<string, number>>;
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

// ── Synchro avec le compte ──────────────────────────────────────────────────
// Le serveur détient la référence (`user_profiles.rule_weights`, migration 017,
// lue en `ruleWeights` et écrite par `PATCH /users/me`) ; localStorage est le
// cache de travail, seul utilisé pour calculer les scores.
//
// L'hydratation est **paresseuse et unique par chargement d'app** : ni
// `AuthProvider` ni la navigation ne déclenchent d'appel — c'est la première
// carte de règles montée qui le fait, et la page Profil s'en acquitte
// gratuitement puisqu'elle a déjà le profil en main. Un invité ne déclenche
// jamais rien.

/** Clé de famille ou de facteur acceptable — mêmes bornes que `ruleWeightsSchema`. */
const KEY_RE = /^(?!__)[A-Za-z0-9_]{1,40}$/;

/**
 * Nettoie une valeur venue du réseau (ou du localStorage d'une vieille version) :
 * familles → { facteur → poids 0-100 }. Ce que le serveur refuserait est écarté
 * ici aussi, pour ne jamais écrire dans le store ce qu'on ne pourrait pas y relire.
 */
function sanitizeStore(map: unknown): FamilyStore {
  const out: FamilyStore = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [family, weights] of Object.entries(map as Record<string, unknown>)) {
    if (!KEY_RE.test(family)) continue;
    if (!weights || typeof weights !== 'object' || Array.isArray(weights)) continue;
    const clean: Record<string, number> = {};
    for (const [id, w] of Object.entries(weights as Record<string, unknown>)) {
      if (!KEY_RE.test(id)) continue;
      const n = Number(w);
      if (Number.isFinite(n)) clean[id] = Math.max(0, Math.min(100, n));
    }
    if (Object.keys(clean).length) out[family] = clean;
  }
  return out;
}

/** Vrai si le compte est connecté — sans quoi toute synchro est inutile. */
function isSignedIn(): boolean {
  return !!getAccessToken();
}

let hydrated = false;
let hydrating: Promise<boolean> | null = null;

/**
 * Écrit dans le store local les poids venus du compte.
 *
 * Deux garde-fous : une valeur vide ou illisible **n'efface pas** les réglages
 * de l'appareil (un store vide côté compte vaut « pas d'opinion », pas « remets
 * tout par défaut »), et l'appel marque la synchro comme faite dans tous les
 * cas — l'état du serveur est connu, inutile de le redemander.
 *
 * Sinon le remplacement est complet, famille comprise : le push envoie toujours
 * le store entier, donc ce que le compte porte fait foi.
 *
 * @returns vrai si le store local a effectivement changé.
 */
export function applyServerFamilyWeights(map: unknown): boolean {
  hydrated = true;
  const clean = sanitizeStore(map);
  if (!Object.keys(clean).length) return false;

  const next = JSON.stringify(clean);
  if (next === localStorage.getItem(FAMILY_KEY)) return false;
  localStorage.setItem(FAMILY_KEY, next);
  return true;
}

/**
 * Pousse le store vers le compte. Sans session, ne fait rien.
 * L'appelant décide quoi faire de l'échec ; rien ici n'est bloquant.
 */
export async function pushFamilyWeights(store: FamilyStore = loadFamilyStore()): Promise<boolean> {
  if (!isSignedIn()) return false;
  await profileApiService.updateProfile({ ruleWeights: sanitizeStore(store) });
  return true;
}

/**
 * Récupère une fois par chargement d'app les poids du compte.
 *
 * Cas particulier volontaire : si le compte n'a **aucun** poids enregistré et que
 * l'appareil en a, ce sont ceux de l'appareil qui montent. Sans ça, un utilisateur
 * qui a réglé ses curseurs avant que la synchro existe devrait les ré-enregistrer
 * un par un pour que son deuxième appareil les voie.
 *
 * @returns vrai si le store local a changé (l'appelant doit se rafraîchir).
 */
export function ensureFamilyWeightsHydrated(): Promise<boolean> {
  if (hydrated || !isSignedIn()) return Promise.resolve(false);
  if (hydrating) return hydrating;

  hydrating = (async () => {
    try {
      const profile = await profileApiService.getProfile();
      const changed = applyServerFamilyWeights(profile.ruleWeights);

      if (!Object.keys(sanitizeStore(profile.ruleWeights)).length) {
        const local = loadFamilyStore();
        if (Object.keys(local).length) await pushFamilyWeights(local).catch(() => false);
      }
      return changed;
    } catch {
      // Hors ligne, 401, profil illisible : on garde les poids de l'appareil et
      // on réessaiera au prochain chargement.
      return false;
    } finally {
      hydrating = null;
    }
  })();

  return hydrating;
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
