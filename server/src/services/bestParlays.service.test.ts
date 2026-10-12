import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * « Best Parlay » — ce que les règles du user exigent, vérifié sur un pool
 * synthétique : 3 à 5 jambes, 2 combinés moneyline, ML seulement, ≥ 25 %
 * sur le chiffre FINAL, cohérence par match, pas de doublons.
 */

// La corrélation d'un même match : mockée, pour piloter le chiffre final.
const corr = { factor: 1 };
vi.mock('./predictionEngine', async () => {
  const gp = await vi.importActual<typeof import('./prediction/gameParlay')>('./prediction/gameParlay');
  return {
    isScoreDerivable: gp.isScoreDerivable,
    predictGameLegCorrelation: vi.fn(async () => ({ factor: corr.factor, joint: 0, independent: 0 })),
  };
});
vi.mock('./bestBets.service', () => ({ getBestBets: vi.fn(), normalizeDate: (d?: string) => d }));

import { buildBestParlays, buildMoreParlays, gateBestParlays, gateMoreParlays, getBestParlays, MIN_PARLAY_PCT, MORE_MIN_PCT } from './bestParlays.service';
import { getBestBets, type BestBet } from './bestBets.service';

const NOW = Date.parse('2026-10-10T18:00:00Z');
const LATER = '2026-10-10T23:00:00Z';
const DAY = '2026-10-10';

function bet(p: Partial<BestBet> & { id: string; mlPct: number; gameId: string }): BestBet {
  return {
    subjectType: 'game', marketType: 'moneyline', marketLabel: 'Moneyline',
    subjectId: p.gameId, subjectName: 'X vs Y', subjectLogo: '', teamAbbr: null,
    label: p.id, selection: p.id, selectionValue: 'x', selectionShort: p.id, context: '',
    line: null, teamId: null, playerId: null, rulePct: 50,
    score: p.mlPct, source: 'ml', confidence: 'high', bookPrice: null, bookTitle: null, ev: null,
    game: { date: DAY, startTimeUTC: LATER, home: 'H', away: 'A' },
    ...p,
  };
}

/** Un match : favori à domicile en ML, un total, un joueur du favori. */
function game(n: number, homePct: number, opts: { over?: number; under?: number; star?: number; awayStar?: number } = {}): BestBet[] {
  const gid = `g${n}`, home = `H${n}`, away = `A${n}`;
  const g = { date: DAY, startTimeUTC: LATER, home, away };
  const out: BestBet[] = [
    bet({ id: `${gid}-ml`, gameId: gid, mlPct: homePct, teamAbbr: home, selectionValue: home.toLowerCase(), game: g }),
  ];
  if (opts.over) out.push(bet({ id: `${gid}-over`, gameId: gid, mlPct: opts.over, marketType: 'total_goals',
    selectionValue: 'over', line: 5.5, game: g }));
  if (opts.under) out.push(bet({ id: `${gid}-under`, gameId: gid, mlPct: opts.under, marketType: 'total_goals',
    selectionValue: 'under', line: 5.5, game: g }));
  if (opts.star) out.push(bet({ id: `${gid}-star`, gameId: gid, mlPct: opts.star, marketType: 'points_ou',
    subjectType: 'player', subjectId: `p${n}`, playerId: `p${n}`, teamAbbr: home, selectionValue: 'over', line: 0.5, game: g }));
  if (opts.awayStar) out.push(bet({ id: `${gid}-astar`, gameId: gid, mlPct: opts.awayStar, marketType: 'points_ou',
    subjectType: 'player', subjectId: `q${n}`, playerId: `q${n}`, teamAbbr: away, selectionValue: 'over', line: 0.5, game: g }));
  return out;
}

const SLATE: BestBet[] = [
  ...game(1, 78, { over: 62, star: 74 }),
  ...game(2, 75, { under: 64, star: 70 }),
  ...game(3, 72, { over: 60, awayStar: 73 }),
  ...game(4, 70, { star: 68 }),
  ...game(5, 69, { over: 61, star: 66 }),
  ...game(6, 66, { under: 63 }),
];

beforeEach(() => { corr.factor = 1; });

describe('buildBestParlays — les règles', () => {
  it('six combinés, 3 à 5 jambes, tous ≥ 25 %, une journée', async () => {
    const { parlays, day } = await buildBestParlays(SLATE, NOW);
    expect(day).toBe(DAY);
    expect(parlays).toHaveLength(6);
    for (const p of parlays) {
      expect(p.legs.length).toBeGreaterThanOrEqual(3);
      expect(p.legs.length).toBeLessThanOrEqual(5);
      expect(p.probability).toBeGreaterThanOrEqual(MIN_PARLAY_PCT);
      expect(new Set(p.legs.map((l) => l.gameId)).size).toBeGreaterThanOrEqual(2);
    }
  });

  it('exactement deux combinés moneyline, et eux seulement en moneyline', async () => {
    const { parlays } = await buildBestParlays(SLATE, NOW);
    const ml = parlays.filter((p) => p.kind === 'moneyline');
    expect(ml).toHaveLength(2);
    for (const p of ml) expect(p.legs.every((l) => l.marketType === 'moneyline')).toBe(true);
    for (const p of parlays.filter((x) => x.kind === 'mixed')) {
      expect(p.legs.some((l) => l.marketType !== 'moneyline')).toBe(true);
    }
    // Les deux gratuits : un de chaque forme.
    expect(parlays.slice(0, 2).map((p) => p.kind)).toEqual(['moneyline', 'mixed']);
  });

  it('les plus probables d\'abord : le 1er moneyline prend les trois plus gros favoris', async () => {
    const { parlays } = await buildBestParlays(SLATE, NOW);
    expect(parlays[0].legs.map((l) => l.id).sort()).toEqual(['g1-ml', 'g2-ml', 'g3-ml']);
    expect(parlays[0].probability).toBeCloseTo(78 * 75 * 72 / 10_000, 1);
  });

  it('jamais deux combinés trop semblables (au plus la moitié des jambes en commun)', async () => {
    const { parlays } = await buildBestParlays(SLATE, NOW);
    for (let i = 0; i < parlays.length; i++) {
      for (let j = i + 1; j < parlays.length; j++) {
        const a = parlays[i].legs.map((l) => l.id), b = parlays[j].legs.map((l) => l.id);
        const shared = a.filter((x) => b.includes(x)).length;
        expect(shared).toBeLessThanOrEqual(Math.floor(Math.min(a.length, b.length) / 2));
      }
    }
  });

  it('variété : chaque combiné apporte du neuf, aucune jambe partout', async () => {
    const { parlays } = await buildBestParlays(SLATE, NOW);
    const count = new Map<string, number>();
    for (const p of parlays) for (const l of p.legs) count.set(l.id, (count.get(l.id) ?? 0) + 1);
    for (const n of count.values()) expect(n).toBeLessThanOrEqual(2);
    // Les combinés mélangés ne partagent qu'une jambe au plus entre eux.
    const mixed = parlays.filter((p) => p.kind === 'mixed');
    for (let i = 0; i < mixed.length; i++) for (let j = i + 1; j < mixed.length; j++) {
      const a = mixed[i].legs.map((l) => l.id), b = mixed[j].legs.map((l) => l.id);
      expect(a.filter((x) => b.includes(x)).length).toBeLessThanOrEqual(1);
    }
  });

  it('cohérence : jamais un joueur adverse avec le vainqueur, ni un under avec une prop offensive', async () => {
    const { parlays } = await buildBestParlays(SLATE, NOW);
    for (const p of parlays) {
      const ids = p.legs.map((l) => l.id);
      expect(ids.includes('g3-ml') && ids.includes('g3-astar')).toBe(false);
      expect(ids.includes('g2-under') && ids.includes('g2-star')).toBe(false);
    }
  });

  it('une jambe sans score ML (règles) n\'entre jamais', async () => {
    const rules = SLATE.map((b) => ({ ...b, source: 'rules' as const, mlPct: null }));
    const { parlays, day } = await buildBestParlays(rules, NOW);
    expect(parlays).toEqual([]);
    expect(day).toBeNull();
  });

  it('un match commencé (ou sans heure) est écarté', async () => {
    const started = SLATE.map((b) => b.gameId === 'g1'
      ? { ...b, game: { ...b.game!, startTimeUTC: '2026-10-10T17:00:00Z' } } : b);
    const { parlays } = await buildBestParlays(started, NOW);
    expect(parlays.flatMap((p) => p.legs).some((l) => l.gameId === 'g1')).toBe(false);
  });

  it('le seuil porte sur le chiffre FINAL : une corrélation négative peut faire tomber un combiné', async () => {
    corr.factor = 0.5;   // toute paire d'un même match divise par deux
    const { parlays } = await buildBestParlays(SLATE, NOW);
    for (const p of parlays) expect(p.probability).toBeGreaterThanOrEqual(MIN_PARLAY_PCT);
  });

  it('peu de matchs → moins de combinés, aucun inventé', async () => {
    const { parlays } = await buildBestParlays([...game(1, 70), ...game(2, 68)], NOW);
    // Deux matchs, un seul pari chacun : pas de quoi faire 3 jambes.
    expect(parlays).toEqual([]);
  });
});

describe('gateBestParlays — le contenu Pro ne quitte pas le serveur', () => {
  it('gratuit : 2 entiers, puis des coquilles', async () => {
    const { parlays, day } = await buildBestParlays(SLATE, NOW);
    const r = gateBestParlays({ parlays, meta: { generatedAt: 'x', day, mlAvailable: true } }, false);
    expect(r.parlays.slice(0, 2).every((p) => !p.locked)).toBe(true);
    for (const p of r.parlays.slice(2)) {
      expect(Object.keys(p).sort()).toEqual(['id', 'kind', 'legCount', 'locked']);
    }
    expect(r.meta).toMatchObject({ freeCount: 2, total: 6 });
  });

  it('Pro : tout', async () => {
    const { parlays, day } = await buildBestParlays(SLATE, NOW);
    const r = gateBestParlays({ parlays, meta: { generatedAt: 'x', day, mlAvailable: true } }, true);
    expect(r.parlays.every((p) => !p.locked)).toBe(true);
  });
});

describe('buildBestParlays — accueil : cotes exigées (2026-10-11)', () => {
  const priced = SLATE.map((b) => b.marketType === 'moneyline' || b.marketType === 'total_goals'
    ? { ...b, bookPrice: 1.5 } : b);

  it('requirePrice : chaque combiné a une cote, aucune jambe sans prix', async () => {
    const { parlays } = await buildBestParlays(priced, NOW, undefined, { requirePrice: true });
    expect(parlays.length).toBeGreaterThan(0);
    for (const p of parlays) {
      expect(p.bookPrice).not.toBeNull();
      expect(p.legs.every((l) => l.bookPrice != null)).toBe(true);
    }
  });

  it('requirePrice sans aucune cote : rien, plutôt qu\'un combiné sans prix', async () => {
    const { parlays } = await buildBestParlays(SLATE, NOW, undefined, { requirePrice: true });
    expect(parlays).toEqual([]);
  });
});

describe('getBestParlays — repli sans cote (2026-10-12)', () => {
  it('aucune jambe cotée : on combine quand même les best picks', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      vi.mocked(getBestBets).mockResolvedValue({
        bets: SLATE, meta: { generatedAt: 'fallback-test', source: 'ml', mlAvailable: true, scanned: SLATE.length },
      } as any);
      const r = await getBestParlays(DAY);
      expect(r.parlays.length).toBeGreaterThan(0);
      for (const p of r.parlays) expect(p.probability).toBeGreaterThanOrEqual(MIN_PARLAY_PCT);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('buildMoreParlays — « Plus de parlays »', () => {
  it('2 à 8 jambes, une journée, seuil par taille, catégories variées', async () => {
    const more = await buildMoreParlays(SLATE, DAY, [], NOW);
    expect(more.length).toBeGreaterThan(5);
    for (const p of more) {
      expect(p.legs.length).toBeGreaterThanOrEqual(2);
      expect(p.legs.length).toBeLessThanOrEqual(8);
      expect(p.probability).toBeGreaterThanOrEqual(MORE_MIN_PCT[p.legs.length]);
      expect(p.legs.every((l) => l.game?.date === DAY)).toBe(true);
    }
    const kinds = new Set(more.map((p) => p.kind));
    for (const k of ['mixed', 'same_game', 'same_team', 'same_market']) expect(kinds.has(k as never)).toBe(true);
  });

  it('chaque catégorie tient sa promesse', async () => {
    const more = await buildMoreParlays(SLATE, DAY, [], NOW);
    for (const p of more) {
      if (p.kind === 'same_game') expect(new Set(p.legs.map((l) => l.gameId)).size).toBe(1);
      if (p.kind === 'same_team') expect(p.legs.every((l) => l.teamAbbr?.toUpperCase() === p.group)).toBe(true);
      if (p.kind === 'same_market') expect(new Set(p.legs.map((l) => l.marketType)).size).toBe(1);
      if (p.kind === 'mixed') expect(new Set(p.legs.map((l) => l.marketType)).size).toBeGreaterThanOrEqual(2);
    }
  });

  it('jamais de contradiction, même dans un même match', async () => {
    const more = await buildMoreParlays(SLATE, DAY, [], NOW);
    for (const p of more) {
      const ids = p.legs.map((l) => l.id);
      expect(ids.includes('g3-ml') && ids.includes('g3-astar')).toBe(false);
      expect(ids.includes('g2-under') && ids.includes('g2-star')).toBe(false);
    }
  });

  it('jamais deux fois le même combiné, même dans deux catégories', async () => {
    const more = await buildMoreParlays(SLATE, DAY, [], NOW);
    const keys = more.map((p) => p.legs.map((l) => l.id).sort().join('+'));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('ne répète pas les combinés de l\'accueil', async () => {
    const { parlays } = await buildBestParlays(SLATE, NOW);
    const more = await buildMoreParlays(SLATE, DAY, parlays, NOW);
    for (const m of more) for (const p of parlays) {
      const a = m.legs.map((l) => l.id), b = p.legs.map((l) => l.id);
      expect(a.filter((x) => b.includes(x)).length).toBeLessThan(Math.min(a.length, b.length));
    }
  });

  it('gate : un non-abonné ne reçoit aucune jambe des extras', async () => {
    const { parlays, day } = await buildBestParlays(SLATE, NOW);
    const more = await buildMoreParlays(SLATE, DAY, parlays, NOW);
    const r = gateMoreParlays({ featured: parlays, more, meta: { generatedAt: 'x', day, mlAvailable: true } }, false);
    expect(r.featured.slice(0, 2).every((p) => !p.locked)).toBe(true);
    for (const p of r.more) expect(Object.keys(p).sort()).toEqual(['id', 'kind', 'legCount', 'locked']);
  });
});
