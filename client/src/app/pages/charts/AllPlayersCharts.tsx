/**
 * AllPlayersCharts.tsx
 *
 * Extrait de ChartPage.tsx le 2026-08-10 (3106 lignes → 11 fichiers).
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { useNavigate } from "react-router";
import { useEffect, useRef, useState } from "react";
import { useSport } from "../../context/SportContext";
import { useI18n } from "../../i18n";
import { nhlApiService } from "../../services/nhlApiService";
import type { PlayerSeasonStat, PlayerLeaders } from "../../services/nhlApiService";
import { FactorPie } from "../../components/FactorPie";
import type { PieSlice } from "../../components/FactorPie";
import { BarSkeleton, MetricChips, PlayerSearchBox, RowsSkeleton, SeasonSelect, SortHead } from "./ChartControls";
import { StackPart, StackRow, StackedTotalsBar } from "./ChartVisuals";
import { buildGoalieExtraMetrics, buildGoalieMetrics, buildSkaterExtraMetrics, buildSkaterMetrics, naturalSortDir } from "./chartsMetrics";
import { BG_CARD, BG_CELL, SERIES_COLORS, SortDir, View, currentSeasonId, int } from "./chartsTheme";

/* ── All players (league leaders) ───────────────────────────
 * Top N players for a season across the same metric set as the single-player
 * page. Sorting happens server-side (the NHL summary endpoints support it), so
 * picking a metric re-fetches rather than re-sorting a partial list — that way
 * "top 20 by PIM" really is the league's top 20, not the top 20 scorers
 * re-ordered by PIM.
 */
export function AllPlayersCharts() {
  const { t } = useI18n();
  const { theme } = useSport();
  const navigate = useNavigate();
  const accent = theme.accent;

  const LIMIT = 20;   // rows in the leaderboard table
  const SORT_DEBOUNCE_MS = 150;
  const CHART_N = 10; // players fed into the bar chart + pies
  const [view, setView] = useState<View>("skater");
  // Skaters and goalies have disjoint metric sets, so each view remembers its
  // own sort. Deriving the active key (rather than resetting it in an effect on
  // view change) avoids firing a throwaway fetch with a mismatched metric.
  const [skaterSort, setSkaterSort] = useState<{ key: string; dir: SortDir }>({ key: "points", dir: "desc" });
  const [goalieSort, setGoalieSort] = useState<{ key: string; dir: SortDir }>({ key: "wins", dir: "desc" });
  // Seeded client-side so the first fetch already carries a season — starting
  // from null and adopting the server's value would cost an extra round trip.
  const [season, setSeason] = useState<number>(currentSeasonId);
  const [data, setData] = useState<PlayerLeaders | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const isGoalieView = view === "goalie";
  const activeSort = isGoalieView ? goalieSort : skaterSort;
  const setActiveSort = isGoalieView ? setGoalieSort : setSkaterSort;
  const sortKey = activeSort.key;
  const sortDir = activeSort.dir;

  // Clicking a new column picks that metric (server re-fetches the true top N
  // for it); clicking the active one just flips the direction, which is a
  // display-only reversal — no refetch.
  const toggleSort = (key: string) =>
    setActiveSort((cur) =>
      cur.key === key
        ? { key, dir: cur.dir === "asc" ? "desc" : "asc" }
        : { key, dir: naturalSortDir(key) },
    );

  const metrics = isGoalieView
    ? [...buildGoalieMetrics(t), ...buildGoalieExtraMetrics(t)]
    // Le classement de ligue est trié CÔTÉ SERVEUR par l'API NHL, qui ne
    // connaît pas le Corsi/Fenwick sur la glace (MoneyPuck) : ces deux colonnes
    // ne peuvent pas y être triées, elles restent sur les fiches joueur.
    : [...buildSkaterMetrics(t), ...buildSkaterExtraMetrics(t)]
        .filter((m) => m.key !== "onIceCorsiPct" && m.key !== "onIceFenwickPct");
  const metric = metrics.find((m) => m.key === sortKey) ?? metrics[0];

  // Clics de tri rapprochés : 12 clics en 0,7 s faisaient 11 requêtes menées
  // à terme (audit du 2026-09-16) — le garde `alive` évitait la course, pas
  // l'appel. Désormais :
  //  - anti-rebond de 150 ms, sauf au premier chargement (pas de délai perçu).
  //    Le tableau reste affiché pendant l'attente : passer `loading` tout de
  //    suite le remplaçait par le squelette, et le clic suivant tombait dans
  //    le vide ;
  //  - la requête d'un tri remplacé est ABANDONNÉE (AbortController), et son
  //    `AbortError` n'affiche aucune erreur.
  const loadedOnce = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    const delay = loadedOnce.current ? SORT_DEBOUNCE_MS : 0;
    loadedOnce.current = true;
    const timer = setTimeout(() => {
      setLoading(true);
      setError(false);
      nhlApiService
        .getPlayerLeaders(view, sortKey, LIMIT, season, controller.signal)
        .then((res) => { if (!controller.signal.aborted) setData(res); })
        .catch((e) => {
          if (controller.signal.aborted) return;
          console.error("AllPlayersCharts load error", e);
          setError(true);
        })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, delay);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [view, sortKey, season]);

  // Rows arrive already sorted by the server in the metric's natural direction,
  // so rank is just position here. Rank stays pinned to the player, meaning
  // flipping the arrow reverses the list without renumbering it.
  const ranked = (data?.players ?? []).map((p, i) => ({ ...p, rank: i + 1 }));
  const displayRows = sortDir === naturalSortDir(sortKey) ? ranked : [...ranked].reverse();

  // ── Chart inputs: always the genuine top 10, regardless of display order ──
  const top = ranked.slice(0, CHART_N);

  // Stacked bars: the components that add up to each player's total. Bars are
  // ordered by that total so the chart reads left-to-right like a ranking.
  const barParts: StackPart[] = isGoalieView
    ? [
        { key: "wins",     label: t("chart.m.wins"),     color: "#4ade80" },
        { key: "losses",   label: t("chart.m.losses"),   color: "#f87171" },
        { key: "otLosses", label: t("chart.m.otLosses"), color: "#fb923c" },
      ]
    : [
        { key: "goals",   label: t("chart.m.goals"),   color: "#4ade80" },
        { key: "assists", label: t("chart.m.assists"), color: "#86d1ea" },
      ];

  // Values are pulled by `barParts` key, so the bars and the legend can never
  // drift apart — the part keys are PlayerSeasonStat field names.
  const barRows: StackRow[] = top
    .map((p) => {
      const s = p.stat as unknown as Record<string, number | null | undefined>;
      const row: StackRow = {
        name: p.name,
        // Surname only — ten full names won't fit along the axis.
        short: p.name.split(" ").slice(1).join(" ") || p.name,
        total: 0,
      };
      for (const part of barParts) {
        const v = s[part.key] ?? 0;
        row[part.key] = v;
        row.total += v;
      }
      return row;
    })
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total);

  const shareSlices = (pick: (s: PlayerSeasonStat) => number): PieSlice[] =>
    top
      .map((p, i) => ({
        label: p.name,
        value: pick(p.stat),
        color: SERIES_COLORS[i % SERIES_COLORS.length],
      }))
      .filter((x) => x.value > 0);

  const pies: { title: string; slices: PieSlice[] }[] = (isGoalieView
    ? [
        { title: t("chart.pie.winShare"),     slices: shareSlices((s) => s.wins ?? 0) },
        { title: t("chart.pie.shutoutShare"), slices: shareSlices((s) => s.shutouts ?? 0) },
        { title: t("chart.pie.gpShare"),      slices: shareSlices((s) => s.gp ?? 0) },
      ]
    : [
        { title: t("chart.pie.pointShare"),  slices: shareSlices((s) => s.points ?? 0) },
        { title: t("chart.pie.goalShare"),   slices: shareSlices((s) => s.goals ?? 0) },
        { title: t("chart.pie.assistShare"), slices: shareSlices((s) => s.assists ?? 0) },
      ]
  ).filter((p) => p.slices.length > 0);

  return (
    <div className="flex flex-col gap-4">
      {/* Header + controls */}
      <div className="rounded-2xl border border-white/20 p-4 flex flex-col gap-3" style={{ background: BG_CARD }}>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-white font-bold text-base">{t("chart.allPlayers.title")}</p>
            <p className="text-[#8a9ea6] text-xs">
              {t("chart.allPlayers.note", { n: LIMIT, metric: metric.label })}
            </p>
          </div>
          <SeasonSelect season={season} onChange={setSeason} />
        </div>

        <PlayerSearchBox
          placeholder={t("chart.searchPlayer")}
          onPick={(p) => navigate(`/stats/chart/player/${p.id}`)}
        />

        <div className="inline-flex self-start rounded-full p-0.5 border border-white/15" style={{ background: BG_CELL }}>
          {(["skater", "goalie"] as View[]).map((v) => {
            const isActive = view === v;
            return (
              <button
                key={v}
                onClick={() => setView(v)}
                className="px-3.5 py-1.5 rounded-full text-xs font-semibold transition-colors"
                style={isActive ? { background: accent, color: "#0A0E0C" } : { color: "#8a9ea6" }}
              >
                {v === "skater" ? t("chart.skaters") : t("chart.goalies")}
              </button>
            );
          })}
        </div>
      </div>

      {/* Leaderboard */}
      <div className="rounded-2xl border border-white/20 overflow-hidden" style={{ background: BG_CARD }}>
        <div className="px-4 pt-3 pb-2 border-b border-white/10">
          <p className="text-white text-sm font-semibold mb-2">{t("chart.playerStats")}</p>
          <MetricChips metrics={metrics} activeKey={metric.key} dir={sortDir} onToggle={toggleSort} accent={accent} />
        </div>

        {loading ? (
          <RowsSkeleton count={8} />
        ) : error || !data || data.players.length === 0 ? (
          <p className="px-4 py-6 text-center text-[#8a9ea6] text-sm">{t("chart.noData")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="text-[#8a9ea6]">
                  <th className="text-left font-semibold px-3 py-2 sticky left-0 z-10" style={{ background: BG_CARD }}>
                    {t("chart.rank")} {t("chart.player")}
                  </th>
                  <th className="font-semibold px-3 py-2 text-center">{t("chart.m.gp")}</th>
                  {metrics.map((m) => (
                    <th key={m.key} className="px-3 py-2 whitespace-nowrap">
                      <SortHead
                        label={m.label}
                        active={m.key === metric.key}
                        dir={sortDir}
                        onClick={() => toggleSort(m.key)}
                        accent={accent}
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayRows.map((p) => (
                  <tr
                    key={p.id}
                    onClick={() => navigate(`/stats/chart/player/${p.id}`)}
                    className="border-t border-white/[0.06] cursor-pointer hover:bg-white/[0.04] transition-colors"
                  >
                    <td className="px-3 py-2.5 sticky left-0 z-10 whitespace-nowrap" style={{ background: BG_CARD }}>
                      <span className="text-[#5c6f63] tabular-nums mr-2">{p.rank}</span>
                      <span className="text-white font-medium">{p.name}</span>
                      <span className="text-[#5c6f63] ml-1.5">{p.teamAbbr}</span>
                      <span className="text-[#5c6f63] ml-1.5">{p.position}</span>
                    </td>
                    <td className="px-3 py-2.5 text-center tabular-nums text-[#c8d3cc]">{int(p.stat.gp)}</td>
                    {metrics.map((m) => (
                      <td
                        key={m.key}
                        className="px-3 py-2.5 text-center tabular-nums"
                        style={m.key === metric.key ? { color: accent, fontWeight: 600 } : { color: "#fff" }}
                      >
                        {m.total(p.stat)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Stacked bars: what each top-10 player's total is made of ── */}
      {loading ? (
        <BarSkeleton />
      ) : (
        <StackedTotalsBar
          rows={barRows}
          parts={barParts}
          title={isGoalieView ? t("chart.bar.decisions") : t("chart.pie.pointsBreakdown")}
          note={t("chart.bar.note", { n: barRows.length })}
        />
      )}

      {/* ── Share breakdowns across the top 10 ── */}
      {pies.length > 0 && (
        <div className="rounded-2xl border border-white/20 p-4" style={{ background: BG_CARD }}>
          <p className="text-white text-sm font-semibold mb-3" style={{ color: accent }}>
            {t("chart.breakdowns")}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {pies.map((pie) => (
              <div key={pie.title} className="rounded-xl p-3" style={{ background: BG_CELL }}>
                <p className="text-[#c8d3cc] text-xs font-semibold mb-2 text-center">{pie.title}</p>
                <FactorPie slices={pie.slices} vertical size={120} thickness={18} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
