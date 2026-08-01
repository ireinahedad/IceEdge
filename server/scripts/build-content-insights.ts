/**
 * build-content-insights.ts
 *
 * Produit les CSV « content insight » qui alimentent les graphiques et les
 * scripts vidéo du content engine (voir `content/HANDOFF.md`).
 *
 * D'OÙ VIENNENT LES DONNÉES
 *
 * De l'app, pas de l'API NHL. Le script tape `/api/nhl/...` sur l'instance qui
 * tourne déjà : mêmes endpoints que la page Charts, donc mêmes caches (30 min
 * côté serveur) et même déduplication des requêtes en vol. Conséquence
 * concrète : si tu as consulté la page Charts dans la journée, la plupart des
 * appels ne repartent pas vers la NHL du tout. Refaire les fetchs en direct
 * doublerait la charge upstream pour un résultat identique.
 *
 * CE QU'ON ÉCRIT
 *
 * Du CSV plat, une ligne par entité, uniquement les colonnes exploitables — pas
 * de JSON imbriqué. Un CSV se jette dans n'importe quel outil de graphique,
 * s'ouvre dans Excel, et se lit tel quel dans un prompt. Les classements ne sont
 * pas pré-calculés : trier une colonne suffit, et ça évite de figer dans le
 * fichier des « top 10 » qui ne servent qu'une fois.
 *
 * FENÊTRE DE DONNÉES — la règle du projet
 *
 *   player / goalie / team / matchup → saison en cours + précédente, point.
 *   advanced                         → SEUL fichier autorisé à remonter (6 saisons).
 *
 * Elle est appliquée ici, dans le code, plutôt que laissée à la vigilance de qui
 * rédige le prompt : une stat de 2019 dans une vidéo de janvier 2026 est fausse
 * au sens éditorial même si elle est exacte au sens factuel.
 *
 * COUVERTURE
 *
 * Les 32 alignements complets — ~740 patineurs, ~65 gardiens — et non le top 100
 * de la ligue. Les profils de niche (4e trio, unité de désavantage numérique,
 * homme de mises au jeu, recrue à 12 matchs) sont précisément ceux dont personne
 * ne parle, donc ceux qui portent le mieux une vidéo.
 *
 * Usage (depuis server/, l'app doit tourner) :
 *   npm run content:insights                    → les 5 CSV
 *   npm run content:insights -- --only=team,matchup
 *   npm run content:insights -- --api=http://localhost:3001/api
 */

import { promises as fs } from 'fs';
import path from 'path';

// --- Destination -----------------------------------------------------------
// Résolue depuis __dirname et jamais depuis un argument : le script n'écrit que
// dans content/data/, quoi qu'on lui passe en ligne de commande.
const OUT_DIR = path.resolve(__dirname, '..', '..', 'content', 'data');

// --- Accès à l'app ---------------------------------------------------------

const DEFAULT_API = `http://localhost:${process.env.PORT || 3001}/api`;

let API_BASE = DEFAULT_API;

/**
 * Un GET sur l'app. Les 429 sont attendus (apiLimiter : 60 s glissantes) et
 * méritent une attente, pas un abandon : un lot de ~130 requêtes passe sous la
 * limite dev, pas forcément sous une limite de prod.
 */
async function api<T>(pathname: string, attempt = 0): Promise<T> {
  const url = `${API_BASE}/nhl${pathname}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });

  if (res.status === 429 && attempt < 4) {
    const wait = Number(res.headers.get('retry-after')) * 1000 || 15_000;
    console.log(`    (429 — pause ${wait / 1000}s)`);
    await new Promise((r) => setTimeout(r, wait));
    return api<T>(pathname, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

/** Vérifie que l'app répond avant de lancer 130 requêtes contre le vide. */
async function assertAppReachable() {
  try {
    await api('/teams');
  } catch (e: any) {
    throw new Error(
      `L'app ne répond pas sur ${API_BASE}.\n` +
      `  Démarre-la (cd server && npm run dev) ou passe --api=<url>.\n` +
      `  Détail : ${e.message}`,
    );
  }
}

// --- Saisons ---------------------------------------------------------------
// Duplication assumée de la fonction privée `currentSeason()` de
// nhlApiClient.ts : l'exporter changerait la surface publique d'un module de
// production pour un besoin d'outillage. 4 lignes à garder synchronisées.
function currentSeason(): string {
  const now = new Date();
  const year = now.getMonth() >= 9 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}${year + 1}`;
}
function previousSeason(season: string): string {
  const start = Number(season.slice(0, 4)) - 1;
  return `${start}${start + 1}`;
}

// --- CSV -------------------------------------------------------------------

type Row = Record<string, string | number | null | undefined>;

/**
 * Sérialise en CSV RFC 4180. Les guillemets ne sont posés que sur les valeurs
 * qui en ont besoin : un fichier majoritairement numérique reste lisible à
 * l'œil et se charge sans réglage dans un tableur.
 */
function toCsv(columns: string[], rows: Row[]): string {
  const cell = (v: unknown) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

async function writeCsv(name: string, columns: string[], rows: Row[]) {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const csv = toCsv(columns, rows);
  await fs.writeFile(path.join(OUT_DIR, name), csv, 'utf8');
  console.log(`  ✔ ${name}  ${rows.length} lignes, ${(Buffer.byteLength(csv) / 1024).toFixed(0)} ko`);
  return { file: name, rows: rows.length, columns: columns.length };
}

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const div = (a: number, b: number, d = 3) => (b > 0 ? round(a / b, d) : null);

/**
 * Concurrence bornée. L'app encaisse mieux 4 requêtes en vol que 32, et un
 * échec isolé ne doit pas faire tomber le lot : on préfère un CSV amputé d'une
 * équipe à pas de CSV du tout.
 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const out: Array<{ item: T; value: R | null }> = [];
  let cursor = 0;
  const failures: string[] = [];

  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        out[i] = { item: items[i], value: await fn(items[i]) };
      } catch (e: any) {
        out[i] = { item: items[i], value: null };
        failures.push(`${String(items[i])}: ${e.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failures.length) {
    console.log(`    ⚠ ${failures.length} échec(s) ignoré(s) — ex. ${failures[0]}`);
  }
  return out;
}

// --- Seuil de pertinence ---------------------------------------------------
//
// Un leader de % de tirs à 3 matchs joués n'est pas un sujet de vidéo, c'est un
// artefact d'échantillon. Le seuil suit l'avancement de la saison : en octobre
// il ne bloque presque rien, en mars il élimine les remplaçants.
function minGamesFor(leagueMaxGp: number, floor: number): number {
  return Math.max(floor, Math.round(leagueMaxGp * 0.3));
}

// ===========================================================================
// Rosters — la source commune de player / goalie / advanced
// ===========================================================================
//
// POURQUOI PAS `/players/leaders`
//
// La première version tirait le top 100 de la ligue par points. Ça couvrait les
// premiers trios et rien d'autre : pas de spécialiste du désavantage numérique,
// pas de 4e trio, pas d'homme de mises au jeu, pas de recrue à 12 matchs. Or ce
// sont exactement les profils dont personne ne parle, donc ceux qui ont le plus
// de valeur en contenu. Et `limit` est plafonné à 100 côté serveur : élargir par
// là demandait d'empiler des requêtes triées sur des métriques différentes, avec
// une couverture qui reste arbitraire.
//
// `/teams/:abbr/player-seasons` donne les 32 alignements complets — ~740
// patineurs, ~65 gardiens, tout le monde. Et c'est déjà la source de
// `advanced.csv` : les deux fichiers partagent le même fetch et le même cache,
// donc élargir la couverture ne coûte rien de plus quand on génère les deux.
//
// Limite connue : c'est l'alignement du JOUR. Un joueur échangé apparaît sous sa
// nouvelle équipe (avec ses totaux consolidés, `fetchTeamPlayerSeasons` replie
// les saisons scindées), et un joueur qui a quitté la ligue en cours de saison
// n'apparaît pas. Pour du contenu sur la forme actuelle, c'est le bon cadrage.

async function fetchRosters(abbrs: string[]) {
  const res = await mapLimit(abbrs, 2, (a) => api<any>(`/teams/${a}/player-seasons`));
  return res.filter((r) => r.value).map((r) => ({ team: r.item, data: r.value }));
}

type Rosters = Awaited<ReturnType<typeof fetchRosters>>;

/** La ligne d'une saison précise dans le tableau renvoyé par player-seasons. */
const seasonRow = (p: any, seasonId: string) =>
  (p.seasons ?? []).find((s: any) => String(s.seasonId) === seasonId) ?? null;

// ===========================================================================
// player.csv / goalie.csv — forme actuelle vs saison précédente
// ===========================================================================
//
// Une ligne par joueur, les deux saisons côte à côte. Ce format donne
// directement les deux graphiques qu'on veut : barres triées sur `ppg_delta`,
// et nuage `prev_ppg` vs `ppg` (la diagonale = joueurs stables).
//
// Le rythme (points par match) est la colonne qui compte, pas le total : un
// joueur blessé 20 matchs n'est pas « en baisse », il a moins joué.

const PLAYER_COLUMNS = [
  'season', 'player_id', 'name', 'team', 'position', 'number',
  'gp', 'goals', 'assists', 'points', 'ppg',
  'shots', 'shooting_pct', 'pp_points', 'pp_goals', 'sh_points',
  'plus_minus', 'pim', 'faceoff_pct', 'avg_toi',
  'prev_gp', 'prev_points', 'prev_ppg', 'prev_avg_toi',
  'ppg_delta', 'ppg_delta_pct', 'toi_delta',
  'above_min_gp', 'is_rookie',
];

const GOALIE_COLUMNS = [
  'season', 'player_id', 'name', 'team', 'number',
  'gp', 'wins', 'losses', 'ot_losses', 'shutouts', 'save_pct', 'gaa',
  'prev_gp', 'prev_wins', 'prev_save_pct', 'prev_gaa',
  'save_pct_delta', 'gaa_delta', 'above_min_gp', 'is_rookie',
];

function buildPlayers(
  rosters: Rosters,
  seasons: { current: string; previous: string },
  leagueMaxGp: number,
) {
  const minGp = minGamesFor(leagueMaxGp, 5);
  const goalieMinGp = minGamesFor(leagueMaxGp, 3);

  const rows: Row[] = [];
  const goalieRows: Row[] = [];

  for (const { team, data } of rosters) {
    for (const p of data.skaters ?? []) {
      const s = seasonRow(p, seasons.current);
      // Pas de ligne cette saison = rien à dire sur sa forme actuelle. C'est le
      // seul filtre : tout joueur ayant disputé un match est inclus, même à
      // 4 matchs — `above_min_gp` sert à l'écarter d'un graphique au besoin.
      if (!s) continue;
      const q = seasonRow(p, seasons.previous);
      const ppg = div(s.points, s.gp);
      const ppgPrev = q ? div(q.points, q.gp) : null;
      rows.push({
        season: seasons.current,
        player_id: p.id, name: p.name, team, position: p.position, number: p.number,
        gp: s.gp, goals: s.goals, assists: s.assists, points: s.points, ppg,
        shots: s.shots, shooting_pct: s.shootingPct,
        pp_points: s.ppPoints, pp_goals: s.powerPlayGoals, sh_points: s.shorthandedPoints,
        plus_minus: s.plusMinus, pim: s.pim, faceoff_pct: s.faceoffPct, avg_toi: s.avgToi,
        prev_gp: q?.gp ?? null,
        prev_points: q?.points ?? null,
        prev_ppg: ppgPrev,
        prev_avg_toi: q?.avgToi ?? null,
        ppg_delta: ppg != null && ppgPrev != null ? round(ppg - ppgPrev, 3) : null,
        ppg_delta_pct:
          ppg != null && ppgPrev != null && ppgPrev > 0
            ? round(((ppg - ppgPrev) / ppgPrev) * 100, 1)
            : null,
        // Le temps de jeu bouge avant les points : un joueur qui gagne 3 minutes
        // par match est une histoire avant même que la production suive.
        toi_delta:
          s.avgToi != null && q?.avgToi != null ? round(s.avgToi - q.avgToi, 2) : null,
        // Colonne plutôt que filtre : le seuil écarte les artefacts d'échantillon
        // dans un graphique, mais la ligne reste là si tu veux justement parler
        // d'un joueur peu utilisé.
        above_min_gp: (s.gp ?? 0) >= minGp ? 1 : 0,
        // Aucune saison NHL antérieure dans l'historique renvoyé.
        is_rookie: (p.seasons ?? []).length <= 1 ? 1 : 0,
      });
    }

    for (const p of data.goalies ?? []) {
      const s = seasonRow(p, seasons.current);
      if (!s) continue;
      const q = seasonRow(p, seasons.previous);
      goalieRows.push({
        season: seasons.current,
        player_id: p.id, name: p.name, team, number: p.number,
        gp: s.gp, wins: s.wins, losses: s.losses, ot_losses: s.otLosses,
        shutouts: s.shutouts, save_pct: s.savePct, gaa: s.gaa,
        prev_gp: q?.gp ?? null, prev_wins: q?.wins ?? null,
        prev_save_pct: q?.savePct ?? null, prev_gaa: q?.gaa ?? null,
        save_pct_delta:
          s.savePct != null && q?.savePct != null ? round(s.savePct - q.savePct, 3) : null,
        // Négatif = amélioration : la moyenne de buts alloués baisse.
        gaa_delta: s.gaa != null && q?.gaa != null ? round(s.gaa - q.gaa, 2) : null,
        above_min_gp: (s.gp ?? 0) >= goalieMinGp ? 1 : 0,
        is_rookie: (p.seasons ?? []).length <= 1 ? 1 : 0,
      });
    }
  }

  return { rows, goalieRows };
}

// ===========================================================================
// team.csv — 32 lignes, écarts saison/saison + splits
// ===========================================================================

const TEAM_COLUMNS = [
  'season', 'team', 'name', 'gp', 'wins', 'losses', 'ot_losses', 'points', 'point_pct',
  'gf', 'ga', 'goal_diff', 'gf_per_game', 'ga_per_game',
  'shots_for_per_game', 'shots_against_per_game', 'pp_pct', 'pk_pct', 'faceoff_pct',
  'prev_point_pct', 'prev_gf_per_game', 'prev_ga_per_game', 'prev_pp_pct', 'prev_pk_pct',
  'point_pct_delta', 'gf_per_game_delta', 'ga_per_game_delta', 'pp_pct_delta', 'pk_pct_delta',
  'home_w', 'home_l', 'home_otl', 'away_w', 'away_l', 'away_otl',
  'last10_w', 'last10_l', 'last10_otl', 'one_goal_w', 'one_goal_l', 'one_goal_otl',
  'streak',
];

async function buildTeams(
  seasons: { current: string; previous: string },
  league: any,
  abbrs: string[],
) {
  const prevLeague = await api<any>(`/teams/season-summary?season=${seasons.previous}`);
  const prevByAbbr = new Map<string, any>(prevLeague.teams.map((t: any) => [t.abbr, t]));

  // season-official sert deux fichiers : les splits (team) et les
  // confrontations (matchup). Un seul passage, on découpe après.
  const officialCur = await mapLimit(abbrs, 4, (a) =>
    api<any>(`/teams/${a}/season-official/${seasons.current}`));
  const officialByAbbr = new Map<string, any>(
    officialCur.filter((r) => r.value).map((r) => [r.item, r.value]),
  );

  const delta = (a?: number | null, b?: number | null) =>
    a != null && b != null ? round(a - b, 2) : null;

  const rows: Row[] = league.teams.map((t: any) => {
    const p = prevByAbbr.get(t.abbr) ?? null;
    const rec = officialByAbbr.get(t.abbr)?.record ?? null;
    return {
      season: seasons.current,
      team: t.abbr, name: t.name,
      gp: t.gamesPlayed, wins: t.wins, losses: t.losses, ot_losses: t.otLosses,
      points: t.points, point_pct: t.pointPct,
      gf: t.goalsFor, ga: t.goalsAgainst, goal_diff: t.goalDiff,
      gf_per_game: t.goalsForPerGame, ga_per_game: t.goalsAgainstPerGame,
      shots_for_per_game: t.shotsForPerGame, shots_against_per_game: t.shotsAgainstPerGame,
      pp_pct: t.ppPct, pk_pct: t.pkPct, faceoff_pct: t.faceoffPct,
      prev_point_pct: p?.pointPct ?? null,
      prev_gf_per_game: p?.goalsForPerGame ?? null,
      prev_ga_per_game: p?.goalsAgainstPerGame ?? null,
      prev_pp_pct: p?.ppPct ?? null,
      prev_pk_pct: p?.pkPct ?? null,
      point_pct_delta:   delta(t.pointPct,           p?.pointPct),
      gf_per_game_delta: delta(t.goalsForPerGame,     p?.goalsForPerGame),
      // Négatif = progression : l'équipe encaisse moins qu'avant.
      ga_per_game_delta: delta(t.goalsAgainstPerGame, p?.goalsAgainstPerGame),
      pp_pct_delta:      delta(t.ppPct,               p?.ppPct),
      pk_pct_delta:      delta(t.pkPct,               p?.pkPct),
      home_w: rec?.home?.w ?? null, home_l: rec?.home?.l ?? null, home_otl: rec?.home?.otl ?? null,
      away_w: rec?.away?.w ?? null, away_l: rec?.away?.l ?? null, away_otl: rec?.away?.otl ?? null,
      last10_w: rec?.last10?.w ?? null, last10_l: rec?.last10?.l ?? null, last10_otl: rec?.last10?.otl ?? null,
      one_goal_w: rec?.oneGoal?.w ?? null, one_goal_l: rec?.oneGoal?.l ?? null, one_goal_otl: rec?.oneGoal?.otl ?? null,
      streak: rec?.streak ?? null,
    };
  });

  return { rows, officialByAbbr };
}

// ===========================================================================
// matchup.csv — une ligne par paire (équipe, adversaire)
// ===========================================================================
//
// Format long : c'est ce qui permet de filtrer sur `team` ou de faire une
// heatmap 32×32 sans retoucher le fichier.
//
// Une paire se joue 3-4 fois par saison : sur une seule saison l'échantillon
// est trop mince pour être racontable. Sur deux, on atteint 6-8 matchs et une
// domination devient un fait. Les colonnes `combined_*` sont là pour ça — et
// c'est aussi pourquoi on ne va pas plus loin que deux saisons.

const MATCHUP_COLUMNS = [
  'team', 'opponent',
  'gp', 'wins', 'losses', 'ot_losses', 'gf', 'ga',
  'prev_gp', 'prev_wins', 'prev_losses', 'prev_ot_losses', 'prev_gf', 'prev_ga',
  'combined_gp', 'combined_wins', 'combined_win_pct',
  'combined_gf_per_game', 'combined_ga_per_game',
];

async function buildMatchups(
  seasons: { current: string; previous: string },
  abbrs: string[],
  officialByAbbr: Map<string, any>,
) {
  const officialPrev = await mapLimit(abbrs, 4, (a) =>
    api<any>(`/teams/${a}/season-official/${seasons.previous}`));
  const prevByAbbr = new Map<string, any>(
    officialPrev.filter((r) => r.value).map((r) => [r.item, r.value]),
  );

  const rows: Row[] = [];
  for (const team of abbrs) {
    const c = officialByAbbr.get(team)?.vsOpponent ?? {};
    const p = prevByAbbr.get(team)?.vsOpponent ?? {};
    for (const opp of [...new Set([...Object.keys(c), ...Object.keys(p)])].sort()) {
      const a = c[opp] ?? null;
      const b = p[opp] ?? null;
      const gp = (a?.gp ?? 0) + (b?.gp ?? 0);
      const wins = (a?.wins ?? 0) + (b?.wins ?? 0);
      const gf = (a?.goalsFor ?? 0) + (b?.goalsFor ?? 0);
      const ga = (a?.goalsAgainst ?? 0) + (b?.goalsAgainst ?? 0);
      rows.push({
        team, opponent: opp,
        gp: a?.gp ?? 0, wins: a?.wins ?? 0, losses: a?.losses ?? 0,
        ot_losses: a?.otLosses ?? 0, gf: a?.goalsFor ?? 0, ga: a?.goalsAgainst ?? 0,
        prev_gp: b?.gp ?? 0, prev_wins: b?.wins ?? 0, prev_losses: b?.losses ?? 0,
        prev_ot_losses: b?.otLosses ?? 0, prev_gf: b?.goalsFor ?? 0, prev_ga: b?.goalsAgainst ?? 0,
        combined_gp: gp, combined_wins: wins,
        combined_win_pct: div(wins, gp),
        combined_gf_per_game: div(gf, gp, 2),
        combined_ga_per_game: div(ga, gp, 2),
      });
    }
  }
  return rows;
}

// ===========================================================================
// advanced.csv — LE SEUL fichier au-delà de 2 saisons
// ===========================================================================
//
// Format long (une ligne par joueur ET par saison) : c'est le format natif
// d'une courbe temporelle. En format large, ajouter une saison changerait les
// colonnes et casserait les graphiques existants.
//
// Réservé aux analyses de fond — trajectoires de carrière, saisons-sommet.
// Ne pas y puiser pour un contenu « forme actuelle ».

const ADVANCED_COLUMNS = [
  'player_id', 'name', 'team', 'position', 'season',
  'gp', 'goals', 'assists', 'points', 'ppg', 'shots', 'shooting_pct', 'avg_toi',
  'is_current_season', 'is_career_best_ppg', 'ppg_vs_career_best',
];

function buildAdvanced(rosters: Rosters, seasons: { current: string; previous: string }) {
  const rows: Row[] = [];
  for (const { team, data } of rosters) {
    for (const p of data.skaters ?? []) {
      const seasonRows = (p.seasons ?? []).filter((s: any) => (s.gp ?? 0) > 0);
      if (seasonRows.length < 3) continue; // pas de trajectoire sans historique

      const withPpg = seasonRows.map((s: any) => ({ ...s, ppg: div(s.points, s.gp) ?? 0 }));
      const bestPpg = Math.max(...withPpg.map((s: any) => s.ppg));

      for (const s of withPpg) {
        rows.push({
          player_id: p.id, name: p.name, team, position: p.position,
          season: s.seasonId,
          gp: s.gp, goals: s.goals, assists: s.assists, points: s.points, ppg: s.ppg,
          shots: s.shots, shooting_pct: s.shootingPct, avg_toi: s.avgToi,
          is_current_season: String(s.seasonId) === seasons.current ? 1 : 0,
          is_career_best_ppg: s.ppg === bestPpg ? 1 : 0,
          ppg_vs_career_best: round(s.ppg - bestPpg, 3),
        });
      }
    }
  }
  return rows;
}

// ===========================================================================
// Entrée
// ===========================================================================

async function main() {
  const args = process.argv.slice(2);
  const apiArg = args.find((a) => a.startsWith('--api='));
  if (apiArg) API_BASE = apiArg.slice('--api='.length).replace(/\/+$/, '');

  const onlyArg = args.find((a) => a.startsWith('--only='));
  const only = onlyArg
    ? new Set(onlyArg.slice('--only='.length).split(',').map((s) => s.trim()))
    : null;
  // Plus de flag `--advanced` : il partage désormais le fetch des alignements
  // avec `player`, donc l'exclure ne fait plus rien économiser. Tout est généré
  // par défaut ; `--only=` reste là pour régénérer un fichier isolé.
  const want = (name: string) => (only ? only.has(name) : true);

  const current = currentSeason();
  const seasons = { current, previous: previousSeason(current) };

  console.log('\nICEEDGE — content insights');
  console.log(`  source  : ${API_BASE}/nhl  (caches de l'app)`);
  console.log(`  saisons : ${seasons.previous} → ${seasons.current}`);
  console.log(`  sortie  : ${OUT_DIR}\n`);

  await assertAppReachable();

  // Un seul appel, il sert à trois choses : la liste des équipes, l'avancement
  // de la saison (donc les seuils du fichier joueur) et les lignes de team.csv.
  const league = await api<any>(`/teams/season-summary?season=${seasons.current}`);
  const abbrs: string[] = league.teams.map((t: any) => t.abbr);
  const leagueMaxGp = Math.max(0, ...league.teams.map((t: any) => t.gamesPlayed ?? 0)) || 82;

  const written: any[] = [];
  let officialByAbbr = new Map<string, any>();

  if (want('team') || want('matchup')) {
    console.log('  … équipes');
    const t = await buildTeams(seasons, league, abbrs);
    officialByAbbr = t.officialByAbbr;
    if (want('team')) written.push(await writeCsv('content_insight_team.csv', TEAM_COLUMNS, t.rows));
  }

  if (want('matchup')) {
    console.log('  … confrontations');
    const rows = await buildMatchups(seasons, abbrs, officialByAbbr);
    written.push(await writeCsv('content_insight_matchup.csv', MATCHUP_COLUMNS, rows));
  }

  // Un seul passage sur les 32 alignements, trois fichiers en sortie. C'est ce
  // qui rend la couverture complète abordable : `advanced` ne coûte plus rien
  // de plus dès lors que `player` est demandé, et inversement.
  if (want('player') || want('advanced')) {
    console.log('  … alignements (32 équipes, le poste le plus long)');
    const rosters = await fetchRosters(abbrs);
    console.log(`    ${rosters.length}/32 équipes récupérées`);

    if (want('player')) {
      const p = buildPlayers(rosters, seasons, leagueMaxGp);
      written.push(await writeCsv('content_insight_player.csv', PLAYER_COLUMNS, p.rows));
      written.push(await writeCsv('content_insight_goalie.csv', GOALIE_COLUMNS, p.goalieRows));
    }
    if (want('advanced')) {
      written.push(await writeCsv(
        'content_insight_advanced.csv', ADVANCED_COLUMNS, buildAdvanced(rosters, seasons)));
    }
  }

  // Le seul JSON du lot, et il ne contient pas de données : de quoi savoir, en
  // lisant un CSV six semaines plus tard, de quand il date et jusqu'où il a le
  // droit d'aller. Sans ça la règle de fenêtre n'existe que dans ce fichier .ts.
  await fs.writeFile(
    path.join(OUT_DIR, 'content_insight_meta.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: `${API_BASE}/nhl`,
        seasons: { current: Number(seasons.current), previous: Number(seasons.previous) },
        window: {
          'content_insight_player.csv':   'saison en cours + précédente',
          'content_insight_goalie.csv':   'saison en cours + précédente',
          'content_insight_team.csv':     'saison en cours + précédente',
          'content_insight_matchup.csv':  'saison en cours + précédente',
          'content_insight_advanced.csv': 'EXCEPTION — jusqu\'à 6 saisons, analyses de fond uniquement',
        },
        files: written,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  console.log('\n  terminé.\n');
  process.exit(0);
}

main().catch((e) => { console.error(`\n${e.message}\n`); process.exit(1); });
