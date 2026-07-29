import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Le verrou de job n'a AUCUN symptôme fonctionnel sur une seule instance : le
 * jour où il cesse de fonctionner, tous les autres tests passent encore et la
 * régression n'apparaît qu'en production, sous la forme de notifications push
 * envoyées en double. D'où ces tests.
 *
 * `pool.query` est bouchonné par un mini-Postgres en mémoire qui reproduit la
 * sémantique des deux énoncés qui comptent : l'`INSERT … ON CONFLICT DO UPDATE
 * … WHERE expires_at < NOW()` (l'atomicité de l'acquisition) et le `DELETE …
 * WHERE owner = $2` (on ne libère que son propre bail).
 */

interface LockRow { owner: string; expiresAt: number; }

function makeFakePool() {
  const locks = new Map<string, LockRow>();
  const state = new Map<string, string>();
  let now = Date.now();

  const query = vi.fn(async (sql: string, params: any[] = []) => {
    if (sql.includes('INSERT INTO job_locks')) {
      const [jobName, owner, ttlMs] = params;
      const held = locks.get(jobName);
      // La clause WHERE du DO UPDATE : on ne prend le bail que s'il est libre
      // ou expiré.
      if (held && held.expiresAt > now) return { rowCount: 0, rows: [] };
      locks.set(jobName, { owner, expiresAt: now + Number(ttlMs) });
      return { rowCount: 1, rows: [{ job_name: jobName }] };
    }
    if (sql.includes('DELETE FROM job_locks')) {
      const [jobName, owner] = params;
      const held = locks.get(jobName);
      if (held && held.owner === owner) locks.delete(jobName);
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('SELECT value FROM job_state')) {
      const v = state.get(params[0]);
      return { rowCount: v == null ? 0 : 1, rows: v == null ? [] : [{ value: v }] };
    }
    if (sql.includes('INSERT INTO job_state')) {
      state.set(params[0], params[1]);
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`SQL non bouchonné : ${sql}`);
  });

  return {
    query,
    locks,
    state,
    advance: (ms: number) => { now += ms; },
    /** Force la lecture du bail comme s'il appartenait à quelqu'un d'autre. */
    seize: (jobName: string, ttlMs: number) =>
      locks.set(jobName, { owner: 'autre-instance', expiresAt: now + ttlMs }),
  };
}

async function loadJobLock(fake: ReturnType<typeof makeFakePool>) {
  vi.resetModules();
  vi.doMock('../db/connection', () => ({ pool: { query: fake.query } }));
  return import('./jobLock');
}

describe('withJobLock', () => {
  let fake: ReturnType<typeof makeFakePool>;
  beforeEach(() => { fake = makeFakePool(); });

  it('exécute le travail quand le bail est libre', async () => {
    const { withJobLock } = await loadJobLock(fake);
    const work = vi.fn(async () => 42);

    const out = await withJobLock('job-a', 60_000, work);

    expect(out).toEqual({ ran: true, result: 42 });
    expect(work).toHaveBeenCalledOnce();
  });

  // LE cas que ce module existe pour couvrir.
  it('n’exécute PAS le travail quand une autre instance tient le bail', async () => {
    const { withJobLock } = await loadJobLock(fake);
    fake.seize('job-a', 60_000);
    const work = vi.fn(async () => 'ne devrait pas tourner');

    const out = await withJobLock('job-a', 60_000, work);

    expect(out).toEqual({ ran: false });
    expect(work).not.toHaveBeenCalled();
  });

  it('sérialise deux tours concurrents : un seul travaille', async () => {
    const { withJobLock } = await loadJobLock(fake);
    let running = 0;
    let maxConcurrent = 0;

    const work = async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 20));
      running -= 1;
    };

    const results = await Promise.all([
      withJobLock('job-a', 60_000, work),
      withJobLock('job-a', 60_000, work),
      withJobLock('job-a', 60_000, work),
    ]);

    expect(maxConcurrent).toBe(1);
    expect(results.filter((r) => r.ran)).toHaveLength(1);
  });

  it('rend le bail à la fin, donc le tour suivant peut travailler', async () => {
    const { withJobLock } = await loadJobLock(fake);

    await withJobLock('job-a', 60_000, async () => 1);
    const second = await withJobLock('job-a', 60_000, async () => 2);

    expect(second).toEqual({ ran: true, result: 2 });
  });

  // Sans le `finally`, une seule erreur gèlerait le job jusqu'à expiration du
  // TTL — soit 15 min pour la passe de rattrapage.
  it('rend le bail même quand le travail échoue', async () => {
    const { withJobLock } = await loadJobLock(fake);

    await expect(
      withJobLock('job-a', 60_000, async () => { throw new Error('boum'); }),
    ).rejects.toThrow('boum');

    expect(fake.locks.has('job-a')).toBe(false);
    const after = await withJobLock('job-a', 60_000, async () => 'ok');
    expect(after).toEqual({ ran: true, result: 'ok' });
  });

  // Le filet quand une instance est tuée net : le bail doit finir par se libérer.
  it('reprend un bail expiré', async () => {
    const { withJobLock } = await loadJobLock(fake);
    fake.seize('job-a', 60_000);

    expect(await withJobLock('job-a', 60_000, async () => 1)).toEqual({ ran: false });

    fake.advance(61_000);
    expect(await withJobLock('job-a', 60_000, async () => 1)).toEqual({ ran: true, result: 1 });
  });

  // Une instance qui dépasse son TTL ne doit pas, en partant, retirer le bail
  // que sa remplaçante vient de prendre.
  it('ne retire pas le bail d’une autre instance après un dépassement de TTL', async () => {
    const { withJobLock } = await loadJobLock(fake);

    await withJobLock('job-a', 1_000, async () => {
      fake.advance(2_000);            // notre bail expire pendant le travail
      fake.seize('job-a', 60_000);    // une autre instance le reprend
    });

    expect(fake.locks.get('job-a')?.owner).toBe('autre-instance');
  });

  // Base injoignable : ne rien faire vaut mieux que tourner sans protection.
  it('saute le tour si l’acquisition échoue', async () => {
    const broken = makeFakePool();
    broken.query.mockRejectedValueOnce(new Error('DB down'));
    const { withJobLock } = await loadJobLock(broken);
    const work = vi.fn();

    const out = await withJobLock('job-a', 60_000, work as any);

    expect(out).toEqual({ ran: false });
    expect(work).not.toHaveBeenCalled();
  });

  it('isole les jobs les uns des autres', async () => {
    const { withJobLock } = await loadJobLock(fake);
    fake.seize('job-a', 60_000);

    expect(await withJobLock('job-a', 60_000, async () => 1)).toEqual({ ran: false });
    expect(await withJobLock('job-b', 60_000, async () => 2)).toEqual({ ran: true, result: 2 });
  });
});

describe('jobState', () => {
  let fake: ReturnType<typeof makeFakePool>;
  beforeEach(() => { fake = makeFakePool(); });

  it('relit ce qu’il a écrit', async () => {
    const { getJobState, setJobState } = await loadJobLock(fake);

    expect(await getJobState('k')).toBeNull();
    expect(await setJobState('k', 'v1')).toBe(true);
    expect(await getJobState('k')).toBe('v1');

    await setJobState('k', 'v2');
    expect(await getJobState('k')).toBe('v2');
  });

  // L'appelant (scan de value bets) annule l'envoi quand l'écriture échoue :
  // ce booléen est donc porteur de sens, pas décoratif.
  it('signale un échec d’écriture au lieu de le masquer', async () => {
    const broken = makeFakePool();
    const { setJobState } = await loadJobLock(broken);
    broken.query.mockRejectedValueOnce(new Error('DB down'));

    expect(await setJobState('k', 'v')).toBe(false);
  });

  it('renvoie null plutôt que de propager une erreur de lecture', async () => {
    const broken = makeFakePool();
    const { getJobState } = await loadJobLock(broken);
    broken.query.mockRejectedValueOnce(new Error('DB down'));

    expect(await getJobState('k')).toBeNull();
  });
});
