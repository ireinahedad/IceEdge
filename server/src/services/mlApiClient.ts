/**
 * mlApiClient.ts
 * HTTP client for the Python ML service (default: http://localhost:8000).
 * All methods throw on error so callers can fall back to rule-based.
 *
 * Auth: the ML service is not user-aware and must only be reachable by this
 * backend. It should sit on Railway's private network (no public domain), and
 * every inference call carries the shared secret `ML_API_TOKEN` in `X-ML-Token`
 * as a second, independent barrier. See ml/python/ml_service.py.
 */

import crypto from 'crypto';
import { logger } from '../logger';
import { timeUpstream } from '../metrics';
import { TtlCache } from './ttlCache';

/** Normalise `ML_SERVICE_URL` and shout about the two ways it's usually wrong.
 *  Railway's dashboard displays the internal address bare — `svc.railway.internal` —
 *  and pasting it as-is makes `fetch` throw "Failed to parse URL", which the route
 *  turns into a generic 503: the real cause never surfaces. Private networking
 *  also has no proxy, so the port is mandatory (uvicorn binds `$PORT`, 8080 on
 *  Railway); omitting it silently means port 80 and a refused connection. */
function resolveMlUrl(): string {
  const raw = (process.env.ML_SERVICE_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return 'http://localhost:8000';

  let url = raw;
  if (!/^https?:\/\//i.test(url)) {
    logger.warn({ ML_SERVICE_URL: raw }, '[ML] ML_SERVICE_URL sans schéma — "http://" ajouté. Corrige la variable.');
    url = `http://${url}`;
  }
  if (/\.railway\.internal(\/|$)/i.test(url) && !/:\d+(\/|$)/.test(url)) {
    logger.warn({ ML_SERVICE_URL: url }, '[ML] Adresse interne sans port — le réseau privé n\'a pas de proxy, ajoute le port écouté par uvicorn (souvent :8080).');
  }
  return url;
}

/** Base URL of the ML service. Exported so callers doing raw fetches (dev routes)
 *  don't re-derive it from the env and re-introduce the parsing bug. */
export const ML_URL = resolveMlUrl();
const TIMEOUT_MS = 5000;

// Without the token every call gets a 401 and the app silently degrades to
// rule-based predictions — a failure mode that looks like "the model is meh"
// rather than a misconfiguration. Say it out loud at boot.
if (process.env.NODE_ENV === 'production'
    && process.env.ML_DISABLED !== 'true'
    && !process.env.ML_API_TOKEN) {
  logger.warn('[ML] ML_API_TOKEN absent — le service ML rejettera les appels (401).');
}

/** Headers for a call to the ML service. The token is omitted when unset so a
 *  local run without `ML_API_TOKEN` still works (the service also skips the
 *  check when it has no token — but refuses to boot that way in production). */
export function mlHeaders(base: Record<string, string> = {}): Record<string, string> {
  const token = process.env.ML_API_TOKEN;
  return token ? { ...base, 'X-ML-Token': token } : base;
}

export interface MLFeatureImportance {
  name:       string;
  importance: number;
  direction:  'positive' | 'negative';
}

export interface MLPredictionResult {
  probability:          number;   // integer, 5–95
  confidence:           number;   // integer, 40–95
  feature_importances:  MLFeatureImportance[];
  model_version:        string;
  model_type:           string;
  explanation:          string;
}

// ─── Disjoncteur (audit, ligne M) ────────────────────────────────────────────
//
// LE PROBLÈME — quand le service Python ralentit, `getBestBets` maintient
// jusqu'à 30 sockets ouvertes pendant 5 s POUR CHAQUE requête entrante. Le
// repli sur les règles existe déjà et fonctionne, mais il n'est atteint qu'après
// le timeout : le serveur passe donc 5 s par requête à attendre un service dont
// il sait déjà, depuis la requête précédente, qu'il ne répond pas. C'est ainsi
// qu'une panne d'un service secondaire devient une panne de l'API principale.
//
// LE DISJONCTEUR — après N échecs consécutifs, les appels échouent
// IMMÉDIATEMENT (sans réseau, sans attente) pendant une fenêtre de repos. Les
// appelants retombent sur les règles au premier millième de seconde au lieu du
// cinquième millième. Passé la fenêtre, un seul appel « sonde » est laissé
// passer : s'il réussit le circuit se referme, sinon la fenêtre repart.
//
// QUELS ÉCHECS COMPTENT — seulement ceux qui décrivent le SERVICE : réseau,
// timeout, 5xx, et 401/403/429 (jeton absent ou débit refusé, donc tout appel
// échouera pareil). Un 400 sur des features mal formées est la faute d'UN
// appelant ; le compter ouvrirait le circuit pour tout le monde à cause d'une
// seule route boguée — le disjoncteur deviendrait lui-même la panne.
const BREAKER_THRESHOLD   = Number(process.env.ML_BREAKER_THRESHOLD) || 5;
const BREAKER_COOLDOWN_MS = Number(process.env.ML_BREAKER_COOLDOWN_MS) || 60_000;

let consecutiveFailures = 0;
let openUntil = 0;
/** Vrai quand la sonde de demi-ouverture est déjà partie (une seule à la fois). */
let probing = false;

export class MLUnavailableError extends Error {
  readonly code = 'ML_CIRCUIT_OPEN';
  constructor(msRemaining: number) {
    super(`ML service circuit open (retry in ${Math.ceil(msRemaining / 1000)}s)`);
  }
}

/** Un échec qui décrit le service, par opposition à un appel malformé. */
function countsAsServiceFailure(err: any): boolean {
  const status = err?.status as number | undefined;
  if (status === undefined) return true;              // réseau / timeout / parse
  if (status >= 500) return true;
  return status === 401 || status === 403 || status === 429;
}

function onSuccess(): void {
  if (consecutiveFailures > 0 || openUntil > 0) {
    logger.info('[ML] circuit refermé — le service répond de nouveau');
  }
  consecutiveFailures = 0;
  openUntil = 0;
  probing = false;
}

function onFailure(err: any): void {
  probing = false;
  if (!countsAsServiceFailure(err)) return;
  consecutiveFailures += 1;
  if (consecutiveFailures >= BREAKER_THRESHOLD) {
    openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    logger.warn(
      { failures: consecutiveFailures, cooldownMs: BREAKER_COOLDOWN_MS, err: err?.message },
      '[ML] circuit ouvert — repli sur les règles, appels suspendus',
    );
  }
}

/** État courant, pour `/api/dev/metrics` et les tests. */
export function mlCircuitState(): { open: boolean; failures: number; openForMs: number } {
  const remaining = openUntil - Date.now();
  return { open: remaining > 0, failures: consecutiveFailures, openForMs: Math.max(0, remaining) };
}

/** Referme le circuit (tests, et bouton d'exploitation si besoin). */
export function resetMlCircuit(): void {
  consecutiveFailures = 0;
  openUntil = 0;
  probing = false;
}

// ─── Cache de prédictions ────────────────────────────────────────────────────
//
// Le modèle est DÉTERMINISTE : mêmes features, même sortie. Deux appelants qui
// demandent le même match dans la même minute font aujourd'hui deux inférences.
// Au-delà de l'économie de CPU, `wrap` déduplique les appels EN VOL — c'est ce
// qui compte ici, puisque `getBestBets` lance ses 30 appels d'un coup.
//
// TTL court malgré le déterminisme : les features, elles, changent (blessures,
// gardien annoncé, cotes). On mémorise le calcul, pas le pronostic.
const PREDICT_TTL_MS  = Number(process.env.ML_CACHE_TTL_MS) || 5 * 60_000;
const predictionCache = new TtlCache<any>(PREDICT_TTL_MS, 2_000, 'mlPredictions');

/** Clé = chemin + empreinte des features. Hachée : les features sont volumineuses
 *  et la clé n'a pas à être lisible, seulement stable et bornée en taille. */
function cacheKey(path: string, body: unknown): string {
  const json = JSON.stringify(body) ?? 'null';
  return `${path}:${crypto.createHash('sha1').update(json).digest('hex')}`;
}

// Point d'étranglement unique des trois méthodes publiques : compter ici suffit
// à voir toute la charge envoyée au service Python, qui n'a que 2 workers et
// sature avant le process Node.
async function mlFetch<T>(path: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await timeUpstream('ml', async () => {
      const res = await fetch(`${ML_URL}${path}`, {
        method:  'POST',
        headers: mlHeaders({ 'Content-Type': 'application/json' }),
        body:    JSON.stringify(body),
        signal:  controller.signal,
      });
      if (!res.ok) {
        const msg = await res.text().catch(() => res.statusText);
        // Le statut est porté par l'erreur : c'est lui qui décide si l'échec
        // compte pour le disjoncteur.
        throw Object.assign(new Error(`ML service ${res.status}: ${msg}`), { status: res.status });
      }
      return res.json() as Promise<T>;
    });
  } finally {
    clearTimeout(timer);
  }
}

async function mlPost<T>(path: string, body: unknown): Promise<T> {
  const key = cacheKey(path, body);

  // Le cache est lu AVANT le disjoncteur, délibérément. Une valeur déjà calculée
  // reste servable pendant une panne — la refuser dégraderait le produit sans
  // soulager le service. Et un hit ne doit ni refermer le circuit (il ne prouve
  // rien sur l'état du service) ni consommer la sonde.
  // `peekFresh` et non `get` : `wrap` ci-dessous compte déjà l'accès. Avec `get`,
  // chaque exécution réelle serait comptée deux fois en `misses` — la métrique
  // sur laquelle reposent les critères des tests de charge.
  const cached = predictionCache.peekFresh(key) as T | null;
  if (cached !== null) return cached;

  const remaining = openUntil - Date.now();
  if (remaining > 0) throw new MLUnavailableError(remaining);

  if (openUntil > 0) {
    // Fenêtre écoulée : UNE seule sonde. Sans ce drapeau, les 30 appels d'un
    // `getBestBets` partiraient tous à la seconde où la fenêtre expire et
    // rouvriraient le circuit par une rafale — précisément ce qu'il empêche.
    if (probing) throw new MLUnavailableError(1);
    probing = true;
  }

  try {
    const out = await predictionCache.wrap(key, () => mlFetch<T>(path, body));
    onSuccess();
    return out;
  } catch (err) {
    onFailure(err);
    throw err;
  }
}

export const mlApiClient = {
  /** Game-outcome prediction (moneyline / puck-line / totals) */
  predictGame:   (features: unknown) => mlPost<MLPredictionResult>('/predict/game',   features),
  /** Player prop prediction (goals / assists / points / shots / pp_point) */
  predictPlayer: (features: unknown) => mlPost<MLPredictionResult>('/predict/player', features),
  /** Team futures prediction (cup / conf / playoff) */
  predictTeam:   (features: unknown) => mlPost<MLPredictionResult>('/predict/team',   features),
};
