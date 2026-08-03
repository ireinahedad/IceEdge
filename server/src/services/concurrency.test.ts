import { describe, it, expect } from 'vitest';
import { mapLimit } from './concurrency';

/** Exécute `fn` après `ms`, en enregistrant le pic de simultanéité observé. */
function tracker() {
  let inFlight = 0;
  let peak = 0;
  return {
    get peak() { return peak; },
    async run<T>(value: T, ms = 1): Promise<T> {
      inFlight += 1;
      if (inFlight > peak) peak = inFlight;
      await new Promise((r) => setTimeout(r, ms));
      inFlight -= 1;
      return value;
    },
  };
}

describe('mapLimit', () => {
  it('ne dépasse jamais la largeur demandée', async () => {
    const t = tracker();
    const items = Array.from({ length: 50 }, (_, i) => i);
    await mapLimit(items, 5, (i) => t.run(i));
    expect(t.peak).toBeLessThanOrEqual(5);
    // Sans plafond ce serait 50 : on vérifie aussi que la largeur est UTILISÉE,
    // sinon un `mapLimit` accidentellement séquentiel passerait le test ci-dessus.
    expect(t.peak).toBeGreaterThan(1);
  });

  it('préserve l\'ordre des résultats, pas l\'ordre d\'achèvement', async () => {
    // Le premier élément est le plus lent : il finira en dernier et doit
    // pourtant rester en tête du tableau de sortie.
    const delays = [30, 1, 1, 1];
    const out = await mapLimit(delays, 4, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3]);
  });

  it('propage la première erreur et cesse de démarrer de nouvelles tâches', async () => {
    let started = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    await expect(mapLimit(items, 2, async (i) => {
      started += 1;
      if (i === 1) throw new Error('boom');
      await new Promise((r) => setTimeout(r, 5));
      return i;
    })).rejects.toThrow('boom');
    // 20 tâches auraient toutes démarré avec `Promise.all`.
    expect(started).toBeLessThan(20);
  });

  it('traite une liste vide sans rien démarrer', async () => {
    const t = tracker();
    expect(await mapLimit([], 5, (x) => t.run(x))).toEqual([]);
    expect(t.peak).toBe(0);
  });

  it('retombe sur le séquentiel plutôt que sur l\'illimité si la largeur est aberrante', async () => {
    // Une variable d'environnement vide ou négative ne doit JAMAIS rouvrir le
    // parallélisme non borné que cette fonction existe pour fermer.
    for (const bad of [0, -3, NaN, Infinity]) {
      const t = tracker();
      await mapLimit([1, 2, 3, 4], bad as number, (x) => t.run(x));
      expect(t.peak).toBe(1);
    }
  });
});
