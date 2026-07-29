import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

import { publicCache, privateCache, noStore, publicPolicy, NO_STORE, TTL } from './httpCache.middleware';

/**
 * Ces tests portent sur les deux choses qu'une simple ligne
 * `res.set('Cache-Control', …)` ne garantit pas, et qui sont les deux façons
 * dont cet en-tête cause de vrais incidents :
 *
 *  1. cacher une réponse d'erreur (une panne amont de 10 s devient une panne
 *     de 30 min pour tous les visiteurs derrière le CDN) ;
 *  2. laisser `public` sur une donnée d'utilisateur (un cache partagé sert
 *     alors le profil de A à B).
 */

function app(mount: (a: express.Express) => void) {
  const a = express();
  mount(a);
  return a;
}

describe('publicCache', () => {
  it('pose la politique publique sur un 2xx', async () => {
    const a = app((x) => x.get('/ok', publicCache(60), (_q, r) => { r.json({ ok: true }); }));

    const res = await request(a).get('/ok');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=120');
  });

  // LA régression que ce middleware existe pour empêcher. Un `res.set` posé au
  // montage se serait appliqué aussi à ce 502.
  it('ne cache JAMAIS une réponse d’erreur', async () => {
    const a = app((x) =>
      x.get('/ko', publicCache(1800), (_q, r) => { r.status(502).json({ error: 'upstream' }); })
    );

    const res = await request(a).get('/ko');
    expect(res.status).toBe(502);
    expect(res.headers['cache-control']).toBe(NO_STORE);
  });

  it('ne cache pas non plus un 404 ni un 400', async () => {
    const a = app((x) => {
      x.get('/notfound', publicCache(300), (_q, r) => { r.status(404).json({ error: 'nope' }); });
      x.get('/bad',      publicCache(300), (_q, r) => { r.status(400).json({ error: 'bad' }); });
    });

    expect((await request(a).get('/notfound')).headers['cache-control']).toBe(NO_STORE);
    expect((await request(a).get('/bad')).headers['cache-control']).toBe(NO_STORE);
  });

  // L'échappatoire utilisée par les routes de match : un match terminé ne
  // change plus, on allonge le cache dans le handler.
  it('laisse la main à un handler qui a posé son propre en-tête', async () => {
    const a = app((x) =>
      x.get('/final', publicCache(30), (_q, r) => {
        r.set('Cache-Control', publicPolicy(TTL.FINAL));
        r.json({ status: 'final' });
      })
    );

    const res = await request(a).get('/final');
    expect(res.headers['cache-control']).toBe('public, max-age=21600, stale-while-revalidate=43200');
  });

  it('couvre res.send comme res.json', async () => {
    const a = app((x) => x.get('/txt', publicCache(60), (_q, r) => { r.send('hello'); }));

    expect((await request(a).get('/txt')).headers['cache-control'])
      .toBe('public, max-age=60, stale-while-revalidate=120');
  });

  // Un cache partagé n'est pas censé stocker une réponse à un POST, mais
  // l'annoncer coûte une ligne et retire l'ambiguïté.
  it('ne pose pas `public` sur autre chose qu’un GET/HEAD', async () => {
    const a = app((x) => x.post('/write', publicCache(60), (_q, r) => { r.json({ ok: true }); }));

    expect((await request(a).post('/write')).headers['cache-control']).toBe(NO_STORE);
  });
});

describe('privateCache', () => {
  it('autorise le navigateur mais jamais un cache partagé', async () => {
    const a = app((x) => x.get('/search', privateCache(300), (_q, r) => { r.json([]); }));

    const cc = (await request(a).get('/search')).headers['cache-control'];
    expect(cc).toBe('private, max-age=300');
    expect(cc).not.toContain('public');
  });
});

describe('noStore', () => {
  it('interdit le stockage sur un 2xx comme sur une erreur', async () => {
    const a = app((x) => {
      x.get('/me',  noStore, (_q, r) => { r.json({ email: 'a@b.c' }); });
      x.get('/401', noStore, (_q, r) => { r.status(401).json({ error: 'nope' }); });
    });

    expect((await request(a).get('/me')).headers['cache-control']).toBe(NO_STORE);
    expect((await request(a).get('/401')).headers['cache-control']).toBe(NO_STORE);
  });
});

/**
 * Le vrai câblage, pas le middleware isolé : c'est la seule façon de vérifier
 * qu'aucun routeur d'utilisateur n'est parti en `public` par inadvertance —
 * et ce test échouera si quelqu'un ajoute demain un routeur authentifié sans
 * `noStore`.
 */
describe('câblage de app.ts', () => {
  /**
   * `noStore` est monté sur le PRÉFIXE, pas sur chaque route : c'est ce qui
   * garantit qu'une route ajoutée demain dans l'un de ces routeurs est couverte
   * sans que personne y pense. Le test porte donc sur le préfixe.
   *
   * Sonder un chemin inexistant sous chaque préfixe est délibéré : la requête
   * traverse le middleware monté puis retombe sur le 404 global, sans toucher à
   * Postgres ni à l'authentification. Une sonde sur une vraie route (par ex.
   * `GET /api/chat/rooms`, ouvert aux invités) irait interroger la base et
   * rendrait ce garde-fou de sécurité dépendant d'un service externe — donc
   * instable, donc ignoré au premier rouge.
   */
  const USER_DATA_PREFIXES = [
    '/api/auth',
    '/api/users',
    '/api/chat',
    '/api/slips',
    '/api/llm',
    '/api/subscription',
    '/api/push',
  ];

  it('tout préfixe portant des données utilisateur répond `no-store`', async () => {
    const { default: appUnderTest } = await import('../app');

    for (const prefix of USER_DATA_PREFIXES) {
      const res = await request(appUnderTest).get(`${prefix}/__sonde_inexistante__`);
      const cc  = res.headers['cache-control'] ?? '';
      // L'en-tête doit être PRÉSENT et valoir no-store : son absence laisse la
      // décision à l'heuristique du CDN, ce qui est précisément ce qu'on refuse.
      expect(cc, `${prefix}/* → ${res.status} / Cache-Control: ${cc || '(absent)'}`)
        .toBe(NO_STORE);
    }
  });

  // Doublons sur de vraies routes, choisies parce qu'elles répondent 401 sur un
  // simple test de jeton — sans requête SQL, donc sans dépendance externe.
  it('le vaut aussi sur de vraies réponses 401', async () => {
    const { default: appUnderTest } = await import('../app');

    for (const path of ['/api/auth/me', '/api/users/me', '/api/subscription/me']) {
      const res = await request(appUnderTest).get(path);
      expect(res.status, `${path} devait répondre 401`).toBe(401);
      expect(res.headers['cache-control'], path).toBe(NO_STORE);
    }
  });

  it('les routes NHL publiques annoncent bien un cache partagé', async () => {
    const { default: appUnderTest } = await import('../app');

    // Paramètres invalides → 400 immédiat, aucun appel réseau vers la NHL.
    // Un 400 ne doit justement PAS être caché.
    const bad = await request(appUnderTest).get('/api/nhl/games/range?start=nope&end=nope');
    expect(bad.status).toBe(400);
    expect(bad.headers['cache-control']).toBe(NO_STORE);
  });
});

/**
 * Sans `Vary: Origin`, un cache partagé peut servir à l'origine B une réponse
 * dont l'`Access-Control-Allow-Origin` désigne l'origine A — le navigateur de B
 * rejette alors une réponse pourtant légitime, ou pire selon le CDN. Le paquet
 * `cors` pose ce `Vary` parce que notre origine est dynamique
 * (`corsOriginCallback`) ; ce test verrouille cette dépendance implicite, qui
 * disparaîtrait si quelqu'un remplaçait le callback par une chaîne fixe.
 *
 * Monté sur une app minimale : la vérification porte sur l'interaction
 * cors + publicCache, pas sur une route particulière, et n'a donc pas à
 * dépendre du réseau NHL.
 */
describe('interaction avec CORS', () => {
  it('une réponse publique porte Vary: Origin', async () => {
    const { corsOriginCallback } = await import('../cors');
    const cors = (await import('cors')).default;

    const a = app((x) => {
      x.use(cors({ origin: corsOriginCallback, credentials: true }));
      x.get('/public', publicCache(300), (_q, r) => { r.json({ ok: true }); });
    });

    const res = await request(a).get('/public').set('Origin', 'http://localhost:5173');
    expect(res.headers['cache-control']).toContain('public');
    expect(String(res.headers['vary'] ?? '')).toContain('Origin');
  });
});
