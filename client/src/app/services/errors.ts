/**
 * errors.ts — ce que l'utilisateur a le droit de lire d'une erreur. Un seul endroit.
 *
 * ── Le problème ─────────────────────────────────────────────────────────────
 *
 * Une soixantaine d'écrans affichaient `e?.message ?? t("…failed")`. Le `??`
 * ne protège que du message ABSENT ; il laisse passer tout message présent, et
 * les messages présents étaient souvent techniques :
 *
 *   • `TypeError: Failed to fetch` / `Load failed` (Safari) — coupure réseau ;
 *   • `Unexpected token '<', "<!DOCTYPE "… is not valid JSON` — une page HTML
 *     d'erreur (Cloudflare, Railway) lue comme du JSON ;
 *   • `NHL API 502: <html>…` — le CORPS BRUT de la réponse recopié dans le
 *     message par `nhlApiService` ;
 *   • `Request timed out after 15000 ms: https://api.arakice.com/api/…` —
 *     l'URL exacte de l'endpoint ;
 *   • `live state 500`, `Fetch failed (500)`, `API 404` — des codes HTTP nus ;
 *   • `Cannot read properties of undefined (reading 'x')` — un bug du client.
 *
 * ── La règle (liste BLANCHE, comme `server/src/httpError.ts`) ────────────────
 *
 * `userErrorMessage(err, repli)` ne rend le message de l'erreur que dans deux
 * cas, et seulement s'il ne ressemble pas à un détail technique :
 *
 *   1. `ApiError` 4xx dont le message vient du SERVEUR (`{ error }`), qui ne
 *      laisse lui-même sortir que des messages marqués `expose` ;
 *   2. `UserFacingError` : un message écrit côté client pour être lu
 *      (« Image trop grande »).
 *
 * Tout le reste rend le repli contextuel passé par l'écran (« Le blocage a
 * échoué »), ou un message de catégorie quand la cause est identifiable :
 * hors ligne, délai dépassé, trop de requêtes. Une erreur imprévue produit donc
 * un message générique, jamais une fuite — l'oubli est sans conséquence.
 *
 * Le détail complet, lui, n'est pas perdu : il part dans la console et dans
 * Sentry (déjà en place, avec rédaction des jetons dans `sentryImpl.ts`).
 */
import { tNow } from '../i18n';

/**
 * Erreur d'API qui conserve le statut HTTP et le `code` stable du serveur.
 *
 * `message` est le texte rédigé par le serveur pour l'utilisateur, ou le repli
 * du service quand le serveur n'en a pas donné de présentable. `body` garde le
 * reste du JSON (`email`, `limit`, `resetsAt`…) pour les écrans qui en ont
 * besoin.
 */
export class ApiError extends Error {
  readonly requestId?: string;
  readonly body: Record<string, unknown>;
  /** Vrai quand `message` vient du serveur (et non du repli du service). */
  readonly fromServer: boolean;

  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    extra: { requestId?: string; body?: Record<string, unknown>; fromServer?: boolean } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.requestId = extra.requestId;
    this.body = extra.body ?? {};
    this.fromServer = extra.fromServer ?? false;
  }
}

/** Message rédigé côté client, destiné à être affiché tel quel. */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserFacingError';
  }
}

/**
 * Construit une `ApiError` à partir d'une réponse non-OK. Lit le corps UNE fois,
 * tolère un corps vide, non JSON ou une page HTML — dans ces cas, rien du corps
 * n'entre dans le message.
 */
export async function apiErrorFromResponse(res: Response, fallback: string): Promise<ApiError> {
  let body: Record<string, unknown> = {};
  try {
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch { /* corps illisible : on garde le repli */ }

  const serverMsg = typeof body.error === 'string' ? body.error : undefined;
  const usable = !!serverMsg && isDisplayable(serverMsg);
  const code = typeof body.code === 'string' ? body.code : undefined;
  const requestId =
    (typeof body.requestId === 'string' ? body.requestId : undefined) ??
    res.headers?.get?.('x-request-id') ?? undefined;

  return new ApiError(usable ? serverMsg! : fallback, res.status, code, {
    requestId,
    body,
    fromServer: usable,
  });
}

/** Lance `apiErrorFromResponse` si la réponse n'est pas OK. */
export async function throwIfNotOk(res: Response, fallback: string): Promise<void> {
  if (!res.ok) throw await apiErrorFromResponse(res, fallback);
}

// ─── Détection des messages techniques ──────────────────────────────────────

const TECHNICAL_PATTERNS: RegExp[] = [
  /https?:\/\//i, /\bwww\./i, /\blocalhost\b/i, /\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/,  // URL, hôte, IP
  /\/api\//i, /\/v\d+\//,                                                          // endpoints
  /\.(ts|tsx|js|mjs|cjs|jsx|py|sql|json|map)\b/i, /node_modules|webpack|\bvite\b|chunk-/i,
  /[A-Z]:\\|\/src\/|\/usr\/|\/app\/|\/home\//,                                       // chemins
  /\n\s*at\s|\bat\s+\S+\s+\(|@\S+:\d+:\d+/,                                        // piles
  /\b(TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError|AbortError|DOMException)\b/,
  /\b(E(CONN\w+|NOTFOUND|TIMEDOUT|AI_AGAIN|PIPE|HOSTUNREACH|NETUNREACH)|UND_ERR\w*)\b/,
  /failed to fetch|load failed|networkerror|network request failed|fetch failed/i,
  /unexpected (token|end of)|json\.parse|is not valid json|in json at position/i,
  /cannot read propert|is not a function|is not defined|is undefined|null is not|undefined is not/i,
  /\b(select|insert|update|delete)\b[\s\S]*\b(from|into|set|where)\b/i,           // SQL
  /\b(relation|column|constraint|duplicate key|violates|sqlstate|syntax error at)\b/i,
  /\beyJ[\w-]{8,}\.|\bsk-[A-Za-z0-9_-]{8,}|\bBearer\s|\bapi[_-]?key\b|\bsecret\b|\btoken\s*[:=]/i,
  /<\s*(!doctype|html|head|body|div|pre|title|h1)\b/i,                              // pages HTML
  /^\s*[{[]|"\w+"\s*:/,                                                             // JSON brut
  /\b(HTTP|API|status( code)?)\s*\d{3}\b|\(\d{3}\)|\b\d{3}\s*:\s/i,                 // statut nu
  /\b(stack|trace|undefined|NaN|null)\b/,
  /\b(VITE_|NODE_ENV|process\.env|import\.meta)/,
  /^[a-z0-9]+(_[a-z0-9]+)+$/i,                                                    // identifiant (`free_parse_quota`)
];

/** Vrai si le texte ressemble à un détail technique ou interne. */
export function looksTechnical(msg: string): boolean {
  if (msg.length > 300) return true;
  return TECHNICAL_PATTERNS.some((re) => re.test(msg));
}

/** Messages génériques du serveur (`httpError.ts`, GENERIC_BY_STATUS) : un
 *  repli contextuel et traduit vaut mieux que ces formules anglaises. */
const SERVER_GENERIC = new Set([
  'bad request', 'unauthorized', 'payment required', 'forbidden', 'not found',
  'method not allowed', 'request timeout', 'conflict', 'gone', 'request too large',
  'unsupported media type', 'unprocessable request', 'too many requests',
  'not implemented', 'upstream service error', 'service temporarily unavailable',
  'upstream service timeout', 'internal server error', 'request failed',
  'invalid json body', 'request body too large',
]);

function isDisplayable(msg: string): boolean {
  const m = msg.trim();
  return m.length > 0 && !looksTechnical(m) && !SERVER_GENERIC.has(m.toLowerCase().replace(/[.!]$/, ''));
}

// ─── Classement ─────────────────────────────────────────────────────────────

export type ErrorKind = 'aborted' | 'offline' | 'network' | 'timeout' | 'rateLimited' | 'client' | 'server' | 'unknown';

export function isAbortError(err: unknown): boolean {
  return (err as any)?.name === 'AbortError';
}

function isNetworkError(err: unknown): boolean {
  const e = err as any;
  return e instanceof TypeError && /fetch|load failed|network/i.test(String(e?.message ?? ''));
}

export function errorKind(err: unknown): ErrorKind {
  if (isAbortError(err)) return 'aborted';
  if ((err as any)?.name === 'RequestTimeoutError') return 'timeout';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  if (isNetworkError(err)) return 'network';
  const status = Number((err as any)?.status);
  if (status === 429) return 'rateLimited';
  if (status >= 500 && status <= 599) return 'server';
  if (status >= 400 && status <= 499) return 'client';
  return 'unknown';
}

/**
 * LE message à afficher pour une erreur, quelle qu'elle soit.
 *
 * @param fallback repli contextuel, déjà traduit (« Le blocage a échoué »).
 */
export function userErrorMessage(err: unknown, fallback: string): string {
  const kind = errorKind(err);
  const msg = typeof (err as any)?.message === 'string' ? ((err as any).message as string) : '';

  switch (kind) {
    case 'aborted':  return fallback;
    case 'offline':  return tNow('error.offline');
    case 'network':  return tNow('error.network');
    case 'timeout':  return tNow('error.timeout');
    case 'rateLimited':
      return err instanceof ApiError && err.fromServer && isDisplayable(msg) ? msg : tNow('error.rateLimited');
    case 'server':   return fallback;
    case 'client':
      if (err instanceof ApiError) return err.fromServer && isDisplayable(msg) ? msg : fallback;
      // Erreur portant un statut sans être une ApiError (LLMError, Object.assign) :
      // le message doit au moins être présentable.
      return isDisplayable(msg) ? msg : fallback;
    default:
      if (err instanceof UserFacingError && isDisplayable(msg)) return msg;
      return fallback;
  }
}

/** Repli générique, quand l'écran n'a pas de formulation propre. */
export function genericErrorMessage(): string {
  return tNow('error.generic');
}
