/**
 * chartsMetrics.ts
 *
 * Extrait de ChartPage.tsx le 2026-08-10 (3106 lignes → 11 fichiers).
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import type { PlayerSeasonStat, OpponentSplit, SeriesGame } from "../../services/nhlApiService";
import { DASH, SortDir, int, num2, pct1, per, sign, snum2, svpct, toiFmt } from "./chartsTheme";

/* ── Metric model (player table) ───────────────────────────
 * Each metric renders three columns (Total / Avg-per-game / vs-opponent) and
 * exposes the raw numbers so the columns can be sorted.
 */
export type PMetric = {
  key: string;
  label: string;
  total: (s: PlayerSeasonStat) => string;
  avg: (s: PlayerSeasonStat) => string;
  vs: (o: OpponentSplit) => string;
  totalNum: (s: PlayerSeasonStat) => number | null;
  avgNum: (s: PlayerSeasonStat) => number | null;
  vsNum: (o: OpponentSplit) => number | null;
  seriesVal: (g: SeriesGame) => number | null; // per-game value for the line chart
  cumulative: boolean;                          // running total (counting) vs raw (rate)
};

/** Counting-stat metric (per-game = total ÷ gp). */
function countMetric(key: keyof PlayerSeasonStat, label: string, signed = false): PMetric {
  const f = signed ? snum2 : num2;
  const tf = signed ? sign : int;
  const raw = (s: PlayerSeasonStat) => (s[key] as number | null | undefined) ?? null;
  const rawO = (o: OpponentSplit) => ((o as Record<string, number>)[key as string]) ?? 0;
  return {
    key: key as string,
    label,
    total: (s) => tf(raw(s)),
    avg: (s) => f(per(raw(s) ?? 0, s.gp)),
    vs: (o) => f(per(rawO(o), o.gp)),
    totalNum: raw,
    avgNum: (s) => per(raw(s) ?? 0, s.gp),
    vsNum: (o) => per(rawO(o), o.gp),
    seriesVal: (g) => ((g as Record<string, number>)[key as string]) ?? 0,
    cumulative: true,
  };
}

export type TFn = (k: string, v?: Record<string, string | number>) => string;

/** Skater metric set (Points, Goals, …) — shared by team + player charts. */
export function buildSkaterMetrics(t: TFn): PMetric[] {
  return [
    countMetric("points", t("chart.m.points")),
    countMetric("goals", t("chart.m.goals")),
    countMetric("assists", t("chart.m.assists")),
    countMetric("plusMinus", t("chart.m.plusMinus"), true),
    countMetric("shots", t("chart.m.shots")),
    countMetric("ppPoints", t("chart.m.ppPoints")),
  ];
}

/** Goalie metric set (Wins, SV%, GAA, SO) — shared by team + player charts. */
export function buildGoalieMetrics(t: TFn): PMetric[] {
  return [
    countMetric("wins", t("chart.m.wins")),
    {
      key: "savePct",
      label: t("chart.m.savePct"),
      total: (s) => svpct(s.savePct),
      avg: () => DASH,
      vs: (o) => (o.shotsAgainst && o.shotsAgainst > 0 ? svpct((o.saves ?? 0) / o.shotsAgainst) : DASH),
      totalNum: (s) => s.savePct ?? null,
      avgNum: () => null,
      vsNum: (o) => (o.shotsAgainst && o.shotsAgainst > 0 ? (o.saves ?? 0) / o.shotsAgainst : null),
      seriesVal: (g) => g.savePct ?? null,
      cumulative: false,
    },
    {
      key: "gaa",
      label: t("chart.m.gaa"),
      total: (s) => num2(s.gaa),
      avg: () => DASH,
      vs: (o) => num2(per(o.goalsAgainst ?? 0, o.gp)),
      totalNum: (s) => s.gaa ?? null,
      avgNum: () => null,
      vsNum: (o) => per(o.goalsAgainst ?? 0, o.gp),
      seriesVal: (g) => g.goalsAgainst ?? null,
      cumulative: false,
    },
    countMetric("shutouts", t("chart.m.shutouts")),
  ];
}

/* ── Extra metrics (player breakdown only) ─────────────────
 * These don't have opponent-split or per-game series data behind them, so
 * they're kept out of buildSkaterMetrics/buildGoalieMetrics — adding them
 * there would leak into the team page's line-chart metric picker and render
 * an empty/flat chart. The player page's breakdown table has no chart, so
 * that constraint doesn't apply here.
 */
export function buildSkaterExtraMetrics(t: TFn): PMetric[] {
  return [
    {
      key: "shootingPct",
      label: t("chart.m.shootingPct"),
      total: (s) => pct1(s.shootingPct),
      avg: () => DASH,
      vs: (o) => (o.shots && o.shots > 0 ? pct1(((o.goals ?? 0) / o.shots) * 100) : DASH),
      totalNum: (s) => s.shootingPct ?? null,
      avgNum: () => null,
      vsNum: (o) => (o.shots && o.shots > 0 ? ((o.goals ?? 0) / o.shots) * 100 : null),
      seriesVal: () => null,
      cumulative: false,
    },
    {
      key: "pim",
      label: t("chart.m.pim"),
      total: (s) => int(s.pim),
      avg: (s) => num2(per(s.pim ?? 0, s.gp)),
      vs: () => DASH,
      totalNum: (s) => s.pim ?? null,
      avgNum: (s) => per(s.pim ?? 0, s.gp),
      vsNum: () => null,
      seriesVal: (g) => g.pim ?? null,
      cumulative: true,
    },
    {
      key: "powerPlayGoals",
      label: t("chart.m.ppg"),
      total: (s) => int(s.powerPlayGoals),
      avg: (s) => num2(per(s.powerPlayGoals ?? 0, s.gp)),
      vs: () => DASH,
      totalNum: (s) => s.powerPlayGoals ?? null,
      avgNum: (s) => per(s.powerPlayGoals ?? 0, s.gp),
      vsNum: () => null,
      seriesVal: (g) => g.powerPlayGoals ?? null,
      cumulative: true,
    },
    {
      key: "shorthandedPoints",
      label: t("chart.m.shp"),
      total: (s) => int(s.shorthandedPoints),
      avg: (s) => num2(per(s.shorthandedPoints ?? 0, s.gp)),
      vs: () => DASH,
      totalNum: (s) => s.shorthandedPoints ?? null,
      avgNum: (s) => per(s.shorthandedPoints ?? 0, s.gp),
      vsNum: () => null,
      seriesVal: (g) => g.shorthandedPoints ?? null,
      cumulative: true,
    },
    {
      key: "faceoffPct",
      label: t("chart.tm.faceoffPct"),
      total: (s) => pct1(s.faceoffPct),
      avg: () => DASH,
      vs: () => DASH,
      totalNum: (s) => s.faceoffPct ?? null,
      avgNum: () => null,
      vsNum: () => null,
      seriesVal: () => null,
      cumulative: false,
    },
    {
      key: "avgToi",
      label: t("chart.m.toi"),
      total: (s) => toiFmt(s.avgToi),
      avg: () => DASH,
      vs: () => DASH,
      totalNum: (s) => s.avgToi ?? null,
      avgNum: () => null,
      vsNum: () => null,
      seriesVal: () => null,
      cumulative: false,
    },
  ];
}

export function buildGoalieExtraMetrics(t: TFn): PMetric[] {
  return [
    {
      key: "losses",
      label: t("chart.m.losses"),
      total: (s) => int(s.losses),
      avg: (s) => num2(per(s.losses ?? 0, s.gp)),
      vs: () => DASH,
      totalNum: (s) => s.losses ?? null,
      avgNum: (s) => per(s.losses ?? 0, s.gp),
      vsNum: () => null,
      seriesVal: (g) => g.losses ?? null,
      cumulative: true,
    },
    {
      key: "otLosses",
      label: t("chart.m.otLosses"),
      total: (s) => int(s.otLosses),
      avg: (s) => num2(per(s.otLosses ?? 0, s.gp)),
      vs: () => DASH,
      totalNum: (s) => s.otLosses ?? null,
      avgNum: (s) => per(s.otLosses ?? 0, s.gp),
      vsNum: () => null,
      seriesVal: (g) => g.otLosses ?? null,
      cumulative: true,
    },
  ];
}

/** Direction the server already sorts a leader metric in: GAA is "lower is
 *  better", everything else is "higher is better". Rows arrive in this order,
 *  so the table only has to reverse them when the user asks for the opposite. */
export function naturalSortDir(key: string): SortDir {
  return key === "gaa" ? "asc" : "desc";
}
