import { Search, HelpCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useNHLData, UITeam, UIGame } from "../hooks/useNHLData";
import { BottomNav } from "./BottomNav";
import { MarketSelectorSheet } from "./MarketSelectorSheet";
import { HowItWorksSheet } from "./HowItWorksSheet";
import { nhlApiService } from "../services/nhlApiService";
import { useSport } from "../context/SportContext";
import { nhlLogoUrl, probToOdds } from "../data/teamEmoji";
import { TennisStatsContent } from "./TennisStatsPage";
import { PlayersTab } from "./PlayersTab";
import { LastNGamesSection } from "./LastNGamesSection";
import { useI18n } from "../i18n";

// ─── Types ────────────────────────────────────────────────────────────────────

const filterTabKeys = ["stats.byTeam", "stats.byGame", "stats.byPlayer"];

type Subject = { id: string; type: "team" | "player" | "game"; name: string; logo: string; subtitle: string };
interface AddSheetState { open: boolean; subject?: Subject }

interface LocalFuture {
  id: string; team: string; logo: string; propLabel: string;
  propType: string; probability: number; oddsLabel: string;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function HowItWorksButton({ onClick, accent }: { onClick: () => void; accent: string }) {
  const { lang } = useI18n();
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold flex-shrink-0 transition-all active:scale-95"
      style={{ color: accent, borderColor: `${accent}4d`, backgroundColor: `${accent}1a`, border: `1px solid ${accent}4d` }}
    >
      <HelpCircle size={13} />
      {lang === "fr" ? "Comment ça marche" : "How it works"}
    </button>
  );
}

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
      className="w-full bg-[#131A12]/70 backdrop-blur-md border border-white/20 rounded-2xl p-4 flex items-center gap-3 active:scale-[0.98] transition-transform text-left"
    >
      <img src={team.logo} alt={team.name} className="w-11 h-11 object-contain flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-white text-sm font-medium truncate">{team.name}</p>
        <p className="text-[#bfc8cc] text-xs">{team.record} · {team.pts} pts</p>
        <div className="flex items-center gap-1.5 mt-1">
          <span className={`text-[10px] font-medium ${team.streak.startsWith("W") ? "text-green-400" : "text-red-400"}`}>{team.streak}</span>
          <span className="text-[#bfc8cc] text-[10px]">· {team.conf}ern</span>
        </div>
      </div>
      <div className="flex flex-col items-end gap-2 flex-shrink-0">
        <span className="text-[#bfc8cc] text-base">›</span>
        <AddButton onPress={onAdd} accent={accent} />
      </div>
    </button>
  );
}

function GameCard({ game, getTeamById, onClick, onAdd, accent }: { game: UIGame; getTeamById: (id: string) => UITeam | undefined; onClick: () => void; onAdd: (e: React.MouseEvent) => void; accent: string }) {
  const { t } = useI18n();
  const team1 = getTeamById(game.team1Id);
  const team2 = getTeamById(game.team2Id);
  if (!team1 || !team2) return null;
  return (
    <button
      onClick={onClick}
      className="w-full bg-[#131A12]/70 backdrop-blur-md border border-white/20 rounded-2xl p-4 active:scale-[0.98] transition-transform text-left"
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-medium uppercase tracking-wider" style={{ color: accent }}>{game.date} · {game.time}</span>
        <div className="flex items-center gap-2">
          <span className="text-[#bfc8cc] text-[10px] bg-[#1B2419] px-2 py-0.5 rounded-full">NHL</span>
          <AddButton onPress={onAdd} accent={accent} />
        </div>
      </div>
      <div className="flex items-center gap-2 mb-3">
        <div className="flex-1 flex items-center gap-2">
          <img src={team1.logo} alt={team1.abbr} className="w-7 h-7 object-contain" />
          <div>
            <p className="text-white text-sm font-medium">{team1.abbr}</p>
            <p className="text-[10px] text-[#8a9ea6]">{team1.record}</p>
          </div>
        </div>
        <div className="flex flex-col items-center px-2">
          <span className="text-[#bfc8cc] text-xs">vs</span>
          <span className="text-[#bfc8cc] text-[10px]">O/U {game.overUnder}</span>
        </div>
        <div className="flex-1 flex items-center gap-2 justify-end">
          <div className="text-right">
            <p className="text-white text-sm font-medium">{team2.abbr}</p>
            <p className="text-[10px] text-[#8a9ea6]">{team2.record}</p>
          </div>
          <img src={team2.logo} alt={team2.abbr} className="w-7 h-7 object-contain" />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[#8a9ea6] text-[10px]">{game.venue ?? ""}</span>
        <span className="text-[#bfc8cc] text-[10px]" style={{ color: accent }}>{t("stats.viewBets")}</span>
      </div>
    </button>
  );
}

function SeasonFutureCard({ future, accent, onNavigate }: { future: LocalFuture; accent: string; onNavigate: () => void }) {
  const { t } = useI18n();
  const isHigh = future.probability >= 20;
  return (
    <button
      onClick={onNavigate}
      className="w-full bg-[#131A12]/70 backdrop-blur-md border border-white/20 rounded-2xl p-4 active:scale-[0.98] transition-transform text-left"
    >
      <div className="flex items-center gap-3 mb-2">
        <img src={future.logo} alt={future.team} className="w-10 h-10 object-contain flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="text-[9px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400">
              {future.propType === "cup" ? t("stats.stanleyCup") : future.propType === "conf" ? t("stats.conference") : t("stats.futuresTag")}
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
      <div className="w-full bg-[#0A0E0C] rounded-full h-1.5">
        <div className="h-1.5 rounded-full" style={{ width: `${future.probability}%`, backgroundColor: accent }} />
      </div>
    </button>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function StatsPage() {
  const { sport, theme } = useSport();
  const { t } = useI18n();
  const accent = theme.accent;
  const [activeFilter, setActiveFilter] = useState(0);
  const [search, setSearch] = useState("");
  const [addSheet, setAddSheet] = useState<AddSheetState>({ open: false });
  const [howItWorks, setHowItWorks] = useState(false);
  const navigate = useNavigate();

  function openAdd(subject: Subject) { setAddSheet({ open: true, subject }); }
  const { teams, games, gamesLabel, loading, error, getTeamById } = useNHLData();
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
            logo: nhlLogoUrl(abbr),
            propLabel: t("stats.winCup"),
            propType: "cup",
            probability: Math.max(5, Math.min(60, prob)),
            oddsLabel: probToOdds(Math.max(5, Math.min(60, prob))),
          };
        }));
      })
      .catch(() => { setFutures([]); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  const filteredTeams = teams.filter((t) =>
    !search || t.name.toLowerCase().includes(search.toLowerCase()) || t.abbr.toLowerCase().includes(search.toLowerCase())
  );
  const filteredGames = games.filter((g) => {
    if (!search) return true;
    const t1 = getTeamById(g.team1Id); const t2 = getTeamById(g.team2Id);
    if (!t1 || !t2) return false;
    return [t1.name, t2.name, t1.abbr, t2.abbr].some((s) => s.toLowerCase().includes(search.toLowerCase()));
  });

  if (sport === "tennis") {
    return (
      <div className="flex flex-col min-h-screen bg-transparent text-white max-w-[430px] md:max-w-5xl mx-auto relative z-10 w-full">
        <header className="px-4 pt-12 pb-3 bg-[#0A0E0C]/80 backdrop-blur-md sticky top-0 z-40 border-b border-white/[0.04]">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h1 className="text-white text-xl font-bold" style={{ fontFamily: "'Merriweather', Georgia, serif" }}>{t("stats.title")}</h1>
              <p className="text-[#bfc8cc] text-xs">{t("stats.tennis")}</p>
            </div>
            <HowItWorksButton accent={accent} onClick={() => setHowItWorks(true)} />
          </div>
        </header>
        <div className="flex-1 px-4 pb-28 pt-3 overflow-y-auto">
          <TennisStatsContent accent={accent} />
        </div>
        {howItWorks && <HowItWorksSheet onClose={() => setHowItWorks(false)} />}
        <BottomNav />
      </div>
    );
  }

  if (loading) return (
    <div className="flex flex-col min-h-screen bg-transparent text-white items-center justify-center max-w-[430px] md:max-w-5xl mx-auto relative z-10 w-full">
      <div className="w-12 h-12 rounded-full bg-[#131A12] border border-white/20 flex items-center justify-center">
        <div className="w-5 h-5 rounded-full bg-[#86d1ea]/20 border border-[#86d1ea]/40 animate-pulse" />
      </div>
      <p className="text-[#bfc8cc] text-sm mt-3">{t("stats.loadingNHL")}</p>
      <BottomNav />
    </div>
  );

  if (error) return (
    <div className="flex flex-col min-h-screen bg-transparent text-white items-center justify-center max-w-[430px] md:max-w-5xl mx-auto relative z-10 w-full">
      <p className="text-red-400 text-sm">{error}</p>
      <BottomNav />
    </div>
  );

  return (
    <div className="flex flex-col min-h-screen bg-transparent text-white max-w-[430px] md:max-w-5xl mx-auto relative z-10 w-full">
      <header className="px-4 pt-12 pb-3 bg-[#0A0E0C]/80 backdrop-blur-md sticky top-0 z-40 border-b border-white/[0.04]">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-white text-xl font-bold" style={{ fontFamily: "'Merriweather', Georgia, serif" }}>{t("stats.title")}</h1>
            <p className="text-[#bfc8cc] text-xs">{t("stats.subtitle")}</p>
          </div>
          <HowItWorksButton accent={accent} onClick={() => setHowItWorks(true)} />
        </div>
        <div className="bg-[#131A12] border border-white/20 rounded-2xl flex items-center gap-2 px-3 py-2.5 mb-3">
          <Search size={14} className="text-[#8a9ea6] flex-shrink-0" />
          <input className="flex-1 bg-transparent text-white text-sm outline-none placeholder:text-[#bfc8cc]"
            placeholder={t("stats.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
          {search && <button onClick={() => setSearch("")} className="text-[#bfc8cc] text-xs">×</button>}
        </div>
        <div className="flex gap-1.5 overflow-x-auto scrollbar-hide pb-0.5">
          {filterTabKeys.map((tabKey, i) => (
            <button key={tabKey} onClick={() => setActiveFilter(i)} className="flex-shrink-0 px-4 py-2 rounded-full text-xs font-medium transition-all"
              style={activeFilter === i ? { backgroundColor: accent, color: "#0f1416", fontWeight: 700 } : { backgroundColor: "#1B2419", color: "#bfc8cc" }}>
              {t(tabKey)}
            </button>
          ))}
        </div>
      </header>

      <div className="flex-1 px-4 pb-28 pt-3 overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[#bfc8cc] text-xs">
            {activeFilter === 0 && `${filteredTeams.length} ${t("stats.teams")}`}
            {activeFilter === 1 && (
              <span className="flex items-center gap-2">
                <span>{t("stats.matches", { n: filteredGames.length })}</span>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#1B2419] text-[#bfc8cc]">{gamesLabel}</span>
              </span>
            )}
            {activeFilter === 2 && t("stats.players")}
          </span>
          {activeFilter < 2 && (
            <span className="text-xs" style={{ color: accent }}>{t("stats.tapToAdd")}</span>
          )}
        </div>

        {/* ── By Team ── */}
        {activeFilter === 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
            {filteredTeams.length > 0 ? (
              filteredTeams.map((team) => (
                <TeamCard key={team.id} team={team} accent={accent}
                  onClick={() => navigate(`/stats/prediction/team/${team.id}`)}
                  onAdd={() => openAdd({ id: team.id, type: "team", name: team.name, logo: team.logo, subtitle: team.record })} />
              ))
            ) : (
              <div className="col-span-full flex flex-col items-center justify-center py-12 gap-3">
                <div className="w-12 h-12 rounded-full bg-[#131A12] border border-white/20 flex items-center justify-center">
                  <div className="w-5 h-5 rounded-full bg-[#86d1ea]/20 border border-[#86d1ea]/40 animate-pulse" />
                </div>
                <p className="text-white text-sm font-medium">{t("stats.loadingTeams")}</p>
                <p className="text-[#bfc8cc] text-xs text-center">{t("stats.loadingTeamsHint")}</p>
              </div>
            )}
          </div>
        )}

        {/* ── By Game ── */}
        {activeFilter === 1 && (
          <div className="flex flex-col gap-3">
            {filteredGames.length > 0 ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {filteredGames.map((game) => {
                  const t1 = getTeamById(game.team1Id); const t2 = getTeamById(game.team2Id);
                  if (!t1 || !t2) return null;
                  return <GameCard key={game.id} game={game} accent={accent} getTeamById={getTeamById}
                    onClick={() => navigate(`/stats/prediction/game/${game.id}`)}
                    onAdd={() => openAdd({ id: game.id, type: "game", name: `${t1.abbr} vs ${t2.abbr}`, logo: "", subtitle: `${game.date} · ${game.time}` })} />;
                })}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 py-5">
                <div className="w-10 h-10 rounded-full bg-[#131A12] border border-white/20 flex items-center justify-center">
                  <div className="w-4 h-4 rounded-full bg-[#86d1ea]/20 border border-[#86d1ea]/40" />
                </div>
                <p className="text-white text-sm font-medium">{t("stats.noGames")}</p>
                <p className="text-[#bfc8cc] text-xs text-center">{t("stats.noGamesHint")}</p>
              </div>
            )}

            <div>
              <p className="text-[#bfc8cc] text-xs mb-2 uppercase tracking-wider font-medium">{t("stats.futures")}</p>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
                {futures.length > 0 ? (
                  [...futures]
                    .sort((a, b) => b.probability - a.probability)
                    .map((future) => (
                      <SeasonFutureCard key={future.id} future={future} accent={accent}
                        onNavigate={() => navigate(`/stats/prediction/future/${future.id}`)} />
                    ))
                ) : (
                  <p className="text-[#bfc8cc] text-xs text-center py-4">{t("stats.loadingStandings")}</p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── By Player ── */}
        {activeFilter === 2 && (
          <PlayersTab teams={teams} accent={accent} />
        )}

      </div>

      <BottomNav />

      {addSheet.open && (
        <MarketSelectorSheet onClose={() => setAddSheet({ open: false })} preselectedSubject={addSheet.subject} />
      )}

      {howItWorks && <HowItWorksSheet onClose={() => setHowItWorks(false)} />}
    </div>
  );
}
