import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { lastNGamesOptions } from "../data/hockeyData";
import { useNHLData, UITeam, UIGame, UIPlayer } from "../hooks/useNHLData";
import { BottomNav } from "./BottomNav";
import { MarketSelectorSheet } from "./MarketSelectorSheet";
import { nhlApiService } from "../services/nhlApiService";
import { predictionApiService } from "../services/predictionApiService";
import { NHLTeamStats } from "../types/bet";

const filterTabs = ["By Team", "By Game", "By Player", "By # Games"];

type Subject = { id: string; type: "team" | "player" | "game"; name: string; logo: string; subtitle: string };

interface AddSheetState { open: boolean; subject?: Subject }

function AddButton({ onPress }: { onPress: (e: React.MouseEvent) => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onPress(e); }}
      className="w-8 h-8 rounded-xl bg-[#86d1ea]/10 border border-[#86d1ea]/30 flex items-center justify-center text-[#86d1ea] font-bold flex-shrink-0 active:bg-[#86d1ea]/30 transition-colors"
    >
      +
    </button>
  );
}

function TeamCard({ team, onClick, onAdd }: { team: UITeam; onClick: () => void; onAdd: (e: React.MouseEvent) => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full bg-[#141c1f]/70 backdrop-blur-md border border-white/10 rounded-2xl p-4 flex items-center gap-3 active:scale-[0.98] transition-transform text-left"
    >
      <div className="w-11 h-11 rounded-xl bg-[#1e2d32] flex items-center justify-center text-2xl flex-shrink-0">
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
        <AddButton onPress={onAdd} />
      </div>
    </button>
  );
}

function GameCard({ game, getTeamById, onClick, onAdd }: { game: UIGame; getTeamById: (id: string) => UITeam | undefined; onClick: () => void; onAdd: (e: React.MouseEvent) => void }) {
  const team1 = getTeamById(game.team1Id);
  const team2 = getTeamById(game.team2Id);
  if (!team1 || !team2) return null;
  return (
    <button
      onClick={onClick}
      className="w-full bg-[#141c1f]/70 backdrop-blur-md border border-white/10 rounded-2xl p-4 active:scale-[0.98] transition-transform text-left"
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-[#86d1ea] text-[10px] font-medium uppercase tracking-wider">{game.date} · {game.time}</span>
        <div className="flex items-center gap-2">
          <span className="text-[#bfc8cc] text-[10px] bg-[#1e2d32] px-2 py-0.5 rounded-full">NHL</span>
          <AddButton onPress={onAdd} />
        </div>
      </div>
      <div className="flex items-center gap-2 mb-3">
        <div className="flex-1 flex items-center gap-2">
          <span className="text-xl">{team1.logo}</span>
          <div>
            <p className="text-white text-sm font-medium">{team1.abbr}</p>
            <p className="text-[#86d1ea] text-[10px] font-bold">{game.winPct1}% win</p>
          </div>
        </div>
        <div className="flex flex-col items-center px-2">
          <span className="text-[#bfc8cc] text-xs">vs</span>
          <span className="text-[#bfc8cc] text-[10px]">O/U {game.overUnder}</span>
        </div>
        <div className="flex-1 flex items-center gap-2 justify-end">
          <div className="text-right">
            <p className="text-white text-sm font-medium">{team2.abbr}</p>
            <p className="text-[#86d1ea] text-[10px] font-bold">{game.winPct2}% win</p>
          </div>
          <span className="text-xl">{team2.logo}</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[#86d1ea] text-[10px] font-bold w-7">{game.winPct1}%</span>
        <div className="flex-1 bg-[#0f1416] rounded-full h-1.5 overflow-hidden flex">
          <div className="h-full bg-[#86d1ea] rounded-l-full" style={{ width: `${game.winPct1}%` }} />
          <div className="h-full bg-[#1e2d32] flex-1" />
        </div>
        <span className="text-[#bfc8cc] text-[10px] font-bold w-7 text-right">{game.winPct2}%</span>
      </div>
      <p className="text-[#bfc8cc] text-[10px] text-center mt-1.5">{game.venue}</p>
    </button>
  );
}

function PlayerCard({ player, getTeamById, onClick, onAdd }: { player: UIPlayer; getTeamById: (id: string) => UITeam | undefined; onClick: () => void; onAdd: (e: React.MouseEvent) => void }) {
  const team = getTeamById(player.teamId);
  if (!team) return null;
  return (
    <button
      onClick={onClick}
      className="w-full bg-[#141c1f]/70 backdrop-blur-md border border-white/10 rounded-2xl p-4 flex items-center gap-3 active:scale-[0.98] transition-transform text-left"
    >
      <div className="w-11 h-11 rounded-xl bg-[#1e2d32] flex items-center justify-center text-2xl flex-shrink-0">
        {team.logo}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-white text-sm font-medium truncate">{player.name}</p>
        <p className="text-[#bfc8cc] text-xs">{team.abbr} · #{player.number} · {player.position}</p>
        <div className="flex items-center gap-3 mt-1">
          <span className="text-[#bfc8cc] text-[10px]">G: <span className="text-white">{player.goals}</span></span>
          <span className="text-[#bfc8cc] text-[10px]">A: <span className="text-white">{player.assists}</span></span>
          <span className="text-[#86d1ea] text-[10px] font-bold">PTS: {player.points}</span>
        </div>
        <div className="flex gap-1 mt-1.5">
          {player.lastFive.map((pts, i) => (
            <div key={i} className={`w-5 h-5 rounded text-[9px] flex items-center justify-center font-bold ${
              pts === 0 ? "bg-[#1e2d32] text-[#bfc8cc]" :
              pts >= 3 ? "bg-[#86d1ea]/30 text-[#86d1ea]" : "bg-[#1e2d32] text-white"
            }`}>{pts}</div>
          ))}
          <span className="text-[#bfc8cc] text-[9px] ml-1 self-center">last 5</span>
        </div>
      </div>
      <div className="flex flex-col items-end gap-2">
        <div className={`px-2.5 py-1 rounded-full text-xs font-bold ${
          player.winImpact >= 75 ? "bg-[#86d1ea]/20 text-[#86d1ea]" : "bg-yellow-500/20 text-yellow-400"
        }`}>{player.winImpact}%</div>
        <AddButton onPress={onAdd} />
      </div>
    </button>
  );
}

function LastNGamesSection({
  navigate,
  onAdd,
  teams,
  getTeamById,
}: {
  navigate: ReturnType<typeof useNavigate>;
  onAdd: (subject: Subject) => void;
  teams: UITeam[];
  getTeamById: (id: string) => UITeam | undefined;
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
          className="w-full bg-[#141c1f]/70 backdrop-blur-md border border-white/10rounded-2xl px-4 py-3 flex items-center justify-between"
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
          <span className="text-[#86d1ea]">{showPicker ? "▲" : "▼"}</span>
        </button>

        {showPicker && (
          <div className="mt-1 bg-[#141c1f] border border-[#1e2d32] rounded-2xl overflow-hidden">
            <div className="px-3 py-2 border-b border-[#1e2d32]">
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
                className={`w-full flex items-center gap-3 px-4 py-2.5 hover:bg-[#1e2d32] transition-colors ${
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
              const wins = stats?.wins ?? Math.round(n * (selectedTeamData.winPct / 100)); // fallback while loading
              const prob = nGamesPreds[n] ?? selectedTeamData.winPct;
              return (
                <div key={n} className="relative">
                  <button
                    onClick={() => navigate(`/stats/prediction/ngames/${selectedTeam}?n=${n}`)}
                    className="w-full bg-[#141c1f]/70 backdrop-blur-md border border-white/10 rounded-2xl p-4 flex flex-col items-center gap-1 active:scale-[0.98] transition-transform hover:border-[#86d1ea]/50"
                  >
                    <span className="text-white text-2xl font-bold">{n}</span>
                    <span className="text-[#bfc8cc] text-xs">Last {n} Games</span>
                    <div className="flex items-center gap-1 mt-1 flex-wrap justify-center">
                      {Array.from({ length: Math.min(n, 10) }).map((_, i) => (
                        <div key={i} className={`w-1.5 h-1.5 rounded-full ${i < Math.round(10 * (selectedTeamData.winPct / 100)) ? "bg-[#86d1ea]" : "bg-[#1e2d32]"}`} />
                      ))}
                    </div>
                    <span className="text-[#86d1ea] text-[10px] mt-0.5">
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
                    className="absolute top-2 right-2 w-7 h-7 rounded-lg bg-[#86d1ea]/10 border border-[#86d1ea]/30 flex items-center justify-center text-[#86d1ea] text-sm font-bold"
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

export function StatsPage() {
  const [activeFilter, setActiveFilter] = useState(0);
  const [search, setSearch] = useState("");
  const [addSheet, setAddSheet] = useState<AddSheetState>({ open: false });
  const navigate = useNavigate();
  const { teams, games, players, loading, error, getTeamById } = useNHLData();

  function openAdd(subject: Subject) {
    setAddSheet({ open: true, subject });
  }

  const filteredTeams = teams.filter((t) =>
    !search || t.name.toLowerCase().includes(search.toLowerCase()) || t.abbr.toLowerCase().includes(search.toLowerCase())
  );
  const filteredGames = games.filter((g) => {
    if (!search) return true;
    const t1 = getTeamById(g.team1Id);
    const t2 = getTeamById(g.team2Id);
    if (!t1 || !t2) return false;
    return [t1.name, t2.name, t1.abbr, t2.abbr].some((s) =>
      s.toLowerCase().includes(search.toLowerCase())
    );
  });
  const filteredPlayers = players.filter((p) =>
    !search || p.name.toLowerCase().includes(search.toLowerCase()) ||
    getTeamById(p.teamId)?.abbr.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) return (
    <div className="flex flex-col min-h-screen bg-transparent text-white items-center justify-center max-w-[430px] mx-auto relative z-10">
      <span className="text-5xl animate-pulse">🏒</span>
      <p className="text-[#bfc8cc] text-sm mt-3">Loading NHL data…</p>
      <BottomNav />
    </div>
  );

  if (error) return (
    <div className="flex flex-col min-h-screen bg-transparent text-white items-center justify-center max-w-[430px] mx-auto relative z-10">
      <p className="text-red-400 text-sm">{error}</p>
      <BottomNav />
    </div>
  );

  return (
    <div className="flex flex-col min-h-screen bg-transparent text-white max-w-[430px] mx-auto relative z-10">
      {/* Header */}
      <header className="px-4 pt-12 pb-3 bg-black/30 backdrop-blur-md sticky top-0 z-40 border-b border-white/5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-white text-xl font-bold">Statistics</h1>
            <p className="text-[#bfc8cc] text-xs">AI-powered predictions</p>
          </div>
          <div className="bg-[#86d1ea]/10 border border-[#86d1ea]/30 rounded-xl px-3 py-1.5 flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-[#86d1ea] animate-pulse" />
            <span className="text-[#86d1ea] text-xs font-medium">Live Data</span>
          </div>
        </div>

        {/* Search bar */}
        <div className="bg-[#141c1f] border border-[#1e2d32] rounded-2xl flex items-center gap-2 px-3 py-2.5 mb-3">
          <span className="text-[#bfc8cc] text-sm">🔍</span>
          <input
            className="flex-1 bg-transparent text-white text-sm outline-none placeholder:text-[#bfc8cc]"
            placeholder="Search team, player, game…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button onClick={() => setSearch("")} className="text-[#bfc8cc] text-xs">✕</button>
          )}
        </div>

        {/* Filter Tabs */}
        <div className="flex gap-1.5 overflow-x-auto scrollbar-hide pb-0.5">
          {filterTabs.map((tab, i) => (
            <button
              key={tab}
              onClick={() => setActiveFilter(i)}
              className={`flex-shrink-0 px-4 py-2 rounded-full text-xs font-medium transition-all ${
                activeFilter === i ? "bg-[#86d1ea] text-[#0f1416] font-bold" : "bg-[#1a2225] text-[#bfc8cc]"
              }`}
            >
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
            <span className="text-[#86d1ea] text-xs">Tap + to add to slip</span>
          </div>
        )}

        {/* By Team */}
        {activeFilter === 0 && (
          <div className="flex flex-col gap-2">
            {filteredTeams.map((team) => (
              <TeamCard
                key={team.id}
                team={team}
                onClick={() => navigate(`/stats/prediction/team/${team.id}`)}
                onAdd={() => openAdd({ id: team.id, type: "team", name: team.name, logo: team.logo, subtitle: team.record })}
              />
            ))}
          </div>
        )}

        {/* By Game */}
        {activeFilter === 1 && (
          <div className="flex flex-col gap-2">
            {filteredGames.map((game) => {
              const t1 = getTeamById(game.team1Id);
              const t2 = getTeamById(game.team2Id);
              if (!t1 || !t2) return null;
              return (
                <GameCard
                  key={game.id}
                  game={game}
                  getTeamById={getTeamById}
                  onClick={() => navigate(`/stats/prediction/game/${game.id}`)}
                  onAdd={() => openAdd({
                    id: game.id,
                    type: "game",
                    name: `${t1.abbr} vs ${t2.abbr}`,
                    logo: "🏒",
                    subtitle: `${game.date} · ${game.time}`,
                  })}
                />
              );
            })}
          </div>
        )}

        {/* By Player */}
        {activeFilter === 2 && (
          <div className="flex flex-col gap-2">
            {filteredPlayers
              .sort((a, b) => b.points - a.points)
              .map((player) => {
                const team = getTeamById(player.teamId);
                if (!team) return null;
                return (
                  <PlayerCard
                    key={player.id}
                    player={player}
                    getTeamById={getTeamById}
                    onClick={() => navigate(`/stats/prediction/player/${player.id}`)}
                    onAdd={() => openAdd({
                      id: player.id,
                      type: "player",
                      name: player.name,
                      logo: team.logo,
                      subtitle: `${team.abbr} · #${player.number} · ${player.position}`,
                    })}
                  />
                );
              })}
          </div>
        )}

        {/* By # Games */}
        {activeFilter === 3 && (
          <LastNGamesSection navigate={navigate} onAdd={openAdd} teams={teams} getTeamById={getTeamById} />
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
