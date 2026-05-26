import { useState, useEffect } from "react";
import { useNavigate } from "react-router";
import { BottomNav } from "./BottomNav";
import { MarketSelectorSheet } from "./MarketSelectorSheet";
import { nhlApiService } from "../services/nhlApiService";
import { predictionApiService } from "../services/predictionApiService";
import type { NHLGame } from "../types/bet";

// Emoji logos keyed by team abbreviation — extend as needed
const TEAM_LOGOS: Record<string, string> = {
  BOS: "🐻", NYR: "🗽", TOR: "🍁", MTL: "🔵",
  CHI: "🦅", DET: "🏒", VGK: "⚔️", EDM: "🛢️",
  COL: "🏔️", FLA: "🐆",
};

// Shape the JSX actually needs
interface DisplayGame {
  id: string;
  period?: string;
  time?: string;
  overUnder?: number;
  totalPct?: number;
  team1: { id: string; abbr: string; name: string; score?: number; logo: string; winPct: number };
  team2: { id: string; abbr: string; name: string; score?: number; logo: string; winPct: number };
}

// Convert NHLGame + prediction probabilities into DisplayGame
async function toDisplayGame(game: NHLGame): Promise<DisplayGame> {
  const [homePred, totalPred] = await Promise.all([
    predictionApiService.getSinglePrediction({
      marketType: "moneyline",
      gameId: game.id,
      teamId: game.homeTeam.abbreviation.toLowerCase(),
    }),
    predictionApiService.getSinglePrediction({
      marketType: "total_goals",
      gameId: game.id,
      selection: "over",
      line: 5.5,
    }),
  ]);

  return {
    id: game.id,
    period: game.period ? `${game.period}P • ${game.clock}` : undefined,
    time: game.startTime,
    overUnder: 5.5,
    totalPct: totalPred.probability,
    team1: {
      id: game.homeTeam.abbreviation.toLowerCase(),
      abbr: game.homeTeam.abbreviation,
      name: game.homeTeam.name,
      score: game.homeTeam.score,
      logo: TEAM_LOGOS[game.homeTeam.abbreviation] ?? "🏒",
      winPct: homePred.probability,
    },
    team2: {
      id: game.awayTeam.abbreviation.toLowerCase(),
      abbr: game.awayTeam.abbreviation,
      name: game.awayTeam.name,
      score: game.awayTeam.score,
      logo: TEAM_LOGOS[game.awayTeam.abbreviation] ?? "🏒",
      winPct: 100 - homePred.probability,
    },
  };
}

interface AddSheetState {
  open: boolean;
  subject?: { id: string; type: "team" | "player" | "game"; name: string; logo: string; subtitle: string };
}

export function HockeyLanding() {
  const navigate = useNavigate();
  const [addSheet, setAddSheet] = useState<AddSheetState>({ open: false });

  const [liveGames, setLiveGames] = useState<DisplayGame[]>([]);
  const [upcomingGames, setUpcomingGames] = useState<DisplayGame[]>([]);
  const [topPredictions, setTopPredictions] = useState<
    { teamLogo: string; team: string; label: string; pct: number; trend: string }[]
  >([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      const [live, all] = await Promise.all([
        nhlApiService.getLiveGames(),
        nhlApiService.getGamesByDate(),
      ]);

      const scheduled = all.filter((g) => g.status === "scheduled");

      const [liveDisplay, upcomingDisplay] = await Promise.all([
        Promise.all(live.map(toDisplayGame)),
        Promise.all(scheduled.map(toDisplayGame)),
      ]);

      setLiveGames(liveDisplay);
      setUpcomingGames(upcomingDisplay);

      // Top predictions = 3 highest win-probability home teams from all today's games
      const allDisplay = [...liveDisplay, ...upcomingDisplay];
      const top = allDisplay
        .sort((a, b) => b.team1.winPct - a.team1.winPct)
        .slice(0, 3)
        .map((g) => ({
          teamLogo: g.team1.logo,
          team: g.team1.abbr,
          label: `Win vs ${g.team2.abbr}`,
          pct: g.team1.winPct,
          trend: "+2%", // static for now; replace with historical delta if your API supports it
        }));
      setTopPredictions(top);
      setLoading(false);
    }

    load();
  }, []);

  function openGameSheet(gameId: string, gameName: string, time: string) {
    setAddSheet({
      open: true,
      subject: { id: gameId, type: "game", name: gameName, logo: "🏒", subtitle: `Today · ${time}` },
    });
  }

  return (
    <div className="flex flex-col min-h-screen bg-transparent text-white max-w-[430px] mx-auto relative z-10">
      {/* Header */}
      <header className="flex items-center justify-between px-4 pt-12 pb-3 bg-black/30 backdrop-blur-xl border-b border-white/5 sticky top-0 z-40">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🏒</span>
          <div>
            <span className="text-white tracking-widest uppercase text-xs">ICE</span>
            <span className="text-[#86d1ea] tracking-widest uppercase text-xs font-medium">EDGE</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/stats")}
            className="bg-[#141c1f]/70 backdrop-blur-md border border-white/10 rounded-xl px-3 py-1.5 flex items-center gap-1.5"
          >
            <span className="text-[#86d1ea] text-sm">🔍</span>
            <span className="text-[#bfc8cc] text-xs">Search</span>
          </button>
          <button className="w-8 h-8 rounded-full bg-[#86d1ea] flex items-center justify-center">
            <span className="text-[#0f1416] text-sm font-bold">JD</span>
          </button>
        </div>
      </header>

      <div className="flex-1 pb-28 overflow-y-auto relative z-10">
        {/* Top Predictions Banner */}
        <div className="px-4 mb-5 mt-4">
          <div className="bg-gradient-to-br from-[#141c1f]/70 backdrop-blur-md border border-white/10 rounded-2xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="text-lg">🔥</span>
                <span className="text-white text-sm font-medium">Today's Top Predictions</span>
              </div>
              <button onClick={() => navigate("/stats")} className="text-[#86d1ea] text-xs">All →</button>
            </div>
            {loading ? (
              <div className="flex flex-col gap-2">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="h-8 bg-[#1e2d32] rounded-xl animate-pulse" />
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {topPredictions.map((pred, i) => (
                  <button key={i} onClick={() => navigate("/stats")} className="flex items-center gap-3">
                    <span className="text-xl flex-shrink-0">{pred.teamLogo}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-white text-xs">{pred.team} · {pred.label}</span>
                        <div className="flex items-center gap-2">
                          <span className="text-green-400 text-[10px]">{pred.trend}</span>
                          <span className="text-[#86d1ea] text-xs font-bold">{pred.pct}%</span>
                        </div>
                      </div>
                      <div className="w-full bg-[#0f1416] rounded-full h-1.5">
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
              <div className="min-w-[260px] h-[140px] bg-[#141c1f] rounded-2xl animate-pulse" />
            ) : liveGames.length === 0 ? (
              <div className="w-full py-6 text-center text-[#bfc8cc] text-xs">No live games right now</div>
            ) : (
              liveGames.map((game) => (
                <div key={game.id} className="min-w-[260px] bg-[#141c1f]/70 backdrop-blur-md border border-white/10 rounded-2xl p-4 flex-shrink-0">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-[10px] text-red-400 font-medium uppercase tracking-wide flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse inline-block" />
                      {game.period}
                    </span>
                    <button
                      onClick={() => openGameSheet(game.id, `${game.team1.abbr} vs ${game.team2.abbr}`, "Live")}
                      className="text-[10px] bg-[#86d1ea]/10 border border-[#86d1ea]/30 text-[#86d1ea] px-2 py-0.5 rounded-full"
                    >
                      + Predict
                    </button>
                  </div>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex flex-col items-center gap-1">
                      <span className="text-2xl">{game.team1.logo}</span>
                      <span className="text-[#bfc8cc] text-xs">{game.team1.abbr}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-white text-3xl font-bold">{game.team1.score}</span>
                      <span className="text-[#bfc8cc]">-</span>
                      <span className="text-white text-3xl font-bold">{game.team2.score}</span>
                    </div>
                    <div className="flex flex-col items-center gap-1">
                      <span className="text-2xl">{game.team2.logo}</span>
                      <span className="text-[#bfc8cc] text-xs">{game.team2.abbr}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[#86d1ea] text-[10px] font-bold w-7">{game.team1.winPct}%</span>
                    <div className="flex-1 bg-[#0f1416] rounded-full h-2 overflow-hidden flex">
                      <div className="h-full bg-[#86d1ea]" style={{ width: `${game.team1.winPct}%` }} />
                      <div className="h-full bg-[#1e2d32] flex-1" />
                    </div>
                    <span className="text-[#bfc8cc] text-[10px] font-bold w-7 text-right">{game.team2.winPct}%</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Tonight's Games */}
        <section className="px-4 mb-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-white text-sm font-medium">Tonight's Games</span>
            <button onClick={() => navigate("/stats")} className="text-[#86d1ea] text-xs">Full stats →</button>
          </div>
          <div className="flex flex-col gap-2">
            {loading ? (
              [1, 2, 3].map((i) => (
                <div key={i} className="h-16 bg-[#141c1f] rounded-2xl animate-pulse" />
              ))
            ) : (
              upcomingGames.map((game) => (
                <div key={game.id} className="bg-[#141c1f]/70 backdrop-blur-md border border-white/10 rounded-2xl p-3.5">
                  <div className="flex items-center gap-3">
                    <div className="flex flex-col items-center min-w-[38px]">
                      <span className="text-[#86d1ea] text-xs font-medium">{game.time}</span>
                      <span className="text-[#bfc8cc] text-[9px]">ET</span>
                    </div>
                    <div className="flex-1 flex items-center justify-between">
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-2">
                          <span className="text-base">{game.team1.logo}</span>
                          <span className="text-white text-xs font-medium">{game.team1.abbr}</span>
                          <span className="text-[#86d1ea] text-[10px] font-bold ml-1">{game.team1.winPct}%</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-base">{game.team2.logo}</span>
                          <span className="text-white text-xs font-medium">{game.team2.abbr}</span>
                          <span className="text-[#86d1ea] text-[10px] font-bold ml-1">{game.team2.winPct}%</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="text-center">
                          <p className="text-[#bfc8cc] text-[9px]">O/U</p>
                          <p className="text-white text-xs font-bold">{game.overUnder}</p>
                          <p className="text-[#86d1ea] text-[9px]">{game.totalPct}%</p>
                        </div>
                        <button
                          onClick={() => openGameSheet(game.id, `${game.team1.abbr} vs ${game.team2.abbr}`, game.time ?? "")}
                          className="w-8 h-8 rounded-xl bg-[#86d1ea]/10 border border-[#86d1ea]/30 flex items-center justify-center text-[#86d1ea]"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        {/* Quick categories — fully static, no changes needed */}
        <section className="px-4 mb-5">
          <p className="text-white text-sm font-medium mb-3">Browse by Category</p>
          <div className="grid grid-cols-2 gap-2">
            {[
              { icon: "🏒", label: "Game Results", desc: "Moneyline & puck line", path: "/stats" },
              { icon: "⭐", label: "Player Props", desc: "Goals, shots, assists", path: "/stats" },
              { icon: "⏱️", label: "Period Betting", desc: "Period-by-period", path: "/stats" },
              { icon: "✨", label: "Specials", desc: "OT, margins & more", path: "/stats" },
            ].map((cat, i) => (
              <button
                key={i}
                onClick={() => navigate(cat.path)}
                className="bg-[#141c1f]/70 backdrop-blur-md border border-[#1e2d32] rounded-2xl p-3.5 text-left active:bg-[#1e2d32] transition-colors"
              >
                <span className="text-2xl">{cat.icon}</span>
                <p className="text-white text-xs font-medium mt-2">{cat.label}</p>
                <p className="text-[#bfc8cc] text-[10px]">{cat.desc}</p>
              </button>
            ))}
          </div>
        </section>
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