/**
 * CompareCharts.tsx — comparaisons joueur-joueur et équipe-équipe (2026-09-29).
 *
 *   /stats/chart/compare-players?a=<id>&b=<id>
 *   /stats/chart/compare-teams?a=<abbr>&b=<abbr>
 *
 * Deux côtés, A (accent de l'app) et B (jaune, la couleur de la colonne
 * « Comparer » de la page d'un joueur). Les choix vivent dans la query string :
 * une comparaison se partage et survit à un rechargement, et les boutons
 * « Comparer » des pages joueur / équipe y arrivent avec A déjà posé.
 *
 * Sous les sélecteurs : un tableau A | B de toutes les statistiques, puis le
 * diagramme face à face (`CompareBars`) sur les principales.
 */

import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { X } from "lucide-react";
import { useSport } from "../../context/SportContext";
import { useI18n } from "../../i18n";
import { nhlLogoUrl } from "../../data/teamEmoji";
import { nhlApiService } from "../../services/nhlApiService";
import type { AllTeamsSeason, PlayerSeasons } from "../../services/nhlApiService";
import type { NHLPlayerInfo, NHLTeamInfo } from "../../types/bet";
import { CardsSkeleton, ChartMessage, PlayerSearchBox, SeasonSelect, TeamSelect } from "./ChartControls";
import { COMPARE_B_COLOR, CompareBars } from "./ChartVisuals";
import {
  buildGoalieExtraMetrics, buildGoalieMetrics, buildSkaterExtraMetrics, buildSkaterMetrics,
  buildTeamMetrics, playerLowBetter,
} from "./chartsMetrics";
import { BG_CARD, BG_CELL, DASH, currentSeasonId, int, seasonLabel, selectCls } from "./chartsTheme";
import { loadTeamDirectory } from "./teamSpace";

type SideKey = "a" | "b";

/** Lit / écrit un côté dans la query string, sans empiler l'historique. */
function useSides() {
  const [params, setParams] = useSearchParams();
  const get = (k: SideKey) => params.get(k) ?? "";
  const set = (k: SideKey, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  };
  return { a: get("a"), b: get("b"), set };
}

/* ── Tableau A | B ─────────────────────────────────────── */
function CompareTable({
  title,
  leftLabel,
  rightLabel,
  leftColor,
  rows,
}: {
  title: string;
  leftLabel: string;
  rightLabel: string;
  leftColor: string;
  rows: { key: string; label: string; left: string; right: string }[];
}) {
  return (
    <div className="rounded-2xl border border-white/20 overflow-hidden" style={{ background: BG_CARD }}>
      <div className="px-4 pt-3 pb-2 border-b border-white/10">
        <p className="text-white text-sm font-semibold">{title}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="text-[#8a9ea6]">
              <th className="text-left font-semibold px-4 py-2 sticky left-0 z-10" style={{ background: BG_CARD }}>&nbsp;</th>
              <th className="font-semibold px-3 py-2 text-center truncate max-w-[8rem]" style={{ color: leftColor }}>{leftLabel}</th>
              <th className="font-semibold px-3 py-2 text-center truncate max-w-[8rem]" style={{ color: COMPARE_B_COLOR }}>{rightLabel}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-white/[0.06]">
                <td className="px-4 py-2.5 sticky left-0 z-10 whitespace-nowrap text-white font-medium" style={{ background: BG_CARD }}>
                  {r.label}
                </td>
                <td className="px-3 py-2.5 text-center tabular-nums" style={{ color: leftColor }}>{r.left}</td>
                <td className="px-3 py-2.5 text-center tabular-nums" style={{ color: COMPARE_B_COLOR }}>{r.right}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** La case d'un côté une fois choisi : visuel, nom, sous-titre, et la croix pour le retirer. */
function PickedSlot({
  img,
  fallbackImg,
  name,
  sub,
  color,
  onClear,
  clearLabel,
}: {
  img: string;
  fallbackImg: string;
  name: string;
  sub: string;
  color: string;
  onClear: () => void;
  clearLabel: string;
}) {
  return (
    <div className="rounded-xl border p-2.5 flex items-center gap-2.5 min-w-0" style={{ background: BG_CELL, borderColor: `${color}66` }}>
      <img
        src={img || fallbackImg}
        alt=""
        className="w-10 h-10 rounded-full object-cover bg-black/20 shrink-0"
        onError={(e) => { (e.currentTarget as HTMLImageElement).src = fallbackImg; }}
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold truncate" style={{ color }}>{name}</p>
        <p className="text-[#8a9ea6] text-[11px] truncate">{sub}</p>
      </div>
      <button onClick={onClear} className="tap-44 text-[#8a9ea6] hover:text-white transition-colors shrink-0" aria-label={clearLabel}>
        <X size={14} />
      </button>
    </div>
  );
}

/* ═══════════════════════ Joueur contre joueur ═══════════════════════ */

type PlayerSide = { entry: PlayerSeasons | null; goalie: boolean; teamAbbr: string; loading: boolean; error: boolean };
const EMPTY_SIDE: PlayerSide = { entry: null, goalie: false, teamAbbr: "", loading: false, error: false };

/**
 * Un joueur par son identifiant : sa fiche (`/players/:id`) donne son club,
 * dont les saisons (`/teams/:abbr/player-seasons`, la requête de la page d'un
 * joueur) portent ses lignes de statistiques.
 */
function usePlayerSide(id: string): PlayerSide {
  const [side, setSide] = useState<PlayerSide>(EMPTY_SIDE);
  useEffect(() => {
    if (!id) { setSide(EMPTY_SIDE); return; }
    let alive = true;
    setSide({ ...EMPTY_SIDE, loading: true });
    (async () => {
      try {
        const info = await nhlApiService.getPlayer(id);
        const abbr = (info?.teamAbbr ?? "").toUpperCase();
        if (!abbr) throw new Error("player without team");
        const ps = await nhlApiService.getTeamPlayerSeasons(abbr);
        const goalie = ps.goalies.find((p) => p.id === id);
        const entry = goalie ?? ps.skaters.find((p) => p.id === id) ?? null;
        if (alive) setSide({ entry, goalie: !!goalie, teamAbbr: abbr, loading: false, error: !entry });
      } catch {
        if (alive) setSide({ ...EMPTY_SIDE, error: true });
      }
    })();
    return () => { alive = false; };
  }, [id]);
  return side;
}

export function ComparePlayersCharts() {
  const { t } = useI18n();
  const { theme } = useSport();
  const accent = theme.accent;
  const { a, b, set } = useSides();
  const A = usePlayerSide(a);
  const B = usePlayerSide(b);
  const [season, setSeason] = useState<number | null>(null);

  // Les saisons que les deux ont jouées, la plus récente d'abord.
  const seasonsOf = (s: PlayerSide) => (s.entry?.seasons ?? []).map((x) => x.seasonId);
  const common = seasonsOf(A).filter((sid) => seasonsOf(B).includes(sid)).sort((x, y) => y - x);
  const activeSeason = season != null && common.includes(season) ? season : common[0] ?? null;
  const statA = A.entry?.seasons.find((s) => s.seasonId === activeSeason) ?? null;
  const statB = B.entry?.seasons.find((s) => s.seasonId === activeSeason) ?? null;

  // Un gardien se compare à un gardien : la recherche de l'autre côté ne
  // propose que des joueurs du même type, et jamais celui déjà choisi.
  const sameKind = (other: PlayerSide, otherId: string) => (p: NHLPlayerInfo) => {
    if (String(p.id) === otherId) return false;
    if (!other.entry) return true;
    return ((p.position ?? "").toUpperCase() === "G") === other.goalie;
  };

  const headshot = (side: PlayerSide, id: string) => {
    const last = side.entry?.seasons.map((s) => s.seasonId).sort((x, y) => y - x)[0];
    return last && side.teamAbbr ? `https://assets.nhle.com/mugs/nhl/${last}/${side.teamAbbr}/${id}.png` : "";
  };

  const slot = (key: SideKey, id: string, side: PlayerSide, other: PlayerSide, otherId: string, color: string) =>
    id ? (
      side.loading ? (
        <div className="h-[62px] rounded-xl animate-pulse" style={{ background: BG_CELL }} />
      ) : (
        <PickedSlot
          img={headshot(side, id)}
          fallbackImg={nhlLogoUrl(side.teamAbbr)}
          name={side.entry?.name ?? DASH}
          sub={[side.entry?.position, side.teamAbbr].filter(Boolean).join(" · ") || t("chart.noData")}
          color={color}
          onClear={() => set(key, "")}
          clearLabel={t("chart.compare.clear")}
        />
      )
    ) : (
      <PlayerSearchBox
        placeholder={t("chart.searchPlayer")}
        onPick={(p) => set(key, String(p.id))}
        filter={sameKind(other, otherId)}
      />
    );

  const goalie = A.entry ? A.goalie : B.goalie;
  const metrics = goalie
    ? [...buildGoalieMetrics(t), ...buildGoalieExtraMetrics(t)]
    : [...buildSkaterMetrics(t), ...buildSkaterExtraMetrics(t)];
  // Le diagramme garde les statistiques principales ; le tableau les a toutes.
  const mainKeys = new Set((goalie ? buildGoalieMetrics(t) : buildSkaterMetrics(t)).map((m) => m.key));
  const nameA = A.entry?.name ?? "A";
  const nameB = B.entry?.name ?? "B";

  const bothReady = !!(a && b && A.entry && B.entry);
  const mixed = bothReady && A.goalie !== B.goalie;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-white/20 p-4 flex flex-col gap-3" style={{ background: BG_CARD }}>
        <div className="min-w-0">
          <p className="text-white font-bold text-base">{t("chart.compare.players")}</p>
          <p className="text-[#8a9ea6] text-xs">{t("chart.compare.playersDesc")}</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {slot("a", a, A, B, b, accent)}
          {slot("b", b, B, A, a, COMPARE_B_COLOR)}
        </div>
      </div>

      {!a || !b ? (
        <ChartMessage large>{t("chart.compare.pickTwoPlayers")}</ChartMessage>
      ) : A.loading || B.loading ? (
        <CardsSkeleton />
      ) : A.error || B.error ? (
        <ChartMessage>{t("chart.noData")}</ChartMessage>
      ) : mixed ? (
        <ChartMessage>{t("chart.compare.mixed")}</ChartMessage>
      ) : activeSeason == null || !statA || !statB ? (
        <ChartMessage>{t("chart.compare.noCommonSeason")}</ChartMessage>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={activeSeason}
              onChange={(e) => setSeason(Number(e.target.value))}
              className={selectCls}
              style={{ background: BG_CELL, color: "#c8d3cc" }}
              aria-label={t("chart.season")}
            >
              {common.map((sid) => (
                <option key={sid} value={sid}>{seasonLabel(sid)}</option>
              ))}
            </select>
          </div>

          <CompareTable
            title={t("chart.playerStats")}
            leftLabel={nameA}
            rightLabel={nameB}
            leftColor={accent}
            rows={[
              { key: "gp", label: "GP", left: int(statA.gp), right: int(statB.gp) },
              ...metrics.map((m) => ({ key: m.key, label: m.label, left: m.total(statA), right: m.total(statB) })),
            ]}
          />

          <CompareBars
            title={t("chart.compare.chart")}
            leftLabel={nameA}
            rightLabel={nameB}
            leftColor={accent}
            items={metrics
              .filter((m) => mainKeys.has(m.key))
              .map((m) => ({
                key: m.key,
                label: m.label,
                left: m.totalNum(statA),
                right: m.totalNum(statB),
                leftText: m.total(statA),
                rightText: m.total(statB),
                lowBetter: playerLowBetter(m.key),
              }))}
          />
        </>
      )}
    </div>
  );
}

/* ═══════════════════════ Équipe contre équipe ═══════════════════════ */

/** Les statistiques d'équipe reprises dans le diagramme (le tableau les a toutes). */
const TEAM_CHART_KEYS = new Set([
  "points", "wins", "goalsFor", "goalsAgainst", "gfPerGame", "gaPerGame", "ppPct", "pkPct", "shotsFor", "faceoffPct",
]);

export function CompareTeamsCharts() {
  const { t } = useI18n();
  const { theme } = useSport();
  const accent = theme.accent;
  const { a, b, set } = useSides();
  const [teams, setTeams] = useState<NHLTeamInfo[]>([]);
  const [season, setSeason] = useState<number>(currentSeasonId);
  const [data, setData] = useState<AllTeamsSeason | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    loadTeamDirectory().then((tm) => { if (alive) setTeams(tm); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Une requête pour les 32 clubs (celle de « toutes les équipes »), puis on
  // y lit les deux lignes.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    nhlApiService
      .getAllTeamsSeason(season)
      .then((res) => { if (alive) setData(res); })
      .catch(() => { if (alive) setError(true); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [season]);

  const teamOptions = [...teams].sort((x, y) => (x.name ?? "").localeCompare(y.name ?? ""));
  const row = (abbr: string) => data?.teams.find((r) => r.abbr.toUpperCase() === abbr.toUpperCase()) ?? null;
  const rowA = a ? row(a) : null;
  const rowB = b ? row(b) : null;
  const nameOf = (abbr: string) =>
    teams.find((x) => (x.abbreviation ?? "").toUpperCase() === abbr.toUpperCase())?.name ?? abbr.toUpperCase();
  const rec = (r: typeof rowA) => (r ? `${r.wins}-${r.losses}-${r.otLosses}` : DASH);

  const slot = (key: SideKey, abbr: string, other: string, color: string) =>
    abbr ? (
      <PickedSlot
        img={nhlLogoUrl(abbr.toUpperCase())}
        fallbackImg={nhlLogoUrl(abbr.toUpperCase())}
        name={nameOf(abbr)}
        sub={`${t("chart.tm.record")} ${rec(key === "a" ? rowA : rowB)} ${t("chart.recordLegend")}`}
        color={color}
        onClear={() => set(key, "")}
        clearLabel={t("chart.compare.clear")}
      />
    ) : (
      <TeamSelect
        value=""
        onChange={(next) => set(key, next)}
        teams={teamOptions.filter((x) => (x.abbreviation ?? "").toLowerCase() !== other.toLowerCase())}
      />
    );

  const metrics = buildTeamMetrics(t);
  const abbrA = a.toUpperCase();
  const abbrB = b.toUpperCase();

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-white/20 p-4 flex flex-col gap-3" style={{ background: BG_CARD }}>
        <div className="min-w-0">
          <p className="text-white font-bold text-base">{t("chart.compare.teams")}</p>
          <p className="text-[#8a9ea6] text-xs">{t("chart.compare.teamsDesc")}</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {slot("a", a, b, accent)}
          {slot("b", b, a, COMPARE_B_COLOR)}
        </div>
      </div>

      {!a || !b ? (
        <ChartMessage large>{t("chart.compare.pickTwoTeams")}</ChartMessage>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <SeasonSelect season={season} onChange={setSeason} />
          </div>

          {loading ? (
            <CardsSkeleton />
          ) : error || !rowA || !rowB ? (
            <ChartMessage>{t("chart.noData")}</ChartMessage>
          ) : (
            <>
              <CompareTable
                title={t("chart.teamStats")}
                leftLabel={abbrA}
                rightLabel={abbrB}
                leftColor={accent}
                rows={[
                  { key: "gp", label: "GP", left: int(rowA.gamesPlayed), right: int(rowB.gamesPlayed) },
                  { key: "record", label: `${t("chart.tm.record")} ${t("chart.recordLegend")}`, left: rec(rowA), right: rec(rowB) },
                  ...metrics.map((m) => ({ key: m.key, label: m.label, left: m.fmt(rowA), right: m.fmt(rowB) })),
                ]}
              />

              <CompareBars
                title={t("chart.compare.chart")}
                leftLabel={abbrA}
                rightLabel={abbrB}
                leftColor={accent}
                items={metrics
                  .filter((m) => TEAM_CHART_KEYS.has(m.key))
                  .map((m) => ({
                    key: m.key,
                    label: m.label,
                    left: m.num(rowA),
                    right: m.num(rowB),
                    leftText: m.fmt(rowA),
                    rightText: m.fmt(rowB),
                    lowBetter: m.lowBetter,
                  }))}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
