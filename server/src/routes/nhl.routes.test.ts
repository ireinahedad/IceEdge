import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * Vérifie les en-têtes de cache HTTP des routes NHL sans toucher au réseau :
 * `NHLService` est bouchonné, donc ce qui est testé est bien le câblage des
 * politiques de cache, pas l'API NHL.
 *
 * L'intérêt principal porte sur la règle « match terminé » : `nhlApiClient`
 * distingue déjà 30 s (en direct) de 6 h (terminé) côté serveur, et cette
 * distinction doit survivre au passage HTTP. Sans elle, on cacherait 30 s des
 * scores définitifs de la saison dernière — le CDN ne servirait presque rien.
 */

const mockService = {
  getGamesByDate:  vi.fn(),
  getGamesRange:   vi.fn(),
  getScheduleAnchor: vi.fn(),
  getLiveGames:    vi.fn(),
  getGame:         vi.fn(),
  getGameDetail:   vi.fn(),
  getTeams:        vi.fn(),
  getStandings:    vi.fn(),
  searchPlayers:   vi.fn(),
  getHeadToHeadSeason: vi.fn(),
};

vi.mock('../services/nhl.service', () => ({
  NHLService: class { constructor() { return mockService as any; } },
}));

const mockPredictions = vi.hoisted(() => ({
  buildGameMarketsWithStatus: vi.fn(),
  buildTeamMarkets:           vi.fn(),
  buildPlayerMarkets:         vi.fn(),
}));
vi.mock('../services/nhlPredictions', () => mockPredictions);

async function nhlApp() {
  const { default: routes } = await import('./nhl.routes');
  const a = express();
  a.use('/api/nhl', routes);
  return a;
}

const LIVE      = 'public, max-age=30, stale-while-revalidate=60';
const SIX_HOURS = 'public, max-age=21600, stale-while-revalidate=43200';

describe('en-têtes de cache des routes NHL', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('cache brièvement une journée contenant un match en direct', async () => {
    mockService.getGamesByDate.mockResolvedValue([
      { id: '1', status: 'final' },
      { id: '2', status: 'live' },
    ]);

    const res = await request(await nhlApp()).get('/api/nhl/games?date=2026-01-15');
    expect(res.headers['cache-control']).toBe(LIVE);
  });

  // Le cas qui justifie `cacheByGameStatus` : sans lui, l'historique complet du
  // calendrier serait re-demandé toutes les 30 s.
  it('cache 6 h une journée entièrement terminée', async () => {
    mockService.getGamesByDate.mockResolvedValue([
      { id: '1', status: 'final' },
      { id: '2', status: 'final' },
    ]);

    const res = await request(await nhlApp()).get('/api/nhl/games?date=2025-11-02');
    expect(res.headers['cache-control']).toBe(SIX_HOURS);
  });

  // Une journée sans match ne dit rien sur la fraîcheur : le calendrier NHL peut
  // encore y ajouter un match. On reste sur le TTL court plutôt que de figer
  // une réponse vide pendant 6 h.
  it('ne fige pas une journée vide', async () => {
    mockService.getGamesByDate.mockResolvedValue([]);

    const res = await request(await nhlApp()).get('/api/nhl/games?date=2026-07-04');
    expect(res.headers['cache-control']).toBe(LIVE);
  });

  it('applique la même règle au détail d’un match', async () => {
    mockService.getGameDetail.mockResolvedValue({ id: '9', status: 'final' });
    const fin = await request(await nhlApp()).get('/api/nhl/games/9/detail');
    expect(fin.headers['cache-control']).toBe(SIX_HOURS);

    mockService.getGameDetail.mockResolvedValue({ id: '9', status: 'live' });
    const live = await request(await nhlApp()).get('/api/nhl/games/9/detail');
    expect(live.headers['cache-control']).toBe(LIVE);
  });

  it('fin de match : en-tête du rythme de 10 s (match et détail)', async () => {
    mockService.getGameDetail.mockResolvedValue({ id: '9', status: 'live', refreshMs: 10_000 });
    const d = await request(await nhlApp()).get('/api/nhl/games/9/detail');
    expect(d.headers['cache-control']).toBe('public, max-age=0, s-maxage=10');
    mockService.getGame.mockResolvedValue({ id: '9', status: 'live', refreshMs: 10_000 });
    const g = await request(await nhlApp()).get('/api/nhl/games/9');
    expect(g.headers['cache-control']).toBe('public, max-age=0, s-maxage=10');
  });

  it('donne au classement le TTL de fetchTeams (5 min)', async () => {
    mockService.getStandings.mockResolvedValue([]);

    const res = await request(await nhlApp()).get('/api/nhl/standings');
    expect(res.headers['cache-control']).toBe('public, max-age=300, stale-while-revalidate=600');
  });

  // Une recherche est une trace de navigation : cachable par le navigateur,
  // jamais par un cache partagé.
  it('garde la recherche de joueurs hors des caches partagés', async () => {
    mockService.searchPlayers.mockResolvedValue([]);

    const res = await request(await nhlApp()).get('/api/nhl/players/search?q=mcdavid');
    expect(res.headers['cache-control']).toBe('private, max-age=300');
  });

  // Une panne amont ne doit pas être figée par le CDN : 502 caché 30 min =
  // 30 min d'indisponibilité pour une coupure NHL de 10 secondes.
  it('ne cache pas une panne de l’API NHL', async () => {
    mockService.getLiveGames.mockRejectedValue(
      Object.assign(new Error('NHL API 503'), { status: 502 })
    );

    const res = await request(await nhlApp()).get('/api/nhl/games/live');
    expect(res.status).toBe(502);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  it('ne cache pas une plage de dates invalide', async () => {
    const res = await request(await nhlApp()).get('/api/nhl/games/range?start=zz&end=zz');
    expect(res.status).toBe(400);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });
});

// Prédictions d'un match : leurs chiffres partent du score et du temps restant
// dès la mise au jeu. Cachées 5 min comme avant, elles resteraient figées sur
// un score dépassé ; une fois tout décidé, elles ne bougeront plus jamais.
describe('cache des prédictions d’un match', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  const groups = [{ id: 'moneyline', title: 'Moneyline', cols: 2, options: [] }];

  it('match en cours : 30 s', async () => {
    mockPredictions.buildGameMarketsWithStatus.mockResolvedValue({ groups, status: 'live' });
    const res = await request(await nhlApp()).get('/api/nhl/predictions/game/2026020001');
    expect(res.headers['cache-control']).toBe(LIVE);
    expect(res.body).toEqual(groups);   // toujours un tableau pour le client
  });

  it('fin de match : le navigateur revalide, un CDN garde 10 s', async () => {
    mockPredictions.buildGameMarketsWithStatus.mockResolvedValue({ groups, status: 'live', refreshMs: 10_000 });
    const res = await request(await nhlApp()).get('/api/nhl/predictions/game/2026020001');
    expect(res.headers['cache-control']).toBe('public, max-age=0, s-maxage=10');
  });

  it('match terminé : 6 h', async () => {
    mockPredictions.buildGameMarketsWithStatus.mockResolvedValue({ groups, status: 'final' });
    const res = await request(await nhlApp()).get('/api/nhl/predictions/game/2026020001');
    expect(res.headers['cache-control']).toBe(SIX_HOURS);
  });

  it('match à venir : 5 min, comme avant', async () => {
    mockPredictions.buildGameMarketsWithStatus.mockResolvedValue({ groups, status: 'scheduled' });
    const res = await request(await nhlApp()).get('/api/nhl/predictions/game/2026020001');
    expect(res.headers['cache-control']).toBe('public, max-age=300, stale-while-revalidate=600');
  });

  it('les poids personnalisés passent au calcul', async () => {
    mockPredictions.buildGameMarketsWithStatus.mockResolvedValue({ groups, status: 'scheduled' });
    await request(await nhlApp()).get('/api/nhl/predictions/game/2026020001?wQuality=50&wHomeIce=10');
    expect(mockPredictions.buildGameMarketsWithStatus).toHaveBeenCalledWith(
      '2026020001', expect.objectContaining({ quality: 50, homeIce: 10 }));
  });

  it('ne cache pas une erreur', async () => {
    mockPredictions.buildGameMarketsWithStatus.mockRejectedValue(Object.assign(new Error('Game not found'), { status: 404 }));
    const res = await request(await nhlApp()).get('/api/nhl/predictions/game/2026020001');
    expect(res.status).toBe(404);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });
});

describe('face-à-face sur une saison', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('fige 6 h une saison passée demandée par son id', async () => {
    mockService.getHeadToHeadSeason.mockResolvedValue({ season: '20202021', games: [] });
    const res = await request(await nhlApp()).get('/api/nhl/teams/TOR/head-to-head/MTL/20202021');
    expect(res.status).toBe(200);
    expect(mockService.getHeadToHeadSeason).toHaveBeenCalledWith('TOR', 'MTL', '20202021');
    expect(res.headers['cache-control']).toBe(SIX_HOURS);
  });

  // `previous` est résolu par le serveur, et ne doit pas rester 6 h en cache
  // au moment de la bascule de septembre.
  it('résout `previous` côté serveur sans le figer', async () => {
    const { previousSeason } = await import('../services/nhl/core');
    mockService.getHeadToHeadSeason.mockResolvedValue({ season: previousSeason(), games: [] });
    const res = await request(await nhlApp()).get('/api/nhl/teams/TOR/head-to-head/MTL/previous');
    expect(res.status).toBe(200);
    expect(mockService.getHeadToHeadSeason).toHaveBeenCalledWith('TOR', 'MTL', previousSeason());
    expect(res.headers['cache-control']).not.toBe(SIX_HOURS);
  });

  it('résout `current` sur la saison en cours, en TTL court', async () => {
    const { currentSeason } = await import('../services/nhl/core');
    mockService.getHeadToHeadSeason.mockResolvedValue({ season: currentSeason(), games: [] });
    const res = await request(await nhlApp()).get('/api/nhl/teams/TOR/head-to-head/MTL/current');
    expect(res.status).toBe(200);
    expect(mockService.getHeadToHeadSeason).toHaveBeenCalledWith('TOR', 'MTL', currentSeason());
    expect(res.headers['cache-control']).toBe('public, max-age=1800, stale-while-revalidate=3600');
  });

  it('refuse un club ou une saison mal formés', async () => {
    const a = await nhlApp();
    expect((await request(a).get('/api/nhl/teams/TORONTO/head-to-head/MTL/20252026')).status).toBe(400);
    expect((await request(a).get('/api/nhl/teams/TOR/head-to-head/MTL/2025')).status).toBe(400);
    expect((await request(a).get('/api/nhl/teams/TOR/head-to-head/MTL/next')).status).toBe(400);
    expect(mockService.getHeadToHeadSeason).not.toHaveBeenCalled();
  });
});
