import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Cadences envoyées au service ML pour les props joueur (`/predict/player`).
 * Cf. ml/INCOHERENCES_ML.md §12 : la fiche du joueur portait ses mises en
 * échec, tirs bloqués, points en AN, victoires et blanchissages, mais le
 * service recevait une moyenne de ligue (ou, pour les points en AN, rien).
 */

const player = vi.fn();
vi.mock('./nhlApiClient', () => ({
  fetchPlayerById:       (id: string) => player(id),
  fetchTeams:            vi.fn(async () => []),
  fetchTeamSummaryStats: vi.fn(async () => ({})),
  fetchTeamRestInfo:     vi.fn(),
  fetchTeamTravel:       vi.fn(),
  fetchTeamGoalies:      vi.fn(async () => []),
}));

import { buildPlayerPropFeatures } from './featureEngineering';

const skater = {
  position: 'C', gamesPlayed: 50, goals: 10, assists: 30, points: 40, shots: 120,
  ppPoints: 20, hits: 40, blockedShots: 25, penaltyMinutes: 12,
};
const goalie = {
  position: 'G', gamesPlayed: 40, goals: 0, assists: 1, points: 1, shots: 0,
  wins: 24, shutouts: 4, shotsAgainst: 1100, goalsAgainst: 100,
};

beforeEach(() => player.mockReset());

describe('buildPlayerPropFeatures — cadences par joueur', () => {
  it('points en AN : la mesure du joueur (0,40/match), pas buts × 0,35', async () => {
    player.mockResolvedValue(skater);
    const f = await buildPlayerPropFeatures('1', 'pp_point', 0.5);
    expect(f.pp_points_per_game).toBeCloseTo(20 / 50, 10);
  });

  it('mises en échec et tirs bloqués : mesurés sur le joueur, pas la moyenne de ligue', async () => {
    player.mockResolvedValue(skater);
    const hits = await buildPlayerPropFeatures('1', 'hits', 0.5);
    expect(hits.shots_per_game).toBeCloseTo(40 / 50, 10);
    expect(hits.rate_is_league_average).toBe(false);
    const blocks = await buildPlayerPropFeatures('1', 'blocks', 0.5);
    expect(blocks.shots_per_game).toBeCloseTo(25 / 50, 10);
  });

  it('gardien : victoires et blanchissages par match joué', async () => {
    player.mockResolvedValue(goalie);
    expect((await buildPlayerPropFeatures('2', 'wins', 0.5)).shots_per_game).toBeCloseTo(24 / 40, 10);
    expect((await buildPlayerPropFeatures('2', 'shutouts', 0.5)).shots_per_game).toBeCloseTo(4 / 40, 10);
  });

  it('sans mesure : moyenne de ligue MESURÉE (1,2 mise en échec), et dit comme telle', async () => {
    player.mockResolvedValue({ ...skater, hits: undefined, blockedShots: undefined, ppPoints: undefined });
    const hits = await buildPlayerPropFeatures('1', 'hits', 0.5);
    expect(hits.shots_per_game).toBe(1.2);
    expect(hits.rate_is_league_average).toBe(true);
    expect((await buildPlayerPropFeatures('1', 'blocks', 0.5)).shots_per_game).toBe(0.84);
    // Points en AN sans mesure : rien n'est envoyé, le service ne chiffre pas.
    expect((await buildPlayerPropFeatures('1', 'pp_point', 0.5)).pp_points_per_game).toBeUndefined();
  });

  it('un patineur n\'a pas de taux de victoire de gardien : moyenne de ligue déclarée', async () => {
    player.mockResolvedValue(skater);
    const f = await buildPlayerPropFeatures('1', 'wins', 0.5);
    expect(f.shots_per_game).toBe(0.5);
    expect(f.rate_is_league_average).toBe(true);
  });
});
