import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Troupeau sur The Odds API — le seul upstream du repo qui soit FACTURÉ À
 * L'APPEL.
 *
 * Mesuré au tir S1 du 2026-08-03 : une seule exécution de `getBestBets` a émis
 * **26 appels** (13 matchs × h2h + totals), parce que `fetchAllOdds` tenait un
 * cache maison sans déduplication en vol. Les appelants concurrents lisaient
 * tous un cache froid avant que le premier n'écrive.
 *
 * Ce test n'a aucun symptôme fonctionnel : avec ou sans déduplication, les
 * cotes rendues sont identiques. Seule la facture change. C'est précisément
 * pour ça qu'il doit exister.
 */

const EVENT = {
  home_team: 'Montreal Canadiens',
  away_team: 'Boston Bruins',
  commence_time: '2026-08-04T23:00:00Z',
  bookmakers: [{
    key: 'bet365',
    markets: [
      { key: 'h2h',    outcomes: [{ name: 'Montreal Canadiens', price: 2.0 },
                                  { name: 'Boston Bruins',      price: 2.0 }] },
      { key: 'totals', outcomes: [{ name: 'Over',  price: 1.9, point: 6.5 },
                                  { name: 'Under', price: 1.9, point: 6.5 }] },
    ],
  }],
};

/** Charge le module avec un `fetch` bouchonné qui compte et temporise. */
async function load(opts: { latencyMs?: number; ok?: boolean } = {}) {
  const { latencyMs = 30, ok = true } = opts;
  vi.resetModules();
  process.env.ODDS_API_KEY = 'test-key';

  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(String(url));
    await new Promise((r) => setTimeout(r, latencyMs));
    if (!ok) return { ok: false, status: 429, text: async () => 'rate limited' };
    return { ok: true, status: 200, json: async () => [EVENT] };
  });

  const mod = await import('./oddsClient');
  return { mod, calls };
}

describe('oddsClient — déduplication des requêtes en vol', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('collapse la rafale de pricing de getBestBets en UN seul appel', async () => {
    const { mod, calls } = await load();

    // La forme exacte de ce que fait `getBestBets` : chaque match demande h2h
    // ET totals, tous les matchs en parallèle.
    await Promise.all(
      Array.from({ length: 13 }, () => [
        mod.fetchOddsImplied('Montreal Canadiens', 'Boston Bruins'),
        mod.fetchTotalsOdds('Montreal Canadiens', 'Boston Bruins'),
      ]).flat(),
    );

    // Avant correction : 26. Chacun était un crédit facturé.
    expect(calls.length).toBe(1);
  });

  it('sert le cache sur la fenêtre suivante, sans réappeler', async () => {
    const { mod, calls } = await load();

    await mod.fetchOddsImplied('Montreal Canadiens', 'Boston Bruins');
    await mod.fetchTotalsOdds('Montreal Canadiens', 'Boston Bruins');

    expect(calls.length).toBe(1);
  });

  it('ne mémorise pas un échec, et ne rend pas de cotes vides mises en cache', async () => {
    const { mod, calls } = await load({ ok: false });

    // Un 429 mis en cache 5 minutes priverait le moteur de cotes bien après le
    // rétablissement — d'où le rejet plutôt que le `[]` mémorisé.
    expect(await mod.fetchOddsImplied('Montreal Canadiens', 'Boston Bruins')).toBeNull();
    await mod.fetchOddsImplied('Montreal Canadiens', 'Boston Bruins');

    expect(calls.length).toBe(2);
  });

  it('sert les dernières cotes connues quand l’upstream tombe', async () => {
    vi.resetModules();
    process.env.ODDS_API_KEY = 'test-key';

    let healthy = true;
    vi.stubGlobal('fetch', async () => (healthy
      ? { ok: true, status: 200, json: async () => [EVENT] }
      : { ok: false, status: 503, text: async () => 'down' }));

    const mod = await import('./oddsClient');

    expect(await mod.fetchOddsImplied('Montreal Canadiens', 'Boston Bruins')).not.toBeNull();

    // Expiration du TTL puis panne : le moteur doit garder un facteur marché
    // plutôt que de perdre le meilleur prédicteur dont il dispose.
    healthy = false;
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 6 * 60_000);
    const stale = await mod.fetchOddsImplied('Montreal Canadiens', 'Boston Bruins');
    vi.useRealTimers();

    expect(stale).not.toBeNull();
    expect(stale?.homeProb).toBeCloseTo(0.5, 2);
  });
});
