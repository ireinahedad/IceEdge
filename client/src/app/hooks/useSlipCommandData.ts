/**
 * useSlipCommandData.ts — ce que l'analyseur de commandes du coupon doit savoir.
 *
 * Chargé à l'ouverture de la feuille seulement (le hook vit dans la feuille) :
 * un appel `/schedule/anchor` + un appel `/games/range` sur 14 jours, les
 * joueurs venant de `useNHLData` (déjà en mémoire partagée).
 *
 * Seuls les joueurs des équipes qui jouent dans la fenêtre sont passés à
 * l'analyseur : un nom de famille ne doit être unique que parmi eux.
 */

import { useEffect, useMemo, useState } from "react";
import type { SlipContext } from "../../../../server/src/services/slipCommand";
import { fetchUpcomingWindow } from "../pages/prediction/predictionShared";
import { MARKET_LINES } from "../../../../server/src/services/marketLines";
import type { SlipCommandData } from "../services/slipCommandLegs";
import { useNHLData } from "./useNHLData";
import type { NHLGame } from "../types/bet";

export interface SlipCommandState {
  /** `null` tant que le calendrier ou les joueurs chargent. */
  ctx: SlipContext | null;
  data: SlipCommandData;
  loading: boolean;
  error: boolean;
}

export function useSlipCommandData(): SlipCommandState {
  const { players, getTeamById, loading: nhlLoading } = useNHLData();
  const [win, setWin] = useState<{ today: string; games: NHLGame[] } | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchUpcomingWindow()
      .then((w) => { if (alive) setWin(w); })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, []);

  const ctx = useMemo<SlipContext | null>(() => {
    if (!win || (nhlLoading && players.length === 0)) return null;
    const games = win.games.map((g) => ({
      id: String(g.id),
      homeAbbr: (g.homeTeam.abbreviation ?? "").toUpperCase(),
      awayAbbr: (g.awayTeam.abbreviation ?? "").toUpperCase(),
      date: g.gameDate,
      startTime: g.startTime,
    }));
    const playing = new Set(games.flatMap((g) => [g.homeAbbr, g.awayAbbr]));
    return {
      today: win.today,
      games,
      players: players
        .filter((p) => playing.has(p.teamId.toUpperCase()))
        .map((p) => ({ id: p.id, name: p.name, teamAbbr: p.teamId.toUpperCase(), position: p.position })),
      lines: MARKET_LINES,
    };
  }, [win, players, nhlLoading]);

  const data = useMemo<SlipCommandData>(
    () => ({ games: win?.games ?? [], players, getTeamById }),
    [win, players, getTeamById],
  );

  return { ctx, data, loading: !error && ctx === null, error };
}
