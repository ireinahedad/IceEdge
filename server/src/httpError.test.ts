import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * La règle « ce qu'un client a le droit de lire d'une erreur ».
 *
 * Ce fichier existe pour une régression dont le coût est invisible tant qu'elle
 * n'est pas exploitée : jusqu'au 2026-09-04, quatre-vingt-treize handlers
 * répondaient eux-mêmes `res.status(err.status ?? 500).json({ error: err.message })`.
 * Un handler qui répond lui-même ne passe jamais par le gestionnaire global
 * d'`app.ts` — donc la protection écrite là, et soigneusement commentée, ne
 * s'appliquait à presque aucune route.
 *
 * Le cas qui rend la chose concrète est en bas de ce fichier : une erreur dont
 * le message contient l'URL amont. C'est ce que lève réellement `nhlApiClient`
 * quand l'API NHL dépasse son délai.
 */

const logError = vi.fn();
// La fabrique de `vi.mock` est hissée en tête de fichier : elle ne peut pas
// LIRE `logError` au moment où elle s'exécute, seulement l'appeler plus tard.
// D'où l'indirection — c'est aussi ce que font les autres tests du dépôt.
vi.mock('./logger', () => ({
  logger: {
    error: (...args: unknown[]) => logError(...args),
    warn:  () => {},
    info:  () => {},
    debug: () => {},
  },
}));

const captureException = vi.fn();
vi.mock('@sentry/node', () => ({ captureException: (...args: unknown[]) => captureException(...args) }));

import { errorStatus, errorBody, sendError, publicError } from './httpError';

const ORIGINAL_ENV = process.env.NODE_ENV;
afterEach(() => { process.env.NODE_ENV = ORIGINAL_ENV; });
beforeEach(() => { logError.mockClear(); captureException.mockClear(); });

const prod = () => { process.env.NODE_ENV = 'production'; };

describe('errorStatus', () => {
  it('retient le statut porté par l\'erreur', () => {
    expect(errorStatus(Object.assign(new Error('x'), { status: 404 }))).toBe(404);
    expect(errorStatus(Object.assign(new Error('x'), { status: 402 }))).toBe(402);
  });

  /**
   * Le piège que ce garde-fou ferme : une erreur `pg` porte `code: '23505'` et
   * parfois d'autres champs numériques, un `AbortError` ne porte rien, et une
   * bibliothèque tierce peut poser n'importe quoi dans `status`. Avec un simple
   * `err.status ?? 500`, une valeur parasite dans la plage 4xx ferait passer une
   * panne interne pour une erreur client — et lui rendrait donc son message.
   */
  it('ramène tout statut invalide vers le repli', () => {
    expect(errorStatus(new Error('sans statut'))).toBe(500);
    expect(errorStatus({ status: '23505' })).toBe(500);
    expect(errorStatus({ status: 999 })).toBe(500);
    expect(errorStatus({ status: 200 })).toBe(500);
    expect(errorStatus({ status: NaN })).toBe(500);
    expect(errorStatus(null)).toBe(500);
  });

  it('accepte un repli explicite, pour les middlewares d\'authentification', () => {
    expect(errorStatus(new Error('jeton refusé'), 401)).toBe(401);
  });
});

describe('errorBody — la règle', () => {
  it('message marqué `expose` : il part tel quel, il est écrit pour être lu', () => {
    prod();
    expect(errorBody(publicError(409, 'Email or username already in use')))
      .toEqual({ error: 'Email or username already in use' });
    const legacy = Object.assign(new Error('Slip not found'), { status: 404, expose: true });
    expect(errorBody(legacy)).toEqual({ error: 'Slip not found' });
  });

  /**
   * Le cœur de la liste blanche : un 4xx SANS `expose` est presque toujours une
   * erreur d'amont qui a recopié son statut, et son message décrit l'amont.
   * Ce sont les cas réels relevés le 2026-11-22.
   */
  it('4xx non marqué : message générique, jamais celui de l\'erreur', () => {
    prod();
    const ml = Object.assign(
      new Error('ML service 422: {"detail":[{"loc":["body","home_team"],"msg":"field required"}]}'),
      { status: 422 },
    );
    expect(errorBody(ml)).toEqual({ error: 'Unprocessable request' });
    const nhl = Object.assign(new Error('NHL stats API 404 for team summary'), { status: 404 });
    expect(errorBody(nhl)).toEqual({ error: 'Not found' });
    // jsonwebtoken, sous le repli 401 des middlewares d'authentification.
    expect(errorBody(new Error('invalid signature'), { fallbackStatus: 401 })).toEqual({ error: 'Unauthorized' });
  });

  it('body-parser : `expose` vrai mais message technique → traduit par type', () => {
    prod();
    const err = Object.assign(new SyntaxError('Unexpected token } in JSON at position 10'), {
      status: 400, expose: true, type: 'entity.parse.failed',
    });
    expect(errorBody(err)).toEqual({ error: 'Invalid JSON body' });
  });

  it('5xx marqué `expose` : un message d\'indisponibilité rédigé pour l\'utilisateur passe', () => {
    prod();
    expect(errorBody(publicError(503, 'NHL schedule unavailable', { code: 'schedule_unavailable' })))
      .toEqual({ error: 'NHL schedule unavailable', code: 'schedule_unavailable' });
  });

  it('5xx : `requestId` joint pour le support, jamais sur un 4xx', () => {
    prod();
    expect(errorBody(new Error('boom'), { requestId: 'req-1' }))
      .toEqual({ error: 'Internal server error', requestId: 'req-1' });
    expect(errorBody(publicError(404, 'Slip not found'), { requestId: 'req-1' }))
      .toEqual({ error: 'Slip not found' });
  });

  it('codes système, Postgres et undici ne traversent pas', () => {
    prod();
    expect(errorBody(Object.assign(new Error('x'), { code: 'ECONNREFUSED', errno: -111, syscall: 'connect' })))
      .not.toHaveProperty('code');
    expect(errorBody(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).not.toHaveProperty('code');
    expect(errorBody(Object.assign(new Error('x'), { code: 'UND_ERR_CONNECT_TIMEOUT' }))).not.toHaveProperty('code');
    expect(errorBody(Object.assign(new Error('x'), { code: '23505', severity: 'ERROR' }))).not.toHaveProperty('code');
    expect(errorBody(Object.assign(new Error('x'), { code: '42P01' }))).not.toHaveProperty('code');
    expect(errorBody(Object.assign(new Error('x'), { code: 'ERR_INVALID_ARG_TYPE' }))).not.toHaveProperty('code');
    // …mais nos codes applicatifs, oui, même sur un 5xx.
    expect(errorBody(Object.assign(new Error('x'), { status: 500, code: 'db_schema' }))).toMatchObject({ code: 'db_schema' });
  });

  it('5xx en production : le message est remplacé', () => {
    prod();
    const err = new Error('connect ECONNREFUSED 10.0.3.14:5432');
    expect(errorBody(err)).toEqual({ error: 'Internal server error' });
  });

  it('5xx hors production : le vrai message, c\'est là qu\'on débogue', () => {
    process.env.NODE_ENV = 'development';
    const err = new Error('connect ECONNREFUSED 10.0.3.14:5432');
    expect(errorBody(err)).toEqual({ error: 'connect ECONNREFUSED 10.0.3.14:5432' });
  });

  it('5xx en production : le repli de la route, jamais l\'erreur', () => {
    prod();
    const err = new Error('getaddrinfo ENOTFOUND ml-internal.railway.internal');
    expect(errorBody(err, { fallbackMessage: 'Best bets failed' }))
      .toEqual({ error: 'Best bets failed' });
  });

  it('`code` traverse — le client teste dessus, et il ne décrit pas l\'infrastructure', () => {
    prod();
    const err = Object.assign(new Error('Pro subscription required'), { status: 402, code: 'PRO_REQUIRED', expose: true });
    expect(errorBody(err)).toEqual({ error: 'Pro subscription required', code: 'PRO_REQUIRED' });
  });

  it('un `code` qui n\'est pas une chaîne courte ne traverse pas', () => {
    prod();
    expect(errorBody({ status: 500, code: { nested: true } })).not.toHaveProperty('code');
    expect(errorBody({ status: 500, code: 'x'.repeat(41) })).not.toHaveProperty('code');
  });

  it('les extras explicites sont joints', () => {
    prod();
    const err = Object.assign(new Error('Email not verified'), {
      status: 403, code: 'EMAIL_NOT_VERIFIED', expose: true,
    });
    expect(errorBody(err, { extra: { email: 'a@b.com' } })).toEqual({
      error: 'Email not verified', code: 'EMAIL_NOT_VERIFIED', email: 'a@b.com',
    });
  });
});

describe('sendError — journalisation', () => {
  function appThatThrows(err: unknown, opts?: Parameters<typeof sendError>[2]) {
    const a = express();
    a.get('/boom', (_req, res) => { sendError(res, err, opts); });
    return a;
  }

  it('journalise les 5xx : masquer un message sans le garder serait pire que la fuite', async () => {
    prod();
    await request(appThatThrows(new Error('relation "user_bets" does not exist')))
      .get('/boom').expect(500);

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0][0]).toMatchObject({ err: 'relation "user_bets" does not exist' });
  });

  it('ne journalise pas les 4xx — un code périmé n\'est pas une panne', async () => {
    prod();
    const err = Object.assign(new Error('Invalid or expired code'), { status: 400 });
    await request(appThatThrows(err)).get('/boom').expect(400);
    expect(logError).not.toHaveBeenCalled();
  });

  it('porte le contexte de la route dans le journal', async () => {
    prod();
    await request(appThatThrows(new Error('boom'), { context: '[predict/best-bets]' }))
      .get('/boom').expect(500);
    expect(logError.mock.calls[0][1]).toBe('[predict/best-bets]');
  });
});

describe('la fuite d\'origine', () => {
  /**
   * `nhlApiClient` lève littéralement :
   *   `NHL API timeout (8000 ms) for https://api-web.nhle.com/v1/score/2026-01-15`
   * Cette erreur ne porte pas de `status`, donc elle vaut 500 — et en
   * production son message ne doit pas quitter le serveur. Avant, il partait
   * dans le corps de `GET /api/nhl/games?date=…`, hôte amont et chemin compris,
   * accessible à qui savait appeler la route.
   */
  const REAL = new Error('NHL API timeout (8000 ms) for https://api-web.nhle.com/v1/score/2026-01-15');

  function app() {
    const a = express();
    a.get('/games', (_req, res) => { sendError(res, REAL); });
    return a;
  }

  it('ne laisse ni l\'hôte amont ni le chemin atteindre le client', async () => {
    prod();
    const res = await request(app()).get('/games').expect(500);

    expect(res.body).toEqual({ error: 'Internal server error' });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('api-web.nhle.com');
    expect(body).not.toContain('8000');
  });

  it('mais le journal, lui, garde tout', async () => {
    prod();
    await request(app()).get('/games').expect(500);
    expect(logError.mock.calls[0][0].err).toContain('https://api-web.nhle.com/v1/score/2026-01-15');
  });
});

describe('sendError → Sentry', () => {
  // QA dynamique 2026-09-26 : les handlers qui répondent eux-mêmes n'appellent
  // jamais next(err), donc Sentry ne voyait aucun de leurs 500.
  function fakeRes() {
    const res: any = { req: {}, status: vi.fn(() => res), json: vi.fn(() => res) };
    return res;
  }

  it('un 500 part à Sentry', () => {
    sendError(fakeRes(), new Error('connect ECONNREFUSED'));
    expect(captureException).toHaveBeenCalledTimes(1);
    expect((captureException.mock.calls[0][0] as Error).message).toBe('connect ECONNREFUSED');
  });

  it('un 4xx, un 501 et un 503 n’y partent pas', () => {
    sendError(fakeRes(), Object.assign(new Error('bad'), { status: 400 }));
    sendError(fakeRes(), Object.assign(new Error('stripe off'), { status: 501 }));
    sendError(fakeRes(), Object.assign(new Error('ML down'), { status: 503 }));
    expect(captureException).not.toHaveBeenCalled();
  });
});
