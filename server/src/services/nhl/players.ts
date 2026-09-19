/**
 * nhl/players.ts — meilleurs joueurs, fiche joueur, recherche et effectif.
 * Point d'entrée public : `../nhlApiClient.ts`.
 */

import { MOCK_TOP_PLAYERS, MOCK_PLAYER_BY_ID } from '../../data/mockNhl';
import {
  USE_MOCK,
  currentSeason,
  fetchNHL,
  fetchNHLSearch,
  fetchStats,
  getCached,
  parseToiMinutes,
  setCached,
} from './core';

/* ─── Tirs bloqués et mises en échec ─────────────────────────────────────────
 *
 * Ces deux statistiques n'existent NULLE PART dans `v1/player/:id/landing`, la
 * réponse dont `seasonCounts` est tiré. Elles vivent sur l'autre hôte de la
 * LNH, `api.nhle.com/stats/rest`, sous le rapport `skater/realtime`.
 *
 * ── Ce que ce silence coûtait ───────────────────────────────────────────────
 *
 * `types/bet.tsx` DÉCLARE `blockedShots` et `hits` sur les statistiques d'un
 * joueur, et `PlayerPrediction` construit ses marchés « Blocked Shots » et
 * « Hits » derrière un `data.blocks > 0` / `data.hits > 0`. Comme le serveur
 * n'a jamais posé ces champs, le client lisait `undefined ?? 0`, la garde était
 * toujours fausse, et les deux groupes de paris n'ont jamais été rendus une
 * seule fois en production. Pas d'erreur, pas de log : deux marchés écrits,
 * testés, jamais affichés. Le seul endroit du dépôt où ces nombres existaient
 * était `db/seed.ts`, c'est-à-dire les données de démonstration — ce qui
 * explique qu'ils aient l'air de marcher en local.
 *
 * ── Un seul appel pour toute la ligue ───────────────────────────────────────
 *
 * Le rapport n'est PAS filtré par équipe, volontairement. `cayenneExp` accepte
 * bien un filtre d'équipe, mais aucun autre appel de ce dépôt ne s'en sert :
 * `teamSeasons.ts` demande partout la ligue entière (`limit=-1`) et trie côté
 * serveur. On suit le même chemin, pour trois raisons — la syntaxe du filtre
 * est la seule partie de cette API qu'on ne peut pas vérifier depuis les tests
 * (elle n'est pas documentée publiquement) ; un joueur échangé en cours de
 * saison porte plusieurs abréviations et tomberait à côté d'un filtre par club ;
 * et une seule réponse en cache sert TOUTES les équipes, là où un filtre par
 * club en demanderait trente-deux.
 *
 * ~1000 patineurs par réponse, gardés 30 minutes comme le reste.
 */
const STATS_BASE = 'https://api.nhle.com/stats/rest/en';

export interface RealtimeLine { blockedShots: number; hits: number }

/**
 * Tirs bloqués et mises en échec de tous les patineurs de la ligue, indexés par
 * id joueur.
 *
 * Rend une table VIDE quand l'amont est indisponible — jamais des zéros. Un
 * zéro dit « ce joueur n'a bloqué aucun tir », ce qui ferait disparaître les
 * marchés correspondants exactement comme le bogue qu'on corrige ici ; une
 * entrée absente laisse le champ `undefined`, que l'appelant sait lire comme
 * « on ne sait pas ».
 *
 * L'échec n'est PAS mis en cache : un amont momentanément muet ne doit pas
 * condamner ces marchés pour la demi-heure qui suit.
 */
export async function fetchSkaterRealtime(): Promise<Map<string, RealtimeLine>> {
  const season = currentSeason();
  const cacheKey = `realtime_${season}`;
  const cached = getCached<Map<string, RealtimeLine>>(cacheKey);
  if (cached) return cached;

  const out = new Map<string, RealtimeLine>();
  try {
    const cayenne = encodeURIComponent(`seasonId=${season} and gameTypeId=2`);
    const data = await fetchStats<any>(
      `${STATS_BASE}/skater/realtime?isAggregate=false&isGame=false&start=0&limit=-1&cayenneExp=${cayenne}`,
      'skater realtime',
    );
    for (const r of data?.data ?? []) {
      if (r?.playerId == null) continue;
      out.set(String(r.playerId), {
        blockedShots: r.blockedShots ?? 0,
        hits:         r.hits ?? 0,
      });
    }
  } catch {
    // Amont muet : table vide, sans cache. Les marchés concernés ne
    // s'afficheront pas ce coup-ci — l'état d'aujourd'hui — mais rien d'autre
    // sur la page ne tombe avec, et le prochain appel retentera.
    return out;
  }

  setCached(cacheKey, out, 30 * 60_000);
  return out;
}

// --- Players --------------------------------------------------------------

export async function fetchTopPlayers(): Promise<any[]> {
  if (USE_MOCK) return MOCK_TOP_PLAYERS as any[];
  const cached = getCached<any[]>('players');
  if (cached) return cached;

  const season = currentSeason();

  const [pointsRes, goalsRes] = await Promise.all([
    fetchNHL<any>(`v1/skater-stats-leaders/${season}/2?categories=points&limit=50`),
    fetchNHL<any>(`v1/skater-stats-leaders/${season}/2?categories=goals&limit=25`),
  ]);

  const map = new Map<number, any>();

  function merge(p: any) {
    const pts = p.points ?? p.value ?? 0;
    const gp  = p.gamesPlayed ?? 1;
    const entry = {
      id:          String(p.id),
      name:        [p.firstName?.default, p.lastName?.default].filter(Boolean).join(' '),
      teamId:      (p.teamAbbrev ?? p.teamAbbreviation ?? '').toLowerCase(),
      position:    p.positionCode ?? p.position ?? 'F',
      number:      p.sweaterNumber ?? 0,
      goals:       p.goals   ?? 0,
      assists:     p.assists ?? 0,
      points:      pts,
      plusMinus:   p.plusMinus ?? 0,
      shots:       p.shots    ?? 0,
      shotPct:     p.shootingPctg != null ? Math.round(p.shootingPctg * 1000) / 10 : 0,
      ppPoints:    p.powerPlayPoints ?? 0,
      gamesPlayed: gp,
      lastFive:    [] as number[],
      winImpact:   Math.min(99, Math.round((pts / gp) * 100)),
    };
    const existing = map.get(p.id);
    if (!existing || pts > existing.points) map.set(p.id, entry);
  }

  for (const p of (pointsRes?.points ?? [])) merge(p);
  for (const p of (goalsRes?.goals   ?? [])) merge(p);

  const players = [...map.values()].sort((a, b) => b.points - a.points);
  setCached('players', players, 10 * 60_000);
  return players;
}

/** Compteurs de saison communs à la fiche joueur et à l'effectif (`seasonTotals` NHL). */
function seasonCounts(cur: any) {
  return {
    goals:     cur.goals     ?? 0,
    assists:   cur.assists   ?? 0,
    points:    cur.points    ?? 0,
    plusMinus: cur.plusMinus ?? 0,
    shots:     cur.shots     ?? 0,
    shotPct:   cur.shootingPctg != null ? Math.round(cur.shootingPctg * 1000) / 10 : 0,
    ppPoints:  cur.powerPlayPoints ?? 0,
  };
}

/**
 * Comme `fetchGameById`, cette fonction n'avait aucun cache alors qu'elle sert
 * `/api/nhl/players/:id`, `/api/nhl/players/:id/stats`,
 * `/api/nhl/predictions/player/:id` et `POST /api/predict/player-prop`.
 *
 * TTL de 10 min, aligné sur `fetchTopPlayers` : les totaux de saison d'un joueur
 * ne bougent qu'après un match, jamais en cours de navigation.
 */
export async function fetchPlayerById(playerId: string): Promise<any> {
  if (USE_MOCK) {
    const mp = MOCK_PLAYER_BY_ID[String(playerId)];
    if (mp) return mp;
  }

  const key    = `player:${playerId}`;
  const cached = getCached<any>(key);
  if (cached) return cached;

  const data    = await fetchNHL<any>(`v1/player/${playerId}/landing`);
  const seasons = (data.seasonTotals ?? []).filter(
    (s: any) => s.leagueAbbrev === 'NHL' && s.gameTypeId === 2
  );
  const cur  = seasons[seasons.length - 1] ?? {};
  const abbr = data.currentTeamAbbrev ?? '';
  const pts  = cur.points ?? 0;
  const gp   = cur.gamesPlayed ?? 1;

  // Tirs bloqués / mises en échec : absents de `landing`, pris sur le rapport
  // `realtime`. L'appel couvre toute la ligue et est mis en cache, donc
  // consulter dix joueurs ne coûte qu'une requête.
  // Un gardien n'y figure pas (rapport « skater ») : la table rend `undefined`,
  // ce qui est correct — un gardien ne bloque pas de tirs au sens de cette
  // statistique.
  const realtime = await fetchSkaterRealtime().catch(() => new Map<string, RealtimeLine>());
  const rt = realtime.get(String(data.playerId));

  const player = {
    id:          String(data.playerId),
    name:        [data.firstName?.default, data.lastName?.default].filter(Boolean).join(' '),
    teamId:      abbr.toLowerCase(),
    teamAbbr:    abbr,
    position:    data.position ?? 'F',
    number:      data.sweaterNumber ?? 0,
    ...seasonCounts(cur),
    gamesPlayed: gp,
    // `pim` et `avgToi` sont dans `seasonTotals` depuis toujours — ce mapping ne
    // les lisait simplement pas, et `predictionEngine` servait donc une moyenne
    // de ligue (0,4 minute de pénalité, 16 ou 22 minutes de jeu) pour TOUS les
    // joueurs sur ces deux marchés. `fetchTeamPlayerSeasons` les lit déjà un peu
    // plus bas dans ce fichier, sur la même réponse.
    penaltyMinutes: cur.pim ?? 0,
    /**
     * ⚠️ `undefined` quand l'amont n'a rien dit, PAS `0`.
     *
     * `PlayerPrediction` garde ses marchés « Blocked Shots » et « Hits »
     * derrière un `> 0`. Un zéro de repli les ferait disparaître exactement
     * comme avant ce câblage, mais cette fois en ayant l'air d'une donnée.
     */
    blockedShots:   rt?.blockedShots,
    hits:           rt?.hits,
    /** Temps de jeu moyen par match, en MINUTES décimales (l'API donne "18:42"). */
    avgToi:         parseToiMinutes(cur.avgToi),
    lastFive:    [] as number[],
    winImpact:   Math.min(99, Math.round((pts / gp) * 100)),
    // Stats gardien (présentes uniquement si position === 'G' dans seasonTotals)
    savePct:          cur.savePctg        ?? null,
    goalsAgainstAvg:  cur.goalsAgainstAvg ?? null,
    wins:             cur.wins            ?? null,
    shutouts:         cur.shutouts        ?? null,
    shotsAgainst:     cur.shotsAgainst    ?? null,
    goalsAgainst:     cur.goalsAgainst    ?? null,
  };

  setCached(key, player, 10 * 60_000);
  return player;
}

export async function searchPlayers(q: string): Promise<any[]> {
  if (!q.trim()) return [];
  try {
    // This endpoint lives on search.d3.nhle.com, not api-web.nhle.com — it
    // returns a bare array (not wrapped in { players: [...] }).
    const data = await fetchNHLSearch<any>(
      `v1/search/player?culture=en-us&limit=20&q=${encodeURIComponent(q)}&active=true`
    );
    const results: any[] = Array.isArray(data) ? data : (data?.players ?? []);
    return results.map((p: any) => ({
      id:       String(p.playerId ?? p.id),
      name:     p.name ?? [p.firstName, p.lastName].filter(Boolean).join(' '),
      teamId:   (p.teamAbbrev ?? p.teamAbbreviation ?? '').toLowerCase(),
      position: p.positionCode ?? p.position ?? 'F',
      number:   p.sweaterNumber ?? 0,
      goals: 0, assists: 0, points: 0,
      plusMinus: 0, shots: 0, shotPct: 0, ppPoints: 0,
      gamesPlayed: 0, lastFive: [] as number[], winImpact: 0,
    }));
  } catch {
    const lower = q.toLowerCase();
    const all   = await fetchTopPlayers();
    return all.filter(p =>
      p.name.toLowerCase().includes(lower) || p.teamId.includes(lower)
    );
  }
}

/** Fetch the full roster for a team (abbr like "EDM") with current-season stats */
export async function fetchTeamRoster(abbr: string): Promise<any[]> {
  const upper = abbr.toUpperCase();
  const cacheKey = `roster_${upper}`;
  const cached = getCached<any[]>(cacheKey);
  if (cached) return cached;

  const season = currentSeason();

  // Roster list
  const rosterData = await fetchNHL<any>(`v1/roster/${upper}/${season}`);
  const allPlayers: any[] = [
    ...(rosterData.forwards  ?? []),
    ...(rosterData.defensemen ?? []),
    ...(rosterData.goalies   ?? []),
  ];

  // Fetch stats for every player in parallel (capped to avoid hammering API)
  // `realtime` part en même temps : un seul appel pour toute l'équipe, qui
  // apporte les tirs bloqués et les mises en échec absents de `landing`.
  const [statsResults, realtime] = await Promise.all([
    Promise.allSettled(
      allPlayers.map(p => fetchNHL<any>(`v1/player/${p.id}/landing`))
    ),
    fetchSkaterRealtime(),
  ]);

  const out: any[] = [];
  for (let i = 0; i < allPlayers.length; i++) {
    const roster = allPlayers[i];
    const res    = statsResults[i];
    if (res.status === 'rejected') continue;
    const data   = res.value as any;
    const seasons = (data.seasonTotals ?? []).filter(
      (s: any) => s.leagueAbbrev === 'NHL' && s.gameTypeId === 2
    );
    const cur  = seasons[seasons.length - 1] ?? {};
    const pts  = cur.points ?? 0;
    const gp   = Math.max(cur.gamesPlayed ?? 1, 1);
    out.push({
      id:          String(roster.id),
      name:        [roster.firstName?.default, roster.lastName?.default].filter(Boolean).join(' '),
      teamId:      upper.toLowerCase(),
      teamAbbr:    upper,
      position:    roster.positionCode ?? 'F',
      number:      roster.sweaterNumber ?? 0,
      ...seasonCounts(cur),
      // `undefined` et non `0` quand l'amont n'a rien dit : voir
      // `fetchSkaterRealtime`. Un zéro se lirait « n'a rien bloqué ».
      blockedShots: realtime.get(String(roster.id))?.blockedShots,
      hits:         realtime.get(String(roster.id))?.hits,
      gamesPlayed: gp,
      lastFive:    [] as number[],
      winImpact:   Math.min(99, Math.round((pts / gp) * 100)),
    });
  }

  out.sort((a, b) => b.points - a.points);
  setCached(cacheKey, out, 30 * 60_000); // cache 30 min
  return out;
}
