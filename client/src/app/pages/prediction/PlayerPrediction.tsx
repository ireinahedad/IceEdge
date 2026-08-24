/**
 * PlayerPrediction.tsx
 *
 * Extrait de PredictionPage.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { useEffect, useState, useMemo } from "react";
import { useSearchParams } from "react-router";
import { nhlApiService } from "../../services/nhlApiService";
import { useSport } from "../../context/SportContext";
import { nhlLogoUrl } from "../../data/teamEmoji";
import { MarketGroup, PredictionsRevealBar } from "./PredictionSheet";
import { BetOpt, MktGroup, RuleFactor } from "./gameMarkets";
import { GameSelector, LoadingSkeleton, NotFound, RecentFormCard, RevealMode, RevealModeCtx, generateForm, useSelectedGame, useUpcomingGames } from "./predictionShared";


/* ─── Player Prediction ──────────────────────── */
export function PlayerPrediction({ playerId }: { playerId: string }) {
  const { theme } = useSport();
  const accent = theme.accent;
  const [data, setData] = useState<{
    name: string; team: string; logo: string; position: string; number: number;
    goals: number; assists: number; points: number; plusMinus: number;
    gamesPlayed: number; goalsPerGame: number; assistsPerGame: number;
    ptsPerGame: number; ppPoints: number; shots: number; hits: number;
    blocks: number; toi: number; faceoffPct: number; penaltyMin: number;
  } | null>(null);
  const [apiGroups, setApiGroups] = useState<MktGroup[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [revealMode, setRevealMode] = useState<RevealMode>("rules");

  // Which game these props are for. Defaults to the player's next game and is
  // switchable from the dropdown; a `?game=` param (e.g. arriving from that
  // game's page) wins. Bets carry the id so they can be auto-settled — see
  // settlementFields().
  const [searchParams] = useSearchParams();
  const games = useUpcomingGames(data?.team || undefined, searchParams.get("game") ?? undefined);
  const { selected: selectedGame, select: selectGame } = useSelectedGame(games);
  const playerGameId = selectedGame?.id;

  const recentForm = useMemo<("W" | "L" | "OT")[]>(
    // Form biased by the player's scoring pace (points/game).
    () => (data ? generateForm(8, Math.min(0.8, Math.max(0.3, 0.35 + data.ptsPerGame * 0.3))) : []),
    [data?.ptsPerGame],
  );

  useEffect(() => {
    async function load() {
      try {
        const [info, stats] = await Promise.all([
          nhlApiService.getPlayer(playerId),
          nhlApiService.getPlayerStats(playerId),
        ]);
        const name = info.name ?? info.fullName ?? `${info.firstName ?? ""} ${info.lastName ?? ""}`.trim();
        const gp = stats.gamesPlayed || 1;
        setData({
          name, team: info.teamAbbr ?? "",
          logo: nhlLogoUrl(info.teamAbbr ?? ""),
          position: info.position, number: info.number ?? info.jerseyNumber ?? 0,
          goals: stats.goals, assists: stats.assists, points: stats.points,
          plusMinus: stats.plusMinus, gamesPlayed: gp,
          goalsPerGame: stats.goals / gp,
          assistsPerGame: stats.assists / gp,
          ptsPerGame: stats.points / gp,
          ppPoints: stats.powerPlayPoints ?? 0,
          shots: stats.shots ?? 0,
          hits: stats.hits ?? 0,
          blocks: stats.blockedShots ?? 0,
          toi: stats.timeOnIce ?? 0,
          faceoffPct: stats.faceoffWinPct ?? 0,
          penaltyMin: stats.penaltyMinutes ?? 0,
        });
        nhlApiService.getPlayerPredictions(playerId).then(setApiGroups).catch(() => {});
        // The game itself is resolved by useUpcomingGames(data.team) above —
        // it looks 14 days ahead and feeds the dropdown, so this loader only
        // has to publish the player's team.
      } catch (e) { console.error("PlayerPrediction load error", e); }
      finally { setLoading(false); }
    }
    load();
  }, [playerId]);

  if (loading) return <LoadingSkeleton />;
  if (!data) return <NotFound />;

  const gp  = data.gamesPlayed;
  const gpg = data.goalsPerGame;
  const apg = data.assistsPerGame;
  const ppg = data.ptsPerGame;
  const spg = data.shots / gp;
  const hpg = data.hits  / gp;
  const bpg = data.blocks / gp;
  const isGoalie = data.position === "G";

  // Poisson helper: P(X >= 1)
  const poi = (lambda: number) => Math.min(92, Math.max(5, Math.round((1 - Math.exp(-lambda)) * 100)));

  const playerGroups: MktGroup[] = isGoalie ? [
    {
      id: "goalie-saves", title: "Saves", cols: 2,
      options: [
        { id: "g-saves-over", label: "Over 25.5 Saves", rulePct: 62,
          ruleNote: "Goalies face ~28-32 shots per game on average. Saving 26+ is likely in most games.",
          mlProps: { type: "player", subjectId: playerId, propType: "saves", line: 25.5, settleMarket: "goalie_saves_ou", settleSelection: "over" } },
        { id: "g-saves-under",label: "Under 25.5 Saves",rulePct: 38,
          ruleNote: "Fewer than 26 saves usually means a lower-shot game or an early pull.",
          mlProps: { type: "player", subjectId: playerId, propType: "saves", line: 25.5, settleMarket: "goalie_saves_ou", settleSelection: "under" } },
        { id: "g-saves-over2", label: "Over 28.5 Saves", rulePct: 44,
          ruleNote: "Higher threshold — requires above-average shot volume against.",
          mlProps: { type: "player", subjectId: playerId, propType: "saves", line: 28.5, settleMarket: "goalie_saves_ou", settleSelection: "over" } },
        { id: "g-saves-under2",label: "Under 28.5 Saves",rulePct: 56,
          ruleNote: "More common line — under 29 saves covers most average-shot games.",
          mlProps: { type: "player", subjectId: playerId, propType: "saves", line: 28.5, settleMarket: "goalie_saves_ou", settleSelection: "under" } },
      ],
    },
    {
      id: "goalie-result", title: "Game Result", cols: 2,
      options: [
        { id: "g-win",    label: "Goalie Win",   rulePct: 50,
          ruleNote: "Winning goalie probability based on team win rate.",
          mlProps: { type: "player", subjectId: playerId, propType: "wins", line: 0.5, settleMarket: "goalie_win", settleSelection: "yes" } },
        { id: "g-shutout",label: "Shutout",      rulePct: 10,
          ruleNote: "Complete shutouts happen in ~10-15% of NHL starts.",
          mlProps: { type: "player", subjectId: playerId, propType: "shutouts", line: 0.5, settleMarket: "goalie_shutout", settleSelection: "yes" } },
      ],
    },
  ] : [
    {
      id: "scoring", title: "Goal Scoring", cols: 2,
      options: [
        { id: "p-anytime", label: "Anytime Goal Scorer", rulePct: poi(gpg),
          ruleNote: `Poisson model: ${gpg.toFixed(3)} goals/game → P(≥1 goal) = ${poi(gpg)}%. Based on ${data.goals} goals in ${gp} games.`,
          mlProps: { type: "player", subjectId: playerId, propType: "goals", line: 0.5, settleMarket: "anytime_goal", settleSelection: "yes" } },
        { id: "p-first",   label: "First Goal Scorer",   rulePct: Math.max(3, Math.round(poi(gpg) / 6)),
          ruleNote: `Being the first scorer is rare (~5-10% per player). Scaled from anytime probability of ${poi(gpg)}%.`,
          mlProps: { type: "player", subjectId: playerId, propType: "goals", line: 0.5, settleMarket: "first_goal_scorer", settleSelection: "yes" } },
        { id: "p-over05",  label: "Goals Over 0.5",      rulePct: poi(gpg),
          ruleNote: `Same as anytime scorer — probability of scoring at least 1 goal.`,
          mlProps: { type: "player", subjectId: playerId, propType: "goals", line: 0.5, settleMarket: "anytime_goal", settleSelection: "yes" } },
        { id: "p-over15",  label: "Goals Over 1.5",      rulePct: poi(gpg * 2) - poi(gpg),
          ruleNote: `Scoring 2+ goals in a game. Based on extended Poisson with rate ${gpg.toFixed(3)}/game.`,
          // anytime_goal settlement checks goals > line, so line 1.5 correctly
          // requires 2+ goals here (not just >=1).
          mlProps: { type: "player", subjectId: playerId, propType: "goals", line: 1.5, settleMarket: "anytime_goal", settleSelection: "yes" } },
      ],
    },
    {
      id: "assists", title: "Assists", cols: 2,
      options: [
        { id: "p-assist",      label: "Any Assist",          rulePct: poi(apg),
          ruleNote: `Poisson model: ${apg.toFixed(3)} assists/game → P(≥1 assist) = ${poi(apg)}%. Based on ${data.assists} assists in ${gp} games.`,
          mlProps: { type: "player", subjectId: playerId, propType: "assists", line: 0.5, settleMarket: "assists_ou", settleSelection: "over" } },
        { id: "p-assist-over", label: "Assists Over 0.5",    rulePct: poi(apg),
          ruleNote: `Probability of recording at least one assist.`,
          mlProps: { type: "player", subjectId: playerId, propType: "assists", line: 0.5, settleMarket: "assists_ou", settleSelection: "over" } },
        { id: "p-point",       label: "Any Point (G or A)",  rulePct: poi(ppg),
          ruleNote: `Poisson model: ${ppg.toFixed(3)} pts/game → P(≥1 point) = ${poi(ppg)}%. Based on ${data.points} points in ${gp} games.`,
          mlProps: { type: "player", subjectId: playerId, propType: "points", line: 0.5, settleMarket: "points_ou", settleSelection: "over" } },
        { id: "p-multi-point", label: "Multi-Point Game",    rulePct: Math.min(60, Math.round(poi(ppg) * 0.35)),
          ruleNote: `Recording 2+ points in one game. Less common — roughly 1/3 of point games.`,
          mlProps: { type: "player", subjectId: playerId, propType: "points", line: 1.5, settleMarket: "points_ou", settleSelection: "over" } },
      ],
    },
    ...(data.shots > 0 ? [{
      id: "shots", title: "Shots on Goal", cols: 2,
      options: [
        { id: "p-shots-over",  label: `Shots Over ${Math.floor(spg + 0.5)}.5`,  rulePct: 52,
          ruleNote: `${data.name} averages ${spg.toFixed(1)} shots/game. The line is close to their average.`,
          mlProps: { type: "player" as const, subjectId: playerId, propType: "shots", line: Math.floor(spg + 0.5) + 0.5, settleMarket: "shots_ou", settleSelection: "over" } },
        { id: "p-shots-under", label: `Shots Under ${Math.floor(spg + 0.5)}.5`, rulePct: 48,
          ruleNote: `Shooting below their ${spg.toFixed(1)}/game average is possible in any matchup.`,
          mlProps: { type: "player" as const, subjectId: playerId, propType: "shots", line: Math.floor(spg + 0.5) + 0.5, settleMarket: "shots_ou", settleSelection: "under" } },
        { id: "p-shots-over2", label: `Shots Over ${Math.ceil(spg + 1)}.5`,      rulePct: 38,
          ruleNote: `Higher threshold — requires an active game for ${data.name}.`,
          mlProps: { type: "player" as const, subjectId: playerId, propType: "shots", line: Math.ceil(spg + 1) + 0.5, settleMarket: "shots_ou", settleSelection: "over" } },
        { id: "p-shots-under2",label: `Shots Under ${Math.ceil(spg + 1)}.5`,     rulePct: 62,
          ruleNote: `Easier to hit — any quiet game keeps ${data.name} under this threshold.`,
          mlProps: { type: "player" as const, subjectId: playerId, propType: "shots", line: Math.ceil(spg + 1) + 0.5, settleMarket: "shots_ou", settleSelection: "under" } },
      ],
    } as MktGroup] : []),
    ...(data.hits > 0 ? [{
      id: "hits", title: "Hits", cols: 2,
      options: [
        { id: "p-hits-over",  label: `Hits Over ${Math.floor(hpg)}.5`,  rulePct: 52,
          ruleNote: `${data.name} averages ${hpg.toFixed(1)} hits/game.`,
          mlProps: { type: "player" as const, subjectId: playerId, propType: "hits", line: Math.floor(hpg) + 0.5, settleMarket: "hits_ou", settleSelection: "over" } },
        { id: "p-hits-under", label: `Hits Under ${Math.floor(hpg)}.5`, rulePct: 48,
          ruleNote: `Below-average hit game for ${data.name}.`,
          mlProps: { type: "player" as const, subjectId: playerId, propType: "hits", line: Math.floor(hpg) + 0.5, settleMarket: "hits_ou", settleSelection: "under" } },
      ],
    } as MktGroup] : []),
    ...(data.blocks > 0 ? [{
      id: "blocks", title: "Blocked Shots", cols: 2,
      options: [
        { id: "p-blocks-over",  label: `Blocks Over ${Math.floor(bpg)}.5`,  rulePct: 50,
          ruleNote: `${data.name} averages ${bpg.toFixed(1)} blocked shots/game.`,
          mlProps: { type: "player" as const, subjectId: playerId, propType: "blocks", line: Math.floor(bpg) + 0.5, settleMarket: "blocked_shots_ou", settleSelection: "over" } },
        { id: "p-blocks-under", label: `Blocks Under ${Math.floor(bpg)}.5`, rulePct: 50,
          ruleNote: `Blocked shots are highly situational depending on the game flow.`,
          mlProps: { type: "player" as const, subjectId: playerId, propType: "blocks", line: Math.floor(bpg) + 0.5, settleMarket: "blocked_shots_ou", settleSelection: "under" } },
      ],
    } as MktGroup] : []),
    ...(data.ppPoints > 0 ? [{
      id: "pp", title: "Power Play", cols: 2,
      options: [
        { id: "p-pp-point", label: "PP Point",         rulePct: Math.min(70, Math.round((data.ppPoints / gp) * 200)),
          ruleNote: `${data.name} has ${data.ppPoints} PP points in ${gp} games (${(data.ppPoints/gp).toFixed(2)}/game).`,
          mlProps: { type: "player" as const, subjectId: playerId, propType: "points", line: 0.5, settleMarket: "pp_point", settleSelection: "yes" } },
        { id: "p-pp-goal",  label: "PP Goal",          rulePct: Math.min(50, Math.round((data.ppPoints / gp) * 100)),
          ruleNote: `PP goals are less common than PP assists. Scaled from PP point probability.`,
          mlProps: { type: "player" as const, subjectId: playerId, propType: "goals", line: 0.5, settleMarket: "pp_goal", settleSelection: "yes" } },
      ],
    } as MktGroup] : []),
    ...(data.penaltyMin > 0 ? [{
      id: "pim", title: "Penalty Minutes", cols: 2,
      options: [
        { id: "p-pim-over",  label: `PIM Over 0.5`,   rulePct: Math.min(70, Math.round((data.penaltyMin / gp) * 100)),
          ruleNote: `${data.name} averages ${(data.penaltyMin/gp).toFixed(2)} penalty minutes/game.`,
          mlProps: { type: "player" as const, subjectId: playerId, propType: "pim", line: 0.5, settleMarket: "penalty_minutes_ou", settleSelection: "over" } },
        { id: "p-pim-under", label: `PIM Under 0.5`,  rulePct: Math.max(30, 100 - Math.min(70, Math.round((data.penaltyMin / gp) * 100))),
          ruleNote: `Staying out of the penalty box — common for disciplined players.`,
          mlProps: { type: "player" as const, subjectId: playerId, propType: "pim", line: 0.5, settleMarket: "penalty_minutes_ou", settleSelection: "under" } },
      ],
    } as MktGroup] : []),
  ];

  // ── Injecte les facteurs serveur dans les paris locaux (table de mapping ids) ──
  const playerGroupsF: MktGroup[] = (() => {
    if (!apiGroups) return playerGroups;
    const byId: Record<string, { factors?: RuleFactor[]; factorGroup?: string }> = {};
    for (const g of apiGroups) for (const o of g.options as any[]) {
      if (o.factors?.length) byId[o.id] = { factors: o.factors, factorGroup: o.factorGroup };
    }
    // Choisit l'id serveur dont la ligne est la plus proche de celle du pari local.
    const nearest = (ids: string[], lines: number[], line?: number): string => {
      if (line == null) return ids[0];
      let best = 0, bestD = Infinity;
      lines.forEach((l, i) => { const d = Math.abs(l - line); if (d < bestD) { bestD = d; best = i; } });
      return ids[best];
    };
    // [id serveur, inverser (paris "under")]
    const resolve = (o: BetOpt): [string, boolean] | null => {
      const line = o.mlProps?.line;
      switch (o.id) {
        case "p-anytime": case "p-over05": return ["g-anytime", false];
        case "p-first":                    return ["g-first", false];
        case "p-over15":                   return ["g-2plus", false];
        case "p-assist": case "p-assist-over": return ["a-1plus", false];
        case "p-point":                    return ["pts-1plus", false];
        case "p-multi-point":              return ["pts-2plus", false];
        case "p-shots-over":  case "p-shots-over2":
          return [nearest(["sog-o25","sog-o35","sog-o45"], [2.5,3.5,4.5], line), false];
        case "p-shots-under": case "p-shots-under2":
          return [nearest(["sog-o25","sog-o35","sog-o45"], [2.5,3.5,4.5], line), true];
        case "p-hits-over":  return [nearest(["hits-o15","hits-o25","hits-o35"], [1.5,2.5,3.5], line), false];
        case "p-hits-under": return [nearest(["hits-o15","hits-o25","hits-o35"], [1.5,2.5,3.5], line), true];
        case "p-blocks-over":  return [nearest(["blk-o05","blk-o15"], [0.5,1.5], line), false];
        case "p-blocks-under": return [nearest(["blk-o05","blk-o15"], [0.5,1.5], line), true];
        case "p-pp-point": return ["pp-point", false];
        case "p-pp-goal":  return ["pp-goal", false];
        case "p-pim-over":  return ["pim-o05", false];
        case "p-pim-under": return ["pim-o05", true];
        // Gardien
        case "g-saves-over":   case "g-saves-over2":
          return [nearest(["sv-o245","sv-o275","sv-o295"], [24.5,27.5,29.5], line), false];
        case "g-saves-under":  case "g-saves-under2":
          return [nearest(["sv-o245","sv-o275","sv-o295"], [24.5,27.5,29.5], line), true];
        case "g-win":     return ["gr-win", false];
        case "g-shutout": return ["gr-shutout", false];
        default: return null;
      }
    };
    return playerGroups.map((g) => ({
      ...g,
      options: g.options.map((o) => {
        const r = resolve(o);
        const src = r ? byId[r[0]] : undefined;
        if (!src?.factors) return o;
        const factors = r![1]
          ? src.factors.map(f => ({ ...f, value: Math.max(0.05, Math.min(0.95, 1 - f.value)) }))
          : src.factors;
        return { ...o, factors, factorGroup: src.factorGroup };
      }),
    }));
  })();

  // Stamp the resolved game id onto every option's mlProps.
  const playerGroupsG: MktGroup[] = playerGameId
    ? playerGroupsF.map(g => ({
        ...g,
        options: g.options.map(o => (o.mlProps ? { ...o, mlProps: { ...o.mlProps, gameId: playerGameId } } : o)),
      }))
    : playerGroupsF;

  return (
    <div className="flex flex-col gap-3">
      {/* Which game these props are for — next game by default */}
      <GameSelector games={games} selected={selectedGame} onSelect={selectGame} accent={accent} />

      {/* Player header */}
      <div className="bg-[#131A12] border border-white/20 rounded-2xl p-4">
        <div className="flex items-center gap-3 mb-3">
          <img src={data.logo} alt={data.team} className="w-12 h-12 object-contain" />
          <div className="flex-1 min-w-0">
            <p className="text-white font-bold text-base truncate">{data.name}</p>
            <p className="text-[#8a9ea6] text-xs">{data.team} · #{data.number} · {data.position}</p>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {[
            { label: "G",    value: String(data.goals)   },
            { label: "A",    value: String(data.assists)  },
            { label: "PTS",  value: String(data.points)   },
            { label: "+/-",  value: (data.plusMinus >= 0 ? "+" : "") + data.plusMinus },
          ].map(s => (
            <div key={s.label} className="bg-[#0A0E0C] rounded-xl p-2 text-center">
              <p className="text-white text-sm font-bold">{s.value}</p>
              <p className="text-[#8a9ea6] text-[9px]">{s.label}</p>
            </div>
          ))}
        </div>
      </div>
      {/* Recent form — shown above the markets */}
      <RecentFormCard results={recentForm} />

      {/* Market groups — local groups always used (they carry mlProps) */}
      <PredictionsRevealBar mode={revealMode} onSelect={setRevealMode} />
      <RevealModeCtx.Provider value={revealMode}>
        {playerGroupsG.map(g => <MarketGroup key={g.id} group={g} accent={accent} />)}
      </RevealModeCtx.Provider>

    </div>
  );
}
