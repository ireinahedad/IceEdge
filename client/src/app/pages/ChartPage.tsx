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
 *   TeamCharts · PlayerCharts · GameCharts                  vues unitaires
 *   AllTeamsCharts · AllPlayersCharts · AllGamesCharts      vues ligue
 *
 * `ChartPage` reste le seul export public : `routes.tsx` est inchangé.
 */

import { useParams, useNavigate, useLocation } from "react-router";
import { BottomNav } from "../components/BottomNav";
import { FramedLabel } from "../components/brand/FramedLabel";
import { useSport } from "../context/SportContext";
import { useI18n } from "../i18n";
import { AllGamesCharts } from "./charts/AllGamesCharts";
import { AllPlayersCharts } from "./charts/AllPlayersCharts";
import { AllTeamsCharts } from "./charts/AllTeamsCharts";
import { GameCharts } from "./charts/GameCharts";
import { PlayerCharts } from "./charts/PlayerCharts";
import { TeamCharts } from "./charts/TeamCharts";
import { BG_HEADER, BG_PAGE } from "./charts/chartsTheme";
import "../components/rink-theme.css";

/* ── Section nav (Team / Game / Player) ────────────────────
 * Flat pills, deliberately plainer than the animated FramedLabel title so the
 * two don't compete. Each lands on that section's league-wide overview.
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
            className="px-2.5 py-1 rounded-md text-[10px] font-bold uppercase tracking-wider transition-colors"
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
  const { type, id } = useParams<{ type: string; id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useI18n();

  // La flèche revient d'où l'on vient — la page prédiction d'un joueur, celle
  // d'un match, Stats… Elle renvoyait toujours sur /stats jusqu'au 2026-09-04,
  // par crainte des graphiques qui se lient entre eux ; c'est le fil d'Ariane
  // ci-dessous (`parent`) qui règle ce cas, pas la flèche.
  // `location.key` vaut "default" quand cette page est la PREMIÈRE entrée de
  // l'historique (lien partagé, rechargement) : là il n'y a rien derrière, on
  // retombe sur Stats plutôt que de sortir du site.
  const goBack = () => (location.key === "default" ? navigate("/stats") : navigate(-1));

  // On a detail view, step up to that section's overview. The arrow beside the
  // title leaves the charts section entirely; this one navigates within it.
  const parent =
    type === "team"   ? { to: "/stats/chart/all-teams",   label: t("chart.allTeams") } :
    type === "player" ? { to: "/stats/chart/all-players", label: t("chart.allPlayers") } :
    type === "game"   ? { to: "/stats/chart/all-games",   label: t("chart.gm.allGames") } :
    null;

  const content =
    type === "all-players" ? (
      <AllPlayersCharts />
    ) : type === "all-teams" ? (
      <AllTeamsCharts />
    ) : type === "all-games" ? (
      <AllGamesCharts />
    ) : type === "game" ? (
      <GameCharts gameId={id} />
    ) : type === "player" ? (
      <PlayerCharts initialPlayerId={id} />
    ) : type === "team" || !type ? (
      <TeamCharts teamId={id} />
    ) : (
      <div className="py-24 text-center">
        <p className="text-[#8a9ea6] text-sm">{t("chart.noData")}</p>
      </div>
    );

  return (
    <div className="flex flex-col min-h-screen pb-24 max-w-[430px] md:max-w-5xl mx-auto w-full" style={{ background: BG_PAGE }}>
      <div
        className="sticky top-0 z-40"
        style={{ background: BG_HEADER, backdropFilter: "blur(16px)", paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <div className="rink-boards" aria-hidden />
        <div className="px-4 pt-3 pb-3">
        <div className="flex items-center gap-2">
          <button onClick={goBack} className="text-[#3a5060] text-lg shrink-0" aria-label={t("stats.title")}>
            ←
          </button>
          <FramedLabel text={t("chart.title")} />
          <ChartNav type={type} />
        </div>

        {parent && (
          <button
            onClick={() => navigate(parent.to)}
            className="mt-2 flex items-center gap-1.5 text-[11px] font-semibold text-[#8a9ea6] hover:text-white transition-colors"
          >
            <span className="text-sm leading-none">←</span>
            {parent.label}
          </button>
        )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">{content}</div>

      <BottomNav />
    </div>
  );
}
