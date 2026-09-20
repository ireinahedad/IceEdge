import { Search, HelpCircle } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { useNHLData, UITeam, UIGame } from "../hooks/useNHLData";
import { BottomNav } from "../components/BottomNav";
import { MarketSelectorSheet } from "../components/MarketSelectorSheet";
import { HowItWorksSheet } from "../components/HowItWorksSheet";
import { useSport } from "../context/SportContext";
import { PlayersTab } from "../components/PlayersTab";
import { ScheduleContent } from "./SchedulePage";
import { FramedLabel } from "../components/brand/FramedLabel";
import { useI18n } from "../i18n";
import { ErrorState } from "../components/ErrorState";
import { teamColors } from "../data/teamEmoji";
import "../components/rink-theme.css";

// ─── Types ────────────────────────────────────────────────────────────────────

const filterTabKeys = ["stats.byTeam", "stats.byGame", "stats.byPlayer"];

type Subject = { id: string; type: "team" | "player" | "game"; name: string; logo: string; subtitle: string };
interface AddSheetState { open: boolean; subject?: Subject }

// ─── Team colours on cards ────────────────────────────────────────────────────
// The club's colours carry the card, but several clubs are light (NSH gold, VGK
// sand, BOS yellow) and the card text is white — so every colour layer sits
// under a scrim. The scrim is directional, not flat: it is heaviest where the
// text is and thinnest at the far edge, which keeps the colour readable as an
// identity while the type stays legible.

/** One club: colours running left → right, darkened under the text. */
function teamCardBackground(abbr: string): string {
  const { primary, secondary } = teamColors(abbr);
  return (
    `linear-gradient(90deg, rgba(0,0,0,0.70) 0%, rgba(0,0,0,0.46) 60%, rgba(0,0,0,0.14) 100%),` +
    `linear-gradient(120deg, ${primary}, ${secondary})`
  );
}

/** Two clubs: a diagonal split at the middle, seamed in white like a jersey. */
function gameCardBackground(abbr1: string, abbr2: string): string {
  const a = teamColors(abbr1);
  const b = teamColors(abbr2);
  return (
    `linear-gradient(180deg, rgba(0,0,0,0.58) 0%, rgba(0,0,0,0.32) 50%, rgba(0,0,0,0.62) 100%),` +
    `linear-gradient(100deg, ${a.primary} 0%, ${a.secondary} 45%,` +
    ` rgba(255,255,255,0.85) 49%, rgba(255,255,255,0.85) 51%,` +
    ` ${b.secondary} 55%, ${b.primary} 100%)`
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function HowItWorksButton({ onClick, accent }: { onClick: () => void; accent: string }) {
  const { lang } = useI18n();
  return (
    <button
      onClick={onClick}
      className="tap-44 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold flex-shrink-0 transition-all active:scale-95"
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
      className="tap-44 w-8 h-8 rounded-xl border flex items-center justify-center font-bold flex-shrink-0 transition-colors"
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
      className="w-full border border-white/20 rounded-2xl p-4 flex items-center gap-3 active:scale-[0.98] transition-transform text-left overflow-hidden"
      style={{ background: teamCardBackground(team.abbr) }}
    >
      <img src={team.logo} alt={team.name} className="w-11 h-11 object-contain flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-white text-sm font-medium truncate">{team.name}</p>
        <p className="text-[#bfc8cc] text-xs">{team.record} · {team.pts} pts</p>
        <div className="flex items-center gap-1.5 mt-1">
          <span className={`text-[11px] font-medium ${team.streak.startsWith("W") ? "text-green-400" : "text-red-400"}`}>{team.streak}</span>
          <span className="text-[#bfc8cc] text-[11px]">· {team.conf}ern</span>
        </div>
      </div>
      <div className="flex flex-col items-end gap-2 flex-shrink-0">
        <span className="text-[#bfc8cc] text-base">›</span>
        <AddButton onPress={onAdd} accent={accent} />
      </div>
    </button>
  );
}

function GameCard({ game, getTeamById, onClick, accent }: { game: UIGame; getTeamById: (id: string) => UITeam | undefined; onClick: () => void; accent: string }) {
  const { t } = useI18n();
  const team1 = getTeamById(game.team1Id);
  const team2 = getTeamById(game.team2Id);
  if (!team1 || !team2) return null;
  return (
    <button
      onClick={onClick}
      className="w-full border border-white/20 rounded-2xl p-4 active:scale-[0.98] transition-transform text-left overflow-hidden"
      style={{ background: gameCardBackground(team1.abbr, team2.abbr) }}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: accent }}>{game.date} · {game.time}</span>
        <span className="text-[#bfc8cc] text-[11px] bg-black/40 px-2 py-0.5 rounded-full">NHL</span>
      </div>
      <div className="flex items-center gap-2 mb-3">
        <div className="flex-1 flex items-center gap-2">
          <img src={team1.logo} alt={team1.abbr} className="w-7 h-7 object-contain" />
          <div>
            <p className="text-white text-sm font-medium">{team1.abbr}</p>
            <p className="text-[11px] text-white/75">{team1.record}</p>
          </div>
        </div>
        <div className="flex flex-col items-center px-2">
          <span className="text-[#bfc8cc] text-xs">vs</span>
          <span className="text-[#bfc8cc] text-[11px]">O/U {game.overUnder}</span>
        </div>
        <div className="flex-1 flex items-center gap-2 justify-end">
          <div className="text-right">
            <p className="text-white text-sm font-medium">{team2.abbr}</p>
            <p className="text-[11px] text-white/75">{team2.record}</p>
          </div>
          <img src={team2.logo} alt={team2.abbr} className="w-7 h-7 object-contain" />
        </div>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-white/70 text-[11px]">{game.venue ?? ""}</span>
        <span className="text-[#bfc8cc] text-[11px]" style={{ color: accent }}>{t("stats.viewBets")}</span>
      </div>
    </button>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function StatsPage() {
  const { theme } = useSport();
  const { t } = useI18n();
  const accent = theme.accent;
  const [activeFilter, setActiveFilter] = useState(0);
  const [search, setSearch] = useState("");
  const [addSheet, setAddSheet] = useState<AddSheetState>({ open: false });
  const [howItWorks, setHowItWorks] = useState(false);
  const navigate = useNavigate();

  function openAdd(subject: Subject) { setAddSheet({ open: true, subject }); }
  const { teams, games, gamesLabel, loading, error, reload, getTeamById } = useNHLData();

  const filteredTeams = teams.filter((t) =>
    !search || t.name.toLowerCase().includes(search.toLowerCase()) || t.abbr.toLowerCase().includes(search.toLowerCase())
  );
  const filteredGames = games.filter((g) => {
    if (!search) return true;
    const t1 = getTeamById(g.team1Id); const t2 = getTeamById(g.team2Id);
    if (!t1 || !t2) return false;
    return [t1.name, t2.name, t1.abbr, t2.abbr].some((s) => s.toLowerCase().includes(search.toLowerCase()));
  });

  if (loading) return (
    <div className="flex flex-col min-h-screen bg-transparent text-white items-center justify-center max-w-[430px] md:max-w-5xl mx-auto relative z-10 w-full">
      <div className="w-12 h-12 rounded-full bg-[#131A12] border border-white/20 flex items-center justify-center">
        <div className="w-5 h-5 rounded-full bg-[#86d1ea]/20 border border-[#86d1ea]/40 animate-pulse" />
      </div>
      <p className="text-[#bfc8cc] text-sm mt-3">{t("stats.loadingNHL")}</p>
      <BottomNav />
    </div>
  );

  // Le message du serveur (`error`) partait seul à l'écran, sans recours : il
  // sert maintenant de sous-titre sous un titre lisible et un bouton.
  if (error) return (
    <div className="flex flex-col min-h-screen bg-transparent text-white items-center justify-center max-w-[430px] md:max-w-5xl mx-auto relative z-10 w-full">
      <ErrorState onRetry={reload} hint={error} />
      <BottomNav />
    </div>
  );

  return (
    <div className="flex flex-col min-h-screen bg-transparent text-white max-w-[430px] md:max-w-5xl mx-auto relative z-10 w-full">
      {/* Header — the boards close the title block, then the controls sit below
          them, the way everything else on this app sits on the ice. */}
      <header className="bg-[#0A0E0C]/80 backdrop-blur-md sticky top-0 z-40" style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}>
        <div className="rink-boards" aria-hidden />
        {/* Les marges verticales de ce bloc sont resserrées sous `md` : l'en-tête
            est collant, donc tout ce qu'il prend, le contenu ne le récupère
            jamais au défilement. Sur grand écran elles reprennent leur valeur
            d'origine. Les tailles des rondelles et de la bannière, elles, sont
            dans rink-theme.css / FramedLabel.css. */}
        <div className="px-4 pt-3 pb-2 md:pb-3">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-white text-lg md:text-xl font-bold uppercase" style={{ fontFamily: "'Oswald', 'Arial Narrow', sans-serif" }}>{t("stats.title")}</h1>
              <p className="text-[#bfc8cc] text-xs">{t("stats.subtitle")}</p>
            </div>
            <HowItWorksButton accent={accent} onClick={() => setHowItWorks(true)} />
          </div>
        </div>
        <div className="px-4 pb-2 md:pb-3">
          {/* Team / Game / Player as pucks. */}
          <div className="flex items-center justify-center gap-2 md:gap-2.5 mb-2 md:mb-2.5">
            {filterTabKeys.map((tabKey, i) => (
              <button
                key={tabKey}
                onClick={() => setActiveFilter(i)}
                className={`rink-puck${activeFilter === i ? " is-active" : ""}`}
                aria-pressed={activeFilter === i}
              >
                <span className="rink-puck-label">{t(tabKey)}</span>
              </button>
            ))}
          </div>
          {/* L'entrée « Statistiques » : un bandeau pleine largeur sous les
              rondelles, plutôt qu'une pastille serrée à côté d'elles.
              Il menait droit à « toutes les équipes » ou « tous les joueurs »
              selon l'onglet ouvert ici ; depuis que la section a un accueil,
              il y mène — les trois entrées y sont côte à côte et expliquées,
              et c'est de là que part aussi l'espace d'un club. */}
          <FramedLabel
            className="framed-label--banner mb-2 md:mb-3"
            text={t("stats.statistics")}
            onClick={() => navigate("/stats/chart")}
          />
          <div className="bg-[#131A12] border border-white/20 rounded-2xl flex items-center gap-2 px-3 py-2 md:py-2.5">
            <Search size={14} className="text-[#8a9ea6] flex-shrink-0" />
            <input className="flex-1 bg-transparent text-white text-sm outline-none placeholder:text-[#bfc8cc]"
              placeholder={t("stats.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
            {search && <button onClick={() => setSearch("")} className="tap-44 text-[#bfc8cc] text-xs">×</button>}
          </div>
        </div>
      </header>

      <div className="flex-1 px-4 pb-[calc(7rem+env(safe-area-inset-bottom,0px))] pt-3 overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[#bfc8cc] text-xs">
            {activeFilter === 0 && `${filteredTeams.length} ${t("stats.teams")}`}
            {activeFilter === 1 && (
              <span className="flex items-center gap-2">
                <span>{t("stats.matches", { n: filteredGames.length })}</span>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#1B2419] text-[#bfc8cc]">{gamesLabel}</span>
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
                    onClick={() => navigate(`/stats/prediction/game/${game.id}`)} />;
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
              <p className="text-[#bfc8cc] text-xs mb-2 uppercase tracking-wider font-medium">{t("schedule.title")}</p>
              <ScheduleContent accent={accent} />
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
