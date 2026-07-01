import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router";
import { Search, TrendingUp, ChevronRight, Plus, Goal, Star, Timer, Zap } from "lucide-react";
import { IceedgeLogo } from "./brand/IceedgeLogo";
import { BottomNav } from "./BottomNav";
import { MarketSelectorSheet } from "./MarketSelectorSheet";
import { nhlApiService } from "../services/nhlApiService";
import { predictionApiService } from "../services/predictionApiService";
import { tennisApiService } from "../services/tennisApiService";
import type { TennisApiMatch } from "../services/tennisApiService";
import type { NHLGame, BetLeg } from "../types/bet";
import { useSport, SPORT_THEMES, type Sport } from "../context/SportContext";
import { useBet } from "../context/BetContext";
import {
  fetchBet365Odds,
  extractH2HOdds,
  ODDS_SPORT_KEYS,
} from "../services/oddsApiService";
import { openBet365, bet365TennisUrl, bet365HockeyUrl } from "../services/affiliateService";

// ─── Hockey helpers ────────────────────────────────────────────────────────────

const TEAM_LOGOS: Record<string, string> = {
  BOS: "🐻", NYR: "🗽", TOR: "🍁", MTL: "🔵",
  CHI: "🦅", DET: "🏒", VGK: "⚔", EDM: "🛢",
  COL: "⛰", FLA: "🐆",
};

interface DisplayGame {
  id: string;
  period?: string;
  time?: string;
  overUnder?: number;
  totalPct?: number;
  // bet365 decimal odds — only populated when VITE_ODDS_API_KEY is set
  bet365Home?: number;
  bet365Away?: number;
  team1: { id: string; abbr: string; name: string; score?: number; logo: string; winPct: number };
  team2: { id: string; abbr: string; name: string; score?: number; logo: string; winPct: number };
}

async function toDisplayGame(game: NHLGame): Promise<DisplayGame> {
  const [homePred, totalPred] = await Promise.all([
    predictionApiService.getSinglePrediction({ marketType: "moneyline", gameId: game.id, teamId: game.homeTeam.abbreviation.toLowerCase() }),
    predictionApiService.getSinglePrediction({ marketType: "total_goals", gameId: game.id, selection: "over", line: 5.5 }),
  ]);
  return {
    id: game.id,
    period: game.period ? `${game.period}P • ${game.clock}` : undefined,
    time: game.startTime,
    overUnder: 5.5,
    totalPct: totalPred.probability,
    team1: { id: game.homeTeam.abbreviation.toLowerCase(), abbr: game.homeTeam.abbreviation, name: game.homeTeam.name, score: game.homeTeam.score, logo: TEAM_LOGOS[game.homeTeam.abbreviation] ?? "🏒", winPct: homePred.probability },
    team2: { id: game.awayTeam.abbreviation.toLowerCase(), abbr: game.awayTeam.abbreviation, name: game.awayTeam.name, score: game.awayTeam.score, logo: TEAM_LOGOS[game.awayTeam.abbreviation] ?? "🏒", winPct: 100 - homePred.probability },
  };
}

// ─── Edge detection helpers ───────────────────────────────────────────────────

/** Convert a bet365 decimal odd to the bookmaker's implied win probability (%) */
function impliedPct(decimal: number): number {
  return Math.round(100 / decimal);
}

/**
 * Edge = our model's probability minus the bookmaker's implied probability.
 * Only meaningful when we have real bet365 odds.
 */
function calcEdge(modelPct: number, decimal: number): number {
  return modelPct - impliedPct(decimal);
}

// ─── Tennis mock data ──────────────────────────────────────────────────────────

interface TennisMatch {
  id: string;
  player1: { name: string; country: string; winPct: number; sets?: number[]; serving?: boolean; bet365Odds?: number };
  player2: { name: string; country: string; winPct: number; sets?: number[]; serving?: boolean; bet365Odds?: number };
  time: string; tournament: string; surface: string; surfaceIcon: string;
  isLive?: boolean; liveSet?: string;
}

const TENNIS_LIVE_FALLBACK: TennisMatch[] = [
  {
    id: "tl1",
    player1: { name: "N. Djokovic", country: "🇷🇸", winPct: 62, sets: [6, 4], serving: true, bet365Odds: 1.52 },
    player2: { name: "C. Alcaraz",  country: "🇪🇸", winPct: 38, sets: [3, 5],                bet365Odds: 2.55 },
    time: "Live", tournament: "Roland Garros", surface: "Clay", surfaceIcon: "🟫", isLive: true, liveSet: "SET 2",
  },
  {
    id: "tl2",
    player1: { name: "J. Sinner", country: "🇮🇹", winPct: 71, sets: [6], serving: true, bet365Odds: 1.35 },
    player2: { name: "A. Zverev", country: "🇩🇪", winPct: 29, sets: [2],                 bet365Odds: 3.10 },
    time: "Live", tournament: "Roland Garros", surface: "Clay", surfaceIcon: "🟫", isLive: true, liveSet: "SET 1",
  },
];

const TENNIS_UPCOMING_FALLBACK: TennisMatch[] = [
  { id: "tu1", player1: { name: "I. Swiatek",  country: "🇵🇱", winPct: 61, bet365Odds: 1.65 }, player2: { name: "A. Sabalenka", country: "🇧🇾", winPct: 39, bet365Odds: 2.30 }, time: "14:00", tournament: "Roland Garros", surface: "Clay", surfaceIcon: "🟫" },
  { id: "tu2", player1: { name: "D. Medvedev", country: "🇷🇺", winPct: 55, bet365Odds: 1.80 }, player2: { name: "H. Rune",      country: "🇩🇰", winPct: 45, bet365Odds: 2.00 }, time: "16:00", tournament: "Roland Garros", surface: "Clay", surfaceIcon: "🟫" },
  { id: "tu3", player1: { name: "C. Gauff",    country: "🇺🇸", winPct: 58, bet365Odds: 1.72 }, player2: { name: "E. Rybakina",  country: "🇰🇿", winPct: 42, bet365Odds: 2.15 }, time: "18:30", tournament: "Roland Garros", surface: "Clay", surfaceIcon: "🟫" },
];

const TENNIS_TOP_PREDICTIONS_FALLBACK = [
  { icon: "🇷🇸", name: "Djokovic", label: "Win vs Alcaraz",   pct: 62, trend: "+3%", edge: 62 - impliedPct(1.52) },
  { icon: "🇮🇹", name: "Sinner",   label: "Win vs Zverev",    pct: 71, trend: "+5%", edge: 71 - impliedPct(1.35) },
  { icon: "🇵🇱", name: "Swiatek",  label: "Win vs Sabalenka", pct: 61, trend: "+1%", edge: 61 - impliedPct(1.65) },
];

async function toTennisMatch(m: TennisApiMatch): Promise<TennisMatch> {
  const pred = await predictionApiService.getSinglePrediction({
    marketType: "moneyline",
    gameId: m.id,
    playerId: m.player1.id,
  });

  let time = "TBD";
  if (m.isLive) {
    time = "Live";
  } else if (m.scheduledIso) {
    const d = new Date(m.scheduledIso);
    time = d.toLocaleTimeString("en-US", {
      hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/New_York",
    });
  }

  return {
    id: m.id,
    tournament: m.tournament,
    surface: m.surface,
    surfaceIcon: m.surfaceIcon,
    isLive: m.isLive,
    liveSet: m.liveSet,
    time,
    player1: {
      name: m.player1.name,
      country: m.player1.country,
      winPct: pred.probability,
      sets: m.player1.sets,
      serving: m.player1.serving,
    },
    player2: {
      name: m.player2.name,
      country: m.player2.country,
      winPct: 100 - pred.probability,
      sets: m.player2.sets,
      serving: m.player2.serving,
    },
  };
}

interface AddSheetState {
  open: boolean;
  subject?: { id: string; type: "team" | "player" | "game"; name: string; logo: string; subtitle: string };
}

// ─── Best Bets ─────────────────────────────────────────────────────────────────

const BB_BASE = import.meta.env.VITE_PREDICTION_API_URL || "";

interface BestBet {
  id: string;
  label: string;
  context: string;
  logo: string;
  rulePct: number;
  mlPct: number | null;
  mlLoading: boolean;
  leg: BetLeg;
  gameId?: string;
  teamId?: string;
}

type SortSource = "rules" | "ml";
type SortDir    = "safe"  | "risky";

function riskLabel(pct: number): { label: string; color: string } {
  if (pct >= 70) return { label: "Safe",      color: "#4ade80" };
  if (pct >= 55) return { label: "Moderate",  color: "#86d1ea" };
  if (pct >= 40) return { label: "Risky",     color: "#facc15" };
  return              { label: "High risk",  color: "#f87171" };
}

function BestBetRow({ bet, sortSource }: { bet: BestBet; sortSource: SortSource }) {
  const { addLeg, removeLeg, hasLeg } = useBet();
  const inSlip = hasLeg(bet.id);
  const displayPct = sortSource === "ml" ? (bet.mlPct ?? bet.rulePct) : bet.rulePct;
  const risk = riskLabel(displayPct);
  const isML = sortSource === "ml" && bet.mlPct != null;

  return (
    <div className="flex items-center gap-3 bg-[#131A12]/70 backdrop-blur-md border border-white/20 rounded-2xl px-3.5 py-3">
      <span className="text-xl flex-shrink-0">{bet.logo}</span>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="text-white text-xs font-medium truncate">{bet.label}</span>
          <span className="text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0 font-medium"
            style={{ color: risk.color, backgroundColor: `${risk.color}18`, border: `1px solid ${risk.color}44` }}>
            {risk.label}
          </span>
        </div>
        <span className="text-[#bfc8cc] text-[10px]">{bet.context}</span>
        <div className="flex items-center gap-2 mt-1.5">
          <div className="flex-1 bg-[#0A0E0C] rounded-full h-1.5 overflow-hidden">
            <div className="h-full rounded-full transition-all duration-500"
              style={{ width: `${displayPct}%`, backgroundColor: isML ? "#a78bfa" : risk.color }} />
          </div>
          <span className="text-[10px] font-bold flex-shrink-0"
            style={{ color: isML ? "#a78bfa" : risk.color }}>
            {sortSource === "ml" && bet.mlLoading ? "…" : `${displayPct}%`}
          </span>
          {isML && <span className="text-[9px] text-[#a78bfa] flex-shrink-0 font-medium">ML</span>}
          {sortSource === "ml" && !bet.mlLoading && bet.mlPct == null &&
            <span className="text-[9px] text-[#bfc8cc] flex-shrink-0">rules</span>}
        </div>
      </div>

      <button
        onClick={() => inSlip ? removeLeg(bet.id) : addLeg({ ...bet.leg, probability: displayPct })}
        className={`w-8 h-8 rounded-xl border flex items-center justify-center text-sm flex-shrink-0 transition-colors ${
          inSlip
            ? "bg-green-500/15 border-green-500/30 text-green-400"
            : "bg-[#86d1ea]/10 border-[#86d1ea]/30 text-[#86d1ea] active:bg-[#86d1ea]/20"
        }`}
      >
        {inSlip ? "✓" : "+"}
      </button>
    </div>
  );
}

function BestBetsSection({
  games,
  tennisLive,
  tennisUpcoming,
  sport,
  accent,
  isLoading,
}: {
  games: DisplayGame[];
  tennisLive: TennisMatch[];
  tennisUpcoming: TennisMatch[];
  sport: "hockey" | "tennis";
  accent: string;
  isLoading: boolean;
}) {
  const [sortSource, setSortSource] = useState<SortSource>("rules");
  const [sortDir,    setSortDir]    = useState<SortDir>("safe");
  const [bets, setBets]             = useState<BestBet[]>([]);
  const [mlFetched,  setMlFetched]  = useState(false);

  // When hockey has no games (e.g. off-season), fall back to tennis matches
  const usingTennisFallback = sport === "hockey" && games.length === 0 && (tennisLive.length > 0 || tennisUpcoming.length > 0);

  // Build raw bets list from game data
  useEffect(() => {
    const raw: BestBet[] = [];

    if (sport === "hockey" && games.length > 0) {
      for (const g of games) {
        const ctx1 = `vs ${g.team2.abbr} · ${g.period ?? g.time ?? ""}`.trim().replace(/·\s*$/, "");
        const ctx2 = `vs ${g.team1.abbr} · ${g.period ?? g.time ?? ""}`.trim().replace(/·\s*$/, "");

        raw.push({
          id: `bb-${g.id}-ml1`, label: `${g.team1.abbr} to win`, context: ctx1,
          logo: g.team1.logo, rulePct: g.team1.winPct, mlPct: null, mlLoading: false,
          gameId: g.id, teamId: g.team1.id,
          leg: { id: `bb-${g.id}-ml1`, marketType: "moneyline", marketLabel: "Moneyline",
            subjectType: "game", subjectId: g.id, subjectName: `${g.team1.abbr} vs ${g.team2.abbr}`,
            subjectLogo: g.team1.logo, selection: `${g.team1.abbr} to win`,
            selectionShort: `${g.team1.abbr} ML`, probability: g.team1.winPct,
            gameInfo: `${g.team1.abbr} vs ${g.team2.abbr}`, addedAt: new Date().toISOString() },
        });
        raw.push({
          id: `bb-${g.id}-ml2`, label: `${g.team2.abbr} to win`, context: ctx2,
          logo: g.team2.logo, rulePct: g.team2.winPct, mlPct: null, mlLoading: false,
          gameId: g.id, teamId: g.team2.id,
          leg: { id: `bb-${g.id}-ml2`, marketType: "moneyline", marketLabel: "Moneyline",
            subjectType: "game", subjectId: g.id, subjectName: `${g.team1.abbr} vs ${g.team2.abbr}`,
            subjectLogo: g.team2.logo, selection: `${g.team2.abbr} to win`,
            selectionShort: `${g.team2.abbr} ML`, probability: g.team2.winPct,
            gameInfo: `${g.team1.abbr} vs ${g.team2.abbr}`, addedAt: new Date().toISOString() },
        });
        if (g.totalPct != null) {
          const line = g.overUnder ?? 5.5;
          raw.push({
            id: `bb-${g.id}-over`, label: `Over ${line} goals`,
            context: `${g.team1.abbr} vs ${g.team2.abbr}`,
            logo: "📈", rulePct: g.totalPct, mlPct: null, mlLoading: false, gameId: g.id,
            leg: { id: `bb-${g.id}-over`, marketType: "total_goals", marketLabel: "Total Goals O/U",
              subjectType: "game", subjectId: g.id, subjectName: `${g.team1.abbr} vs ${g.team2.abbr}`,
              subjectLogo: "📈", selection: `Over ${line}`, selectionShort: `O${line}`,
              probability: g.totalPct, line, gameInfo: `${g.team1.abbr} vs ${g.team2.abbr}`,
              addedAt: new Date().toISOString() },
          });
          const underPct = 100 - g.totalPct;
          raw.push({
            id: `bb-${g.id}-under`, label: `Under ${line} goals`,
            context: `${g.team1.abbr} vs ${g.team2.abbr}`,
            logo: "📉", rulePct: underPct, mlPct: null, mlLoading: false, gameId: g.id,
            leg: { id: `bb-${g.id}-under`, marketType: "total_goals", marketLabel: "Total Goals O/U",
              subjectType: "game", subjectId: g.id, subjectName: `${g.team1.abbr} vs ${g.team2.abbr}`,
              subjectLogo: "📉", selection: `Under ${line}`, selectionShort: `U${line}`,
              probability: underPct, line, gameInfo: `${g.team1.abbr} vs ${g.team2.abbr}`,
              addedAt: new Date().toISOString() },
          });
        }
      }
    } else {
      // Tennis (or hockey off-season fallback showing tennis)
      for (const m of [...tennisLive, ...tennisUpcoming]) {
        const ctx = `${m.tournament} · ${m.isLive ? "Live" : m.time}`;
        raw.push({
          id: `bb-tennis-${m.id}-p1`, label: `${m.player1.name} to win`, context: ctx,
          logo: m.player1.country, rulePct: m.player1.winPct, mlPct: null, mlLoading: false,
          leg: { id: `bb-tennis-${m.id}-p1`, marketType: "tennis_match_winner", marketLabel: "Match Winner",
            subjectType: "player", subjectId: m.id, subjectName: m.player1.name,
            subjectLogo: m.player1.country, selection: `${m.player1.name} to win`,
            selectionShort: `${m.player1.name.split(" ").pop()} W`,
            probability: m.player1.winPct, gameInfo: ctx, addedAt: new Date().toISOString() },
        });
        raw.push({
          id: `bb-tennis-${m.id}-p2`, label: `${m.player2.name} to win`, context: ctx,
          logo: m.player2.country, rulePct: m.player2.winPct, mlPct: null, mlLoading: false,
          leg: { id: `bb-tennis-${m.id}-p2`, marketType: "tennis_match_winner", marketLabel: "Match Winner",
            subjectType: "player", subjectId: m.id, subjectName: m.player2.name,
            subjectLogo: m.player2.country, selection: `${m.player2.name} to win`,
            selectionShort: `${m.player2.name.split(" ").pop()} W`,
            probability: m.player2.winPct, gameInfo: ctx, addedAt: new Date().toISOString() },
        });
      }
    }

    setBets(raw);
    setMlFetched(false);
  }, [games, tennisLive, tennisUpcoming, sport]);

  // Lazy ML fetch when ML tab selected
  useEffect(() => {
    if (sortSource !== "ml" || mlFetched || bets.length === 0 || !BB_BASE) return;
    setMlFetched(true);
    setBets(prev => prev.map(b => ({ ...b, mlLoading: true })));

    bets.slice(0, 20).forEach(async (bet) => {
      try {
        const body: Record<string, unknown> = { type: sport === "hockey" ? "game" : "tennis", subjectId: bet.teamId ?? bet.gameId ?? bet.id };
        if (bet.teamId) body.opponentId = bet.gameId;
        const res = await fetch(`${BB_BASE}/predict/ml`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (res.ok) {
          const data = await res.json() as { probability?: number };
          setBets(prev => prev.map(b => b.id === bet.id ? { ...b, mlPct: Math.round(data.probability ?? bet.rulePct), mlLoading: false } : b));
        } else {
          setBets(prev => prev.map(b => b.id === bet.id ? { ...b, mlLoading: false } : b));
        }
      } catch {
        setBets(prev => prev.map(b => b.id === bet.id ? { ...b, mlLoading: false } : b));
      }
    });
  }, [sortSource, mlFetched, bets, sport]);

  const sorted = useMemo(() => {
    const src = (b: BestBet) => sortSource === "ml" ? (b.mlPct ?? b.rulePct) : b.rulePct;
    return [...bets].sort((a, b) => sortDir === "safe" ? src(b) - src(a) : src(a) - src(b)).slice(0, 15);
  }, [bets, sortSource, sortDir]);

  return (
    <section className="px-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Star size={13} style={{ color: accent }} />
          <span className="text-white text-sm font-medium">Best Bets</span>
          {!isLoading && <span className="text-[10px] text-[#bfc8cc] bg-white/5 px-1.5 py-0.5 rounded-full">Top {sorted.length}</span>}
          {usingTennisFallback && <span className="text-[10px] text-[#facc15] bg-[#facc15]/10 border border-[#facc15]/20 px-1.5 py-0.5 rounded-full">Tennis · NHL off-season</span>}
        </div>
        <div className="flex items-center gap-1.5">
          {/* Source toggle */}
          <div className="flex bg-white/5 border border-white/10 rounded-full p-0.5 gap-0.5">
            {(["rules", "ml"] as SortSource[]).map((s) => (
              <button key={s} onClick={() => setSortSource(s)}
                className={`px-2.5 py-0.5 rounded-full text-[10px] font-medium transition-all ${sortSource === s ? "text-[#0A0E0C] font-bold" : "text-[#8a9ea6]"}`}
                style={sortSource === s ? { backgroundColor: s === "ml" ? "#a78bfa" : accent } : {}}>
                {s === "ml" ? "ML" : "Rules"}
              </button>
            ))}
          </div>
          {/* Direction toggle */}
          <button onClick={() => setSortDir(d => d === "safe" ? "risky" : "safe")}
            className="px-2.5 py-1 rounded-full bg-white/5 border border-white/10 text-[10px] text-[#8a9ea6] hover:text-white transition-all">
            {sortDir === "safe" ? "↓ Safe" : "↑ Risky"}
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-2">
          {[1,2,3,4,5].map(i => <div key={i} className="h-16 bg-[#131A12] rounded-2xl animate-pulse" />)}
        </div>
      ) : sorted.length === 0 ? (
        <div className="py-8 text-center text-[#bfc8cc] text-xs">No bets available right now</div>
      ) : (
        <div className="flex flex-col gap-2">
          {sorted.map(bet => <BestBetRow key={bet.id} bet={bet} sortSource={sortSource} />)}
        </div>
      )}
    </section>
  );
}

// ─── Sport Selector ────────────────────────────────────────────────────────────

function SportSelector() {
  const { sport, setSport, theme } = useSport();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handleClick(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2.5 select-none">
        {/* ICEEDGE logo mark */}
        <IceedgeLogo size={38} wordmark={false} />
        {/* Brand name + sport label */}
        <div className="flex flex-col leading-none gap-0.5">
          <span
            className="tracking-[0.14em] uppercase text-sm font-bold text-white"
            style={{ fontFamily: "'Oswald', 'Arial Narrow', sans-serif", letterSpacing: "0.12em" }}
          >
            ICEEDGE
          </span>
          <span className="text-[10px] tracking-wider" style={{ color: theme.accent, opacity: 0.85 }}>
            {theme.sportLabel}
          </span>
        </div>
        <span className="text-xs" style={{ color: theme.accent }}>▾</span>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-2 bg-[#131A12] border border-white/20 rounded-2xl overflow-hidden z-50 min-w-[168px] shadow-xl shadow-black/50 backdrop-blur-sm">
          {(Object.keys(SPORT_THEMES) as Sport[]).map((s) => {
            const t = SPORT_THEMES[s]; const active = sport === s;
            return (
              <button key={s} onClick={() => { setSport(s); setOpen(false); }}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${active ? "bg-white/5" : "hover:bg-white/5"}`}>
                <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${t.accent}20`, border: `1.5px solid ${t.accent}50` }}>
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: t.accent }} />
                </div>
                <span className="text-white text-sm flex-1">{t.sportLabel}</span>
                {active && <span className="text-xs font-bold" style={{ color: t.accent }}>✓</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Odds pill ─────────────────────────────────────────────────────────────────

function OddsPill({ decimal, onBet }: { decimal: number; onBet: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onBet(); }}
      className="flex items-center gap-1 bg-green-500/10 border border-green-500/20 rounded-full px-2 py-0.5 active:bg-green-500/20 transition-colors"
    >
      <span className="text-[9px] text-[#bfc8cc]">bet365</span>
      <span className="text-[10px] font-bold text-green-400">{decimal.toFixed(2)}</span>
    </button>
  );
}

// ─── Edge badge ────────────────────────────────────────────────────────────────

function EdgeBadge({ edge }: { edge: number }) {
  if (edge < 8) return null;
  return (
    <span className="text-[9px] px-2 py-0.5 rounded-full bg-green-500/10 border border-green-500/25 text-green-400 font-medium flex-shrink-0">
      +{edge}% edge
    </span>
  );
}

// ─── Hockey live game card ─────────────────────────────────────────────────────

function LiveGameCard({ game, onOpenSheet }: { game: DisplayGame; onOpenSheet: () => void }) {
  const { theme } = useSport();
  const accent = theme.accent;
  const { addLeg, hasLeg } = useBet();

  const legId = `${game.id}-moneyline-${game.team1.id}`;
  const isAdded = hasLeg(legId);

  const edge = game.bet365Home ? calcEdge(game.team1.winPct, game.bet365Home) : 0;

  function quickAdd(e: React.MouseEvent) {
    e.stopPropagation();
    if (isAdded) return;
    const leg: BetLeg = {
      id: legId,
      marketType: "moneyline",
      marketLabel: "Moneyline",
      subjectType: "game",
      subjectId: game.id,
      subjectName: `${game.team1.abbr} vs ${game.team2.abbr}`,
      subjectLogo: game.team1.logo,
      selection: `${game.team1.name} to win`,
      selectionShort: `${game.team1.abbr} ML`,
      probability: game.team1.winPct,
      gameInfo: `${game.team1.abbr} vs ${game.team2.abbr} · Live`,
      addedAt: new Date().toISOString(),
    };
    addLeg(leg);
  }

  return (
    <div className="min-w-[280px] bg-[#131A12]/70 backdrop-blur-md border border-white/20 rounded-2xl p-4 flex-shrink-0">

      {/* Header: live badge + edge + buttons */}
      <div className="flex items-center justify-between mb-3 gap-2">
        <span className="text-[10px] text-red-400 font-medium uppercase tracking-wide flex items-center gap-1 flex-shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse inline-block" />{game.period}
        </span>
        <div className="flex items-center gap-1.5 min-w-0">
          <EdgeBadge edge={edge} />
          <button
            onClick={quickAdd}
            className={`text-[10px] px-2.5 py-0.5 rounded-full border font-medium flex-shrink-0 transition-colors ${
              isAdded
                ? "bg-green-500/15 border-green-500/30 text-green-400"
                : "bg-[#86d1ea]/10 border-[#86d1ea]/30 text-[#86d1ea] active:bg-[#86d1ea]/20"
            }`}
          >
            {isAdded ? "✓ Added" : "+ Add"}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onOpenSheet(); }}
            className="text-[10px] text-[#bfc8cc] border border-white/20 px-2 py-0.5 rounded-full flex-shrink-0 active:bg-white/5"
          >
            More
          </button>
        </div>
      </div>

      {/* Teams + score */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex flex-col items-center gap-1">
          <span className="text-2xl">{game.team1.logo}</span>
          <span className="text-white text-xs font-bold">{game.team1.abbr}</span>
        </div>
        <div className="flex flex-col items-center gap-0.5">
          <div className="flex items-center gap-2.5">
            <span className="text-white text-3xl font-bold tabular-nums">{game.team1.score}</span>
            <span className="text-[#bfc8cc] text-lg">–</span>
            <span className="text-white text-3xl font-bold tabular-nums">{game.team2.score}</span>
          </div>
          {game.overUnder && <span className="text-[#bfc8cc] text-[9px]">O/U {game.overUnder}</span>}
        </div>
        <div className="flex flex-col items-center gap-1">
          <span className="text-2xl">{game.team2.logo}</span>
          <span className="text-white text-xs font-bold">{game.team2.abbr}</span>
        </div>
      </div>

      {/* Model probability bar */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] font-bold w-7 flex-shrink-0" style={{ color: accent }}>{game.team1.winPct}%</span>
        <div className="flex-1 bg-[#0A0E0C] rounded-full h-2 overflow-hidden flex">
          <div className="h-full rounded-l-full transition-all duration-500" style={{ width: `${game.team1.winPct}%`, backgroundColor: accent }} />
          <div className="h-full bg-[#1B2419] flex-1" />
        </div>
        <span className="text-[#bfc8cc] text-[10px] font-bold w-7 text-right flex-shrink-0">{game.team2.winPct}%</span>
      </div>

      {/* bet365 odds row — only shown when API has real odds */}
      {game.bet365Home && game.bet365Away ? (
        <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/5">
          <OddsPill decimal={game.bet365Home} onBet={() => openBet365(bet365HockeyUrl())} />
          <span className="text-[9px] text-[#bfc8cc]">Moneyline</span>
          <OddsPill decimal={game.bet365Away} onBet={() => openBet365(bet365HockeyUrl())} />
        </div>
      ) : (
        /* No API key — show a subtle link to bet365 instead */
        <div className="flex items-center justify-end mt-1">
          <button
            onClick={() => openBet365(bet365HockeyUrl())}
            className="text-[9px] text-green-400 border border-green-500/20 bg-green-500/8 px-2 py-1 rounded-full"
          >
            Bet on bet365 →
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Hockey upcoming game row ──────────────────────────────────────────────────

function UpcomingGameRow({ game, onOpenSheet }: { game: DisplayGame; onOpenSheet: () => void }) {
  const { theme } = useSport();
  const accent = theme.accent;
  const { addLeg, hasLeg } = useBet();

  const legId = `${game.id}-moneyline-${game.team1.id}`;
  const isAdded = hasLeg(legId);

  const edge = game.bet365Home ? calcEdge(game.team1.winPct, game.bet365Home) : 0;

  function quickAdd(e: React.MouseEvent) {
    e.stopPropagation();
    if (isAdded) return;
    const leg: BetLeg = {
      id: legId,
      marketType: "moneyline",
      marketLabel: "Moneyline",
      subjectType: "game",
      subjectId: game.id,
      subjectName: `${game.team1.abbr} vs ${game.team2.abbr}`,
      subjectLogo: game.team1.logo,
      selection: `${game.team1.name} to win`,
      selectionShort: `${game.team1.abbr} ML`,
      probability: game.team1.winPct,
      gameInfo: `${game.team1.abbr} vs ${game.team2.abbr} · ${game.time}`,
      addedAt: new Date().toISOString(),
    };
    addLeg(leg);
  }

  return (
    <div className="bg-[#131A12]/70 backdrop-blur-md border border-white/20 rounded-2xl p-3.5">
      <div className="flex items-center gap-3">

        {/* Time column */}
        <div className="flex flex-col items-center min-w-[38px] flex-shrink-0">
          <span className="text-xs font-medium" style={{ color: accent }}>{game.time}</span>
          <span className="text-[#bfc8cc] text-[9px]">ET</span>
        </div>

        {/* Teams column */}
        <div className="flex-1 min-w-0">
          {/* Team 1 */}
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="text-base flex-shrink-0">{game.team1.logo}</span>
            <span className="text-white text-xs font-medium flex-1 truncate">{game.team1.abbr}</span>
            <span className="text-[10px] font-bold tabular-nums" style={{ color: accent }}>{game.team1.winPct}%</span>
            {game.bet365Home && (
              <OddsPill decimal={game.bet365Home} onBet={() => openBet365(bet365HockeyUrl())} />
            )}
          </div>
          {/* Team 2 */}
          <div className="flex items-center gap-1.5">
            <span className="text-base flex-shrink-0">{game.team2.logo}</span>
            <span className="text-white text-xs font-medium flex-1 truncate">{game.team2.abbr}</span>
            <span className="text-[#bfc8cc] text-[10px] font-bold tabular-nums">{game.team2.winPct}%</span>
            {game.bet365Away && (
              <OddsPill decimal={game.bet365Away} onBet={() => openBet365(bet365HockeyUrl())} />
            )}
          </div>
        </div>

        {/* Actions column */}
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          <div className="flex items-center gap-1.5">
            {edge >= 8 && <EdgeBadge edge={edge} />}
            <button
              onClick={quickAdd}
              className={`w-8 h-8 rounded-xl border flex items-center justify-center text-sm font-bold transition-colors ${
                isAdded
                  ? "bg-green-500/15 border-green-500/30 text-green-400"
                  : "bg-[#86d1ea]/10 border-[#86d1ea]/30 text-[#86d1ea] active:bg-[#86d1ea]/20"
              }`}
              title={isAdded ? "Already in slip" : "Add to slip"}
            >
              {isAdded ? "✓" : "+"}
            </button>
          </div>
          {/* O/U info */}
          {game.overUnder && (
            <div className="text-right">
              <span className="text-[9px] text-[#bfc8cc]">O/U {game.overUnder}</span>
              {game.totalPct && <span className="text-[9px] text-[#86d1ea] ml-1">{game.totalPct}%</span>}
            </div>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onOpenSheet(); }}
            className="text-[9px] text-[#bfc8cc] underline underline-offset-2"
          >
            More bets
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Tennis live card ─────────────────────────────────────────────────────────

function TennisLiveCard({ match, accent }: { match: TennisMatch; accent: string }) {
  const navigate = useNavigate();
  const { addLeg, hasLeg } = useBet();
  const legId = `tennis-${match.id}-p1`;
  const isAdded = hasLeg(legId);

  const edge = match.player1.bet365Odds ? calcEdge(match.player1.winPct, match.player1.bet365Odds) : 0;

  function quickAdd(e: React.MouseEvent) {
    e.stopPropagation();
    if (isAdded) return;
    addLeg({
      id: legId,
      marketType: "moneyline",
      marketLabel: "Match Winner",
      subjectType: "player",
      subjectId: match.id,
      subjectName: match.player1.name,
      subjectLogo: match.player1.country,
      selection: `${match.player1.name} to win`,
      selectionShort: `${match.player1.name.split(" ").pop()} W`,
      probability: match.player1.winPct,
      gameInfo: `${match.player1.name} vs ${match.player2.name} · ${match.tournament}`,
      addedAt: new Date().toISOString(),
    });
  }

  return (
    <div
      className="min-w-[280px] bg-[#131A12]/70 backdrop-blur-md border border-white/20 rounded-2xl p-4 flex-shrink-0 cursor-pointer active:scale-[0.98] transition-transform"
      onClick={() => navigate(`/predictions/tennis?id=${match.id}`)}
    >

      {/* Header */}
      <div className="flex items-center justify-between mb-3 gap-2">
        <span className="text-[10px] text-red-400 font-medium uppercase tracking-wide flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse inline-block" />{match.liveSet}
        </span>
        <div className="flex items-center gap-1.5">
          <EdgeBadge edge={edge} />
          <span className="text-[10px] px-2 py-0.5 rounded-full border" style={{ color: accent, borderColor: `${accent}4d`, backgroundColor: `${accent}1a` }}>
            {match.surfaceIcon} {match.surface}
          </span>
        </div>
      </div>

      {/* Players + sets */}
      <div className="flex flex-col gap-2 mb-3">
        {[match.player1, match.player2].map((p, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="text-base w-6 flex-shrink-0">{p.country}</span>
            <span className="text-white text-xs flex-1 font-medium">{p.name}</span>
            {p.serving && <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: accent }} />}
            <div className="flex gap-1">
              {(p.sets ?? []).map((s, j) => (
                <span key={j} className="text-xs font-bold w-5 text-center rounded tabular-nums"
                  style={{ color: j === (p.sets!.length - 1) ? accent : "#bfc8cc" }}>{s}</span>
              ))}
            </div>
            {p.bet365Odds && (
              <OddsPill decimal={p.bet365Odds} onBet={() => openBet365(bet365TennisUrl())} />
            )}
          </div>
        ))}
      </div>

      {/* Probability bar */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] font-bold w-7" style={{ color: accent }}>{match.player1.winPct}%</span>
        <div className="flex-1 bg-[#0A0E0C] rounded-full h-2 overflow-hidden flex">
          <div className="h-full rounded-l-full" style={{ width: `${match.player1.winPct}%`, backgroundColor: accent }} />
          <div className="h-full bg-[#1B2419] flex-1" />
        </div>
        <span className="text-[#bfc8cc] text-[10px] font-bold w-7 text-right">{match.player2.winPct}%</span>
      </div>

      {/* Quick add — stops propagation so card click doesn't also fire */}
      <button
        onClick={(e) => { e.stopPropagation(); quickAdd(e); }}
        className={`w-full mt-1 py-1.5 rounded-xl text-xs font-bold transition-colors ${
          isAdded
            ? "bg-green-500/15 border border-green-500/30 text-green-400"
            : "bg-[#86d1ea]/10 border border-[#86d1ea]/25 text-[#86d1ea] active:bg-[#86d1ea]/20"
        }`}
      >
        {isAdded ? "✓ Added to slip" : `+ Add ${match.player1.name.split(" ").pop()} to slip`}
      </button>
    </div>
  );
}

// ─── Tennis upcoming row ──────────────────────────────────────────────────────

function TennisMatchRow({ match, accent }: { match: TennisMatch; accent: string }) {
  const navigate = useNavigate();
  const { addLeg, hasLeg } = useBet();
  const legId = `tennis-${match.id}-p1`;
  const isAdded = hasLeg(legId);

  const edge = match.player1.bet365Odds ? calcEdge(match.player1.winPct, match.player1.bet365Odds) : 0;

  function quickAdd(e: React.MouseEvent) {
    e.stopPropagation();
    if (isAdded) return;
    addLeg({
      id: legId,
      marketType: "moneyline",
      marketLabel: "Match Winner",
      subjectType: "player",
      subjectId: match.id,
      subjectName: match.player1.name,
      subjectLogo: match.player1.country,
      selection: `${match.player1.name} to win`,
      selectionShort: `${match.player1.name.split(" ").pop()} W`,
      probability: match.player1.winPct,
      gameInfo: `${match.player1.name} vs ${match.player2.name} · ${match.tournament}`,
      addedAt: new Date().toISOString(),
    });
  }

  return (
    <div
      className="bg-[#131A12]/70 backdrop-blur-md border border-white/20 rounded-2xl p-3.5 cursor-pointer active:scale-[0.98] transition-transform"
      onClick={() => navigate(`/predictions/tennis?id=${match.id}`)}
    >
      <div className="flex items-center gap-3">

        {/* Time */}
        <div className="flex flex-col items-center min-w-[38px] flex-shrink-0">
          <span className="text-xs font-medium" style={{ color: accent }}>{match.time}</span>
          <span className="text-[#bfc8cc] text-[9px]">ET</span>
        </div>

        {/* Players */}
        <div className="flex-1 min-w-0">
          {[match.player1, match.player2].map((p, i) => (
            <div key={i} className={`flex items-center gap-1.5 ${i === 0 ? "mb-1.5" : ""}`}>
              <span className="text-base flex-shrink-0">{p.country}</span>
              <span className="text-white text-xs font-medium flex-1 truncate">{p.name}</span>
              <span className="text-[10px] font-bold tabular-nums" style={{ color: i === 0 ? accent : "#bfc8cc" }}>{p.winPct}%</span>
              {p.bet365Odds && (
                <OddsPill decimal={p.bet365Odds} onBet={() => openBet365(bet365TennisUrl())} />
              )}
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          <div className="flex items-center gap-1.5">
            {edge >= 8 && <EdgeBadge edge={edge} />}
            <button
              onClick={(e) => { e.stopPropagation(); quickAdd(e); }}
              className={`w-8 h-8 rounded-xl border flex items-center justify-center text-sm font-bold transition-colors ${
                isAdded
                  ? "bg-green-500/15 border-green-500/30 text-green-400"
                  : "bg-[#86d1ea]/10 border-[#86d1ea]/30 text-[#86d1ea] active:bg-[#86d1ea]/20"
              }`}
            >
              {isAdded ? "✓" : "+"}
            </button>
          </div>
          <span className="text-[9px] px-1.5 py-0.5 rounded-full" style={{ color: accent, backgroundColor: `${accent}1a` }}>
            {match.surfaceIcon} {match.surface}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export function HockeyLanding() {
  const navigate = useNavigate();
  const { sport, theme } = useSport();
  const accent = theme.accent;
  const [addSheet, setAddSheet] = useState<AddSheetState>({ open: false });
  const [liveGames, setLiveGames] = useState<DisplayGame[]>([]);
  const [upcomingGames, setUpcomingGames] = useState<DisplayGame[]>([]);
  const [topPredictions, setTopPredictions] = useState<{ teamLogo: string; team: string; label: string; pct: number; trend: string; edge: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [upcomingLabel, setUpcomingLabel] = useState("Tonight's Games");

  // Tennis state
  const [tennisLive, setTennisLive] = useState<TennisMatch[]>([]);
  const [tennisUpcoming, setTennisUpcoming] = useState<TennisMatch[]>([]);
  const [tennisTopPreds, setTennisTopPreds] = useState<Array<{ icon: string; name: string; label: string; pct: number; trend: string; edge: number }>>([]);
  const [tennisLoading, setTennisLoading] = useState(false);

  // Load NHL games + model predictions
  useEffect(() => {
    if (sport !== "hockey") return;
    setLoading(true);
    async function load() {
      try {
        const live = await nhlApiService.getLiveGames();
        let scheduled: typeof live = [];
        let label = "Tonight's Games";
        for (let offset = 0; offset <= 7; offset++) {
          const d = new Date();
          d.setDate(d.getDate() + offset);
          const dateStr = d.toISOString().split("T")[0];
          const all = await nhlApiService.getGamesByDate(dateStr);
          scheduled = all.filter((g) => ["scheduled", "live", "preview"].includes(g.status));
          if (scheduled.length > 0) {
            if (offset === 1) label = "Tomorrow's Games";
            else if (offset > 1) label = d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" }) + " Games";
            break;
          }
        }
        const [liveDisplay, upcomingDisplay] = await Promise.all([
          Promise.all(live.map(toDisplayGame)),
          Promise.all(scheduled.map(toDisplayGame)),
        ]);
        setLiveGames(liveDisplay);
        setUpcomingGames(upcomingDisplay);
        setUpcomingLabel(label);
        const allDisplay = [...liveDisplay, ...upcomingDisplay];
        setTopPredictions(
          allDisplay
            .sort((a, b) => b.team1.winPct - a.team1.winPct)
            .slice(0, 3)
            .map((g) => ({
              teamLogo: g.team1.logo,
              team: g.team1.abbr,
              label: `Win vs ${g.team2.abbr}`,
              pct: g.team1.winPct,
              trend: "+2%",
              edge: g.bet365Home ? calcEdge(g.team1.winPct, g.bet365Home) : 0,
            }))
        );
      } catch (err) {
        console.error("[HockeyLanding] Failed to load games:", err);
        setLiveGames([]);
        setUpcomingGames([]);
        setTopPredictions([]);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [sport]);

  // Overlay real Bet365 odds — stored separately, does NOT overwrite model winPct
  useEffect(() => {
    if (sport !== "hockey") return;
    fetchBet365Odds(ODDS_SPORT_KEYS.hockey).then((events) => {
      if (!events.length) return;

      function applyOdds(prev: DisplayGame[]): DisplayGame[] {
        return prev.map((g) => {
          const ev = events.find(
            (e) =>
              e.homeTeam?.toLowerCase().includes(g.team1.abbr.toLowerCase()) ||
              e.awayTeam?.toLowerCase().includes(g.team2.abbr.toLowerCase())
          );
          if (!ev) return g;
          const odds = extractH2HOdds(ev);
          if (!odds) return g;
          return { ...g, bet365Home: odds.home, bet365Away: odds.away };
        });
      }

      setLiveGames(applyOdds);
      setUpcomingGames(applyOdds);

      // Recalculate top predictions with edge now that odds are available
      setTopPredictions((prev) =>
        prev.map((p) => {
          // Find matching event by team abbr
        
          const ev = events.find((e) => e.homeTeam?.toLowerCase().includes(p.team.toLowerCase()));
          if (!ev) return p;
          const odds = extractH2HOdds(ev);
          if (!odds) return p;
          return { ...p, edge: calcEdge(p.pct, odds.home) };
        })
      );
    });
  }, [sport]);

  // Load tennis matches from API, fall back to mock data if key not set
  useEffect(() => {
    if (sport !== "tennis") return;
    setTennisLoading(true);
    async function load() {
      try {
        const [liveRaw, fixturesRaw] = await Promise.all([
          tennisApiService.getLiveMatches(),
          tennisApiService.getFixtures(),
        ]);
        const [liveDisplay, upcomingDisplay] = await Promise.all([
          Promise.all(liveRaw.map(toTennisMatch)),
          Promise.all(fixturesRaw.map(toTennisMatch)),
        ]);
        setTennisLive(liveDisplay);
        setTennisUpcoming(upcomingDisplay);
        const all = [...liveDisplay, ...upcomingDisplay];
        setTennisTopPreds(
          all
            .sort((a, b) => b.player1.winPct - a.player1.winPct)
            .slice(0, 3)
            .map((m) => ({
              icon: m.player1.country,
              name: m.player1.name.split(" ")[0],
              label: `Win vs ${m.player2.name.split(" ")[0]}`,
              pct: m.player1.winPct,
              trend: "+2%",
              edge: m.player1.bet365Odds ? calcEdge(m.player1.winPct, m.player1.bet365Odds) : 0,
            }))
        );
      } catch (err) {
        console.warn("[Tennis] API unavailable — using fallback data:", err);
        setTennisLive(TENNIS_LIVE_FALLBACK);
        setTennisUpcoming(TENNIS_UPCOMING_FALLBACK);
        setTennisTopPreds(TENNIS_TOP_PREDICTIONS_FALLBACK);
      } finally {
        setTennisLoading(false);
      }
    }
    load();
  }, [sport]);

  // Overlay Bet365 tennis odds from The Odds API
  useEffect(() => {
    if (sport !== "tennis") return;
    fetchBet365Odds(ODDS_SPORT_KEYS.tennis).then((events) => {
      if (!events.length) return;

      /** Extract last name: "Djokovic N." → "djokovic", "Novak Djokovic" → "djokovic" */
      function lastNameOf(n: string): string {
        const parts = n.trim().split(" ");
        return (parts[parts.length - 1].endsWith(".")
          ? parts[0]
          : parts[parts.length - 1]
        ).toLowerCase();
      }

      function applyTennisOdds(prev: TennisMatch[]): TennisMatch[] {
        return prev.map((m) => {
          const p1 = lastNameOf(m.player1.name);
          const p2 = lastNameOf(m.player2.name);
          const ev = events.find((e) => {
            const h = lastNameOf(e.homeTeam);
            const a = lastNameOf(e.awayTeam);
            return (h === p1 && a === p2) || (h === p2 && a === p1);
          });
          if (!ev) return m;
          const odds = extractH2HOdds(ev);
          if (!odds) return m;
          const homeIsP1 = lastNameOf(ev.homeTeam) === p1;
          return {
            ...m,
            player1: { ...m.player1, bet365Odds: homeIsP1 ? odds.home : odds.away },
            player2: { ...m.player2, bet365Odds: homeIsP1 ? odds.away : odds.home },
          };
        });
      }

      setTennisLive(applyTennisOdds);
      setTennisUpcoming(applyTennisOdds);
    });
  }, [sport]);

  function openGameSheet(gameId: string) {
    setAddSheet({ open: true, gameId });
  }

  return (
    <div className="flex flex-col min-h-screen pb-24" style={{ background: "#0A0E0C" }}>
      {/* Header */}
      <div className="sticky top-0 z-40 px-4 pt-12 pb-3"
        style={{ background: "rgba(10,14,12,0.88)", backdropFilter: "blur(16px)", borderBottom: "1px solid #283323" }}>
        <SportSelector />
      </div>

      <div className="flex-1 overflow-y-auto">
        {sport === "hockey" ? (
          <div className="px-4 py-4 flex flex-col gap-6">
            {/* Best Bets */}
            <BestBetsSection
              games={[...liveGames, ...upcomingGames]}
              tennisLive={[]}
              tennisUpcoming={[]}
              sport="hockey"
              accent={accent}
              isLoading={loading}
            />

            {/* Live Games */}
            {liveGames.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                  <h2 className="text-white text-sm font-bold uppercase tracking-wider">Live Now</h2>
                </div>
                <div className="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4 snap-x">
                  {liveGames.map((g) => (
                    <LiveGameCard key={g.id} game={g} onOpenSheet={() => openGameSheet(g.id)} accent={accent} />
                  ))}
                </div>
              </section>
            )}

            {/* Upcoming Games */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-white text-sm font-bold uppercase tracking-wider">{upcomingLabel}</h2>
                {loading && <div className="w-16 h-3 bg-white/5 rounded animate-pulse" />}
              </div>
              {loading ? (
                <div className="flex flex-col gap-2">
                  {[1, 2, 3].map((i) => <div key={i} className="h-20 bg-white/5 rounded-2xl animate-pulse" />)}
                </div>
              ) : upcomingGames.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {upcomingGames.map((g) => (
                    <UpcomingGameRow key={g.id} game={g} onOpenSheet={() => openGameSheet(g.id)} />
                  ))}
                </div>
              ) : (
                <div className="text-center py-12">
                  <p className="text-[#4a6068] text-sm">No games scheduled</p>
                </div>
              )}
            </section>
          </div>
        ) : (
          /* Tennis */
          <div className="px-4 py-4 flex flex-col gap-6">
            <BestBetsSection
              games={[]}
              tennisLive={tennisLive}
              tennisUpcoming={tennisUpcoming}
              sport="tennis"
              accent={accent}
              isLoading={tennisLoading}
            />

            {tennisLive.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                  <h2 className="text-white text-sm font-bold uppercase tracking-wider">Live Now</h2>
                </div>
                <div className="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4 snap-x">
                  {tennisLive.map((m) => (
                    <TennisLiveCard key={m.id} match={m} accent={accent} />
                  ))}
                </div>
              </section>
            )}

            <section>
              <h2 className="text-white text-sm font-bold uppercase tracking-wider mb-3">Upcoming Matches</h2>
              {tennisLoading ? (
                <div className="flex flex-col gap-2">
                  {[1, 2, 3].map((i) => <div key={i} className="h-20 bg-white/5 rounded-2xl animate-pulse" />)}
                </div>
              ) : tennisUpcoming.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {tennisUpcoming.map((m) => (
                    <TennisMatchRow key={m.id} match={m} accent={accent} />
                  ))}
                </div>
              ) : (
                <div className="text-center py-12">
                  <p className="text-[#4a6068] text-sm">No matches scheduled</p>
                </div>
              )}
            </section>
          </div>
        )}
      </div>

      {/* Market selector sheet */}
      {addSheet.open && (
        <MarketSelectorSheet
          onClose={() => setAddSheet({ open: false })}
          preselectedSubject={
            addSheet.gameId
              ? {
                  id: addSheet.gameId,
                  type: "game",
                  name: liveGames.concat(upcomingGames).find((g) => g.id === addSheet.gameId)?.team1.abbr ?? "Game",
                  logo: "🏒",
                  subtitle: "NHL Game",
                }
              : undefined
          }
        />
      )}

      <BottomNav />
    </div>
  );
}
