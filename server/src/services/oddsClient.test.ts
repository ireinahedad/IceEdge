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
    // Au-delà du TTL par défaut (30 min, `ODDS_CACHE_TTL_MIN`).
    vi.setSystemTime(Date.now() + 31 * 60_000);
    const stale = await mod.fetchOddsImplied('Montreal Canadiens', 'Boston Bruins');
    vi.useRealTimers();

    expect(stale).not.toBeNull();
    expect(stale?.homeProb).toBeCloseTo(0.5, 2);
  });
});

/**
 * Livres demandés (2026-09-27). The Odds API ne cote pas Bet365 sur la NHL :
 * la paire `bet365`/`eu` écrite en dur ne rendait aucun prix. Ces tests tiennent
 * les deux livres distincts — affichage canadien, collecte = livre du backfill.
 */
describe('oddsClient — livres demandés', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ODDS_BOOKMAKERS;
    delete process.env.ODDS_COLLECT_BOOKMAKERS;
  });

  it('affichage : demande `draftkings` par `bookmakers`, jamais par `regions`', async () => {
    const { mod, calls } = await load({ latencyMs: 0 });
    await mod.fetchOddsImplied('Montreal Canadiens', 'Boston Bruins');
    const url = new URL(calls[0]);
    expect(url.searchParams.get('bookmakers')).toBe('draftkings');
    expect(url.searchParams.has('regions')).toBe(false);
    expect(url.searchParams.get('markets')).toBe('h2h,spreads,totals');
  });

  it('collecte : livre `draftkings` seul par défaut (BET99 retiré le 2026-10-17), et AUCUN cache', async () => {
    const { mod, calls } = await load({ latencyMs: 0 });
    await mod.fetchCollectorOdds('h2h,spreads');
    await mod.fetchCollectorOdds('h2h,spreads');
    expect(calls.length).toBe(2);   // deux créneaux = deux observations
    const url = new URL(calls[0]);
    expect(url.searchParams.get('bookmakers')).toBe('draftkings');
    expect(url.searchParams.get('markets')).toBe('h2h,spreads');
  });

  it('la collecte ne pollue pas le cache d’affichage (appels séparés)', async () => {
    const { mod, calls } = await load({ latencyMs: 0 });
    await mod.fetchCollectorOdds('h2h,spreads,totals');
    await mod.fetchOddsImplied('Montreal Canadiens', 'Boston Bruins');
    expect(calls.length).toBe(2);
    expect(new URL(calls[1]).searchParams.get('bookmakers')).toBe('draftkings');
  });

  it('les variables d’environnement remplacent les défauts', async () => {
    process.env.ODDS_BOOKMAKERS = 'playnow_ca,betano_ca_on';
    process.env.ODDS_COLLECT_BOOKMAKERS = 'fanduel';
    process.env.ODDS_SHADOW_BOOKMAKERS = 'pinnacle,fanduel';   // fanduel déjà collecté : pas en double
    try {
      const { mod, calls } = await load({ latencyMs: 0 });
      await mod.fetchOddsImplied('Montreal Canadiens', 'Boston Bruins');
      await mod.fetchCollectorOdds('h2h');
      expect(new URL(calls[0]).searchParams.get('bookmakers')).toBe('playnow_ca,betano_ca_on');
      expect(new URL(calls[1]).searchParams.get('bookmakers')).toBe('fanduel,pinnacle');
    } finally {
      delete process.env.ODDS_BOOKMAKERS;
      delete process.env.ODDS_COLLECT_BOOKMAKERS;
      delete process.env.ODDS_SHADOW_BOOKMAKERS;
    }
  });

  it('collecte parallèle désactivable : ODDS_SHADOW_BOOKMAKERS=none', async () => {
    process.env.ODDS_SHADOW_BOOKMAKERS = 'none';
    try {
      const { mod, calls } = await load({ latencyMs: 0 });
      await mod.fetchCollectorOdds('h2h');
      expect(new URL(calls[0]).searchParams.get('bookmakers')).toBe('draftkings');
      expect(mod.ODDS_SHADOW_BOOKMAKERS).toEqual([]);
    } finally {
      delete process.env.ODDS_SHADOW_BOOKMAKERS;
    }
  });
});

describe('priceForSelection — prix d’une sélection précise', () => {
  const FULL = {
    home_team: 'Montreal Canadiens', away_team: 'Boston Bruins',
    commence_time: '2026-10-08T23:00:00Z',
    bookmakers: [{
      key: 'betano_ca_on', title: 'Betano (Ontario)',
      markets: [
        { key: 'h2h', outcomes: [{ name: 'Montreal Canadiens', price: 2.1 },
                                 { name: 'Boston Bruins', price: 1.8 }] },
        { key: 'spreads', outcomes: [{ name: 'Montreal Canadiens', price: 1.4, point: 1.5 },
                                     { name: 'Boston Bruins', price: 2.9, point: -1.5 }] },
        { key: 'totals', outcomes: [{ name: 'Over', price: 1.95, point: 6.5 },
                                    { name: 'Under', price: 1.85, point: 6.5 }] },
      ],
    }],
  };

  async function mod() {
    vi.resetModules();
    process.env.ODDS_API_KEY = 'test-key';
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => [FULL] }));
    return import('./oddsClient');
  }
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('moneyline : par abréviation, dans les deux sens, avec le nom du livre', async () => {
    const m = await mod();
    expect(await m.priceForSelection({ homeAbbr: 'MTL', awayAbbr: 'BOS', marketType: 'moneyline', selectionValue: 'bos' }))
      .toEqual({ price: 1.8, bookmaker: 'betano_ca_on', bookTitle: 'Betano (Ontario)' });
    // Domicile/extérieur inversés côté appelant : même match, même prix.
    expect((await m.priceForSelection({ homeAbbr: 'BOS', awayAbbr: 'MTL', marketType: 'moneyline', selectionValue: 'mtl' }))?.price)
      .toBe(2.1);
  });

  it('puck line : exige le MÊME handicap', async () => {
    const m = await mod();
    expect((await m.priceForSelection({ homeAbbr: 'MTL', awayAbbr: 'BOS', marketType: 'puck_line', selectionValue: 'bos', line: -1.5 }))?.price)
      .toBe(2.9);
    expect(await m.priceForSelection({ homeAbbr: 'MTL', awayAbbr: 'BOS', marketType: 'puck_line', selectionValue: 'mtl', line: -1.5 }))
      .toBeNull();   // le livre cote MTL +1.5, pas −1.5
  });

  it('total : exige la MÊME ligne, sinon pas de prix', async () => {
    const m = await mod();
    expect((await m.priceForSelection({ homeAbbr: 'MTL', awayAbbr: 'BOS', marketType: 'total_goals', selectionValue: 'under', line: 6.5 }))?.price)
      .toBe(1.85);
    expect(await m.priceForSelection({ homeAbbr: 'MTL', awayAbbr: 'BOS', marketType: 'total_goals', selectionValue: 'over', line: 5.5 }))
      .toBeNull();
  });

  it('autre match, ou marché non coté → null', async () => {
    const m = await mod();
    expect(await m.priceForSelection({ homeAbbr: 'TOR', awayAbbr: 'BOS', marketType: 'moneyline', selectionValue: 'tor' })).toBeNull();
    expect(await m.priceForSelection({ homeAbbr: 'MTL', awayAbbr: 'BOS', marketType: 'anytime_goal', selectionValue: 'yes' })).toBeNull();
  });
});

/**
 * Marchés supplémentaires — l'endpoint PAR MATCH, facturé au marché renvoyé.
 * Son coût suit le trafic : ces tests tiennent les trois garde-fous (cache par
 * match, plafond quotidien, horizon de 48 h).
 */
describe('fetchGameExtras — marchés de match supplémentaires', () => {
  const soon = new Date(Date.now() + 6 * 60 * 60_000).toISOString();
  const far  = new Date(Date.now() + 5 * 24 * 60 * 60_000).toISOString();
  const LIST = [
    { id: 'ev1', home_team: 'Montreal Canadiens', away_team: 'Boston Bruins', commence_time: soon, bookmakers: [] },
    { id: 'ev2', home_team: 'Toronto Maple Leafs', away_team: 'Ottawa Senators', commence_time: far, bookmakers: [] },
  ];
  const EXTRAS = { id: 'ev1', bookmakers: [{ key: 'betano_ca_on', title: 'Betano', markets: [
    { key: 'h2h_3_way', outcomes: [{ name: 'Montreal Canadiens', price: 2.6 }, { name: 'Boston Bruins', price: 2.3 }, { name: 'Draw', price: 4.1 }] },
  ] }] };

  async function load(budget?: string, cost = '4') {
    vi.resetModules();
    process.env.ODDS_API_KEY = 'test-key';
    if (budget === undefined) delete process.env.ODDS_EXTRAS_DAILY_BUDGET;
    else process.env.ODDS_EXTRAS_DAILY_BUDGET = budget;
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      const isEvent = String(url).includes('/events/');
      const headers = new Headers({ 'x-requests-last': isEvent ? cost : '3', 'x-requests-remaining': '10000' });
      return { ok: true, status: 200, headers, json: async () => (isEvent ? EXTRAS : LIST) };
    });
    // La réserve visiteurs n'est pas le sujet ici : la collecte peut dépenser.
    vi.doMock('./oddsQuota', () => ({
      observe: vi.fn(), proxyTtlMs: (b: number) => b, collectorMaySpend: async () => true,
    }));
    const mod = await import('./oddsClient');
    return { mod, calls };
  }
  beforeEach(() => { vi.unstubAllGlobals(); vi.doUnmock('./oddsQuota'); });

  it('un match proche : un appel par match, puis le cache', async () => {
    const { mod, calls } = await load();
    const a = await mod.fetchGameExtras('MTL', 'BOS');
    const b = await mod.fetchGameExtras('bos', 'mtl');
    expect(a[0].markets[0].key).toBe('h2h_3_way');
    expect(b).toEqual(a);
    const eventCalls = calls.filter((u) => u.includes('/events/ev1/odds'));
    expect(eventCalls.length).toBe(1);
    expect(new URL(eventCalls[0]).searchParams.get('bookmakers')).toBe('draftkings');
  });

  it('match à plus de 48 h ou inconnu : aucun appel facturé', async () => {
    const { mod, calls } = await load();
    expect(await mod.fetchGameExtras('TOR', 'OTT')).toEqual([]);
    expect(await mod.fetchGameExtras('EDM', 'CGY')).toEqual([]);
    expect(calls.filter((u) => u.includes('/events/')).length).toBe(0);
  });

  it('plafond quotidien atteint : plus aucun appel, et le coût RÉEL est compté', async () => {
    const { mod, calls } = await load('3', '4');
    await mod.fetchGameExtras('MTL', 'BOS');                 // estimation 5 > 3 → refusé
    expect(calls.filter((u) => u.includes('/events/')).length).toBe(0);
    expect(mod.extrasBudgetState().spent).toBe(0);
  });

  it('le compteur additionne x-requests-last', async () => {
    const { mod } = await load('100', '4');
    await mod.fetchGameExtras('MTL', 'BOS');
    expect(mod.extrasBudgetState().spent).toBe(4);
  });
});
