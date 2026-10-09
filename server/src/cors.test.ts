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

  // APPLE_PLAN 3.4 — l'app iOS (Capacitor) doit passer même si CORS_ORIGIN
  // ne la mentionne pas : une variable Railway modifiée ne doit jamais la couper.
  it('accepte l’origine de l’app iOS sans configuration', async () => {
    const { isAllowedOrigin } = await loadCors('https://arakice.com');
    expect(isAllowedOrigin('capacitor://localhost')).toBe(true);
    expect(isAllowedOrigin('ionic://localhost')).toBe(true);
    // Le schéma seul ne suffit pas : un autre hôte reste refusé.
    expect(isAllowedOrigin('capacitor://evil.com')).toBe(false);
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

  /**
   * LA faille que le suffixe d'équipe ferme (2026-09-04).
   *
   * La regex était `^https://ice-edge[a-z0-9-]*\.vercel\.app$` : le préfixe
   * seul, sans le slug d'équipe. Or un sous-domaine `<projet>.vercel.app`
   * s'attribue au PREMIER ARRIVÉ, sur n'importe quel compte Vercel. Créer un
   * projet nommé `ice-edge-x` suffisait donc à obtenir une origine autorisée.
   *
   * Ce que ça donnait, concrètement : `cors({ credentials: true })` + le cookie
   * de refresh en `SameSite=None` → une page hébergée là appelait
   * `POST /api/auth/refresh` avec `credentials: 'include'` ET LISAIT LA RÉPONSE,
   * donc repartait avec un jeton d'accès valide. Prise de contrôle de compte
   * complète, sans XSS, pour tout visiteur connecté ouvrant le lien.
   *
   * Le slug d'équipe vient du compte propriétaire : il n'est pas attribuable à
   * un tiers. C'est lui, et lui seul, qui ferme la porte.
   */
  it('refuse un projet Vercel tiers dont le nom commence par ice-edge', async () => {
    const { isAllowedOrigin } = await loadCors('https://arakice.com');

    expect(isAllowedOrigin('https://ice-edge-evil.vercel.app')).toBe(false);
    expect(isAllowedOrigin('https://ice-edge.vercel.app')).toBe(false);
    expect(isAllowedOrigin('https://ice-edge-abc123.vercel.app')).toBe(false);
    // Slug d'équipe imité mais pas identique.
    expect(isAllowedOrigin('https://ice-edge-abc-ireina-hedad-s-project.vercel.app')).toBe(false);
    expect(isAllowedOrigin('https://ice-edge-abc-autre-equipe.vercel.app')).toBe(false);
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
