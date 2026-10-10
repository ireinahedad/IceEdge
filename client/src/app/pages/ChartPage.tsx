/**
 * ChartPage.tsx — coquille de la page Charts.
 *
 * Ce fichier faisait 3106 lignes ; il a été découpé le 2026-08-10 en 11 fichiers
 * (`./charts/`) sans toucher une ligne de code — seuls les imports et les
 * `export` ont été ajoutés. Il ne reste ici que la navigation et l'aiguillage
 * vers la section demandée.
 *
 *   chartsTheme.ts      palette, types de tri, formateurs de valeurs
 *   chartsMetrics.ts    modèle de métrique + jeux de métriques joueur
 *   ChartControls.tsx   sélecteur d'adversaire, en-têtes triables, recherche
 *   ChartVisuals.tsx    courbes, barres empilées, camemberts, tables d'équipe
 *   ChartsHome.tsx      accueil de la section (les trois entrées)
 *   teamSpace.tsx       navigation à l'intérieur d'un club
 *   TeamCharts · PlayerCharts · GameCharts                  vues unitaires
 *   AllTeamsCharts · AllPlayersCharts · AllGamesCharts      vues ligue
 *   CompareCharts       joueur contre joueur, équipe contre équipe (2026-09-29)
 *
 * `ChartPage` reste le seul export public : trois routes y mènent
 * (`/stats/chart`, `/stats/chart/:type/:id?`, `/stats/chart/team/:id/:section`).
 *
 * ── Deux niveaux de navigation ──────────────────────────────
 * La section se lit sur deux étages, et les trois mêmes boutons servent aux
 * deux — c'est voulu, le geste est le même :
 *
 *   ligue   accueil → toutes les équipes / tous les matchs / tous les joueurs
 *           pastilles à l'ACCENT DE L'APPLICATION
 *   club    un club → ses matchs / ses joueurs
 *           pastilles à la COULEUR DU CLUB (voir charts/teamSpace.tsx)
 *
 * La couleur est le seul signal qui distingue les deux barres. Le fil d'Ariane
 * plus bas monte d'un cran à la fois — joueur du club → club → toutes les
 * équipes → accueil — pour qu'on puisse toujours remonter sans la flèche.
 */

import { useParams, useNavigate, useLocation, useSearchParams } from "react-router";
import { ChevronLeft } from "lucide-react";
import { BottomNav } from "../components/BottomNav";
import { FramedLabel } from "../components/brand/FramedLabel";
import { useSport } from "../context/SportContext";
import { useI18n } from "../i18n";
import { teamAccent } from "../data/teamEmoji";
import { AllGamesCharts } from "./charts/AllGamesCharts";
import { AllPlayersCharts } from "./charts/AllPlayersCharts";
import { AllTeamsCharts } from "./charts/AllTeamsCharts";
import { ChartsHome } from "./charts/ChartsHome";
import { ComparePlayersCharts, CompareTeamsCharts } from "./charts/CompareCharts";
import { GameCharts } from "./charts/GameCharts";
import { PlayerCharts } from "./charts/PlayerCharts";
import { TeamCharts } from "./charts/TeamCharts";
import { TeamSpaceIdentity, TeamSpaceNav, teamSectionPath, toTeamSection, useTeamName } from "./charts/teamSpace";
import { BG_HEADER, BG_PAGE } from "./charts/chartsTheme";
import { StatsHubHeader } from "./StatsPage";
import "../components/rink-theme.css";
import "./charts/charts-tables.css";

/* ── Section nav (Team / Game / Player) ────────────────────
 * Flat pills, deliberately plainer than the animated FramedLabel title so the
 * two don't compete. Each lands on that section's league-wide overview.
 *
 * Sur l'accueil (`type` absent) aucune n'est active : on n'est encore dans
 * aucune des trois, et les mêmes trois entrées occupent le corps de la page.
 */
function ChartNav({ type }: { type?: string }) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { theme } = useSport();
  const accent = theme.accent;

  const items = [
    { key: "team",   label: t("chart.team"),   to: "/stats/chart/all-teams",   match: ["team", "all-teams"] },
    { key: "game",   label: t("chart.game"),   to: "/stats/chart/all-games",   match: ["game", "all-games"] },
    { key: "player", label: t("chart.player"), to: "/stats/chart/all-players", match: ["player", "all-players"] },
  ];

  return (
    <nav className="flex items-center gap-1 ml-auto shrink-0">
      {items.map((it) => {
        const active = it.match.includes(type ?? "");
        return (
          <button
            key={it.key}
            onClick={() => navigate(it.to)}
            aria-current={active ? "page" : undefined}
            className="px-2.5 py-1 rounded-md text-[11px] font-bold uppercase tracking-wider transition-colors"
            style={
              active
                ? { background: accent, color: "#0A0E0C" }
                : { background: "rgba(255,255,255,0.06)", color: "#8a9ea6" }
            }
          >
            {it.label}
          </button>
        );
      })}
    </nav>
  );
}

/* ── Charts page shell ─────────────────────────────────────
 * Mirrors the prediction page layout on the lighter Charts palette, with the
 * framed STATISTICS label reused as the page title.
 */
export function ChartPage() {
  const { type, id, section: sectionParam } = useParams<{ type: string; id: string; section: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useI18n();

  // L'espace d'un club : `/stats/chart/team/mtl` et ses deux sous-sections.
  // `/stats/chart/team` tout court (sélecteur vide) n'en est PAS un — il n'y a
  // pas encore de club dont porter les couleurs.
  const inTeamSpace = type === "team" && !!id;
  const section = toTeamSection(sectionParam);
  const teamName = useTeamName(inTeamSpace ? id : undefined);

  // Un match ou un joueur ouvert DEPUIS un club garde le chemin du retour dans
  // l'état de navigation : l'URL d'un match est la même partout
  // (`/stats/chart/game/:id`), elle ne peut donc pas dire d'où l'on vient.
  const fromTeam = (location.state as { fromTeam?: string } | null)?.fromTeam;

  // La flèche revient d'où l'on vient — la page prédiction d'un joueur, celle
  // d'un match, Stats… Elle renvoyait toujours sur /stats jusqu'au 2026-09-04,
  // par crainte des graphiques qui se lient entre eux ; c'est le fil d'Ariane
  // ci-dessous (`parent`) qui règle ce cas, pas la flèche.
  // `location.key` vaut "default" quand cette page est la PREMIÈRE entrée de
  // l'historique (lien partagé, rechargement) : là il n'y a rien derrière, on
  // retombe sur l'accueil de la section — ou sur Stats si on y est déjà.
  const goBack = () =>
    location.key === "default"
      ? navigate(type ? "/stats/chart" : "/stats")
      : navigate(-1);

  // On a detail view, step up to that section's overview. The arrow beside the
  // title leaves the charts section entirely; this one navigates within it.
  // Un seul cran à la fois : joueur d'un club → club → toutes les équipes →
  // accueil. Chaque niveau sait remonter au suivant, jamais sauter deux.
  const parent =
    !type ? null :
    inTeamSpace && section !== "overview"
      ? { to: teamSectionPath(id, "overview"), label: teamName } :
    type === "team"   ? { to: "/stats/chart/all-teams",   label: t("chart.allTeams") } :
    type === "player" ? (fromTeam
      ? { to: teamSectionPath(fromTeam, "players"), label: t("chart.teamSpace.players", { team: fromTeam.toUpperCase() }) }
      : { to: "/stats/chart/all-players", label: t("chart.allPlayers") }) :
    type === "game"   ? (fromTeam
      ? { to: teamSectionPath(fromTeam, "games"), label: t("chart.teamSpace.games", { team: fromTeam.toUpperCase() }) }
      : { to: "/stats/chart/all-games", label: t("chart.gm.allGames") }) :
    { to: "/stats/chart", label: t("chart.home") };

  const content =
    !type ? (
      <ChartsHome />
    ) : type === "all-players" ? (
      <AllPlayersCharts />
    ) : type === "all-teams" ? (
      <AllTeamsCharts />
    ) : type === "all-games" ? (
      <AllGamesCharts />
    ) : type === "compare-players" ? (
      <ComparePlayersCharts />
    ) : type === "compare-teams" ? (
      <CompareTeamsCharts />
    ) : type === "game" ? (
      <GameCharts gameId={id} />
    ) : type === "player" ? (
      <PlayerCharts initialPlayerId={id} />
    ) : type === "team" ? (
      inTeamSpace && section === "games" ? (
        <AllGamesCharts teamSpace={id} />
      ) : inTeamSpace && section === "players" ? (
        // Le joueur regardé vit dans la query string plutôt que dans le chemin :
        // l'URL doit rester celle du CLUB pour que sa barre garde ses couleurs
        // et que le retour remonte chez lui, pas vers « tous les joueurs ».
        <PlayerCharts teamSpace={id} initialPlayerId={searchParams.get("player") ?? undefined} />
      ) : (
        <TeamCharts teamId={id} />
      )
    ) : (
      <div className="py-24 text-center">
        <p className="text-[#8a9ea6] text-sm">{t("chart.noData")}</p>
      </div>
    );

  return (
    <div className="flex flex-col min-h-screen pb-[calc(6rem+env(safe-area-inset-bottom,0px))] max-w-[430px] md:max-w-5xl mx-auto w-full" style={{ background: BG_PAGE }}>
      {/* L'accueil de la section (`/stats/chart`) est l'onglet « Statistiques »
          de Stats & prédiction (2026-09-29) : même en-tête que /stats, titre et
          rondelle seulement. Les vues de détail gardent l'en-tête ci-dessous. */}
      {!type ? <StatsHubHeader active={1} /> : (
      <div
        className="sticky top-0 z-40"
        style={{
          background: BG_HEADER,
          backdropFilter: "blur(16px)",
          paddingTop: "env(safe-area-inset-top, 0px)",
          // Le liseré du club ferme l'en-tête : visible même quand le fil
          // d'Ariane est défilé hors de vue.
          borderBottom: inTeamSpace ? `2px solid ${teamAccent(id)}` : undefined,
        }}
      >
        <div className="px-4 pt-3 pb-3">
        {/* Rangée 1 (2026-09-25) — deux boutons DISTINCTS, qui ne font pas la
            même chose :
              ‹  Retour        la page d'avant, d'où qu'on vienne (goBack) ;
              STATISTIQUES     l'accueil de la section, toujours (/stats/chart).
            Ils étaient collés l'un à l'autre et la flèche, minuscule, portait
            l'étiquette « Statistiques » : on ne savait pas lequel faisait quoi.
            Le titre est centré par une grille 1fr · auto · 1fr — la colonne de
            droite (identité du club, ou vide) équilibre celle de la flèche. */}
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <div className="flex justify-start">
            <button
              onClick={goBack}
              className="w-11 h-11 rounded-xl border border-white/15 bg-white/[0.06] text-white flex items-center justify-center active:scale-95 transition-transform"
              aria-label={t("common.back")}
              title={t("common.back")}
            >
              <ChevronLeft size={24} strokeWidth={2.5} />
            </button>
          </div>
          <FramedLabel
            text={t("chart.title")}
            onClick={() => navigate("/stats/chart")}
            ariaLabel={t("chart.home")}
          />
          <div className="flex justify-end min-w-0">
            {inTeamSpace && <TeamSpaceIdentity abbr={id} />}
          </div>
        </div>

        {/* Rangée 2 — le fil d'Ariane (un cran vers le haut) et les pastilles
            Équipe · Match · Joueur, sorties de la rangée du titre pour lui
            laisser le centre. */}
        <div className="mt-2 flex items-center justify-between gap-2">
          {parent ? (
            <button
              onClick={() => navigate(parent.to)}
              className="flex items-center gap-1.5 text-[11px] font-semibold text-[#8a9ea6] hover:text-white transition-colors min-w-0"
            >
              <span className="text-sm leading-none shrink-0">←</span>
              <span className="truncate">{parent.label}</span>
            </button>
          ) : <span />}
          {inTeamSpace ? <TeamSpaceNav abbr={id} section={section} /> : <ChartNav type={type} />}
        </div>
        </div>
      </div>
      )}

      <div className="chart-tables flex-1 overflow-y-auto px-4 py-4">{content}</div>

      <BottomNav />
    </div>
  );
}
