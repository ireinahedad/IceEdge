import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Étape 4 : la route reçoit les nouvelles absent / gardien des deux équipes, et rien d'autre. */

// Fonction simple, pas `vi.fn` : le suivi des promesses de `vi.fn` (vitest 2)
// signale un rejet pourtant attrapé par le code testé.
let calls: unknown[][] = [];
let impl: (...a: unknown[]) => Promise<unknown[]> = async () => [];
vi.mock('./newsSync.service', () => ({ listNews: (...a: unknown[]) => { calls.push(a); return impl(...a); } }));
vi.mock('./gameMlBundle', () => ({ getGameMlBundle: vi.fn(), getGameFeatures: vi.fn(), mlBundleKey: vi.fn() }));
vi.mock('../logger', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('./llmSensitivity', () => ({ computeGoalieSensitivities: vi.fn(async () => []) }));

const item = (over: Record<string, unknown>) => ({
  id: 1, source: 'bluesky', teams: ['VGK'], author: 'VGK', url: 'u', excerpt: 'e', flags: [], postedAt: '2026-10-23T22:00:00Z', ...over,
});

describe('recentFlaggedNews', () => {
  beforeEach(() => { calls = []; impl = async () => []; });

  it('garde absent / gardien des deux équipes (24 h), écarte transactions et autres équipes, au plus 3', async () => {
    impl = async () => [
      item({ flags: ['transaction'], excerpt: 'trade' }),
      item({ flags: ['lineup'], excerpt: 'Marner out', teams: ['TOR', 'VGK'] }),
      item({ flags: ['goalie', 'transaction'], excerpt: 'Binnington starts', teams: ['STL'] }),
      item({ flags: ['lineup'], excerpt: 'a' }),
      item({ flags: ['lineup'], excerpt: 'b' }),
    ];
    const { recentFlaggedNews } = await import('./llmAnalysisContext');
    const out = await recentFlaggedNews('VGK', 'STL');
    expect(calls).toEqual([[['VGK', 'STL'], 24, 20]]);
    expect(out.map((n) => [n.team, n.excerpt, n.flags])).toEqual([
      ['VGK', 'Marner out', ['lineup']],
      ['STL', 'Binnington starts', ['goalie']],
      ['VGK', 'a', ['lineup']],
    ]);
  });

  it('base muette : liste vide, pas d’erreur', async () => {
    impl = async () => { throw new Error('db down'); };
    const { recentFlaggedNews } = await import('./llmAnalysisContext');
    expect(await recentFlaggedNews('VGK', 'STL')).toEqual([]);
  });

  it('sans équipe : aucune lecture', async () => {
    const { recentFlaggedNews } = await import('./llmAnalysisContext');
    expect(await recentFlaggedNews(undefined, undefined)).toEqual([]);
    expect(calls).toEqual([]);
  });
});
