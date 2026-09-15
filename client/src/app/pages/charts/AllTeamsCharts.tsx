/**
 * AllTeamsCharts.tsx
 *
 * Extrait de ChartPage.tsx le 2026-08-10 (3106 lignes → 11 fichiers).
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { useNavigate } from "react-router";
import { useEffect, useState } from "react";
import { useSport } from "../../context/SportContext";
import { useI18n } from "../../i18n";
import { nhlLogoUrl } from "../../data/teamEmoji";
import { nhlApiService } from "../../services/nhlApiService";
import type { TeamSeasonRow, AllTeamsSeason } from "../../services/nhlApiService";
import { BarSkeleton, MetricChips, RowsSkeleton, SearchInput, SeasonSelect, SortHead } from "./ChartControls";
import { StackPart, StackRow, StackedTotalsBar } from "./ChartVisuals";
import { TFn } from "./chartsMetrics";
import { BG_CARD, SortDir, currentSeasonId, int, num2, sign } from "./chartsTheme";

/* ── All teams (league-wide team performance) ───────────────
 * Every team's season summary in one table. Unlike the player leaders page,
 * all 32 rows arrive in a single call, so sorting is done locally — which also
 * lets derived columns like goal differential be sortable.
 */
type TMetric = {
  key: string;
  label: string;
  fmt: (r: TeamSeasonRow) => string;
  num: (r: TeamSeasonRow) => number;
  /** Lower is better (sorts ascending by default). */
  lowBetter?: boolean;
};

function buildTeamMetrics(t: TFn): TMetric[] {
  const pct = (v: number) => `${v.toFixed(1)}%`;
  return [
    { key: "points",       label: t("chart.tm.points"),       fmt: (r) => int(r.points),       num: (r) => r.points },
    { key: "wins",         label: t("chart.tm.wins"),         fmt: (r) => int(r.wins),         num: (r) => r.wins },
    { key: "losses",       label: t("chart.tm.losses"),       fmt: (r) => int(r.losses),       num: (r) => r.losses, lowBetter: true },
    { key: "otLosses",     label: t("chart.tm.otLosses"),     fmt: (r) => int(r.otLosses),     num: (r) => r.otLosses, lowBetter: true },
    { key: "pointPct",     label: t("chart.tm.pointPct"),     fmt: (r) => pct(r.pointPct),     num: (r) => r.pointPct },
    { key: "goalsFor",     label: t("chart.tm.goalsFor"),     fmt: (r) => int(r.goalsFor),     num: (r) => r.goalsFor },
    { key: "goalsAgainst", label: t("chart.tm.goalsAgainst"), fmt: (r) => int(r.goalsAgainst), num: (r) => r.goalsAgainst, lowBetter: true },
    { key: "goalDiff",     label: t("chart.tm.goalDiff"),     fmt: (r) => sign(r.goalDiff),    num: (r) => r.goalDiff },
    { key: "gfPerGame",    label: `${t("chart.tm.goalsFor")}/G`,     fmt: (r) => num2(r.goalsForPerGame),     num: (r) => r.goalsForPerGame },
    { key: "gaPerGame",    label: `${t("chart.tm.goalsAgainst")}/G`, fmt: (r) => num2(r.goalsAgainstPerGame), num: (r) => r.goalsAgainstPerGame, lowBetter: true },
    { key: "ppPct",        label: t("chart.tm.ppPct"),        fmt: (r) => pct(r.ppPct),        num: (r) => r.ppPct },
    { key: "pkPct",        label: t("chart.tm.pkPct"),        fmt: (r) => pct(r.pkPct),        num: (r) => r.pkPct },
    { key: "shotsFor",     label: t("chart.tm.shots"),        fmt: (r) => num2(r.shotsForPerGame),     num: (r) => r.shotsForPerGame },
    { key: "shotsAgainst", label: t("chart.tm.shotsAgainst"), fmt: (r) => num2(r.shotsAgainstPerGame), num: (r) => r.shotsAgainstPerGame, lowBetter: true },
    { key: "faceoffPct",   label: t("chart.tm.faceoffPct"),   fmt: (r) => pct(r.faceoffPct),   num: (r) => r.faceoffPct },
    { key: "shutouts",     label: t("chart.tm.shutouts"),     fmt: (r) => int(r.shutouts),     num: (r) => r.shutouts },
  ];
}

export function AllTeamsCharts() {
  const { t } = useI18n();
  const { theme } = useSport();
  const navigate = useNavigate();
  const accent = theme.accent;

  const [season, setSeason] = useState<number>(currentSeasonId);
  const [data, setData] = useState<AllTeamsSeason | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [sort, setSort] = useState<{ key: string; dir: SortDir }>({ key: "points", dir: "desc" });
  const [query, setQuery] = useState("");

  const metrics = buildTeamMetrics(t);
  const metric = metrics.find((m) => m.key === sort.key) ?? metrics[0];

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    nhlApiService
      .getAllTeamsSeason(season)
      .then((res) => { if (alive) setData(res); })
      .catch((e) => { console.error("AllTeamsCharts load error", e); if (alive) setError(true); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [season]);

  const toggleSort = (key: string) =>
    setSort((cur) => {
      if (cur.key === key) return { key, dir: cur.dir === "asc" ? "desc" : "asc" };
      const m = metrics.find((x) => x.key === key);
      return { key, dir: m?.lowBetter ? "asc" : "desc" };
    });

  // Sorted first (so rank reflects the metric), then filtered for display —
  // searching must not renumber the standings.
  const sorted = [...(data?.teams ?? [])].sort((a, b) => {
    const d = metric.num(a) - metric.num(b);
    return sort.dir === "asc" ? d : -d;
  });
  const ranked = sorted.map((r, i) => ({ ...r, rank: i + 1 }));

  const q = query.trim().toLowerCase();
  const visible = q
    ? ranked.filter((r) => r.name.toLowerCase().includes(q) || r.abbr.toLowerCase().includes(q))
    : ranked;

  // Stacked bar: W / L / OTL add up to games played — every team, in the
  // current sort order. The team-level analogue of the goalie decisions chart.
  const barParts: StackPart[] = [
    { key: "wins",     label: t("chart.tm.wins"),     color: "#4ade80" },
    { key: "losses",   label: t("chart.tm.losses"),   color: "#f87171" },
    { key: "otLosses", label: t("chart.tm.otLosses"), color: "#fb923c" },
  ];
  const barRows: StackRow[] = ranked.map((r) => ({
    name: r.name,
    short: r.abbr,
    total: r.wins + r.losses + r.otLosses,
    wins: r.wins,
    losses: r.losses,
    otLosses: r.otLosses,
  })).filter((r) => r.total > 0);

  return (
    <div className="flex flex-col gap-4">
      {/* Header + season + search */}
      <div className="rounded-2xl border border-white/20 p-4 flex flex-col gap-3" style={{ background: BG_CARD }}>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-white font-bold text-base">{t("chart.allTeams.title")}</p>
            <p className="text-[#8a9ea6] text-xs">
              {t("chart.allTeams.note", { n: data?.teams.length ?? 0 })}
            </p>
          </div>
          <SeasonSelect season={season} onChange={setSeason} />
        </div>

        {/* All 32 teams are already loaded, so this filters locally. */}
        <SearchInput value={query} onChange={setQuery} placeholder={t("chart.searchTeam")} />
      </div>

      {/* Standings table */}
      <div className="rounded-2xl border border-white/20 overflow-hidden" style={{ background: BG_CARD }}>
        <div className="px-4 pt-3 pb-2 border-b border-white/10">
          <p className="text-white text-sm font-semibold mb-2">{t("chart.teamStats")}</p>
          <MetricChips metrics={metrics} activeKey={metric.key} dir={sort.dir} onToggle={toggleSort} accent={accent} />
        </div>

        {loading ? (
          <RowsSkeleton count={8} />
        ) : error || !data || data.teams.length === 0 ? (
          <p className="px-4 py-6 text-center text-[#8a9ea6] text-sm">{t("chart.noData")}</p>
        ) : visible.length === 0 ? (
          <p className="px-4 py-6 text-center text-[#8a9ea6] text-sm">{t("chart.noResults")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="text-[#8a9ea6]">
                  <th className="text-left font-semibold px-3 py-2 sticky left-0 z-10" style={{ background: BG_CARD }}>
                    {t("chart.rank")} {t("chart.team")}
                  </th>
                  <th className="font-semibold px-3 py-2 text-center">{t("chart.tm.gp")}</th>
                  {metrics.map((m) => (
                    <th key={m.key} className="px-3 py-2 whitespace-nowrap">
                      <SortHead
                        label={m.label}
                        active={m.key === metric.key}
                        dir={sort.dir}
                        onClick={() => toggleSort(m.key)}
                        accent={accent}
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr
                    key={r.abbr}
                    onClick={() => navigate(`/stats/chart/team/${r.abbr.toLowerCase()}`)}
                    className="border-t border-white/[0.06] cursor-pointer hover:bg-white/[0.04] transition-colors"
                  >
                    <td className="px-3 py-2.5 sticky left-0 z-10 whitespace-nowrap" style={{ background: BG_CARD }}>
                      <span className="text-[#5c6f63] tabular-nums mr-2">{r.rank}</span>
                      <img src={nhlLogoUrl(r.abbr)} alt={r.abbr} className="w-4 h-4 object-contain inline-block mr-1.5 align-text-bottom" />
                      <span className="text-white font-medium">{r.name}</span>
                    </td>
                    <td className="px-3 py-2.5 text-center tabular-nums text-[#c8d3cc]">{int(r.gamesPlayed)}</td>
                    {metrics.map((m) => (
                      <td
                        key={m.key}
                        className="px-3 py-2.5 text-center tabular-nums"
                        style={m.key === metric.key ? { color: accent, fontWeight: 600 } : { color: "#fff" }}
                      >
                        {m.fmt(r)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Record breakdown for the top 10 by the current sort */}
      {loading ? (
        <BarSkeleton />
      ) : (
        <StackedTotalsBar
          rows={barRows}
          parts={barParts}
          title={t("chart.bar.decisions")}
          note={t("chart.bar.allNote", { n: barRows.length })}
        />
      )}
    </div>
  );
}
