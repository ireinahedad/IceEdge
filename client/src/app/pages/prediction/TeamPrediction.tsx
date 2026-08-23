/**
 * TeamPrediction.tsx
 *
 * Extrait de PredictionPage.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { useEffect, useState, useMemo } from "react";
import { nhlApiService } from "../../services/nhlApiService";
import { useSport } from "../../context/SportContext";
import { nhlLogoUrl } from "../../data/teamEmoji";
import { MarketGroup, PredictionsRevealBar } from "./PredictionSheet";
import { MLProps, MktGroup, RuleFactor } from "./gameMarkets";
import { LoadingSkeleton, NotFound, RecentFormCard, RevealMode, RevealModeCtx, generateForm } from "./predictionShared";


/* ─── Team Prediction ─────────────────────────── */
export function TeamPrediction({ teamId }: { teamId: string }) {
  const { theme } = useSport();
  const accent = theme.accent;
  const [data, setData] = useState<{
    name: string; abbr: string; logo: string; conf: string; pts: number;
    homeRecord: string; awayRecord: string; streak: string;
    winPct: number; ppPct: number; pkPct: number;
    goalsFor: number; goalsAgainst: number;
  } | null>(null);
  const [apiGroups, setApiGroups] = useState<MktGroup[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [revealMode, setRevealMode] = useState<RevealMode>("rules");
  const recentForm = useMemo<("W" | "L" | "OT")[]>(
    () => (data ? generateForm(8, data.winPct / 100) : []),
    [data?.winPct],
  );

  useEffect(() => {
    async function load() {
      try {
        const [teams, stats] = await Promise.all([
          nhlApiService.getAllTeams(),
          nhlApiService.getTeamStats(teamId),
        ]);
        const info = teams.find(t => t.abbreviation?.toLowerCase() === teamId.toLowerCase());
        const abbr = info?.abbreviation ?? teamId.toUpperCase();
        const winPct = stats.wins + stats.losses + stats.otLosses > 0
          ? Math.round((stats.wins / (stats.wins + stats.losses + stats.otLosses)) * 100) : 50;
        setData({
          name: info?.name ?? abbr, abbr,
          logo: nhlLogoUrl(abbr),
          conf: info?.conference === "Eastern" ? "East" : "West",
          pts: stats.points ?? stats.wins * 2,
          homeRecord: stats.homeRecord ?? "", awayRecord: stats.awayRecord ?? "",
          streak: stats.streak ?? "", winPct,
          ppPct: stats.powerPlayPct ?? 0, pkPct: stats.penaltyKillPct ?? 0,
          goalsFor: stats.goalsForPerGame ?? 0, goalsAgainst: stats.goalsAgainstPerGame ?? 0,
        });
        // Fetch rule-based predictions from backend
        nhlApiService.getTeamPredictions(abbr).then(setApiGroups).catch(() => {});
      } catch (e) { console.error("TeamPrediction load error", e); }
      finally { setLoading(false); }
    }
    load();
  }, [teamId]);

  if (loading) return <LoadingSkeleton />;
  if (!data) return <NotFound />;

  const hp = data.winPct;
  const ou = parseFloat(((data.goalsFor + data.goalsAgainst)).toFixed(1)) || 5.5;

  // ── build team-level bet groups ──────────────────────────────────────────
  const tml = (propType: string, line?: number): MLProps =>
    ({ type: "team", subjectId: data.abbr, propType, line });

  const teamGroups: MktGroup[] = [
    {
      id: "match", title: "Match Betting", cols: 2,
      options: [
        { id: "t-win",  label: `${data.abbr} Wins (ML)`,       rulePct: hp,
          ruleNote: `Season win rate of ${hp}% based on ${data.pts} pts, record ${data.homeRecord} home / ${data.awayRecord} away.`,
          mlProps: tml("moneyline") },
        { id: "t-lose", label: `${data.abbr} Loses (ML)`,      rulePct: 100 - hp,
          ruleNote: `Inverse of win probability: ${100 - hp}%. Current streak: ${data.streak || "—"}.`,
          mlProps: tml("moneyline") },
        { id: "t-ml-ot",label: "Match Goes to OT",             rulePct: 22,
          ruleNote: "~22-24% of NHL games go to OT/SO regardless of team strength.",
          mlProps: tml("game_to_ot") },
      ],
    },
    {
      id: "puckline", title: "Puck Line", cols: 2,
      options: [
        { id: "t-pl-fav", label: `${data.abbr} -1.5`,          rulePct: Math.max(10, hp - 18),
          ruleNote: "Win by 2+ goals — ~18% harder than a straight moneyline win.",
          mlProps: tml("puck_line") },
        { id: "t-pl-dog", label: `${data.abbr} +1.5`,          rulePct: Math.min(90, hp + 18),
          ruleNote: "Win OR lose by 1 goal. Probability boosted ~18% vs straight moneyline.",
          mlProps: tml("alt_puck_line") },
      ],
    },
    {
      id: "totals", title: "Team Goals", cols: 2,
      options: [
        { id: "t-over",    label: `Over ${ou}`,                  rulePct: 54,
          ruleNote: `Based on ${data.abbr}'s ${data.goalsFor.toFixed(2)} goals/game average.`,
          mlProps: tml("total_goals_over", ou) },
        { id: "t-under",   label: `Under ${ou}`,                 rulePct: 46,
          ruleNote: `${data.abbr} allows ${data.goalsAgainst.toFixed(2)} goals/game. Solid defense could keep this low.`,
          mlProps: tml("total_goals_under", ou) },
        { id: "t-team-over", label: `${data.abbr} Over 2.5`,   rulePct: Math.min(80, Math.round(data.goalsFor * 22 + 5)),
          ruleNote: `${data.abbr} averages ${data.goalsFor.toFixed(2)} goals/game. Scoring 3+ requires above-average output.`,
          mlProps: tml("total_goals_over", 2.5) },
        { id: "t-team-under",label: `${data.abbr} Under 2.5`,  rulePct: Math.max(20, 100 - Math.min(80, Math.round(data.goalsFor * 22 + 5))),
          ruleNote: `${data.abbr} held under 3 goals in a significant portion of games.`,
          mlProps: tml("total_goals_under", 2.5) },
      ],
    },
    {
      id: "clean", title: "Clean Sheet / Both Score", cols: 2,
      options: [
        { id: "t-cs",   label: `${data.abbr} Shutout`,          rulePct: Math.max(8, Math.round((100 - data.pkPct) * 0.20)),
          ruleNote: `Shutouts happen in ~15-22% of games. ${data.abbr}'s PK at ${data.pkPct.toFixed(1)}% is a factor.`,
          mlProps: tml("clean_sheet") },
        { id: "t-btts", label: "Both Teams Score",               rulePct: Math.min(88, Math.round(data.goalsFor * 18 + data.goalsAgainst * 12 + 25)),
          ruleNote: "Both offenses producing. Very common in NHL (~75-80% of games).",
          mlProps: tml("both_teams_score") },
      ],
    },
    {
      id: "period", title: "Period Results", cols: 3,
      options: [
        { id: "t-p1", label: `${data.abbr} Leads P1`,           rulePct: Math.round(hp * 0.42 + 10),
          ruleNote: `${data.abbr} leads after the 1st period in ~${Math.round(hp * 0.42 + 10)}% of games.`,
          mlProps: tml("period1_winner") },
        { id: "t-p2", label: `${data.abbr} Leads P2`,           rulePct: Math.round(hp * 0.44 + 8),
          ruleNote: `${data.abbr} leads after P2. More predictive than P1.`,
          mlProps: tml("period2_winner") },
        { id: "t-p3", label: `${data.abbr} Leads P3`,           rulePct: Math.round(hp * 0.48 + 6),
          ruleNote: `Leading after P3 strongly correlates with winning the game.`,
          mlProps: tml("period3_winner") },
      ],
    },
    {
      id: "pp", title: "Special Teams", cols: 2,
      options: [
        { id: "t-pp-goal", label: `${data.abbr} PP Goal`,       rulePct: Math.min(75, Math.round(data.ppPct * 1.8)),
          ruleNote: `${data.abbr}'s power play is at ${data.ppPct.toFixed(1)}%. League avg is ~20%. Scoring on the PP ~${Math.min(75, Math.round(data.ppPct * 1.8))}% of games.`,
          mlProps: tml("pp_goal") },
        { id: "t-pk",      label: `${data.abbr} Kills All PKs`, rulePct: Math.min(80, Math.round(data.pkPct * 0.9)),
          ruleNote: `${data.abbr} penalty kill at ${data.pkPct.toFixed(1)}%. Successfully killing all penalties ~${Math.min(80, Math.round(data.pkPct * 0.9))}% of games.`,
          mlProps: tml("penalty_kill") },
      ],
    },
    {
      id: "margin", title: "Winning Margin", cols: 3,
      options: [
        { id: "t-w1", label: `${data.abbr} by 1`, rulePct: Math.round(hp * 0.18),
          ruleNote: "One-goal wins are the most common margin in the NHL.",
          mlProps: tml("winning_margin") },
        { id: "t-w2", label: `${data.abbr} by 2`, rulePct: Math.round(hp * 0.13),
          ruleNote: "Two-goal victory — comfortable but not a blowout.",
          mlProps: tml("winning_margin") },
        { id: "t-w3", label: `${data.abbr} by 3+`, rulePct: Math.round(hp * 0.09),
          ruleNote: "Blowout wins are less frequent, even for dominant teams.",
          mlProps: tml("winning_margin") },
      ],
    },
  ];

  // Injecte la décomposition en facteurs (données serveur) dans les paris
  // victoire/défaite locaux → affiche le pie chart des règles.
  const teamGroupsF: MktGroup[] = (() => {
    if (!apiGroups) return teamGroups;
    // Table de correspondance ids locaux (vue équipe) → ids serveur.
    const TEAM_ID_MAP: Record<string, string> = {
      "t-win": "ml-home",   "t-lose": "ml-away",
      "t-ml-ot": "ot-yes",  "t-dc": "dc-home",
      "t-pl-fav": "pl-home","t-pl-dog": "pl-away",
      "t-over": ou >= 6 ? "o65" : "o55", "t-under": ou >= 6 ? "u65" : "u55",
      "t-team-over": "tg-o25", "t-team-under": "tg-u25",
      "t-cs": "cs-for",     "t-btts": "btts-yes",
      "t-p1": "p1-home",    "t-p2": "p2-home",  "t-p3": "p3-home",
      "t-pp-goal": "ppgoal","t-pk": "pk-perfect",
      "t-w1": "wm-1",       "t-w2": "wm-2",     "t-w3": "wm-3p",
    };
    const byServerId: Record<string, { factors?: RuleFactor[]; factorGroup?: string }> = {};
    for (const g of apiGroups) for (const o of g.options as any[]) {
      if (o.factors?.length) byServerId[o.id] = { factors: o.factors, factorGroup: o.factorGroup };
    }
    return teamGroups.map((g) => ({
      ...g,
      options: g.options.map((o) => {
        const src = TEAM_ID_MAP[o.id] ? byServerId[TEAM_ID_MAP[o.id]] : undefined;
        return src ? { ...o, ...src } : o;
      }),
    }));
  })();

  return (
    <div className="flex flex-col gap-3">
      {/* Team header */}
      <div className="bg-[#131A12] border border-white/20 rounded-2xl p-4">
        <div className="flex items-center gap-3 mb-3">
          <img src={data.logo} alt={data.name} className="w-12 h-12 object-contain" />
          <div className="flex-1">
            <p className="text-white font-bold text-base">{data.name}</p>
            <p className="text-[#8a9ea6] text-xs">{data.conf}ern · {data.pts} pts · {data.streak || "—"}</p>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {[
            { label: "Home",   value: data.homeRecord || "—" },
            { label: "Away",   value: data.awayRecord  || "—" },
            { label: "PP%",    value: data.ppPct ? data.ppPct.toFixed(1)+"%" : "—" },
            { label: "PK%",    value: data.pkPct ? data.pkPct.toFixed(1)+"%" : "—" },
          ].map(s => (
            <div key={s.label} className="bg-[#0A0E0C] rounded-xl p-2 text-center">
              <p className="text-white text-xs font-bold">{s.value}</p>
              <p className="text-[#8a9ea6] text-[9px]">{s.label}</p>
            </div>
          ))}
        </div>
      </div>
      {/* Recent form — shown above the markets */}
      <RecentFormCard results={recentForm} />

      {/* Market groups — reveal-all toggle */}
      <PredictionsRevealBar mode={revealMode} onSelect={setRevealMode} />
      <RevealModeCtx.Provider value={revealMode}>
        {teamGroupsF.map(g => <MarketGroup key={g.id} group={g} accent={accent} />)}
      </RevealModeCtx.Provider>

    </div>
  );
}
