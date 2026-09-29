/**
 * sync-injuries.ts — Remplir les blessés longue durée depuis la liste PoolExpert.
 *
 *   npm run injuries:sync              → simulation (défaut) : montre ce qui serait écrit
 *   npm run injuries:sync -- --apply   → écrit vraiment dans `long_injuries`
 *
 * Lancé À LA MAIN, depuis le poste du user, les jours de match (rappel par une
 * tâche planifiée à midi, heure de l'Est). Décision du user du 2026-09-29 : ni
 * Railway ni une tâche dans le nuage ne font la lecture.
 *
 * CE QUE ÇA FAIT
 *   1. Lit la PREMIÈRE page de https://www.poolexpert.com/fr/ginjuries.aspx
 *      (≈ 150 notes, les plus récentes), une seule requête. Les pages suivantes
 *      répondent 403 à ce robot (mesuré le 2026-09-30, alors qu'un navigateur
 *      les obtient) : la source les refuse aux robots, on ne les demande donc
 *      pas, et on ne se fait PAS passer pour un navigateur.
 *   2. Pour chaque note : absent ou non, et jusqu'à quand (`classifyNote`). La
 *      note elle-même n'est PAS stockée ; seules la décision et les dates le sont.
 *   3. Retrouve le joueur dans les effectifs LNH (orthographe LNH, celle que
 *      l'écran /dev/saisie propose) et calcule son importance (`computeImpact`).
 *   4. Avec --apply : remplace les entrées AUTOMATIQUES de chaque équipe. Les
 *      entrées saisies à la main et les joueurs retirés à la main ne sont
 *      jamais touchés (`mergeAutoSync`, voir longInjuries.ts). Un joueur absent
 *      de la page lue n'est PAS considéré revenu : sa note est seulement plus
 *      vieille que la page. Son entrée est gardée jusqu'à sa date de fin.
 *
 * CE QUI N'EST PAS ÉCRIT, et listé à la fin : les incertains (au jour le jour,
 * décision avant le match), les notes non reconnues, et les joueurs introuvables
 * dans les effectifs LNH. C'est au collègue de trancher dans /dev/saisie.
 *
 * Écrit dans la base de `DATABASE_URL` (server/.env), comme settle:stuck.
 */

import 'dotenv/config';
import { pool } from '../src/db/connection';
import { setEntry, deleteEntry } from '../src/services/manualData.service';
import { fetchNHL, fetchNHLSearch, currentSeason, TEAM_META } from '../src/services/nhl/core';
import { fetchScheduleAnchor } from '../src/services/nhlApiClient';
import { mapLimit } from '../src/services/concurrency';
import { easternToday } from '../src/services/startingGoalies';
import {
  parseInjuryPage, classifyNote, toNhlAbbr, matchPlayer, searchResultsToRoster, foldSeasons, pickBaseSeason,
  computeImpact, storedName, nameKey, type RawInjury, type RosterPlayer, type NoteVerdict,
} from '../src/services/injurySync';
import { mergeAutoSync, isActiveOn, type LongInjury, type LongInjuryEntry } from '../src/services/longInjuries';

const APPLY = process.argv.includes('--apply');
const SOURCE_URL = 'https://www.poolexpert.com/fr/ginjuries.aspx';
const USER_AGENT = 'IceEdge/1.0 (+https://arakice.com)';
/** En dessous, la mise en page de la source a sûrement changé : on s'arrête. */
const MIN_ROWS = 50;

const pad = (s: string | number, n: number) => String(s).padEnd(n).slice(0, n);

async function fetchPage(page: number): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const url = `${SOURCE_URL}?${page > 1 ? `g=${page}&` : ''}lid=1`;
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`PoolExpert ${res.status} sur la page ${page}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** La première page seulement — voir l'en-tête. `oldest` = date de sa note la plus ancienne. */
async function readSource(): Promise<{ rows: RawInjury[]; oldest: string }> {
  const rows = parseInjuryPage(await fetchPage(1)).rows;
  // Un joueur ne doit compter qu'une fois : on garde sa note la plus récente.
  const latest = new Map<string, RawInjury>();
  for (const r of rows) {
    const k = `${r.player}|${r.team}`;
    const cur = latest.get(k);
    if (!cur || r.date > cur.date) latest.set(k, r);
  }
  return { rows: [...latest.values()], oldest: rows.map((r) => r.date).sort()[0] ?? '' };
}

async function loadRosters(): Promise<RosterPlayer[]> {
  const teams = Object.keys(TEAM_META);
  const perTeam = await mapLimit(teams, 6, async (abbr) => {
    const d = await fetchNHL<any>(`v1/roster/${abbr}/current`);
    return [...(d.forwards ?? []), ...(d.defensemen ?? []), ...(d.goalies ?? [])].map((p: any): RosterPlayer => {
      const firstName = p.firstName?.default ?? '';
      const lastName = p.lastName?.default ?? '';
      return { id: String(p.id), name: `${firstName} ${lastName}`.trim(), firstName, lastName, team: abbr, position: p.positionCode ?? 'C' };
    });
  });
  return perTeam.flat();
}

/**
 * Repli quand l'effectif ne connaît pas le joueur : les effectifs LNH
 * n'incluent pas les blessés. Nom complet d'abord, puis nom de famille seul
 * (diminutifs : « Ben Kindel » est « Benjamin Kindel » pour la source).
 */
async function searchPlayer(name: string, team: string | null) {
  const last = name.trim().split(/\s+/).slice(1).join(' ');
  for (const q of [name, last].filter(Boolean)) {
    try {
      const data = await fetchNHLSearch<any>(`v1/search/player?culture=en-us&limit=20&q=${encodeURIComponent(q)}&active=true`);
      const found = matchPlayer(name, team, searchResultsToRoster(Array.isArray(data) ? data : data?.players ?? []));
      if (found) return { ...found, how: `recherche LNH${found.how === 'nom' ? '' : `, ${found.how}`}` };
    } catch { /* recherche muette : le joueur finit dans « introuvables » */ }
  }
  return null;
}

/**
 * Premier match de saison régulière de chaque équipe : « manquera le match
 * d'ouverture » parle du SIEN, qui peut tomber plusieurs jours après celui de
 * la ligue. Une équipe dont le calendrier ne répond pas retombe sur la ligue.
 */
async function loadTeamOpeners(teams: string[], season: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await mapLimit(teams, 6, async (abbr) => {
    try {
      const d = await fetchNHL<any>(`v1/club-schedule-season/${abbr}/${season}`);
      const first = (d.games ?? []).filter((g: any) => g.gameType === 2).map((g: any) => String(g.gameDate)).sort()[0];
      if (first) out.set(abbr, first);
    } catch { /* repli : le premier match de la ligue */ }
  });
  return out;
}

/** Matchs joués par équipe cette saison — seulement si le classement est bien celui de la saison en cours. */
async function loadTeamGames(season: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const d = await fetchNHL<any>('v1/standings/now');
    for (const s of d.standings ?? []) {
      if (String(s.seasonId) === season) out.set(s.teamAbbrev?.default, Number(s.gamesPlayed) || 0);
    }
  } catch { /* hors saison : aucune base « saison en cours », on prend la précédente */ }
  return out;
}

interface Planned {
  team: string;
  entry: LongInjury;
  position: string;
  basis: string;
  rule: string;
  how: string;
}

async function main() {
  const today = easternToday();
  const anchor = await fetchScheduleAnchor();
  if (!anchor.seasonStart) throw new Error('Date du premier match introuvable (v1/schedule/now) — arrêt.');
  const season = currentSeason();
  const ctx = {
    today,
    opener: anchor.seasonStart,
    seasonEnd: anchor.seasonEnd || `${Number(season.slice(4))}-06-30`,
  };

  console.log(`\nBlessés PoolExpert → long_injuries — ${today} (heure de l'Est)${APPLY ? '' : '  [SIMULATION]'}`);
  const { rows, oldest } = await readSource();
  console.log(`  ${rows.length} joueurs sur la 1re page (notes du ${oldest} à aujourd'hui) · premier match de la saison : ${ctx.opener}`);
  if (rows.length < MIN_ROWS) {
    throw new Error(`Seulement ${rows.length} notes lues : la page a sans doute changé de forme. Rien n'a été écrit.`);
  }

  const known = new Set(Object.keys(TEAM_META));
  const [roster, teamGames, openers] = await Promise.all([
    loadRosters(), loadTeamGames(season), loadTeamOpeners([...known], season),
  ]);

  const counts: Record<NoteVerdict['kind'], number> = { out: 0, available: 0, doubtful: 0, stale: 0, unknown: 0 };
  const doubtful: string[] = [];
  const unknown: string[] = [];
  const notFound: string[] = [];
  const teamConflict: string[] = [];
  const outRows: Array<{ raw: RawInjury; verdict: Extract<NoteVerdict, { kind: 'out' }>; player: RosterPlayer; how: string }> = [];
  // Tous les joueurs qui ont une note sur la page, quelle qu'elle soit : ceux-là
  // ont des nouvelles fraîches, leur entrée auto est remplacée (ou retirée).
  const onPage = new Set<string>();

  // La note la plus récente d'abord : c'est elle qui compte si un joueur en a deux.
  rows.sort((a, b) => b.date.localeCompare(a.date));
  for (const raw of rows) {
    const team = toNhlAbbr(raw.team, known);
    const verdict = classifyNote(raw.note, raw.date, { ...ctx, opener: (team && openers.get(team)) || ctx.opener });
    counts[verdict.kind]++;
    onPage.add(nameKey(raw.player));
    const inRoster = matchPlayer(raw.player, team, roster);
    if (inRoster) onPage.add(nameKey(inRoster.player.name));
    const line = `${pad(raw.team, 4)} ${pad(raw.player, 24)} ${raw.date}  ${raw.note.replace(/\s+/g, ' ').slice(0, 70)}`;
    if (verdict.kind === 'doubtful') doubtful.push(line);
    if (verdict.kind === 'unknown') unknown.push(line);
    if (verdict.kind !== 'out') continue;
    const match = inRoster ?? await searchPlayer(raw.player, team);
    if (!match) { notFound.push(line); continue; }
    onPage.add(nameKey(match.player.name));
    // Trouvé par la recherche (donc dans AUCUN effectif) avec une autre équipe
    // que la source : on ne sait pas laquelle a raison, on n'écrit pas.
    if (match.how.startsWith('recherche') && team && match.player.team !== team) {
      teamConflict.push(`${line}  → LNH : ${match.player.team}`);
      continue;
    }
    outRows.push({ raw, verdict, player: match.player, how: match.how });
  }

  // Statistiques des absents, six requêtes à la fois.
  const landings = await mapLimit(outRows, 6, async (r) => {
    try { return await fetchNHL<any>(`v1/player/${r.player.id}/landing`); } catch { return null; }
  });

  const planned: Planned[] = [];
  const seen = new Set<string>();
  outRows.forEach((r, i) => {
    if (seen.has(r.player.id)) return; // deux notes pour le même joueur : la première (la plus récente) suffit
    seen.add(r.player.id);
    const lines = foldSeasons(landings[i]?.seasonTotals ?? []);
    const base = pickBaseSeason(lines, season);
    // Part des départs : matchs de l'équipe cette saison, sinon une saison complète.
    const games = base?.season === season ? (teamGames.get(r.player.team) ?? 0) : 82;
    const role = r.player.position === 'G' ? 'G' : r.player.position === 'D' ? 'D' : 'F';
    const { impact, basis } = computeImpact(role, base, games);
    planned.push({
      team: r.player.team,
      entry: { player: storedName(r.player.name), impact, since: r.raw.date, until: r.verdict.until, source: 'auto' },
      position: role,
      basis: landings[i] ? basis : 'fiche LNH injoignable',
      rule: r.verdict.rule,
      how: r.how,
    });
  });
  planned.sort((a, b) => a.team.localeCompare(b.team) || b.entry.impact - a.entry.impact);

  console.log(`\nABSENTS (${planned.length}) — ce qui ${APPLY ? 'est' : 'serait'} écrit`);
  for (const p of planned) {
    const moved = p.how.includes('autre équipe') ? '  ⚠ équipe corrigée d\'après la LNH' : '';
    console.log(`  ${pad(p.team, 4)} ${pad(p.entry.player, 24)} ${p.position}  ${p.entry.impact.toFixed(2)}  ${pad(p.basis, 30)} jusqu'au ${p.entry.until}  (${p.rule})${moved}`);
  }
  const section = (title: string, list: string[]) => {
    if (!list.length) return;
    console.log(`\n${title} (${list.length})`);
    for (const l of list) console.log(`  ${l}`);
  };
  section('INCERTAINS — non écrits, à trancher dans /dev/saisie', doubtful);
  section('NOTES NON RECONNUES — non écrites', unknown);
  section('INTROUVABLES DANS LES EFFECTIFS LNH — non écrits', notFound);
  section('ÉQUIPE À VÉRIFIER (la source et la LNH ne disent pas la même) — non écrits', teamConflict);
  console.log(`\nIgnorés : ${counts.stale} notes périmées, ${counts.available} « de retour / prêt ».`);

  // Lecture DIRECTE, pas `mapEntries` : celui-ci rend {} si la base ne répond
  // pas, et on réécrirait alors chaque équipe sans ses entrées manuelles. Lue
  // aussi en simulation, pour montrer ce qui serait gardé et retiré.
  const { rows: dbRows } = await pool.query<{ entry_key: string; payload: LongInjuryEntry }>(
    "SELECT entry_key, payload FROM manual_data WHERE kind = 'long_injuries'",
  );
  const existing = new Map(dbRows.map((r) => [r.entry_key, r.payload]));
  const byTeam = new Map<string, LongInjury[]>();
  for (const p of planned) byTeam.set(p.team, [...(byTeam.get(p.team) ?? []), p.entry]);
  const keepUnseen = (p: LongInjury) => !onPage.has(nameKey(p.player)) && isActiveOn(p, today);

  const keptList: string[] = [];
  const droppedList: string[] = [];
  const nextByTeam = new Map<string, LongInjuryEntry | null>();
  for (const team of new Set([...existing.keys(), ...byTeam.keys()])) {
    const before = existing.get(team) ?? null;
    const next = mergeAutoSync(before, byTeam.get(team) ?? [], keepUnseen);
    nextByTeam.set(team, next);
    const planNames = new Set((byTeam.get(team) ?? []).map((p) => nameKey(p.player)));
    for (const p of before?.players ?? []) {
      if (p.source !== 'auto' || planNames.has(nameKey(p.player))) continue;
      const stays = next?.players.some((q) => nameKey(q.player) === nameKey(p.player));
      (stays ? keptList : droppedList).push(`${pad(team, 4)} ${pad(p.player, 24)} jusqu'au ${p.until ?? '—'}`);
    }
  }
  section('GARDÉS — plus sur la 1re page, date de fin pas encore passée', keptList);
  section('RETIRÉS — nouvelle note de retour/incertitude, ou date de fin passée', droppedList);

  if (!APPLY) {
    console.log('\nRien n\'a été écrit. Relancer avec -- --apply pour écrire.\n');
    return;
  }

  let written = 0;
  let cleared = 0;
  for (const [team, next] of nextByTeam) {
    const before = existing.get(team) ?? null;
    if (JSON.stringify(next) === JSON.stringify(before)) continue;
    if (next) { await setEntry('long_injuries', team, next, null); written++; }
    else { await deleteEntry('long_injuries', team); cleared++; }
  }
  console.log(`\nÉcrit : ${written} équipe(s) mise(s) à jour, ${cleared} ligne(s) vidée(s). Visible sur le site d'ici 90 s.\n`);
}

main()
  .catch((err) => { console.error('[injuries:sync]', err?.message ?? err); process.exitCode = 1; })
  .finally(() => pool.end());
