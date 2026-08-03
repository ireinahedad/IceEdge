import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Disjoncteur + cache d'inférence (audit, ligne M).
 *
 * Comme la déduplication de `nhlApiClient`, ces deux mécanismes n'ont AUCUN
 * symptôme fonctionnel : avec ou sans eux, l'application répond la même chose —
 * simplement 5 secondes plus tard par requête pendant une panne du service
 * Python, ce que rien d'autre ne mesure. D'où ces tests.
 */

type FetchOutcome =
  | { kind: 'ok' }
  | { kind: 'status'; status: number }
  | { kind: 'network' };

/** Charge le module avec un `fetch` bouchonné dont on pilote l'issue. */
async function load(outcome: () => FetchOutcome) {
  vi.resetModules();
  process.env.ML_BREAKER_THRESHOLD = '3';
  process.env.ML_BREAKER_COOLDOWN_MS = '10000';

  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(String(url));
    const o = outcome();
    if (o.kind === 'network') throw new Error('ECONNREFUSED');
    if (o.kind === 'status') {
      return { ok: false, status: o.status, statusText: 'nope', text: async () => 'nope' };
    }
    return { ok: true, status: 200, json: async () => ({ probability: 60, confidence: 70 }) };
  });

  const mod = await import('./mlApiClient');
  mod.resetMlCircuit();
  return { mod, calls };
}

/** Features distinctes à chaque appel, pour ne pas mesurer le cache par erreur. */
let seq = 0;
const uniqueFeatures = () => ({ n: seq++ });

describe('mlApiClient — disjoncteur', () => {
  beforeEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); seq = 0; });

  it('ouvre le circuit après N échecs de service et cesse d\'appeler le réseau', async () => {
    const { mod, calls } = await load(() => ({ kind: 'network' }));

    for (let i = 0; i < 3; i++) {
      await expect(mod.mlApiClient.predictGame(uniqueFeatures())).rejects.toThrow();
    }
    expect(calls.length).toBe(3);
    expect(mod.mlCircuitState().open).toBe(true);

    // Les 30 appels d'un `getBestBets` qui suivraient : zéro réseau, échec
    // immédiat, l'appelant retombe sur les règles sans attendre 5 s chacun.
    for (let i = 0; i < 30; i++) {
      await expect(mod.mlApiClient.predictGame(uniqueFeatures())).rejects.toThrow(mod.MLUnavailableError);
    }
    expect(calls.length).toBe(3);
  });

  it('ne s\'ouvre PAS sur des 400 — un appelant boguée ne doit pas couper le service pour tous', async () => {
    const { mod, calls } = await load(() => ({ kind: 'status', status: 400 }));

    for (let i = 0; i < 10; i++) {
      await expect(mod.mlApiClient.predictGame(uniqueFeatures())).rejects.toThrow();
    }
    expect(mod.mlCircuitState().open).toBe(false);
    expect(calls.length).toBe(10);
  });

  it('s\'ouvre sur 401 — jeton absent : tous les appels échoueront pareil', async () => {
    const { mod } = await load(() => ({ kind: 'status', status: 401 }));

    for (let i = 0; i < 3; i++) {
      await expect(mod.mlApiClient.predictGame(uniqueFeatures())).rejects.toThrow();
    }
    expect(mod.mlCircuitState().open).toBe(true);
  });

  it('laisse passer UNE seule sonde après la fenêtre, puis referme si elle réussit', async () => {
    let down = true;
    const { mod, calls } = await load(() => (down ? { kind: 'network' } : { kind: 'ok' }));

    for (let i = 0; i < 3; i++) {
      await expect(mod.mlApiClient.predictGame(uniqueFeatures())).rejects.toThrow();
    }
    const before = calls.length;

    // Fin de la fenêtre de repos.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11_000);
    down = false;

    // Une rafale arrive en même temps : une seule doit atteindre le réseau,
    // sinon la « sonde » serait elle-même la rafale qu'on veut éviter.
    const burst = Array.from({ length: 10 }, () => mod.mlApiClient.predictGame(uniqueFeatures()));
    const settled = await Promise.allSettled(burst);
    vi.useRealTimers();

    expect(calls.length).toBe(before + 1);
    expect(settled.filter((s) => s.status === 'fulfilled').length).toBe(1);
    expect(mod.mlCircuitState().open).toBe(false);
  });
});

describe('mlApiClient — cache de prédictions', () => {
  beforeEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); seq = 0; });

  it('ne réinterroge pas le service pour des features identiques', async () => {
    const { mod, calls } = await load(() => ({ kind: 'ok' }));
    const feats = { home: 'BOS', away: 'NYR' };

    await mod.mlApiClient.predictGame(feats);
    await mod.mlApiClient.predictGame({ ...feats });   // objet distinct, contenu identique
    expect(calls.length).toBe(1);

    await mod.mlApiClient.predictGame({ ...feats, away: 'TOR' });
    expect(calls.length).toBe(2);
  });

  it('sépare les chemins : mêmes features, modèle différent → deux appels', async () => {
    const { mod, calls } = await load(() => ({ kind: 'ok' }));
    const feats = { x: 1 };

    await mod.mlApiClient.predictGame(feats);
    await mod.mlApiClient.predictPlayer(feats);
    expect(calls.length).toBe(2);
  });

  it('ne mémorise pas un échec', async () => {
    let fail = true;
    const { mod, calls } = await load(() => (fail ? { kind: 'status', status: 500 } : { kind: 'ok' }));
    const feats = { x: 42 };

    await expect(mod.mlApiClient.predictGame(feats)).rejects.toThrow();
    fail = false;
    await expect(mod.mlApiClient.predictGame(feats)).resolves.toBeTruthy();
    expect(calls.length).toBe(2);
  });
});
