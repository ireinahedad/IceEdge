/**
 * httpError.ts — comment une erreur devient une réponse HTTP. Un seul endroit.
 *
 * ── Le problème que ce module règle ─────────────────────────────────────────
 *
 * `app.ts` se termine par un gestionnaire d'erreurs global qui fait exactement
 * la bonne chose : il masque le message des 5xx en production, parce qu'un
 * message d'erreur interne décrit l'infrastructure (hôtes en amont, noms de
 * base, chemins de fichiers, versions de bibliothèques) et que rien de tout cela
 * n'aide l'appelant.
 *
 * Sauf que quatre-vingt-treize handlers écrivaient eux-mêmes
 * `res.status(err.status ?? 500).json({ error: err.message })`. Un handler qui
 * répond lui-même n'appelle jamais `next(err)` : le gestionnaire global ne
 * s'exécute pas, et sa protection ne s'applique pas. La règle existait,
 * soigneusement écrite et commentée, et elle ne couvrait quasiment aucune route.
 *
 * Ce que cela donnait concrètement, en production, à qui savait quoi appeler :
 *
 *   • `GET /api/nhl/games?date=…` sur une API NHL lente →
 *     `{"error":"NHL API timeout (8000 ms) for https://api-web.nhle.com/v1/…"}`
 *     — l'hôte en amont, le chemin exact, et le timeout configuré.
 *   • `POST /api/predict/ml` → `{"error":"ML service unavailable","detail":…}`
 *     où `detail` porte l'adresse du service Python.
 *   • `POST /api/llm` sans la migration 005 →
 *     `« Run: psql -d IceedgeDB -f src/db/migrations/005_openai_key.sql »` —
 *     le nom de la base ET l'arborescence du dépôt.
 *   • n'importe quelle erreur `pg` inattendue → le nom de la colonne, de la
 *     contrainte, et souvent un fragment de la requête.
 *
 * ── Le deuxième problème, moins visible ─────────────────────────────────────
 *
 * Ces messages partaient au client et **nulle part ailleurs**. Le gestionnaire
 * global journalise ; ces handlers-là, non. Masquer le message sans le
 * journaliser aurait donc échangé une fuite contre un aveuglement. `sendError`
 * fait les deux à la fois : réponse muette côté client, erreur complète côté
 * serveur, corrélée à son `request-id` via le logger de la requête.
 *
 * ── La règle (liste BLANCHE depuis le 2026-11-22) ───────────────────────────
 *
 *   Un message part au client SI ET SEULEMENT SI l'erreur porte `expose: true`.
 *
 *   • `publicError(409, 'Email or username already in use')` (ou l'ancien
 *     `Object.assign(new Error('…'), { status: 409, expose: true })`) : message
 *     écrit par nous, pour être lu, il traverse — 4xx comme 5xx.
 *   • Tout le reste — erreur `pg`, `fetch failed`, `jwt malformed`, erreur
 *     d'amont qui recopie le statut de l'API NHL ou du service ML, erreur d'une
 *     bibliothèque tierce — reçoit un message FIXE choisi d'après le statut
 *     (`Not found`, `Bad request`, `Internal server error`…).
 *
 *   La version précédente faisait l'inverse (« 4xx → message tel quel ») et
 *   c'était une liste noire déguisée : `mlApiClient` levait
 *   `ML service 422: {"detail":[{"loc":["body","home_team"]…` avec
 *   `status: 422`, `fetchStats` levait `NHL stats API 404 for <ressource>` avec
 *   `status: 404`, `jsonwebtoken` rendait `invalid signature` sous le repli 401
 *   — tous des 4xx, donc tous relayés. Une liste blanche, elle, ne peut pas
 *   être prise en défaut par un cas qu'on n'a pas prévu : l'oubli d'`expose`
 *   produit un message générique, jamais une fuite.
 *
 *   En dev, le vrai message est rendu dans tous les cas : c'est là qu'on débogue.
 *
 *   Sur un 5xx, la réponse porte `requestId` (le même que l'en-tête
 *   `x-request-id` et que la ligne de journal) : l'utilisateur peut le donner au
 *   support, nous le retrouvons dans les journaux, et il ne dit rien de
 *   l'infrastructure.
 *
 * Le statut ne vient PAS de `err.status ?? 500` naïvement : une valeur qui n'est
 * pas un code HTTP valide (une erreur `pg` porte `code: '23505'`, un
 * `AbortError` ne porte rien) retombe sur 500, donc sur le chemin muet. C'est
 * l'inverse du piège précédent, où `err.status ?? 400` transformait toute erreur
 * inattendue en 4xx — et lui rendait donc son message.
 */

import type { Response } from 'express';
import { logger } from './logger';
import * as Sentry from '@sentry/node';

const GENERIC_5XX = 'Internal server error';

/** Message fixe par statut, quand l'erreur n'est pas marquée `expose`. */
const GENERIC_BY_STATUS: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  402: 'Payment required',
  403: 'Forbidden',
  404: 'Not found',
  405: 'Method not allowed',
  408: 'Request timeout',
  409: 'Conflict',
  410: 'Gone',
  413: 'Request too large',
  415: 'Unsupported media type',
  422: 'Unprocessable request',
  429: 'Too many requests',
  501: 'Not implemented',
  502: 'Upstream service error',
  503: 'Service temporarily unavailable',
  504: 'Upstream service timeout',
};

/** Message générique sûr pour un statut donné. */
export function genericMessage(status: number): string {
  return GENERIC_BY_STATUS[status] ?? (status >= 500 ? GENERIC_5XX : 'Request failed');
}

/**
 * Erreurs de `body-parser` (via `express.json`) : elles portent `expose: true`
 * selon la convention `http-errors`, mais leur message est technique
 * (« Unexpected token } in JSON at position 10 »). On les traduit par `type`.
 */
const BODY_PARSER_MESSAGES: Record<string, string> = {
  'entity.parse.failed':      'Invalid JSON body',
  'entity.too.large':         'Request body too large',
  'encoding.unsupported':     'Unsupported content encoding',
  'charset.unsupported':      'Unsupported charset',
  'request.aborted':          'Request aborted',
  'request.size.invalid':     'Invalid request size',
  'stream.encoding.set':      'Bad request',
  'parameters.too.many':      'Too many parameters',
};

/** Longueur maximale d'un message rendu : un message public est une phrase. */
const MAX_PUBLIC_MESSAGE = 300;

/**
 * Fabrique l'erreur dont le message EST destiné au client.
 *
 *     throw publicError(404, 'Slip not found');
 *     throw publicError(409, 'Game already started', { code: 'GAME_STARTED' });
 *
 * N'y passer qu'un texte écrit par nous — jamais `err.message`, jamais une
 * valeur venue d'un amont.
 */
export function publicError(
  status: number,
  message: string,
  extra: Record<string, unknown> = {},
): Error & { status: number; expose: true } {
  return Object.assign(new Error(message), { ...extra, status, expose: true as const });
}

export interface SendErrorOptions {
  /** Message rendu quand l'erreur n'est pas `expose` (en production). Doit être
   *  une constante, jamais dérivée de l'erreur. Défaut : message générique du
   *  statut (« Internal server error », « Not found »…). */
  fallbackMessage?: string;
  /** Statut à utiliser quand l'erreur n'en porte pas de valide. Défaut : 500.
   *  Les middlewares d'authentification passent 401 : une erreur sans statut y
   *  signifie « jeton refusé », pas « le serveur est cassé ». */
  fallbackStatus?: number;
  /** Étiquette de journalisation, ex. `[predict/best-bets]`. */
  context?: string;
  /** Champs supplémentaires à joindre à la réponse (`email`, `limit`, …).
   *  N'y mettre que des valeurs destinées au client. */
  extra?: Record<string, unknown>;
  /** Identifiant de requête à joindre aux 5xx (posé par `sendError` et le
   *  gestionnaire global d'après `req.id`). */
  requestId?: string;
}

/**
 * Statut HTTP porté par l'erreur, ou le repli.
 *
 * `Number.isInteger` + bornes : `err.status` vient parfois d'une bibliothèque
 * tierce et vaut alors n'importe quoi. Un statut invalide doit ramener vers 500.
 */
export function errorStatus(err: unknown, fallback = 500): number {
  const raw = Number((err as any)?.status);
  return Number.isInteger(raw) && raw >= 400 && raw <= 599 ? raw : fallback;
}

/**
 * Codes d'erreur que le client a le droit de lire.
 *
 * `code` est le discriminant stable que l'UI teste (`EMAIL_NOT_VERIFIED`,
 * `PRO_REQUIRED`, `no_api_key`…). Mais le même champ existe sur les erreurs
 * système et tierces, et celles-là décrivent l'infrastructure :
 * `ECONNREFUSED`/`ENOTFOUND` (Node : il y a un hôte derrière, et il est
 * tombé), `UND_ERR_CONNECT_TIMEOUT` (undici), `42P01`/`23505` (SQLSTATE
 * Postgres : la base, et la nature de la requête), `ERR_INVALID_ARG_TYPE`.
 *
 * Règle : un code écrit par nous, sur une erreur `expose`, passe toujours.
 * Sinon il doit avoir la forme d'un identifiant et ne ressembler à aucune
 * famille système connue — et l'erreur ne doit pas être une erreur système
 * (`errno`/`syscall`) ni une erreur `pg` (`severity`/`routine`).
 */
const SYSTEM_CODE = /^(E[A-Z0-9]{2,}$|ERR_|UND_ERR|ABORT_ERR|CERT_|DEPTH_ZERO|UNABLE_TO_|SELF_SIGNED|HPE_)/;
const TRUSTED_SYSTEM_LIKE = new Set(['EMAIL_NOT_VERIFIED']);

export function safeErrorCode(err: unknown): string | undefined {
  const e = err as any;
  const code = e?.code;
  if (typeof code !== 'string' || code.length === 0 || code.length > 40) return undefined;
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(code)) return undefined;
  if (e?.expose === true) return code;
  if (e?.errno !== undefined || e?.syscall !== undefined) return undefined;
  if (e?.severity !== undefined || e?.routine !== undefined) return undefined;
  if (SYSTEM_CODE.test(code) && !TRUSTED_SYSTEM_LIKE.has(code)) return undefined;
  return code;
}

/**
 * Le message qu'un client a le droit de lire pour cette erreur.
 */
export function publicMessage(err: unknown, status: number, fallback?: string): string {
  const e = err as any;
  const generic = fallback ?? genericMessage(status);
  const raw = typeof e?.message === 'string' ? e.message : undefined;

  if (process.env.NODE_ENV !== 'production') return raw ?? generic;

  // body-parser / http-errors : `expose` vrai mais message technique.
  if (typeof e?.type === 'string' && BODY_PARSER_MESSAGES[e.type]) return BODY_PARSER_MESSAGES[e.type];

  if (e?.expose === true && raw && raw.length <= MAX_PUBLIC_MESSAGE) return raw;
  return generic;
}

/**
 * Le corps JSON à renvoyer pour une erreur. Exporté pour que le gestionnaire
 * global d'`app.ts` applique LA MÊME règle — deux définitions de « qu'est-ce
 * qu'on a le droit de dire » finiraient par diverger, et la divergence est
 * exactement ce qui a produit le problème d'origine.
 */
export function errorBody(err: unknown, opts: SendErrorOptions = {}): Record<string, unknown> {
  const status = errorStatus(err, opts.fallbackStatus ?? 500);
  const body: Record<string, unknown> = { error: publicMessage(err, status, opts.fallbackMessage) };

  const code = safeErrorCode(err);
  if (code) body.code = code;

  if (status >= 500 && opts.requestId) body.requestId = opts.requestId;
  if (opts.extra) Object.assign(body, opts.extra);
  return body;
}

/** `req.id` posé par `pino-http`, s'il existe et a une forme raisonnable. */
export function requestIdOf(req: unknown): string | undefined {
  const id = (req as any)?.id;
  return (typeof id === 'string' || typeof id === 'number') && String(id).length <= 100 ? String(id) : undefined;
}

/**
 * Répond à une erreur, et la journalise quand elle mérite de l'être.
 *
 * Remplace `res.status(err.status ?? 500).json({ error: err.message })`.
 *
 * Journalisation : les 5xx uniquement. Un 4xx est un déroulement normal — un
 * code périmé, un e-mail déjà pris — et les journaliser noierait les vraies
 * pannes. On préfère le logger de la requête (`req.log`, posé par `pino-http`)
 * quand il existe : l'erreur porte alors le `request-id` de la réponse, ce qui
 * permet de relier un rapport d'utilisateur à sa ligne de journal.
 */
export function sendError(res: Response, err: unknown, opts: SendErrorOptions = {}): Response {
  const status = errorStatus(err, opts.fallbackStatus ?? 500);

  if (status >= 500) {
    const log = (res.req as any)?.log ?? logger;
    // Erreur COMPLÈTE côté serveur : message, pile, code, statut d'origine.
    // C'est la seule copie de ces détails — le client n'en reçoit aucun.
    log.error(
      {
        err: (err as any)?.message ?? err,
        stack: (err as any)?.stack,
        code: (err as any)?.code,
        upstreamStatus: (err as any)?.status,
      },
      opts.context ?? 'request failed',
    );
    // Un handler qui répond lui-même n'appelle jamais `next(err)`, donc
    // `Sentry.setupExpressErrorHandler` ne voyait AUCUNE de ces erreurs : un 500
    // sur une panne Postgres partait dans les journaux et nulle part ailleurs
    // (QA dynamique du 2026-09-26). 501 et 503 sont exclus : ce sont des
    // indisponibilités annoncées (Stripe non configuré, service ML coupé,
    // disjoncteur ouvert) — les remonter enverrait un événement par requête
    // pendant toute la panne et viderait le quota. No-op sans SENTRY_DSN.
    if (status !== 501 && status !== 503) {
      Sentry.captureException(err instanceof Error ? err : new Error(String((err as any)?.message ?? err)), {
        tags: { handled_by: 'sendError', ...(opts.context ? { context: opts.context } : {}) },
      });
    }
  }

  // Les 4xx non `expose` sont journalisés en `warn` : ce sont eux qui
  // signalent une erreur d'amont qui a recopié son statut (NHL 404, ML 422) ou
  // un message qu'on a oublié de marquer — sans quoi on ne les verrait jamais.
  if (status < 500 && (err as any)?.expose !== true) {
    const log = (res.req as any)?.log ?? logger;
    log.warn({ err: (err as any)?.message ?? err, status }, opts.context ?? 'client error (message masqué)');
  }

  const requestId = opts.requestId ?? requestIdOf(res.req);
  return res.status(status).json(errorBody(err, { ...opts, requestId }));
}
