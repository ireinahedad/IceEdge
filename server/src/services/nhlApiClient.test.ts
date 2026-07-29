import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Garde-fou contre le retour du troupeau (stampede).
 *
 * `nhlApiClient` met en cache avec `getCached`/`setCached`, sans déduplication
 * au niveau du cache : entre l'instant où N appels concurrents lisent un cache
 * froid et celui où le premier écrit, tous voient `null`. Mesuré avant
 * correction (`loadtest/stampede.ts`) : 500 concurrents → 500 appels NHL.
 *
 * La déduplication vit maintenant dans `fetchNHL`, au point d'étranglement
 * HTTP. Elle n'a aucun symptôme fonctionnel — les réponses sont identiques avec
 * ou sans — donc rien d'autre ne la protège : si quelqu'un la retire, tous les
 * tests passeraient encore et la facture de latence reviendrait en silence.
 * D'où ce test.
 */

/** Charge le module avec un `fetch` bouchonné qui compte et temporise. */
async function loadWithStubbedFetch(latencyMs = 30) {
  vi.resetModules();
  process.env.NHL_USE_MOCK = 'false';

  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(String(url));
    await new Promise((r) => setTimeout(r, latencyMs));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        standings: [{
          teamAbbrev: { default: 'BOS' },
          teamFullName: { default: 'Boston Bruins' },
          gamesPlayed: 10, wins: 6, losses: 3, otLosses: 1, points: 13,
        }],
      }),
    };
  });

  const mod = await import('./nhlApiClient');
  return { mod, calls };
}

describe('nhlApiClient — déduplication des requêtes en vol', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('collapse N appels concurrents sur une clé froide en UN seul appel NHL', async () => {
    const { mod, calls } = await loadWithStubbedFetch();

    await Promise.all(Array.from({ length: 200 }, () => mod.fetchTeams()));

    expect(calls.length).toBe(1);
  });

  it('rend à tous les appelants la même donnée', async () => {
    const { mod } = await loadWithStubbedFetch();

    const results = await Promise.all(Array.from({ length: 50 }, () => mod.fetchTeams()));

    expect(results.every((r) => Array.isArray(r) && r.length === 1)).toBe(true);
    expect(results.every((r) => r[0].abbreviation === 'BOS')).toBe(true);
  });

  it('ne sert plus rien depuis l’en-vol une fois la requête terminée (pas de fuite)', async () => {
    const { mod, calls } = await loadWithStubbedFetch();

    await mod.fetchTeams();          // 1er appel : va au réseau
    expect(calls.length).toBe(1);

    // Le cache prend le relais ; l'entrée en vol a bien été retirée, sinon les
    // appels suivants attendraient une promesse déjà résolue et périmée.
    await mod.fetchTeams();
    expect(calls.length).toBe(1);
  });

  it('ne mémorise pas un échec : l’appel suivant retente', async () => {
    vi.resetModules();
    process.env.NHL_USE_MOCK = 'false';

    let attempt = 0;
    vi.stubGlobal('fetch', async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('réseau coupé');
      return {
        ok: true, status: 200,
        json: async () => ({ standings: [{ teamAbbrev: { default: 'BOS' } }] }),
      };
    });

    const mod = await import('./nhlApiClient');

    await expect(mod.fetchTeams()).rejects.toThrow('réseau coupé');
    // Si l'échec restait dans la map des requêtes en vol, celui-ci rejetterait
    // aussi — et l'endpoint resterait cassé jusqu'au redémarrage.
    await expect(mod.fetchTeams()).resolves.toBeInstanceOf(Array);
    expect(attempt).toBe(2);
  });
});
