import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

/**
 * `manual.routes` — le câblage HTTP de la saisie manuelle.
 *
 * Ce fichier verrouille ce que la relecture de code ne montre pas :
 *
 *   1. **Rien n'est public.** L'ancien `GET /api/injuries` l'était. La liste
 *      nominative des joueurs qu'on croit absents et la pondération qu'on leur
 *      donne, c'est la méthode du modèle ; le jour où quelqu'un déplace
 *      `router.use(authenticate, requireRole('admin'))` sous une route pour
 *      « juste rendre la lecture publique », ces tests tombent.
 *
 *   2. **Les clés d'URL sont validées.** Elles entrent dans une clé primaire ET
 *      dans une clé de cache : une clé libre laisse écrire des lignes qu'aucune
 *      lecture ne retrouvera jamais, et faire grossir le cache.
 *
 *   3. **Une saisie vidée SUPPRIME la ligne.** C'est la seule façon de retirer
 *      un gardien saisi par erreur. Une écriture qui ne saurait qu'ajouter
 *      laisserait le facteur en place jusqu'à la fin des temps.
 *
 * Le service est bouchonné : SQL est vérifié ailleurs (`manualData.service.test`
 * pour la mécanique, un vrai Postgres pour la migration).
 */

const ADMIN = { sub: 'admin-1', email: 'a@b.com', role: 'admin' };

// Auth : on vérifie que les routes SONT gardées, pas comment le JWT est validé.
const authenticate = vi.fn((req: any, _res: any, next: any) => { req.user = ADMIN; next(); });
// Les rôles sont déclarés dans la signature du faux : sans eux, le `spread` de
// `requireRole(...roles)` plus bas ne typerait pas (TS2556), et `npm run
// typecheck` — qui tourne en CI — échouerait alors que les tests passent.
const requireRole = vi.fn((..._roles: string[]) => (req: any, res: any, next: any) =>
  req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Insufficient permissions' }));

vi.mock('../middleware/auth.middleware', () => ({
  authenticate: (req: any, res: any, next: any) => authenticate(req, res, next),
  requireRole:  (...roles: string[]) => requireRole(...roles),
}));

const Manual = {
  getEntry:     vi.fn(),
  listEntries:  vi.fn(),
  mapEntries:   vi.fn(),
  setEntry:     vi.fn(),
  deleteEntry:  vi.fn(),
  replaceKind:  vi.fn(),
  purgeDatedBefore: vi.fn(),
  clearManualDataCache: vi.fn(),
  coverage:     vi.fn(),
};
vi.mock('../services/manualData.service', () => Manual);

// Le calendrier du jour sert à dire « 0 sur 12 » plutôt que « 0 ».
const fetchGamesByDate = vi.fn();
vi.mock('../services/nhlApiClient', () => ({ fetchGamesByDate }));

// `normalizeRefName` vit dans refereeStore, qui tire tout le module (fetch,
// TtlCache, table d'équipes). On le bouchonne pour garder ce test sur les
// routes, en gardant la sémantique réelle : minuscules, espaces normalisés.
vi.mock('../services/refereeStore', () => ({
  normalizeRefName: (n: string) => (n || '').toLowerCase().replace(/\s+/g, ' ').trim(),
}));

async function app() {
  const { default: routes } = await import('./manual.routes');
  const a = express();
  a.use(express.json());
  a.use('/api/manual', routes);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  Manual.getEntry.mockResolvedValue(null);
  Manual.mapEntries.mockResolvedValue({});
  Manual.listEntries.mockResolvedValue([]);
  Manual.setEntry.mockResolvedValue(undefined);
  Manual.deleteEntry.mockResolvedValue(true);
  Manual.replaceKind.mockResolvedValue(undefined);
  Manual.coverage.mockResolvedValue({});
  fetchGamesByDate.mockResolvedValue([]);
});

describe('garde admin', () => {
  it('la LECTURE aussi est réservée aux admins', async () => {
    authenticate.mockImplementationOnce((req: any, _res: any, next: any) => {
      req.user = { ...ADMIN, role: 'user' };
      next();
    });
    await request(await app()).get('/api/manual/injuries').expect(403);
  });

  it('un admin passe', async () => {
    await request(await app()).get('/api/manual/injuries').expect(200);
  });
});

describe('blessures', () => {
  it('refuse une clé de match qui n\'est pas VISITEUR@MAISON', async () => {
    const res = await request(await app())
      .put('/api/manual/injuries/pas-une-cle')
      .send({ lineupAdj: 0.03 })
      .expect(400);
    expect(res.body.error).toMatch(/clé de match invalide/);
    expect(Manual.setEntry).not.toHaveBeenCalled();
  });

  it('met la clé en majuscules avant de l\'écrire', async () => {
    await request(await app())
      .put('/api/manual/injuries/tor@bos')
      .send({ home: [{ player: 'Jeremy Swayman', impact: 0.12 }] })
      .expect(200);

    expect(Manual.setEntry).toHaveBeenCalledWith(
      'injuries', 'TOR@BOS', expect.objectContaining({
        home: [expect.objectContaining({ player: 'Jeremy Swayman', impact: 0.12 })],
      }), ADMIN.sub);
  });

  it('une saisie vidée SUPPRIME la ligne au lieu d\'écrire une entrée neutre', async () => {
    await request(await app())
      .put('/api/manual/injuries/TOR@BOS')
      .send({ home: [], away: [], lineupAdj: 0, lineupNote: '' })
      .expect(200);

    expect(Manual.deleteEntry).toHaveBeenCalledWith('injuries', 'TOR@BOS');
    expect(Manual.setEntry).not.toHaveBeenCalled();
  });

  it('refuse un impact hors barème (400, rien n\'est écrit)', async () => {
    await request(await app())
      .put('/api/manual/injuries/TOR@BOS')
      .send({ home: [{ player: 'Quelqu\'un', impact: 50 }] })
      .expect(400);
    expect(Manual.setEntry).not.toHaveBeenCalled();
  });
});

describe('compos du soir', () => {
  it('refuse une date malformée en query', async () => {
    await request(await app()).get('/api/manual/lineups?date=15-01-2026').expect(400);
  });

  it('écrit gardiens et absents dans DEUX jeux distincts, équipes en majuscules', async () => {
    await request(await app())
      .put('/api/manual/lineups/2026-01-15')
      .send({ goalies: { tor: 'Joseph Woll' }, scratches: { mtl: ['Kaiden Guhle'] } })
      .expect(200);

    expect(Manual.setEntry).toHaveBeenCalledWith(
      'starting_goalies', '2026-01-15', { TOR: 'Joseph Woll' }, ADMIN.sub);
    expect(Manual.setEntry).toHaveBeenCalledWith(
      'scratches', '2026-01-15', { MTL: ['Kaiden Guhle'] }, ADMIN.sub);
  });

  it('une journée vidée supprime la ligne — c\'est ainsi qu\'on RETIRE un gardien saisi par erreur', async () => {
    await request(await app())
      .put('/api/manual/lineups/2026-01-15')
      .send({ goalies: {} })
      .expect(200);

    expect(Manual.deleteEntry).toHaveBeenCalledWith('starting_goalies', '2026-01-15');
    // `scratches` n'était pas dans le corps : on n'y touche pas.
    expect(Manual.deleteEntry).not.toHaveBeenCalledWith('scratches', '2026-01-15');
    expect(Manual.setEntry).not.toHaveBeenCalled();
  });

  it('refuse un corps qui ne contient ni gardiens ni absents', async () => {
    await request(await app()).put('/api/manual/lineups/2026-01-15').send({}).expect(400);
    expect(Manual.setEntry).not.toHaveBeenCalled();
  });

  it('DELETE efface les deux jeux de la journée', async () => {
    await request(await app()).delete('/api/manual/lineups/2026-01-15').expect(200);
    expect(Manual.deleteEntry).toHaveBeenCalledWith('starting_goalies', '2026-01-15');
    expect(Manual.deleteEntry).toHaveBeenCalledWith('scratches', '2026-01-15');
  });
});

describe('blessés longue durée', () => {
  it('écrit la liste d\'une équipe, abréviation en majuscules, doublons retirés', async () => {
    await request(await app())
      .put('/api/manual/long-injuries/tor')
      .send({ players: [
        { player: 'Auston Matthews', impact: 0.06, since: '2026-10-01' },
        { player: 'auston matthews', impact: 0.03 },
      ] })
      .expect(200);
    expect(Manual.setEntry).toHaveBeenCalledWith(
      'long_injuries', 'TOR',
      { players: [{ player: 'Auston Matthews', impact: 0.06, since: '2026-10-01' }] },
      ADMIN.sub);
  });

  it('une liste vide SUPPRIME la ligne — c\'est ainsi qu\'un joueur revient au jeu', async () => {
    await request(await app()).put('/api/manual/long-injuries/TOR').send({ players: [] }).expect(200);
    expect(Manual.deleteEntry).toHaveBeenCalledWith('long_injuries', 'TOR');
    expect(Manual.setEntry).not.toHaveBeenCalled();
  });

  it('refuse une équipe invalide et un poids absurde', async () => {
    await request(await app()).put('/api/manual/long-injuries/T0R1X').send({ players: [] }).expect(400);
    await request(await app())
      .put('/api/manual/long-injuries/TOR')
      .send({ players: [{ player: 'Auston Matthews', impact: 5 }] })
      .expect(400);
    expect(Manual.setEntry).not.toHaveBeenCalled();
  });

  it('une entrée de la synchro retirée à la main est gardée en « rejet » — la ligne n\'est PAS effacée', async () => {
    Manual.getEntry.mockResolvedValueOnce({ players: [
      { player: 'Auston Matthews', impact: 0.06, since: '2026-09-28', until: '2026-10-20', source: 'auto' },
    ] });
    await request(await app()).put('/api/manual/long-injuries/TOR').send({ players: [] }).expect(200);
    expect(Manual.deleteEntry).not.toHaveBeenCalled();
    expect(Manual.setEntry).toHaveBeenCalledWith(
      'long_injuries', 'TOR',
      { players: [], dismissed: [{ player: 'Auston Matthews', since: '2026-09-28' }] },
      ADMIN.sub);
  });

  it('le client ne peut pas se déclarer « auto » : `source` est écarté', async () => {
    await request(await app())
      .put('/api/manual/long-injuries/TOR')
      .send({ players: [{ player: 'Auston Matthews', impact: 0.06, source: 'auto', until: '2026-10-20' }] })
      .expect(200);
    expect(Manual.setEntry).toHaveBeenCalledWith(
      'long_injuries', 'TOR',
      { players: [{ player: 'Auston Matthews', impact: 0.06, until: '2026-10-20' }] },
      ADMIN.sub);
  });

  it('GET rend { ABBR: [joueurs] }', async () => {
    Manual.mapEntries.mockResolvedValueOnce({ TOR: { players: [{ player: 'Auston Matthews', impact: 0.06 }] } });
    const res = await request(await app()).get('/api/manual/long-injuries').expect(200);
    expect(res.body).toEqual({ TOR: [{ player: 'Auston Matthews', impact: 0.06 }] });
    expect(Manual.mapEntries).toHaveBeenCalledWith('long_injuries');
  });
});

describe('arbitres', () => {
  it('remplace la table en une fois, avec des clés normalisées', async () => {
    await request(await app())
      .put('/api/manual/referees')
      .send({
        leagueAvgPpPerGame: 6.4,
        referees: [{ name: '  Wes   McCauley ', ppPerGame: 6.9 }],
      })
      .expect(200);

    expect(Manual.setEntry).toHaveBeenCalledWith(
      'ref_config', 'league', { avgPpPerGame: 6.4 }, ADMIN.sub);
    expect(Manual.replaceKind).toHaveBeenCalledWith(
      'ref_tendency',
      [{ key: 'wes mccauley', payload: { name: 'Wes McCauley', ppPerGame: 6.9, note: undefined } }],
      ADMIN.sub);
  });

  it('la moyenne ligue peut être modifiée seule, sans toucher à la table', async () => {
    await request(await app())
      .put('/api/manual/referees')
      .send({ leagueAvgPpPerGame: 6.1 })
      .expect(200);

    expect(Manual.setEntry).toHaveBeenCalledWith('ref_config', 'league', { avgPpPerGame: 6.1 }, ADMIN.sub);
    expect(Manual.replaceKind).not.toHaveBeenCalled();
  });

  it('rend la moyenne par défaut quand rien n\'est configuré', async () => {
    const res = await request(await app()).get('/api/manual/referees').expect(200);
    expect(res.body).toEqual({ leagueAvgPpPerGame: 6.2, referees: [] });
  });
});


describe('couverture des saisies', () => {
  const soiree = [
    { awayTeam: { abbreviation: 'STL' }, homeTeam: { abbreviation: 'TOR' } },
    { awayTeam: { abbreviation: 'SEA' }, homeTeam: { abbreviation: 'DET' } },
  ];

  it('dit « 0 sur 2 » quand rien n\'est saisi — c\'est tout l\'intérêt', async () => {
    // Une table vide rend exactement les mêmes probabilités qu'un fichier
    // introuvable. Sans ce relevé, la panne d'origine revient sans un mot.
    fetchGamesByDate.mockResolvedValue(soiree);
    const res = await request(await app()).get('/api/manual/coverage?date=2025-11-18').expect(200);

    expect(res.body.matchs).toBe(2);
    expect(res.body.blessures).toEqual({ saisi: 0, attendu: 2, actif: false });
    expect(res.body.gardiensPartants).toEqual({ saisi: 0, attendu: 4, actif: false });
    expect(res.body.absents).toEqual({ saisi: 0, attendu: 4, actif: false });
    expect(res.body.arbitres.actif).toBe(false);
  });

  it('ne compte que les matchs DU JOUR, pas toutes les blessures en base', async () => {
    fetchGamesByDate.mockResolvedValue(soiree);
    Manual.mapEntries.mockResolvedValue({
      'STL@TOR': { home: [], away: [] },      // ce soir
      'BOS@MTL': { home: [], away: [] },      // un autre soir
    });
    Manual.getEntry.mockResolvedValue({ TOR: 'Joseph Woll' });
    Manual.coverage.mockResolvedValue({ ref_tendency: 0, ref_tendency_auto: 32 });

    const res = await request(await app()).get('/api/manual/coverage?date=2025-11-18').expect(200);
    expect(res.body.blessures).toEqual({ saisi: 1, attendu: 2, actif: true });
    expect(res.body.gardiensPartants.saisi).toBe(1);
    // Le facteur arbitre est le seul qui se remplit tout seul.
    expect(res.body.arbitres).toEqual({ saisiManuellement: 0, releveAutomatique: 32, actif: true });
  });

  it('un jour sans match rend 0 sur 0, pas une erreur', async () => {
    fetchGamesByDate.mockRejectedValue(new Error('hors saison'));
    const res = await request(await app()).get('/api/manual/coverage?date=2026-09-04').expect(200);
    expect(res.body.matchs).toBe(0);
    expect(res.body.blessures.attendu).toBe(0);
  });

  it('refuse une date malformée', async () => {
    await request(await app()).get('/api/manual/coverage?date=hier').expect(400);
  });
});
