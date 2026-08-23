/**
 * ChartVisuals.tsx
 *
 * Extrait de ChartPage.tsx le 2026-08-10 (3106 lignes → 11 fichiers).
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { type ReactNode } from "react";
import type { PlayerSeasons, PlayerSeasonStat, TeamSeasonOfficial, SeriesGame } from "../../services/nhlApiService";
import { FactorPie } from "../../components/FactorPie";
import type { PieSlice } from "../../components/FactorPie";
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from "recharts";
import { PMetric } from "./chartsMetrics";
import { BG_CARD, BG_CELL, DASH, SERIES_COLORS, int, num2, per, sign, snum2 } from "./chartsTheme";

/* ── Player line chart ─────────────────────────────────────
 * One line per player. Counting metrics accumulate over games (a diverging
 * "who's producing" view); rate metrics (SV%, GAA) plot the per-game value.
 */
export function PlayerLineChart({
  players,
  seriesById,
  metric,
  title,
  note,
}: {
  players: { id: string; name: string }[];
  seriesById: Map<string, SeriesGame[]>;
  metric: PMetric;
  title: string;
  note: string;
}) {
  const arr = players.map((p) => ({ ...p, series: seriesById.get(p.id) ?? [] }));
  const maxGames = arr.reduce((m, x) => Math.max(m, x.series.length), 0);
  if (maxGames === 0 || players.length === 0) return null;

  const data: Record<string, number>[] = [];
  const running: Record<string, number> = {};
  for (let gi = 0; gi < maxGames; gi++) {
    const point: Record<string, number> = { g: gi + 1 };
    for (const sp of arr) {
      const item = sp.series[gi];
      if (!item) continue;
      const v = metric.seriesVal(item);
      if (metric.cumulative) {
        running[sp.id] = (running[sp.id] ?? 0) + (v ?? 0);
        point[sp.id] = running[sp.id];
      } else if (v != null) {
        point[sp.id] = v;
      }
    }
    data.push(point);
  }

  return (
    <div className="rounded-2xl border border-white/20 overflow-hidden" style={{ background: BG_CARD }}>
      <div className="px-4 pt-3 pb-2 border-b border-white/10">
        <p className="text-white text-sm font-semibold">{title}</p>
        <p className="text-[#8a9ea6] text-[11px]">{note}</p>
      </div>
      <div className="px-2 py-3">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={data} margin={{ top: 8, right: 10, left: -18, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="g" tick={{ fill: "#8a9ea6", fontSize: 10 }} stroke="rgba(255,255,255,0.15)" />
            <YAxis tick={{ fill: "#8a9ea6", fontSize: 10 }} stroke="rgba(255,255,255,0.15)" width={34} />
            <Tooltip
              contentStyle={{ background: BG_CELL, border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: "#c8d3cc" }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {arr.map((sp, i) => (
              <Line
                key={sp.id}
                type="monotone"
                dataKey={sp.id}
                name={sp.name}
                stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/* ── Stacked bar: what a player's total is made of ─────────
 * One bar per player, split into the components that sum to the total —
 * goals + assists = points for skaters, W/L/OTL = decisions for goalies.
 * Uses season totals (not per-game data), so it reads straight off the
 * leaderboard payload.
 */
export type StackPart = { key: string; label: string; color: string };
/** `key` holds each part's value; `name`/`short` are the tooltip/axis labels. */
export type StackRow = { name: string; short: string; total: number; [k: string]: string | number };

export function StackedTotalsBar({
  rows,
  parts,
  title,
  note,
  height,
}: {
  rows: StackRow[];
  parts: StackPart[];
  title: string;
  note: string;
  /** Defaults to ~22px per bar so long lists (all 32 teams) stay readable. */
  height?: number;
}) {
  if (rows.length === 0) return null;
  const chartHeight = height ?? Math.max(300, rows.length * 22 + 60);

  return (
    <div className="rounded-2xl border border-white/20 overflow-hidden" style={{ background: BG_CARD }}>
      <div className="px-4 pt-3 pb-2 border-b border-white/10">
        <p className="text-white text-sm font-semibold">{title}</p>
        <p className="text-[#8a9ea6] text-[11px]">{note}</p>
      </div>
      <div className="px-2 py-3">
        {/* Horizontal layout: value along X, one row per player down Y — names
            read straight across, so no rotated labels. */}
        <ResponsiveContainer width="100%" height={chartHeight}>
          <BarChart data={rows} layout="vertical" margin={{ top: 8, right: 14, left: 4, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
            <XAxis
              type="number"
              tick={{ fill: "#8a9ea6", fontSize: 10 }}
              stroke="rgba(255,255,255,0.15)"
            />
            <YAxis
              type="category"
              dataKey="short"
              tick={{ fill: "#8a9ea6", fontSize: 10 }}
              stroke="rgba(255,255,255,0.15)"
              interval={0}
              width={82}
            />
            <Tooltip
              cursor={{ fill: "rgba(255,255,255,0.04)" }}
              contentStyle={{ background: BG_CELL, border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, fontSize: 12 }}
              labelStyle={{ color: "#c8d3cc" }}
              // The axis shows surnames to stay readable; the tooltip shows the full name.
              labelFormatter={(label, payload) =>
                (payload?.[0]?.payload as { name?: string })?.name ?? String(label)
              }
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            {parts.map((p) => (
              <Bar
                key={p.key}
                dataKey={p.key}
                name={p.label}
                stackId="total"
                fill={p.color}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/* ── Pie breakdowns ────────────────────────────────────────
 * Home/away results, plus each player's share of the team's points and goals.
 */
export function PieBreakdowns({
  title,
  teamSeason,
  skaters,
  season,
  accent,
  t,
}: {
  title: string;
  teamSeason: TeamSeasonOfficial | null;
  skaters: PlayerSeasons[];
  season: number | null;
  accent: string;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  const rec = teamSeason?.record ?? null;

  const resultSlices: PieSlice[] = rec
    ? [
        { label: t("chart.pie.wonHome"), value: rec.home.w, color: "#4ade80" },
        { label: t("chart.pie.wonAway"), value: rec.away.w, color: "#22d3ee" },
        { label: t("chart.pie.lostHome"), value: rec.home.l + rec.home.otl, color: "#f87171" },
        { label: t("chart.pie.lostAway"), value: rec.away.l + rec.away.otl, color: "#fb923c" },
      ]
    : [];
  const totalGp = rec ? rec.overall.w + rec.overall.l + rec.overall.otl : 0;

  const shareSlices = (key: keyof PlayerSeasonStat): PieSlice[] => {
    const arr = skaters
      .map((p) => ({ name: p.name, v: (p.seasons.find((s) => s.seasonId === season)?.[key] as number) ?? 0 }))
      .filter((x) => x.v > 0)
      .sort((a, b) => b.v - a.v);
    const top = arr.slice(0, 8);
    const rest = arr.slice(8).reduce((s, x) => s + x.v, 0);
    const slices: PieSlice[] = top.map((x, i) => ({
      label: x.name,
      value: x.v,
      color: SERIES_COLORS[i % SERIES_COLORS.length],
    }));
    if (rest > 0) slices.push({ label: t("chart.others"), value: rest, color: "#4b5563" });
    return slices;
  };

  const pointSlices = shareSlices("points");
  const goalSlices = shareSlices("goals");

  const pies: { title: string; slices: PieSlice[]; center?: string; sub?: string }[] = [
    { title: t("chart.pie.results"), slices: resultSlices, center: totalGp ? String(totalGp) : undefined, sub: "GP" },
    { title: t("chart.pie.pointShare"), slices: pointSlices },
    { title: t("chart.pie.goalShare"), slices: goalSlices },
  ].filter((p) => p.slices.length > 0);

  if (pies.length === 0) return null;

  return (
    <div className="rounded-2xl border border-white/20 p-4" style={{ background: BG_CARD }}>
      <p className="text-white text-sm font-semibold mb-3" style={{ color: accent }}>{title}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {pies.map((pie) => (
          <div key={pie.title} className="rounded-xl p-3" style={{ background: BG_CELL }}>
            <p className="text-[#c8d3cc] text-xs font-semibold mb-2 text-center">{pie.title}</p>
            <FactorPie slices={pie.slices} vertical size={120} thickness={18} centerLabel={pie.center} centerSub={pie.sub} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Team stats table (rows = official metrics) ─────────── */
export function TeamStatsTable({
  title,
  teamSeason,
  opponent,
  oppSelect,
  accent,
  t,
}: {
  title: string;
  teamSeason: TeamSeasonOfficial | null;
  opponent: string;
  oppSelect: ReactNode;
  accent: string;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  const o = teamSeason?.official ?? null;
  const vo = opponent ? teamSeason?.vsOpponent[opponent] : undefined;

  const rows: { label: string; total: string; avg: string; vs: string }[] = o
    ? [
        { label: t("chart.tm.goalsFor"),     total: int(o.goalsFor),     avg: num2(o.goalsForPerGame),     vs: vo ? num2(per(vo.goalsFor, vo.gp)) : DASH },
        { label: t("chart.tm.goalsAgainst"), total: int(o.goalsAgainst), avg: num2(o.goalsAgainstPerGame), vs: vo ? num2(per(vo.goalsAgainst, vo.gp)) : DASH },
        { label: t("chart.tm.goalDiff"),     total: sign(o.goalsFor - o.goalsAgainst), avg: snum2(o.goalsForPerGame - o.goalsAgainstPerGame), vs: vo ? snum2(per(vo.goalsFor - vo.goalsAgainst, vo.gp)) : DASH },
        { label: t("chart.tm.shots"),        total: int(o.shotsForPerGame * o.gamesPlayed), avg: num2(o.shotsForPerGame), vs: DASH },
        { label: t("chart.tm.wins"),         total: int(o.wins),         avg: num2(per(o.wins, o.gamesPlayed)), vs: vo ? num2(per(vo.wins, vo.gp)) : DASH },
        { label: t("chart.tm.points"),       total: int(o.points),       avg: num2(per(o.points, o.gamesPlayed)), vs: DASH },
      ]
    : [];

  return (
    <div className="rounded-2xl border border-white/20 overflow-hidden" style={{ background: BG_CARD }}>
      <div className="px-4 pt-3 pb-2 border-b border-white/10">
        <p className="text-white text-sm font-semibold">{title}</p>
      </div>
      {!teamSeason ? (
        <div className="px-4 py-6 flex flex-col gap-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-6 rounded animate-pulse" style={{ background: BG_CELL }} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-[#8a9ea6] text-sm">{t("chart.noData")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="text-[#8a9ea6]">
                <th className="text-left font-semibold px-4 py-2 sticky left-0 z-10" style={{ background: BG_CARD }}>&nbsp;</th>
                <th className="font-semibold px-3 py-2 text-center">{t("chart.col.total")}</th>
                <th className="font-semibold px-3 py-2 text-center">{t("chart.col.perGame")}</th>
                <th className="px-3 py-2 whitespace-nowrap">{oppSelect}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className="border-t border-white/[0.06]">
                  <td className="px-4 py-2.5 sticky left-0 z-10 whitespace-nowrap text-white font-medium" style={{ background: BG_CARD }}>
                    {r.label}
                  </td>
                  <td className="px-3 py-2.5 text-center tabular-nums text-white">{r.total}</td>
                  <td className="px-3 py-2.5 text-center tabular-nums text-[#c8d3cc]">{r.avg}</td>
                  <td className="px-3 py-2.5 text-center tabular-nums" style={{ color: accent }}>{r.vs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ── Team trends table ─────────────────────────────────────
 * Rate & record stats that don't fit the per-game model → a 2-column
 * Season / vs-opponent layout. Easy to extend with more rows later.
 */
export function TeamTrendsTable({
  title,
  teamSeason,
  opponent,
  oppSelect,
  accent,
  t,
}: {
  title: string;
  teamSeason: TeamSeasonOfficial | null;
  opponent: string;
  oppSelect: ReactNode;
  accent: string;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  const o = teamSeason?.official ?? null;
  const rec = teamSeason?.record ?? null;
  const vo = opponent ? teamSeason?.vsOpponent[opponent] : undefined;
  const fmtRec = (r?: { w: number; l: number; otl: number }) =>
    r ? `${r.w}-${r.l}-${r.otl}` : DASH;
  const pct = (v?: number | null) => (v == null ? DASH : `${v.toFixed(1)}%`);

  const rows: { label: string; season: string; vs: string }[] = [
    ...(o
      ? [
          { label: t("chart.tm.pointPct"),   season: pct(o.pointPct),   vs: DASH },
          { label: t("chart.tm.ppPct"),      season: pct(o.ppPct),      vs: DASH },
          { label: t("chart.tm.pkPct"),      season: pct(o.pkPct),      vs: DASH },
          { label: t("chart.tm.faceoffPct"), season: pct(o.faceoffPct), vs: DASH },
        ]
      : []),
    ...(rec
      ? [
          { label: t("chart.tm.record"),  season: fmtRec(rec.overall), vs: vo ? `${vo.wins}-${vo.losses}-${vo.otLosses}` : DASH },
          { label: t("chart.tm.home"),    season: fmtRec(rec.home),    vs: DASH },
          { label: t("chart.tm.away"),    season: fmtRec(rec.away),    vs: DASH },
          { label: t("chart.tm.last10"),  season: fmtRec(rec.last10),  vs: DASH },
          { label: t("chart.tm.streak"),  season: rec.streak || DASH,  vs: DASH },
          { label: t("chart.tm.oneGoal"), season: fmtRec(rec.oneGoal), vs: DASH },
        ]
      : []),
  ];

  return (
    <div className="rounded-2xl border border-white/20 overflow-hidden" style={{ background: BG_CARD }}>
      <div className="px-4 pt-3 pb-2 border-b border-white/10">
        <p className="text-white text-sm font-semibold">{title}</p>
      </div>
      {!teamSeason ? (
        <div className="px-4 py-6 flex flex-col gap-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-6 rounded animate-pulse" style={{ background: BG_CELL }} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-[#8a9ea6] text-sm">{t("chart.noData")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="text-[#8a9ea6]">
                <th className="text-left font-semibold px-4 py-2 sticky left-0 z-10" style={{ background: BG_CARD }}>&nbsp;</th>
                <th className="font-semibold px-3 py-2 text-center">{t("chart.col.season")}</th>
                <th className="px-3 py-2 whitespace-nowrap">{oppSelect}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label} className="border-t border-white/[0.06]">
                  <td className="px-4 py-2.5 sticky left-0 z-10 whitespace-nowrap text-white font-medium" style={{ background: BG_CARD }}>
                    {r.label}
                  </td>
                  <td className="px-3 py-2.5 text-center tabular-nums text-white">{r.season}</td>
                  <td className="px-3 py-2.5 text-center tabular-nums" style={{ color: accent }}>{r.vs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
