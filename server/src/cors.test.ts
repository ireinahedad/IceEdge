import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * La politique d'origine est lue au chargement du module (`process.env` au
 * moment de l'import). Chaque cas doit donc réimporter le module avec un env
 * propre — d'où `resetModules` + import dynamique.
 */
async function loadCors(corsOrigin?: string) {
  vi.resetModules();
  if (corsOrigin === undefined) delete process.env.CORS_ORIGIN;
  else process.env.CORS_ORIGIN = corsOrigin;
  delete process.env.CLIENT_URL;
  return import('./cors');
}

const ORIGINAL_ENV = { ...process.env };

describe('politique CORS partagée', () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

  // LA régression que ce module existe pour empêcher : socket.ts passait
  // CORS_ORIGIN brut à Socket.io, donc une liste à deux origines ne
  // correspondait à aucune origine réelle et cassait le WebSocket pour toutes.
  it('accepte chaque origine d’une liste séparée par des virgules', async () => {
    const { isAllowedOrigin } = await loadCors('https://a.com, https://b.com');

    expect(isAllowedOrigin('https://a.com')).toBe(true);
    expect(isAllowedOrigin('https://b.com')).toBe(true);
    // La chaîne complète n'est pas une origine : elle ne doit pas être acceptée.
    expect(isAllowedOrigin('https://a.com, https://b.com')).toBe(false);
  });

  it('refuse une origine non configurée', async () => {
    const { isAllowedOrigin } = await loadCors('https://a.com');
    expect(isAllowedOrigin('https://evil.com')).toBe(false);
  });

  it('accepte les previews Vercel du projet', async () => {
    const { isAllowedOrigin } = await loadCors('https://arakice.com');
    expect(isAllowedOrigin('https://ice-edge-abc123-ireina-hedad-s-projects.vercel.app')).toBe(true);
  });

  // L'ancre de la regex est la seule chose qui sépare un preview légitime d'un
  // domaine hostile qui contient la même sous-chaîne.
  it('refuse un domaine hostile qui imite un preview Vercel', async () => {
    const { isAllowedOrigin } = await loadCors('https://arakice.com');

    expect(isAllowedOrigin('https://ice-edge.vercel.app.attaquant.com')).toBe(false);
    expect(isAllowedOrigin('https://attaquant.com/https://ice-edge.vercel.app')).toBe(false);
    expect(isAllowedOrigin('http://ice-edge-abc.vercel.app')).toBe(false); // http, pas https
  });

  // curl, sondes de santé, clients non navigateur : pas d'en-tête Origin, donc
  // pas de requête cross-origin à protéger.
  it('laisse passer une requête sans Origin', async () => {
    const { isAllowedOrigin } = await loadCors('https://a.com');
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin('')).toBe(true);
  });

  it('expose un callback au format attendu par le paquet cors', async () => {
    const { corsOriginCallback } = await loadCors('https://a.com');

    const ok = vi.fn();
    corsOriginCallback('https://a.com', ok);
    expect(ok).toHaveBeenCalledWith(null, true);

    const ko = vi.fn();
    corsOriginCallback('https://evil.com', ko);
    expect(ko.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(ko.mock.calls[0][1]).toBeUndefined();
  });

  it('retombe sur localhost quand rien n’est configuré', async () => {
    const { isAllowedOrigin } = await loadCors(undefined);
    expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedOrigin('http://localhost:9999')).toBe(false);
  });
});
