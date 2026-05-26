import { useParams, useNavigate, useSearchParams } from "react-router";
import { useEffect, useState } from "react";
import { getTeamById, getGameById, getPlayerById, getTeamLastNGames } from "../data/hockeyData";
import { BottomNav } from "./BottomNav";
import { MarketSelectorSheet } from "./MarketSelectorSheet";
import { PredictionResponse } from "../types/bet";
import { predictionApiService } from "../services/predictionApiService";

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
    <div className="bg-[#141c1f] border border-[#1e2d32] rounded-2xl p-3.5">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-lg">{icon}</span>
          <span className="text-white text-xs font-medium">{label}</span>
        </div>
        <span className="text-xs font-bold" style={{ color }}>{detail}</span>
      </div>
      <div className="w-full bg-[#0f1416] rounded-full h-2">
        <div
          className="h-2 rounded-full transition-all duration-700 ease-out"
          style={{ width: `${width}%`, backgroundColor: color }}
        />
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




/* ─── Team Prediction ─────────────────────────── */
function TeamPrediction({ teamId }: { teamId: string }) {
  const team = getTeamById(teamId);
  
  // ✅ hooks are INSIDE the component
  const [prediction, setPrediction] = useState<PredictionResponse | null>(null);

  useEffect(() => {
    predictionApiService.getSinglePrediction({
      marketType: "moneyline",
      teamId,
    }).then(setPrediction);
  }, [teamId]);

  if (!team) return <NotFound />;

  // Use prediction probability if loaded, fall back to local data while loading
  const winPct = prediction?.probability ?? team.winPct;

  // Build reasons from prediction factors if available, otherwise use local stats
  const reasons = prediction?.factors
    ? prediction.factors.map((f, i) => ({
        icon: ["🎯", "⚡", "🛡️", "🥅", "🔒"][i] ?? "📊",
        label: f.label,
        value: f.weight,
        maxValue: 100,
        color: f.impact === "positive" ? "#4ade80" : f.impact === "negative" ? "#f87171" : "#86d1ea",
        detail: f.value,
      }))
    : [
        { icon: "🎯", label: "Win Rate This Season", value: team.winPct, maxValue: 100, color: "#86d1ea", detail: `${team.winPct}%` },
        { icon: "⚡", label: "Power Play %", value: team.ppPct, maxValue: 35, color: "#4ade80", detail: `${team.ppPct}%` },
        { icon: "🛡️", label: "Penalty Kill %", value: team.pkPct, maxValue: 100, color: "#facc15", detail: `${team.pkPct}%` },
        { icon: "🥅", label: "Goals For / Game", value: team.goalsFor, maxValue: 4.5, color: "#86d1ea", detail: `${team.goalsFor}` },
        { icon: "🔒", label: "Goals Against / Game", value: 4.5 - team.goalsAgainst, maxValue: 4.5, color: "#f87171", detail: `${team.goalsAgainst} GA` },
      ];

  const recentForm = team.streak.startsWith("W")
    ? generateForm(6, 0.7 * winPct / 100)
    : generateForm(6, 0.3 * winPct / 100);

  const betRecommendation = winPct >= 60 ? "Moneyline Bet" : winPct >= 50 ? "Puck Line -1.5" : "Over/Under";

  return (
    <PredictionLayout
      title={team.name}
      subtitle={`${team.conf}ern Conference · ${team.record}`}
      logo={team.logo}
      winPct={winPct}
      winLabel="Win Prediction"
      reasons={reasons}
      recentForm={recentForm}
      betRec={betRecommendation}
      betNote={winPct >= 60
        ? `${team.name} is on a ${team.streak} streak and ranks in the top tier for offensive efficiency this season.`
        : `${team.name} shows inconsistency. Value may be on the over with ${team.goalsFor} goals/game average.`}
      extraStats={[
        { label: "Home", value: team.homeRecord },
        { label: "Away", value: team.awayRecord },
        { label: "Streak", value: team.streak },
        { label: "Pts", value: `${team.pts}` },
      ]}
    />
  );
}

/* ─── Game Prediction ─────────────────────────── */
function GamePrediction({ gameId }: { gameId: string }) {
  const game = getGameById(gameId);
  if (!game) return <NotFound />;
  const team1 = getTeamById(game.team1Id)!;
  const team2 = getTeamById(game.team2Id)!;
  const formatOdds = (o: number) => o > 0 ? `+${o}` : `${o}`;

  const reasons = [
    { icon: "📈", label: `${team1.abbr} Season Win Rate`, value: team1.winPct, maxValue: 100, color: "#86d1ea", detail: `${team1.winPct}%` },
    { icon: "📉", label: `${team2.abbr} Season Win Rate`, value: team2.winPct, maxValue: 100, color: "#bfc8cc", detail: `${team2.winPct}%` },
    { icon: "⚡", label: "Offensive Edge (Goals/G)", value: team1.goalsFor, maxValue: Math.max(team1.goalsFor, team2.goalsFor) + 0.5, color: "#4ade80", detail: `${team1.goalsFor} vs ${team2.goalsFor}` },
    { icon: "🛡️", label: "Defensive Edge (GA/G)", value: 4.5 - team1.goalsAgainst, maxValue: 4.5, color: "#facc15", detail: `${team1.goalsAgainst} vs ${team2.goalsAgainst} GA` },
    { icon: "🏠", label: "Home Ice Advantage", value: 70, maxValue: 100, color: "#86d1ea", detail: `${team1.abbr} at home` },
  ];

  const form1 = generateForm(5, team1.winPct / 100);
  const form2 = generateForm(5, team2.winPct / 100);

  return (
    <div className="flex flex-col gap-5">
      {/* Head-to-head panel */}
      <div className="bg-[#141c1f] border border-[#1e2d32] rounded-2xl p-4">
        <p className="text-[#bfc8cc] text-[10px] uppercase tracking-widest text-center mb-3">Head to Head</p>
        <div className="flex items-center justify-between">
          <div className="flex flex-col items-center gap-1.5">
            <span className="text-3xl">{team1.logo}</span>
            <span className="text-white text-sm font-bold">{team1.abbr}</span>
            <span className="text-[#86d1ea] text-sm font-bold">{formatOdds(game.odds1)}</span>
            <span className="text-[#bfc8cc] text-xs">{game.winPct1}% win</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            <span className="text-[#bfc8cc] text-xs">{game.date}</span>
            <span className="text-white font-bold text-lg">VS</span>
            <span className="text-[#bfc8cc] text-[10px]">{game.time}</span>
            <span className="text-[#bfc8cc] text-[10px]">O/U {game.overUnder}</span>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <span className="text-3xl">{team2.logo}</span>
            <span className="text-white text-sm font-bold">{team2.abbr}</span>
            <span className="text-[#86d1ea] text-sm font-bold">{formatOdds(game.odds2)}</span>
            <span className="text-[#bfc8cc] text-xs">{game.winPct2}% win</span>
          </div>
        </div>
        {/* Bar */}
        <div className="mt-4 flex items-center gap-2">
          <span className="text-[#86d1ea] text-[10px] font-bold w-8">{game.winPct1}%</span>
          <div className="flex-1 bg-[#0f1416] rounded-full h-3 overflow-hidden flex">
            <div className="h-full bg-[#86d1ea] rounded-l-full transition-all duration-700" style={{ width: `${game.winPct1}%` }} />
            <div className="h-full bg-[#1e2d32] flex-1" />
          </div>
          <span className="text-[#bfc8cc] text-[10px] font-bold w-8 text-right">{game.winPct2}%</span>
        </div>
      </div>

      {/* Win gauge for team 1 */}
      <div className="flex justify-around">
        <WinGauge pct={game.winPct1} label={`${team1.abbr} Win`} size={120} />
        <WinGauge pct={game.winPct2} label={`${team2.abbr} Win`} size={120} />
      </div>

      {/* Reasons */}
      <div>
        <p className="text-white text-sm font-medium mb-2">Key Factors</p>
        <div className="flex flex-col gap-2">
          {reasons.map((r, i) => <ReasonBar key={i} {...r} />)}
        </div>
      </div>

      {/* Form */}
      <div className="bg-[#141c1f] border border-[#1e2d32] rounded-2xl p-4">
        <p className="text-white text-sm font-medium mb-3">Recent Form</p>
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-[#bfc8cc] text-xs mb-1.5">{team1.abbr} last 5</p>
            <FormDots results={form1} />
          </div>
          <div>
            <p className="text-[#bfc8cc] text-xs mb-1.5">{team2.abbr} last 5</p>
            <FormDots results={form2} />
          </div>
        </div>
      </div>

      {/* Bet Recommendation */}
      <BetRec
        rec="Moneyline"
        note={`Our model favors ${game.winPct1 > game.winPct2 ? team1.name : team2.name} with ${Math.max(game.winPct1, game.winPct2)}% win probability. The over/under of ${game.overUnder} aligns with both teams' scoring averages.`}
      />
    </div>
  );
}

/* ─── Player Prediction ──────────────────────── */
function PlayerPrediction({ playerId }: { playerId: string }) {
  const player = getPlayerById(playerId);
  if (!player) return <NotFound />;
  const team = getTeamById(player.teamId)!;

  const avgPts = (player.points / player.gamesPlayed).toFixed(2);
  const lastFiveAvg = (player.lastFive.reduce((a, b) => a + b, 0) / 5).toFixed(1);

  const reasons = [
    { icon: "🎯", label: "Season Points/Game", value: parseFloat(avgPts) * 20, maxValue: 100, color: "#86d1ea", detail: `${avgPts} pts/g` },
    { icon: "🥅", label: "Goal-Scoring Rate", value: player.goals, maxValue: 60, color: "#4ade80", detail: `${player.goals} goals` },
    { icon: "🍎", label: "Playmaking Rate", value: player.assists, maxValue: 80, color: "#facc15", detail: `${player.assists} assists` },
    { icon: "⚡", label: "Power Play Production", value: player.ppPoints, maxValue: 60, color: "#86d1ea", detail: `${player.ppPoints} PP pts` },
    { icon: "📊", label: "Shot Efficiency", value: player.shotPct, maxValue: 20, color: "#f87171", detail: `${player.shotPct}% shot%` },
    { icon: "🔥", label: "Last 5 Games Form", value: parseFloat(lastFiveAvg) * 25, maxValue: 100, color: "#86d1ea", detail: `${lastFiveAvg} pts/g` },
  ];

  const form = player.lastFive.map(pts =>
    pts === 0 ? "L" : pts >= 2 ? "W" : "OT"
  ) as ("W" | "L" | "OT")[];

  return (
    <PredictionLayout
      title={player.name}
      subtitle={`${team.name} · #${player.number} · ${player.position}`}
      logo={team.logo}
      winPct={player.winImpact}
      winLabel="Win Impact"
      reasons={reasons}
      recentForm={form}
      betRec="Player Prop"
      betNote={`${player.name} is averaging ${avgPts} pts/game. Over/under on points scored is a strong value play given their ${lastFiveAvg} pts/game over the last 5.`}
      extraStats={[
        { label: "Goals", value: `${player.goals}` },
        { label: "Assists", value: `${player.assists}` },
        { label: "Points", value: `${player.points}` },
        { label: "+/-", value: `${player.plusMinus > 0 ? "+" : ""}${player.plusMinus}` },
      ]}
    />
  );
}

/* ─── N Games Prediction ─────────────────────── */
function NGamesPrediction({ teamId, n }: { teamId: string; n: number }) {
  const team = getTeamById(teamId);
  const data = getTeamLastNGames(teamId, n);
  if (!team || !data) return <NotFound />;

  const winRateN = Math.round((data.wins / n) * 100);

  const reasons = [
    { icon: "🏆", label: `Wins in Last ${n}`, value: data.wins, maxValue: n, color: "#4ade80", detail: `${data.wins}W – ${data.losses}L` },
    { icon: "🥅", label: "Goals Scored", value: data.goalsFor, maxValue: n * 5, color: "#86d1ea", detail: `${data.goalsFor} total` },
    { icon: "🔒", label: "Goals Conceded", value: n * 5 - data.goalsAgainst, maxValue: n * 5, color: "#facc15", detail: `${data.goalsAgainst} total` },
    { icon: "📈", label: "Season Win Rate", value: team.winPct, maxValue: 100, color: "#86d1ea", detail: `${team.winPct}%` },
    { icon: "⚡", label: "Power Play %", value: team.ppPct, maxValue: 35, color: "#f87171", detail: `${team.ppPct}%` },
  ];

  const form = generateForm(Math.min(n, 8), team.winPct / 100);

  return (
    <PredictionLayout
      title={`${team.name} — Last ${n}`}
      subtitle={`Performance over last ${n} games`}
      logo={team.logo}
      winPct={winRateN}
      winLabel={`Win Rate (L${n})`}
      reasons={reasons}
      recentForm={form}
      betRec={winRateN >= 60 ? "Moneyline" : "Over/Under"}
      betNote={`Over the last ${n} games, ${team.name} has gone ${data.wins}-${data.losses} with ${(data.goalsFor / n).toFixed(1)} goals/game. ${winRateN >= 55 ? "Strong form makes them a solid moneyline pick." : "Inconsistent results suggest value in totals betting."}`}
      extraStats={[
        { label: `L${n} W`, value: `${data.wins}` },
        { label: `L${n} L`, value: `${data.losses}` },
        { label: "GF", value: `${data.goalsFor}` },
        { label: "GA", value: `${data.goalsAgainst}` },
      ]}
    />
  );
}

/* ─── Shared layout ────────────────────────────── */
function BetRec({ rec, note }: { rec: string; note: string }) {
  const [added, setAdded] = useState(false);
  return (
    <div className="bg-gradient-to-br from-[#86d1ea]/10 to-[#0f1416] border border-[#86d1ea]/30 rounded-2xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-lg">💡</span>
        <p className="text-white text-sm font-medium">Recommended Bet</p>
        <span className="ml-auto bg-[#86d1ea]/20 text-[#86d1ea] text-[10px] px-2 py-0.5 rounded-full font-medium">{rec}</span>
      </div>
      <p className="text-[#bfc8cc] text-xs leading-relaxed">{note}</p>
      <button
        onClick={() => setAdded(v => !v)}
        className={`mt-3 w-full py-2.5 rounded-xl text-sm font-bold transition-all ${
          added ? "bg-green-500 text-white" : "bg-[#86d1ea] text-[#0f1416]"
        }`}
      >
        {added ? "✓ Added to Bet Slip" : "Add to Bet Slip"}
      </button>
    </div>
  );
}

function PredictionLayout({
  title, subtitle, logo, winPct, winLabel, reasons, recentForm, betRec, betNote, extraStats,
}: {
  title: string; subtitle: string; logo: string; winPct: number; winLabel: string;
  reasons: { icon: string; label: string; value: number; maxValue: number; color: string; detail: string }[];
  recentForm: ("W" | "L" | "OT")[]; betRec: string; betNote: string;
  extraStats: { label: string; value: string }[];
}) {
  return (
    <div className="flex flex-col gap-5">
      {/* Hero card */}
      <div className="bg-[#141c1f] border border-[#1e2d32] rounded-2xl p-5">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-12 h-12 rounded-xl bg-[#1e2d32] flex items-center justify-center text-2xl">{logo}</div>
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
            <div key={i} className="bg-[#0f1416] rounded-xl p-2 text-center">
              <p className="text-white text-xs font-bold">{s.value}</p>
              <p className="text-[#bfc8cc] text-[9px]">{s.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Key factors */}
      <div>
        <p className="text-white text-sm font-medium mb-2">Key Factors</p>
        <div className="flex flex-col gap-2">
          {reasons.map((r, i) => <ReasonBar key={i} {...r} />)}
        </div>
      </div>

      {/* Recent form */}
      <div className="bg-[#141c1f] border border-[#1e2d32] rounded-2xl p-4">
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
    </div>
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
  const [addSheet, setAddSheet] = useState<{ open: boolean; subject?: Subject }>({ open: false });

  const title =
    type === "team" ? (getTeamById(id!) ? `${getTeamById(id!)!.name} Prediction` : "Prediction") :
    type === "game" ? "Game Prediction" :
    type === "player" ? (getPlayerById(id!) ? `${getPlayerById(id!)!.name}` : "Prediction") :
    type === "ngames" ? `Last ${searchParams.get("n") || 5} Games` :
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
    <div className="flex flex-col min-h-screen bg-[#0f1416] text-white max-w-[430px] mx-auto">
      {/* Header */}
      <header className="px-4 pt-12 pb-3 bg-[#0f1416] sticky top-0 z-40 border-b border-[#1e2d32]">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="w-9 h-9 rounded-xl bg-[#141c1f] border border-[#1e2d32] flex items-center justify-center text-[#86d1ea]"
          >
            ←
          </button>
          <div className="flex-1 min-w-0">
            <p className="text-white font-bold text-sm truncate">{title}</p>
            <p className="text-[#bfc8cc] text-[10px]">AI Win Prediction</p>
          </div>
          <button
            onClick={() => setAddSheet({ open: true, subject: buildSubject() })}
            className="flex items-center gap-1.5 bg-[#86d1ea] text-[#0f1416] font-bold px-3 py-1.5 rounded-xl text-xs flex-shrink-0"
          >
            + Add to Slip
          </button>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 px-4 pb-28 pt-4 overflow-y-auto">
        {type === "team" && id && <TeamPrediction teamId={id} />}
        {type === "game" && id && <GamePrediction gameId={id} />}
        {type === "player" && id && <PlayerPrediction playerId={id} />}
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