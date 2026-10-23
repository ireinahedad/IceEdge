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

  // Les clients d'API n'ont pas un TTL unique : un match terminé
  // se garde des heures, un match en direct quelques secondes. Sans surcharge
  // par entrée, ils devaient garder leur propre Map — non bornée, donc OOM.
  it('accepte un TTL par entrée qui surcharge le défaut', async () => {
    const cache = new TtlCache<string>(10_000, 10);

    cache.set('court', 'a', 20);
    cache.set('long', 'b');            // TTL par défaut

    await new Promise((r) => setTimeout(r, 50));

    expect(cache.get('court')).toBeNull();
    expect(cache.get('long')).toBe('b');
  });

  it('applique aussi le TTL par entrée via wrap()', async () => {
    const cache = new TtlCache<number>(10_000, 10);
    let n = 0;

    await cache.wrap('k', async () => ++n, 20);
    await new Promise((r) => setTimeout(r, 50));
    await cache.wrap('k', async () => ++n, 20);

    expect(n).toBe(2); // recalculé : le TTL court a bien primé sur les 10 s
  });
});

// PERF_PLAN.md P1.2 — personne n'attend un recalcul tant que l'ancienne valeur
// est dans sa fenêtre de péremption tolérée.
describe('TtlCache.wrapSwr', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('sert la valeur périmée tout de suite et recalcule une seule fois en fond', async () => {
    const cache = new TtlCache<number>(20);
    let n = 0;
    const slow = async () => { await sleep(40); return ++n; };

    expect(await cache.wrapSwr('k', slow, 1_000)).toBe(1);   // froid : on attend
    await sleep(30);                                          // expiré, dans la fenêtre

    const t0 = Date.now();
    const vals = await Promise.all([1, 2, 3].map(() => cache.wrapSwr('k', slow, 1_000)));
    expect(Date.now() - t0).toBeLessThan(30);                 // personne n'a attendu
    expect(vals).toEqual([1, 1, 1]);                          // l'ancienne valeur

    await sleep(60);                                          // le recalcul de fond a fini
    expect(n).toBe(2);                                        // UN seul recalcul
    expect(await cache.wrapSwr('k', slow, 1_000)).toBe(2);    // frais
  });

  it('au-delà de la fenêtre, attend le calcul comme wrap()', async () => {
    const cache = new TtlCache<number>(10);
    let n = 0;
    await cache.wrapSwr('k', async () => ++n, 10);
    await sleep(40);                                          // expiré ET hors fenêtre
    expect(await cache.wrapSwr('k', async () => ++n, 10)).toBe(2);
  });

  it('un échec du recalcul de fond garde l’ancienne valeur', async () => {
    const cache = new TtlCache<number>(10);
    await cache.wrapSwr('k', async () => 7, 1_000);
    await sleep(20);
    expect(await cache.wrapSwr('k', async () => { throw new Error('ML down'); }, 1_000)).toBe(7);
    await sleep(10);
    expect(await cache.wrapSwr('k', async () => { throw new Error('ML down'); }, 1_000)).toBe(7);
  });
});
