/**
 * slipCommandContext.ts — le contexte de l'analyseur de commandes, construit
 * CÔTÉ SERVEUR pour valider ce que rend le LLM (`parse_bet_command`).
 *
 * Mêmes sources et même fenêtre que le client (`useSlipCommandData`) :
 *   - jour LNH : `fetchScheduleAnchor` (route `/schedule/anchor`) ;
 *   - matchs non terminés des 14 jours suivants : `fetchGamesRange`
 *     (route `/games/range`) ;
 *   - joueurs : `fetchTopPlayers` (route `/players`), réduits aux équipes qui
 *     jouent dans la fenêtre ;
 *   - lignes : `MARKET_LINES`, la source partagée avec l'écran.
 *
 * Le serveur ne croit donc RIEN du client : ni la liste des matchs, ni les
 * joueurs, ni les lignes permises. Une intention du LLM n'est transmise que si
 * elle tient contre ce contexte-ci.
 */

import { fetchGamesRange, fetchScheduleAnchor, fetchTopPlayers } from './nhlApiClient';
import { MARKET_LINES } from './marketLines';
import type { SlipContext } from './slipCommand';

/** Même fenêtre que `UPCOMING_DAYS` côté client (`predictionShared.tsx`). */
export const SLIP_WINDOW_DAYS = 14;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export async function buildServerSlipContext(): Promise<SlipContext> {
  const anchor = await fetchScheduleAnchor().catch(() => null);
  const today = anchor?.today && ISO_DATE.test(anchor.today) ? anchor.today : new Date().toISOString().slice(0, 10);

  const [rawGames, rawPlayers] = await Promise.all([
    fetchGamesRange(today, addDays(today, SLIP_WINDOW_DAYS)),
    fetchTopPlayers(),
  ]);

  const games = (rawGames as any[])
    .filter((g) => g?.status !== 'final')
    .map((g) => ({
      id: String(g.id),
      homeAbbr: String(g.homeTeam?.abbreviation ?? '').toUpperCase(),
      awayAbbr: String(g.awayTeam?.abbreviation ?? '').toUpperCase(),
      date: String(g.gameDate ?? '').slice(0, 10),
      startTime: g.startTime,
    }))
    .filter((g) => g.homeAbbr && g.awayAbbr && ISO_DATE.test(g.date));

  const playing = new Set(games.flatMap((g) => [g.homeAbbr, g.awayAbbr]));
  const players = (rawPlayers as any[])
    .map((p) => ({
      id: String(p.id),
      name: String(p.name ?? p.fullName ?? ''),
      // Même lecture que `toUIPlayer` côté client : `teamAbbr`, sinon `teamId`
      // (l'abréviation en minuscules que rend `fetchTopPlayers`).
      teamAbbr: String(p.teamAbbr ?? p.teamId ?? '').toUpperCase(),
      position: p.position ? String(p.position) : undefined,
    }))
    .filter((p) => p.name && playing.has(p.teamAbbr));

  return { today, games, players, lines: MARKET_LINES };
}
