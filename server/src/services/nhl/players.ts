/**
 * nhl/players.ts — meilleurs joueurs, fiche joueur, recherche et effectif.
 * Point d'entrée public : `../nhlApiClient.ts`.
 */

import { MOCK_TOP_PLAYERS, MOCK_PLAYER_BY_ID } from '../../data/mockNhl';
import {
  USE_MOCK,
  currentSeason,
  previousSeason,
  fetchNHL,
  fetchNHLSearch,
  fetchStats,
  getCached,
  parseToiMinutes,
  setCached,
  TEAM_META,
} from './core';
import { mapLimit } from '../concurrency';

/* ─── Quelle saison porte les statistiques d'un joueur ───────────────────────
 *
 * `seasonTotals` était lu par `seasons[seasons.length - 1]` — la dernière ligne
 * du tableau, quelle qu'elle soit. Tant que la bascule de `currentSeason()`
 * était en octobre, ça tombait juste par accident. Depuis qu'elle est en
 * septembre, la dernière ligne EST la saison écoulée pendant six semaines,
 * et ces totaux se seraient affichés comme ceux de la saison en cours.
 *
 * On choisit donc explicitement, et on DIT lequel des deux cas s'applique :
 *
 *   • la saison en cours existe et compte au moins un match → on la prend ;
 *   • sinon → la dernière saison complète, avec `statsSeason` qui porte son
 *     identifiant, pour que l'écran puisse écrire « 2025-26 » à côté.
 *
 * Pourquoi ne pas simplement rendre des zéros en avant-saison : une cadence de
 * buts par match est la SEULE base des prédictions joueur. À zéro, toutes les
 * tuiles tombent au plancher de 3 % et la page ne dit plus rien. La dernière
 * saison complète est la meilleure estimation disponible — à condition d'être
 * datée, ce qu'elle n'était pas.
 */
export function pickSeasonRow(seasonTotals: any[]): { cur: any; statsSeason: string } {
  const season = currentSeason();
  const nhl = (seasonTotals ?? []).filter(
    (s: any) => s.leagueAbbrev === 'NHL' && s.gameTypeId === 2,
  );
  const inSeason = nhl.find((s: any) => String(s.seasonId) === season);
  if (inSeason && (inSeason.gamesPlayed ?? 0) > 0) {
    return { cur: inSeason, statsSeason: season };
  }
  const last = nhl[nhl.length - 1];
  return {
    cur: last ?? {},
    statsSeason: last?.seasonId != null ? String(last.seasonId) : previousSeason(),
  };
}

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
export async function fetchSkaterRealtime(season?: string): Promise<Map<string, RealtimeLine>> {
  // Sans saison demandée : la saison en cours, et à défaut la dernière
  // complète. En avant-saison la première est vide — retomber sur la seconde
  // garde les marchés « tirs bloqués » et « mises en échec » alignés sur les
  // totaux de buts et de passes, qui font la même bascule (`pickSeasonRow`).
  // Mêler les deux donnerait une ligne aux buts de 2025-26 et aux blocs de
  // 2026-27.
  const wanted = season ? [season] : [currentSeason(), previousSeason()];
  for (const sid of wanted) {
    const table = await realtimeForSeason(sid);
    if (table.size > 0) return table;
  }
  return new Map();
}

/** Une saison précise du rapport `realtime`. Table vide = rien reçu. */
async function realtimeForSeason(season: string): Promise<Map<string, RealtimeLine>> {
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

  // Une réponse vide n'est PAS mise en cache : en avant-saison, la saison en
  // cours se remplit au premier match, et on ne veut pas la déclarer vide pour
  // la demi-heure qui suit.
  if (out.size > 0) setCached(cacheKey, out, 30 * 60_000);
  return out;
}


/* ─── Qui joue CETTE saison ──────────────────────────────────────────────────
 *
 * LE PROBLÈME. Les meneurs de la ligue (`fetchTopPlayers`) et la recherche
 * retombent sur la DERNIÈRE saison complète tant que la saison en cours n'a pas
 * commencé — c'est voulu, une cadence de buts ne s'invente pas. Mais le
 * classement de l'an dernier contient des joueurs qui ont pris leur retraite,
 * qui ont changé de club ou qui ne sont plus dans la LNH. L'application les
 * proposait donc partout — accueil, stats, recherche, marchés de paris — avec
 * en prime l'équipe de l'an dernier à côté du nom. On peut miser sur un joueur
 * qui ne jouera pas.
 *
 * CE QU'ON FAIT. Un index des effectifs PUBLIÉS pour la saison en cours, toutes
 * équipes confondues. Il sert à deux choses, et à deux seulement :
 *   · écarter un joueur qui n'est dans aucun effectif ;
 *   · corriger l'équipe, le numéro et la position, qui sont ceux d'aujourd'hui
 *     et non ceux du classement d'où vient la ligne.
 * Les TOTAUX ne sont pas touchés : ils restent ceux de la dernière saison
 * jouée, datés par `statsSeason`, exactement comme avant.
 *
 * LE FILET. Une table VIDE — avant-saison sans effectifs publiés, ou amont
 * muet — ne filtre RIEN. Le pire qu'une panne puisse faire est de laisser
 * passer un ancien joueur ; elle ne doit jamais vider l'application.
 *
 * LE COÛT. 32 appels, mis en cache six heures (un effectif bouge par
 * transaction, pas par minute), six de front. C'est la même dépense qu'UNE
 * consultation de page d'équipe, une fois par demi-journée, pour toute la
 * ligue. L'échec n'est pas mis en cache.
 */

export interface RosterEntry {
  teamAbbr: string;
  position: string;
  number:   number;
}

const ROSTER_INDEX_TTL_MS = 6 * 60 * 60_000;
const ROSTER_INDEX_CONCURRENCY = 6;

export async function fetchActiveRosterIndex(): Promise<Map<string, RosterEntry>> {
  if (USE_MOCK) return new Map();

  const cached = getCached<[string, RosterEntry][]>('roster_index');
  if (cached) return new Map(cached);

  const season = currentSeason();
  const teams  = Object.keys(TEAM_META);

  const perTeam = await mapLimit(teams, ROSTER_INDEX_CONCURRENCY, async (abbr) => {
    try {
      const d = await fetchNHL<any>(`v1/roster/${abbr}/${season}`);
      const players = [...(d.forwards ?? []), ...(d.defensemen ?? []), ...(d.goalies ?? [])];
      return players.map((pl: any) => [String(pl.id), {
        teamAbbr: abbr,
        position: pl.positionCode ?? 'F',
        number:   pl.sweaterNumber ?? 0,
      }] as [string, RosterEntry]);
    } catch {
      // 404 d'avant-saison ou amont muet : cette équipe manque, les autres
      // restent. Voir plus bas pourquoi un index partiel n'est pas utilisé.
      return null;
    }
  });

  const ok = perTeam.filter(Boolean) as [string, RosterEntry][][];

  // Un index PARTIEL est pire que pas d'index : filtrer avec 20 équipes sur 32
  // effacerait les joueurs des 12 autres, ce qui ressemble à un bogue de
  // données et pas à une panne. On exige donc la ligue entière, ou rien.
  if (ok.length < teams.length) return new Map();

  const index = new Map<string, RosterEntry>(ok.flat());
  if (index.size > 0) setCached('roster_index', [...index.entries()], ROSTER_INDEX_TTL_MS);
  return index;
}

/**
 * Écarte les joueurs absents des effectifs de la saison en cours et remet
 * l'équipe / le numéro / la position à jour sur ceux qui restent.
 *
 * Table vide → la liste passe telle quelle (voir le filet ci-dessus).
 */
function keepActive<T extends { id: string; teamId?: string; number?: number; position?: string }>(
  players: T[],
  index:   Map<string, RosterEntry>,
): T[] {
  if (index.size === 0) return players;
  const out: T[] = [];
  for (const p of players) {
    const cur = index.get(String(p.id));
    if (!cur) continue;                       // retraité, sans contrat, hors LNH
    out.push({
      ...p,
      teamId:   cur.teamAbbr.toLowerCase(),   // l'équipe d'AUJOURD'HUI
      number:   cur.number   || p.number,
      position: cur.position || p.position,
    });
  }
  return out;
}

// --- Players --------------------------------------------------------------

/**
 * Meilleurs joueurs de la ligue.
 *
 * ── Le 404 d'avant-saison ───────────────────────────────────────────────────
 *
 * `v1/skater-stats-leaders/:season/2` ne rend pas un classement vide pour une
 * saison qui n'a pas commencé : il rend **404**. Depuis que `currentSeason()`
 * bascule en septembre, il y a donc six semaines par an où cet appel échoue,
 * et l'erreur remontait telle quelle jusqu'à l'écran :
 *
 *     NHL API 404 for v1/skater-stats-leaders/20262027/2?categories=points&limit=50
 *
 * La page d'équipe entière tombait avec — « Impossible de charger ça » — alors
 * que tout le reste de ses données était disponible.
 *
 * ── Le repli ────────────────────────────────────────────────────────────────
 *
 * Même bascule que partout ailleurs dans ce fichier (`pickSeasonRow`,
 * `fetchSkaterRealtime`) : la saison en cours, et à défaut la dernière
 * complète. Chaque entrée porte `statsSeason`, pour que l'écran puisse écrire
 * « 2025-26 » à côté d'un total plutôt que de le laisser passer pour celui du
 * calendrier en cours.
 *
 * Un `Promise.allSettled` plutôt qu'un `Promise.all` : les deux catégories
 * (points, buts) ne basculent pas forcément le même jour au premier match de
 * la saison, et une seule des deux suffit à remplir la liste.
 *
 * Une liste vide n'est PAS mise en cache : la saison en cours se remplit au
 * premier match, et on ne veut pas la déclarer vide pour les dix minutes qui
 * suivent.
 */
export async function fetchTopPlayers(): Promise<any[]> {
  if (USE_MOCK) return MOCK_TOP_PLAYERS as any[];
  const cached = getCached<any[]>('players');
  if (cached) return cached;

  // L'index part EN MÊME TEMPS que le classement : il est mis en cache six
  // heures, donc il ne coûte rien la plupart du temps, et l'attendre en série
  // ajouterait sa latence à celle du classement.
  const indexPromise = fetchActiveRosterIndex();

  for (const season of [currentSeason(), previousSeason()]) {
    const players = await topPlayersForSeason(season);
    if (players.length > 0) {
      const index    = await indexPromise;
      const filtered = keepActive(players, index);
      // Un classement entier écarté n'est pas un effectif à jour, c'est une
      // anomalie : on rend la liste brute plutôt qu'un écran vide.
      const list = filtered.length > 0 ? filtered : players;
      setCached('players', list, 10 * 60_000);
      return list;
    }
  }
  return [];
}

/** Une saison précise du classement des meneurs. Liste vide = rien reçu. */
async function topPlayersForSeason(season: string): Promise<any[]> {
  const [pointsRes, goalsRes] = await Promise.allSettled([
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
      /** Saison de ces totaux — voir `pickSeasonRow`, même contrat. */
      statsSeason: season,
      lastFive:    [] as number[],
      winImpact:   Math.min(99, Math.round((pts / gp) * 100)),
    };
    const existing = map.get(p.id);
    if (!existing || pts > existing.points) map.set(p.id, entry);
  }

  if (pointsRes.status === 'fulfilled') for (const p of (pointsRes.value?.points ?? [])) merge(p);
  if (goalsRes.status  === 'fulfilled') for (const p of (goalsRes.value?.goals   ?? [])) merge(p);

  return [...map.values()].sort((a, b) => b.points - a.points);
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
    /**
     * Lignes de GARDIEN — `undefined` pour un patineur, et c'est ce qui les
     * distingue en aval.
     *
     * `seasonTotals` les porte depuis toujours ; seul `fetchPlayerById` les
     * lisait, et `fetchTeamRoster` ne les a jamais remontées. Conséquence :
     * l'effectif d'une équipe arrivait au client avec ses gardiens réduits à
     * des lignes de zéros, et rien côté écran ne pouvait proposer un marché
     * d'arrêts sans aller chercher chaque gardien un par un.
     *
     * `shotsAgainst` et `goalsAgainst` plutôt que « arrêts » directement :
     * l'API ne donne pas les arrêts, c'est une soustraction — et la faire ici
     * l'enfermerait, alors que les deux nombres bruts servent aussi au % d'arrêts.
     */
    shotsAgainst: cur.shotsAgainst ?? undefined,
    goalsAgainst: cur.goalsAgainst ?? undefined,
    savePct:      cur.savePctg     ?? undefined,
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

  const data = await fetchNHL<any>(`v1/player/${playerId}/landing`);
  const { cur, statsSeason } = pickSeasonRow(data.seasonTotals);
  const abbr = data.currentTeamAbbrev ?? '';
  const pts  = cur.points ?? 0;
  const gp   = cur.gamesPlayed ?? 1;

  // Tirs bloqués / mises en échec : absents de `landing`, pris sur le rapport
  // `realtime`. L'appel couvre toute la ligue et est mis en cache, donc
  // consulter dix joueurs ne coûte qu'une requête.
  // Un gardien n'y figure pas (rapport « skater ») : la table rend `undefined`,
  // ce qui est correct — un gardien ne bloque pas de tirs au sens de cette
  // statistique.
  const realtime = await fetchSkaterRealtime(statsSeason).catch(() => new Map<string, RealtimeLine>());
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
    /**
     * La saison à laquelle se rapportent TOUS les nombres ci-dessus.
     *
     * En avant-saison, ce n'est pas `currentSeason()` — c'est la dernière
     * saison complète (voir `pickSeasonRow`). L'écran doit l'écrire : « 32 buts »
     * sans année, sur une page qui parle du match de ce soir, se lit comme
     * « 32 buts cette saison ».
     */
    statsSeason,
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
    const mapped = results.map((p: any) => ({
      id:       String(p.playerId ?? p.id),
      name:     p.name ?? [p.firstName, p.lastName].filter(Boolean).join(' '),
      teamId:   (p.teamAbbrev ?? p.teamAbbreviation ?? '').toLowerCase(),
      position: p.positionCode ?? p.position ?? 'F',
      number:   p.sweaterNumber ?? 0,
      goals: 0, assists: 0, points: 0,
      plusMinus: 0, shots: 0, shotPct: 0, ppPoints: 0,
      gamesPlayed: 0, lastFive: [] as number[], winImpact: 0,
    }));
    // `active=true` de la LNH garde aussi les espoirs et les joueurs de ligue
    // mineure : on ne peut pas parier sur eux. L'index des effectifs de la
    // saison en cours est le seul critère qui le dise.
    return keepActive(mapped, await fetchActiveRosterIndex());
  } catch {
    // `fetchTopPlayers` est DÉJÀ filtré sur les effectifs de la saison en
    // cours : le repli hérite du même contrat que le chemin nominal.
    const lower = q.toLowerCase();
    const all   = await fetchTopPlayers();
    return all.filter(p =>
      p.name.toLowerCase().includes(lower) || p.teamId.includes(lower)
    );
  }
}

/** Fetch the full roster for a team (abbr like "EDM") with current-season stats */
/**
 * Effectif d'une équipe, avec la même bascule d'avant-saison que le reste du
 * fichier.
 *
 * `v1/roster/:abbr/:season` se comporte comme le classement des meneurs : pour
 * une saison que la LNH n'a pas encore ouverte, il rend **404**, pas un
 * effectif vide. Aujourd'hui il répond — les effectifs 2026-27 sont publiés —
 * mais la date de publication n'est pas un contrat, et un 404 ici ferait
 * tomber la page d'équipe entière exactement comme le faisait
 * `fetchTopPlayers`.
 *
 * ⚠️ Le repli n'est PAS équivalent ici, et c'est pour ça qu'il est écrit.
 * L'effectif de la saison écoulée n'est pas celui de la saison à venir : des
 * joueurs ont été échangés, d'autres ont pris leur retraite. On le sert quand
 * même parce qu'une liste à un mois près vaut mieux qu'une page morte — mais
 * chaque joueur porte déjà `statsSeason`, qui dit de quelle saison viennent
 * ses totaux, donc l'écran n'a pas à deviner.
 */
async function rosterListFor(upper: string): Promise<any[]> {
  for (const season of [currentSeason(), previousSeason()]) {
    try {
      const d = await fetchNHL<any>(`v1/roster/${upper}/${season}`);
      const players = [
        ...(d.forwards   ?? []),
        ...(d.defensemen ?? []),
        ...(d.goalies    ?? []),
      ];
      if (players.length > 0) return players;
    } catch {
      // 404 d'avant-saison, ou amont momentanément muet : on tente la saison
      // précédente. Un échec sur les DEUX rend une liste vide, que
      // `fetchTeamRoster` ne met pas en cache.
    }
  }
  return [];
}

/** Gardien de l'effectif : identifiant NHL et nom complet (orthographe NHL). */
export interface RosterGoalie { id: number; name: string }

/**
 * Gardiens de l'effectif — UNE requête (`v1/roster`), sans les fiches de
 * statistiques que `fetchTeamRoster` va chercher joueur par joueur. Sert à
 * traduire le gardien partant saisi (un nom) en identifiant NHL, que le service
 * ML apparie à l'état d'inférence (identifiants MoneyPuck = identifiants NHL).
 * Une liste vide n'est pas mise en cache : l'effectif peut être publié plus tard.
 */
export async function fetchTeamGoalies(abbr: string): Promise<RosterGoalie[]> {
  const upper = abbr.toUpperCase();
  const cacheKey = `roster_goalies_${upper}`;
  const cached = getCached<RosterGoalie[]>(cacheKey);
  if (cached) return cached;

  const goalies = (await rosterListFor(upper))
    .filter((p) => (p.positionCode ?? '') === 'G')
    .map((p) => ({
      id:   Number(p.id),
      name: [p.firstName?.default, p.lastName?.default].filter(Boolean).join(' '),
    }))
    .filter((g) => Number.isFinite(g.id) && g.id > 0 && g.name !== '');
  if (goalies.length) setCached(cacheKey, goalies, 6 * 60 * 60_000);
  return goalies;
}

export async function fetchTeamRoster(abbr: string): Promise<any[]> {
  const upper = abbr.toUpperCase();
  const cacheKey = `roster_${upper}`;
  const cached = getCached<any[]>(cacheKey);
  if (cached) return cached;

  const allPlayers = await rosterListFor(upper);
  // Rien reçu : on rend une liste vide SANS la mettre en cache — l'effectif de
  // la saison en cours peut être publié dans l'heure qui suit.
  if (allPlayers.length === 0) return [];

  // Fetch stats for every player in parallel (capped to avoid hammering API)
  // `realtime` part en même temps : un seul appel pour toute l'équipe, qui
  // apporte les tirs bloqués et les mises en échec absents de `landing`.
  const [statsResults, realtime] = await Promise.all([
    Promise.allSettled(
      allPlayers.map(p => fetchNHL<any>(`v1/player/${p.id}/landing`))
    ),
    // Sans argument : saison en cours, à défaut la dernière complète — la
    // même bascule que `pickSeasonRow` fait sur les totaux de chaque joueur.
    fetchSkaterRealtime(),
  ]);

  const out: any[] = [];
  for (let i = 0; i < allPlayers.length; i++) {
    const roster = allPlayers[i];
    const res    = statsResults[i];
    if (res.status === 'rejected') continue;
    const data = res.value as any;
    const { cur, statsSeason } = pickSeasonRow(data.seasonTotals);
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
      /** Saison de ces totaux — la grille de paris l'affiche en en-tête. */
      statsSeason,
      gamesPlayed: gp,
      lastFive:    [] as number[],
      winImpact:   Math.min(99, Math.round((pts / gp) * 100)),
    });
  }

  out.sort((a, b) => b.points - a.points);
  setCached(cacheKey, out, 30 * 60_000); // cache 30 min
  return out;
}
