import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `manualData.service` — le cache, et surtout ce qu'il met en cache.
 *
 * Ce fichier existe pour DEUX régressions, toutes deux invisibles en lecture de
 * code et coûteuses en production :
 *
 *   1. **L'absence doit être mise en cache.** La grande majorité des matchs n'a
 *      aucune saisie. Si seules les valeurs trouvées étaient mémorisées, le cas
 *      majoritaire — « rien pour ce match » — repartirait en base à CHAQUE
 *      prédiction, c'est-à-dire l'exact contraire du but. C'est facile à casser
 *      sans s'en rendre compte : il suffit qu'un jour `TtlCache<T>` cesse
 *      d'emballer la valeur dans `{ v }`, et `peekFresh` confondra de nouveau
 *      « pas en cache » et « en cache, valeur null ».
 *
 *   2. **Une écriture doit invalider.** La saisie d'avant-match n'a de sens que
 *      si elle est visible tout de suite après l'enregistrement. Un cache qui
 *      ne s'invalide pas ferait mentir l'écran pendant 30 s — assez pour croire
 *      que la saisie n'a pas fonctionné et la refaire.
 *
 * Le pool est bouchonné : ce qui est testé ici est la mécanique du service, pas
 * SQL (celui-ci est vérifié contre un vrai Postgres, cf. `manual.routes.test`).
 */

const query = vi.fn();
vi.mock('../db/connection', () => ({
  pool: {
    query: (...args: unknown[]) => query(...args),
    connect: vi.fn(),
  },
}));
vi.mock('../logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  getEntry, listEntries, mapEntries, setEntry, deleteEntry, purgeDatedBefore,
  clearManualDataCache,
} from './manualData.service';

beforeEach(() => {
  query.mockReset();
  clearManualDataCache();
});

describe('getEntry', () => {
  it('rend la charge utile et ne relit pas la base au second appel', async () => {
    query.mockResolvedValue({ rows: [{ payload: { lineupAdj: 0.03 } }] });

    const a = await getEntry<{ lineupAdj: number }>('injuries', 'TOR@BOS');
    const b = await getEntry<{ lineupAdj: number }>('injuries', 'TOR@BOS');

    expect(a).toEqual({ lineupAdj: 0.03 });
    expect(b).toEqual({ lineupAdj: 0.03 });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('met AUSSI l\'absence en cache — le cas majoritaire', async () => {
    query.mockResolvedValue({ rows: [] });

    expect(await getEntry('injuries', 'MTL@OTT')).toBeNull();
    expect(await getEntry('injuries', 'MTL@OTT')).toBeNull();
    expect(await getEntry('injuries', 'MTL@OTT')).toBeNull();

    expect(query).toHaveBeenCalledTimes(1);
  });

  it('dédoublonne les appels concurrents sur une clé froide', async () => {
    query.mockResolvedValue({ rows: [{ payload: { a: 1 } }] });

    await Promise.all([
      getEntry('scratches', '2026-01-15'),
      getEntry('scratches', '2026-01-15'),
      getEntry('scratches', '2026-01-15'),
    ]);

    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rend null sans lever quand la base est injoignable', async () => {
    query.mockRejectedValue(new Error('ECONNREFUSED'));

    // Le contrat : une base en panne retire un facteur, elle ne casse pas la
    // prédiction. C'était déjà le comportement du `catch` de l'ancien lecteur
    // de fichier — la différence est qu'il est journalisé maintenant.
    await expect(getEntry('injuries', 'TOR@BOS')).resolves.toBeNull();
  });

  it('ne met pas un échec en cache', async () => {
    query.mockRejectedValueOnce(new Error('boom'));
    query.mockResolvedValueOnce({ rows: [{ payload: { ok: true } }] });

    expect(await getEntry('injuries', 'TOR@BOS')).toBeNull();
    expect(await getEntry('injuries', 'TOR@BOS')).toEqual({ ok: true });
  });
});

describe('listEntries / mapEntries', () => {
  it('rend un objet indexé par clé', async () => {
    query.mockResolvedValue({
      rows: [
        { key: 'wes mccauley', payload: { name: 'Wes McCauley', ppPerGame: 6.9 }, updatedAt: 'x', updatedBy: null },
        { key: 'garrett rank', payload: { name: 'Garrett Rank', ppPerGame: 5.4 }, updatedAt: 'x', updatedBy: null },
      ],
    });

    expect(await mapEntries('ref_tendency')).toEqual({
      'wes mccauley': { name: 'Wes McCauley', ppPerGame: 6.9 },
      'garrett rank': { name: 'Garrett Rank', ppPerGame: 5.4 },
    });
  });

  it('rend une liste vide sans lever quand la base est injoignable', async () => {
    query.mockRejectedValue(new Error('down'));
    await expect(listEntries('ref_tendency')).resolves.toEqual([]);
  });
});

describe('écriture', () => {
  it('setEntry invalide l\'entrée ET la liste de son jeu de données', async () => {
    query.mockResolvedValue({ rows: [{ payload: { v: 'ancien' } }] });
    await getEntry('injuries', 'TOR@BOS');
    await mapEntries('injuries');
    expect(query).toHaveBeenCalledTimes(2);

    query.mockResolvedValue({ rows: [], rowCount: 1 });
    await setEntry('injuries', 'TOR@BOS', { v: 'nouveau' }, 'admin-id');

    // Les deux relectures doivent repartir en base : sinon l'écran d'admin
    // afficherait l'ancienne valeur juste après l'avoir enregistrée.
    query.mockResolvedValue({ rows: [{ payload: { v: 'nouveau' } }] });
    expect(await getEntry('injuries', 'TOR@BOS')).toEqual({ v: 'nouveau' });
  });

  it('setEntry LÈVE quand la base refuse — l\'admin doit le savoir', async () => {
    query.mockRejectedValue(new Error('unique violation'));
    await expect(setEntry('injuries', 'TOR@BOS', {})).rejects.toThrow('unique violation');
  });

  it('deleteEntry dit si la ligne existait', async () => {
    query.mockResolvedValue({ rowCount: 0 });
    expect(await deleteEntry('injuries', 'ABS@ENT')).toBe(false);
    query.mockResolvedValue({ rowCount: 1 });
    expect(await deleteEntry('injuries', 'TOR@BOS')).toBe(true);
  });
});

describe('purgeDatedBefore', () => {
  it('ne vise que les deux jeux datés', async () => {
    query.mockResolvedValue({ rowCount: 4 });
    const n = await purgeDatedBefore('2026-08-20');

    expect(n).toBe(4);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    // Les blessures ne sont pas datées : les purger effacerait une saisie
    // encore utile pour un match à venir.
    expect(sql).toContain("kind IN ('starting_goalies', 'scratches')");
    expect(sql).not.toContain('injuries');
    expect(params).toEqual(['2026-08-20']);
  });
});
