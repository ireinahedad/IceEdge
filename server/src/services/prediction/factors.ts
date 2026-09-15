/**
 * prediction/factors.ts — décomposition des facteurs d'une prédiction.
 * Point d'entrée public : `../predictionEngine.ts`.
 */

import { fetchPlayerById } from '../nhlApiClient';
import { getTeam } from './scoreModel';

// ── Factor breakdown ──────────────────────────────────────────────────────────

/**
 * Builds a real factor breakdown for the UI.
 * type: 'team' | 'player'
 */
export async function buildRealFactors(
  type: string,
  id: string,
  probability: number
): Promise<any[]> {
  try {
    if (type === 'team') {
      const team = await getTeam(id);
      if (!team) throw new Error('not found');

      // Saison pas commencée : les taux valent `null` depuis `fetchTeams`, et
      // les lire donnerait « Win rate: null% » et un différentiel NaN à l'écran.
      // On dit ce qu'on sait — rien — plutôt que d'afficher des cases vides
      // remplies de valeurs par défaut.
      if ((team.gamesPlayed ?? 0) < 1) {
        return [
          { icon: '📅', label: 'Season not started — no team stats yet', delta: 0 },
          { icon: '📊', label: 'Estimate based on league averages', delta: 0 },
        ];
      }

      const gfDiff = team.goalsForPerGame - team.goalsAgainstPerGame;

      return [
        {
          icon: '📊',
          label: `Win rate: ${team.winPct}% (${team.wins}W-${team.losses}L-${team.otLosses}OTL)`,
          delta: team.winPct >= 58 ? 12 : team.winPct >= 52 ? 5 : team.winPct >= 48 ? 0 : -6,
        },
        {
          icon: '🏒',
          label: `Goal diff: ${gfDiff >= 0 ? '+' : ''}${gfDiff.toFixed(2)}/game`,
          delta: gfDiff >= 0.4 ? 8 : gfDiff >= 0 ? 2 : -5,
        },
        {
          icon: '📈',
          label: `Streak: ${team.streak || 'even'} · ${team.homeRecord} home`,
          delta: team.streak?.startsWith('W') ? 6 : team.streak?.startsWith('L') ? -5 : 0,
        },
        {
          icon: '⚡',
          label: `PP ${team.ppPct}% · PK ${team.pkPct}%`,
          delta: team.ppPct >= 22 ? 5 : team.ppPct >= 18 ? 1 : -3,
        },
      ];
    }

    // player type
    const player = await fetchPlayerById(id);
    const gpg    = player.gamesPlayed > 0 ? player.goals   / player.gamesPlayed : 0;
    const ppg    = player.gamesPlayed > 0 ? player.points  / player.gamesPlayed : 0;
    const spg    = player.gamesPlayed > 0 ? player.shots   / player.gamesPlayed : 0;

    return [
      {
        icon: '🎯',
        label: `Goals/game: ${gpg.toFixed(2)} (${player.goals} total)`,
        delta: gpg >= 0.5 ? 12 : gpg >= 0.3 ? 5 : -3,
      },
      {
        icon: '🏒',
        label: `Points/game: ${ppg.toFixed(2)} (${player.points} pts)`,
        delta: ppg >= 0.9 ? 10 : ppg >= 0.6 ? 4 : -2,
      },
      {
        icon: '📊',
        label: `Shots/game: ${spg.toFixed(1)} · Shot%: ${player.shotPct}%`,
        delta: spg >= 3.5 ? 6 : spg >= 2.5 ? 2 : -2,
      },
      {
        icon: '⚡',
        label: `PP points: ${player.ppPoints} · Assists: ${player.assists}`,
        delta: player.ppPoints >= 20 ? 5 : 0,
      },
    ];
  } catch {
    return [
      { icon: '📊', label: `${type} analysis`, delta: probability >= 55 ? 8 : -5 },
      { icon: '📈', label: 'Recent form', delta: 3 },
      { icon: '🏒', label: 'Matchup context', delta: 0 },
    ];
  }
}
