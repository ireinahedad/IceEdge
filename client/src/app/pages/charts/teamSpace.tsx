/**
 * teamSpace.tsx — l'espace d'une équipe dans la section Statistiques.
 *
 * Trois routes partagent cet espace :
 *
 *   /stats/chart/team/:abbr            vue d'ensemble du club  (TeamCharts)
 *   /stats/chart/team/:abbr/games      ses matchs              (AllGamesCharts)
 *   /stats/chart/team/:abbr/players    ses joueurs             (PlayerCharts)
 *
 * On y navigue avec les MÊMES trois boutons qu'à l'accueil (Équipe · Match ·
 * Joueur) — c'est le même geste — mais peints à la couleur du club plutôt qu'à
 * l'accent de l'application. C'est le seul signal qui dit « tu n'es plus dans
 * la ligue, tu es chez Montréal » : sans lui, les deux niveaux de navigation
 * seraient identiques à l'œil et on ne saurait plus lequel des deux on vient
 * d'utiliser.
 *
 * `teamAccent()` (data/teamEmoji) relève les bleus marine quasi noirs — TOR,
 * WPG — qui disparaîtraient sinon sur le fond de glace de nuit.
 */

import { useNavigate } from "react-router";
import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { nhlLogoUrl, teamAccent } from "../../data/teamEmoji";
import { nhlApiService } from "../../services/nhlApiService";
import type { NHLTeamInfo } from "../../types/bet";

/** Les trois sections d'un espace d'équipe. */
export type TeamSection = "overview" | "games" | "players";

/** `undefined`/`"games"`/`"players"` (segment d'URL) → section. */
export function toTeamSection(segment?: string): TeamSection {
  return segment === "games" ? "games" : segment === "players" ? "players" : "overview";
}

/** URL d'une section de l'espace d'une équipe. */
export function teamSectionPath(abbr: string, section: TeamSection): string {
  const base = `/stats/chart/team/${abbr.toLowerCase()}`;
  return section === "overview" ? base : `${base}/${section}`;
}

/* ── Annuaire des équipes ──────────────────────────────────
 * `/teams` est demandé par TeamCharts, PlayerCharts, AllGamesCharts et
 * l'accueil. Un cache de module évite que l'en-tête en redemande une copie à
 * chaque changement de section : la liste ne bouge pas d'une saison à l'autre,
 * et la promesse est partagée pour que deux montages simultanés n'émettent
 * qu'une requête.
 */
let teamsPromise: Promise<NHLTeamInfo[]> | null = null;

export function loadTeamDirectory(): Promise<NHLTeamInfo[]> {
  if (!teamsPromise) {
    teamsPromise = nhlApiService.getAllTeams().catch((e) => {
      // Un échec ne doit pas figer l'annuaire sur une promesse rejetée : le
      // prochain appelant retentera.
      teamsPromise = null;
      throw e;
    });
  }
  return teamsPromise;
}

/** Nom complet du club, le temps que l'annuaire arrive (repli : l'abréviation). */
export function useTeamName(abbr?: string): string {
  const [teams, setTeams] = useState<NHLTeamInfo[]>([]);
  useEffect(() => {
    let alive = true;
    loadTeamDirectory().then((tm) => { if (alive) setTeams(tm); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!abbr) return "";
  const up = abbr.toUpperCase();
  return teams.find((x) => (x.abbreviation ?? "").toUpperCase() === up)?.name ?? up;
}

/* ── Les trois pastilles, aux couleurs du club ─────────────
 * Même forme et même position que `ChartNav` (ChartPage) : seules les couleurs
 * et les destinations changent. Inactives, elles gardent une teinte du club —
 * sinon la barre ne se distinguerait de celle de la ligue qu'au moment où une
 * pastille est sélectionnée.
 */
export function TeamSpaceNav({ abbr, section }: { abbr: string; section: TeamSection }) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const accent = teamAccent(abbr);

  const items: { key: TeamSection; label: string }[] = [
    { key: "overview", label: t("chart.team") },
    { key: "games",    label: t("chart.game") },
    { key: "players",  label: t("chart.player") },
  ];

  return (
    <nav className="flex items-center gap-1 ml-auto shrink-0">
      {items.map((it) => {
        const active = section === it.key;
        return (
          <button
            key={it.key}
            onClick={() => navigate(teamSectionPath(abbr, it.key))}
            aria-current={active ? "page" : undefined}
            className="px-2.5 py-1 rounded-md text-[11px] font-bold uppercase tracking-wider transition-colors"
            style={
              active
                ? { background: accent, color: "#0A0E0C" }
                : { background: `${accent}24`, color: accent }
            }
          >
            {it.label}
          </button>
        );
      })}
    </nav>
  );
}

/** Logo + nom du club, posés sous le titre : à qui appartient cet espace. */
export function TeamSpaceIdentity({ abbr }: { abbr: string }) {
  const accent = teamAccent(abbr);
  const name = useTeamName(abbr);
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <img src={nhlLogoUrl(abbr)} alt="" className="w-4 h-4 object-contain shrink-0" aria-hidden />
      <span className="text-[11px] font-bold uppercase tracking-wider truncate" style={{ color: accent }}>
        {name}
      </span>
    </span>
  );
}
