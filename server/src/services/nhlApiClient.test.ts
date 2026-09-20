import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Garde-fou contre le retour du troupeau (stampede).
 *
 * `nhlApiClient` met en cache avec `getCached`/`setCached`, sans déduplication
 * au niveau du cache : entre l'instant où N appels concurrents lisent un cache
 * froid et celui où le premier écrit, tous voient `null`. Mesuré avant
 * correction (`loadtest/stampede.ts`) : 500 concurrents → 500 appels NHL.
 *
 * La déduplication vit maintenant dans `fetchNHL`, au point d'étranglement
 * HTTP. Elle n'a aucun symptôme fonctionnel — les réponses sont identiques avec
 * ou sans — donc rien d'autre ne la protège : si quelqu'un la retire, tous les
 * tests passeraient encore et la facture de latence reviendrait en silence.
 * D'où ce test.
 */

/** Charge le module avec un `fetch` bouchonné qui compte et temporise. */
async function loadWithStubbedFetch(latencyMs = 30) {
  vi.resetModules();
  process.env.NHL_USE_MOCK = 'false';

  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(String(url));
    await new Promise((r) => setTimeout(r, latencyMs));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        standings: [{
          teamAbbrev: { default: 'BOS' },
          teamFullName: { default: 'Boston Bruins' },
          gamesPlayed: 10, wins: 6, losses: 3, otLosses: 1, points: 13,
        }],
      }),
    };
  });

  const mod = await import('./nhlApiClient');
  return { mod, calls };
}

describe('nhlApiClient — déduplication des requêtes en vol', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('collapse N appels concurrents sur une clé froide en UN seul appel NHL', async () => {
    const { mod, calls } = await loadWithStubbedFetch();

    await Promise.all(Array.from({ length: 200 }, () => mod.fetchTeams()));

    expect(calls.length).toBe(1);
  });

  it('rend à tous les appelants la même donnée', async () => {
    const { mod } = await loadWithStubbedFetch();

    const results = await Promise.all(Array.from({ length: 50 }, () => mod.fetchTeams()));

    expect(results.every((r) => Array.isArray(r) && r.length === 1)).toBe(true);
    expect(results.every((r) => r[0].abbreviation === 'BOS')).toBe(true);
  });

  it('ne sert plus rien depuis l’en-vol une fois la requête terminée (pas de fuite)', async () => {
    const { mod, calls } = await loadWithStubbedFetch();

    await mod.fetchTeams();          // 1er appel : va au réseau
    expect(calls.length).toBe(1);

    // Le cache prend le relais ; l'entrée en vol a bien été retirée, sinon les
    // appels suivants attendraient une promesse déjà résolue et périmée.
    await mod.fetchTeams();
    expect(calls.length).toBe(1);
  });

  it('ne mémorise pas un échec : l’appel suivant retente', async () => {
    vi.resetModules();
    process.env.NHL_USE_MOCK = 'false';

    let attempt = 0;
    vi.stubGlobal('fetch', async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('réseau coupé');
      return {
        ok: true, status: 200,
        json: async () => ({ standings: [{ teamAbbrev: { default: 'BOS' } }] }),
      };
    });

    const mod = await import('./nhlApiClient');

    await expect(mod.fetchTeams()).rejects.toThrow('réseau coupé');
    // Si l'échec restait dans la map des requêtes en vol, celui-ci rejetterait
    // aussi — et l'endpoint resterait cassé jusqu'au redémarrage.
    await expect(mod.fetchTeams()).resolves.toBeInstanceOf(Array);
    expect(attempt).toBe(2);
  });

  /**
   * `team/summary?limit=-1` est demandé par TROIS fonctions avec exactement la
   * même URL (`fetchTeamSeasonOfficial`, `fetchAllTeamsSeason`,
   * `fetchTeamSummaryStats`). Tant qu'elles faisaient leur `fetch` elles-mêmes,
   * chacune payait son aller-retour ; le passage par `fetchStats` les rattache à
   * la même requête en vol.
   */
  it('dédoublonne team/summary entre deux fonctions différentes', async () => {
    const { mod, calls } = await loadWithStubbedFetch();

    await Promise.all([mod.fetchAllTeamsSeason(), mod.fetchTeamSummaryStats()]);

    expect(calls.filter((u) => u.includes('/team/summary')).length).toBe(1);
  });
});

/**
 * TIMEOUT — trouvé par le tir de charge S1 du 2026-08-03, pas par relecture.
 *
 * Le module n'avait aucun timeout : `fetch` sans `signal` s'en remet au défaut
 * d'undici, 300 s. Mesuré pendant le tir : `upstream.nhl.maxMs = 305 043`.
 *
 * La déduplication rend ce trou bien pire qu'une lenteur isolée — tous les
 * appelants d'une URL partagent le sort du premier. Ces deux tests portent
 * exactement là-dessus, et sur rien de fonctionnellement visible : sans eux, un
 * retrait du `signal` passerait toute la suite au vert.
 */
describe('nhlApiClient — timeout', () => {
  beforeEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  // `NHL_TIMEOUT_MS` est lu à l'import du module. Le laisser à 50 ms
  // contaminerait les blocs suivants, dont les `fetch` bouchonnés répondent vite
  // mais pas instantanément sur une machine chargée — un test qui échoue une
  // fois sur vingt est pire qu'un test absent.
  afterEach(() => { delete process.env.NHL_TIMEOUT_MS; });

  /** Charge le module avec un `fetch` qui ne répond jamais, mais respecte `signal`. */
  async function loadWithHangingFetch(timeoutMs = 50) {
    vi.resetModules();
    process.env.NHL_USE_MOCK = 'false';
    process.env.NHL_TIMEOUT_MS = String(timeoutMs);

    vi.stubGlobal('fetch', (_url: string, init: any) => new Promise((_resolve, reject) => {
      // Comportement d'undici : l'abandon rejette avec un `AbortError`.
      init?.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    }));

    return import('./nhlApiClient');
  }

  it('abandonne un appel qui ne répond pas, avec un message qui nomme la cause', async () => {
    const mod = await loadWithHangingFetch(50);

    // Sans timeout, cette promesse tiendrait 300 s et le test expirerait.
    await expect(mod.fetchTeams()).rejects.toThrow(/timeout/i);
  });

  it('libère TOUS les appelants dédoublonnés, pas seulement le premier', async () => {
    const mod = await loadWithHangingFetch(50);

    // C'est le vrai enjeu : pendant le tir, un seul appel bloqué a fait expirer
    // toutes les requêtes qui attendaient la même URL. Le timeout doit donc
    // rejeter la promesse PARTAGÉE, sinon il ne protège qu'une requête sur N.
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => mod.fetchTeams()),
    );

    expect(results.every((r) => r.status === 'rejected')).toBe(true);
  });

  it('ne mémorise pas un dépassement de délai : l’appel suivant retente', async () => {
    vi.resetModules();
    process.env.NHL_USE_MOCK = 'false';
    process.env.NHL_TIMEOUT_MS = '50';

    let attempt = 0;
    vi.stubGlobal('fetch', (_url: string, init: any) => {
      attempt += 1;
      if (attempt === 1) {
        return new Promise((_r, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
        });
      }
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => ({ standings: [{ teamAbbrev: { default: 'BOS' } }] }),
      });
    });

    const mod = await import('./nhlApiClient');

    await expect(mod.fetchTeams()).rejects.toThrow(/timeout/i);
    // Une coupure passagère ne doit pas geler l'endpoint jusqu'au redémarrage.
    await expect(mod.fetchTeams()).resolves.toBeInstanceOf(Array);
  });

  /**
   * L'hôte `api.nhle.com/stats/rest` (classements, sommaires de saison) était
   * servi par quatre `fetch` bruts qui contournaient `fetchWithTimeout` : le
   * timeout ci-dessus ne les protégeait pas, et le tir S1 ne les avait pas
   * exercés. Ils passent par `fetchStats` depuis le 2026-08-24 — ce test est ce
   * qui empêche d'y revenir sans s'en apercevoir.
   */
  it('couvre aussi l’hôte des stats (team/summary)', async () => {
    const mod = await loadWithHangingFetch(50);

    await expect(mod.fetchTeamSummaryStats()).rejects.toThrow(/timeout/i);
  });
});

/**
 * CALENDRIER — cache par SEMAINE et non par plage (ligne S de l'audit).
 *
 * `fetchGamesRange` mettait en cache le résultat assemblé sous
 * `range:<début>:<fin>`. Les bornes viennent du calendrier côté client : deux
 * plages qui se chevauchent de six jours sur sept ne partageaient rien, et le
 * nombre de clés suivait le nombre de plages consultées. Ces tests portent sur
 * ce qui ne se voit pas dans la réponse — elle est identique dans les deux cas.
 */
describe('nhlApiClient — cache du calendrier par semaine', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  const plusDays = (iso: string, n: number): string => {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };

  /** `fetch` bouchonné : rend une semaine de 7 jours à partir de la date demandée. */
  async function loadWithSchedule() {
    vi.resetModules();
    process.env.NHL_USE_MOCK = 'false';

    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      const asked = String(url).split('/').pop() ?? '';
      const gameWeek = Array.from({ length: 7 }, (_, i) => ({
        date: plusDays(asked, i),
        games: [{ id: `${asked}-${i}`, gameState: 'FUT', homeTeam: { abbrev: 'BOS' }, awayTeam: { abbrev: 'MTL' } }],
      }));
      return { ok: true, status: 200, json: async () => ({ gameWeek }) };
    });

    return { mod: await import('./nhlApiClient'), calls };
  }

  it('ne redemande rien pour une plage incluse dans des semaines déjà chargées', async () => {
    const { mod, calls } = await loadWithSchedule();

    const wide = await mod.fetchGamesRange('2026-01-05', '2026-01-25');
    expect(wide.length).toBeGreaterThan(0);
    const first = calls.length;
    expect(first).toBeGreaterThan(0);

    // Décalée d'un jour : sous l'ancienne clé `range:<début>:<fin>`, c'était un
    // cache froid et toute la fenêtre repartait vers la NHL.
    await mod.fetchGamesRange('2026-01-06', '2026-01-24');

    expect(calls.length).toBe(first);
  });

  it('rend la même chose au deuxième appel qu’au premier', async () => {
    const { mod } = await loadWithSchedule();

    const a = await mod.fetchGamesRange('2026-01-05', '2026-01-18');
    const b = await mod.fetchGamesRange('2026-01-05', '2026-01-18');

    expect(b.map((g: any) => g.id)).toEqual(a.map((g: any) => g.id));
  });

  it('borne la fenêtre à 45 jours', async () => {
    const { mod } = await loadWithSchedule();

    const games = await mod.fetchGamesRange('2026-01-05', '2026-12-31');
    const dates = games.map((g: any) => g.gameDate).sort();

    expect(dates[dates.length - 1] <= plusDays('2026-01-05', 45)).toBe(true);
  });
});

/**
 * `fetchGameById` et `fetchPlayerById` étaient les deux seules fonctions du
 * module sans cache : elles repartaient vers la NHL à chaque requête, la
 * déduplication en vol ne les protégeant que des rafales strictement
 * simultanées. Elles servent 5 routes NHL et 2 chemins ML.
 *
 * Ces tests portent sur ce qui n'a AUCUN symptôme visible — les réponses sont
 * identiques avec ou sans cache — donc rien d'autre ne les protège d'une
 * suppression silencieuse.
 */

/** Bouchonne `fetch` avec une charge de gamecenter/landing paramétrable. */
async function loadWithGame(gameState: string) {
  vi.resetModules();
  process.env.NHL_USE_MOCK = 'false';

  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: 2025020123,
        gameState,
        gameDate: '2026-01-15',
        homeTeam: { abbrev: 'BOS', score: 3 },
        awayTeam: { abbrev: 'MTL', score: 2 },
      }),
    };
  });

  return { mod: await import('./nhlApiClient'), calls };
}

describe('nhlApiClient — cache de fetchGameById', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('ne redemande pas un match déjà chargé', async () => {
    const { mod, calls } = await loadWithGame('LIVE');

    await mod.fetchGameById('2025020123');
    await mod.fetchGameById('2025020123');
    await mod.fetchGameById('2025020123');

    expect(calls.length).toBe(1);
  });

  it('sépare bien deux matchs différents', async () => {
    const { mod, calls } = await loadWithGame('FINAL');

    await mod.fetchGameById('2025020123');
    await mod.fetchGameById('2025020124');

    expect(calls.length).toBe(2);
  });

  // Le point sensible : un match en direct doit rester frais. On vérifie le TTL
  // via l'horloge simulée plutôt que par le contenu, qui est identique.
  it('garde 30 s un match en direct, 6 h un match terminé', async () => {
    vi.useFakeTimers();
    try {
      const live = await loadWithGame('LIVE');
      await live.mod.fetchGameById('1');
      vi.advanceTimersByTime(31_000);
      await live.mod.fetchGameById('1');
      expect(live.calls.length, 'un match en direct doit être re-demandé après 30 s').toBe(2);

      const final = await loadWithGame('FINAL');
      await final.mod.fetchGameById('1');
      vi.advanceTimersByTime(60 * 60_000);   // 1 h
      await final.mod.fetchGameById('1');
      expect(final.calls.length, 'un match terminé ne change plus').toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Un gameId pas encore publié par la NHL ne doit pas être figé en 404 : sinon
  // un match consulté trop tôt resterait introuvable pendant des heures.
  it('ne mémorise pas un 404', async () => {
    vi.resetModules();
    process.env.NHL_USE_MOCK = 'false';

    let attempt = 0;
    vi.stubGlobal('fetch', async () => {
      attempt += 1;
      if (attempt === 1) return { ok: false, status: 404, json: async () => ({}) };
      return {
        ok: true, status: 200,
        json: async () => ({ id: 1, gameState: 'FUT', homeTeam: { abbrev: 'BOS' }, awayTeam: { abbrev: 'MTL' } }),
      };
    });

    const mod = await import('./nhlApiClient');

    await expect(mod.fetchGameById('1')).rejects.toThrow('Game not found');
    await expect(mod.fetchGameById('1')).resolves.toHaveProperty('id');
    expect(attempt).toBe(2);
  });
});

describe('nhlApiClient — cache de fetchPlayerById', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  /**
   * Ce qu'on compte, et pourquoi pas tous les appels.
   *
   * `fetchPlayerById` fait DEUX requêtes amont, pas une : la fiche du joueur
   * (`v1/player/:id/landing`) et le rapport `skater/realtime` de l'autre hôte,
   * qui porte les tirs bloqués et les mises en échec absents de `landing`.
   *
   * Le rapport `realtime` a sa propre mise en cache (30 min, toute la ligue en
   * une réponse), mais il ne met PAS en cache une réponse vide — c'est
   * délibéré : en avant-saison la saison en cours se remplit au premier match.
   * Ici le `fetch` bouchonné rend la fiche joueur pour n'importe quelle URL,
   * donc `realtime` reçoit une réponse sans `data`, la juge vide et repart à
   * chaque fois.
   *
   * Compter les appels bruts mesurerait donc ce comportement-là et non le
   * cache qu'on teste. On ne compte que les `landing`, qui sont exactement les
   * requêtes que le cache de `fetchPlayerById` doit économiser.
   */
  const landings = (calls: string[]) => calls.filter(u => u.includes('/landing')).length;

  async function loadWithPlayer() {
    vi.resetModules();
    process.env.NHL_USE_MOCK = 'false';

    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          playerId: 8478402,
          firstName: { default: 'Connor' },
          lastName:  { default: 'McDavid' },
          position: 'C',
          currentTeamAbbrev: 'EDM',
          seasonTotals: [
            { leagueAbbrev: 'NHL', gameTypeId: 2, gamesPlayed: 40, goals: 25, assists: 45, points: 70 },
          ],
        }),
      };
    });

    return { mod: await import('./nhlApiClient'), calls };
  }

  it('ne redemande pas un joueur déjà chargé', async () => {
    const { mod, calls } = await loadWithPlayer();

    const a = await mod.fetchPlayerById('8478402');
    const b = await mod.fetchPlayerById('8478402');

    expect(landings(calls)).toBe(1);
    expect(b.points).toBe(a.points);
    expect(a.name).toBe('Connor McDavid');
  });

  it('repart vers la NHL après 10 min', async () => {
    vi.useFakeTimers();
    try {
      const { mod, calls } = await loadWithPlayer();

      await mod.fetchPlayerById('8478402');
      vi.advanceTimersByTime(9 * 60_000);
      await mod.fetchPlayerById('8478402');
      expect(landings(calls)).toBe(1);

      vi.advanceTimersByTime(2 * 60_000);   // total 11 min
      await mod.fetchPlayerById('8478402');
      expect(landings(calls)).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
