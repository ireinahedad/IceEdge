import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `getBettingStats` — ce que ce fichier verrouille.
 *
 * Trois valeurs de cet écran étaient écrites EN DUR dans le retour du service
 * (`calibrationScore: 81`, `currentStreak: 4`, `longestWinStreak: 11`), et tout
 * le reste était agrégé depuis `user_bets` — une table que plus aucun chemin
 * d'écriture n'alimente depuis que les coupons partent dans `bet_slips`. Les
 * deux défauts se cachaient l'un l'autre : un profil affichait « 0 pari » et
 * « 11 W de série », et l'incohérence ne faisait tomber aucun test parce
 * qu'aucun test ne regardait.
 *
 * D'où le premier bloc, qui n'assert pas sur une forme d'objet mais sur le
 * TEXTE de la requête : une régression qui repointerait sur `user_bets`
 * renverrait un objet parfaitement bien formé, rempli de zéros.
 */

const query = vi.fn();
vi.mock('../db/connection', () => ({
  pool: { query: (...args: unknown[]) => query(...args) },
}));
vi.mock('../logger', () => ({
  logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
}));

import { getBettingStats } from './profile.service';

type Outcome = 'win' | 'loss' | 'pending' | 'void';

/** Une ligne telle que la renvoie la requête de `getBettingStats`. */
function slip(
  outcome: Outcome,
  opts: {
    placedAt?: string;
    markets?: string[];
    isParlay?: boolean;
    prob?: number | null;
  } = {},
) {
  const markets = opts.markets ?? ['moneyline'];
  return {
    outcome,
    isParlay:            opts.isParlay ?? markets.length > 1,
    combinedProbability: opts.prob === undefined ? 60 : opts.prob,
    placedAt:            new Date(opts.placedAt ?? '2026-03-10T18:00:00Z'),
    marketTypes:         markets,
  };
}

/** Le service ordonne déjà en SQL (ASC) ; on sert les lignes dans cet ordre. */
function mockSlips(rows: ReturnType<typeof slip>[]) {
  query.mockResolvedValueOnce({ rows });
}

beforeEach(() => {
  query.mockReset();
});

describe('getBettingStats — source des données', () => {
  it('lit bet_slips et jamais user_bets', async () => {
    mockSlips([]);
    await getBettingStats('u1');

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain('FROM bet_slips');
    expect(sql).not.toContain('user_bets');
    expect(query.mock.calls[0][1]).toEqual(['u1']);
  });

  it('ne rapatrie pas le JSONB des legs, seulement les marchés', async () => {
    mockSlips([]);
    await getBettingStats('u1');

    // `legs` n'apparaît que déplié par jsonb_array_elements : la colonne
    // entière ne doit pas être sélectionnée.
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain('jsonb_array_elements(legs)');
    expect(sql).not.toMatch(/SELECT[\s\S]*\blegs\s*,/);
  });

  it('un compte sans coupon rend des compteurs à zéro, pas des constantes', async () => {
    mockSlips([]);
    const stats = await getBettingStats('u1');

    expect(stats).toMatchObject({
      totalBets: 0, wins: 0, losses: 0, pending: 0,
      hitRate: 0, avgProbability: 0,
      currentStreak: 0, longestWinStreak: 0,
      bestMarketType: null, bestMarketHitRate: 0,
    });
    expect(stats.marketBreakdown).toEqual([]);
    expect(stats.monthlyStats).toEqual([]);
    // Le champ a été retiré de la réponse, pas remis à 0 : le client ne doit
    // plus pouvoir peindre une jauge de calibration.
    expect(stats).not.toHaveProperty('calibrationScore');
  });
});

describe('getBettingStats — séries', () => {
  it('compte la plus longue série de victoires', async () => {
    mockSlips([
      slip('win'), slip('loss'), slip('win'), slip('win'), slip('win'), slip('loss'), slip('win'),
    ]);
    const stats = await getBettingStats('u1');
    expect(stats.longestWinStreak).toBe(3);
  });

  it('un coupon annulé ou en attente ne coupe pas une série', async () => {
    // Quatre victoires séparées par un `void` et un `pending` : c'est UNE série
    // de quatre, pas deux de deux. Un coupon annulé n'est pas une défaite.
    mockSlips([
      slip('win'), slip('win'), slip('void'), slip('pending'), slip('win'), slip('win'),
    ]);
    const stats = await getBettingStats('u1');
    expect(stats.longestWinStreak).toBe(4);
    expect(stats.currentStreak).toBe(4);
  });

  it('la série en cours est signée négativement sur des défaites', async () => {
    mockSlips([slip('win'), slip('win'), slip('loss'), slip('loss')]);
    const stats = await getBettingStats('u1');
    expect(stats.currentStreak).toBe(-2);
    expect(stats.longestWinStreak).toBe(2);
  });

  it('aucun coupon tranché ⇒ série à 0', async () => {
    mockSlips([slip('pending'), slip('void')]);
    const stats = await getBettingStats('u1');
    expect(stats.currentStreak).toBe(0);
    expect(stats.longestWinStreak).toBe(0);
  });
});

describe('getBettingStats — taux et probabilités', () => {
  it('le taux de réussite ignore les coupons non tranchés', async () => {
    // 3 gagnés, 1 perdu, plus un `void` et un `pending` qui ne doivent peser
    // sur aucun des deux côtés de la fraction.
    mockSlips([
      slip('win'), slip('win'), slip('win'), slip('loss'), slip('void'), slip('pending'),
    ]);
    const stats = await getBettingStats('u1');
    expect(stats.totalBets).toBe(6);
    expect(stats.pending).toBe(1);
    expect(stats.hitRate).toBe(75);
  });

  it('la probabilité moyenne ignore les coupons sans probabilité', async () => {
    // Moyenne de 40 et 60, pas de 40, 60 et 0.
    mockSlips([
      slip('win',  { prob: 40 }),
      slip('loss', { prob: 60 }),
      slip('win',  { prob: null }),
    ]);
    const stats = await getBettingStats('u1');
    expect(stats.avgProbability).toBe(50);
  });
});

describe('getBettingStats — détail par marché', () => {
  it('déplie les jambes et attribue l’issue du coupon à chacune', async () => {
    mockSlips([
      slip('win',  { markets: ['moneyline', 'total_goals'] }),
      slip('loss', { markets: ['moneyline'] }),
    ]);
    const stats = await getBettingStats('u1');

    const byType = Object.fromEntries(stats.marketBreakdown.map((m) => [m.marketType, m]));
    expect(byType.moneyline).toMatchObject({ bets: 2, hitRate: 50, label: 'Moneyline' });
    expect(byType.total_goals).toMatchObject({ bets: 1, hitRate: 100, label: 'Totals' });
  });

  it('un même marché joué deux fois dans un parlay compte deux fois', async () => {
    mockSlips([slip('win', { markets: ['shots_ou', 'shots_ou'] })]);
    const stats = await getBettingStats('u1');
    expect(stats.marketBreakdown).toEqual([
      { marketType: 'shots_ou', label: 'Shots O/U', bets: 2, hitRate: 100 },
    ]);
  });

  it('les coupons non tranchés n’entrent pas dans le détail', async () => {
    mockSlips([slip('pending', { markets: ['puck_line'] })]);
    const stats = await getBettingStats('u1');
    expect(stats.marketBreakdown).toEqual([]);
  });

  it('un marché inconnu garde son identifiant comme libellé', async () => {
    mockSlips([slip('win', { markets: ['saves_ou'] })]);
    const stats = await getBettingStats('u1');
    expect(stats.marketBreakdown[0].label).toBe('saves_ou');
  });

  it('trie par volume décroissant', async () => {
    mockSlips([
      slip('win',  { markets: ['moneyline'] }),
      slip('loss', { markets: ['moneyline'] }),
      slip('win',  { markets: ['puck_line'] }),
    ]);
    const stats = await getBettingStats('u1');
    expect(stats.marketBreakdown.map((m) => m.marketType)).toEqual(['moneyline', 'puck_line']);
  });
});

describe('getBettingStats — meilleur marché', () => {
  it('ne couronne pas un marché joué une seule fois', async () => {
    // `anytime_goal` sort à 100 % sur UN pari, `moneyline` à 60 % sur cinq.
    // Sans plancher d'échantillon, le coup de chance gagne le titre.
    mockSlips([
      ...Array.from({ length: 3 }, () => slip('win',  { markets: ['moneyline'] })),
      ...Array.from({ length: 2 }, () => slip('loss', { markets: ['moneyline'] })),
      slip('win', { markets: ['anytime_goal'] }),
    ]);
    const stats = await getBettingStats('u1');
    expect(stats.bestMarketType).toBe('moneyline');
    expect(stats.bestMarketHitRate).toBe(60);
  });

  it('rend null tant qu’aucun marché n’atteint le plancher', async () => {
    mockSlips([slip('win', { markets: ['moneyline'] })]);
    const stats = await getBettingStats('u1');
    expect(stats.bestMarketType).toBeNull();
    expect(stats.bestMarketHitRate).toBe(0);
  });
});

describe('getBettingStats — historique mensuel', () => {
  it('ne mélange pas le même mois de deux saisons', async () => {
    mockSlips([
      slip('win',  { placedAt: '2025-04-10T18:00:00Z' }),
      slip('loss', { placedAt: '2026-04-10T18:00:00Z' }),
    ]);
    const stats = await getBettingStats('u1');
    expect(stats.monthlyStats).toHaveLength(2);
    expect(stats.monthlyStats.map((m) => m.month)).toEqual(['Apr', 'Apr']);
    expect(stats.monthlyStats.map((m) => m.hitRate)).toEqual([100, 0]);
  });

  it('ne rend que les six derniers mois, les plus récents', async () => {
    const months = ['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05'];
    mockSlips(months.map((m) => slip('win', { placedAt: `${m}-15T18:00:00Z` })));
    const stats = await getBettingStats('u1');
    expect(stats.monthlyStats.map((m) => m.month))
      .toEqual(['Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May']);
  });

  it('le taux mensuel se calcule sur les coupons tranchés, pas sur les coupons posés', async () => {
    // Un gagné, un encore en attente : 100 %, pas 50 %.
    mockSlips([
      slip('win',     { placedAt: '2026-02-03T18:00:00Z' }),
      slip('pending', { placedAt: '2026-02-04T18:00:00Z' }),
    ]);
    const stats = await getBettingStats('u1');
    expect(stats.monthlyStats).toEqual([{ month: 'Feb', bets: 2, hitRate: 100 }]);
  });
});

describe('getBettingStats — parlays', () => {
  it('ne compte pas un parlay en attente comme une défaite', async () => {
    mockSlips([
      slip('win',     { markets: ['moneyline', 'puck_line'] }),
      slip('loss',    { markets: ['moneyline', 'puck_line'] }),
      slip('pending', { markets: ['moneyline', 'puck_line'] }),
      slip('void',    { markets: ['moneyline', 'puck_line'] }),
    ]);
    const stats = await getBettingStats('u1');
    expect(stats.parlayRecord).toEqual({ wins: 1, losses: 1 });
  });

  it('un coupon simple n’entre pas dans le bilan parlay', async () => {
    mockSlips([slip('loss', { markets: ['moneyline'], isParlay: false })]);
    const stats = await getBettingStats('u1');
    expect(stats.parlayRecord).toEqual({ wins: 0, losses: 0 });
  });
});
