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
 * ── La règle ────────────────────────────────────────────────────────────────
 *
 *   4xx  → le message part tel quel. Un code client est une erreur DE
 *          l'appelant : « Email or username already in use », « Invalid or
 *          expired code ». Ces messages sont écrits pour être lus, et l'UI les
 *          affiche. Ils ne décrivent pas l'infrastructure.
 *   5xx  → en production, un message fixe écrit par nous. En dev, le vrai
 *          message : c'est là qu'on débogue.
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

export interface SendErrorOptions {
  /** Message rendu sur un 5xx en production. Doit être une constante, jamais
   *  dérivée de l'erreur. Défaut : « Internal server error ». */
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
}

/**
 * Statut HTTP porté par l'erreur, ou le repli.
 *
 * `Number.isInteger` + bornes : `err.status` vient parfois d'une bibliothèque
 * tierce et vaut alors n'importe quoi. Un statut invalide doit ramener vers 500,
 * jamais vers un 4xx qui rendrait le message.
 */
export function errorStatus(err: unknown, fallback = 500): number {
  const raw = Number((err as any)?.status);
  return Number.isInteger(raw) && raw >= 400 && raw <= 599 ? raw : fallback;
}

/**
 * Le corps JSON à renvoyer pour une erreur. Exporté pour que le gestionnaire
 * global d'`app.ts` applique LA MÊME règle — deux définitions de « qu'est-ce
 * qu'on a le droit de dire » finiraient par diverger, et la divergence est
 * exactement ce qui a produit le problème d'origine.
 */
export function errorBody(err: unknown, opts: SendErrorOptions = {}): Record<string, unknown> {
  const status   = errorStatus(err, opts.fallbackStatus ?? 500);
  const fallback = opts.fallbackMessage ?? GENERIC_5XX;
  const isProd   = process.env.NODE_ENV === 'production';

  const message =
    status < 500
      ? ((err as any)?.message ?? fallback)
      : (isProd ? fallback : ((err as any)?.message ?? fallback));

  const body: Record<string, unknown> = { error: message };

  // `code` est un discriminant court et stable que le client teste
  // (`EMAIL_NOT_VERIFIED`, `PRO_REQUIRED`, `no_api_key`…). Il ne décrit rien de
  // l'infrastructure — contrairement au message — donc il traverse même sur un
  // 5xx. Borné et typé pour qu'aucune erreur tierce ne l'utilise comme fourgon
  // (une erreur `pg` porte `code: '23505'`, ce qui est inoffensif mais inutile ;
  // la longueur maximale ne fait qu'empêcher un jour un `code` verbeux).
  const code = (err as any)?.code;
  if (typeof code === 'string' && code.length > 0 && code.length <= 40) body.code = code;

  if (opts.extra) Object.assign(body, opts.extra);
  return body;
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
    log.error(
      { err: (err as any)?.message ?? err, stack: (err as any)?.stack },
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

  return res.status(status).json(errorBody(err, opts));
}
