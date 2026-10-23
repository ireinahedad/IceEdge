/**
 * mlApi.ts — appels au modèle ML (probabilité d'une tuile, paquet d'un match)
 * et normalisation de leurs réponses. Extrait de `components/MLPredictionCard.tsx`
 * le 2026-10-23 (PERF_PLAN.md, P2.1) SANS changement de code : les services et
 * l'accueil n'importent plus le composant (jauges, cartes) pour atteindre ces
 * fonctions, qui sortent ainsi du bundle principal avec lui.
 * `MLPredictionCard.tsx` les ré-exporte : ses importeurs ne changent pas.
 */
import { env } from "../env";
import { fetchWithTimeout } from "./http";
// ── Types ─────────────────────────────────────────────────────────────────────

export interface MLFeatureImportance {
  name:       string;
  importance: number;
  direction:  "positive" | "negative";
}

export interface MLPredictionResult {
  probability:         number;
  /** Recalculé sur l'état du match en cours (paquet ML en direct). */
  live?:               boolean;
  /**
   * `null` quand le service n'a pas envoyé de confiance. Elle valait 0,7 par
   * défaut (soit « 70 % de confiance » affiché à l'écran) pour toute réponse
   * qui n'en portait pas, et 62 dans le repli fabriqué. On ne montre plus une
   * confiance qu'on n'a pas reçue.
   */
  confidence:          number | null;
  feature_importances: MLFeatureImportance[];
  /**
   * Renseignés SEULEMENT si le service les a envoyés. Ils étaient auparavant
   * remplis par défaut avec « Random Forest » / « 1.0.0 », ce qui nommait un
   * modèle précis sous un chiffre dont on ignorait la provenance. Le rendu les
   * omet quand ils manquent.
   */
  model_version?:      string;
  model_type?:         string;
  explanation:         string;
}

export const ML_BASE = `${env.nhlServerUrl}/api/predict`;

/**
 * Extract the ML probability (0-100 integer) from a raw ML-service response.
 * SINGLE source of truth for both the stats tile (fetchMLProbability) and the
 * detail card (normalizeMLResponse) so they can never round differently and
 * show two different ML numbers for the same bet. Returns null when the
 * response carries no usable probability.
 */
function mlPctFromResponse(data: Record<string, unknown>): number | null {
  const raw =
    typeof data.probability === "number" ? data.probability :
    typeof data.homeWinProb  === "number" ? data.homeWinProb  : null;
  if (raw === null) return null;
  // Paquet ML en direct : toujours en points, où 0 et 1 % sont de vraies valeurs.
  if (data.probability_scale === "pct") return Math.round(raw);
  // Réponse du service Python : `probability` est un entier en POINTS, mais un
  // score exact peut valoir 1 % (ou 0 %) — lu comme une fraction, « 1 »
  // devenait 100 % (bug 2026-10-11). La valeur exacte 0–1, quand elle est là,
  // ne laisse aucune ambiguïté.
  const exact = data.probability_exact;
  if (typeof exact === "number" && Number.isFinite(exact) && exact >= 0 && exact <= 1) {
    return Math.round(exact * 100);
  }
  return raw > 1 ? Math.round(raw) : Math.round(raw * 100);
}

/**
 * Fetch ONLY the ML probability (0-100) for a bet — used by the stats-page
 * tiles when the "ML" reveal mode is active. Uses the exact same extraction
 * (mlPctFromResponse) as the detail card, so a tile and the card the user opens
 * always show the same number.
 *
 * Retourne `null` quand le service ne donne pas de probabilité exploitable —
 * hors ligne, 503, corps illisible, disjoncteur ouvert. La tuile doit alors dire
 * « indisponible » ; elle ne doit NI fabriquer un chiffre, NI afficher
 * discrètement le pourcentage de règles sous une étiquette « ML », ce qui
 * revient au même mensonge en moins visible.
 */
export type MLProbabilityRequest = {
  // `selection` porte le CÔTÉ d'un marché binaire (« yes » / « no »). Il était
  // absent de ce type, donc les deux tuiles d'un même marché envoyaient une
  // requête identique et affichaient le même pourcentage des deux côtés.
  // `isHome` dit si le SUJET reçoit. Sans lui, le serveur passait le sujet comme
  // équipe à domicile au service Python : les deux tuiles moneyline d'un même
  // match recevaient chacune l'avantage de la glace et totalisaient 109–112 %.
  type: "game" | "player" | "team"; subjectId: string; opponentId?: string; propType?: string; line?: number; selection?: string; isHome?: boolean;
  /**
   * Pari JOUEUR : le match visé. Le serveur y lit la cadence du modèle joueur
   * (paquet ML du match) ; sans lui, il prend le prochain match du joueur.
   */
  gameId?: string;
};

/**
 * Clé d'une demande de probabilité ML : exactement les champs envoyés au
 * serveur, dans un ordre fixe. Sert au cache ci-dessous ET de dépendance
 * d'effet aux tuiles (`BetOption`) — une chaîne est stable d'un rendu à
 * l'autre, là où l'objet `mlProps` est recréé à chaque rendu du parent.
 */
export function mlProbabilityKey(req: MLProbabilityRequest): string {
  return JSON.stringify([
    req.type, req.subjectId, req.opponentId ?? null, req.propType ?? null,
    req.line ?? null, req.selection ?? null, req.isHome ?? null, req.gameId ?? null,
  ]);
}

/**
 * Cache des probabilités ML, partagé par toutes les tuiles de l'application.
 *
 * Mesuré le 2026-09-16 : une page de match tirait 31 `POST /predict/ml` à la
 * première bascule en mode ML, et 31 de plus à CHAQUE retour Règles → ML. Avec
 * `predictLimiter` à 60/min par compte (par IP pour un invité), un seul
 * aller-retour suffisait à prendre des 429 et à afficher « — » sur les tuiles.
 * La page joueur envoyait en plus des corps identiques (12 appels, 7 distincts).
 *
 * On garde la PROMESSE, pas le résultat : deux tuiles qui demandent la même
 * chose au même instant partagent un seul appel. Un `null` (hors ligne, 429,
 * 503) n'est PAS conservé : la prochaine demande retente, sinon une panne
 * passagère resterait affichée cinq minutes.
 */
const ML_PROB_TTL_MS = 5 * 60_000;
const ML_PROB_MAX_ENTRIES = 300;
const mlProbCache = new Map<string, { at: number; promise: Promise<number | null> }>();

export function fetchMLProbability(req: MLProbabilityRequest): Promise<number | null> {
  const key = mlProbabilityKey(req);
  const hit = mlProbCache.get(key);
  if (hit && Date.now() - hit.at < ML_PROB_TTL_MS) return hit.promise;

  const entry = { at: Date.now(), promise: requestMLProbability(req) };
  entry.promise.then((p) => {
    if (p === null && mlProbCache.get(key) === entry) mlProbCache.delete(key);
  });
  mlProbCache.delete(key);
  if (mlProbCache.size >= ML_PROB_MAX_ENTRIES) {
    const oldest = mlProbCache.keys().next();
    if (!oldest.done) mlProbCache.delete(oldest.value);
  }
  mlProbCache.set(key, entry);
  return entry.promise;
}

async function requestMLProbability(req: MLProbabilityRequest): Promise<number | null> {
  try {
    const r = await fetchWithTimeout(`${ML_BASE}/ml`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (!data || typeof data !== "object") return null;
    return mlPctFromResponse(data as Record<string, unknown>);
  } catch {
    return null;
  }
}

/* ─── Paquet ML d'un match ──────────────────────────────────────────────────
 *
 * Toutes les tuiles d'une page de match en UNE requête
 * (`GET /api/predict/game/:id/bundle`), au lieu d'un `POST /predict/ml` par
 * tuile — ~95 appels, et des 429 dès la première bascule en mode ML.
 *
 * Résultat : `{ [identifiant de tuile]: résultat | null }`, ou `null` si le
 * paquet entier est indisponible. La promesse est partagée 5 min ; un échec
 * n'est pas conservé (la prochaine bascule retente).
 */
export interface GameMlBundle {
  /** Par identifiant de tuile de la page match. */
  byId:  Record<string, MLPredictionResult | null>;
  /** Par question (`mlBundleKey`) — pages équipe et joueur. */
  byKey: Record<string, MLPredictionResult | null>;
  /**
   * Match commencé : chiffres du modèle conditionnés par le score (serveur).
   * `refreshMs` : rythme du recalcul côté serveur — 30 s, 10 s en fin de match.
   */
  live?: { label: string; final: boolean; refreshMs?: number };
}
const BUNDLE_TTL_MS = 5 * 60_000;
/** Match en cours : le serveur recalcule toutes les 30 s, on ne garde pas plus. */
const LIVE_BUNDLE_TTL_MS = 25_000;
type BundleEntry = { at: number; promise: Promise<GameMlBundle | null>; liveTtlMs?: number };
const bundleCache = new Map<string, BundleEntry>();

export function fetchGameMlBundle(gameId: string): Promise<GameMlBundle | null> {
  const hit = bundleCache.get(gameId);
  const ttl = hit?.liveTtlMs ?? BUNDLE_TTL_MS;
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const entry: BundleEntry = {
    at: Date.now(),
    promise: (async (): Promise<GameMlBundle | null> => {
      try {
        const r = await fetchWithTimeout(`${ML_BASE}/game/${encodeURIComponent(gameId)}/bundle`);
        if (!r.ok) return null;
        const data = await r.json() as {
          results?: Record<string, unknown>; byKey?: Record<string, unknown>;
          live?: { label?: unknown; final?: unknown; refreshMs?: unknown };
        };
        if (!data?.results || typeof data.results !== "object") return null;
        const norm = (m: Record<string, unknown> | undefined) => {
          const out: Record<string, MLPredictionResult | null> = {};
          for (const [id, v] of Object.entries(m ?? {})) {
            out[id] = v && typeof v === "object" ? normalizeMLResponse(v as Record<string, unknown>) : null;
          }
          return out;
        };
        const refreshMs = typeof data.live?.refreshMs === "number" && data.live.refreshMs > 0
          ? data.live.refreshMs : undefined;
        const live = data.live && typeof data.live.label === "string"
          ? { label: data.live.label, final: data.live.final === true, ...(refreshMs ? { refreshMs } : {}) }
          : undefined;
        return { byId: norm(data.results), byKey: norm(data.byKey), ...(live ? { live } : {}) };
      } catch {
        return null;
      }
    })(),
  };
  entry.promise.then(b => {
    if (b === null && bundleCache.get(gameId) === entry) bundleCache.delete(gameId);
    // Match en cours : la promesse ne sert que 25 s (voir `LIVE_BUNDLE_TTL_MS`),
    // et un peu moins que le rythme du serveur en fin de match (10 s).
    if (b?.live && !b.live.final) {
      entry.liveTtlMs = Math.min(LIVE_BUNDLE_TTL_MS, Math.max(5_000, (b.live.refreshMs ?? 30_000) - 2_000));
    }
  });
  bundleCache.set(gameId, entry);
  return entry.promise;
}

/**
 * Normalise any server response shape into the MLPredictionResult the card
 * expects — ou `null` si la réponse ne porte pas de probabilité exploitable.
 *
 * Le `?? 50` qui occupait cette ligne transformait toute réponse inattendue en
 * pile ou face parfaitement présentable, et les valeurs par défaut
 * « Random Forest » / « 1.0.0 » lui collaient un nom de modèle par-dessus. La
 * confiance n'est plus inventée non plus : absente, elle n'est pas affichée.
 */
export function normalizeMLResponse(data: Record<string, unknown>): MLPredictionResult | null {
  // Same extraction/rounding the stats tile uses → identical ML % in both.
  const pct = mlPctFromResponse(data);
  if (pct === null) return null;

  const rawConf = typeof data.confidence === "number" ? data.confidence : null;
  const conf    = rawConf === null ? null : rawConf > 1 ? Math.round(rawConf) : Math.round(rawConf * 100);

  return {
    probability:         pct,
    confidence:          conf,
    feature_importances: Array.isArray(data.feature_importances)
      ? (data.feature_importances as MLFeatureImportance[])
      : [],
    model_type:          typeof data.model_type    === "string" ? data.model_type    : undefined,
    model_version:       typeof data.model_version === "string" ? data.model_version : undefined,
    explanation:         typeof data.explanation   === "string" ? data.explanation   : "",
    // Recalculé sur l'état du match en cours (paquet ML) : blanc opaque à l'écran.
    ...(data.live === true ? { live: true } : {}),
  };
}
