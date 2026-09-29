/**
 * ChartsHome.tsx — accueil de la section Statistiques (`/stats/chart`).
 *
 * Jusqu'ici la section n'avait pas de porte d'entrée : `/stats` sautait
 * directement sur « toutes les équipes » ou « tous les joueurs », et les trois
 * pastilles de l'en-tête étaient le seul moyen de passer de l'une à l'autre.
 * Cette page est cette porte — les mêmes trois entrées (Équipe · Match ·
 * Joueur), en grand et expliquées, plus un accès direct à un club.
 *
 * Elle ne fait qu'aiguiller : aucun graphique ici, aucune donnée de saison. Le
 * seul appel réseau est la liste des équipes, la même que TeamCharts,
 * PlayerCharts et AllGamesCharts demandent déjà.
 *
 * La grille de clubs est ce qui rend l'espace d'équipe atteignable en un clic :
 * choisir Montréal ici mène à `/stats/chart/team/mtl`, d'où les trois mêmes
 * boutons — aux couleurs du club, cette fois — mènent à ses matchs et à ses
 * joueurs.
 */

import { useNavigate } from "react-router";
import { useEffect, useState } from "react";
import { useSport } from "../../context/SportContext";
import { useI18n } from "../../i18n";
import { nhlLogoUrl, teamAccent } from "../../data/teamEmoji";
import { nhlApiService } from "../../services/nhlApiService";
import type { NHLTeamInfo } from "../../types/bet";
import { DivisionFilter, DivisionTag, SearchInput } from "./ChartControls";
import { divisionOf, type Division } from "../../data/nhlDivisions";
import { BG_CARD, BG_CELL } from "./chartsTheme";
import { COMPARE_B_COLOR } from "./ChartVisuals";

/* ── Une des trois entrées ─────────────────────────────────
 * Volontairement plus grande et plus bavarde que la pastille correspondante de
 * l'en-tête : ici on choisit, là on navigue.
 */
function SectionTile({
  label,
  desc,
  accent,
  onClick,
}: {
  label: string;
  desc: string;
  accent: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left rounded-2xl border p-4 flex items-center gap-3 transition-transform active:scale-[0.98]"
      style={{ background: BG_CARD, borderColor: `${accent}40` }}
    >
      <span
        className="w-1 self-stretch rounded-full shrink-0"
        style={{ background: accent }}
        aria-hidden
      />
      <span className="flex-1 min-w-0">
        <span className="block text-white font-bold text-sm uppercase tracking-wider">{label}</span>
        <span className="block text-[#8a9ea6] text-xs mt-0.5">{desc}</span>
      </span>
      <span className="text-base shrink-0" style={{ color: accent }}>›</span>
    </button>
  );
}

export function ChartsHome() {
  const { t } = useI18n();
  const { theme } = useSport();
  const navigate = useNavigate();
  const accent = theme.accent;

  const [teams, setTeams] = useState<NHLTeamInfo[]>([]);
  const [query, setQuery] = useState("");
  const [division, setDivision] = useState<Division | null>(null);

  useEffect(() => {
    let alive = true;
    nhlApiService.getAllTeams().then((tm) => { if (alive) setTeams(tm); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Mêmes libellés que les pastilles de l'en-tête : un bouton ne change pas de
  // nom entre l'accueil et la page où il mène.
  const sections = [
    { key: "team",   label: t("chart.team"),   desc: t("chart.home.teamsDesc"),   to: "/stats/chart/all-teams" },
    { key: "game",   label: t("chart.game"),   desc: t("chart.home.gamesDesc"),   to: "/stats/chart/all-games" },
    { key: "player", label: t("chart.player"), desc: t("chart.home.playersDesc"), to: "/stats/chart/all-players" },
  ];

  const q = query.trim().toLowerCase();
  const visibleTeams = [...teams]
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
    .filter((x) =>
      !q ||
      (x.name ?? "").toLowerCase().includes(q) ||
      (x.abbreviation ?? "").toLowerCase().includes(q)
    )
    .filter((x) => !division || divisionOf(x.abbreviation) === division);

  return (
    <div className="flex flex-col gap-4">
      {/* Les trois entrées */}
      <div className="rounded-2xl border border-white/20 p-4 flex flex-col gap-3" style={{ background: BG_CARD }}>
        <div className="min-w-0">
          <p className="text-white font-bold text-base">{t("chart.home")}</p>
          <p className="text-[#8a9ea6] text-xs">{t("chart.home.subtitle")}</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          {sections.map((s) => (
            <SectionTile
              key={s.key}
              label={s.label}
              desc={s.desc}
              accent={accent}
              onClick={() => navigate(s.to)}
            />
          ))}
        </div>

        {/* Comparaisons (2026-09-29) : deux entrées directes, en jaune — la
            couleur du côté B partout dans les comparaisons. */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <SectionTile
            label={t("chart.compare.players")}
            desc={t("chart.compare.playersDesc")}
            accent={COMPARE_B_COLOR}
            onClick={() => navigate("/stats/chart/compare-players")}
          />
          <SectionTile
            label={t("chart.compare.teams")}
            desc={t("chart.compare.teamsDesc")}
            accent={COMPARE_B_COLOR}
            onClick={() => navigate("/stats/chart/compare-teams")}
          />
        </div>
      </div>

      {/* Entrée directe dans l'espace d'un club */}
      <div className="rounded-2xl border border-white/20 p-4 flex flex-col gap-3" style={{ background: BG_CARD }}>
        <div className="min-w-0">
          <p className="text-white text-sm font-semibold">{t("chart.home.pickTeam")}</p>
          <p className="text-[#8a9ea6] text-xs">{t("chart.home.pickTeamNote")}</p>
        </div>

        <SearchInput value={query} onChange={setQuery} placeholder={t("chart.searchTeam")} />
        <DivisionFilter value={division} onChange={setDivision} accent={accent} />

        {teams.length === 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="h-14 rounded-xl animate-pulse" style={{ background: BG_CELL }} />
            ))}
          </div>
        ) : visibleTeams.length === 0 ? (
          <p className="py-4 text-center text-[#8a9ea6] text-sm">{t("chart.noResults")}</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {visibleTeams.map((x) => {
              const abbr = (x.abbreviation ?? "").toUpperCase();
              const clr = teamAccent(abbr);
              return (
                <button
                  key={abbr || x.id}
                  onClick={() => navigate(`/stats/chart/team/${abbr.toLowerCase()}`)}
                  className="rounded-xl border p-2.5 flex items-center gap-2 text-left transition-transform active:scale-[0.97]"
                  style={{ background: `${clr}14`, borderColor: `${clr}59` }}
                >
                  <img src={nhlLogoUrl(abbr)} alt={x.name} className="w-7 h-7 object-contain shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-white text-xs font-medium truncate">{x.name}</span>
                    <span className="flex items-center gap-1.5">
                      <span className="text-[11px] font-bold tracking-wider" style={{ color: clr }}>{abbr}</span>
                      {/* Filtrée, la division est déjà dite par la puce active. */}
                      {!division && <DivisionTag abbr={abbr} />}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
