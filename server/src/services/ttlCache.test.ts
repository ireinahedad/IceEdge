import { describe, it, expect } from 'vitest';
import { TtlCache } from './ttlCache';

// Ce cache est ce qui découple le coût upstream (The Odds API, service ML) du
// nombre de visiteurs. Une régression ici ne casse aucun test fonctionnel mais
// se paye en facture et en indisponibilité — d'où ces garde-fous.
describe('TtlCache', () => {
  it('ne déclenche qu’une exécution pour N appels concurrents sur une clé froide', async () => {
    const cache = new TtlCache<string[]>(1_000);
    let calls = 0;
    const fn = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return ['data'];
    };

    const results = await Promise.all(
      Array.from({ length: 500 }, () => cache.wrap('k', fn)),
    );

    expect(calls).toBe(1);
    expect(results.every((r) => r[0] === 'data')).toBe(true);
  });

  it('sert depuis le cache tant que le TTL n’est pas écoulé, puis recalcule', async () => {
    const cache = new TtlCache<number>(30);
    let n = 0;
    const fn = async () => ++n;

    await cache.wrap('k', fn);
    await cache.wrap('k', fn);
    expect(n).toBe(1);

    await new Promise((r) => setTimeout(r, 50));
    await cache.wrap('k', fn);
    expect(n).toBe(2);
  });

  it('ne met pas en cache un échec et ne laisse pas d’inflight fantôme', async () => {
    const cache = new TtlCache<string>(1_000);

    await expect(
      cache.wrap('k', async () => {
        throw new Error('upstream 429');
      }),
    ).rejects.toThrow('upstream 429');

    let calls = 0;
    const value = await cache.wrap('k', async () => {
      calls++;
      return 'ok';
    });
    expect(calls).toBe(1);
    expect(value).toBe('ok');
  });

  it('conserve la dernière valeur connue via getStale (filet quota épuisé)', async () => {
    const cache = new TtlCache<string>(10);
    await cache.wrap('k', async () => 'good');
    await new Promise((r) => setTimeout(r, 30));

    expect(cache.get('k')).toBeNull();
    expect(cache.getStale('k')).toBe('good');
  });

  it('borne le nombre d’entrées (pas de DoS mémoire par clés arbitraires)', async () => {
    const cache = new TtlCache<string>(10_000, 3);
    for (const k of ['a', 'b', 'c', 'd']) {
      await cache.wrap(k, async () => k);
    }

    expect(cache.getStale('a')).toBeNull(); // évincée (FIFO)
    expect(cache.getStale('d')).toBe('d');
  });
});
