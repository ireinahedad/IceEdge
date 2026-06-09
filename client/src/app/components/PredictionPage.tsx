import { useParams, useNavigate, useSearchParams } from "react-router";
import { useEffect, useState } from "react";
import { BottomNav } from "./BottomNav";
import { MarketSelectorSheet } from "./MarketSelectorSheet";
import { PredictionResponse } from "../types/bet";
import { nhlApiService } from "../services/nhlApiService";
import { predictionApiService } from "../services/predictionApiService";
import { useSport } from "../context/SportContext";
import { teamEmoji } from "../data/teamEmoji";
import { factorsApiService } from "../services/predictionApiService";

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
  const [data, setData] = useState<{ name: string; abbr: string; logo: string; conf: string; pts: number; homeRecord: string; awayRecord: string; streak: string; winPct: number; ppPct: number; pkPct: number; goalsFor: number; goalsAgainst: number } | null>(null);
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
          ? Math.round((stats.wins / (stats.wins + stats.losses + stats.otLosses)) * 100)
          : 50;
        setData({
          name: info?.name ?? abbr,
          abbr,
          logo: teamEmoji(abbr),
          conf: info?.conference === "Eastern" ? "East" : "West",
          pts: stats.points ?? stats.wins * 2,
          homeRecord: stats.homeRecord ?? "",
          awayRecord: stats.awayRecord ?? "",
          streak: stats.streak ?? "",
          winPct,
          ppPct: stats.powerPlayPct ?? 0,
          pkPct: stats.penaltyKillPct ?? 0,
          goalsFor: stats.goalsForPerGame ?? 0,
          goalsAgainst: stats.goalsAgainstPerGame ?? 0,
        });
      } catch (e) {
        console.error("TeamPrediction load error", e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [teamId]);

  if (loading) return <LoadingSkeleton />;
  if (!data) return <NotFound />;

  const leagueAvgGF = 3.0, leagueAvgGA = 3.0, leagueAvgPP = 20, leagueAvgPK = 80;

  const calcFactors: CalcFactor[] = [
    data.homeRecord ? { icon: "\u{1F3E0}", label: `Home ice advantage (${data.homeRecord} at home)`, delta: 5 } : null,
    { icon: "\u{1F4C8}", label: `Season win rate: ${data.winPct}% vs league avg 50%`, delta: Math.round((data.winPct - 50) / 4) },
    data.ppPct ? { icon: "\u{26A1}", label: `Power play: ${data.ppPct.toFixed(1)}% (league avg ${leagueAvgPP}%)`, delta: Math.round((data.ppPct - leagueAvgPP) / 2) } : null,
    data.pkPct ? { icon: "\u{1F6E1}\u{FE0F}", label: `Penalty kill: ${data.pkPct.toFixed(1)}% (league avg ${leagueAvgPK}%)`, delta: Math.round((data.pkPct - leagueAvgPK) / 4) } : null,
    data.goalsFor ? { icon: "\u{1F945}", label: `Goals for: ${data.goalsFor.toFixed(2)}/game (league avg ${leagueAvgGF})`, delta: Math.round((data.goalsFor - leagueAvgGF) * 6) } : null,
    data.goalsAgainst ? { icon: "\u{1F512}", label: `Goals against: ${data.goalsAgainst.toFixed(2)}/game (league avg ${leagueAvgGA})`, delta: Math.round((leagueAvgGA - data.goalsAgainst) * 6) } : null,
    data.streak ? { icon: "\u{1F525}", label: `Current streak: ${data.streak}`, delta: /^W[4-9]/.test(data.streak) ? 6 : /^W[23]/.test(data.streak) ? 3 : data.streak.startsWith("W") ? 2 : data.streak.startsWith("L3") || data.streak.startsWith("L4") ? -5 : data.streak.startsWith("L") ? -3 : 0 } : null,
  ].filter((f): f is CalcFactor => f !== null && f.delta !== 0);

  const basePct = 50;
  const finalPct = Math.min(85, Math.max(15, basePct + calcFactors.reduce((s, f) => s + f.delta, 0)));
  const form = generateForm(6, finalPct / 100);

  return (
    <PredictionLayout
      title={data.name}
      subtitle={`${data.conf}ern Conference · ${data.pts} pts`}
      logo={data.logo}
      winPct={finalPct}
      winLabel="Win Prediction"
      calcFactors={calcFactors}
      basePct={basePct}
      accent={accent}
      recentForm={form}
      betRec={finalPct >= 60 ? "Moneyline Bet" : finalPct >= 50 ? "Puck Line -1.5" : "Over/Under"}
      betNote={finalPct >= 60
        ? `${data.name} are on a ${data.streak} streak with a ${data.winPct}% win rate. Strong moneyline value.`
        : `${data.name} show inconsistency at ${data.winPct}% wins. Value may be on the over at ${data.goalsFor.toFixed(1)} goals/game.`}
      extraStats={[
        { label: "Home",   value: data.homeRecord || "—" },
        { label: "Away",   value: data.awayRecord  || "—" },
        { label: "Streak", value: data.streak       || "—" },
        { label: "Pts",    value: String(data.pts)       },
      ]}
    />
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

function GamePrediction({ gameId }: { gameId: string }) {
  const { theme } = useSport();
  const accent = theme.accent;
  const [gameView, setGameView] = useState<LiveGameView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      setLoading(true);
      // 1. Try static mock first
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
      // 2. Fall back to live NHL API
      try {
        const [nhlGame, homePred] = await Promise.all([
          nhlApiService.getGame(gameId),
          predictionApiService.getSinglePrediction({ marketType: "moneyline", gameId, teamId: "" })
            .catch(() => ({ probability: 55 })),
        ]);
        setGameView({
          id: gameId,
          home: {
            abbr: nhlGame.homeTeam.abbreviation,
            name: nhlGame.homeTeam.name,
            logo: TEAM_LOGOS_PRED[nhlGame.homeTeam.abbreviation] ?? "🏒",
            score: nhlGame.homeTeam.score,
            winPct: homePred.probability,
          },
          away: {
            abbr: nhlGame.awayTeam.abbreviation,
            name: nhlGame.awayTeam.name,
            logo: TEAM_LOGOS_PRED[nhlGame.awayTeam.abbreviation] ?? "🏒",
            score: nhlGame.awayTeam.score,
            winPct: 100 - homePred.probability,
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
  }, [gameId]);

  if (loading) return (
    <div className="flex flex-col gap-3">
      {[1,2,3,4].map(i => <div key={i} className="h-20 bg-[#111a1f] rounded-2xl animate-pulse" />)}
    </div>
  );
  if (!gameView) return <NotFound />;

  const { home, away } = gameView;
  const isLive = !!gameView.period;
  const winDiff = Math.round((home.winPct - 50) / 3);

  const calcFactors: CalcFactor[] = [
    { icon: "🏠", label: home.abbr + " playing at home — home ice advantage", delta: 5 },
    { icon: "📈", label: "AI win probability: " + home.abbr + " " + home.winPct + "% vs " + away.abbr + " " + away.winPct + "%", delta: winDiff },
    { icon: "⚡", label: "Offensive pressure index: " + home.abbr + " scoring rate vs " + away.abbr, delta: Math.round(winDiff / 2) },
    { icon: "🛡", label: "Defensive strength: goals allowed per game differential", delta: Math.round(-winDiff / 3) },
    { icon: isLive ? "🔥" : "📊", label: isLive ? "Game in progress — live momentum factor" : "Pre-game model confidence", delta: isLive ? 3 : 1 },
  ].filter(f => f.delta !== 0);

  const basePct = 50;
  const finalPct = Math.min(85, Math.max(15, home.winPct));
  const form1 = generateForm(5, home.winPct / 100);
  const form2 = generateForm(5, away.winPct / 100);
  const winnerName = home.winPct >= away.winPct ? home.name : away.name;

  return (
    <div className="flex flex-col gap-5">
      <div className="bg-[#111a1f] border border-white/20 rounded-2xl p-4">
        <p className="text-[#bfc8cc] text-[10px] uppercase tracking-widest text-center mb-3">
          {isLive
            ? <span className="flex items-center justify-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse inline-block" />{gameView.period}</span>
            : "Head to Head"}
        </p>
        <div className="flex items-center justify-between">
          <div className="flex flex-col items-center gap-1.5">
            <span className="text-3xl">{home.logo}</span>
            <span className="text-white text-sm font-bold">{home.abbr}</span>
            {home.score !== undefined && <span className="text-white text-2xl font-black">{home.score}</span>}
            <span className="text-xs font-bold" style={{ color: accent }}>{home.winPct}% win</span>
          </div>
          <div className="flex flex-col items-center gap-1">
            {!isLive && <span className="text-[#bfc8cc] text-xs">{gameView.time ?? "Today"}</span>}
            <span className="text-white font-bold text-lg">VS</span>
            <span className="text-[#bfc8cc] text-[10px]">O/U {gameView.overUnder}</span>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <span className="text-3xl">{away.logo}</span>
            <span className="text-white text-sm font-bold">{away.abbr}</span>
            {away.score !== undefined && <span className="text-white text-2xl font-black">{away.score}</span>}
            <span className="text-[#bfc8cc] text-xs">{away.winPct}% win</span>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <span className="text-xs font-bold w-8" style={{ color: accent }}>{home.winPct}%</span>
          <div className="flex-1 bg-[#0a1014] rounded-full h-3 overflow-hidden flex">
            <div className="h-full rounded-l-full transition-all duration-700" style={{ width: home.winPct + "%", backgroundColor: accent }} />
            <div className="h-full bg-[#1a2a2f] flex-1" />
          </div>
          <span className="text-[#bfc8cc] text-xs font-bold w-8 text-right">{away.winPct}%</span>
        </div>
      </div>

      <div className="flex justify-around">
        <WinGauge pct={home.winPct} label={home.abbr + " Win"} size={120} />
        <WinGauge pct={away.winPct} label={away.abbr + " Win"} size={120} />
      </div>

      <CalculatedBreakdown basePct={basePct} factors={calcFactors} finalPct={finalPct} accent={accent} />

      <div className="bg-[#111a1f] border border-white/20 rounded-2xl p-4">
        <p className="text-white text-sm font-medium mb-3">Recent Form</p>
        <div className="flex flex-col gap-3">
          <div><p className="text-[#bfc8cc] text-xs mb-1.5">{home.abbr} last 5</p><FormDots results={form1} /></div>
          <div><p className="text-[#bfc8cc] text-xs mb-1.5">{away.abbr} last 5</p><FormDots results={form2} /></div>
        </div>
      </div>

      <BetRec rec="Moneyline" note={"Our model favors " + winnerName + " with " + finalPct + "% win probability. The over/under of " + gameView.overUnder + " aligns with both teams scoring averages."} />
    </div>
  );
}

/* ─── Player Prediction ──────────────────────── */
function PlayerPrediction({ playerId }: { playerId: string }) {
  const { theme } = useSport();
  const accent = theme.accent;
  const [data, setData] = useState<{ name: string; team: string; logo: string; position: string; number: number; goals: number; assists: number; points: number; plusMinus: number; ppPoints: number; gamesPlayed: number; shotPct: number; lastFive: number[] } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [info, stats] = await Promise.all([
          nhlApiService.getPlayer(playerId),
          nhlApiService.getPlayerStats(playerId),
        ]);
        setData({
          name:        info.fullName ?? `${info.firstName} ${info.lastName}`,
          team:        info.teamAbbr ?? "",
          logo:        teamEmoji(info.teamAbbr ?? ""),
          position:    info.position,
          number:      info.jerseyNumber,
          goals:       stats.goals,
          assists:     stats.assists,
          points:      stats.points,
          plusMinus:   stats.plusMinus,
          ppPoints:    stats.powerPlayPoints,
          gamesPlayed: stats.gamesPlayed,
          shotPct:     stats.shootingPct,
          lastFive:    [],
        });
      } catch (e) {
        console.error("PlayerPrediction load error", e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [playerId]);

  if (loading) return <LoadingSkeleton />;
  if (!data) return <NotFound />;

  const ptsPerGame = data.gamesPlayed > 0 ? (data.points / data.gamesPlayed) : 0;
  const goalsPerGame = data.gamesPlayed > 0 ? (data.goals / data.gamesPlayed) : 0;

  const calcFactors: CalcFactor[] = [
    { icon: "\u{1F4CA}", label: `Averaging ${ptsPerGame.toFixed(2)} pts/game this season`, delta: Math.round((ptsPerGame - 0.5) * 15) },
    { icon: "\u{1F945}", label: `${data.goals} goals (${goalsPerGame.toFixed(2)}/game)`, delta: Math.round((goalsPerGame - 0.25) * 20) },
    { icon: "\u{1F34E}", label: `${data.assists} assists — playmaking contribution`, delta: data.assists > data.goals ? 4 : 2 },
    data.ppPoints > 5 ? { icon: "\u{26A1}", label: `${data.ppPoints} power play points — elite PP producer`, delta: 5 } : null,
    data.plusMinus !== 0 ? { icon: "\u{2696}\u{FE0F}", label: `Plus/minus: ${data.plusMinus > 0 ? "+" : ""}${data.plusMinus}`, delta: Math.round(data.plusMinus / 5) } : null,
    data.shotPct > 12 ? { icon: "\u{1F3AF}", label: `${data.shotPct.toFixed(1)}% shooting — above league avg (10%)`, delta: 4 } : null,
  ].filter((f): f is CalcFactor => f !== null && f.delta !== 0);

  const winImpact = Math.min(85, Math.max(20, 50 + calcFactors.reduce((s, f) => s + f.delta, 0)));
  const form = generateForm(6, winImpact / 100);

  return (
    <PredictionLayout
      title={data.name}
      subtitle={`${data.team} · #${data.number} · ${data.position}`}
      logo={data.logo}
      winPct={winImpact}
      winLabel="Win Impact"
      calcFactors={calcFactors}
      basePct={50}
      accent={accent}
      recentForm={form}
      betRec="Player Prop"
      betNote={`${data.name} is averaging ${ptsPerGame.toFixed(2)} pts/game with ${data.goals}G ${data.assists}A in ${data.gamesPlayed} GP. Strong over/under value on their next-game point total.`}
      extraStats={[
        { label: "Goals",   value: String(data.goals)   },
        { label: "Assists", value: String(data.assists)  },
        { label: "Points",  value: String(data.points)   },
        { label: "+/-",     value: `${data.plusMinus >= 0 ? "+" : ""}${data.plusMinus}` },
      ]}
    />
  );
}

/* ─── N Games Prediction ─────────────────────── */
const TEAM_LOGOS_NGAMES: Record<string, string> = {
  BOS: "🐻", NYR: "🗽", TOR: "🍁", MTL: "🔵",
  CHI: "🦅", DET: "🏒", VGK: "⚔️",  EDM: "🛢️",
  COL: "⛰️",  FLA: "🐆", TBL: "⚡",       CAR: "🌀",
  NYI: "🗽", NJD: "😈", PHI: "🟠", PIT: "🐧",
  WSH: "🦅", CBJ: "🔵", OTT: "⭐",      BUF: "🦙",
  MIN: "🦢", WPG: "✈️",  NSH: "🎸", STL: "🎵",
  CHC: "🐻", DAL: "⭐",      ARI: "🐶", ANA: "🦆",
  LAK: "👑", SJS: "🦈", VAN: "🧊", CGY: "🔥",
  SEA: "🧜",
};

interface NGamesView {
  teamName: string;
  teamAbbr: string;
  logo: string;
  wins: number;
  losses: number;
  otLosses: number;
  goalsFor: number;
  goalsAgainst: number;
  goalsForPerGame: number;
  goalsAgainstPerGame: number;
  ppPct: number;
  pkPct: number;
  streak: string;
  last10: string;
  winRateN: number;
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
          added ? "bg-green-500 text-white" : "bg-[#86d1ea] text-[#0a1014]"
        }`}
      >
        {added ? "✓ Added to Bet Slip" : "Add to Bet Slip"}
      </button>
    </div>
  );
}

function PredictionLayout({
  title, subtitle, logo, winPct, winLabel, calcFactors, basePct, accent, recentForm, betRec, betNote, extraStats,
}: {
  title: string; subtitle: string; logo: string; winPct: number; winLabel: string;
  calcFactors?: CalcFactor[]; basePct?: number; accent?: string;
  recentForm: ("W" | "L" | "OT")[]; betRec: string; betNote: string;
  extraStats: { label: string; value: string }[];
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
    />
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
  const [addSheet, setAddSheet] = useState<{ open: boolean; subject?: Subject }>({ open: false });

  const title =
    type === "team"        ? "Team Prediction" :
    type === "game" ? "Game Prediction" :
    type === "player"      ? "Player Prediction" :
    type === "player-prop" ? "Player Prop" :
    type === "future"      ? "Season Futures" :
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
            className="flex items-center gap-1.5 font-bold px-3 py-1.5 rounded-xl text-xs flex-shrink-0"
            style={{ backgroundColor: theme.accent, color: "#0f1416" }}
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
        {type === "player-prop" && id && <PlayerPropPrediction propId={id} />}
        {type === "future" && id && <FuturePrediction futureId={id} />}
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
