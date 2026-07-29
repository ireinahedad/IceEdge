import { describe, it, expect, beforeEach } from 'vitest';
import { recordUpstream, timeUpstream, snapshotMetrics, resetMetrics } from './metrics';
import { TtlCache } from './services/ttlCache';

/**
 * Ces compteurs sont la seule chose qui rend vérifiables les critères des tests
 * de charge (« ≤ 2 appels Odds API », « ≤ 5 exécutions de getBestBets »). Une
 * régression ici ne casse aucun test fonctionnel : elle produit simplement un
 * chiffre faux, sur lequel on décidera de lancer ou non. D'où ces garde-fous.
 */
describe('compteurs d’appels sortants', () => {
  beforeEach(() => resetMetrics());

  it('compte les appels, les erreurs et la pire latence', () => {
    recordUpstream('odds', 100, true);
    recordUpstream('odds', 300, false);

    const { upstream } = snapshotMetrics();
    expect(upstream.odds.calls).toBe(2);
    expect(upstream.odds.errors).toBe(1);
    expect(upstream.odds.maxMs).toBeGreaterThanOrEqual(300);
    expect(upstream.odds.avgMs).toBe(200);
  });

  it('timeUpstream compte l’échec ET laisse remonter l’erreur', async () => {
    await expect(
      timeUpstream('ml', async () => { throw new Error('ML service 503'); }),
    ).rejects.toThrow('ML service 503');

    const { upstream } = snapshotMetrics();
    expect(upstream.ml.calls).toBe(1);
    expect(upstream.ml.errors).toBe(1);
  });

  it('remet à zéro sans perdre les cibles', () => {
    recordUpstream('nhl', 10, true);
    resetMetrics();

    const { upstream } = snapshotMetrics();
    expect(upstream.nhl.calls).toBe(0);
    // La cible doit rester présente : une clé absente se lit « pas mesuré »,
    // pas « zéro appel ».
    expect(upstream.nhl).toBeDefined();
  });
});

describe('compteurs de cache', () => {
  beforeEach(() => resetMetrics());

  // LA distinction qui décide du verdict : un rattachement à un calcul déjà en
  // vol n'est PAS une exécution. Les confondre ferait lire « 300 exécutions »
  // là où le serveur n'en a fait qu'une — soit exactement l'inverse de ce que
  // le scénario S3 doit démontrer.
  it('distingue exécution réelle (miss) et rattachement (dedup)', async () => {
    const cache = new TtlCache<string>(10_000, 10, 'test-dedup');
    let executions = 0;

    const fn = async () => {
      executions += 1;
      await new Promise((r) => setTimeout(r, 20));
      return 'v';
    };

    await Promise.all(Array.from({ length: 50 }, () => cache.wrap('k', fn)));

    const stats = snapshotMetrics().caches['test-dedup'];
    expect(executions).toBe(1);
    expect(stats.misses).toBe(1);   // une seule exécution réelle
    expect(stats.dedup).toBe(49);   // 49 rattachements
    expect(stats.hits).toBe(0);     // rien n'était encore en cache
  });

  it('compte les hits une fois la valeur en cache', async () => {
    const cache = new TtlCache<string>(10_000, 10, 'test-hits');
    await cache.wrap('k', async () => 'v');
    await cache.wrap('k', async () => 'v');
    await cache.wrap('k', async () => 'v');

    const stats = snapshotMetrics().caches['test-hits'];
    expect(stats.misses).toBe(1);
    expect(stats.hits).toBe(2);
    expect(stats.hitRate).toBeCloseTo(2 / 3, 2);
  });

  // Un `evictions` qui grimpe est le signe que le plafond est trop bas et que le
  // cache se vide lui-même — le taux de hit s'effondre sans autre symptôme.
  it('compte les évictions quand le plafond est atteint', () => {
    const cache = new TtlCache<string>(10_000, 2, 'test-evictions');
    cache.set('a', 'a');
    cache.set('b', 'b');
    cache.set('c', 'c');   // évince 'a'
    cache.set('d', 'd');   // évince 'b'

    const stats = snapshotMetrics().caches['test-evictions'];
    expect(stats.evictions).toBe(2);
    expect(stats.size).toBe(2);
    expect(stats.maxEntries).toBe(2);
  });

  // Sans nom, pas d'enregistrement : les caches créés à la volée (tests,
  // usages locaux) ne polluent pas les métriques et ne sont pas retenus
  // indéfiniment par le registre.
  it('n’enregistre pas les caches anonymes', async () => {
    const anon = new TtlCache<string>(10_000, 10);
    await anon.wrap('k', async () => 'v');

    const names = Object.keys(snapshotMetrics().caches);
    expect(names).not.toContain('');
  });

  it('resetMetrics remet les compteurs à zéro mais garde le contenu', async () => {
    const cache = new TtlCache<string>(10_000, 10, 'test-reset');
    await cache.wrap('k', async () => 'v');

    resetMetrics();

    expect(snapshotMetrics().caches['test-reset'].misses).toBe(0);
    // Le contenu survit : c'est voulu. Pour mesurer un démarrage à froid il
    // faut redémarrer le service, pas appeler reset — sinon on lit « 0
    // exécution » sur un cache resté chaud.
    expect(cache.get('k')).toBe('v');
  });
});
