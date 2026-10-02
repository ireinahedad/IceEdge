import { Search, HelpCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useNHLData, UITeam, UIGame } from "../hooks/useNHLData";
import { BottomNav } from "../components/BottomNav";
import { MarketSelectorSheet } from "../components/MarketSelectorSheet";
import { HowItWorksSheet } from "../components/HowItWorksSheet";
import { useSport } from "../context/SportContext";
import { PlayersTab } from "../components/PlayersTab";
import { ScheduleContent } from "./SchedulePage";
import { useI18n } from "../i18n";
import { ErrorState } from "../components/ErrorState";
import { teamColors } from "../data/teamEmoji";
import { dayHeading, groupByDay, weekdayShort } from "../data/gameDay";
import { CONFERENCES, DIVISIONS, conferenceLabelKey, divisionLabelKey, divisionOf } from "../data/nhlDivisions";
import "../components/rink-theme.css";
import { SlipCommandLauncher } from "../components/SlipCommandSheet";

// ─── Types ────────────────────────────────────────────────────────────────────

// « Par match » en premier, et ouvert par défaut (demande du user, 2026-09-29).
type Filter = "game" | "team" | "player";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "game",   label: "stats.byGame" },
  { key: "team",   label: "stats.byTeam" },
  { key: "player", label: "stats.byPlayer" },
];

/**
 * L'onglet ouvert (match / équipe / joueur) est gardé dans `sessionStorage`
 * (demande du user, 2026-10-02) : en revenant sur la page — bouton Retour
 * depuis une prédiction, barre du bas, onglet Statistiques — on retombe sur
 * le même onglet. `sessionStorage` lève dans un onglet privé verrouillé :
 * on retombe alors sur « Par match », sans erreur.
 */
const FILTER_KEY = "iceedge.stats.filter";
function readFilter(): Filter {
  try {
    const v = sessionStorage.getItem(FILTER_KEY);
    if (v === "game" || v === "team" || v === "player") return v;
  } catch { /* stockage indisponible */ }
  return "game";
}
function writeFilter(f: Filter) {
  try { sessionStorage.setItem(FILTER_KEY, f); } catch { /* stockage indisponible */ }
}

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
      className="tap-44 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold flex-shrink-0 transition-all active:scale-95"
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
  const { t, lang } = useI18n();
  const weekday = weekdayShort(game.gameDate, lang);
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
        <span className="text-[11px] font-medium uppercase tracking-wider" style={{ color: accent }}>{weekday ? `${weekday} ` : ""}{game.date} · {game.time}</span>
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

// ─── En-tête partagé Stats & prédiction ──────────────────────────────────────

/**
 * En-tête commun aux deux onglets de la section (2026-09-29) : le titre et le
 * commutateur à rondelle (`.puck-tabs`, le même que Coupon, League, Profil),
 * rien d'autre.
 *
 *   Prédiction    → /stats        (cette page)
 *   Statistiques  → /stats/chart  (accueil des graphiques, ChartPage)
 *
 * Les onglets sont deux ROUTES et non un état local : les liens existants vers
 * /stats/chart (fil d'Ariane et retour des graphiques) restent valides. Changer
 * d'onglet change donc de page ; pour que la rondelle GLISSE quand même,
 * l'onglet de départ voyage dans l'état de navigation (`hubFrom`) : le nouvel
 * en-tête se peint d'abord à cet index, puis passe au sien deux images plus
 * tard, et la transition CSS de `.puck-tabs-thumb` fait le reste.
 * `replace` : passer d'un onglet à l'autre n'empile pas l'historique.
 */
const HUB_TABS = [
  { key: "stats.tabPrediction", path: "/stats" },
  { key: "stats.statistics",    path: "/stats/chart" },
];

export function StatsHubHeader({ active }: { active: 0 | 1 }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { hubFrom?: number } | null)?.hubFrom;
  const [puck, setPuck] = useState<number>(from === 0 || from === 1 ? from : active);
  useEffect(() => {
    // Deux images : la première peint l'index de départ, la seconde lance la glisse.
    let second = 0;
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setPuck(active)); });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [active]);

  return (
    <header className="bg-[#0A0E0C]/80 backdrop-blur-md sticky top-0 z-40" style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}>
      <div className="px-4 pt-3 pb-2">
        <h1 className="text-white text-lg md:text-xl font-bold uppercase" style={{ fontFamily: "'Oswald', 'Arial Narrow', sans-serif" }}>{t("stats.title")}</h1>
      </div>
      <div
        className="puck-tabs mx-4 mb-3"
        style={{ "--puck-count": HUB_TABS.length, "--puck-index": puck } as React.CSSProperties}
      >
        <span className="puck-tabs-thumb" aria-hidden />
        {HUB_TABS.map((tab, i) => (
          <button
            key={tab.path}
            onClick={() => { if (i !== active) navigate(tab.path, { replace: true, state: { hubFrom: active } }); }}
            className={`puck-tab${active === i ? " is-active" : ""}`}
            aria-pressed={active === i}
          >
            {t(tab.key)}
          </button>
        ))}
      </div>
    </header>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function StatsPage() {
  const { theme } = useSport();
  const { t, lang } = useI18n();
  const accent = theme.accent;
  const [activeFilter, setActiveFilterState] = useState<Filter>(readFilter);
  const setActiveFilter = (f: Filter) => { setActiveFilterState(f); writeFilter(f); };
  const [search, setSearch] = useState("");
  const [addSheet, setAddSheet] = useState<AddSheetState>({ open: false });
  const [howItWorks, setHowItWorks] = useState(false);
  const navigate = useNavigate();

  function openAdd(subject: Subject) { setAddSheet({ open: true, subject }); }
  const renderTeamCard = (team: UITeam) => (
    <TeamCard key={team.id} team={team} accent={accent}
      onClick={() => navigate(`/stats/prediction/team/${team.id}`)}
      onAdd={() => openAdd({ id: team.id, type: "team", name: team.name, logo: team.logo, subtitle: team.record })} />
  );
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

  // L'en-tête partagé reste là pendant le chargement et en cas d'erreur :
  // l'onglet Statistiques doit rester joignable.
  const shell = "flex flex-col min-h-screen bg-transparent text-white max-w-[430px] md:max-w-5xl mx-auto relative z-10 w-full";

  if (loading) return (
    <div className={shell}>
      <StatsHubHeader active={0} />
      <div className="flex-1 flex flex-col items-center justify-center">
        <div className="w-12 h-12 rounded-full bg-[#131A12] border border-white/20 flex items-center justify-center">
          <div className="w-5 h-5 rounded-full bg-[#86d1ea]/20 border border-[#86d1ea]/40 animate-pulse" />
        </div>
        <p className="text-[#bfc8cc] text-sm mt-3">{t("stats.loadingNHL")}</p>
      </div>
      <BottomNav />
    </div>
  );

  // Le message du serveur (`error`) partait seul à l'écran, sans recours : il
  // sert maintenant de sous-titre sous un titre lisible et un bouton.
  if (error) return (
    <div className={shell}>
      <StatsHubHeader active={0} />
      <div className="flex-1 flex flex-col items-center justify-center">
        <ErrorState onRetry={reload} hint={error} />
      </div>
      <BottomNav />
    </div>
  );

  return (
    <div className={shell}>
      <StatsHubHeader active={0} />

      <div className="flex-1 px-4 pb-[calc(7rem+env(safe-area-inset-bottom,0px))] pt-3 overflow-y-auto">
        {/* Ce qui était dans l'en-tête collant de la page est descendu ici le
            2026-09-29 (demande du user) : il défile avec la page, donc les
            trois rondelles disparaissent quand on descend. Le bandeau
            « Statistiques » est parti — c'est maintenant l'onglet du haut. */}
        <div className="flex items-start justify-between gap-2 mb-3">
          <p className="text-[#bfc8cc] text-xs pt-2">{t("stats.subtitle")}</p>
          {/* « Bet builder IA » sous « Comment ça marche », même taille
              (demande du user, 2026-09-29) — il était un bandeau pleine
              largeur sous la recherche. */}
          <div className="flex flex-col items-stretch gap-1.5 shrink-0">
            <HowItWorksButton accent={accent} onClick={() => setHowItWorks(true)} />
            <SlipCommandLauncher variant="chip" />
          </div>
        </div>
        {/* Team / Game / Player as pucks. */}
        <div className="flex items-center justify-center gap-2 md:gap-2.5 mb-3">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setActiveFilter(f.key)}
              className={`rink-puck${activeFilter === f.key ? " is-active" : ""}`}
              aria-pressed={activeFilter === f.key}
            >
              <span className="rink-puck-label">{t(f.label)}</span>
            </button>
          ))}
        </div>
        <div className="bg-[#131A12] border border-white/20 rounded-2xl flex items-center gap-2 px-3 py-2 md:py-2.5 mb-3">
          <Search size={14} className="text-[#8a9ea6] flex-shrink-0" />
          <input className="flex-1 bg-transparent text-white text-sm outline-none placeholder:text-[#bfc8cc]"
            placeholder={t("stats.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
          {search && <button onClick={() => setSearch("")} className="tap-44 text-[#bfc8cc] text-xs">×</button>}
        </div>
        <div className="flex items-center mb-3">
          <span className="text-[#bfc8cc] text-xs">
            {activeFilter === "team" && `${filteredTeams.length} ${t("stats.teams")}`}
            {activeFilter === "game" && (
              <span className="flex items-center gap-2">
                <span>{t("stats.matches", { n: filteredGames.length })}</span>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#1B2419] text-[#bfc8cc]">{gamesLabel}</span>
              </span>
            )}
            {activeFilter === "player" && t("stats.players")}
          </span>
        </div>

        {/* ── By Team ── */}
        {activeFilter === "team" && (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
            {filteredTeams.length > 0 ? (
              /* Par conférence, puis par division (2026-09-25) : Est =
                 Atlantique + Métropolitaine, Ouest = Centrale + Pacifique.
                 Une recherche garde ce découpage et masque les groupes vides.
                 Un club absent de la table (data/nhlDivisions) tombe à la fin,
                 sans titre, plutôt que de disparaître. */
              <>
                {CONFERENCES.map((conf) => {
                  const divs = DIVISIONS.filter((d) => d.conference === conf)
                    .map((d) => ({ d, items: filteredTeams.filter((tm) => divisionOf(tm.abbr) === d.key) }))
                    .filter((x) => x.items.length > 0);
                  if (divs.length === 0) return null;
                  return (
                    <section key={conf} className="col-span-full flex flex-col gap-3 mb-2">
                      <h2 className="text-white text-sm font-bold uppercase tracking-wider" style={{ fontFamily: "'Oswald', 'Arial Narrow', sans-serif" }}>
                        {t(conferenceLabelKey(conf))}
                      </h2>
                      {divs.map(({ d, items }) => (
                        <div key={d.key} className="flex flex-col gap-2">
                          <h3 className="text-[11px] font-bold uppercase tracking-wider" style={{ color: accent }}>
                            {t(divisionLabelKey(d.key))}
                          </h3>
                          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
                            {items.map(renderTeamCard)}
                          </div>
                        </div>
                      ))}
                    </section>
                  );
                })}
                {filteredTeams.filter((tm) => !divisionOf(tm.abbr)).map(renderTeamCard)}
              </>
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
        {activeFilter === "game" && (
          <div className="flex flex-col gap-3">
            {filteredGames.length > 0 ? (
              /* Un titre par journée au-dessus de ses matchs (aujourd'hui,
                 demain…), comme sur l'accueil et le calendrier. */
              <div className="flex flex-col gap-4">
                {groupByDay(filteredGames, (g) => g.gameDate).map(({ day, items }) => (
                  <div key={day || "unknown"} className="flex flex-col gap-2">
                    {day && (
                      <h3 className="text-[#bfc8cc] text-[11px] font-bold uppercase tracking-wider">
                        {dayHeading(day, lang)}
                      </h3>
                    )}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      {items.map((game) => {
                        const t1 = getTeamById(game.team1Id); const t2 = getTeamById(game.team2Id);
                        if (!t1 || !t2) return null;
                        return <GameCard key={game.id} game={game} accent={accent} getTeamById={getTeamById}
                          onClick={() => navigate(`/stats/prediction/game/${game.id}`)} />;
                      })}
                    </div>
                  </div>
                ))}
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
        {activeFilter === "player" && (
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
