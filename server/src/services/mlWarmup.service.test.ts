import { describe, it, expect, vi } from 'vitest';

vi.mock('./nhlApiClient', () => ({ fetchGamesRange: vi.fn() }));
vi.mock('./gameMlBundle', () => ({ warmGameMlBundle: vi.fn() }));
vi.mock('./bestBets.service', () => ({ etDate: (n: number) => `D+${n}` }));

import { warmUpcomingBundles } from './mlWarmup.service';

// PERF_PLAN.md P1.5 — le préchauffage ne touche que les matchs à venir, un à la
// fois, et un échec ne bloque pas les suivants.
describe('warmUpcomingBundles', () => {
  it('ne réchauffe que les matchs à venir, en série, sur J..J+7', async () => {
    const order: string[] = [];
    let inFlight = 0, maxInFlight = 0;
    const fetchGamesRange = vi.fn(async () => [
      { id: 1, status: 'scheduled' }, { id: 2, status: 'live' },
      { id: 3, status: 'final' }, { id: 4, status: 'scheduled' },
    ]);
    const warm = vi.fn(async (id: string) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      order.push(id); inFlight--;
    });
    const r = await warmUpcomingBundles({ fetchGamesRange, warm, now: () => new Date() } as any);
    expect(fetchGamesRange).toHaveBeenCalledWith('D+0', 'D+7');
    expect(order).toEqual(['1', '4']);
    expect(maxInFlight).toBe(1);
    expect(r).toMatchObject({ games: 2, failed: 0 });
  });

  it('un match en échec est compté et les suivants passent', async () => {
    const warm = vi.fn(async (id: string) => { if (id === '1') throw new Error('422'); });
    const r = await warmUpcomingBundles({
      fetchGamesRange: async () => [{ id: 1, status: 'scheduled' }, { id: 2, status: 'scheduled' }],
      warm, now: () => new Date(),
    } as any);
    expect(warm).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ games: 2, failed: 1 });
  });

  it('un tour encore en cours fait sauter le suivant', async () => {
    let release!: () => void;
    const slow = { fetchGamesRange: async () => [{ id: 1, status: 'scheduled' }],
      warm: () => new Promise<void>((r) => { release = r; }), now: () => new Date() } as any;
    const first = warmUpcomingBundles(slow);
    await new Promise((r) => setTimeout(r, 0));
    expect(await warmUpcomingBundles(slow)).toBeNull();
    release();
    expect(await first).toMatchObject({ games: 1 });
  });
});
