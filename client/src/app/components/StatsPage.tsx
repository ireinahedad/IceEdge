import { Search, RefreshCw } from "lucide-react";

import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { lastNGamesOptions } from "../data/hockeyData";
import { useNHLData, UITeam, UIGame, UIPlayer } from "../hooks/useNHLData";
import { BottomNav } from "./BottomNav";
import { MarketSelectorSheet } from "./MarketSelectorSheet";
import { nhlApiService } from "../services/nhlApiService";
import { predictionApiService } from "../services/predictionApiService";
import { NHLTeamStats } from "../types/bet";
import { useSport } from "../context/SportContext";
import { teamEmoji, probToOdds } from "../data/teamEmoji";
import { tennisApiService, TennisApiMatch, TennisRankingEntry, TennisTournamentInfo } from "../services/tennisApiService";
import { useBet } from "../context/BetContext";
import type { BetLeg } from "../types/bet";

// ─── Shared types ──────────────────────────────────────────────────────────────

const filterTabs = ["By Team", "By Game", "By Player", "By # Games"];

type Subject = { id: string; type: "team" | "player" | "game"; name: string; logo: string; subtitle: string };

interface AddSheetState { open: boolean; subject?: Subject }

// ─── Hockey sub-components (unchanged) ────────────────────────────────────────

function AddButton({ onPress, accent }: { onPress: (e: React.MouseEvent) => void; accent: string }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onPress(e); }}
      className="w-8 h-8 rounded-xl border flex items-center justify-center font-bold flex-shrink-0 transition-colors"
      style={{ color: accent, borderColor: `${accent}4d`, backgroundColor: `${accent}1a` }}
    >
      +
    </button>
  );
}

function TeamCard({ team, onClick, onAdd, accent }: { team: UITeam; onClick: () => void; onAdd: (e: React.MouseEvent) => void; accent: string }) {
  return (
    <button
      onClick={onClick}
      className="w-full bg-[#111a1f]/70 backdrop-blur-md border border-white/20 rounded-2xl p-4 flex items-center gap-3 active:scale-[0.98] transition-transform text-left"
    >
      <div className="w-11 h-11 rounded-xl bg-[#1a2a2f] flex items-center justify-center text-2xl flex-shrink-0">
        {team.logo}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-white text-sm font-medium truncate">{team.name}</p>
        <p className="text-[#bfc8cc] text-xs">{team.record} · {team.pts} pts</p>
        <div className="flex items-center gap-1.5 mt-1">
          <span className={`text-[10px] font-medium ${team.streak.startsWith("W") ? "text-green-400" : "text-red-400"}`}>{team.streak}</span>
          <span className="text-[#bfc8cc] text-[10px]">· {team.conf}ern</span>
        </div>
      </div>
      <div className="flex flex-col items-end gap-2">
        <div className={`px-2.5 py-1 rounded-full text-xs font-bold ${
          team.winPct >= 55 ? "bg-green-500/20 text-green-400" :
          team.winPct < 45 ? "bg-red-500/20 text-red-400" :
          "bg-yellow-500/20 text-yellow-400"
        }`}>{team.winPct}%</div>
        <AddButton onPress={onAdd} accent={accent} />
      </div>
    </button>
  );
}

function GameCard({ game, getTeamById, onClick, onAdd, accent }: { game: UIGame; getTeamById: (id: string) => UITeam | undefined; onClick: () => void; onAdd: (e: React.MouseEvent) => void; accent: string }) {
  const team1 = getTeamById(game.team1Id);
  const team2 = getTeamById(game.team2Id);
  if (!team1 || !team2) return null;
  return (
    <button
      onClick={onClick}
      className="w-full bg-[#111a1f]/70 backdrop-blur-md border border-white/20 rounded-2xl p-4 active:scale-[0.98] transition-transform text-left"
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: accent }}>{game.date} · {game.time}</span>
        <div className="flex items-center gap-2">
          <span className="text-[#bfc8cc] text-[10px] bg-[#1a2a2f] px-2 py-0.5 rounded-full">NHL</span>
          <AddButton onPress={onAdd} accent={accent} />
        </div>
      </div>
      <div className="flex items-center gap-2 mb-3">
        <div className="flex-1 flex items-center gap-2">
          <span className="text-xl">{team1.logo}</span>
          <div>
            <p className="text-white text-sm font-medium">{team1.abbr}</p>
            <p className="text-[10px] font-bold" style={{ color: accent }}>{game.winPct1}% win</p>
          </div>
        </div>
        <div className="flex flex-col items-center px-2">
          <span className="text-[#bfc8cc] text-xs">vs</span>
          <span className="text-[#bfc8cc] text-[10px]">O/U {game.overUnder}</span>
        </div>
        <div className="flex-1 flex items-center gap-2 justify-end">
          <div className="text-right">
            <p className="text-white text-sm font-medium">{team2.abbr}</p>
            <p className="text-[10px] font-bold" style={{ color: accent }}>{game.winPct2}% win</p>
          </div>
          <span className="text-xl">{team2.logo}</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-bold w-7" style={{ color: accent }}>{game.winPct1}%</span>
        <div className="flex-1 bg-[#0a1014] rounded-full h-1.5 overflow-hidden flex">
          <div className="h-full rounded-l-full" style={{ width: `${game.winPct1}%`, backgroundColor: accent }} />
          <div className="h-full bg-[#1a2a2f] flex-1" />
        </div>
        <span className="text-[#bfc8cc] text-[10px] font-bold w-7 text-right">{game.winPct2}%</span>
      </div>
      <p className="text-[#bfc8cc] text-[10px] text-center mt-1.5">{game.venue}</p>
    </button>
  );
}

function PlayerCard({ player, getTeamById, onClick, onAdd, accent }: { player: UIPlayer; getTeamById: (id: string) => UITeam | undefined; onClick: () => void; onAdd: (e: React.MouseEvent) => void; accent: string }) {
  const team = getTeamById(player.teamId);
  if (!team) return null;
  return (
    <button
      onClick={onClick}
      className="w-full bg-[#111a1f]/70 backdrop-blur-md border border-white/20 rounded-2xl p-4 flex items-center gap-3 active:scale-[0.98] transition-transform text-left"
    >
      <div className="w-11 h-11 rounded-xl bg-[#1a2a2f] flex items-center justify-center text-2xl flex-shrink-0">
        {team.logo}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-white text-sm font-medium truncate">{player.name}</p>
        <p className="text-[#bfc8cc] text-xs">{team.abbr} · #{player.number} · {player.position}</p>
        <div className="flex items-center gap-3 mt-1">
          <span className="text-[#bfc8cc] text-[10px]">G: <span className="text-white">{player.goals}</span></span>
          <span className="text-[#bfc8cc] text-[10px]">A: <span className="text-white">{player.assists}</span></span>
          <span className="text-[10px] font-bold" style={{ color: accent }}>PTS: {player.points}</span>
        </div>
        <div className="flex gap-1 mt-1.5">
          {player.lastFive.map((pts, i) => (
            <div key={i} className={`w-5 h-5 rounded text-[9px] flex items-center justify-center font-bold ${
              pts === 0 ? "bg-[#1a2a2f] text-[#bfc8cc]" :
              pts >= 3 ? "bg-[#1a2a2f] text-white" : "bg-[#1a2a2f] text-white"
            }`} style={pts >= 3 ? { backgroundColor: `${accent}30`, color: accent } : {}}>{pts}</div>
          ))}
          <span className="text-[#bfc8cc] text-[9px] ml-1 self-center">last 5</span>
        </div>
      </div>
      <div className="flex flex-col items-end gap-2">
        <div className={`px-2.5 py-1 rounded-full text-xs font-bold ${
          player.winImpact >= 75 ? "text-xs font-bold" : "bg-yellow-500/20 text-yellow-400"
        }`}
          style={player.winImpact >= 75 ? { backgroundColor: `${accent}20`, color: accent } : {}}
        >{player.winImpact}%</div>
        <AddButton onPress={onAdd} accent={accent} />
      </div>
    </button>
  );
}

function LastNGamesSection({
  navigate,
  onAdd,
  teams,
  getTeamById,
  accent,
}: {
  navigate: ReturnType<typeof useNavigate>;
  onAdd: (subject: Subject) => void;
  teams: UITeam[];
  getTeamById: (id: string) => UITeam | undefined;
  accent: string;
}) {
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [search, setSearch] = useState("");
  const [nGamesStats, setNGamesStats] = useState<Record<number, NHLTeamStats>>({});
  const [nGamesPreds, setNGamesPreds] = useState<Record<number, number>>({});
  const [loadingStats, setLoadingStats] = useState(false);

  const selectedTeamData = selectedTeam ? getTeamById(selectedTeam) : null;
  const filteredTeams = teams.filter((t) =>
    !search || t.name.toLowerCase().includes(search.toLowerCase()) || t.abbr.toLowerCase().includes(search.toLowerCase())
  );

  useEffect(() => {
    if (!selectedTeam) return;
    setLoadingStats(true);
    Promise.all(
      lastNGamesOptions.map(async (n) => {
        const [stats, pred] = await Promise.all([
          nhlApiService.getTeamLastNGamesStats(selectedTeam, n),
          predictionApiService.getSinglePrediction({
            marketType: "moneyline",
            teamId: selectedTeam,
            seasonContext: { lastNGames: n },
          }),
        ]);
        return { n, stats, prob: pred.probability };
      })
    ).then((results) => {
      const statsMap: Record<number, NHLTeamStats> = {};
      const predMap: Record<number, number> = {};
      results.forEach(({ n, stats, prob }) => {
        statsMap[n] = stats;
        predMap[n] = prob;
      });
      setNGamesStats(statsMap);
      setNGamesPreds(predMap);
      setLoadingStats(false);
    });
  }, [selectedTeam]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-[#bfc8cc] text-xs mb-2 uppercase tracking-wider">Select a team</p>
        <button
          onClick={() => setShowPicker(!showPicker)}
          className="w-full bg-[#111a1f]/70 backdrop-blur-md border border-white/20 rounded-2xl px-4 py-3 flex items-center justify-between"
        >
          <div className="flex items-center gap-2">
            {selectedTeamData ? (
              <>
                <span className="text-xl">{selectedTeamData.logo}</span>
                <span className="text-white text-sm">{selectedTeamData.name}</span>
              </>
            ) : (
              <span className="text-[#bfc8cc] text-sm">Choose a team…</span>
            )}
          </div>
          <span style={{ color: accent }}>{showPicker ? "▲" : "▼"}</span>
        </button>

        {showPicker && (
          <div className="mt-1 bg-[#111a1f] border border-white/20 rounded-2xl overflow-hidden">
            <div className="px-3 py-2 border-b border-white/20">
              <input
                className="w-full bg-transparent text-white text-xs outline-none placeholder:text-[#bfc8cc]"
                placeholder="Search team…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {filteredTeams.map((team, i) => (
              <button
                key={team.id}
                onClick={() => { setSelectedTeam(team.id); setShowPicker(false); setSearch(""); }}
                className={`w-full flex items-center gap-3 px-4 py-2.5 hover:bg-[#1a2a2f] transition-colors ${
                  i < filteredTeams.length - 1 ? "border-b border-[#1a2225]" : ""
                }`}
              >
                <span className="text-lg">{team.logo}</span>
                <span className="text-white text-sm flex-1 text-left">{team.name}</span>
                <span className="text-[#bfc8cc] text-xs">{team.record}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {selectedTeamData && (
        <div>
          <p className="text-[#bfc8cc] text-xs mb-2 uppercase tracking-wider">Select span</p>
          <div className="grid grid-cols-2 gap-2">
            {lastNGamesOptions.map((n) => {
              const stats = nGamesStats[n];
              const wins = stats?.wins ?? Math.round(n * (selectedTeamData.winPct / 100));
              const prob = nGamesPreds[n] ?? selectedTeamData.winPct;
              return (
                <div key={n} className="relative">
                  <button
                    onClick={() => navigate(`/stats/prediction/ngames/${selectedTeam}?n=${n}`)}
                    className="w-full bg-[#111a1f]/70 backdrop-blur-md border border-white/20 rounded-2xl p-4 flex flex-col items-center gap-1 active:scale-[0.98] transition-transform"
                    style={{ ['--hover-border' as string]: `${accent}80` }}
                  >
                    <span className="text-white text-2xl font-bold">{n}</span>
                    <span className="text-[#bfc8cc] text-xs">Last {n} Games</span>
                    <div className="flex items-center gap-1 mt-1 flex-wrap justify-center">
                      {Array.from({ length: Math.min(n, 10) }).map((_, i) => (
                        <div
                          key={i}
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ backgroundColor: i < Math.round(10 * (selectedTeamData.winPct / 100)) ? accent : "#1e2d32" }}
                        />
                      ))}
                    </div>
                    <span className="text-[10px] mt-0.5" style={{ color: accent }}>
                      {loadingStats ? "Loading…" : `${wins}W – ${n - wins}L · ${prob}%`}
                    </span>
                  </button>
                  <button
                    onClick={() => onAdd({
                      id: selectedTeamData.id,
                      type: "team",
                      name: `${selectedTeamData.name} (Last ${n})`,
                      logo: selectedTeamData.logo,
                      subtitle: `Last ${n} games · ${wins}W ${n - wins}L`,
                    })}
                    className="absolute top-2 right-2 w-7 h-7 rounded-lg border flex items-center justify-center text-sm font-bold"
                    style={{ color: accent, borderColor: `${accent}4d`, backgroundColor: `${accent}1a` }}
                  >
                    +
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!selectedTeamData && (
        <div className="flex flex-col items-center justify-center py-12 gap-3">
          <span className="text-5xl">🏒</span>
          <p className="text-[#bfc8cc] text-sm text-center">Select a team above to explore their form over a span of games</p>
        </div>
      )}
    </div>
  );
}


// ─── Betting Prop Cards ───────────────────────────────────────────────────────

interface LocalPlayerProp {
  id: string; playerName: string; country: string; team: string; logo: string;
  propLabel: string; propType: string; line: number; season: string;
  probability: number; oddsLabel: string;
}
function PlayerPropCard({
  prop, accent, onNavigate,
}: { prop: LocalPlayerProp; accent: string; onNavigate: () => void }) {
  const isHigh = prop.probability >= 65;
  const isMid  = prop.probability >= 45;
  const probColor = isHigh ? accent : isMid ? "#fbbf24" : "#f87171";
  const tagLabel = prop.propType === "award" ? "Award" : prop.propType === "playoff" ? "Playoff" : "Season Prop";
  return (
    <button
      onClick={onNavigate}
      className="w-full bg-[#111a1f]/70 backdrop-blur-md border border-white/20 rounded-2xl p-4 active:scale-[0.98] transition-transform text-left"
    >
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-[#1a2a2f] flex items-center justify-center text-xl flex-shrink-0">
          {prop.logo}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded-full"
              style={{ color: accent, backgroundColor: `${accent}20` }}>{tagLabel}</span>
            <span className="text-[10px] text-[#bfc8cc]">{prop.season}</span>
          </div>
          <p className="text-white text-sm font-medium truncate">{prop.playerName}</p>
          <p className="text-[#bfc8cc] text-xs">{prop.country} {prop.team}</p>
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <div className="px-2.5 py-1 rounded-full text-sm font-black"
            style={{ backgroundColor: `${probColor}20`, color: probColor }}>
            {prop.probability}%
          </div>
          <span className="text-[#bfc8cc] text-[10px]">{prop.oddsLabel}</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 px-3 py-2 rounded-xl border text-xs font-medium"
          style={{ borderColor: `${accent}30`, backgroundColor: `${accent}0d`, color: "white" }}>
          {prop.propLabel}
        </div>
        <span className="text-[10px] font-semibold flex-shrink-0" style={{ color: accent }}>Predict &rarr;</span>
      </div>
      <div className="mt-2 w-full bg-[#0a1014] rounded-full h-1.5">
        <div className="h-1.5 rounded-full" style={{ width: `${prop.probability}%`, backgroundColor: probColor }} />
      </div>
    </button>
  );
}

interface LocalFuture {
  id: string; team: string; logo: string; propLabel: string;
  propType: string; probability: number; oddsLabel: string;
}
function SeasonFutureCard({
  future, accent, onNavigate,
}: { future: LocalFuture; accent: string; onNavigate: () => void }) {
  const isHigh = future.probability >= 20;
  return (
    <button
      onClick={onNavigate}
      className="w-full bg-[#111a1f]/70 backdrop-blur-md border border-white/20 rounded-2xl p-4 active:scale-[0.98] transition-transform text-left"
    >
      <div className="flex items-center gap-3 mb-2">
        <div className="w-10 h-10 rounded-xl bg-[#1a2a2f] flex items-center justify-center text-xl flex-shrink-0">
          {future.logo}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400">
              {future.propType === "cup" ? "Stanley Cup" : future.propType === "conf" ? "Conference" : "Futures"}
            </span>
          </div>
          <p className="text-white text-sm font-medium truncate">{future.team}</p>
          <p className="text-[#bfc8cc] text-xs truncate">{future.propLabel}</p>
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <div className="px-2.5 py-1 rounded-full text-sm font-black"
            style={{ backgroundColor: isHigh ? `${accent}20` : "#ffffff10", color: isHigh ? accent : "#bfc8cc" }}>
            {future.probability}%
          </div>
          <span className="text-[#bfc8cc] text-[10px]">{future.oddsLabel}</span>
        </div>
      </div>
      <div className="w-full bg-[#0a1014] rounded-full h-1.5">
        <div className="h-1.5 rounded-full" style={{ width: `${future.probability}%`, backgroundColor: accent }} />
      </div>
    </button>
  );
}

// ─── Tennis static reference data ────────────────────────────────────────────

interface TennisSurface {
  name: string; icon: string; topPlayer: string; avgWinPct: number; desc: string;
}

const TENNIS_SURFACES: TennisSurface[] = [
  { name: "Clay",  icon: "🟫", topPlayer: "I. Swiatek",  avgWinPct: 72, desc: "Slower bounces, long rallies" },
  { name: "Hard",  icon: "🟦", topPlayer: "J. Sinner",   avgWinPct: 68, desc: "All-round game, power favoured" },
  { name: "Grass", icon: "🟩", topPlayer: "N. Djokovic", avgWinPct: 65, desc: "Fast & low — serve-volley era" },
];

// Fallback rankings shown when RapidAPI plan doesn't include the endpoint
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

const FALLBACK_TOURNAMENTS: TennisTournamentInfo[] = [
  { id: "rg",        name: "Roland Garros",  surface: "Clay",  surfaceIcon: "🟫", location: "Paris, France",   prize: "$51.9M", startDate: "2025-05-25", endDate: "2025-06-08" },
  { id: "wimbledon", name: "Wimbledon",       surface: "Grass", surfaceIcon: "🟩", location: "London, UK",      prize: "$50.0M", startDate: "2025-06-30", endDate: "2025-07-13" },
  { id: "uso",       name: "US Open",         surface: "Hard",  surfaceIcon: "🟦", location: "New York, USA",   prize: "$65.0M", startDate: "2025-08-25", endDate: "2025-09-07" },
  { id: "ao",        name: "Australian Open", surface: "Hard",  surfaceIcon: "🟦", location: "Melbourne, AUS",  prize: "$54.2M", startDate: "2026-01-12", endDate: "2026-01-26" },
];

/** Estimate win % from ranking position (rank 1 ≈ 82%, drops ~2% per rank) */
function rankToWinPct(pos: number): number {
  return Math.max(35, Math.min(85, 84 - (pos - 1) * 2));
}

/** Format ISO datetime to HH:MM */
function fmtMatchTime(iso?: string): string {
  if (!iso) return "TBD";
  try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  catch { return "TBD"; }
}

/** Format ISO date range for tournaments */
function fmtDateRange(start?: string, end?: string): string {
  if (!start) return "";
  const fmt = (s: string) => {
    try { return new Date(s).toLocaleDateString([], { month: "short", day: "numeric" }); }
    catch { return s; }
  };
  return end ? fmt(start) + " – " + fmt(end) : fmt(start);
}

// ─── Tennis sub-components ───────────────────────────────────────────────────

function TennisRankingCard({ entry, tour, accent, onPress }: { entry: TennisRankingEntry; tour: "ATP" | "WTA"; accent: string; onPress?: () => void }) {
  const winPct = rankToWinPct(entry.pos);
  return (
    <div onClick={onPress} className="w-full bg-[#111a1f]/70 backdrop-blur-md border border-white/20 rounded-2xl p-4 flex items-center gap-3 cursor-pointer active:opacity-70">
      <div className="w-11 h-11 rounded-xl bg-[#1a2a2f] flex flex-col items-center justify-center flex-shrink-0">
        <span className="text-[9px] text-[#bfc8cc] uppercase tracking-wider">{tour}</span>
        <span className="text-white text-lg font-bold leading-none">#{entry.pos}</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-base">{entry.player.country}</span>
          <p className="text-white text-sm font-medium truncate">{entry.player.name}</p>
        </div>
        <p className="text-[#bfc8cc] text-xs">{entry.points.toLocaleString()} pts</p>
      </div>
      <div className="px-2.5 py-1 rounded-full text-xs font-bold"
        style={{
          backgroundColor: winPct >= 70 ? `${accent}20` : winPct >= 55 ? "#eab30820" : "#ef444420",
          color:           winPct >= 70 ? accent        : winPct >= 55 ? "#fbbf24"   : "#f87171",
        }}>
        {winPct}%
      </div>
    </div>
  );
}

function TennisTournamentCard({ t, accent }: { t: TennisTournamentInfo; accent: string }) {
  const dateRange = fmtDateRange(t.startDate, t.endDate);
  return (
    <div className="w-full bg-[#111a1f]/70 backdrop-blur-md border border-white/20 rounded-2xl p-4">
      <div className="flex items-start gap-3">
        <div className="w-11 h-11 rounded-xl bg-[#1a2a2f] flex items-center justify-center text-2xl flex-shrink-0">🏆</div>
        <div className="flex-1 min-w-0">
          <p className="text-white text-sm font-medium">{t.name}</p>
          {(t.location || dateRange) && (
            <p className="text-[#bfc8cc] text-xs mt-0.5">{[t.location, dateRange].filter(Boolean).join(" · ")}</p>
          )}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ color: accent, backgroundColor: `${accent}1a` }}>{t.surfaceIcon} {t.surface}</span>
            {t.prize && <span className="text-[#bfc8cc] text-[10px]">Prize: {t.prize}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function TennisSurfaceCard({ s, accent }: { s: TennisSurface; accent: string }) {
  return (
    <div className="w-full bg-[#111a1f]/70 backdrop-blur-md border border-white/20 rounded-2xl p-4">
      <div className="flex items-center gap-3 mb-3">
        <span className="text-3xl">{s.icon}</span>
        <div className="flex-1">
          <p className="text-white text-sm font-medium">{s.name} Court</p>
          <p className="text-[#bfc8cc] text-xs">{s.desc}</p>
        </div>
        <div className="px-2.5 py-1 rounded-full text-xs font-bold" style={{ backgroundColor: `${accent}20`, color: accent }}>{s.avgWinPct}%</div>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[#bfc8cc] text-xs">Top performer</span>
        <span className="text-white text-xs font-medium">{s.topPlayer}</span>
      </div>
      <div className="w-full bg-[#0a1014] rounded-full h-1.5 mt-2">
        <div className="h-1.5 rounded-full" style={{ width: `${s.avgWinPct}%`, backgroundColor: accent }} />
      </div>
    </div>
  );
}

// ─── Tennis probability helpers ──────────────────────────────────────────────

function calcTennisProbs(
  p1name: string,
  p2name: string,
  rankings: (TennisRankingEntry & { tour: "ATP" | "WTA" })[],
) {
  // Try to match by last name
  const lastName = (n: string) => n.split(/[.\s]/).pop()?.toLowerCase() ?? "";
  const r1 = rankings.find((r) => r.player.name.toLowerCase().includes(lastName(p1name)));
  const r2 = rankings.find((r) => r.player.name.toLowerCase().includes(lastName(p2name)));

  let p1Win = 55;
  if (r1 && r2) {
    const total = r1.points + r2.points || 1;
    p1Win = Math.round(Math.max(20, Math.min(80, (r1.points / total) * 100)));
  }
  const p2Win = 100 - p1Win;

  // Over 2.5 sets: closer to 50/50 → more likely to go full distance
  const balance = 1 - Math.abs(p1Win - 50) / 50;
  const overSets = Math.round(35 + balance * 35); // 35–70 %

  // First set: similar to match winner but pulled toward 50/50
  const p1FirstSet = Math.round(50 + (p1Win - 50) * 0.70);

  return {
    p1Win, p2Win,
    overSets, underSets: 100 - overSets,
    p1FirstSet, p2FirstSet: 100 - p1FirstSet,
  };
}

// ─── Bettable tennis match card ───────────────────────────────────────────────

function TennisBetMatchCard({
  m, accent,
  allRankings,
}: {
  m: TennisApiMatch;
  accent: string;
  allRankings: (TennisRankingEntry & { tour: "ATP" | "WTA" })[];
}) {
  const { addLeg, hasLeg } = useBet();
  const timeLabel = m.isLive ? (m.liveSet ?? "Live") : fmtMatchTime(m.scheduledIso);

  const probs = calcTennisProbs(m.player1.name, m.player2.name, allRankings);

  // Short label: "Sinner" from "J. Sinner"
  const shortName = (n: string) => n.split(/[.\s]/).filter(Boolean).pop() ?? n;

  interface MarketBtn {
    legId: string;
    name: string;
    flag: string;
    prob: number;
    leg: Omit<BetLeg, "addedAt">;
  }

  const markets: { title: string; desc: string; btns: [MarketBtn, MarketBtn] }[] = [
    {
      title: "Match Winner",
      desc: "Who wins the match",
      btns: [
        {
          legId: `tennis-${m.id}-mw-p1`,
          name: shortName(m.player1.name),
          flag: m.player1.country,
          prob: probs.p1Win,
          leg: {
            id: `tennis-${m.id}-mw-p1`,
            marketType: "tennis_match_winner",
            marketLabel: "Match Winner",
            subjectType: "game",
            subjectId: m.id,
            subjectName: m.player1.name,
            subjectLogo: m.player1.country,
            selection: `${m.player1.name} to win`,
            selectionShort: `${shortName(m.player1.name)} ML`,
            probability: probs.p1Win,
            gameInfo: `${m.player1.name} vs ${m.player2.name}`,
          },
        },
        {
          legId: `tennis-${m.id}-mw-p2`,
          name: shortName(m.player2.name),
          flag: m.player2.country,
          prob: probs.p2Win,
          leg: {
            id: `tennis-${m.id}-mw-p2`,
            marketType: "tennis_match_winner",
            marketLabel: "Match Winner",
            subjectType: "game",
            subjectId: m.id,
            subjectName: m.player2.name,
            subjectLogo: m.player2.country,
            selection: `${m.player2.name} to win`,
            selectionShort: `${shortName(m.player2.name)} ML`,
            probability: probs.p2Win,
            gameInfo: `${m.player1.name} vs ${m.player2.name}`,
          },
        },
      ],
    },
    {
      title: "Total Sets",
      desc: "Will the match go to a deciding set?",
      btns: [
        {
          legId: `tennis-${m.id}-ts-over`,
          name: "Over 2.5",
          flag: "🎾",
          prob: probs.overSets,
          leg: {
            id: `tennis-${m.id}-ts-over`,
            marketType: "tennis_total_sets",
            marketLabel: "Total Sets",
            subjectType: "game",
            subjectId: m.id,
            subjectName: "Over 2.5 Sets",
            subjectLogo: "🎾",
            selection: "Over 2.5 sets",
            selectionShort: "O 2.5 Sets",
            probability: probs.overSets,
            line: 2.5,
            gameInfo: `${m.player1.name} vs ${m.player2.name}`,
          },
        },
        {
          legId: `tennis-${m.id}-ts-under`,
          name: "Under 2.5",
          flag: "🎾",
          prob: probs.underSets,
          leg: {
            id: `tennis-${m.id}-ts-under`,
            marketType: "tennis_total_sets",
            marketLabel: "Total Sets",
            subjectType: "game",
            subjectId: m.id,
            subjectName: "Under 2.5 Sets",
            subjectLogo: "🎾",
            selection: "Under 2.5 sets",
            selectionShort: "U 2.5 Sets",
            probability: probs.underSets,
            line: 2.5,
            gameInfo: `${m.player1.name} vs ${m.player2.name}`,
          },
        },
      ],
    },
    {
      title: "First Set Winner",
      desc: "Who wins the opening set",
      btns: [
        {
          legId: `tennis-${m.id}-fs-p1`,
          name: shortName(m.player1.name),
          flag: m.player1.country,
          prob: probs.p1FirstSet,
          leg: {
            id: `tennis-${m.id}-fs-p1`,
            marketType: "tennis_first_set",
            marketLabel: "First Set Winner",
            subjectType: "game",
            subjectId: m.id,
            subjectName: m.player1.name,
            subjectLogo: m.player1.country,
            selection: `${m.player1.name} wins 1st set`,
            selectionShort: `${shortName(m.player1.name)} 1st Set`,
            probability: probs.p1FirstSet,
            gameInfo: `${m.player1.name} vs ${m.player2.name}`,
          },
        },
        {
          legId: `tennis-${m.id}-fs-p2`,
          name: shortName(m.player2.name),
          flag: m.player2.country,
          prob: probs.p2FirstSet,
          leg: {
            id: `tennis-${m.id}-fs-p2`,
            marketType: "tennis_first_set",
            marketLabel: "First Set Winner",
            subjectType: "game",
            subjectId: m.id,
            subjectName: m.player2.name,
            subjectLogo: m.player2.country,
            selection: `${m.player2.name} wins 1st set`,
            selectionShort: `${shortName(m.player2.name)} 1st Set`,
            probability: probs.p2FirstSet,
            gameInfo: `${m.player1.name} vs ${m.player2.name}`,
          },
        },
      ],
    },
  ];

  return (
    <div className="w-full bg-[#111a1f]/70 backdrop-blur-md border border-white/20 rounded-2xl overflow-hidden">

      {/* ── Header ── */}
      <div className="px-4 pt-3 pb-2.5 flex items-center justify-between border-b border-white/[0.06]">
        <div className="flex items-center gap-2 min-w-0">
          {m.isLive
            ? <span className="text-[10px] text-red-400 font-medium uppercase tracking-wide flex items-center gap-1 flex-shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse inline-block" />{timeLabel}
              </span>
            : <span className="text-[11px] font-semibold flex-shrink-0" style={{ color: accent }}>{timeLabel}</span>}
          <span className="text-[#4a5a62] text-[10px]">·</span>
          <span className="text-[#8a9ea6] text-[10px] truncate">{m.tournament}</span>
        </div>
        <span className="text-[10px] px-2 py-0.5 rounded-full flex-shrink-0 ml-2"
          style={{ color: accent, backgroundColor: `${accent}1a` }}>{m.surfaceIcon} {m.surface}</span>
      </div>

      {/* ── Players ── */}
      <div className="px-4 py-3 flex items-center gap-3">
        <div className="flex-1 flex items-center gap-2">
          <span className="text-2xl">{m.player1.country}</span>
          <div>
            <p className="text-white text-sm font-semibold leading-tight">{m.player1.name}</p>
            {m.player1.sets
              ? <p className="text-[11px] font-bold mt-0.5" style={{ color: accent }}>{m.player1.sets.join("-")} sets</p>
              : <p className="text-[11px] font-bold mt-0.5" style={{ color: accent }}>{probs.p1Win}% win</p>}
          </div>
        </div>
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-[#8a9ea6] text-xs font-medium">vs</span>
        </div>
        <div className="flex-1 flex items-center gap-2 justify-end">
          <div className="text-right">
            <p className="text-white text-sm font-semibold leading-tight">{m.player2.name}</p>
            {m.player2.sets
              ? <p className="text-[11px] font-bold mt-0.5 text-right" style={{ color: accent }}>{m.player2.sets.join("-")} sets</p>
              : <p className="text-[11px] font-bold mt-0.5 text-right" style={{ color: accent }}>{probs.p2Win}% win</p>}
          </div>
          <span className="text-2xl">{m.player2.country}</span>
        </div>
      </div>

      {/* ── Win probability bar ── */}
      <div className="px-4 pb-3 flex items-center gap-2">
        <span className="text-[10px] font-bold w-8 flex-shrink-0" style={{ color: accent }}>{probs.p1Win}%</span>
        <div className="flex-1 bg-[#0a1014] rounded-full h-1.5 overflow-hidden flex">
          <div className="h-full rounded-l-full transition-all" style={{ width: `${probs.p1Win}%`, backgroundColor: accent }} />
        </div>
        <span className="text-[#8a9ea6] text-[10px] font-bold w-8 text-right flex-shrink-0">{probs.p2Win}%</span>
      </div>

      {/* ── Markets ── */}
      <div className="border-t border-white/[0.06]">
        {markets.map((mkt, mi) => (
          <div key={mkt.title} className={`px-4 py-3 ${mi > 0 ? "border-t border-white/[0.04]" : ""}`}>
            <div className="flex items-baseline gap-2 mb-2">
              <p className="text-white text-xs font-semibold">{mkt.title}</p>
              <p className="text-[#8a9ea6] text-[10px]">{mkt.desc}</p>
            </div>
            <div className="flex gap-2">
              {mkt.btns.map((btn) => {
                const added = hasLeg(btn.legId);
                return (
                  <button
                    key={btn.legId}
                    onClick={() => addLeg({ ...btn.leg, addedAt: new Date().toISOString() })}
                    className="flex-1 flex flex-col items-center justify-center py-2.5 px-2 rounded-xl border transition-all active:scale-95"
                    style={added
                      ? { backgroundColor: `${accent}20`, borderColor: `${accent}60` }
                      : { backgroundColor: "#0d1519", borderColor: "#ffffff12" }}
                  >
                    <span className="text-base mb-0.5">{btn.flag}</span>
                    <span className="text-white text-[11px] font-semibold">{btn.name}</span>
                    <span className="text-[12px] font-bold mt-0.5"
                      style={{ color: added ? accent : accent }}>{btn.prob}%</span>
                    {added && <span className="text-[9px] mt-0.5" style={{ color: accent }}>Added ✓</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── TennisStatsContent ───────────────────────────────────────────────────────

const TENNIS_FILTER_TABS = ["By Player", "By Match", "By Surface", "By Tournament"];

function TennisStatsContent({ accent }: { accent: string }) {
  const navigate = useNavigate();
  const [activeFilter, setActiveFilter] = useState(0);
  const [search, setSearch] = useState("");
  const [tourFilter, setTourFilter] = useState<"ALL" | "ATP" | "WTA">("ALL");

  // Rankings
  const [atpRankings,  setAtpRankings]  = useState<TennisRankingEntry[]>([]);
  const [wtaRankings,  setWtaRankings]  = useState<TennisRankingEntry[]>([]);
  const [rankLoading,  setRankLoading]  = useState(false);
  const [rankError,    setRankError]    = useState<string | null>(null);

  // Matches (live + fixtures)
  const [liveMatches,  setLiveMatches]  = useState<TennisApiMatch[]>([]);
  const [fixtures,     setFixtures]     = useState<TennisApiMatch[]>([]);
  const [matchLoading, setMatchLoading] = useState(false);
  const [matchError,   setMatchError]   = useState<string | null>(null);

  // Tournaments
  const [tournaments,  setTournaments]  = useState<TennisTournamentInfo[]>([]);
  const [tourLoading,  setTourLoading]  = useState(false);

  // Fetch rankings — falls back to static data if API plan doesn't include endpoint
  useEffect(() => {
    if (activeFilter !== 0) return;
    if (atpRankings.length > 0) return;
    setRankLoading(true);
    setRankError(null);
    Promise.all([
      tennisApiService.getRankings("ATP"),
      tennisApiService.getRankings("WTA"),
    ]).then(([atp, wta]) => {
      // API returned empty (403 / 429 handled server-side) → use fallback
      setAtpRankings(atp.length > 0 ? atp : FALLBACK_ATP);
      setWtaRankings(wta.length > 0 ? wta : FALLBACK_WTA);
      setRankLoading(false);
    }).catch(() => {
      setAtpRankings(FALLBACK_ATP);
      setWtaRankings(FALLBACK_WTA);
      setRankLoading(false);
    });
  }, [activeFilter]);

  // Fetch matches when "By Match" tab active
  useEffect(() => {
    if (activeFilter !== 1) return;
    if (liveMatches.length > 0 || fixtures.length > 0) return;
    setMatchLoading(true);
    setMatchError(null);
    Promise.all([
      tennisApiService.getLiveMatches(),
      tennisApiService.getFixtures(),
    ]).then(([live, fix]) => {
      setLiveMatches(live);
      setFixtures(fix);
      setMatchLoading(false);
    }).catch((err) => {
      setMatchError(err.message ?? "Failed to load matches");
      setMatchLoading(false);
    });
  }, [activeFilter]);

  // Fetch tournaments — falls back to static Grand Slam schedule if API unavailable
  useEffect(() => {
    if (activeFilter !== 3) return;
    if (tournaments.length > 0) return;
    setTourLoading(true);
    tennisApiService.getTournaments().then((data) => {
      setTournaments(data.length > 0 ? data : FALLBACK_TOURNAMENTS);
      setTourLoading(false);
    }).catch(() => {
      setTournaments(FALLBACK_TOURNAMENTS);
      setTourLoading(false);
    });
  }, [activeFilter]);

  const allRankings: (TennisRankingEntry & { tour: "ATP" | "WTA" })[] = [
    ...atpRankings.map((e) => ({ ...e, tour: "ATP" as const })),
    ...wtaRankings.map((e) => ({ ...e, tour: "WTA" as const })),
  ];

  const filteredRankings = allRankings.filter((p) => {
    if (tourFilter !== "ALL" && p.tour !== tourFilter) return false;
    if (search) return p.player.name.toLowerCase().includes(search.toLowerCase());
    return true;
  });

  const allMatches = [...liveMatches, ...fixtures];
  const filteredMatches = allMatches.filter((m) =>
    !search ||
    m.player1.name.toLowerCase().includes(search.toLowerCase()) ||
    m.player2.name.toLowerCase().includes(search.toLowerCase()) ||
    m.tournament.toLowerCase().includes(search.toLowerCase())
  );

  function LoadingDot() {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3">
        <div className="w-10 h-10 rounded-full bg-[#111a1f] border border-white/20 flex items-center justify-center">
          <div className="w-4 h-4 rounded-full bg-[#86d1ea]/20 border border-[#86d1ea]/40 animate-pulse" />
        </div>
        <p className="text-[#bfc8cc] text-sm">Loading...</p>
      </div>
    );
  }

  function ErrorCard({ msg, onRetry }: { msg: string; onRetry: () => void }) {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <p className="text-red-400 text-sm text-center">{msg}</p>
        <button onClick={onRetry} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full"
          style={{ backgroundColor: `${accent}20`, color: accent }}>
          <RefreshCw size={12} /> Retry
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="bg-[#111a1f] border border-white/20 rounded-2xl flex items-center gap-2 px-3 py-2.5 mb-3">
        <Search size={14} className="text-[#8a9ea6] flex-shrink-0" />
        <input className="flex-1 bg-transparent text-white text-sm outline-none placeholder:text-[#bfc8cc]"
          placeholder="Search player, tournament..." value={search} onChange={(e) => setSearch(e.target.value)} />
        {search && <button onClick={() => setSearch("")} className="text-[#bfc8cc] text-xs">×</button>}
      </div>
      <div className="flex gap-1.5 overflow-x-auto scrollbar-hide pb-0.5 mb-3">
        {TENNIS_FILTER_TABS.map((tab, i) => (
          <button key={tab} onClick={() => setActiveFilter(i)} className="flex-shrink-0 px-4 py-2 rounded-full text-xs font-medium transition-all"
            style={activeFilter === i ? { backgroundColor: accent, color: "#0f1416", fontWeight: 700 } : { backgroundColor: "#1a2a2f", color: "#bfc8cc" }}>
            {tab}
          </button>
        ))}
      </div>

      {/* ── By Player ── */}
      {activeFilter === 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex gap-2 items-center">
            {(["ALL", "ATP", "WTA"] as const).map((t) => (
              <button key={t} onClick={() => setTourFilter(t)} className="px-4 py-1.5 rounded-full text-xs font-medium transition-all border"
                style={tourFilter === t ? { backgroundColor: `${accent}20`, color: accent, borderColor: `${accent}50` } : { backgroundColor: "transparent", color: "#bfc8cc", borderColor: "#ffffff15" }}>
                {t}
              </button>
            ))}
            {!rankLoading && <span className="ml-auto text-[#bfc8cc] text-xs">{filteredRankings.length} players</span>}
          </div>
          {rankLoading && <LoadingDot />}
          {rankError && (
            <ErrorCard msg={rankError} onRetry={() => {
              setAtpRankings([]); setWtaRankings([]); setRankError(null);
              setActiveFilter(-1); setTimeout(() => setActiveFilter(0), 0);
            }} />
          )}
          {!rankLoading && !rankError && filteredRankings.map((e) => (
            <TennisRankingCard key={`${e.tour}-${e.pos}`} entry={e} tour={e.tour} accent={accent} onPress={() => navigate(`/stats/prediction/tennis-player/${e.player.id}`, { state: { player: e } })} />
          ))}
        </div>
      )}

      {/* ── By Match ── */}
      {activeFilter === 1 && (
        <div className="flex flex-col gap-2">
          {matchLoading && <LoadingDot />}
          {matchError && (
            <ErrorCard msg={matchError} onRetry={() => {
              setLiveMatches([]); setFixtures([]); setMatchError(null);
              setActiveFilter(-1); setTimeout(() => setActiveFilter(1), 0);
            }} />
          )}
          {!matchLoading && !matchError && (
            <>
              {liveMatches.length > 0 && (
                <div className="mb-1">
                  <span className="text-[10px] text-red-400 font-medium uppercase tracking-wide flex items-center gap-1 mb-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse inline-block" />
                    {liveMatches.length} Live Now
                  </span>
                  {liveMatches
                    .filter((m) => !search || m.player1.name.toLowerCase().includes(search.toLowerCase()) || m.player2.name.toLowerCase().includes(search.toLowerCase()))
                    .map((m) => <TennisBetMatchCard key={m.id} m={m} accent={accent} allRankings={allRankings} />)}
                </div>
              )}
              {fixtures.length > 0 && (
                <div>
                  <span className="text-[10px] text-[#bfc8cc] font-medium uppercase tracking-wide block mb-2">Upcoming Today</span>
                  {filteredMatches.filter((m) => !m.isLive).map((m) => <TennisBetMatchCard key={m.id} m={m} accent={accent} allRankings={allRankings} />)}
                </div>
              )}
              {allMatches.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-10">
                  <p className="text-white text-sm font-medium">No matches today</p>
                  <p className="text-[#bfc8cc] text-xs text-center">Check back on match days</p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── By Surface ── */}
      {activeFilter === 2 && (
        <div className="flex flex-col gap-3">
          <p className="text-[#bfc8cc] text-xs">Win prediction accuracy varies by court surface</p>
          {TENNIS_SURFACES.map((s) => <TennisSurfaceCard key={s.name} s={s} accent={accent} />)}
        </div>
      )}

      {/* ── By Tournament ── */}
      {activeFilter === 3 && (
        <div className="flex flex-col gap-3">
          {tourLoading && <LoadingDot />}
          {!tourLoading && tournaments.length === 0 && (
            <p className="text-[#bfc8cc] text-xs text-center py-4">No tournament data available</p>
          )}
          {!tourLoading && tournaments.map((t) => <TennisTournamentCard key={t.id} t={t} accent={accent} />)}
        </div>
      )}
    </>
  );
}

// ─── Main StatsPage export ────────────────────────────────────────────────────

export function StatsPage() {
  const { sport, theme } = useSport();
  const accent = theme.accent;
  const [activeFilter, setActiveFilter] = useState(0);
  const [search, setSearch] = useState("");
  const [addSheet, setAddSheet] = useState<AddSheetState>({ open: false });
  const navigate = useNavigate();
  const { teams, games, players, loading, error, getTeamById } = useNHLData();
  const [futures, setFutures] = useState<LocalFuture[]>([]);

  useEffect(() => {
    nhlApiService.getStandings()
      .then((standings) => {
        const allTeams = standings.flatMap((s) => s.teams);
        const east = allTeams.filter(t => t.team.conference === "Eastern")
          .sort((a, b) => (b.stats.points ?? 0) - (a.stats.points ?? 0)).slice(0, 4);
        const west = allTeams.filter(t => t.team.conference === "Western")
          .sort((a, b) => (b.stats.points ?? 0) - (a.stats.points ?? 0)).slice(0, 4);
        const top = [...east, ...west]
          .sort((a, b) => (b.stats.points ?? 0) - (a.stats.points ?? 0))
          .slice(0, 8);
        setFutures(top.map((entry) => {
          const abbr = entry.team.abbreviation;
          const wins = entry.stats.wins;
          const pts  = entry.stats.points ?? wins * 2;
          const rank = top.indexOf(entry) + 1;
          const prob = Math.max(5, Math.round(35 - rank * 3 + (pts - 90) * 0.3));
          return {
            id: `${abbr.toLowerCase()}-cup`,
            team: entry.team.name,
            logo: teamEmoji(abbr),
            propLabel: "Win Stanley Cup 2026",
            propType: "cup",
            probability: Math.max(5, Math.min(60, prob)),
            oddsLabel: probToOdds(Math.max(5, Math.min(60, prob))),
          };
        }));
      })
      .catch(() => { setFutures([]); });
  }, []);

  function openAdd(subject: Subject) { setAddSheet({ open: true, subject }); }

  const filteredTeams = teams.filter((t) => !search || t.name.toLowerCase().includes(search.toLowerCase()) || t.abbr.toLowerCase().includes(search.toLowerCase()));
  const filteredGames = games.filter((g) => {
    if (!search) return true;
    const t1 = getTeamById(g.team1Id); const t2 = getTeamById(g.team2Id);
    if (!t1 || !t2) return false;
    return [t1.name, t2.name, t1.abbr, t2.abbr].some((s) => s.toLowerCase().includes(search.toLowerCase()));
  });
  const filteredPlayers = players.filter((p) =>
    !search || p.name.toLowerCase().includes(search.toLowerCase()) ||
    getTeamById(p.teamId)?.abbr.toLowerCase().includes(search.toLowerCase())
  );

  if (sport === "tennis") {
    return (
      <div className="flex flex-col min-h-screen bg-transparent text-white max-w-[430px] mx-auto relative z-10">
        <header className="px-4 pt-12 pb-3 bg-[#0a1014]/80 backdrop-blur-md sticky top-0 z-40 border-b border-white/[0.04]">
          <div className="flex items-center justify-between mb-3">
            <div><h1 className="text-white text-xl font-bold" style={{ fontFamily: "'Merriweather', Georgia, serif" }}>Statistics</h1><p className="text-[#bfc8cc] text-xs">Tennis · Live Data</p></div>
            <div className="border rounded-xl px-3 py-1.5 flex items-center gap-1.5" style={{ backgroundColor: `${accent}1a`, borderColor: `${accent}4d` }}>
              <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: accent }} />
              <span className="text-xs font-medium" style={{ color: accent }}>Live Data</span>
            </div>
          </div>
        </header>
        <div className="flex-1 px-4 pb-28 pt-3 overflow-y-auto"><TennisStatsContent accent={accent} /></div>
        <BottomNav />
      </div>
    );
  }

  if (loading) return (
    <div className="flex flex-col min-h-screen bg-transparent text-white items-center justify-center max-w-[430px] mx-auto relative z-10">
      <div className="w-12 h-12 rounded-full bg-[#111a1f] border border-white/20 flex items-center justify-center"><div className="w-5 h-5 rounded-full bg-[#86d1ea]/20 border border-[#86d1ea]/40 animate-pulse" /></div>
      <p className="text-[#bfc8cc] text-sm mt-3">Loading NHL data...</p>
      <BottomNav />
    </div>
  );

  if (error) return (
    <div className="flex flex-col min-h-screen bg-transparent text-white items-center justify-center max-w-[430px] mx-auto relative z-10">
      <p className="text-red-400 text-sm">{error}</p><BottomNav />
    </div>
  );

  return (
    <div className="flex flex-col min-h-screen bg-transparent text-white max-w-[430px] mx-auto relative z-10">
      <header className="px-4 pt-12 pb-3 bg-[#0a1014]/80 backdrop-blur-md sticky top-0 z-40 border-b border-white/[0.04]">
        <div className="flex items-center justify-between mb-3">
          <div><h1 className="text-white text-xl font-bold" style={{ fontFamily: "'Merriweather', Georgia, serif" }}>Statistics</h1><p className="text-[#bfc8cc] text-xs">AI-powered predictions</p></div>
          <div className="border rounded-xl px-3 py-1.5 flex items-center gap-1.5" style={{ backgroundColor: `${accent}1a`, borderColor: `${accent}4d` }}>
            <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: accent }} />
            <span className="text-xs font-medium" style={{ color: accent }}>Live Data</span>
          </div>
        </div>
        <div className="bg-[#111a1f] border border-white/20 rounded-2xl flex items-center gap-2 px-3 py-2.5 mb-3">
          <Search size={14} className="text-[#8a9ea6] flex-shrink-0" />
          <input className="flex-1 bg-transparent text-white text-sm outline-none placeholder:text-[#bfc8cc]"
            placeholder="Search team, player, game..." value={search} onChange={(e) => setSearch(e.target.value)} />
          {search && <button onClick={() => setSearch("")} className="text-[#bfc8cc] text-xs">x</button>}
        </div>
        <div className="flex gap-1.5 overflow-x-auto scrollbar-hide pb-0.5">
          {filterTabs.map((tab, i) => (
            <button key={tab} onClick={() => setActiveFilter(i)} className="flex-shrink-0 px-4 py-2 rounded-full text-xs font-medium transition-all"
              style={activeFilter === i ? { backgroundColor: accent, color: "#0f1416", fontWeight: 700 } : { backgroundColor: "#1a2a2f", color: "#bfc8cc" }}>
              {tab}
            </button>
          ))}
        </div>
      </header>

      <div className="flex-1 px-4 pb-28 pt-3 overflow-y-auto">
        {activeFilter < 3 && (
          <div className="flex items-center justify-between mb-3">
            <span className="text-[#bfc8cc] text-xs">
              {activeFilter === 0 && `${filteredTeams.length} teams`}
              {activeFilter === 1 && `${filteredGames.length} games`}
              {activeFilter === 2 && `${filteredPlayers.length} players`}
            </span>
            <span className="text-xs" style={{ color: accent }}>Tap + to add to slip</span>
          </div>
        )}
        {activeFilter === 0 && (
          <div className="flex flex-col gap-2">
            {filteredTeams.length > 0 ? (
              filteredTeams.map((team) => (
                <TeamCard key={team.id} team={team} accent={accent}
                  onClick={() => navigate(`/stats/prediction/team/${team.id}`)}
                  onAdd={() => openAdd({ id: team.id, type: "team", name: team.name, logo: team.logo, subtitle: team.record })} />
              ))
            ) : (
              <div className="flex flex-col items-center justify-center py-12 gap-3">
                <div className="w-12 h-12 rounded-full bg-[#111a1f] border border-white/20 flex items-center justify-center"><div className="w-5 h-5 rounded-full bg-[#86d1ea]/20 border border-[#86d1ea]/40 animate-pulse" /></div>
                <p className="text-white text-sm font-medium">Loading team data...</p>
                <p className="text-[#bfc8cc] text-xs text-center">Make sure the backend is running at localhost:3001</p>
              </div>
            )}
          </div>
        )}
        {activeFilter === 1 && (
          <div className="flex flex-col gap-3">
            {filteredGames.length > 0 ? (
              <div className="flex flex-col gap-2">
                {filteredGames.map((game) => {
                  const t1 = getTeamById(game.team1Id); const t2 = getTeamById(game.team2Id);
                  if (!t1 || !t2) return null;
                  return <GameCard key={game.id} game={game} accent={accent} getTeamById={getTeamById}
                    onClick={() => navigate(`/stats/prediction/game/${game.id}`)}
                    onAdd={() => openAdd({ id: game.id, type: "game", name: `${t1.abbr} vs ${t2.abbr}`, logo: "🏒", subtitle: `${game.date} · ${game.time}` })} />;
                })}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 py-5">
                <div className="w-10 h-10 rounded-full bg-[#111a1f] border border-white/20 flex items-center justify-center"><div className="w-4 h-4 rounded-full bg-[#86d1ea]/20 border border-[#86d1ea]/40" /></div>
                <p className="text-white text-sm font-medium">No games scheduled today</p>
                <p className="text-[#bfc8cc] text-xs text-center">Check back on game nights, or explore season futures below</p>
              </div>
            )}
            <div>
              <p className="text-[#bfc8cc] text-xs mb-2 uppercase tracking-wider font-medium">Season Futures</p>
              <div className="flex flex-col gap-2">
                {futures.length > 0 ? (
                  [...futures]
                    .sort((a, b) => b.probability - a.probability)
                    .map((future) => (
                      <SeasonFutureCard key={future.id} future={future} accent={accent}
                        onNavigate={() => navigate(`/stats/prediction/future/${future.id}`)} />
                    ))
                ) : (
                  <p className="text-[#bfc8cc] text-xs text-center py-4">Loading standings data...</p>
                )}
              </div>
            </div>
          </div>
        )}
        {activeFilter === 2 && (
          <div className="flex flex-col gap-3">
            <div>
              <p className="text-[#bfc8cc] text-xs mb-2 uppercase tracking-wider font-medium">Player Props</p>
              <div className="flex flex-col gap-2">
                {players
                  .filter((p) => !search ||
                    p.name.toLowerCase().includes(search.toLowerCase()) ||
                    (getTeamById(p.teamId)?.abbr ?? "").toLowerCase().includes(search.toLowerCase()))
                  .sort((a, b) => b.points - a.points)
                  .slice(0, 20)
                  .flatMap((player) => {
                    const team = getTeamById(player.teamId);
                    const gp = Math.max(player.gamesPlayed, 1);
                    const props: any[] = [];
                    if (player.goals > 10) {
                      const goalPace = Math.round((player.goals / gp) * 82);
                      const goalLine = Math.max(player.goals + 2, Math.round(goalPace * 0.92));
                      const goalProb = player.goals / gp >= goalLine / 82 ? 65 : 45;
                      props.push({ id: `${player.id}-goals`, playerName: player.name,
                        country: "", team: team?.abbr ?? "", logo: team?.logo ?? teamEmoji(team?.abbr ?? ""),
                        propLabel: `${goalLine}+ Goals This Season`, propType: "goals",
                        line: goalLine, season: "2025-26", probability: goalProb,
                        oddsLabel: probToOdds(goalProb) });
                    }
                    if (player.points > 20) {
                      const ptsPace = Math.round((player.points / gp) * 82);
                      const ptsLine = Math.max(player.points + 3, Math.round(ptsPace * 0.92));
                      const ptsProb = player.points / gp >= ptsLine / 82 ? 62 : 42;
                      props.push({ id: `${player.id}-points`, playerName: player.name,
                        country: "", team: team?.abbr ?? "", logo: team?.logo ?? teamEmoji(team?.abbr ?? ""),
                        propLabel: `${ptsLine}+ Points This Season`, propType: "points",
                        line: ptsLine, season: "2025-26", probability: ptsProb,
                        oddsLabel: probToOdds(ptsProb) });
                    }
                    return props;
                  })
                  .map((prop) => (
                    <PlayerPropCard key={prop.id} prop={prop} accent={accent}
                      onNavigate={() => navigate(`/stats/prediction/player-prop/${prop.id}`)}
                    />
                  ))}
              </div>
            </div>
            {filteredPlayers.length > 0 && (
              <div className="mt-1">
                <p className="text-[#bfc8cc] text-xs mb-2 uppercase tracking-wider font-medium">Player Stats</p>
                <div className="flex flex-col gap-2">
                  {filteredPlayers.sort((a, b) => b.points - a.points).map((player) => {
                    const team = getTeamById(player.teamId);
                    if (!team) return null;
                    return <PlayerCard key={player.id} player={player} accent={accent} getTeamById={getTeamById}
                      onClick={() => navigate(`/stats/prediction/player/${player.id}`)}
                      onAdd={() => openAdd({ id: player.id, type: "player", name: player.name, logo: team.logo, subtitle: `${team.abbr} · #${player.number} · ${player.position}` })} />;
                  })}
                </div>
              </div>
            )}
          </div>
        )}
        {activeFilter === 3 && (
          <LastNGamesSection navigate={navigate} onAdd={openAdd} teams={teams} getTeamById={getTeamById} accent={accent} />
        )}
      </div>

      <BottomNav />

      {addSheet.open && (
        <MarketSelectorSheet onClose={() => setAddSheet({ open: false })} preselectedSubject={addSheet.subject} />
      )}
    </div>
  );
}
