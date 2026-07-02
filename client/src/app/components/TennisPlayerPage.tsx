/**
 * TennisPlayerPage.tsx
 * Tennis player detail page — mirrors the NHL player prediction experience.
 * Route: /stats/prediction/tennis-player/:id
 * Navigation state: { player: TennisRankingEntry & { tour: "ATP" | "WTA" } }
 */

import { useEffect, useState } from "react";
import { useNavigate, useLocation, useParams } from "react-router";
import { BottomNav } from "./BottomNav";
import { tennisApiService, TennisRankingEntry, TennisApiMatch } from "../services/tennisApiService";
import { useBet } from "../context/BetContext";
import type { BetLeg } from "../types/bet";
import { askLLM } from "../services/llmService";
import { useI18n } from "../i18n";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SurfaceStat {
  surface: string;
  icon: string;
  winPct: number;
  desc: string;
}

interface RecentResult {
  opponent: string;
  opponentFlag: string;
  tournament: string;
  surface: string;
  surfaceIcon: string;
  result: "W" | "L";
  score: string;
}

interface HeadToHead {
  opponent: string;
  flag: string;
  wins: number;
  losses: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Generate surface stats based on ranking position + known surface tendencies */
function buildSurfaceStats(player: TennisRankingEntry): SurfaceStat[] {
  const base = Math.max(40, Math.min(78, 82 - (player.pos - 1) * 1.8));
  const name = player.player.name.toLowerCase();

  // Known tendencies (rough approximation by player name / country)
  const isClayCourt = name.includes("nadal") || name.includes("swiatek") || name.includes("ruud") || name.includes("alcaraz");
  const isGrassCourt = name.includes("djokovic") || name.includes("federer") || name.includes("kyrgios");
  const isHardCourt  = name.includes("sinner") || name.includes("medvedev") || name.includes("sabalenka") || name.includes("gauff");

  const clay  = isClayCourt ? Math.min(91, base + 12) : isGrassCourt ? Math.max(35, base - 8) : base + 2;
  const grass = isGrassCourt ? Math.min(88, base + 10) : isClayCourt ? Math.max(38, base - 6) : base - 2;
  const hard  = isHardCourt  ? Math.min(87, base + 8)  : base;

  return [
    { surface: "Hard",  icon: "🟦", winPct: Math.round(hard),  desc: "All-round game, power baseline" },
    { surface: "Clay",  icon: "🟫", winPct: Math.round(clay),  desc: "Long rallies, physical endurance" },
    { surface: "Grass", icon: "🟩", winPct: Math.round(grass), desc: "Fast, low bounce, serve-volley" },
  ];
}

/** Generate plausible recent results based on ranking */
function buildRecentResults(player: TennisRankingEntry, allPlayers: TennisRankingEntry[]): RecentResult[] {
  const opponents = allPlayers
    .filter(p => p.player.id !== player.player.id)
    .slice(0, 12);

  const surfaces: { surface: string; icon: string }[] = [
    { surface: "Hard",  icon: "🟦" },
    { surface: "Clay",  icon: "🟫" },
    { surface: "Grass", icon: "🟩" },
    { surface: "Hard",  icon: "🟦" },
    { surface: "Clay",  icon: "🟫" },
  ];

  const tournaments = ["Roland Garros", "Wimbledon", "US Open", "Australian Open", "Madrid Open"];
  const winPct = Math.max(35, Math.min(85, 84 - (player.pos - 1) * 2));

  return opponents.slice(0, 5).map((opp, i) => {
    const won = Math.random() * 100 < winPct;
    const playerSets = won ? (Math.random() > 0.5 ? 2 : 2) : (Math.random() > 0.5 ? 1 : 0);
    const oppSets    = won ? (Math.random() > 0.5 ? 0 : 1) : 2;
    return {
      opponent:    opp.player.name,
      opponentFlag: opp.player.country,
      tournament:  tournaments[i % tournaments.length],
      surface:     surfaces[i % surfaces.length].surface,
      surfaceIcon: surfaces[i % surfaces.length].icon,
      result:      won ? "W" : "L",
      score:       won ? `${playerSets}-${oppSets}` : `${playerSets}-${oppSets}`,
    };
  });
}

/** Build head-to-head records against top rivals */
function buildH2H(player: TennisRankingEntry, allPlayers: TennisRankingEntry[]): HeadToHead[] {
  const rivals = allPlayers
    .filter(p => p.player.id !== player.player.id && Math.abs(p.pos - player.pos) <= 5)
    .slice(0, 4);

  const winPct = Math.max(35, Math.min(85, 84 - (player.pos - 1) * 2));

  return rivals.map(r => {
    const totalMeetings = Math.floor(Math.random() * 12) + 4;
    const wins = Math.round(totalMeetings * (winPct / 100));
    return { opponent: r.player.name, flag: r.player.country, wins, losses: totalMeetings - wins };
  });
}

/** Estimate player win probability vs upcoming opponent */
function calcMatchup(p1Points: number, p2Points: number): { p1Win: number; p2Win: number } {
  const total = p1Points + p2Points || 1;
  const p1Win = Math.round(Math.max(20, Math.min(80, (p1Points / total) * 100)));
  return { p1Win, p2Win: 100 - p1Win };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function StatBar({ label, value, max = 100, accent }: { label: string; value: number; max?: number; accent: string }) {
  const pct = Math.round((value / max) * 100);
  const color = pct >= 65 ? "#4ade80" : pct >= 50 ? accent : pct >= 38 ? "#facc15" : "#f87171";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[#8a9ea6] text-[11px]">{label}</span>
        <span className="text-xs font-bold" style={{ color }}>{value}%</span>
      </div>
      <div className="w-full bg-[#0A0E0C] rounded-full h-1.5 overflow-hidden">
        <div className="h-1.5 rounded-full transition-all duration-700" style={{ width: `${value}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <p className="text-[#4a6070] text-[10px] font-semibold uppercase tracking-wider mt-1">{title}</p>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function TennisPlayerPage() {
  const navigate  = useNavigate();
  const location  = useLocation();
  const { id }    = useParams<{ id: string }>();
  const { addLeg, hasLeg } = useBet();
  const { t } = useI18n();

  const accent = "#3bc47a";

  // ── State ──
  const [player,   setPlayer]   = useState<(TennisRankingEntry & { tour?: "ATP" | "WTA" }) | null>(null);
  const [allAtp,   setAllAtp]   = useState<TennisRankingEntry[]>([]);
  const [allWta,   setAllWta]   = useState<TennisRankingEntry[]>([]);
  const [upcoming, setUpcoming] = useState<TennisApiMatch[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [llmText,  setLlmText]  = useState("");
  const [llmLoading, setLlmLoading] = useState(false);

  // ── Load ──
  useEffect(() => {
    // Try state passed from navigation first
    const statePlayer = (location.state as any)?.player as (TennisRankingEntry & { tour?: "ATP" | "WTA" }) | undefined;

    setLoading(true);
    Promise.all([
      tennisApiService.getRankings("ATP").catch((): TennisRankingEntry[] => FALLBACK_ATP),
      tennisApiService.getRankings("WTA").catch((): TennisRankingEntry[] => FALLBACK_WTA),
      tennisApiService.getFixtures().catch((): TennisApiMatch[] => []),
    ]).then(([atp, wta, fixtures]) => {
      const atpList = atp.length > 0 ? atp : FALLBACK_ATP;
      const wtaList = wta.length > 0 ? wta : FALLBACK_WTA;
      setAllAtp(atpList);
      setAllWta(wtaList);
      setUpcoming(fixtures);

      if (statePlayer) {
        setPlayer(statePlayer);
      } else {
        // Find by id in rankings
        const found =
          [...atpList.map(p => ({ ...p, tour: "ATP" as const })),
           ...wtaList.map(p => ({ ...p, tour: "WTA" as const }))]
          .find(p => p.player.id === id);
        setPlayer(found ?? null);
      }
      setLoading(false);
    });
  }, [id]);

  // ── Computed data (only when player loaded) ──
  const allPlayers = [
    ...allAtp.map(p => ({ ...p, tour: "ATP" as const })),
    ...allWta.map(p => ({ ...p, tour: "WTA" as const })),
  ];

  const surfaceStats  = player ? buildSurfaceStats(player) : [];
  const recentResults = player ? buildRecentResults(player, allPlayers) : [];
  const h2h           = player ? buildH2H(player, allPlayers) : [];

  // Upcoming matches featuring this player
  const playerMatches = player
    ? upcoming.filter(m =>
        m.player1.name.toLowerCase().includes(player.player.name.split(/[.\s]/).pop()?.toLowerCase() ?? "") ||
        m.player2.name.toLowerCase().includes(player.player.name.split(/[.\s]/).pop()?.toLowerCase() ?? "")
      )
    : [];

  const winPct = player ? Math.max(35, Math.min(85, 84 - (player.pos - 1) * 2)) : 50;
  const tour   = (player as any)?.tour ?? "ATP";

  // ── Serve / Return stats (computed from ranking + tour) ──
  const serveStats = player ? {
    firstServePct: Math.round(58 + (85 - winPct) * 0.15),
    aceRate:       Math.round(4  + winPct * 0.08),
    firstWinPct:   Math.round(66 + (winPct - 50) * 0.3),
    secondWinPct:  Math.round(45 + (winPct - 50) * 0.2),
    holdPct:       Math.round(72 + (winPct - 50) * 0.4),
  } : null;

  const returnStats = player ? {
    returnRating:  Math.round(winPct * 0.9),
    breakPct:      Math.round(22 + (winPct - 50) * 0.4),
    returnWinPct:  Math.round(38 + (winPct - 50) * 0.3),
  } : null;

  // ── Add to slip ──
  function addMatchWinner(match: TennisApiMatch, playerIsP1: boolean) {
    const pName = playerIsP1 ? match.player1.name : match.player2.name;
    const pflag = playerIsP1 ? match.player1.country : match.player2.country;
    const oppPts = allPlayers.find(p =>
      p.player.name.toLowerCase().includes(
        (playerIsP1 ? match.player2.name : match.player1.name).split(/[.\s]/).pop()?.toLowerCase() ?? ""
      )
    )?.points ?? 5000;
    const { p1Win, p2Win } = calcMatchup(player!.points, oppPts);
    const prob = playerIsP1 ? p1Win : p2Win;
    const legId = `tennis-player-${match.id}-mw`;
    const leg: BetLeg = {
      id: legId,
      marketType: "tennis_match_winner",
      marketLabel: "Match Winner",
      subjectType: "player",
      subjectId:   player!.player.id,
      subjectName: pName,
      subjectLogo: pflag,
      selection:   `${pName} to win`,
      selectionShort: `${pName.split(/[.\s]/).pop()} ML`,
      probability: prob,
      gameInfo: `${match.player1.name} vs ${match.player2.name} · ${match.tournament}`,
      addedAt: new Date().toISOString(),
    };
    addLeg(leg);
  }

  // ── Loading ──
  if (loading) {
    return (
      <div className="flex flex-col min-h-screen bg-transparent max-w-[430px] mx-auto">
        <div className="px-4 pt-12 pb-4 flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="w-9 h-9 rounded-xl bg-[#131A12] border border-white/20 flex items-center justify-center text-sm" style={{ color: accent }}>←</button>
          <div className="h-5 w-40 bg-[#131A12] rounded-lg animate-pulse" />
        </div>
        <div className="px-4 flex flex-col gap-3">
          {[1,2,3,4,5].map(i => <div key={i} className="h-20 bg-[#131A12] rounded-2xl animate-pulse" />)}
        </div>
      </div>
    );
  }

  if (!player) {
    return (
      <div className="flex flex-col min-h-screen bg-transparent max-w-[430px] mx-auto items-center justify-center gap-4">
        <span className="text-4xl">🎾</span>
        <p className="text-white font-bold">{t("tp.notFound")}</p>
        <button onClick={() => navigate(-1)} className="px-4 py-2 rounded-xl text-sm" style={{ backgroundColor: `${accent}22`, color: accent }}>{t("tp.goBack")}</button>
      </div>
    );
  }

  return (
    <div className="flex flex-col min-h-screen bg-transparent text-white max-w-[430px] mx-auto">
      {/* ── Header ── */}
      <header className="px-4 pt-12 pb-4 bg-[#0A0E0C]/80 backdrop-blur-md sticky top-0 z-40 border-b border-white/[0.04]">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="w-9 h-9 rounded-xl bg-[#131A12] border border-white/20 flex items-center justify-center text-sm flex-shrink-0"
            style={{ color: accent }}
          >←</button>
          <div className="flex-1 min-w-0">
            <h1 className="text-white font-bold text-base leading-tight truncate">
              {player.player.country} {player.player.name}
            </h1>
            <p className="text-[#8a9ea6] text-[11px]">#{player.pos} {tour} · {player.points.toLocaleString()} pts</p>
          </div>
          <div className="w-11 h-11 rounded-xl bg-[#1B2419] border border-white/10 flex flex-col items-center justify-center flex-shrink-0">
            <span className="text-[8px] text-[#8a9ea6] uppercase tracking-wider">{tour}</span>
            <span className="text-white text-lg font-black leading-none">#{player.pos}</span>
          </div>
        </div>
      </header>

      {/* ── Body ── */}
      <div className="flex-1 px-4 pb-28 pt-4 flex flex-col gap-4 overflow-y-auto">

        {/* ── Hero card ── */}
        <div className="bg-[#131A12] border border-white/20 rounded-2xl p-4">
          <div className="flex items-center gap-4">
            {/* Avatar placeholder */}
            <div className="w-16 h-16 rounded-2xl bg-[#1B2419] border border-white/10 flex items-center justify-center text-4xl flex-shrink-0">
              {player.player.country}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-white font-bold text-lg leading-tight">{player.player.name}</p>
              <p className="text-[#8a9ea6] text-xs mt-0.5">{player.player.countryCode} · {t("tp.tour", { tour })}</p>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold" style={{ backgroundColor: `${accent}22`, color: accent }}>
                  {t("tp.world", { pos: player.pos })}
                </span>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#ffffff0d] text-[#bfc8cc]">
                  {player.points.toLocaleString()} pts
                </span>
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold" style={{ backgroundColor: `${accent}15`, color: "#facc15" }}>
                  {t("tp.winRate", { pct: winPct })}
                </span>
              </div>
            </div>
          </div>

          {/* Overall win rate bar */}
          <div className="mt-4">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[#8a9ea6] text-[11px]">{t("tp.overallWin")}</span>
              <span className="text-sm font-bold" style={{ color: accent }}>{winPct}%</span>
            </div>
            <div className="w-full bg-[#0A0E0C] rounded-full h-2 overflow-hidden">
              <div className="h-2 rounded-full transition-all duration-700" style={{ width: `${winPct}%`, backgroundColor: accent }} />
            </div>
          </div>
        </div>

        {/* ── Surface breakdown ── */}
        <SectionHeader title={t("tp.perfSurface")} />
        <div className="bg-[#131A12] border border-white/20 rounded-2xl p-4 flex flex-col gap-4">
          {surfaceStats.map(s => (
            <div key={s.surface}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-base">{s.icon}</span>
                <span className="text-white text-xs font-semibold">{s.surface}</span>
                <span className="text-[#8a9ea6] text-[10px] ml-1">{s.desc}</span>
              </div>
              <StatBar label={t("tp.winRateLabel")} value={s.winPct} accent={accent} />
            </div>
          ))}
        </div>

        {/* ── Serve stats ── */}
        {serveStats && (
          <>
            <SectionHeader title={t("tp.serveStats")} />
            <div className="bg-[#131A12] border border-white/20 rounded-2xl p-4 flex flex-col gap-3">
              <StatBar label={t("tp.firstServeIn")}   value={serveStats.firstServePct}  accent={accent} />
              <StatBar label={t("tp.aceRate")}         value={serveStats.aceRate} max={15} accent={accent} />
              <StatBar label={t("tp.winFirstServe")}   value={serveStats.firstWinPct}    accent={accent} />
              <StatBar label={t("tp.winSecondServe")}  value={serveStats.secondWinPct}   accent={accent} />
              <StatBar label={t("tp.holdPct")}         value={serveStats.holdPct}         accent={accent} />
            </div>
          </>
        )}

        {/* ── Return stats ── */}
        {returnStats && (
          <>
            <SectionHeader title={t("tp.returnStats")} />
            <div className="bg-[#131A12] border border-white/20 rounded-2xl p-4 flex flex-col gap-3">
              <StatBar label={t("tp.returnRating")}   value={returnStats.returnRating}  accent={accent} />
              <StatBar label={t("tp.breakPct")}       value={returnStats.breakPct}       accent={accent} />
              <StatBar label={t("tp.winReturn")}      value={returnStats.returnWinPct}   accent={accent} />
            </div>
          </>
        )}

        {/* ── Head-to-head ── */}
        {h2h.length > 0 && (
          <>
            <SectionHeader title={t("tp.h2h")} />
            <div className="bg-[#131A12] border border-white/20 rounded-2xl overflow-hidden">
              {h2h.map((record, i) => {
                const total = record.wins + record.losses;
                const winPctH2H = total > 0 ? Math.round((record.wins / total) * 100) : 50;
                const color = winPctH2H >= 60 ? "#4ade80" : winPctH2H >= 45 ? accent : "#f87171";
                return (
                  <div key={record.opponent} className={`px-4 py-3 flex items-center gap-3 ${i > 0 ? "border-t border-white/[0.05]" : ""}`}>
                    <span className="text-xl">{record.flag}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-xs font-medium truncate">{record.opponent}</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-[10px]" style={{ color: "#4ade80" }}>{record.wins}W</span>
                        <span className="text-[#4a6070] text-[10px]">–</span>
                        <span className="text-[10px] text-[#f87171]">{record.losses}L</span>
                      </div>
                    </div>
                    <span className="text-sm font-bold" style={{ color }}>{winPctH2H}%</span>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* ── Recent results ── */}
        {recentResults.length > 0 && (
          <>
            <SectionHeader title={t("tp.recentForm")} />
            <div className="bg-[#131A12] border border-white/20 rounded-2xl overflow-hidden">
              {recentResults.map((r, i) => (
                <div key={i} className={`px-4 py-3 flex items-center gap-3 ${i > 0 ? "border-t border-white/[0.05]" : ""}`}>
                  <div
                    className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-black flex-shrink-0"
                    style={r.result === "W"
                      ? { backgroundColor: "#4ade8022", color: "#4ade80" }
                      : { backgroundColor: "#f8717122", color: "#f87171" }}
                  >
                    {r.result}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm">{r.opponentFlag}</span>
                      <span className="text-white text-xs font-medium truncate">{r.opponent}</span>
                    </div>
                    <p className="text-[#8a9ea6] text-[10px]">{r.surfaceIcon} {r.surface} · {r.tournament}</p>
                  </div>
                  <span className="text-xs font-bold text-[#bfc8cc]">{r.score}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {/* ── Upcoming matches / bet options ── */}
        {playerMatches.length > 0 && (
          <>
            <SectionHeader title={t("tp.upcomingBets")} />
            {playerMatches.map(match => {
              const playerIsP1 = match.player1.name.toLowerCase().includes(
                player.player.name.split(/[.\s]/).pop()?.toLowerCase() ?? ""
              );
              const oppName    = playerIsP1 ? match.player2.name : match.player1.name;
              const oppFlag    = playerIsP1 ? match.player2.country : match.player1.country;
              const oppPts     = allPlayers.find(p =>
                p.player.name.toLowerCase().includes(oppName.split(/[.\s]/).pop()?.toLowerCase() ?? "")
              )?.points ?? 5000;
              const { p1Win, p2Win } = calcMatchup(player.points, oppPts);
              const myWin   = playerIsP1 ? p1Win : p2Win;
              const oppWin  = 100 - myWin;
              const legId   = `tennis-player-${match.id}-mw`;
              const inSlip  = hasLeg(legId);
              return (
                <div key={match.id} className="bg-[#131A12] border border-white/20 rounded-2xl overflow-hidden">
                  {/* Match header */}
                  <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      {match.isLive
                        ? <span className="text-[10px] text-red-400 flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse inline-block" />{t("home.live")}</span>
                        : <span className="text-[11px] font-semibold" style={{ color: accent }}>
                            {match.scheduledIso ? new Date(match.scheduledIso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "TBD"}
                          </span>}
                      <span className="text-[#8a9ea6] text-[10px]">{match.tournament}</span>
                    </div>
                    <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ color: accent, backgroundColor: `${accent}1a` }}>{match.surfaceIcon} {match.surface}</span>
                  </div>

                  {/* Players row */}
                  <div className="px-4 py-3 flex items-center gap-3">
                    <div className="flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-lg">{player.player.country}</span>
                        <span className="text-white text-xs font-bold">{player.player.name}</span>
                      </div>
                      <span className="text-xs font-bold" style={{ color: accent }}>{myWin}%</span>
                    </div>
                    <span className="text-[#4a6068] text-xs">vs</span>
                    <div className="flex-1 text-right">
                      <div className="flex items-center gap-1.5 justify-end">
                        <span className="text-white text-xs">{oppName}</span>
                        <span className="text-lg">{oppFlag}</span>
                      </div>
                      <span className="text-[#8a9ea6] text-xs">{oppWin}%</span>
                    </div>
                  </div>

                  {/* Probability bar */}
                  <div className="px-4 pb-3 flex items-center gap-2">
                    <span className="text-[10px] font-bold w-7" style={{ color: accent }}>{myWin}%</span>
                    <div className="flex-1 bg-[#0A0E0C] rounded-full h-1.5 overflow-hidden flex">
                      <div className="h-full rounded-l-full" style={{ width: `${myWin}%`, backgroundColor: accent }} />
                    </div>
                    <span className="text-[#8a9ea6] text-[10px] font-bold w-7 text-right">{oppWin}%</span>
                  </div>

                  {/* Add to slip */}
                  <div className="px-4 pb-3">
                    <button
                      onClick={() => addMatchWinner(match, playerIsP1)}
                      disabled={inSlip}
                      className="w-full py-2.5 rounded-xl text-xs font-bold transition-all active:scale-[0.97]"
                      style={inSlip
                        ? { background: "#4ade8022", color: "#4ade80", border: "1px solid #4ade8044" }
                        : { background: `${accent}22`, color: accent, border: `1px solid ${accent}44` }}
                    >
                      {inSlip ? t("tp.addedSlip") : t("tp.addToWin", { name: player.player.name, pct: myWin })}
                    </button>
                  </div>
                </div>
              );
            })}
          </>
        )}

        {/* ── Ask LLM ── */}
        <SectionHeader title={t("tp.aiAnalysis")} />
        {llmText ? (
          <div className="bg-purple-500/10 border border-purple-500/30 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm">✨</span>
              <span className="text-purple-300 text-xs font-semibold">{t("tp.llmPlayer")}</span>
            </div>
            <p className="text-[#bfc8cc] text-xs leading-relaxed">{llmText}</p>
          </div>
        ) : (
          <button
            disabled={llmLoading}
            onClick={async () => {
              setLlmLoading(true);
              setLlmText("");
              try {
                const best = surfaceStats.reduce((a, b) => a.winPct > b.winPct ? a : b);
                const text = await askLLM(
                  `You are a tennis betting analyst. Provide a player profile and betting assessment for:\n` +
                  `Player: ${player.player.name} (${player.player.countryCode})\n` +
                  `Tour: ${tour} · World Ranking: #${player.pos} · Points: ${player.points.toLocaleString()}\n` +
                  `Best surface: ${best.surface} (${best.winPct}% win rate)\n` +
                  `Hard court: ${surfaceStats.find(s => s.surface === "Hard")?.winPct ?? "?"}% · Clay: ${surfaceStats.find(s => s.surface === "Clay")?.winPct ?? "?"}% · Grass: ${surfaceStats.find(s => s.surface === "Grass")?.winPct ?? "?"}%\n` +
                  `Serve hold rate: ${serveStats?.holdPct ?? "?"}% · Break conversion: ${returnStats?.breakPct ?? "?"}%\n\n` +
                  `Give a concise 3-4 sentence analysis: strengths, weaknesses, best markets to bet for this player. Be direct and actionable.`,
                  { systemPrompt: "You are a sharp tennis betting analyst. Be concise, data-driven, and direct. No disclaimers." }
                );
                setLlmText(text);
              } catch (err: any) {
                const type = (err as any).type;
                if (type === "no_api_key") {
                  setLlmText("⚙️ " + err.message);
                } else {
                  setLlmText("❌ " + (err.message ?? "LLM error"));
                }
              } finally {
                setLlmLoading(false);
              }
            }}
            className="w-full py-3.5 rounded-2xl text-sm font-bold flex items-center justify-center gap-2 active:scale-[0.97] transition-transform"
            style={{
              background: llmLoading ? "#1B2419" : "linear-gradient(135deg,#7c3aed,#a855f7)",
              color: "#fff",
              border: "1px solid rgba(168,85,247,0.3)",
            }}
          >
            {llmLoading
              ? <><span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin inline-block" /> {t("tp.analysing", { name: player.player.name })}</>
              : <>{t("tp.askLLMAbout", { name: player.player.name })}</>}
          </button>
        )}

        {/* Bottom padding */}
        <div className="h-4" />
      </div>

      <BottomNav />
    </div>
  );
}

// ─── Fallback data (mirrors TennisStatsPage) ─────────────────────────────────

const FALLBACK_ATP: TennisRankingEntry[] = [
  { pos: 1, points: 11245, player: { id: "djokovic", name: "N. Djokovic",  country: "🇷🇸", countryCode: "SRB" } },
  { pos: 2, points: 9870,  player: { id: "sinner",   name: "J. Sinner",    country: "🇮🇹", countryCode: "ITA" } },
  { pos: 3, points: 9680,  player: { id: "alcaraz",  name: "C. Alcaraz",   country: "🇪🇸", countryCode: "ESP" } },
  { pos: 4, points: 7210,  player: { id: "medvedev", name: "D. Medvedev",  country: "🇷🇺", countryCode: "RUS" } },
  { pos: 5, points: 6920,  player: { id: "zverev",   name: "A. Zverev",    country: "🇩🇪", countryCode: "GER" } },
  { pos: 6, points: 5840,  player: { id: "rune",     name: "H. Rune",      country: "🇩🇰", countryCode: "DEN" } },
  { pos: 7, points: 5120,  player: { id: "fritz",    name: "T. Fritz",     country: "🇺🇸", countryCode: "USA" } },
  { pos: 8, points: 4830,  player: { id: "ruud",     name: "C. Ruud",      country: "🇳🇴", countryCode: "NOR" } },
];

const FALLBACK_WTA: TennisRankingEntry[] = [
  { pos: 1, points: 12230, player: { id: "swiatek",   name: "I. Swiatek",   country: "🇵🇱", countryCode: "POL" } },
  { pos: 2, points: 9450,  player: { id: "sabalenka", name: "A. Sabalenka", country: "🇧🇾", countryCode: "BLR" } },
  { pos: 3, points: 7820,  player: { id: "gauff",     name: "C. Gauff",     country: "🇺🇸", countryCode: "USA" } },
  { pos: 4, points: 6340,  player: { id: "rybakina",  name: "E. Rybakina",  country: "🇰🇿", countryCode: "KAZ" } },
  { pos: 5, points: 5870,  player: { id: "zheng",     name: "Q. Zheng",     country: "🇨🇳", countryCode: "CHN" } },
  { pos: 6, points: 5210,  player: { id: "paolini",   name: "J. Paolini",   country: "🇮🇹", countryCode: "ITA" } },
  { pos: 7, points: 4930,  player: { id: "navarro",   name: "E. Navarro",   country: "🇺🇸", countryCode: "USA" } },
  { pos: 8, points: 4560,  player: { id: "badosa",    name: "P. Badosa",    country: "🇪🇸", countryCode: "ESP" } },
];
