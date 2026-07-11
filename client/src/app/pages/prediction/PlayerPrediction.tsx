import { useEffect, useMemo, useState } from "react";
import { nhlApiService } from "../../services/nhlApiService";
import { nhlLogoUrl } from "../../data/teamEmoji";
import { useSport } from "../../context/SportContext";
import {
  generateForm, LoadingSkeleton, NotFound, RecentFormCard,
  PredictionsRevealBar, RevealAllCtx,
} from "./common";
import { MarketGroup, type MktGroup } from "./markets";

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
  const [loading, setLoading] = useState(true);
  const [revealAll, setRevealAll] = useState(false);
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
          mlProps: { type: "player", subjectId: playerId, propType: "saves", line: 25.5 } },
        { id: "g-saves-under",label: "Under 25.5 Saves",rulePct: 38,
          ruleNote: "Fewer than 26 saves usually means a lower-shot game or an early pull.",
          mlProps: { type: "player", subjectId: playerId, propType: "saves", line: 25.5 } },
        { id: "g-saves-over2", label: "Over 28.5 Saves", rulePct: 44,
          ruleNote: "Higher threshold — requires above-average shot volume against.",
          mlProps: { type: "player", subjectId: playerId, propType: "saves", line: 28.5 } },
        { id: "g-saves-under2",label: "Under 28.5 Saves",rulePct: 56,
          ruleNote: "More common line — under 29 saves covers most average-shot games.",
          mlProps: { type: "player", subjectId: playerId, propType: "saves", line: 28.5 } },
      ],
    },
    {
      id: "goalie-result", title: "Game Result", cols: 2,
      options: [
        { id: "g-win",    label: "Goalie Win",   rulePct: 50,
          ruleNote: "Winning goalie probability based on team win rate.",
          mlProps: { type: "player", subjectId: playerId, propType: "wins", line: 0.5 } },
        { id: "g-shutout",label: "Shutout",      rulePct: 10,
          ruleNote: "Complete shutouts happen in ~10-15% of NHL starts.",
          mlProps: { type: "player", subjectId: playerId, propType: "shutouts", line: 0.5 } },
      ],
    },
  ] : [
    {
      id: "scoring", title: "Goal Scoring", cols: 2,
      options: [
        { id: "p-anytime", label: "Anytime Goal Scorer", rulePct: poi(gpg),
          ruleNote: `Poisson model: ${gpg.toFixed(3)} goals/game → P(≥1 goal) = ${poi(gpg)}%. Based on ${data.goals} goals in ${gp} games.`,
          mlProps: { type: "player", subjectId: playerId, propType: "goals", line: 0.5 } },
        { id: "p-first",   label: "First Goal Scorer",   rulePct: Math.max(3, Math.round(poi(gpg) / 6)),
          ruleNote: `Being the first scorer is rare (~5-10% per player). Scaled from anytime probability of ${poi(gpg)}%.`,
          mlProps: { type: "player", subjectId: playerId, propType: "goals", line: 0.5 } },
        { id: "p-over05",  label: "Goals Over 0.5",      rulePct: poi(gpg),
          ruleNote: `Same as anytime scorer — probability of scoring at least 1 goal.`,
          mlProps: { type: "player", subjectId: playerId, propType: "goals", line: 0.5 } },
        { id: "p-over15",  label: "Goals Over 1.5",      rulePct: poi(gpg * 2) - poi(gpg),
          ruleNote: `Scoring 2+ goals in a game. Based on extended Poisson with rate ${gpg.toFixed(3)}/game.`,
          mlProps: { type: "player", subjectId: playerId, propType: "goals", line: 1.5 } },
      ],
    },
    {
      id: "assists", title: "Assists", cols: 2,
      options: [
        { id: "p-assist",      label: "Any Assist",          rulePct: poi(apg),
          ruleNote: `Poisson model: ${apg.toFixed(3)} assists/game → P(≥1 assist) = ${poi(apg)}%. Based on ${data.assists} assists in ${gp} games.`,
          mlProps: { type: "player", subjectId: playerId, propType: "assists", line: 0.5 } },
        { id: "p-assist-over", label: "Assists Over 0.5",    rulePct: poi(apg),
          ruleNote: `Probability of recording at least one assist.`,
          mlProps: { type: "player", subjectId: playerId, propType: "assists", line: 0.5 } },
        { id: "p-point",       label: "Any Point (G or A)",  rulePct: poi(ppg),
          ruleNote: `Poisson model: ${ppg.toFixed(3)} pts/game → P(≥1 point) = ${poi(ppg)}%. Based on ${data.points} points in ${gp} games.`,
          mlProps: { type: "player", subjectId: playerId, propType: "points", line: 0.5 } },
        { id: "p-multi-point", label: "Multi-Point Game",    rulePct: Math.min(60, Math.round(poi(ppg) * 0.35)),
          ruleNote: `Recording 2+ points in one game. Less common — roughly 1/3 of point games.`,
          mlProps: { type: "player", subjectId: playerId, propType: "points", line: 1.5 } },
      ],
    },
    ...(data.shots > 0 ? [{
      id: "shots", title: "Shots on Goal", cols: 2,
      options: [
        { id: "p-shots-over",  label: `Shots Over ${Math.floor(spg + 0.5)}.5`,  rulePct: 52,
          ruleNote: `${data.name} averages ${spg.toFixed(1)} shots/game. The line is close to their average.`,
          mlProps: { type: "player" as const, subjectId: playerId, propType: "shots", line: Math.floor(spg + 0.5) + 0.5 } },
        { id: "p-shots-under", label: `Shots Under ${Math.floor(spg + 0.5)}.5`, rulePct: 48,
          ruleNote: `Shooting below their ${spg.toFixed(1)}/game average is possible in any matchup.`,
          mlProps: { type: "player" as const, subjectId: playerId, propType: "shots", line: Math.floor(spg + 0.5) + 0.5 } },
        { id: "p-shots-over2", label: `Shots Over ${Math.ceil(spg + 1)}.5`,      rulePct: 38,
          ruleNote: `Higher threshold — requires an active game for ${data.name}.`,
          mlProps: { type: "player" as const, subjectId: playerId, propType: "shots", line: Math.ceil(spg + 1) + 0.5 } },
        { id: "p-shots-under2",label: `Shots Under ${Math.ceil(spg + 1)}.5`,     rulePct: 62,
          ruleNote: `Easier to hit — any quiet game keeps ${data.name} under this threshold.`,
          mlProps: { type: "player" as const, subjectId: playerId, propType: "shots", line: Math.ceil(spg + 1) + 0.5 } },
      ],
    } as MktGroup] : []),
    ...(data.hits > 0 ? [{
      id: "hits", title: "Hits", cols: 2,
      options: [
        { id: "p-hits-over",  label: `Hits Over ${Math.floor(hpg)}.5`,  rulePct: 52,
          ruleNote: `${data.name} averages ${hpg.toFixed(1)} hits/game.`,
          mlProps: { type: "player" as const, subjectId: playerId, propType: "hits", line: Math.floor(hpg) + 0.5 } },
        { id: "p-hits-under", label: `Hits Under ${Math.floor(hpg)}.5`, rulePct: 48,
          ruleNote: `Below-average hit game for ${data.name}.`,
          mlProps: { type: "player" as const, subjectId: playerId, propType: "hits", line: Math.floor(hpg) + 0.5 } },
      ],
    } as MktGroup] : []),
    ...(data.blocks > 0 ? [{
      id: "blocks", title: "Blocked Shots", cols: 2,
      options: [
        { id: "p-blocks-over",  label: `Blocks Over ${Math.floor(bpg)}.5`,  rulePct: 50,
          ruleNote: `${data.name} averages ${bpg.toFixed(1)} blocked shots/game.`,
          mlProps: { type: "player" as const, subjectId: playerId, propType: "blocks", line: Math.floor(bpg) + 0.5 } },
        { id: "p-blocks-under", label: `Blocks Under ${Math.floor(bpg)}.5`, rulePct: 50,
          ruleNote: `Blocked shots are highly situational depending on the game flow.`,
          mlProps: { type: "player" as const, subjectId: playerId, propType: "blocks", line: Math.floor(bpg) + 0.5 } },
      ],
    } as MktGroup] : []),
    ...(data.ppPoints > 0 ? [{
      id: "pp", title: "Power Play", cols: 2,
      options: [
        { id: "p-pp-point", label: "PP Point",         rulePct: Math.min(70, Math.round((data.ppPoints / gp) * 200)),
          ruleNote: `${data.name} has ${data.ppPoints} PP points in ${gp} games (${(data.ppPoints/gp).toFixed(2)}/game).`,
          mlProps: { type: "player" as const, subjectId: playerId, propType: "points", line: 0.5 } },
        { id: "p-pp-goal",  label: "PP Goal",          rulePct: Math.min(50, Math.round((data.ppPoints / gp) * 100)),
          ruleNote: `PP goals are less common than PP assists. Scaled from PP point probability.`,
          mlProps: { type: "player" as const, subjectId: playerId, propType: "goals", line: 0.5 } },
      ],
    } as MktGroup] : []),
    ...(data.penaltyMin > 0 ? [{
      id: "pim", title: "Penalty Minutes", cols: 2,
      options: [
        { id: "p-pim-over",  label: `PIM Over 0.5`,   rulePct: Math.min(70, Math.round((data.penaltyMin / gp) * 100)),
          ruleNote: `${data.name} averages ${(data.penaltyMin/gp).toFixed(2)} penalty minutes/game.`,
          mlProps: { type: "player" as const, subjectId: playerId, propType: "pim", line: 0.5 } },
        { id: "p-pim-under", label: `PIM Under 0.5`,  rulePct: Math.max(30, 100 - Math.min(70, Math.round((data.penaltyMin / gp) * 100))),
          ruleNote: `Staying out of the penalty box — common for disciplined players.`,
          mlProps: { type: "player" as const, subjectId: playerId, propType: "pim", line: 0.5 } },
      ],
    } as MktGroup] : []),
  ];

  return (
    <div className="flex flex-col gap-3">
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
      <PredictionsRevealBar revealAll={revealAll} onToggle={() => setRevealAll(v => !v)} />
      <RevealAllCtx.Provider value={revealAll}>
        {playerGroups.map(g => <MarketGroup key={g.id} group={g} accent={accent} />)}
      </RevealAllCtx.Provider>

    </div>
  );
}
