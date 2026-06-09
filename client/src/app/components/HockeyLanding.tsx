import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { Search, TrendingUp, ChevronRight, Plus, Goal, Star, Timer, Zap } from "lucide-react";
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
      <button onClick={() => setOpen(!open)} className="flex items-center gap-3 select-none">
        {/* Circle logo */}
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
          style={{
            background: `${theme.accent}18`,
            border: `3px solid white`,
            boxShadow: `0 0 0 1px ${theme.accent}40`,
          }}
        >
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: theme.accent }} />
        </div>
        {/* Brand name */}
        <div className="flex flex-col leading-none gap-0.5">
          <div style={{ fontFamily: "'Merriweather', Georgia, serif" }}>
            <span className="text-white tracking-[0.18em] uppercase text-sm font-bold">ICE</span>
            <span className="tracking-[0.18em] uppercase text-sm font-bold" style={{ color: theme.accent }}>EDGE</span>
          </div>
          <span className="text-xs tracking-wider" style={{ color: theme.accent, opacity: 0.75 }}>{theme.sportLabel}</span>
        </div>
        <span className="text-xs" style={{ color: theme.accent }}>▾</span>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-2 bg-[#111a1f] border border-white/20 rounded-2xl overflow-hidden z-50 min-w-[168px] shadow-xl shadow-black/50 backdrop-blur-sm">
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
    <div className="min-w-[280px] bg-[#111a1f]/70 backdrop-blur-md border border-white/20 rounded-2xl p-4 flex-shrink-0">

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
        <div className="flex-1 bg-[#0a1014] rounded-full h-2 overflow-hidden flex">
          <div className="h-full rounded-l-full transition-all duration-500" style={{ width: `${game.team1.winPct}%`, backgroundColor: accent }} />
          <div className="h-full bg-[#1a2a2f] flex-1" />
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
    <div className="bg-[#111a1f]/70 backdrop-blur-md border border-white/20 rounded-2xl p-3.5">
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
    <div className="min-w-[280px] bg-[#111a1f]/70 backdrop-blur-md border border-white/20 rounded-2xl p-4 flex-shrink-0">

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
        <div className="flex-1 bg-[#0a1014] rounded-full h-2 overflow-hidden flex">
          <div className="h-full rounded-l-full" style={{ width: `${match.player1.winPct}%`, backgroundColor: accent }} />
          <div className="h-full bg-[#1a2a2f] flex-1" />
        </div>
        <span className="text-[#bfc8cc] text-[10px] font-bold w-7 text-right">{match.player2.winPct}%</span>
      </div>

      {/* Quick add */}
      <button
        onClick={quickAdd}
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
    <div className="bg-[#111a1f]/70 backdrop-blur-md border border-white/20 rounded-2xl p-3.5">
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
              onClick={quickAdd}
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

  function openGameSheet(gameId: string, gameName: string, time: string) {
    setAddSheet({ open: true, subject: { id: gameId, type: "game", name: gameName, logo: "🏒", subtitle: `Today · ${time}` } });
  }

  const sharedHeader = (
    <header className="flex items-center justify-between px-4 pt-12 pb-3 bg-[#0a1014]/80 backdrop-blur-md border-b border-white/[0.04] sticky top-0 z-40">
      <SportSelector />
      <div className="flex items-center gap-2.5">
        <button onClick={() => navigate("/stats")} className="bg-[#111a1f]/80 border border-white/20 rounded-xl px-3 py-1.5 flex items-center gap-1.5 hover:border-white/35 active:scale-95 transition-all">
          <Search size={12} style={{ color: accent }} />
          <span className="text-[#bfc8cc] text-xs">Search</span>
        </button>
        <button className="w-8 h-8 rounded-full flex items-center justify-center" style={{ backgroundColor: accent }}>
          <span className="text-[#0a1014] text-[11px] font-bold">JD</span>
        </button>
      </div>
    </header>
  );

  // ── Tennis view ──────────────────────────────────────────────────────────────
  if (sport === "tennis") {
    return (
      <div className="flex flex-col min-h-screen bg-transparent text-white max-w-[430px] mx-auto relative z-10">
        {sharedHeader}
        <div className="flex-1 pb-28 overflow-y-auto relative z-10">

          {/* Top Predictions */}
          <div className="px-4 mb-5 mt-4">
            <div className="bg-[#111a1f]/70 backdrop-blur-md border border-white/20 rounded-2xl p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <TrendingUp size={14} className="text-[#86d1ea]" />
                  <span className="text-white text-sm font-medium">Today's Top Predictions</span>
                </div>
                <button onClick={() => navigate("/stats")} className="text-xs" style={{ color: accent }}>All →</button>
              </div>
              {tennisLoading ? (
                <div className="flex flex-col gap-2">{[1,2,3].map((i) => <div key={i} className="h-8 bg-[#1a2a2f] rounded-xl animate-pulse" />)}</div>
              ) : (
              <div className="flex flex-col gap-2.5">
                {tennisTopPreds.map((pred, i) => (
                  <button key={i} onClick={() => navigate("/stats")} className="flex items-center gap-3">
                    <span className="text-xl flex-shrink-0">{pred.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-white text-xs">{pred.name} · {pred.label}</span>
                        <div className="flex items-center gap-2">
                          {pred.edge >= 8 && (
                            <span className="text-[9px] text-green-400 bg-green-500/10 border border-green-500/20 px-1.5 py-0.5 rounded-full">
                              +{pred.edge}%
                            </span>
                          )}
                          <span className="text-xs font-bold" style={{ color: accent }}>{pred.pct}%</span>
                        </div>
                      </div>
                      <div className="w-full bg-[#0a1014] rounded-full h-1.5">
                        <div className="h-1.5 rounded-full" style={{ width: `${pred.pct}%`, backgroundColor: accent }} />
                      </div>
                    </div>
                  </button>
                ))}
              </div>
              )}
            </div>
          </div>

          {/* Live Matches */}
          <section className="px-4 mb-5">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse inline-block" />
                <span className="text-white text-sm font-medium">Live Now</span>
              </div>
              <button className="text-xs" style={{ color: accent }}>See all →</button>
            </div>
            <div className="flex gap-3 overflow-x-auto pb-1 scrollbar-hide">
              {tennisLoading ? (
                <div className="min-w-[280px] h-[160px] bg-[#111a1f] rounded-2xl animate-pulse" />
              ) : tennisLive.length === 0 ? (
                <div className="w-full py-6 text-center text-[#bfc8cc] text-xs">No live matches right now</div>
              ) : (
                tennisLive.map((match) => <TennisLiveCard key={match.id} match={match} accent={accent} />)
              )}
            </div>
          </section>

          {/* Today's Matches */}
          <section className="px-4 mb-5">
            <div className="flex items-center justify-between mb-3">
              <span className="text-white text-sm font-medium">Today's Matches</span>
              <button onClick={() => navigate("/stats")} className="text-xs" style={{ color: accent }}>Full stats →</button>
            </div>
            <div className="flex flex-col gap-2">
              {tennisLoading
                ? [1,2,3].map((i) => <div key={i} className="h-20 bg-[#111a1f] rounded-2xl animate-pulse" />)
                : tennisUpcoming.length === 0
                  ? <div className="py-8 text-center text-[#bfc8cc] text-xs">No matches scheduled — check back soon</div>
                  : tennisUpcoming.map((match) => <TennisMatchRow key={match.id} match={match} accent={accent} />)
              }
            </div>
          </section>

          {/* Browse by Category */}
          <section className="px-4 mb-5">
            <p className="text-white text-sm font-medium mb-3">Browse by Category</p>
            <div className="grid grid-cols-2 gap-2">
              {[
                { icon: "🎾", label: "Match Winner",  desc: "Moneyline & outright",  path: "/stats" },
                { icon: "📋", label: "Set Betting",   desc: "Correct score by sets", path: "/stats" },
                { icon: "⚡", label: "Game Handicap", desc: "Spread across games",   path: "/stats" },
                { icon: "✨", label: "Specials",      desc: "Aces, breaks & more",   path: "/stats" },
              ].map((cat, i) => (
                <button key={i} onClick={() => navigate(cat.path)}
                  className="bg-[#111a1f]/70 backdrop-blur-md border border-white/20 rounded-2xl p-3.5 text-left active:bg-[#1a2a2f] transition-colors">
                  <div className="w-8 h-8 rounded-lg bg-[#86d1ea]/10 border border-[#86d1ea]/20 flex items-center justify-center mb-2"><div className="w-3 h-3 rounded-full bg-[#86d1ea]/60" /></div>
                  <p className="text-white text-xs font-medium mt-2">{cat.label}</p>
                  <p className="text-[#bfc8cc] text-[10px]">{cat.desc}</p>
                </button>
              ))}
            </div>
          </section>

        </div>
        <BottomNav />
        {addSheet.open && <MarketSelectorSheet onClose={() => setAddSheet({ open: false })} preselectedSubject={addSheet.subject} />}
      </div>
    );
  }

  // ── Hockey view ──────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col min-h-screen bg-transparent text-white max-w-[430px] mx-auto relative z-10">
      {sharedHeader}
      <div className="flex-1 pb-28 overflow-y-auto relative z-10">

        {/* Top Predictions Banner */}
        <div className="px-4 mb-5 mt-4">
          <div className="bg-[#111a1f]/70 backdrop-blur-md border border-white/20 rounded-2xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <TrendingUp size={14} className="text-[#86d1ea]" />
                <span className="text-white text-sm font-medium">Today's Top Predictions</span>
              </div>
              <button onClick={() => navigate("/stats")} className="text-[#86d1ea] text-xs">All →</button>
            </div>
            {loading ? (
              <div className="flex flex-col gap-2">{[1,2,3].map((i) => <div key={i} className="h-8 bg-[#1a2a2f] rounded-xl animate-pulse" />)}</div>
            ) : (
              <div className="flex flex-col gap-2.5">
                {topPredictions.map((pred, i) => (
                  <button key={i} onClick={() => navigate("/stats")} className="flex items-center gap-3">
                    <div className="w-7 h-7 rounded-lg bg-[#1a2a2f] border border-white/20 flex items-center justify-center text-[9px] font-bold text-[#86d1ea] flex-shrink-0">{pred.team.slice(0,3)}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-white text-xs">{pred.team} · {pred.label}</span>
                        <div className="flex items-center gap-2">
                          {pred.edge >= 8 && (
                            <span className="text-[9px] text-green-400 bg-green-500/10 border border-green-500/20 px-1.5 py-0.5 rounded-full">
                              +{pred.edge}%
                            </span>
                          )}
                          <span className="text-green-400 text-[10px]">{pred.trend}</span>
                          <span className="text-[#86d1ea] text-xs font-bold">{pred.pct}%</span>
                        </div>
                      </div>
                      <div className="w-full bg-[#0a1014] rounded-full h-1.5">
                        <div className="h-1.5 rounded-full bg-[#86d1ea]" style={{ width: `${pred.pct}%` }} />
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Live Games */}
        <section className="px-4 mb-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse inline-block" />
              <span className="text-white text-sm font-medium">Live Now</span>
            </div>
            <button className="text-[#86d1ea] text-xs">See all →</button>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-1 scrollbar-hide">
            {loading ? (
              <div className="min-w-[280px] h-[160px] bg-[#111a1f] rounded-2xl animate-pulse" />
            ) : liveGames.length === 0 ? (
              <div className="w-full py-6 text-center text-[#bfc8cc] text-xs">No live games right now</div>
            ) : liveGames.map((game) => (
              <LiveGameCard
                key={game.id}
                game={game}
                onOpenSheet={() => openGameSheet(game.id, `${game.team1.abbr} vs ${game.team2.abbr}`, "Live")}
              />
            ))}
          </div>
        </section>

        {/* Upcoming Games */}
        <section className="px-4 mb-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-white text-sm font-medium">{upcomingLabel}</span>
            <button onClick={() => navigate("/stats")} className="text-[#86d1ea] text-xs">Full stats →</button>
          </div>
          <div className="flex flex-col gap-2">
            {loading
              ? [1,2,3].map((i) => <div key={i} className="h-20 bg-[#111a1f] rounded-2xl animate-pulse" />)
              : upcomingGames.length === 0
                ? <div className="py-8 text-center text-[#bfc8cc] text-xs">No games scheduled — check back soon</div>
                : upcomingGames.map((game) => (
                    <UpcomingGameRow
                      key={game.id}
                      game={game}
                      onOpenSheet={() => openGameSheet(game.id, `${game.team1.abbr} vs ${game.team2.abbr}`, game.time ?? "")}
                    />
                  ))
            }
          </div>
        </section>

        {/* Browse by Category */}
        <section className="px-4 mb-6">
          <div className="flex items-center justify-between mb-3">
            <span className="text-white text-sm font-medium">Browse by Category</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: "Game Lines",    icon: "🏒", path: "/stats" },
              { label: "Player Props",  icon: "👤", path: "/stats" },
              { label: "Futures",       icon: "🏆", path: "/stats" },
              { label: "Live Betting",  icon: "⚡", path: "/stats" },
            ].map((cat, i) => (
              <button key={i} onClick={() => navigate(cat.path)}
                className="bg-[#111a1f]/80 backdrop-blur-sm border border-white/20 rounded-2xl p-3.5 text-left hover:border-white/35 active:scale-[0.97] transition-all group">
                <div className="w-8 h-8 rounded-lg bg-[#86d1ea]/10 border border-[#86d1ea]/20 flex items-center justify-center mb-2"><div className="w-3 h-3 rounded-full bg-[#86d1ea]/60" /></div>
                <p className="text-white text-xs font-medium mt-2">{cat.label}</p>
              </button>
            ))}
          </div>
        </section>

        <div className="h-24" />
        <BottomNav />
      </div>

      {addSheet.open && (
        <MarketSelectorSheet
          onClose={() => setAddSheet({ open: false })}
          preselectedSubject={addSheet.subject}
        />
      )}
    </div>
  );
}
