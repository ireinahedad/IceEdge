import { useParams, useNavigate, useSearchParams } from "react-router";
import { useEffect, useState } from "react";
import { BottomNav } from "./BottomNav";
import { MarketSelectorSheet } from "./MarketSelectorSheet";
import { PredictionResponse } from "../types/bet";
import { nhlApiService } from "../services/nhlApiService";
import { predictionApiService } from "../services/predictionApiService";
import { useSport } from "../context/SportContext";
import { teamEmoji } from "../data/teamEmoji";
import { getTeamById, getGameById, getPlayerById } from "../data/hockeyData";
import { factorsApiService } from "../services/predictionApiService";
import { useBet } from "../context/BetContext";
import type { BetLeg } from "../types/bet";
import { tennisApiService } from "../services/tennisApiService";
import type { TennisRankingEntry } from "../services/tennisApiService";
import { MLSection } from "./MLPredictionCard";

type Subject = { id: string; type: "team" | "player" | "game"; name: string; logo: string; subtitle: string };
/* ─── Circular gauge ─────────────────────────────── */
function WinGauge({ pct, label, size = 140 }: { pct: number; label: string; size?: number }) {
  const [displayed, setDisplayed] = useState(0);
  const radius = (size - 20) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - displayed / 100);

  const color =
    pct >= 65 ? "#4ade80" :
    pct >= 50 ? "#86d1ea" :
    pct >= 40 ? "#facc15" :
    "#f87171";

  useEffect(() => {
    const timeout = setTimeout(() => {
      let start = 0;
      const step = () => {
        start += 1;
        setDisplayed(start);
        if (start < pct) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }, 300);
    return () => clearTimeout(timeout);
  }, [pct]);

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#1e2d32" strokeWidth={10} />
        <circle
          cx={size / 2} cy={size / 2} r={radius} fill="none"
          stroke={color} strokeWidth={10}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          style={{ transition: "stroke-dashoffset 0.05s linear" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-white text-3xl font-bold">{displayed}<span className="text-xl">%</span></span>
        <span className="text-[#bfc8cc] text-[10px] mt-0.5 text-center px-2 leading-tight">{label}</span>
      </div>
    </div>
  );
}

/* ─── Reason card ─────────────────────────────────── */
function ReasonBar({ icon, label, value, maxValue, color, detail }: {
  icon: string; label: string; value: number; maxValue: number; color: string; detail: string;
}) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setWidth((value / maxValue) * 100), 400);
    return () => clearTimeout(t);
  }, [value, maxValue]);

  return (
    <div className="bg-[#111a1f] border border-white/20 rounded-2xl p-3.5">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-lg">{icon}</span>
          <span className="text-white text-xs font-medium">{label}</span>
        </div>
        <span className="text-xs font-bold" style={{ color }}>{detail}</span>
      </div>
      <div className="w-full bg-[#0a1014] rounded-full h-2">
        <div
          className="h-2 rounded-full transition-all duration-700 ease-out"
          style={{ width: `${width}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

/* ─── Calculated Breakdown (waterfall) ─────────── */

function CalculatedBreakdown({ basePct, factors, finalPct, accent }: {
  basePct: number;
  factors: CalcFactor[];
  finalPct: number;
  accent: string;
}) {
  const [revealed, setRevealed] = useState(0);

  useEffect(() => {
    let i = 0;
    const id = setInterval(() => {
      i++;
      setRevealed(i);
      if (i >= factors.length) clearInterval(id);
    }, 220);
    return () => clearInterval(id);
  }, [factors.length]);

  let running = basePct;

  return (
    <div className="bg-[#111a1f] border border-white/20 rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-white/20 flex items-center justify-between">
        <span className="text-white text-sm font-semibold">Calculated Predictions</span>
        <span className="text-[10px] text-[#bfc8cc] bg-[#0a1014] px-2 py-0.5 rounded-full">Base: {basePct}%</span>
      </div>
      <div className="divide-y divide-[#1e2d32]">
        {factors.map((f, i) => {
          running += f.delta;
          const isPos = f.delta >= 0;
          const color = isPos ? "#4ade80" : "#f87171";
          const show = i < revealed;
          return (
            <div key={i} className="flex items-center gap-3 px-4 py-3 transition-all duration-300"
              style={{ opacity: show ? 1 : 0, transform: show ? "translateY(0)" : "translateY(6px)" }}>
              <span className="text-base w-6 text-center flex-shrink-0">{f.icon}</span>
              <span className="text-[#bfc8cc] text-xs flex-1 leading-tight">{f.label}</span>
              <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
                <span className="text-xs font-bold" style={{ color }}>{isPos ? "+" : ""}{f.delta}%</span>
                <span className="text-[9px] text-[#bfc8cc]">{Math.round(running)}%</span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="px-4 py-4 flex items-center justify-between border-t-2" style={{ borderColor: accent }}>
        <div>
          <p className="text-[#bfc8cc] text-[10px] uppercase tracking-widest">AI Prediction</p>
          <p className="text-white text-2xl font-black mt-0.5">{finalPct}<span className="text-sm font-medium text-[#bfc8cc]">%</span></p>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium"
          style={{ color: accent, borderColor: `${accent}40`, backgroundColor: `${accent}15` }}>
          <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: accent }} />
          Live Model
        </div>
      </div>
    </div>
  );
}

/* ─── Confidence badge ──────────────────────────── */
function ConfidenceBadge({ pct }: { pct: number }) {
  const label = pct >= 70 ? "High Confidence" : pct >= 55 ? "Moderate" : pct >= 45 ? "Even Match" : "Underdog Pick";
  const cls = pct >= 70 ? "bg-green-500/20 text-green-400 border-green-500/30" :
    pct >= 55 ? "bg-[#86d1ea]/20 text-[#86d1ea] border-[#86d1ea]/30" :
    pct >= 45 ? "bg-yellow-500/20 text-yellow-400 border-yellow-500/30" :
    "bg-red-500/20 text-red-400 border-red-500/30";
  return (
    <span className={`border rounded-full px-3 py-1 text-xs font-medium ${cls}`}>{label}</span>
  );
}

/* ─── Form dots ────────────────────────────────── */
function FormDots({ results }: { results: ("W" | "L" | "OT")[] }) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {results.map((r, i) => (
        <div key={i} className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold ${
          r === "W" ? "bg-green-500/20 text-green-400 border border-green-500/30" :
          r === "OT" ? "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30" :
          "bg-red-500/20 text-red-400 border border-red-500/30"
        }`}>{r}</div>
      ))}
    </div>
  );
}




/* --- Loading skeleton --- */
function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {[1,2,3,4].map(i => <div key={i} className="h-20 bg-[#111a1f] rounded-2xl animate-pulse" />)}
    </div>
  );
}

/* ─── Team Prediction ─────────────────────────── */
function TeamPrediction({ teamId }: { teamId: string }) {
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
          logo: teamEmoji(abbr),
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
  const teamGroups: MktGroup[] = [
    {
      id: "match", title: "Match Betting", cols: 2,
      options: [
        { id: "t-win",  label: `${data.abbr} Wins (ML)`,       rulePct: hp,
          ruleNote: `Season win rate of ${hp}% based on ${data.pts} pts, record ${data.homeRecord} home / ${data.awayRecord} away.` },
        { id: "t-lose", label: `${data.abbr} Loses (ML)`,      rulePct: 100 - hp,
          ruleNote: `Inverse of win probability: ${100 - hp}%. Current streak: ${data.streak || "—"}.` },
        { id: "t-ml-ot",label: "Match Goes to OT",             rulePct: 22,
          ruleNote: "~22-24% of NHL games go to OT/SO regardless of team strength." },
        { id: "t-dc",   label: `${data.abbr} Wins or OT`,      rulePct: Math.min(90, hp + 14),
          ruleNote: "Double chance: team wins OR game goes to overtime." },
      ],
    },
    {
      id: "puckline", title: "Puck Line", cols: 2,
      options: [
        { id: "t-pl-fav", label: `${data.abbr} -1.5`,          rulePct: Math.max(10, hp - 18),
          ruleNote: "Win by 2+ goals — ~18% harder than a straight moneyline win." },
        { id: "t-pl-dog", label: `${data.abbr} +1.5`,          rulePct: Math.min(90, hp + 18),
          ruleNote: "Win OR lose by 1 goal. Probability boosted ~18% vs straight moneyline." },
      ],
    },
    {
      id: "totals", title: "Team Goals", cols: 2,
      options: [
        { id: "t-over",    label: `Over ${ou}`,                  rulePct: 54,
          ruleNote: `Based on ${data.abbr}'s ${data.goalsFor.toFixed(2)} goals/game average.` },
        { id: "t-under",   label: `Under ${ou}`,                 rulePct: 46,
          ruleNote: `${data.abbr} allows ${data.goalsAgainst.toFixed(2)} goals/game. Solid defense could keep this low.` },
        { id: "t-team-over", label: `${data.abbr} Over 2.5`,   rulePct: Math.min(80, Math.round(data.goalsFor * 22 + 5)),
          ruleNote: `${data.abbr} averages ${data.goalsFor.toFixed(2)} goals/game. Scoring 3+ requires above-average output.` },
        { id: "t-team-under",label: `${data.abbr} Under 2.5`,  rulePct: Math.max(20, 100 - Math.min(80, Math.round(data.goalsFor * 22 + 5))),
          ruleNote: `${data.abbr} held under 3 goals in a significant portion of games.` },
      ],
    },
    {
      id: "clean", title: "Clean Sheet / Both Score", cols: 2,
      options: [
        { id: "t-cs",   label: `${data.abbr} Shutout`,          rulePct: Math.max(8, Math.round((100 - data.pkPct) * 0.20)),
          ruleNote: `Shutouts happen in ~15-22% of games. ${data.abbr}'s PK at ${data.pkPct.toFixed(1)}% is a factor.` },
        { id: "t-btts", label: "Both Teams Score",               rulePct: Math.min(88, Math.round(data.goalsFor * 18 + data.goalsAgainst * 12 + 25)),
          ruleNote: "Both offenses producing. Very common in NHL (~75-80% of games)." },
      ],
    },
    {
      id: "period", title: "Period Results", cols: 3,
      options: [
        { id: "t-p1", label: `${data.abbr} Leads P1`,           rulePct: Math.round(hp * 0.42 + 10),
          ruleNote: `${data.abbr} leads after the 1st period in ~${Math.round(hp * 0.42 + 10)}% of games.` },
        { id: "t-p2", label: `${data.abbr} Leads P2`,           rulePct: Math.round(hp * 0.44 + 8),
          ruleNote: `${data.abbr} leads after P2. More predictive than P1.` },
        { id: "t-p3", label: `${data.abbr} Leads P3`,           rulePct: Math.round(hp * 0.48 + 6),
          ruleNote: `Leading after P3 strongly correlates with winning the game.` },
      ],
    },
    {
      id: "pp", title: "Special Teams", cols: 2,
      options: [
        { id: "t-pp-goal", label: `${data.abbr} PP Goal`,       rulePct: Math.min(75, Math.round(data.ppPct * 1.8)),
          ruleNote: `${data.abbr}'s power play is at ${data.ppPct.toFixed(1)}%. League avg is ~20%. Scoring on the PP ~${Math.min(75, Math.round(data.ppPct * 1.8))}% of games.` },
        { id: "t-pk",      label: `${data.abbr} Kills All PKs`, rulePct: Math.min(80, Math.round(data.pkPct * 0.9)),
          ruleNote: `${data.abbr} penalty kill at ${data.pkPct.toFixed(1)}%. Successfully killing all penalties ~${Math.min(80, Math.round(data.pkPct * 0.9))}% of games.` },
      ],
    },
    {
      id: "margin", title: "Winning Margin", cols: 3,
      options: [
        { id: "t-w1", label: `${data.abbr} by 1`, rulePct: Math.round(hp * 0.18),
          ruleNote: "One-goal wins are the most common margin in the NHL." },
        { id: "t-w2", label: `${data.abbr} by 2`, rulePct: Math.round(hp * 0.13),
          ruleNote: "Two-goal victory — comfortable but not a blowout." },
        { id: "t-w3", label: `${data.abbr} by 3+`, rulePct: Math.round(hp * 0.09),
          ruleNote: "Blowout wins are less frequent, even for dominant teams." },
      ],
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      {/* Team header */}
      <div className="bg-[#111a1f] border border-white/20 rounded-2xl p-4">
        <div className="flex items-center gap-3 mb-3">
          <span className="text-4xl">{data.logo}</span>
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
            <div key={s.label} className="bg-[#0a1014] rounded-xl p-2 text-center">
              <p className="text-white text-xs font-bold">{s.value}</p>
              <p className="text-[#8a9ea6] text-[9px]">{s.label}</p>
            </div>
          ))}
        </div>
      </div>
      {/* Market groups — API predictions when available, local fallback otherwise */}
      {(apiGroups ?? teamGroups).map(g => <MarketGroup key={g.id} group={g} accent={accent} />)}
      {!apiGroups && <p className="text-[#4a6070] text-[10px] text-center mt-1">Connecting to prediction engine…</p>}

      {/* AI/ML prediction section */}
      <MLSection type="team" subjectId={teamId} propType="moneyline" ruleBasedPct={data.winPct} />
    </div>
  );
}

/* ─── Game Prediction ──────────────── */
const TEAM_LOGOS_PRED: Record<string, string> = {
  BOS: "🐻", NYR: "🗽", TOR: "🍁", MTL: "🔵",
  CHI: "🦅", DET: "🏒", VGK: "⚔", EDM: "🛢",
  COL: "⛰", FLA: "🐆",
};

interface LiveGameView {
  id: string;
  home: { abbr: string; name: string; logo: string; score?: number; winPct: number };
  away: { abbr: string; name: string; logo: string; score?: number; winPct: number };
  period?: string; time?: string; overUnder: number;
}

/* ─── Bet types & market groups ─────────────── */
interface BetOpt { id: string; label: string; rulePct: number; ruleNote: string; }
interface MktGroup { id: string; title: string; cols: 2 | 3; options: BetOpt[]; }

function buildGameGroups(home: string, away: string, hp: number, ou: number): MktGroup[] {
  const ap = 100 - hp;
  return [
    {
      id: "match", title: "Match Betting", cols: 3,
      options: [
        { id: "ml-home",  label: `${home} to Win`,   rulePct: hp,
          ruleNote: `Win probability based on season stats: ${hp}%. Home ice advantage is included in the calculation.` },
        { id: "ml-ot",    label: "OT / Shootout",     rulePct: 22,
          ruleNote: `~22-24% of NHL games go to OT or shootout, regardless of team strength.` },
        { id: "ml-away",  label: `${away} to Win`,   rulePct: ap,
          ruleNote: `Inverse of home probability: ${ap}%. Visitors carry a slight systemic disadvantage.` },
      ],
    },
    {
      id: "puckline", title: "Puck Line", cols: 2,
      options: [
        { id: "pl-home", label: `${home} -1.5`, rulePct: Math.max(10, hp - 18),
          ruleNote: `Winning by 2+ is ~18% harder than a straight win. Calculated from historical goal-differential data.` },
        { id: "pl-away", label: `${away} +1.5`, rulePct: Math.min(90, ap + 18),
          ruleNote: `Covering +1.5 means winning OR losing by exactly 1. Probability boosted ~18% vs moneyline.` },
      ],
    },
    {
      id: "totals", title: "Total Goals", cols: 2,
      options: [
        { id: "ou-over",     label: `Over ${ou}`,     rulePct: 54,
          ruleNote: `Based on combined offensive averages. The ${ou} line aligns with the NHL average of ~6.0 goals/game.` },
        { id: "ou-under",    label: `Under ${ou}`,    rulePct: 46,
          ruleNote: `Strong defense and tight games favor the under. Slightly less likely when both teams score well.` },
        { id: "ou-over-alt", label: `Over ${ou + 1}`, rulePct: 38,
          ruleNote: `Higher alternate line — requires a more open, high-scoring game to hit.` },
        { id: "ou-under-alt",label: `Under ${ou + 1}`,rulePct: 62,
          ruleNote: `Easier to hit — any defensive performance from either team keeps this alive.` },
      ],
    },
    {
      id: "btts", title: "Both Teams to Score", cols: 2,
      options: [
        { id: "btts-yes", label: "Yes", rulePct: Math.min(88, Math.round(hp * 0.42 + ap * 0.40 + 20)),
          ruleNote: `Both offenses producing at least one goal. Very common in NHL (~75-80% of games).` },
        { id: "btts-no",  label: "No",  rulePct: Math.max(12, 100 - Math.min(88, Math.round(hp * 0.42 + ap * 0.40 + 20))),
          ruleNote: `Requires one team to be shut out — only ~15-25% of NHL games end this way.` },
      ],
    },
    {
      id: "dc", title: "Double Chance", cols: 2,
      options: [
        { id: "dc-home", label: `${home} or OT`, rulePct: Math.min(90, hp + 15),
          ruleNote: `Covers home win + OT/SO result. Two outcomes bundled into one bet.` },
        { id: "dc-away", label: `${away} or OT`, rulePct: Math.min(85, ap + 15),
          ruleNote: `Covers away win + OT/SO. Less likely when home team is a heavy favorite.` },
      ],
    },
    {
      id: "p1", title: "1st Period Result", cols: 3,
      options: [
        { id: "p1-home", label: `${home} leads`, rulePct: Math.round(hp * 0.42 + 10),
          ruleNote: `Home teams lead after P1 in ~${Math.round(hp * 0.42 + 10)}% of cases. Linked to early offensive momentum.` },
        { id: "p1-draw", label: "Tied",           rulePct: 30,
          ruleNote: `Tied after P1 in ~25-35% of NHL games. Common in balanced matchups.` },
        { id: "p1-away", label: `${away} leads`, rulePct: Math.round(ap * 0.38 + 8),
          ruleNote: `Visitors lead after P1 in ~${Math.round(ap * 0.38 + 8)}% of cases — harder without home crowd.` },
      ],
    },
    {
      id: "p1goals", title: "1st Period Goals", cols: 2,
      options: [
        { id: "p1-over", label: "Over 1.5",  rulePct: 37,
          ruleNote: `~37% of NHL games see 2+ goals in the first period.` },
        { id: "p1-under",label: "Under 1.5", rulePct: 63,
          ruleNote: `First periods often start cautiously — under 1.5 hits ~63% of the time.` },
      ],
    },
    {
      id: "p2", title: "2nd Period Result", cols: 3,
      options: [
        { id: "p2-home", label: `${home} leads`, rulePct: Math.round(hp * 0.44 + 8),
          ruleNote: `More predictive than P1 since more play has unfolded.` },
        { id: "p2-draw", label: "Tied",           rulePct: 28,
          ruleNote: `Tied after P2 in ~25-32% of games.` },
        { id: "p2-away", label: `${away} leads`, rulePct: Math.round(ap * 0.40 + 7),
          ruleNote: `Away team holding a lead after two periods.` },
      ],
    },
    {
      id: "p3", title: "3rd Period Result", cols: 3,
      options: [
        { id: "p3-home", label: `${home} leads`, rulePct: Math.round(hp * 0.48 + 6),
          ruleNote: `Leading after P3 strongly correlates with the final result.` },
        { id: "p3-draw", label: "Tied → OT",      rulePct: 20,
          ruleNote: `Tied after regulation forces OT/SO — happens in ~20-22% of games.` },
        { id: "p3-away", label: `${away} leads`, rulePct: Math.round(ap * 0.44 + 5),
          ruleNote: `Away team ahead heading into OT or winning in regulation.` },
      ],
    },
    {
      id: "ot", title: "Extra Time", cols: 2,
      options: [
        { id: "ot-yes", label: "Goes to OT",      rulePct: 22,
          ruleNote: `~22-24% of NHL games go to overtime, independent of the teams involved.` },
        { id: "ot-no",  label: "Decided in Reg",  rulePct: 78,
          ruleNote: `Most games (78%) are decided inside regulation time.` },
      ],
    },
    {
      id: "margin", title: "Winning Margin", cols: 3,
      options: [
        { id: "wm-h1", label: `${home} by 1`,  rulePct: Math.round(hp * 0.18),
          ruleNote: `One-goal wins are the most common margin in NHL hockey.` },
        { id: "wm-h2", label: `${home} by 2`,  rulePct: Math.round(hp * 0.13),
          ruleNote: `Two-goal wins: comfortable but not a blowout.` },
        { id: "wm-h3", label: `${home} by 3+`, rulePct: Math.round(hp * 0.09),
          ruleNote: `Blowout win — less common but more likely for dominant home teams.` },
        { id: "wm-a1", label: `${away} by 1`,  rulePct: Math.round(ap * 0.16),
          ruleNote: `Narrow away win — common when teams are evenly matched.` },
        { id: "wm-a2", label: `${away} by 2`,  rulePct: Math.round(ap * 0.11),
          ruleNote: `Away win by two goals.` },
        { id: "wm-a3", label: `${away} by 3+`, rulePct: Math.round(ap * 0.07),
          ruleNote: `Away blowout — rare but possible when visitors are heavily favored.` },
      ],
    },
    {
      id: "firstlast", title: "Goal Scorer", cols: 2,
      options: [
        { id: "first-home", label: `${home} scores first`, rulePct: Math.round(hp * 0.56 + 5),
          ruleNote: `Correlated with win probability. Favorites open the scoring more often.` },
        { id: "first-away", label: `${away} scores first`, rulePct: Math.round(ap * 0.52 + 4),
          ruleNote: `Away team drawing first blood.` },
        { id: "last-home",  label: `${home} scores last`,  rulePct: Math.round(hp * 0.54 + 4),
          ruleNote: `Final goal lightly correlates with overall team performance.` },
        { id: "last-away",  label: `${away} scores last`,  rulePct: Math.round(ap * 0.50 + 3),
          ruleNote: `Away team scoring the last goal of the game.` },
      ],
    },
  ];
}

/* ─── Prediction bottom sheet ───────────────── */
function PredictionSheet({ label, rulePct, ruleNote, accent, onClose }: {
  label: string; rulePct: number; ruleNote: string; accent: string; onClose: () => void;
}) {
  const [llmText, setLlmText] = useState("");
  const [llmLoading, setLlmLoading] = useState(false);
  const pctColor = rulePct >= 65 ? "#4ade80" : rulePct >= 50 ? accent : rulePct >= 38 ? "#facc15" : "#f87171";

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end"
      style={{ background: "rgba(0,0,0,0.72)" }}
      onClick={onClose}
    >
      <div
        className="bg-[#0d1519] rounded-t-3xl flex flex-col gap-4 max-h-[82vh] overflow-y-auto"
        style={{ padding: "20px 20px 44px" }}
        onClick={e => e.stopPropagation()}
      >
        <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-1" />
        <p className="text-white font-bold text-base leading-snug">{label}</p>

        {/* Rules */}
        <div className="bg-[#111a1f] border border-white/10 rounded-2xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm">📐</span>
            <span className="text-[#bfc8cc] text-xs font-semibold uppercase tracking-wide">Règles statistiques</span>
            <span className="ml-auto text-2xl font-black" style={{ color: pctColor }}>{rulePct}%</span>
          </div>
          <p className="text-[#8a9ea6] text-xs leading-relaxed">{ruleNote}</p>
        </div>

        {/* ML placeholder */}
        <div className="bg-[#111a1f] border border-white/10 rounded-2xl p-4" style={{ opacity: 0.55 }}>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm">🤖</span>
            <span className="text-[#bfc8cc] text-xs font-semibold uppercase tracking-wide">Modèle ML</span>
            <span className="ml-auto text-[10px] bg-[#1a2a2f] text-[#8a9ea6] px-2 py-0.5 rounded-full">À venir</span>
          </div>
          <div className="h-2 bg-[#1a2a2f] rounded-full w-3/4 animate-pulse" />
        </div>

        {/* LLM */}
        {llmText ? (
          <div className="bg-purple-500/10 border border-purple-500/30 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm">✨</span>
              <span className="text-purple-300 text-xs font-semibold">Analyse LLM</span>
            </div>
            <p className="text-[#bfc8cc] text-xs leading-relaxed">{llmText}</p>
          </div>
        ) : (
          <button
            disabled={llmLoading}
            onClick={async () => {
              setLlmLoading(true);
              await new Promise(r => setTimeout(r, 1400));
              setLlmText(`Analyse pour « ${label} » : probabilité estimée à ${rulePct}% selon le modèle de règles. Les tendances récentes et les facteurs contextuels supportent cette estimation. À connecter à un LLM réel pour une analyse approfondie.`);
              setLlmLoading(false);
            }}
            className="w-full py-3 rounded-2xl text-sm font-bold flex items-center justify-center gap-2 active:scale-[0.97] transition-transform"
            style={{ background: llmLoading ? "#1a2a2f" : "linear-gradient(135deg,#7c3aed,#a855f7)", color: "#fff", border: "1px solid rgba(168,85,247,0.3)" }}
          >
            {llmLoading
              ? <><span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin inline-block" /> Analyse en cours...</>
              : <>✨ Ask LLM</>}
          </button>
        )}

        <button
          onClick={onClose}
          className="w-full py-3 bg-[#111a1f] border border-white/20 rounded-2xl text-[#8a9ea6] text-sm font-medium"
        >
          Fermer
        </button>
      </div>
    </div>
  );
}

/* ─── BetOption ─────────────────────────────── */
function BetOption({ opt, accent }: { opt: BetOpt; accent: string }) {
  const [revealed, setRevealed] = useState(false);
  const [sheet, setSheet] = useState(false);
  const pctColor = opt.rulePct >= 65 ? "#4ade80" : opt.rulePct >= 50 ? accent : opt.rulePct >= 38 ? "#facc15" : "#f87171";

  return (
    <>
      <button
        onClick={() => setRevealed(v => !v)}
        className="flex flex-col items-center justify-between p-3 rounded-xl border transition-all active:scale-[0.97] w-full"
        style={{
          minHeight: 64,
          background: revealed ? "#111a1f" : "#0d1519",
          borderColor: revealed ? pctColor + "55" : "rgba(255,255,255,0.08)",
        }}
      >
        <span className="text-white text-[11px] font-medium text-center leading-tight">{opt.label}</span>
        {revealed ? (
          <button
            onClick={e => { e.stopPropagation(); setSheet(true); }}
            className="mt-2 px-3 py-0.5 rounded-full text-xs font-bold active:scale-95 transition-transform"
            style={{ background: pctColor + "22", color: pctColor, border: `1px solid ${pctColor}55` }}
          >
            {opt.rulePct}%
          </button>
        ) : (
          <span className="mt-2 text-[#3a5060] text-[9px] font-medium">Tap</span>
        )}
      </button>
      {sheet && (
        <PredictionSheet
          label={opt.label} rulePct={opt.rulePct} ruleNote={opt.ruleNote}
          accent={accent} onClose={() => setSheet(false)}
        />
      )}
    </>
  );
}

/* ─── MarketGroup ───────────────────────────── */
function MarketGroup({ group, accent }: { group: MktGroup; accent: string }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="bg-[#0a1014] border border-white/[0.07] rounded-2xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3"
        style={{ borderBottom: open ? "1px solid rgba(255,255,255,0.06)" : "none" }}
      >
        <span className="text-[#c0cdd4] text-xs font-semibold uppercase tracking-wider">{group.title}</span>
        <span className="text-[#3a5060] text-xs">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div
          className="p-3 grid gap-2"
          style={{ gridTemplateColumns: `repeat(${group.cols}, 1fr)` }}
        >
          {group.options.map(opt => (
            <BetOption key={opt.id} opt={opt} accent={accent} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── GamePrediction ────────────────────────── */
function GamePrediction({ gameId }: { gameId: string }) {
  const { theme } = useSport();
  const accent = theme.accent;
  const [gameView, setGameView] = useState<LiveGameView | null>(null);
  const [apiGroups, setApiGroups] = useState<MktGroup[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const staticGame = getGameById(gameId);
      if (staticGame) {
        const t1 = getTeamById(staticGame.team1Id);
        const t2 = getTeamById(staticGame.team2Id);
        if (t1 && t2) {
          setGameView({ id: gameId,
            home: { abbr: t1.abbr, name: t1.name, logo: t1.logo, winPct: staticGame.winPct1 },
            away: { abbr: t2.abbr, name: t2.name, logo: t2.logo, winPct: staticGame.winPct2 },
            time: staticGame.time, overUnder: staticGame.overUnder });
          setLoading(false);
          return;
        }
      }
      try {
        const [nhlGame, homePred] = await Promise.all([
          nhlApiService.getGame(gameId),
          predictionApiService.getSinglePrediction({ marketType: "moneyline", gameId, teamId: "" })
            .catch(() => ({ probability: 55 })),
        ]);
        setGameView({
          id: gameId,
          home: {
            abbr: nhlGame.homeTeam.abbreviation, name: nhlGame.homeTeam.name,
            logo: TEAM_LOGOS_PRED[nhlGame.homeTeam.abbreviation] ?? "🏒",
            score: nhlGame.homeTeam.score, winPct: homePred.probability,
          },
          away: {
            abbr: nhlGame.awayTeam.abbreviation, name: nhlGame.awayTeam.name,
            logo: TEAM_LOGOS_PRED[nhlGame.awayTeam.abbreviation] ?? "🏒",
            score: nhlGame.awayTeam.score, winPct: 100 - homePred.probability,
          },
          period: nhlGame.period ? nhlGame.period + "P • " + nhlGame.clock : undefined,
          time: nhlGame.startTime,
          overUnder: 5.5,
        });
      } catch (e) {
        console.error("GamePrediction fetch error", e);
      }
      setLoading(false);
    }
    load();
    // Fetch rule-based predictions from backend (parallel, non-blocking)
    nhlApiService.getGamePredictions(gameId).then(setApiGroups).catch(() => {});
  }, [gameId]);

  if (loading) return (
    <div className="flex flex-col gap-3">
      {[1,2,3,4].map(i => <div key={i} className="h-16 bg-[#111a1f] rounded-2xl animate-pulse" />)}
    </div>
  );
  if (!gameView) return <NotFound />;

  const { home, away } = gameView;
  const isLive = !!gameView.period;
  const finalPct = Math.min(85, Math.max(15, home.winPct));
  const localGroups = buildGameGroups(home.abbr, away.abbr, finalPct, gameView.overUnder ?? 5.5);
  const groups = apiGroups ?? localGroups;

  return (
    <div className="flex flex-col gap-3">
      {/* ── Match header ── */}
      <div className="bg-[#111a1f] border border-white/20 rounded-2xl p-4">
        {isLive && (
          <div className="flex items-center justify-center gap-1.5 mb-3">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            <span className="text-red-400 text-[10px] font-semibold uppercase tracking-widest">{gameView.period}</span>
          </div>
        )}
        <div className="flex items-center justify-between">
          <div className="flex flex-col items-center gap-1.5 flex-1">
            <span className="text-4xl">{home.logo}</span>
            <span className="text-white text-sm font-bold">{home.name}</span>
            {home.score !== undefined && <span className="text-white text-3xl font-black">{home.score}</span>}
          </div>
          <div className="flex flex-col items-center gap-1 px-2">
            {!isLive && <span className="text-[#8a9ea6] text-xs">{gameView.time ?? "Today"}</span>}
            <span className="text-[#8a9ea6] font-bold text-base">VS</span>
            <span className="text-[#4a6070] text-[10px]">O/U {gameView.overUnder}</span>
          </div>
          <div className="flex flex-col items-center gap-1.5 flex-1">
            <span className="text-4xl">{away.logo}</span>
            <span className="text-white text-sm font-bold">{away.name}</span>
            {away.score !== undefined && <span className="text-white text-3xl font-black">{away.score}</span>}
          </div>
        </div>
      </div>

      {/* ── Market groups ── */}
      {groups.map(g => <MarketGroup key={g.id} group={g} accent={accent} />)}
      {!apiGroups && <p className="text-[#4a6070] text-[10px] text-center mt-1">Connecting to prediction engine…</p>}

      {/* AI/ML prediction section */}
      {gameView && (
        <MLSection
          type="game"
          subjectId={gameView.home.abbr}
          opponentId={gameView.away.abbr}
          propType="moneyline"
          ruleBasedPct={gameView.home.winPct}
        />
      )}
    </div>
  );
}

/* ─── Player Prediction ──────────────────────── */
function PlayerPrediction({ playerId }: { playerId: string }) {
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

  useEffect(() => {
    async function load() {
      try {
        const [info, stats] = await Promise.all([
          nhlApiService.getPlayer(playerId),
          nhlApiService.getPlayerStats(playerId),
        ]);
        const name = info.fullName ?? `${info.firstName} ${info.lastName}`;
        const gp = stats.gamesPlayed || 1;
        setData({
          name, team: info.teamAbbr ?? "",
          logo: teamEmoji(info.teamAbbr ?? ""),
          position: info.position, number: info.jerseyNumber,
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
          ruleNote: "Goalies face ~28-32 shots per game on average. Saving 26+ is likely in most games." },
        { id: "g-saves-under",label: "Under 25.5 Saves",rulePct: 38,
          ruleNote: "Fewer than 26 saves usually means a lower-shot game or an early pull." },
        { id: "g-saves-over2", label: "Over 28.5 Saves", rulePct: 44,
          ruleNote: "Higher threshold — requires above-average shot volume against." },
        { id: "g-saves-under2",label: "Under 28.5 Saves",rulePct: 56,
          ruleNote: "More common line — under 29 saves covers most average-shot games." },
      ],
    },
    {
      id: "goalie-result", title: "Game Result", cols: 2,
      options: [
        { id: "g-win",    label: "Goalie Win",   rulePct: 50,
          ruleNote: "Winning goalie probability based on team win rate." },
        { id: "g-shutout",label: "Shutout",      rulePct: 10,
          ruleNote: "Complete shutouts happen in ~10-15% of NHL starts." },
      ],
    },
  ] : [
    {
      id: "scoring", title: "Goal Scoring", cols: 2,
      options: [
        { id: "p-anytime", label: "Anytime Goal Scorer", rulePct: poi(gpg),
          ruleNote: `Poisson model: ${gpg.toFixed(3)} goals/game → P(≥1 goal) = ${poi(gpg)}%. Based on ${data.goals} goals in ${gp} games.` },
        { id: "p-first",   label: "First Goal Scorer",   rulePct: Math.max(3, Math.round(poi(gpg) / 6)),
          ruleNote: `Being the first scorer is rare (~5-10% per player). Scaled from anytime probability of ${poi(gpg)}%.` },
        { id: "p-over05",  label: "Goals Over 0.5",      rulePct: poi(gpg),
          ruleNote: `Same as anytime scorer — probability of scoring at least 1 goal.` },
        { id: "p-over15",  label: "Goals Over 1.5",      rulePct: poi(gpg * 2) - poi(gpg),
          ruleNote: `Scoring 2+ goals in a game. Based on extended Poisson with rate ${gpg.toFixed(3)}/game.` },
      ],
    },
    {
      id: "assists", title: "Assists", cols: 2,
      options: [
        { id: "p-assist",      label: "Any Assist",          rulePct: poi(apg),
          ruleNote: `Poisson model: ${apg.toFixed(3)} assists/game → P(≥1 assist) = ${poi(apg)}%. Based on ${data.assists} assists in ${gp} games.` },
        { id: "p-assist-over", label: "Assists Over 0.5",    rulePct: poi(apg),
          ruleNote: `Probability of recording at least one assist.` },
        { id: "p-point",       label: "Any Point (G or A)",  rulePct: poi(ppg),
          ruleNote: `Poisson model: ${ppg.toFixed(3)} pts/game → P(≥1 point) = ${poi(ppg)}%. Based on ${data.points} points in ${gp} games.` },
        { id: "p-multi-point", label: "Multi-Point Game",    rulePct: Math.min(60, Math.round(poi(ppg) * 0.35)),
          ruleNote: `Recording 2+ points in one game. Less common — roughly 1/3 of point games.` },
      ],
    },
    ...(data.shots > 0 ? [{
      id: "shots", title: "Shots on Goal", cols: 2,
      options: [
        { id: "p-shots-over",  label: `Shots Over ${Math.floor(spg + 0.5)}.5`,  rulePct: 52,
          ruleNote: `${data.name} averages ${spg.toFixed(1)} shots/game. The line is close to their average.` },
        { id: "p-shots-under", label: `Shots Under ${Math.floor(spg + 0.5)}.5`, rulePct: 48,
          ruleNote: `Shooting below their ${spg.toFixed(1)}/game average is possible in any matchup.` },
        { id: "p-shots-over2", label: `Shots Over ${Math.ceil(spg + 1)}.5`,      rulePct: 38,
          ruleNote: `Higher threshold — requires an active game for ${data.name}.` },
        { id: "p-shots-under2",label: `Shots Under ${Math.ceil(spg + 1)}.5`,     rulePct: 62,
          ruleNote: `Easier to hit — any quiet game keeps ${data.name} under this threshold.` },
      ],
    } as MktGroup] : []),
    ...(data.hits > 0 ? [{
      id: "hits", title: "Hits", cols: 2,
      options: [
        { id: "p-hits-over",  label: `Hits Over ${Math.floor(hpg)}.5`,  rulePct: 52,
          ruleNote: `${data.name} averages ${hpg.toFixed(1)} hits/game.` },
        { id: "p-hits-under", label: `Hits Under ${Math.floor(hpg)}.5`, rulePct: 48,
          ruleNote: `Below-average hit game for ${data.name}.` },
      ],
    } as MktGroup] : []),
    ...(data.blocks > 0 ? [{
      id: "blocks", title: "Blocked Shots", cols: 2,
      options: [
        { id: "p-blocks-over",  label: `Blocks Over ${Math.floor(bpg)}.5`,  rulePct: 50,
          ruleNote: `${data.name} averages ${bpg.toFixed(1)} blocked shots/game.` },
        { id: "p-blocks-under", label: `Blocks Under ${Math.floor(bpg)}.5`, rulePct: 50,
          ruleNote: `Blocked shots are highly situational depending on the game flow.` },
      ],
    } as MktGroup] : []),
    ...(data.ppPoints > 0 ? [{
      id: "pp", title: "Power Play", cols: 2,
      options: [
        { id: "p-pp-point", label: "PP Point",         rulePct: Math.min(70, Math.round((data.ppPoints / gp) * 200)),
          ruleNote: `${data.name} has ${data.ppPoints} PP points in ${gp} games (${(data.ppPoints/gp).toFixed(2)}/game).` },
        { id: "p-pp-goal",  label: "PP Goal",          rulePct: Math.min(50, Math.round((data.ppPoints / gp) * 100)),
          ruleNote: `PP goals are less common than PP assists. Scaled from PP point probability.` },
      ],
    } as MktGroup] : []),
    ...(data.penaltyMin > 0 ? [{
      id: "pim", title: "Penalty Minutes", cols: 2,
      options: [
        { id: "p-pim-over",  label: `PIM Over 0.5`,   rulePct: Math.min(70, Math.round((data.penaltyMin / gp) * 100)),
          ruleNote: `${data.name} averages ${(data.penaltyMin/gp).toFixed(2)} penalty minutes/game.` },
        { id: "p-pim-under", label: `PIM Under 0.5`,  rulePct: Math.max(30, 100 - Math.min(70, Math.round((data.penaltyMin / gp) * 100))),
          ruleNote: `Staying out of the penalty box — common for disciplined players.` },
      ],
    } as MktGroup] : []),
  ];

  return (
    <div className="flex flex-col gap-3">
      {/* Player header */}
      <div className="bg-[#111a1f] border border-white/20 rounded-2xl p-4">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-12 h-12 rounded-2xl bg-[#1a2a2f] flex items-center justify-center text-2xl">{data.logo}</div>
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
            <div key={s.label} className="bg-[#0a1014] rounded-xl p-2 text-center">
              <p className="text-white text-sm font-bold">{s.value}</p>
              <p className="text-[#8a9ea6] text-[9px]">{s.label}</p>
            </div>
          ))}
        </div>
      </div>
      {/* Market groups — API predictions when available, local fallback otherwise */}
      {(apiGroups ?? playerGroups).map(g => <MarketGroup key={g.id} group={g} accent={accent} />)}
      {!apiGroups && <p className="text-[#4a6070] text-[10px] text-center mt-1">Connecting to prediction engine…</p>}

      {/* AI/ML prediction section */}
      <MLSection
        type="player"
        subjectId={playerId}
        propType="goals"
        line={0.5}
        selection="over"
        ruleBasedPct={Math.round(data.goalsPerGame * 100)}
      />
    </div>
  );
}

function NGamesPrediction({ teamId, n }: { teamId: string; n: number }) {
  const { theme } = useSport();
  const accent = theme.accent;
  const [view, setView] = useState<NGamesView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);

    async function load() {
      try {
        const [teams, stats] = await Promise.all([
          nhlApiService.getAllTeams(),
          nhlApiService.getTeamLastNGamesStats(teamId, n),
        ]);

        if (!alive) return;

        // Match team by abbreviation (teamId is lowercase abbr from useNHLData)
        const teamInfo = teams.find(
          (t) => t.abbreviation?.toLowerCase() === teamId.toLowerCase()
        );
        const abbr = teamInfo?.abbreviation ?? teamId.toUpperCase();
        const totalGames = stats.wins + stats.losses + (stats.otLosses ?? 0);
        const winRateN = totalGames > 0
          ? Math.round((stats.wins / totalGames) * 100)
          : Math.round((stats.wins / n) * 100);

        setView({
          teamName:        teamInfo?.name ?? abbr,
          teamAbbr:        abbr,
          logo:            TEAM_LOGOS_NGAMES[abbr] ?? "🏒",
          wins:            stats.wins,
          losses:          stats.losses,
          otLosses:        stats.otLosses ?? 0,
          goalsFor:        stats.goalsFor,
          goalsAgainst:    stats.goalsAgainst,
          goalsForPerGame: stats.goalsForPerGame  ?? +(stats.goalsFor  / n).toFixed(2),
          goalsAgainstPerGame: stats.goalsAgainstPerGame ?? +(stats.goalsAgainst / n).toFixed(2),
          ppPct:           stats.powerPlayPct   ?? 0,
          pkPct:           stats.penaltyKillPct ?? 0,
          streak:          stats.streak  ?? "",
          last10:          stats.last10  ?? "",
          winRateN,
        });
      } catch (err) {
        console.error("NGamesPrediction fetch error", err);
        // Graceful fallback — estimate from n
        if (alive) {
          setView({
            teamName: teamId.toUpperCase(), teamAbbr: teamId.toUpperCase(),
            logo: TEAM_LOGOS_NGAMES[teamId.toUpperCase()] ?? "🏒",
            wins: Math.round(n * 0.55), losses: Math.round(n * 0.35),
            otLosses: Math.round(n * 0.10),
            goalsFor: +(n * 3.1).toFixed(1), goalsAgainst: +(n * 2.8).toFixed(1),
            goalsForPerGame: 3.1, goalsAgainstPerGame: 2.8,
            ppPct: 21, pkPct: 80, streak: "?", last10: "?",
            winRateN: 55,
          });
        }
      } finally {
        if (alive) setLoading(false);
      }
    }

    load();
    return () => { alive = false; };
  }, [teamId, n]);

  if (loading) return (
    <div className="flex flex-col gap-3">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="h-20 bg-[#111a1f] rounded-2xl animate-pulse" />
      ))}
    </div>
  );

  if (!view) return <NotFound />;

  const leagueAvgGF  = 3.0;
  const leagueAvgGA  = 3.0;
  const leagueAvgPP  = 20;
  const leagueAvgPK  = 80;

  const calcFactors: CalcFactor[] = [
    {
      icon: "🏆",
      label: `Last ${n} record: ${view.wins}W – ${view.losses}L – ${view.otLosses}OT`,
      delta: Math.round(((view.winRateN - 50) / 100) * 20),
    },
    {
      icon: "🥅",
      label: `Goals for/game: ${view.goalsForPerGame.toFixed(2)} vs league avg ${leagueAvgGF}`,
      delta: Math.round((view.goalsForPerGame - leagueAvgGF) * 6),
    },
    {
      icon: "🔒",
      label: `Goals against/game: ${view.goalsAgainstPerGame.toFixed(2)} vs league avg ${leagueAvgGA}`,
      delta: Math.round((leagueAvgGA - view.goalsAgainstPerGame) * 6),
    },
    {
      icon: "⚡",
      label: `Power play: ${view.ppPct.toFixed(1)}% (league avg ${leagueAvgPP}%)`,
      delta: Math.round((view.ppPct - leagueAvgPP) / 2),
    },
    {
      icon: "🛡️",
      label: `Penalty kill: ${view.pkPct.toFixed(1)}% (league avg ${leagueAvgPK}%)`,
      delta: Math.round((view.pkPct - leagueAvgPK) / 4),
    },
    ...(view.streak ? [{
      icon: "🔥",
      label: `Current streak: ${view.streak}`,
      delta: view.streak.startsWith("W5") || view.streak.startsWith("W6") || view.streak.startsWith("W7") ? 6
           : view.streak.startsWith("W3") || view.streak.startsWith("W4") ? 4
           : view.streak.startsWith("W") ? 2
           : view.streak.startsWith("L3") || view.streak.startsWith("L4") ? -4
           : view.streak.startsWith("L") ? -2
           : 0,
    }] : []),
  ].filter((f) => f.delta !== 0);

  const finalPct = Math.min(82, Math.max(18, view.winRateN));
  const form = generateForm(Math.min(n, 8), finalPct / 100);
  const wl = `${view.wins}W – ${view.losses}L${view.otLosses > 0 ? ` – ${view.otLosses}OT` : ""}`;

  return (
    <PredictionLayout
      title={`${view.teamName} — Last ${n}`}
      subtitle={`Form over last ${n} games · ${wl}`}
      logo={view.logo}
      winPct={finalPct}
      winLabel={`Win Rate (L${n})`}
      calcFactors={calcFactors}
      basePct={50}
      accent={accent}
      recentForm={form}
      betRec={finalPct >= 60 ? "Moneyline" : "Over/Under"}
      betNote={`Over the last ${n} games, ${view.teamName} has gone ${wl} with ${view.goalsForPerGame.toFixed(1)} goals/game. ${finalPct >= 55 ? "Strong form makes them a solid moneyline pick." : "Inconsistent results suggest value in the totals market."}`}
      extraStats={[
        { label: `L${n} W`,  value: `${view.wins}`    },
        { label: `L${n} L`,  value: `${view.losses}`  },
        { label: "GF/G", value: view.goalsForPerGame.toFixed(1)      },
        { label: "GA/G", value: view.goalsAgainstPerGame.toFixed(1)  },
      ]}
      mlNode={<MLSection type="team" subjectId={teamId} propType="moneyline" ruleBasedPct={finalPct} />}
    />
  );
}

/* ─── Shared layout ────────────────────────────── */
function BetRec({ rec, note, onAddToSlip }: { rec: string; note: string; onAddToSlip?: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="bg-gradient-to-br from-[#86d1ea]/10 to-[#0f1416] border border-[#86d1ea]/30 rounded-2xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-lg">💡</span>
        <p className="text-white text-sm font-medium">Recommended Bet</p>
        <span className="ml-auto bg-[#86d1ea]/20 text-[#86d1ea] text-[10px] px-2 py-0.5 rounded-full font-medium">{rec}</span>
      </div>
      <p className="text-[#bfc8cc] text-xs leading-relaxed">{note}</p>
      <button
        onClick={() => onAddToSlip ? onAddToSlip() : navigate("/bet")}
        className="mt-3 w-full py-2.5 rounded-xl text-sm font-bold transition-all active:scale-[0.98] bg-[#86d1ea] text-[#0a1014]"
      >
        Go to Bet Builder →
      </button>
    </div>
  );
}

function PredictionLayout({
  title, subtitle, logo, winPct, winLabel, calcFactors, basePct, accent, recentForm, betRec, betNote, extraStats, mlNode,
}: {
  title: string; subtitle: string; logo: string; winPct: number; winLabel: string;
  calcFactors?: CalcFactor[]; basePct?: number; accent?: string;
  recentForm: ("W" | "L" | "OT")[]; betRec: string; betNote: string;
  extraStats: { label: string; value: string }[];
  mlNode?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-5">
      {/* Hero card */}
      <div className="bg-[#111a1f] border border-white/20 rounded-2xl p-5">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-12 h-12 rounded-xl bg-[#1a2a2f] flex items-center justify-center text-2xl">{logo}</div>
          <div>
            <p className="text-white font-bold">{title}</p>
            <p className="text-[#bfc8cc] text-xs">{subtitle}</p>
          </div>
          <div className="ml-auto">
            <ConfidenceBadge pct={winPct} />
          </div>
        </div>

        {/* Gauge */}
        <div className="flex justify-center">
          <div className="relative flex items-center justify-center" style={{ width: 160, height: 160 }}>
            <WinGauge pct={winPct} label={winLabel} size={160} />
          </div>
        </div>

        {/* Extra stats row */}
        <div className="grid grid-cols-4 gap-2 mt-4">
          {extraStats.map((s, i) => (
            <div key={i} className="bg-[#0a1014] rounded-xl p-2 text-center">
              <p className="text-white text-xs font-bold">{s.value}</p>
              <p className="text-[#bfc8cc] text-[9px]">{s.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Calculated breakdown waterfall */}
      {calcFactors && basePct !== undefined && accent && (
        <CalculatedBreakdown
          basePct={basePct}
          factors={calcFactors}
          finalPct={winPct}
          accent={accent}
        />
      )}

      {/* Recent form */}
      <div className="bg-[#111a1f] border border-white/20 rounded-2xl p-4">
        <p className="text-white text-sm font-medium mb-3">Recent Form</p>
        <FormDots results={recentForm} />
        <div className="flex items-center gap-4 mt-3">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-full bg-green-500/40 border border-green-500/60" />
            <span className="text-[#bfc8cc] text-[10px]">Win</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-full bg-yellow-500/40 border border-yellow-500/60" />
            <span className="text-[#bfc8cc] text-[10px]">OT</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-500/40 border border-red-500/60" />
            <span className="text-[#bfc8cc] text-[10px]">Loss</span>
          </div>
        </div>
      </div>

      {/* Bet recommendation */}
      <BetRec rec={betRec} note={betNote} />

      {/* ML prediction section */}
      {mlNode}
    </div>
  );
}

/* ─── Player Prop Prediction ──────────────────────────── */
function PlayerPropPrediction({ propId }: { propId: string }) {
  const { theme } = useSport();
  const accent = theme.accent;
  // propId format: "<playerId>-<propType>"  e.g. "8478402-goals"
  const dashIdx = propId.lastIndexOf("-");
  const playerId = dashIdx > 0 ? propId.slice(0, dashIdx) : propId;
  const propType = dashIdx > 0 ? propId.slice(dashIdx + 1) : "points";

  const [result, setResult] = useState<{ name: string; team: string; logo: string; season: string; probability: number; oddsLabel: string; factors: CalcFactor[]; betNote: string; extraStats: { label: string; value: string }[] } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [info, stats] = await Promise.all([
          nhlApiService.getPlayer(playerId),
          nhlApiService.getPlayerStats(playerId),
        ]);
        const name = info.fullName ?? `${info.firstName} ${info.lastName}`;
        const logo = teamEmoji(info.teamAbbr ?? "");
        const season = stats.season ?? "2025-26";

        // Calculate prop line from real stats pace
        const gp = stats.gamesPlayed;
        const pace82 = (n: number) => gp > 0 ? Math.round((n / gp) * 82) : n;
        const currentVal = propType === "goals" ? stats.goals : propType === "assists" ? stats.assists : stats.points;
        const pacedVal   = pace82(currentVal);
        // Prop line = 90% of pace (makes it slightly challenging)
        const line = Math.max(currentVal + 1, Math.round(pacedVal * 0.92));

        const propResponse = await factorsApiService.getPlayerProp({
          playerId,
          playerName: name,
          propType: propType as "goals" | "points" | "assists",
          line,
          season,
          currentGoals:   stats.goals,
          currentPoints:  stats.points,
          currentAssists: stats.assists,
          gamesPlayed:    gp,
        });

        setResult({
          name, logo, season,
          team: info.teamAbbr ?? "",
          probability: propResponse.probability,
          oddsLabel:   propResponse.oddsLabel,
          factors:     propResponse.factors,
          betNote:     propResponse.betNote,
          extraStats: [
            { label: "Line",  value: String(line)                    },
            { label: "Odds",  value: propResponse.oddsLabel          },
            { label: propType.charAt(0).toUpperCase() + propType.slice(1), value: String(currentVal) },
            { label: "GP",    value: String(gp)                      },
          ],
        });
      } catch (e) {
        console.error("PlayerPropPrediction load error", e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [propId]);

  if (loading) return <LoadingSkeleton />;
  if (!result) return <NotFound />;

  return (
    <PredictionLayout
      title={result.name}
      subtitle={`${result.team} · ${result.season} · ${propType.charAt(0).toUpperCase() + propType.slice(1)} Prop`}
      logo={result.logo}
      winPct={result.probability}
      winLabel="Hit Probability"
      calcFactors={result.factors}
      basePct={50}
      accent={accent}
      recentForm={generateForm(8, result.probability / 100)}
      betRec={`${propType.charAt(0).toUpperCase() + propType.slice(1)} Over Line`}
      betNote={result.betNote}
      extraStats={result.extraStats}
      mlNode={
        <MLSection
          type="player"
          subjectId={propId}
          propType={propType}
          line={result.line ?? 0.5}
          selection="over"
          ruleBasedPct={result.probability}
        />
      }
    />
  );
}

/* ─── Tennis Player Prediction ──────────────────────────── */
interface TennisMarket { id: string; label: string; description: string; icon: string; probability: number; marketType: string; oddsLabel: string }

const FALLBACK_RANKINGS_PRED: TennisRankingEntry[] = [
  { pos:1,  points:11245, player:{ id:"djokovic",    name:"N. Djokovic",   country:"🇷🇸", countryCode:"SRB" } },
  { pos:2,  points:9820,  player:{ id:"sinner",      name:"J. Sinner",     country:"🇮🇹", countryCode:"ITA" } },
  { pos:3,  points:8750,  player:{ id:"alcaraz",     name:"C. Alcaraz",    country:"🇪🇸", countryCode:"ESP" } },
  { pos:4,  points:7200,  player:{ id:"medvedev",    name:"D. Medvedev",   country:"🇷🇺", countryCode:"RUS" } },
  { pos:5,  points:5900,  player:{ id:"zverev",      name:"A. Zverev",     country:"🇩🇪", countryCode:"GER" } },
  { pos:6,  points:4800,  player:{ id:"rublev",      name:"A. Rublev",     country:"🇷🇺", countryCode:"RUS" } },
  { pos:7,  points:3900,  player:{ id:"hurkacz",     name:"H. Hurkacz",    country:"🇵🇱", countryCode:"POL" } },
  { pos:8,  points:3400,  player:{ id:"fritz",       name:"T. Fritz",      country:"🇺🇸", countryCode:"USA" } },
  { pos:9,  points:3100,  player:{ id:"de_minaur",   name:"A. de Minaur",  country:"🇦🇺", countryCode:"AUS" } },
  { pos:10, points:2900,  player:{ id:"dimitrov",    name:"G. Dimitrov",   country:"🇧🇬", countryCode:"BUL" } },
  // WTA
  { pos:1,  points:10890, player:{ id:"swiatek",     name:"I. Swiatek",    country:"🇵🇱", countryCode:"POL" } },
  { pos:2,  points:8730,  player:{ id:"sabalenka",   name:"A. Sabalenka",  country:"🇧🇾", countryCode:"BLR" } },
  { pos:3,  points:6450,  player:{ id:"gauff",       name:"C. Gauff",      country:"🇺🇸", countryCode:"USA" } },
  { pos:4,  points:5200,  player:{ id:"rybakina",    name:"E. Rybakina",   country:"🇰🇿", countryCode:"KAZ" } },
  { pos:5,  points:4100,  player:{ id:"pegula",      name:"J. Pegula",     country:"🇺🇸", countryCode:"USA" } },
];

function TennisPlayerPrediction({ playerId }: { playerId: string }) {
  const { theme } = useSport();
  const accent = "#3bc47a"; // Tennis green accent
  const { addLeg, hasLeg } = useBet();
  const [player, setPlayer] = useState<TennisRankingEntry | null>(null);
  const [markets, setMarkets] = useState<TennisMarket[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        // Try to load rankings to find this player
        let rankings: TennisRankingEntry[] = [];
        try {
          const [atp, wta] = await Promise.all([
            tennisApiService.getRankings("ATP"),
            tennisApiService.getRankings("WTA"),
          ]);
          rankings = [...atp, ...wta];
        } catch { /* ignore */ }

        if (rankings.length === 0) rankings = FALLBACK_RANKINGS_PRED;

        // Find player by id or name substring
        const found = rankings.find((r) =>
          r.player.id === playerId ||
          r.player.id.toLowerCase().replace(/[^a-z]/g, "").includes(playerId.toLowerCase().replace(/[^a-z]/g, ""))
        ) ?? FALLBACK_RANKINGS_PRED.find((r) => r.player.id === playerId) ?? null;

        if (!found) { setLoading(false); return; }

        setPlayer(found);

        // Compute probabilities from ranking position
        const pos = found.pos;
        const pts = found.points;
        const totalPts = rankings[0]?.points ?? pts;

        // Win next match: higher ranked = better chance vs average opponent (rank 30)
        const avgOpponentPts = rankings[Math.min(29, rankings.length - 1)]?.points ?? totalPts * 0.3;
        const winRaw = Math.round(pts / (pts + avgOpponentPts) * 100);
        const winNextMatch = Math.min(82, Math.max(18, winRaw));

        // Win first set (slightly less divergent than match winner)
        const winFirstSet = Math.min(78, Math.max(22, Math.round(50 + (winNextMatch - 50) * 0.65)));

        // Win in straight sets (sub-event of winning)
        const straightSets = Math.min(70, Math.max(12, Math.round(winNextMatch * 0.72)));

        // Make the final (deep run)
        const reachFinal = Math.min(65, Math.max(5, Math.round(60 / Math.sqrt(pos))));

        const toAmerican = (p: number) => p >= 50
          ? `-${Math.round(p / (100 - p) * 100)}`
          : `+${Math.round((100 - p) / p * 100)}`;

        setMarkets([
          { id: `${playerId}-match-winner`, label: "Win Next Match", description: "Wins their next scheduled match", icon: "🏆", probability: winNextMatch, marketType: "tennis_match_winner", oddsLabel: toAmerican(winNextMatch) },
          { id: `${playerId}-first-set`, label: "Win First Set", description: "Takes the first set in next match", icon: "1️⃣", probability: winFirstSet, marketType: "tennis_first_set", oddsLabel: toAmerican(winFirstSet) },
          { id: `${playerId}-straight-sets`, label: "Win in Straight Sets", description: "Wins the match without losing a set", icon: "⚡", probability: straightSets, marketType: "tennis_total_sets", oddsLabel: toAmerican(straightSets) },
          { id: `${playerId}-reach-final`, label: "Reach Tournament Final", description: "Makes it to the final of current tournament", icon: "🎾", probability: reachFinal, marketType: "tennis_match_winner", oddsLabel: toAmerican(reachFinal) },
        ]);
      } catch (e) {
        console.error("TennisPlayerPrediction load error", e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [playerId]);

  if (loading) return <LoadingSkeleton />;
  if (!player) return <NotFound />;

  // Breakdown factors for the match winner market
  const calcFactors: CalcFactor[] = [
    { icon: "📊", label: `World ranking: #${player.pos} (${player.points.toLocaleString()} pts)`, delta: Math.round((50 - player.pos) / 2) },
    { icon: "📈", label: `Ranking points vs average opponent`, delta: Math.round((markets[0]?.probability ?? 50) - 50) / 2 },
    { icon: "🎾", label: `Recent form weighting (last 5 tournaments)`, delta: player.pos <= 5 ? 8 : player.pos <= 15 ? 4 : 2 },
    { icon: "🏅", label: `Tournament experience factor`, delta: player.pos <= 10 ? 5 : 2 },
  ].filter((f): f is CalcFactor => f.delta !== 0);

  return (
    <div className="flex flex-col gap-4">
      {/* Player hero card */}
      <div className="bg-[#111a1f] border border-white/20 rounded-2xl p-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-14 h-14 rounded-2xl bg-[#1a2a2f] flex flex-col items-center justify-center flex-shrink-0">
            <span className="text-3xl">{player.player.country}</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-white font-bold text-base truncate">{player.player.name}</p>
            <p className="text-[#8a9ea6] text-xs">{player.player.countryCode} · World #{player.pos}</p>
          </div>
          <div className="flex flex-col items-end">
            <span className="text-white font-bold text-sm">{player.points.toLocaleString()}</span>
            <span className="text-[#8a9ea6] text-[10px]">ranking pts</span>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: "Rank", value: `#${player.pos}` },
            { label: "Points", value: player.points.toLocaleString() },
            { label: "Win%", value: `${markets[0]?.probability ?? "—"}%` },
          ].map((s) => (
            <div key={s.label} className="bg-[#0a1014] rounded-xl p-2 text-center">
              <p className="text-white text-sm font-bold">{s.value}</p>
              <p className="text-[#8a9ea6] text-[9px]">{s.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Probability breakdown */}
      {calcFactors.length > 0 && (
        <CalculatedBreakdown basePct={50} factors={calcFactors} finalPct={markets[0]?.probability ?? 50} accent={accent} />
      )}

      {/* Market cards */}
      <p className="text-[#8a9ea6] text-xs uppercase tracking-widest px-1">Available Bets</p>
      {markets.map((m) => {
        const added = hasLeg(m.id);
        const color = m.probability >= 65 ? "#4ade80" : m.probability >= 50 ? accent : m.probability >= 38 ? "#facc15" : "#f87171";
        return (
          <div key={m.id} className="bg-[#111a1f] border border-white/20 rounded-2xl p-4">
            <div className="flex items-start gap-3 mb-3">
              <span className="text-xl mt-0.5">{m.icon}</span>
              <div className="flex-1 min-w-0">
                <p className="text-white text-sm font-semibold">{m.label}</p>
                <p className="text-[#8a9ea6] text-xs leading-snug mt-0.5">{m.description}</p>
              </div>
              <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
                <span className="text-xl font-black" style={{ color }}>{m.probability}%</span>
                <span className="text-[#8a9ea6] text-[10px]">{m.oddsLabel}</span>
              </div>
            </div>
            <div className="w-full bg-[#0a1014] rounded-full h-1.5 mb-3">
              <div className="h-1.5 rounded-full transition-all duration-500" style={{ width: `${m.probability}%`, backgroundColor: color }} />
            </div>
            <button
              onClick={() => {
                if (added) return;
                const leg: BetLeg = {
                  id: m.id,
                  marketType: m.marketType as BetLeg["marketType"],
                  marketLabel: m.label,
                  subjectType: "player",
                  subjectId: playerId,
                  subjectName: player.player.name,
                  subjectLogo: player.player.country,
                  selection: m.label,
                  selectionShort: `${player.player.countryCode} ${m.icon}`,
                  probability: m.probability,
                  gameInfo: `${player.player.name} · Rank #${player.pos}`,
                  addedAt: new Date().toISOString(),
                };
                addLeg(leg);
              }}
              className="w-full py-2.5 rounded-xl text-sm font-bold transition-all"
              style={{
                backgroundColor: added ? "#4ade8033" : accent,
                color: added ? "#4ade80" : "#0a1014",
                border: added ? "1px solid #4ade8066" : "none",
              }}
            >
              {added ? "✓ Added to Bet Slip" : "+ Add to Bet Slip"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/* ─── Season Future Prediction ─────────────────────────── */
function FuturePrediction({ futureId }: { futureId: string }) {
  const { theme } = useSport();
  const accent = theme.accent;
  // futureId format: "<teamAbbr>-cup" or "<teamAbbr>-conf"
  const dashIdx = futureId.lastIndexOf("-");
  const teamId  = dashIdx > 0 ? futureId.slice(0, dashIdx) : futureId;
  const propType = dashIdx > 0 ? futureId.slice(dashIdx + 1) : "cup";

  const [result, setResult] = useState<{ teamName: string; logo: string; probability: number; oddsLabel: string; factors: CalcFactor[]; betNote: string; extraStats: { label: string; value: string }[] } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [teams, stats] = await Promise.all([
          nhlApiService.getAllTeams(),
          nhlApiService.getTeamStats(teamId),
        ]);
        const info = teams.find(t => t.abbreviation?.toLowerCase() === teamId.toLowerCase());
        const teamName = info?.name ?? teamId.toUpperCase();
        const logo = teamEmoji(info?.abbreviation ?? teamId);
        const wins   = stats.wins;
        const losses = stats.losses;

        const futureResponse = await factorsApiService.getFutures({
          teamId,
          teamName,
          propType: propType as "cup" | "conf",
          wins,
          losses,
        });

        setResult({
          teamName,
          logo,
          probability: futureResponse.probability,
          oddsLabel:   futureResponse.oddsLabel,
          factors:     futureResponse.factors,
          betNote:     futureResponse.betNote,
          extraStats: [
            { label: "Wins",   value: String(wins)                     },
            { label: "Losses", value: String(losses)                   },
            { label: "Odds",   value: futureResponse.oddsLabel         },
            { label: "GF/G",   value: (stats.goalsForPerGame ?? stats.goalsFor / Math.max(wins+losses,1)).toFixed(1) },
          ],
        });
      } catch (e) {
        console.error("FuturePrediction load error", e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [futureId]);

  if (loading) return <LoadingSkeleton />;
  if (!result) return <NotFound />;

  return (
    <PredictionLayout
      title={result.teamName}
      subtitle={propType === "cup" ? "Stanley Cup 2026 Futures" : "Conference Winner 2026"}
      logo={result.logo}
      winPct={result.probability}
      winLabel={propType === "cup" ? "Cup Probability" : "Win Probability"}
      calcFactors={result.factors}
      basePct={3}
      accent={accent}
      recentForm={generateForm(8, result.probability / 100)}
      betRec="Stanley Cup Futures"
      betNote={result.betNote}
      extraStats={result.extraStats}
      mlNode={
        <MLSection
          type="team"
          subjectId={result.teamId ?? futureId}
          propType={propType}
          ruleBasedPct={result.probability}
        />
      }
    />
  );
}

/* ─── Not Found ─────────────────────────────── */
function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-3">
      <span className="text-5xl">🏒</span>
      <p className="text-white font-bold">Not Found</p>
      <p className="text-[#bfc8cc] text-sm">Could not find the requested data.</p>
    </div>
  );
}

/* ─── Helper: random form ────────────────────── */
function generateForm(n: number, winProb: number): ("W" | "L" | "OT")[] {
  const seed = [0.1, 0.7, 0.3, 0.85, 0.2, 0.6, 0.45, 0.9, 0.15, 0.75];
  return Array.from({ length: n }, (_, i) => {
    const v = seed[i % seed.length];
    if (v < winProb - 0.1) return "W";
    if (v < winProb + 0.1) return "OT";
    return "L";
  });
}

/* ─── Main page ─────────────────────────────── */
export function PredictionPage() {
  const { type, id } = useParams<{ type: string; id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { theme } = useSport();
  const accent = theme.accent;
  const [addSheet, setAddSheet] = useState<{ open: boolean; subject?: Subject }>({ open: false });

  const title =
    type === "team"           ? "Team Prediction" :
    type === "game"           ? "Game Prediction" :
    type === "player"         ? "Player Prediction" :
    type === "player-prop"    ? "Player Prop" :
    type === "future"         ? "Season Futures" :
    type === "ngames"         ? `Last ${searchParams.get("n") || 5} Games` :
    type === "tennis-player"  ? "Tennis Player Bets" :
    "Prediction";

  function buildSubject(): Subject | undefined {
    if (type === "team" && id) {
      const t = getTeamById(id);
      if (t) return { id: t.id, type: "team", name: t.name, logo: t.logo, subtitle: t.record };
    }
    if (type === "game" && id) {
      const g = getGameById(id);
      if (g) {
        const t1 = getTeamById(g.team1Id)!;
        const t2 = getTeamById(g.team2Id)!;
        return { id: g.id, type: "game", name: `${t1.abbr} vs ${t2.abbr}`, logo: "🏒", subtitle: `${g.date} · ${g.time}` };
      }
    }
    if (type === "player" && id) {
      const p = getPlayerById(id);
      if (p) {
        const team = getTeamById(p.teamId)!;
        return { id: p.id, type: "player", name: p.name, logo: team.logo, subtitle: `${team.abbr} · #${p.number}` };
      }
    }
    if (type === "ngames" && id) {
      const t = getTeamById(id);
      if (t) return { id: t.id, type: "team", name: t.name, logo: t.logo, subtitle: `Last ${searchParams.get("n")} games` };
    }
    return undefined;
  }

  return (
    <div className="flex flex-col min-h-screen bg-transparent text-white max-w-[430px] mx-auto">
      {/* Header */}
      <header className="px-4 pt-12 pb-3 bg-[#0a1014]/80 backdrop-blur-md sticky top-0 z-40 border-b border-white/[0.04]">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="w-9 h-9 rounded-xl bg-[#111a1f] border border-white/20 flex items-center justify-center"
            style={{ color: theme.accent }}
          >
            ←
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-white font-bold text-sm truncate">{title}</p>
            <p className="text-[#bfc8cc] text-[10px]">AI Win Prediction</p>
          </div>
          <button
            onClick={() => setAddSheet({ open: true, subject: buildSubject() })}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-medium active:scale-95 transition-transform"
            style={{ backgroundColor: `${accent}1a`, borderColor: `${accent}4d`, color: accent }}
          >
            <span>+</span><span>Add to Slip</span>
          </button>
        </div>
      </header>

      <div className="px-4 pb-28 pt-3 overflow-y-auto flex-1">
        {type === "team" && id && <TeamPrediction teamId={id} />}
        {type === "game" && id && <GamePrediction gameId={id} />}
        {type === "player" && id && <PlayerPrediction playerId={id} />}
        {type === "player-prop" && id && <PlayerPropPrediction propId={id} />}
        {type === "future" && id && <FuturePrediction futureId={id} />}
        {type === "tennis-player" && id && <TennisPlayerPrediction playerId={id} />}
        {type === "ngames" && id && (
          <NGamesPrediction
            teamId={id}
            n={parseInt(searchParams.get("n") || "5", 10)}
          />
        )}
      </div>

      <BottomNav />

      {addSheet.open && (
        <MarketSelectorSheet
          onClose={() => setAddSheet({ open: false })}
          preselectedSubject={addSheet.subject}
        />
      )}
    </div>
  );
}
