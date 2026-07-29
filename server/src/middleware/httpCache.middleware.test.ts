import { describe, it, expect, vi } from 'vitest';
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
   * Postgres bouchonné, en échec immédiat.
   *
   * Une première version de ce test sondait un chemin inexistant sous chaque
   * préfixe, en supposant qu'il retomberait sur le 404 global sans toucher à la
   * base. C'était faux : `/api/users/<x>` matche `router.get('/:id')` et
   * `/api/slips/<x>` aussi — les routes paramétrées avalent n'importe quel
   * segment. La sonde partait donc en base, `pool.connect()` attendait ses 5 s
   * de `connectionTimeoutMillis`, et le test échouait par timeout.
   *
   * Plutôt que de chercher un chemin qui n'existe vraiment nulle part — une
   * hypothèse que la prochaine route paramétrée casserait à nouveau — on retire
   * la dépendance : ce test porte sur des EN-TÊTES, pas sur la base. Peu importe
   * que la route réponde 401, 404 ou 500, tant qu'elle répond vite ; l'en-tête
   * est posé au montage du routeur et vaut pour les trois.
   */
  /**
   * Importer `app` tire tout le graphe de dépendances du serveur (Sentry,
   * Stripe, socket.io, pg…) : ~3 s de transpilation, contre 5 s de budget par
   * défaut chez vitest. La marge était trop mince — d'où le timeout explicite
   * sur les cas ci-dessous, et ce chargement mis en cache pour ne le payer
   * qu'une fois. Les tests ne modifient rien (uniquement des GET) et le
   * limiteur est à 2000/min, très au-dessus de la douzaine de requêtes émises.
   */
  const IMPORT_HEAVY_TIMEOUT_MS = 20_000;

  let cached: Promise<any> | null = null;
  function loadAppWithoutDb(): Promise<any> {
    if (!cached) {
      cached = (async () => {
        vi.resetModules();
        const fail = async () => { throw new Error('DB indisponible (bouchon de test)'); };
        vi.doMock('../db/connection', () => ({
          pool: { query: fail, connect: fail, on: () => {}, end: async () => {} },
          connectDB: fail,
        }));
        return (await import('../app')).default;
      })();
    }
    return cached;
  }

  /**
   * `noStore` est monté sur le PRÉFIXE, pas sur chaque route : c'est ce qui
   * garantit qu'une route ajoutée demain dans l'un de ces routeurs est couverte
   * sans que personne y pense. Le test porte donc sur le préfixe.
   */
  const USER_DATA_PROBES = [
    '/api/auth/__sonde__',
    '/api/users/__sonde__',
    '/api/chat/__sonde__',
    '/api/slips/__sonde__',
    '/api/llm/__sonde__',
    '/api/subscription/__sonde__',
    '/api/push/__sonde__',
  ];

  it('tout préfixe portant des données utilisateur répond `no-store`', async () => {
    const appUnderTest = await loadAppWithoutDb();

    for (const path of USER_DATA_PROBES) {
      const res = await request(appUnderTest).get(path);
      const cc  = res.headers['cache-control'] ?? '';
      // L'en-tête doit être PRÉSENT et valoir no-store : son absence laisse la
      // décision à l'heuristique du CDN, ce qui est précisément ce qu'on refuse.
      expect(cc, `${path} → ${res.status} / Cache-Control: ${cc || '(absent)'}`)
        .toBe(NO_STORE);
    }
  }, IMPORT_HEAVY_TIMEOUT_MS);

  // Doublon sur de vraies routes : celles-ci répondent 401 sur un simple test de
  // jeton, donc le code de statut est lui aussi vérifiable.
  it('le vaut aussi sur de vraies réponses 401', async () => {
    const appUnderTest = await loadAppWithoutDb();

    for (const path of ['/api/auth/me', '/api/users/me', '/api/subscription/me']) {
      const res = await request(appUnderTest).get(path);
      expect(res.status, `${path} devait répondre 401`).toBe(401);
      expect(res.headers['cache-control'], path).toBe(NO_STORE);
    }
  }, IMPORT_HEAVY_TIMEOUT_MS);

  it('les routes NHL publiques annoncent bien un cache partagé', async () => {
    const appUnderTest = await loadAppWithoutDb();

    // Paramètres invalides → 400 immédiat, aucun appel réseau vers la NHL.
    // Un 400 ne doit justement PAS être caché.
    const bad = await request(appUnderTest).get('/api/nhl/games/range?start=nope&end=nope');
    expect(bad.status).toBe(400);
    expect(bad.headers['cache-control']).toBe(NO_STORE);
  }, IMPORT_HEAVY_TIMEOUT_MS);
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
