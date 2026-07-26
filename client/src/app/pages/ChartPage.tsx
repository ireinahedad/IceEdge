import { useParams, useNavigate } from "react-router";
import { useEffect, useState, useRef, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { BottomNav } from "../components/BottomNav";
import { FramedLabel } from "../components/brand/FramedLabel";
import { useSport } from "../context/SportContext";
import { useI18n } from "../i18n";
import { nhlLogoUrl } from "../data/teamEmoji";
import { nhlApiService } from "../services/nhlApiService";
import type {
  TeamPlayerSeasons,
  PlayerSeasons,
  PlayerSeasonStat,
  TeamOpponentSplits,
  OpponentSplit,
  TeamSeasonOfficial,
  SeriesGame,
  PlayerLeaders,
  TeamSeasonRow,
  AllTeamsSeason,
} from "../services/nhlApiService";
import type { NHLTeamInfo, NHLPlayerInfo, NHLGame } from "../types/bet";
import { FactorPie } from "../components/FactorPie";
import type { PieSlice } from "../components/FactorPie";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";

// Distinct line/slice colours cycled across players.
const SERIES_COLORS = [
  "#86d1ea", "#4ade80", "#facc15", "#f472b6", "#a78bfa", "#fb923c",
  "#38bdf8", "#34d399", "#f87171", "#c084fc", "#2dd4bf", "#e879f9",
];

/* ── Palette ───────────────────────────────────────────────
 * Same visual language as the prediction page, but every surface is nudged a
 * shade lighter so the user recognises they are on the Charts page.
 */
const BG_PAGE = "#12180F";
const BG_HEADER = "rgba(18,24,15,0.92)";
const BG_CARD = "#1A2216";
const BG_CELL = "#12180F";

type View = "skater" | "goalie";
type PosFilter = "all" | "forwards" | "defense";
type SortCol = "name" | "total" | "avg" | "vs";
type SortDir = "asc" | "desc";
const DASH = "—";

const selectCls =
  "rounded-full px-3 py-1.5 text-xs font-semibold border border-white/15 outline-none";

/** 20252026 → "25/26" */
function seasonLabel(id: number): string {
  const s = String(id);
  return s.length === 8 ? `${s.slice(2, 4)}/${s.slice(6, 8)}` : s;
}

/** Current NHL season id (e.g. 20252026). Mirrors the server's rollover rule:
 *  a new season starts in October, so months before that belong to the
 *  previous season's id. */
const currentSeasonId = (() => {
  const now = new Date();
  const y = now.getMonth() >= 9 ? now.getFullYear() : now.getFullYear() - 1;
  return Number(`${y}${y + 1}`);
})();

/* ── Value formatters ──────────────────────────────────── */
const int = (v?: number | null) => (v == null ? DASH : String(Math.round(v)));
const sign = (v?: number | null) => (v == null ? DASH : v > 0 ? `+${v}` : String(v));
const num2 = (v?: number | null) => (v == null ? DASH : v.toFixed(2));
const snum2 = (v?: number | null) =>
  v == null ? DASH : v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2);
const svpct = (v?: number | null) => (v == null ? DASH : v.toFixed(3).replace(/^0/, ""));
const per = (v?: number | null, gp?: number | null) =>
  v != null && gp && gp > 0 ? v / gp : null;
const pct1 = (v?: number | null) => (v == null ? DASH : `${v.toFixed(1)}%`);
/** Decimal minutes (e.g. 21.87) → "MM:SS" for time-on-ice display. */
const toiFmt = (v?: number | null) => {
  if (v == null) return DASH;
  const m = Math.floor(v);
  const s = Math.round((v - m) * 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

/* ── Metric model (player table) ───────────────────────────
 * Each metric renders three columns (Total / Avg-per-game / vs-opponent) and
 * exposes the raw numbers so the columns can be sorted.
 */
type PMetric = {
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

type TFn = (k: string, v?: Record<string, string | number>) => string;

/** Skater metric set (Points, Goals, …) — shared by team + player charts. */
function buildSkaterMetrics(t: TFn): PMetric[] {
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
function buildGoalieMetrics(t: TFn): PMetric[] {
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
function buildSkaterExtraMetrics(t: TFn): PMetric[] {
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

function buildGoalieExtraMetrics(t: TFn): PMetric[] {
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
function naturalSortDir(key: string): SortDir {
  return key === "gaa" ? "asc" : "desc";
}

/* ── Opponent picker (lives in the vs-column header) ──────── */
function OpponentSelect({
  opponent,
  onChange,
  teams,
  accent,
  placeholder,
}: {
  opponent: string;
  onChange: (abbr: string) => void;
  teams: NHLTeamInfo[];
  accent: string;
  placeholder: string;
}) {
  return (
    <div className="flex items-center justify-center gap-1">
      <span className="text-[#8a9ea6]">vs</span>
      <select
        value={opponent}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md px-1.5 py-0.5 text-[11px] font-semibold border border-white/15 outline-none max-w-[7.5rem]"
        style={{ background: BG_CELL, color: opponent ? accent : "#8a9ea6" }}
        aria-label={placeholder}
      >
        <option value="">{placeholder}</option>
        {teams.map((x) => (
          <option key={x.abbreviation} value={x.abbreviation?.toUpperCase()}>
            {x.abbreviation?.toUpperCase()}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Sortable column header. */
function SortHead({
  label,
  active,
  dir,
  onClick,
  align = "center",
  accent,
}: {
  label: ReactNode;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  align?: "left" | "center";
  accent: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-1 ${align === "left" ? "justify-start" : "justify-center"}`}
      style={{ color: active ? accent : undefined }}
    >
      <span className="font-semibold">{label}</span>
      <span className="text-[9px] w-2">{active ? (dir === "asc" ? "▲" : "▼") : ""}</span>
    </button>
  );
}

function TeamCharts({ teamId }: { teamId?: string }) {
  const { t } = useI18n();
  const { theme } = useSport();
  const navigate = useNavigate();
  const accent = theme.accent;

  const [playerSeasons, setPlayerSeasons] = useState<TeamPlayerSeasons | null>(null);
  const [teams, setTeams] = useState<NHLTeamInfo[]>([]);
  const [loading, setLoading] = useState<boolean>(!!teamId);
  const [error, setError] = useState(false);

  const [view, setView] = useState<View>("skater");
  const [season, setSeason] = useState<number | null>(null);
  const [opponent, setOpponent] = useState<string>("");
  const [metricKey, setMetricKey] = useState<string>("points");
  const [posFilter, setPosFilter] = useState<PosFilter>("all");
  const [sortCol, setSortCol] = useState<SortCol>("total");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const [splits, setSplits] = useState<TeamOpponentSplits | null>(null);
  const [splitsLoading, setSplitsLoading] = useState(false);
  const [teamSeason, setTeamSeason] = useState<TeamSeasonOfficial | null>(null);

  // Team list (for the picker + opponent dropdown) — fetched once.
  useEffect(() => {
    let alive = true;
    nhlApiService.getAllTeams().then((tm) => { if (alive) setTeams(tm); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Player-season history (drives the year dropdown) — only when a team is chosen.
  useEffect(() => {
    if (!teamId) { setPlayerSeasons(null); setSeason(null); setLoading(false); setError(false); return; }
    let alive = true;
    setLoading(true);
    setError(false);
    nhlApiService
      .getTeamPlayerSeasons(teamId)
      .then((ps) => { if (!alive) return; setPlayerSeasons(ps); setSeason(ps.seasonIds[0] ?? null); })
      .catch((e) => { console.error("TeamCharts load error", e); if (alive) setError(true); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [teamId]);

  // Official team stats (fast) — lets the stats tables render first.
  useEffect(() => {
    if (!teamId || season == null) { setTeamSeason(null); return; }
    let alive = true;
    setTeamSeason(null);
    nhlApiService.getTeamSeasonOfficial(teamId, season).then((ts) => { if (alive) setTeamSeason(ts); }).catch(() => {});
    return () => { alive = false; };
  }, [teamId, season]);

  // Opponent splits + per-game series (slow: one game-log call per player) —
  // fetched separately so the graphs load AFTER the stats are already on screen.
  useEffect(() => {
    if (!teamId || season == null) { setSplits(null); setSplitsLoading(false); return; }
    let alive = true;
    setSplits(null);
    setSplitsLoading(true);
    nhlApiService
      .getTeamOpponentSplits(teamId, season)
      .then((sp) => { if (alive) setSplits(sp); })
      .catch(() => { if (alive) setSplits(null); })
      .finally(() => { if (alive) setSplitsLoading(false); });
    return () => { alive = false; };
  }, [teamId, season]);

  const info = teams.find((x) => x.abbreviation?.toLowerCase() === (teamId ?? "").toLowerCase());
  const abbr = (playerSeasons?.teamAbbr ?? teamId ?? "").toUpperCase();
  const teamName = info?.name ?? playerSeasons?.teamAbbr ?? (teamId ? teamId.toUpperCase() : "");

  const skaterMetrics = buildSkaterMetrics(t);
  const goalieMetrics = buildGoalieMetrics(t);

  const metrics = view === "skater" ? skaterMetrics : goalieMetrics;
  const metric = metrics.find((m) => m.key === metricKey) ?? metrics[0];

  const allPlayers: PlayerSeasons[] =
    (view === "skater" ? playerSeasons?.skaters : playerSeasons?.goalies) ?? [];
  const splitGroup = (view === "skater" ? splits?.skaters : splits?.goalies) ?? [];
  const splitById = new Map(splitGroup.map((p) => [p.id, p.vs] as const));

  const opponentTeams = teams
    .filter((x) => x.abbreviation && x.abbreviation.toUpperCase() !== abbr)
    .sort((a, b) => (a.abbreviation ?? "").localeCompare(b.abbreviation ?? ""));

  const teamOptions = [...teams].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

  // Filter (position) → build sortable rows → sort.
  const filtered = allPlayers.filter((p) => {
    if (view !== "skater" || posFilter === "all") return true;
    const def = p.position === "D";
    return posFilter === "defense" ? def : !def;
  });

  type Row = { p: PlayerSeasons; s: PlayerSeasonStat; vsObj?: OpponentSplit };
  const rows: Row[] = filtered
    .map((p) => ({ p, s: p.seasons.find((x) => x.seasonId === season) }))
    .filter((r): r is Row => !!r.s)
    .map((r) => ({ ...r, vsObj: opponent ? splitById.get(r.p.id)?.[opponent] : undefined }));

  const sortVal = (r: Row): number | string | null => {
    if (sortCol === "name") return r.p.name;
    if (sortCol === "total") return metric.totalNum(r.s);
    if (sortCol === "avg") return metric.avgNum(r.s);
    return r.vsObj ? metric.vsNum(r.vsObj) : null;
  };
  rows.sort((a, b) => {
    const va = sortVal(a);
    const vb = sortVal(b);
    if (typeof va === "string" || typeof vb === "string") {
      const cmp = String(va ?? "").localeCompare(String(vb ?? ""));
      return sortDir === "asc" ? cmp : -cmp;
    }
    if (va == null && vb == null) return 0;
    if (va == null) return 1; // nulls last
    if (vb == null) return -1;
    return sortDir === "asc" ? va - vb : vb - va;
  });

  const toggleSort = (col: SortCol) => {
    if (col === sortCol) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortCol(col);
      setSortDir(col === "name" ? "asc" : "desc");
    }
  };

  // Line-chart inputs: per-game series keyed by player id, and the top-8 players
  // (by the selected metric) among the currently filtered set.
  const LINE_CAP = 8;
  const seriesById = new Map(splitGroup.map((p) => [p.id, p.series] as const));
  const chartPlayers = [...rows]
    .sort((a, b) => (metric.totalNum(b.s) ?? -Infinity) - (metric.totalNum(a.s) ?? -Infinity))
    .slice(0, LINE_CAP)
    .map((r) => ({ id: r.p.id, name: r.p.name }));

  const makeOppSelect = () => (
    <OpponentSelect
      opponent={opponent}
      onChange={setOpponent}
      teams={opponentTeams}
      accent={accent}
      placeholder={t("chart.allOpponents")}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Team hero + team picker */}
      <div
        className="rounded-2xl border border-white/20 p-4 flex items-center gap-3"
        style={{ background: BG_CARD }}
      >
        {teamId ? (
          <>
            <img src={nhlLogoUrl(abbr)} alt={teamName} className="w-12 h-12 object-contain" />
            <div className="flex-1 min-w-0">
              <p className="text-white font-bold text-base truncate">{teamName}</p>
              <p className="text-[#8a9ea6] text-xs">{t("chart.last6")}</p>
            </div>
          </>
        ) : (
          <div className="flex-1 min-w-0">
            <p className="text-white font-bold text-base">{t("chart.title")}</p>
            <p className="text-[#8a9ea6] text-xs">{t("chart.noTeam")}</p>
          </div>
        )}
        <div className="flex flex-col gap-1.5 shrink-0">
          <select
            value={teamId ? teamId.toLowerCase() : ""}
            onChange={(e) => navigate(e.target.value ? `/stats/chart/team/${e.target.value}` : "/stats/chart/team")}
            className={selectCls}
            style={{ background: BG_CELL, color: teamId ? "#c8d3cc" : "#8a9ea6" }}
            aria-label={t("chart.team")}
          >
            <option value="">{t("chart.noTeam")}</option>
            {teamOptions.map((x) => (
              <option key={x.abbreviation} value={x.abbreviation?.toLowerCase()}>
                {x.abbreviation?.toUpperCase()}
              </option>
            ))}
          </select>
          <button
            onClick={() => navigate("/stats/chart/all-teams")}
            className={selectCls}
            style={{ background: BG_CELL, color: accent, borderColor: accent + "66" }}
          >
            {t("chart.allTeams")}
          </button>
        </div>
      </div>

      {!teamId ? (
        <div className="rounded-2xl border border-white/10 p-8 text-center" style={{ background: BG_CARD }}>
          <p className="text-[#8a9ea6] text-sm">{t("chart.choosePrompt")}</p>
        </div>
      ) : loading ? (
        <div className="flex flex-col gap-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 rounded-2xl animate-pulse" style={{ background: BG_CARD }} />
          ))}
        </div>
      ) : error || !playerSeasons ? (
        <div className="rounded-2xl border border-white/10 p-6 text-center" style={{ background: BG_CARD }}>
          <p className="text-[#8a9ea6] text-sm">{t("chart.noData")}</p>
        </div>
      ) : (
        <>
          {/* Controls: Skater/Goalie · Season · Position filter */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-full p-0.5 border border-white/15" style={{ background: BG_CELL }}>
              {(["skater", "goalie"] as View[]).map((v) => {
                const active = view === v;
                return (
                  <button
                    key={v}
                    onClick={() => setView(v)}
                    className="px-3.5 py-1.5 rounded-full text-xs font-semibold transition-colors"
                    style={active ? { background: accent, color: "#0A0E0C" } : { color: "#8a9ea6" }}
                  >
                    {v === "skater" ? t("chart.skaters") : t("chart.goalies")}
                  </button>
                );
              })}
            </div>

            <select
              value={season ?? ""}
              onChange={(e) => setSeason(Number(e.target.value))}
              className={selectCls}
              style={{ background: BG_CELL, color: "#c8d3cc" }}
              aria-label={t("chart.season")}
            >
              {playerSeasons.seasonIds.map((id) => (
                <option key={id} value={id}>
                  {seasonLabel(id)}
                </option>
              ))}
            </select>

            {view === "skater" && (
              <select
                value={posFilter}
                onChange={(e) => setPosFilter(e.target.value as PosFilter)}
                className={selectCls}
                style={{ background: BG_CELL, color: posFilter === "all" ? "#8a9ea6" : accent }}
                aria-label={t("chart.position")}
              >
                <option value="all">{t("chart.pos.all")}</option>
                <option value="forwards">{t("chart.pos.forwards")}</option>
                <option value="defense">{t("chart.pos.defense")}</option>
              </select>
            )}
          </div>

          {/* ── Team Stats table (per-game counting stats) ── */}
          <TeamStatsTable
            title={t("chart.teamStats")}
            teamSeason={teamSeason}
            opponent={opponent}
            oppSelect={makeOppSelect()}
            accent={accent}
            t={t}
          />

          {/* ── Team Trends table (rate + record stats) ── */}
          <TeamTrendsTable
            title={t("chart.teamTrends")}
            teamSeason={teamSeason}
            opponent={opponent}
            oppSelect={makeOppSelect()}
            accent={accent}
            t={t}
          />

          {/* ── Player Stats table (below the team tables) ── */}
          <div className="rounded-2xl border border-white/20 overflow-hidden" style={{ background: BG_CARD }}>
            <div className="px-4 pt-3 pb-2 border-b border-white/10">
              <p className="text-white text-sm font-semibold mb-2">{t("chart.playerStats")}</p>
              <div className="flex flex-wrap gap-1.5">
                {metrics.map((m) => {
                  const active = m.key === metric.key;
                  return (
                    <button
                      key={m.key}
                      onClick={() => setMetricKey(m.key)}
                      className="px-3 py-1 rounded-full text-[11px] font-semibold transition-colors"
                      style={
                        active
                          ? { background: accent + "22", color: accent, border: `1px solid ${accent}66` }
                          : { background: BG_CELL, color: "#8a9ea6", border: "1px solid transparent" }
                      }
                    >
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr className="text-[#8a9ea6]">
                    <th className="px-4 py-2 sticky left-0 z-10" style={{ background: BG_CARD }}>
                      <SortHead label={t("chart.player")} align="left" active={sortCol === "name"} dir={sortDir} onClick={() => toggleSort("name")} accent={accent} />
                    </th>
                    <th className="px-3 py-2 whitespace-nowrap">
                      <SortHead label={metric.label} active={sortCol === "total"} dir={sortDir} onClick={() => toggleSort("total")} accent={accent} />
                    </th>
                    <th className="px-3 py-2 whitespace-nowrap">
                      <SortHead label={t("chart.col.perGame")} active={sortCol === "avg"} dir={sortDir} onClick={() => toggleSort("avg")} accent={accent} />
                    </th>
                    <th className="px-3 py-2 whitespace-nowrap">{makeOppSelect()}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ p, s, vsObj }) => (
                    <tr
                      key={p.id}
                      onClick={() => navigate(`/stats/chart/player/${p.id}`)}
                      className="border-t border-white/[0.06] cursor-pointer hover:bg-white/[0.04] transition-colors"
                    >
                      <td className="px-4 py-2.5 sticky left-0 z-10 whitespace-nowrap" style={{ background: BG_CARD }}>
                        <span className="text-white font-medium">{p.name}</span>
                        <span className="text-[#5c6f63] ml-1.5">{p.position}</span>
                        <span className="text-[#5c6f63] ml-1.5">›</span>
                      </td>
                      <td className="px-3 py-2.5 text-center tabular-nums text-white">{metric.total(s)}</td>
                      <td className="px-3 py-2.5 text-center tabular-nums text-[#c8d3cc]">{metric.avg(s)}</td>
                      <td className="px-3 py-2.5 text-center tabular-nums" style={{ color: accent }}>
                        {opponent ? (vsObj ? metric.vs(vsObj) : DASH) : DASH}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ── Player line chart — loads after the stats tables ── */}
          {splitsLoading ? (
            <div className="rounded-2xl border border-white/20 p-4" style={{ background: BG_CARD }}>
              <div className="h-4 w-40 rounded animate-pulse mb-3" style={{ background: BG_CELL }} />
              <div className="h-[240px] rounded-xl animate-pulse" style={{ background: BG_CELL }} />
            </div>
          ) : (
            <PlayerLineChart
              players={chartPlayers}
              seriesById={seriesById}
              metric={metric}
              title={`${metric.label} ${t("chart.byGame")}`}
              note={t("chart.cumNote", { n: chartPlayers.length })}
            />
          )}

          {/* ── Pie breakdowns (under everything) ── */}
          <PieBreakdowns
            title={t("chart.breakdowns")}
            teamSeason={teamSeason}
            skaters={playerSeasons.skaters}
            season={season}
            accent={accent}
            t={t}
          />
        </>
      )}
    </div>
  );
}

/* ── Player line chart ─────────────────────────────────────
 * One line per player. Counting metrics accumulate over games (a diverging
 * "who's producing" view); rate metrics (SV%, GAA) plot the per-game value.
 */
function PlayerLineChart({
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

/* ── Player search box ─────────────────────────────────────
 * Debounced league-wide player lookup. Used on the charts pages to jump
 * straight to someone's stats without going through their team first.
 */
function PlayerSearchBox({
  placeholder,
  onPick,
}: {
  placeholder: string;
  onPick: (p: NHLPlayerInfo) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NHLPlayerInfo[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); setSearching(false); return; }
    let alive = true;
    setSearching(true);
    const handle = setTimeout(() => {
      nhlApiService
        .searchPlayers(q)
        .then((res) => { if (alive) setResults(res); })
        .catch(() => { if (alive) setResults([]); })
        .finally(() => { if (alive) setSearching(false); });
    }, 300);
    return () => { alive = false; clearTimeout(handle); };
  }, [query]);

  return (
    <div className="relative">
      <div
        className="flex items-center gap-2 rounded-xl border border-white/15 px-3 py-2"
        style={{ background: BG_CELL }}
      >
        <Search size={14} className="text-[#8a9ea6] flex-shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          className="flex-1 bg-transparent text-white text-sm outline-none placeholder:text-[#5c6f63]"
        />
        {query && (
          <button onClick={() => setQuery("")} className="text-[#8a9ea6] hover:text-white transition-colors">
            <X size={13} />
          </button>
        )}
      </div>

      {query.trim().length >= 2 && (
        <div
          className="absolute left-0 right-0 top-full mt-1 z-20 max-h-60 overflow-y-auto rounded-xl border border-white/15 shadow-xl"
          style={{ background: "#1A2216" }}
        >
          {searching ? (
            <p className="text-[#5c6f63] text-[11px] text-center py-3">…</p>
          ) : results.length > 0 ? (
            results.map((p) => (
              <button
                key={String(p.id)}
                onClick={() => { onPick(p); setQuery(""); setResults([]); }}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-white/[0.06] transition-colors"
              >
                <span className="text-white text-[12px] font-medium truncate">{p.name}</span>
                <span className="text-[#8a9ea6] text-[10px] flex-shrink-0">
                  {String((p as unknown as { teamId?: string }).teamId ?? "").toUpperCase()} · {p.position}
                </span>
              </button>
            ))
          ) : (
            <p className="text-[#5c6f63] text-[11px] text-center py-3">{t("chart.noResults")}</p>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Stacked bar: what a player's total is made of ─────────
 * One bar per player, split into the components that sum to the total —
 * goals + assists = points for skaters, W/L/OTL = decisions for goalies.
 * Uses season totals (not per-game data), so it reads straight off the
 * leaderboard payload.
 */
type StackPart = { key: string; label: string; color: string };
/** `key` holds each part's value; `name`/`short` are the tooltip/axis labels. */
type StackRow = { name: string; short: string; total: number; [k: string]: string | number };

function StackedTotalsBar({
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
function PieBreakdowns({
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
function TeamStatsTable({
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
function TeamTrendsTable({
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

/* ── Player charts ─────────────────────────────────────────
 * Bet365-style single-player view: pick a team, then a player, and see that
 * player's current-season breakdown (Total / per-game / vs-another-player).
 * The 4th column lets you search any other skater or goalie and drops their
 * stat line in for a side-by-side comparison, plus a points-share pie chart.
 * Reuses the team charts' player-seasons endpoint for both the main player and
 * whoever is picked to compare against.
 */
function PlayerCharts({ initialPlayerId }: { initialPlayerId?: string }) {
  const { t } = useI18n();
  const { theme } = useSport();
  const navigate = useNavigate();
  const accent = theme.accent;

  const [teams, setTeams] = useState<NHLTeamInfo[]>([]);
  const [teamAbbr, setTeamAbbr] = useState<string>("");
  const [playerSeasons, setPlayerSeasons] = useState<TeamPlayerSeasons | null>(null);
  const [playerId, setPlayerId] = useState<string>(initialPlayerId ?? "");
  const [season, setSeason] = useState<number | null>(null);
  const [metricKey, setMetricKey] = useState<string>("points");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState(false);

  // Player-vs-player comparison (search another player and show stats side by side).
  const [compareQuery, setCompareQuery] = useState<string>("");
  const [compareResults, setCompareResults] = useState<NHLPlayerInfo[]>([]);
  const [compareSearching, setCompareSearching] = useState(false);
  const [compareSelected, setCompareSelected] = useState<NHLPlayerInfo | null>(null);
  const [comparePlayerSeasons, setComparePlayerSeasons] = useState<TeamPlayerSeasons | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);

  // Team list (team picker + opponent dropdown) — fetched once.
  useEffect(() => {
    let alive = true;
    nhlApiService.getAllTeams().then((tm) => { if (alive) setTeams(tm); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Deep-link support: resolve a bare player id (e.g. from the team table) to
  // its team so the pickers populate. Runs once on mount.
  const bootRef = useRef(false);
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    if (!initialPlayerId) return;
    nhlApiService
      .getPlayer(initialPlayerId)
      .then((info) => { if (info?.teamAbbr) setTeamAbbr(info.teamAbbr.toLowerCase()); })
      .catch(() => {});
  }, [initialPlayerId]);

  // Roster seasons for the chosen team → drives the player + season dropdowns.
  useEffect(() => {
    if (!teamAbbr) { setPlayerSeasons(null); setSeason(null); setLoading(false); setError(false); return; }
    let alive = true;
    setLoading(true);
    setError(false);
    nhlApiService
      .getTeamPlayerSeasons(teamAbbr)
      .then((ps) => {
        if (!alive) return;
        setPlayerSeasons(ps);
        setSeason(ps.seasonIds[0] ?? null);
        // Keep the current player if they belong to this team, else default to the first.
        setPlayerId((cur) => {
          const exists = [...ps.skaters, ...ps.goalies].some((p) => p.id === cur);
          if (exists) return cur;
          const first = ps.skaters[0] ?? ps.goalies[0];
          return first ? first.id : "";
        });
      })
      .catch((e) => { console.error("PlayerCharts load error", e); if (alive) setError(true); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [teamAbbr]);

  // Keep the URL in sync so a chosen player is shareable / refresh-safe.
  useEffect(() => {
    if (playerId) navigate(`/stats/chart/player/${playerId}`, { replace: true });
  }, [playerId, navigate]);

  const skaters = playerSeasons?.skaters ?? [];
  const goalies = playerSeasons?.goalies ?? [];
  const selected = [...skaters, ...goalies].find((p) => p.id === playerId) ?? null;
  const isGoalie = !!selected && goalies.some((g) => g.id === selected.id);

  const metrics = isGoalie
    ? [...buildGoalieMetrics(t), ...buildGoalieExtraMetrics(t)]
    : [...buildSkaterMetrics(t), ...buildSkaterExtraMetrics(t)];
  const metric = metrics.find((m) => m.key === metricKey) ?? metrics[0];

  const teamOptions = [...teams].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  const abbr = (playerSeasons?.teamAbbr ?? teamAbbr ?? "").toUpperCase();

  // Selected player's current-season stat.
  const stat = selected?.seasons.find((s) => s.seasonId === season) ?? null;

  // Debounced player search — same-position players only (skater vs skater,
  // goalie vs goalie), excluding the currently viewed player.
  useEffect(() => {
    const q = compareQuery.trim();
    if (q.length < 2) { setCompareResults([]); setCompareSearching(false); return; }
    let alive = true;
    setCompareSearching(true);
    const handle = setTimeout(() => {
      nhlApiService
        .searchPlayers(q)
        .then((res) => {
          if (!alive) return;
          const filtered = res.filter((p) => {
            const isG = (p.position ?? "").toUpperCase() === "G";
            return isG === isGoalie && String(p.id) !== playerId;
          });
          setCompareResults(filtered);
        })
        .catch(() => { if (alive) setCompareResults([]); })
        .finally(() => { if (alive) setCompareSearching(false); });
    }, 300);
    return () => { alive = false; clearTimeout(handle); };
  }, [compareQuery, isGoalie, playerId]);

  // Once a comparison player is picked, pull their team roster's player-seasons
  // (same endpoint as the main view) to find their stat line for this season.
  useEffect(() => {
    if (!compareSelected) { setComparePlayerSeasons(null); return; }
    // NHLPlayerInfo.teamId is typed as a numeric team id elsewhere, but the
    // /players/search endpoint actually returns the team abbreviation here.
    const cmpAbbr = String((compareSelected as unknown as { teamId?: string }).teamId ?? "").toUpperCase();
    if (!cmpAbbr) { setComparePlayerSeasons(null); return; }
    let alive = true;
    setCompareLoading(true);
    setComparePlayerSeasons(null);
    nhlApiService
      .getTeamPlayerSeasons(cmpAbbr)
      .then((ps) => { if (alive) setComparePlayerSeasons(ps); })
      .catch(() => { if (alive) setComparePlayerSeasons(null); })
      .finally(() => { if (alive) setCompareLoading(false); });
    return () => { alive = false; };
  }, [compareSelected]);

  const compareEntry = comparePlayerSeasons
    ? [...comparePlayerSeasons.skaters, ...comparePlayerSeasons.goalies].find(
        (p) => compareSelected != null && p.id === String(compareSelected.id)
      )
    : null;
  const compareStat = compareEntry?.seasons.find((s) => s.seasonId === season) ?? null;

  const headshot =
    selected && season != null && abbr
      ? `https://assets.nhle.com/mugs/nhl/${season}/${abbr}/${selected.id}.png`
      : "";

  return (
    <div className="flex flex-col gap-4">
      {/* Identity + team/player pickers */}
      <div
        className="rounded-2xl border border-white/20 p-4 flex items-center gap-3"
        style={{ background: BG_CARD }}
      >
        {selected ? (
          <>
            <img
              src={headshot || nhlLogoUrl(abbr)}
              alt={selected.name}
              className="w-12 h-12 rounded-full object-cover bg-black/20"
              onError={(e) => { (e.currentTarget as HTMLImageElement).src = nhlLogoUrl(abbr); }}
            />
            <div className="flex-1 min-w-0">
              <p className="text-white font-bold text-base truncate">{selected.name}</p>
              <p className="text-[#8a9ea6] text-xs">
                {[selected.position, selected.number ? `#${selected.number}` : "", abbr].filter(Boolean).join(" · ")}
              </p>
            </div>
          </>
        ) : (
          <div className="flex-1 min-w-0">
            <p className="text-white font-bold text-base">{t("chart.title")}</p>
            <p className="text-[#8a9ea6] text-xs">{t("chart.choosePlayerPrompt")}</p>
          </div>
        )}
        <div className="flex flex-col gap-1.5 shrink-0">
          <select
            value={teamAbbr}
            onChange={(e) => setTeamAbbr(e.target.value)}
            className={selectCls}
            style={{ background: BG_CELL, color: teamAbbr ? "#c8d3cc" : "#8a9ea6" }}
            aria-label={t("chart.team")}
          >
            <option value="">{t("chart.noTeam")}</option>
            {teamOptions.map((x) => (
              <option key={x.abbreviation} value={x.abbreviation?.toLowerCase()}>
                {x.abbreviation?.toUpperCase()}
              </option>
            ))}
          </select>
          <select
            value={playerId}
            onChange={(e) => setPlayerId(e.target.value)}
            disabled={!playerSeasons}
            className={selectCls}
            style={{ background: BG_CELL, color: playerId ? "#c8d3cc" : "#8a9ea6", opacity: playerSeasons ? 1 : 0.5, maxWidth: "10rem" }}
            aria-label={t("chart.player")}
          >
            <option value="">{t("chart.noPlayer")}</option>
            {skaters.length > 0 && (
              <optgroup label={t("chart.skaters")}>
                {skaters.map((p) => (
                  <option key={p.id} value={p.id}>{p.number ? `#${p.number} ` : ""}{p.name}</option>
                ))}
              </optgroup>
            )}
            {goalies.length > 0 && (
              <optgroup label={t("chart.goalies")}>
                {goalies.map((p) => (
                  <option key={p.id} value={p.id}>{p.number ? `#${p.number} ` : ""}{p.name}</option>
                ))}
              </optgroup>
            )}
          </select>
          <button
            onClick={() => navigate("/stats/chart/all-players")}
            className={selectCls}
            style={{ background: BG_CELL, color: accent, borderColor: accent + "66" }}
          >
            {t("chart.allPlayers")}
          </button>
        </div>
      </div>

      {!teamAbbr ? (
        <div className="rounded-2xl border border-white/10 p-8 text-center" style={{ background: BG_CARD }}>
          <p className="text-[#8a9ea6] text-sm">{t("chart.choosePlayerPrompt")}</p>
        </div>
      ) : loading ? (
        <div className="flex flex-col gap-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-24 rounded-2xl animate-pulse" style={{ background: BG_CARD }} />
          ))}
        </div>
      ) : error || !playerSeasons ? (
        <div className="rounded-2xl border border-white/10 p-6 text-center" style={{ background: BG_CARD }}>
          <p className="text-[#8a9ea6] text-sm">{t("chart.noData")}</p>
        </div>
      ) : !selected ? (
        <div className="rounded-2xl border border-white/10 p-6 text-center" style={{ background: BG_CARD }}>
          <p className="text-[#8a9ea6] text-sm">{t("chart.choosePlayerPrompt")}</p>
        </div>
      ) : (
        <>
          {/* Season picker */}
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={season ?? ""}
              onChange={(e) => setSeason(Number(e.target.value))}
              className={selectCls}
              style={{ background: BG_CELL, color: "#c8d3cc" }}
              aria-label={t("chart.season")}
            >
              {playerSeasons.seasonIds.map((sid) => (
                <option key={sid} value={sid}>{seasonLabel(sid)}</option>
              ))}
            </select>
          </div>

          {/* Current-season breakdown: rows = metrics, cols = Total / per-game / compare-player.
              The 4th column replaces the old "vs opponent team" split with a
              searchable "vs another player" comparison — pick someone and their
              stat line drops straight into this column. */}
          <div className="rounded-2xl border border-white/20 overflow-hidden" style={{ background: BG_CARD }}>
            <div className="px-4 pt-3 pb-2 border-b border-white/10 flex items-center justify-between gap-2">
              <p className="text-white text-sm font-semibold flex-shrink-0">{t("chart.playerStats")}</p>
              <div className="relative">
                {compareSelected ? (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-semibold truncate max-w-[7rem]" style={{ color: "#facc15" }}>
                      {compareSelected.name}
                    </span>
                    <button
                      onClick={() => { setCompareSelected(null); setComparePlayerSeasons(null); }}
                      className="text-[#8a9ea6] hover:text-white transition-colors flex-shrink-0"
                      aria-label={t("chart.compare.title")}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ) : (
                  <div
                    className="flex items-center gap-1.5 rounded-full border border-white/15 px-2.5 py-1"
                    style={{ background: BG_CELL }}
                  >
                    <Search size={12} className="text-[#8a9ea6] flex-shrink-0" />
                    <input
                      value={compareQuery}
                      onChange={(e) => setCompareQuery(e.target.value)}
                      placeholder={t("chart.compare.search")}
                      className="w-28 bg-transparent text-white text-[11px] outline-none placeholder:text-[#5c6f63]"
                    />
                  </div>
                )}

                {!compareSelected && compareQuery.trim().length >= 2 && (
                  <div
                    className="absolute right-0 top-full mt-1 z-20 w-60 max-h-60 overflow-y-auto rounded-xl border border-white/15 shadow-xl"
                    style={{ background: "#1A2216" }}
                  >
                    {compareSearching ? (
                      <p className="text-[#5c6f63] text-[11px] text-center py-3">…</p>
                    ) : compareResults.length > 0 ? (
                      compareResults.map((p) => (
                        <button
                          key={String(p.id)}
                          onClick={() => { setCompareSelected(p); setCompareQuery(""); setCompareResults([]); }}
                          className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-white/[0.06] transition-colors"
                        >
                          <span className="text-white text-[11px] font-medium truncate">{p.name}</span>
                          <span className="text-[#8a9ea6] text-[10px] flex-shrink-0">
                            {String((p as unknown as { teamId?: string }).teamId ?? "").toUpperCase()} · {p.position}
                          </span>
                        </button>
                      ))
                    ) : (
                      <p className="text-[#5c6f63] text-[11px] text-center py-3">{t("chart.compare.noResults")}</p>
                    )}
                  </div>
                )}
              </div>
            </div>
            {!stat ? (
              <p className="px-4 py-6 text-center text-[#8a9ea6] text-sm">{t("chart.noData")}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="text-[#8a9ea6]">
                      <th className="text-left font-semibold px-4 py-2 sticky left-0 z-10" style={{ background: BG_CARD }}>
                        GP {int(stat.gp)}
                      </th>
                      <th className="font-semibold px-3 py-2 text-center">{t("chart.col.total")}</th>
                      <th className="font-semibold px-3 py-2 text-center">{t("chart.col.perGame")}</th>
                      <th className="font-semibold px-3 py-2 text-center whitespace-nowrap truncate max-w-[6rem]" style={{ color: compareSelected ? "#facc15" : undefined }}>
                        {compareSelected ? compareSelected.name : t("chart.compare.column")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.map((m) => {
                      const active = m.key === metric.key;
                      return (
                        <tr
                          key={m.key}
                          onClick={() => setMetricKey(m.key)}
                          className="border-t border-white/[0.06] cursor-pointer hover:bg-white/[0.04] transition-colors"
                          style={active ? { background: accent + "12" } : undefined}
                        >
                          <td className="px-4 py-2.5 sticky left-0 z-10 whitespace-nowrap font-medium" style={{ background: active ? undefined : BG_CARD, color: active ? accent : "#fff" }}>
                            {m.label}
                          </td>
                          <td className="px-3 py-2.5 text-center tabular-nums text-white">{m.total(stat)}</td>
                          <td className="px-3 py-2.5 text-center tabular-nums text-[#c8d3cc]">{m.avg(stat)}</td>
                          <td className="px-3 py-2.5 text-center tabular-nums" style={{ color: "#facc15" }}>
                            {compareLoading ? "…" : compareSelected && compareStat ? m.total(compareStat) : DASH}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Points breakdown (skaters only): share of points from goals vs assists ── */}
          {!isGoalie && stat && (stat.points ?? 0) > 0 && (
            <div className="rounded-2xl border border-white/20 p-4" style={{ background: BG_CARD }}>
              <p className="text-white text-sm font-semibold mb-3">{t("chart.pie.pointsBreakdown")}</p>
              <div className="rounded-xl p-3" style={{ background: BG_CELL }}>
                <FactorPie
                  slices={[
                    { label: t("chart.m.goals"), value: stat.goals ?? 0, color: "#4ade80" },
                    { label: t("chart.m.assists"), value: stat.assists ?? 0, color: "#86d1ea" },
                  ]}
                  vertical
                  size={140}
                  thickness={20}
                  centerLabel={String(stat.points ?? 0)}
                  centerSub={t("chart.pie.pts")}
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ── All players (league leaders) ───────────────────────────
 * Top N players for a season across the same metric set as the single-player
 * page. Sorting happens server-side (the NHL summary endpoints support it), so
 * picking a metric re-fetches rather than re-sorting a partial list — that way
 * "top 20 by PIM" really is the league's top 20, not the top 20 scorers
 * re-ordered by PIM.
 */
function AllPlayersCharts() {
  const { t } = useI18n();
  const { theme } = useSport();
  const navigate = useNavigate();
  const accent = theme.accent;

  const LIMIT = 20;   // rows in the leaderboard table
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
    : [...buildSkaterMetrics(t), ...buildSkaterExtraMetrics(t)];
  const metric = metrics.find((m) => m.key === sortKey) ?? metrics[0];

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    nhlApiService
      .getPlayerLeaders(view, sortKey, LIMIT, season)
      .then((res) => { if (alive) setData(res); })
      .catch((e) => { console.error("AllPlayersCharts load error", e); if (alive) setError(true); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [view, sortKey, season]);

  // Six most recent seasons, counting back from the current one.
  const seasonOptions = Array.from({ length: 6 }, (_, i) => {
    const y = Math.floor(currentSeasonId / 10000) - i;
    return Number(`${y}${y + 1}`);
  });

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
          <select
            value={season}
            onChange={(e) => setSeason(Number(e.target.value))}
            className={selectCls}
            style={{ background: BG_CELL, color: "#c8d3cc" }}
            aria-label={t("chart.season")}
          >
            {seasonOptions.map((sid) => (
              <option key={sid} value={sid}>{seasonLabel(sid)}</option>
            ))}
          </select>
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
          <div className="flex flex-wrap gap-1.5">
            {metrics.map((m) => {
              const isActive = m.key === metric.key;
              return (
                <button
                  key={m.key}
                  onClick={() => toggleSort(m.key)}
                  className="px-3 py-1 rounded-full text-[11px] font-semibold transition-colors"
                  style={
                    isActive
                      ? { background: accent + "22", color: accent, border: `1px solid ${accent}66` }
                      : { background: BG_CELL, color: "#8a9ea6", border: "1px solid transparent" }
                  }
                >
                  {m.label}
                  {isActive && <span className="ml-1 text-[9px]">{sortDir === "asc" ? "▲" : "▼"}</span>}
                </button>
              );
            })}
          </div>
        </div>

        {loading ? (
          <div className="px-4 py-6 flex flex-col gap-2">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="h-6 rounded animate-pulse" style={{ background: BG_CELL }} />
            ))}
          </div>
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
        <div className="rounded-2xl border border-white/20 p-4" style={{ background: BG_CARD }}>
          <div className="h-4 w-40 rounded animate-pulse mb-3" style={{ background: BG_CELL }} />
          <div className="h-[280px] rounded-xl animate-pulse" style={{ background: BG_CELL }} />
        </div>
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

function AllTeamsCharts() {
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

  const seasonOptions = Array.from({ length: 6 }, (_, i) => {
    const y = Math.floor(currentSeasonId / 10000) - i;
    return Number(`${y}${y + 1}`);
  });

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
          <select
            value={season}
            onChange={(e) => setSeason(Number(e.target.value))}
            className={selectCls}
            style={{ background: BG_CELL, color: "#c8d3cc" }}
            aria-label={t("chart.season")}
          >
            {seasonOptions.map((sid) => (
              <option key={sid} value={sid}>{seasonLabel(sid)}</option>
            ))}
          </select>
        </div>

        {/* All 32 teams are already loaded, so this filters locally. */}
        <div className="flex items-center gap-2 rounded-xl border border-white/15 px-3 py-2" style={{ background: BG_CELL }}>
          <Search size={14} className="text-[#8a9ea6] flex-shrink-0" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("chart.searchTeam")}
            className="flex-1 bg-transparent text-white text-sm outline-none placeholder:text-[#5c6f63]"
          />
          {query && (
            <button onClick={() => setQuery("")} className="text-[#8a9ea6] hover:text-white transition-colors">
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Standings table */}
      <div className="rounded-2xl border border-white/20 overflow-hidden" style={{ background: BG_CARD }}>
        <div className="px-4 pt-3 pb-2 border-b border-white/10">
          <p className="text-white text-sm font-semibold mb-2">{t("chart.teamStats")}</p>
          <div className="flex flex-wrap gap-1.5">
            {metrics.map((m) => {
              const isActive = m.key === metric.key;
              return (
                <button
                  key={m.key}
                  onClick={() => toggleSort(m.key)}
                  className="px-3 py-1 rounded-full text-[11px] font-semibold transition-colors"
                  style={
                    isActive
                      ? { background: accent + "22", color: accent, border: `1px solid ${accent}66` }
                      : { background: BG_CELL, color: "#8a9ea6", border: "1px solid transparent" }
                  }
                >
                  {m.label}
                  {isActive && <span className="ml-1 text-[9px]">{sort.dir === "asc" ? "▲" : "▼"}</span>}
                </button>
              );
            })}
          </div>
        </div>

        {loading ? (
          <div className="px-4 py-6 flex flex-col gap-2">
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="h-6 rounded animate-pulse" style={{ background: BG_CELL }} />
            ))}
          </div>
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
        <div className="rounded-2xl border border-white/20 p-4" style={{ background: BG_CARD }}>
          <div className="h-4 w-40 rounded animate-pulse mb-3" style={{ background: BG_CELL }} />
          <div className="h-[280px] rounded-xl animate-pulse" style={{ background: BG_CELL }} />
        </div>
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

/* ── All games (league schedule + results) ──────────────────
 * Same shell as the other overview pages: header card with a period picker and
 * search, then a sortable table. Charts deliberately left out for now.
 *
 * Scoped to one month at a time — a full season is ~1300 games, which is a lot
 * of rows to fetch and render at once when the useful view is "what happened
 * recently". The month list is built from the season bounds the NHL reports.
 */
type GMetric = {
  key: string;
  label: string;
  /** Sort value; null (unplayed game) always sorts last, either direction. */
  num: (g: NHLGame) => number | null;
};

/** "2026-04-16" → { y: 2026, m: 4 } (1-based month). */
function ymOf(iso: string): { y: number; m: number } {
  const [y, m] = iso.split("-").map(Number);
  return { y, m };
}
function ymKey(y: number, m: number): string {
  return `${y}-${String(m).padStart(2, "0")}`;
}
/** Inclusive first/last ISO date of a month. */
function monthRange(y: number, m: number): { start: string; end: string } {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${ymKey(y, m)}-01`, end: `${ymKey(y, m)}-${String(last).padStart(2, "0")}` };
}
/** ISO date + n days, in UTC so it can't drift across a DST boundary. */
function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

type GameRange = "5d" | "10d" | "month";

function AllGamesCharts() {
  const { t, lang } = useI18n();
  const { theme } = useSport();
  const navigate = useNavigate();
  const accent = theme.accent;
  const locale = lang === "fr" ? "fr-FR" : "en-US";

  const [today, setToday] = useState<string>("");
  const [months, setMonths] = useState<{ y: number; m: number }[]>([]);
  const [cursor, setCursor] = useState<{ y: number; m: number } | null>(null);
  const [range, setRange] = useState<GameRange>("5d");
  const [team, setTeam] = useState<string>("");
  // Full league list, so the picker stays stable when the range changes — a
  // team derived only from the loaded games would vanish and blank the select.
  const [teamOptions, setTeamOptions] = useState<string[]>([]);
  const [games, setGames] = useState<NHLGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [sort, setSort] = useState<{ key: string; dir: SortDir }>({ key: "date", dir: "desc" });

  useEffect(() => {
    let alive = true;
    nhlApiService
      .getAllTeams()
      .then((tm) => {
        if (!alive) return;
        setTeamOptions(
          tm.map((x) => (x.abbreviation ?? "").toUpperCase()).filter(Boolean).sort(),
        );
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // Season bounds come from the NHL's own calendar rather than the local clock,
  // matching how the schedule page anchors itself.
  useEffect(() => {
    let alive = true;
    nhlApiService
      .getScheduleAnchor()
      .then((a) => {
        if (!alive || !a?.today) return;
        const first = ymOf(a.seasonStart ?? a.today);
        const last = ymOf(a.seasonEnd ?? a.today);
        const list: { y: number; m: number }[] = [];
        let { y, m } = first;
        // Guard against a malformed range producing an unbounded loop.
        for (let i = 0; i < 24; i++) {
          list.push({ y, m });
          if (y === last.y && m === last.m) break;
          m += 1;
          if (m > 12) { m = 1; y += 1; }
        }
        setMonths(list);
        setToday(a.today);
        const tm = ymOf(a.today);
        setCursor(list.some((x) => x.y === tm.y && x.m === tm.m) ? tm : list[list.length - 1] ?? tm);
      })
      // Loading stays true on success — setting the anchor immediately kicks
      // off the games fetch below, so clearing it here would flash "no games".
      .catch(() => { if (alive) { setError(true); setLoading(false); } });
    return () => { alive = false; };
  }, []);

  // The fetch window: a rolling N days from today, or a whole calendar month.
  const win = (() => {
    if (range === "month") return cursor ? monthRange(cursor.y, cursor.m) : null;
    if (!today) return null;
    return { start: today, end: addDaysIso(today, range === "5d" ? 5 : 10) };
  })();

  useEffect(() => {
    if (!win) return;
    let alive = true;
    setLoading(true);
    setError(false);
    nhlApiService
      .getGamesRange(win.start, win.end)
      .then((g) => { if (alive) setGames(g); })
      .catch((e) => { console.error("AllGamesCharts load error", e); if (alive) setError(true); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // `win` is derived, so depend on its primitive bounds rather than identity.
  }, [win?.start, win?.end]);

  const totalOf = (g: NHLGame) =>
    g.homeTeam.score == null || g.awayTeam.score == null ? null : g.homeTeam.score + g.awayTeam.score;
  const marginOf = (g: NHLGame) =>
    g.homeTeam.score == null || g.awayTeam.score == null
      ? null
      : Math.abs(g.homeTeam.score - g.awayTeam.score);
  const statusLabel = (g: NHLGame) =>
    g.status === "final" ? t("chart.gm.final") : g.status === "live" ? t("chart.gm.live") : t("chart.gm.scheduled");

  const metrics: GMetric[] = [
    // "2026-04-16" → 20260416, so date sorts numerically without parsing.
    { key: "date",   label: t("chart.gm.date"),  num: (g) => Number(g.gameDate.replace(/-/g, "")) },
    { key: "total",  label: t("chart.gm.total"), num: totalOf },
    { key: "margin", label: t("chart.gm.diff"),  num: marginOf },
  ];
  const metric = metrics.find((m) => m.key === sort.key) ?? metrics[0];

  const toggleSort = (key: string) =>
    setSort((cur) => (cur.key === key ? { key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" }));

  const inTeam = (g: NHLGame) =>
    !team || g.homeTeam.abbreviation === team || g.awayTeam.abbreviation === team;
  const filtered = games.filter(inTeam);

  // Played games get the chosen sort. Upcoming ones are always soonest-first:
  // they have no score, so sorting them by total or margin is meaningless.
  const past = filtered
    .filter((g) => g.status === "final")
    .sort((a, b) => {
      const va = metric.num(a);
      const vb = metric.num(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return sort.dir === "asc" ? va - vb : vb - va;
    });
  const upcoming = filtered
    .filter((g) => g.status !== "final")
    .sort((a, b) => a.gameDate.localeCompare(b.gameDate));


  const monthLabel = (x: { y: number; m: number }) =>
    new Date(Date.UTC(x.y, x.m - 1, 1)).toLocaleDateString(locale, { month: "long", year: "numeric", timeZone: "UTC" });
  const dayLabel = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString(locale, { month: "short", day: "numeric", timeZone: "UTC" });

  const matchupCell = (g: NHLGame) => (
    <td className="px-3 py-2.5 sticky left-0 z-10 whitespace-nowrap" style={{ background: BG_CARD }}>
      <img src={nhlLogoUrl(g.awayTeam.abbreviation)} alt={g.awayTeam.abbreviation} className="w-4 h-4 object-contain inline-block mr-1 align-text-bottom" />
      <span className="text-white font-medium">{g.awayTeam.abbreviation}</span>
      <span className="text-[#5c6f63] mx-1.5">{t("schedule.at")}</span>
      <img src={nhlLogoUrl(g.homeTeam.abbreviation)} alt={g.homeTeam.abbreviation} className="w-4 h-4 object-contain inline-block mr-1 align-text-bottom" />
      <span className="text-white font-medium">{g.homeTeam.abbreviation}</span>
    </td>
  );

  const rangeLabel =
    range === "month"
      ? (cursor ? monthLabel(cursor) : "—")
      : range === "5d" ? t("chart.gm.next5") : t("chart.gm.next10");

  const skeleton = (
    <div className="px-4 py-6 flex flex-col gap-2">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="h-6 rounded animate-pulse" style={{ background: BG_CELL }} />
      ))}
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Header + range + team filter */}
      <div className="rounded-2xl border border-white/20 p-4 flex flex-col gap-3" style={{ background: BG_CARD }}>
        <div className="min-w-0">
          <p className="text-white font-bold text-base">{t("chart.allGames.title")}</p>
          <p className="text-[#8a9ea6] text-xs">
            {t("chart.allGames.note", { n: games.length, month: rangeLabel })}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-full p-0.5 border border-white/15" style={{ background: BG_CELL }}>
            {([
              { key: "5d" as GameRange,    label: t("chart.gm.next5") },
              { key: "10d" as GameRange,   label: t("chart.gm.next10") },
              { key: "month" as GameRange, label: t("chart.gm.month") },
            ]).map((r) => {
              const isActive = range === r.key;
              return (
                <button
                  key={r.key}
                  onClick={() => setRange(r.key)}
                  className="px-3 py-1.5 rounded-full text-xs font-semibold transition-colors whitespace-nowrap"
                  style={isActive ? { background: accent, color: "#0A0E0C" } : { color: "#8a9ea6" }}
                >
                  {r.label}
                </button>
              );
            })}
          </div>

          {/* Only relevant when browsing a whole month. */}
          {range === "month" && (
            <select
              value={cursor ? ymKey(cursor.y, cursor.m) : ""}
              onChange={(e) => {
                const [y, m] = e.target.value.split("-").map(Number);
                setCursor({ y, m });
              }}
              className={selectCls}
              style={{ background: BG_CELL, color: "#c8d3cc" }}
              aria-label={t("chart.gm.month")}
            >
              {months.map((x) => (
                <option key={ymKey(x.y, x.m)} value={ymKey(x.y, x.m)}>{monthLabel(x)}</option>
              ))}
            </select>
          )}

          {/* Filters what's already loaded — no refetch. */}
          <select
            value={team}
            onChange={(e) => setTeam(e.target.value)}
            className={selectCls}
            style={{ background: BG_CELL, color: team ? accent : "#8a9ea6" }}
            aria-label={t("chart.team")}
          >
            <option value="">{t("chart.gm.allTeams")}</option>
            {teamOptions.map((abbr) => (
              <option key={abbr} value={abbr}>{abbr}</option>
            ))}
          </select>
        </div>
      </div>

      {error ? (
        <div className="rounded-2xl border border-white/20 p-6 text-center" style={{ background: BG_CARD }}>
          <p className="text-[#8a9ea6] text-sm">{t("schedule.error")}</p>
        </div>
      ) : (
        <>
          {/* ── Results (games already played) ── */}
          <div className="rounded-2xl border border-white/20 overflow-hidden" style={{ background: BG_CARD }}>
            <div className="px-4 pt-3 pb-2 border-b border-white/10">
              <p className="text-white text-sm font-semibold mb-2">{t("chart.gm.results")}</p>
              <div className="flex flex-wrap gap-1.5">
                {metrics.map((m) => {
                  const isActive = m.key === metric.key;
                  return (
                    <button
                      key={m.key}
                      onClick={() => toggleSort(m.key)}
                      className="px-3 py-1 rounded-full text-[11px] font-semibold transition-colors"
                      style={
                        isActive
                          ? { background: accent + "22", color: accent, border: `1px solid ${accent}66` }
                          : { background: BG_CELL, color: "#8a9ea6", border: "1px solid transparent" }
                      }
                    >
                      {m.label}
                      {isActive && <span className="ml-1 text-[9px]">{sort.dir === "asc" ? "▲" : "▼"}</span>}
                    </button>
                  );
                })}
              </div>
            </div>

            {loading ? skeleton : past.length === 0 ? (
              <p className="px-4 py-6 text-center text-[#8a9ea6] text-sm">{t("chart.gm.noResults")}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="text-[#8a9ea6]">
                      <th className="text-left font-semibold px-3 py-2 sticky left-0 z-10" style={{ background: BG_CARD }}>
                        {t("chart.gm.matchup")}
                      </th>
                      <th className="px-3 py-2 whitespace-nowrap">
                        <SortHead label={t("chart.gm.date")} active={metric.key === "date"} dir={sort.dir} onClick={() => toggleSort("date")} accent={accent} />
                      </th>
                      <th className="font-semibold px-3 py-2 text-center">{t("chart.gm.score")}</th>
                      <th className="px-3 py-2 whitespace-nowrap">
                        <SortHead label={t("chart.gm.total")} active={metric.key === "total"} dir={sort.dir} onClick={() => toggleSort("total")} accent={accent} />
                      </th>
                      <th className="px-3 py-2 whitespace-nowrap">
                        <SortHead label={t("chart.gm.diff")} active={metric.key === "margin"} dir={sort.dir} onClick={() => toggleSort("margin")} accent={accent} />
                      </th>
                      <th className="font-semibold px-3 py-2 text-left whitespace-nowrap">{t("chart.gm.venue")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {past.map((g) => (
                      <tr
                        key={g.id}
                        onClick={() => navigate(`/stats/prediction/game/${g.id}`)}
                        className="border-t border-white/[0.06] cursor-pointer hover:bg-white/[0.04] transition-colors"
                      >
                        {matchupCell(g)}
                        <td
                          className="px-3 py-2.5 text-center tabular-nums whitespace-nowrap"
                          style={metric.key === "date" ? { color: accent, fontWeight: 600 } : { color: "#c8d3cc" }}
                        >
                          {dayLabel(g.gameDate)}
                        </td>
                        <td className="px-3 py-2.5 text-center tabular-nums text-white whitespace-nowrap">
                          {g.awayTeam.score} – {g.homeTeam.score}
                        </td>
                        <td className="px-3 py-2.5 text-center tabular-nums" style={metric.key === "total" ? { color: accent, fontWeight: 600 } : { color: "#fff" }}>
                          {totalOf(g) ?? DASH}
                        </td>
                        <td className="px-3 py-2.5 text-center tabular-nums" style={metric.key === "margin" ? { color: accent, fontWeight: 600 } : { color: "#fff" }}>
                          {marginOf(g) ?? DASH}
                        </td>
                        <td className="px-3 py-2.5 text-left text-[#8a9ea6] whitespace-nowrap max-w-[12rem] truncate">{g.venue || DASH}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* ── Upcoming (not yet final) — always soonest first ── */}
          <div className="rounded-2xl border border-white/20 overflow-hidden" style={{ background: BG_CARD }}>
            <div className="px-4 pt-3 pb-2 border-b border-white/10">
              <p className="text-white text-sm font-semibold">{t("chart.gm.upcoming")}</p>
            </div>

            {loading ? skeleton : upcoming.length === 0 ? (
              <p className="px-4 py-6 text-center text-[#8a9ea6] text-sm">{t("chart.gm.noUpcoming")}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="text-[#8a9ea6]">
                      <th className="text-left font-semibold px-3 py-2 sticky left-0 z-10" style={{ background: BG_CARD }}>
                        {t("chart.gm.matchup")}
                      </th>
                      <th className="font-semibold px-3 py-2 text-center">{t("chart.gm.date")}</th>
                      <th className="font-semibold px-3 py-2 text-center">{t("chart.gm.time")}</th>
                      <th className="font-semibold px-3 py-2 text-center">{t("chart.gm.status")}</th>
                      <th className="font-semibold px-3 py-2 text-left whitespace-nowrap">{t("chart.gm.venue")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {upcoming.map((g) => (
                      <tr
                        key={g.id}
                        onClick={() => navigate(`/stats/prediction/game/${g.id}`)}
                        className="border-t border-white/[0.06] cursor-pointer hover:bg-white/[0.04] transition-colors"
                      >
                        {matchupCell(g)}
                        <td className="px-3 py-2.5 text-center tabular-nums text-[#c8d3cc] whitespace-nowrap">{dayLabel(g.gameDate)}</td>
                        <td className="px-3 py-2.5 text-center tabular-nums text-white whitespace-nowrap">{g.startTime || DASH}</td>
                        <td className="px-3 py-2.5 text-center whitespace-nowrap">
                          <span
                            className="px-2 py-0.5 rounded-full text-[10px] font-semibold"
                            style={
                              g.status === "live"
                                ? { background: "#f8717122", color: "#f87171" }
                                : { background: accent + "22", color: accent }
                            }
                          >
                            {statusLabel(g)}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-left text-[#8a9ea6] whitespace-nowrap max-w-[12rem] truncate">{g.venue || DASH}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

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
  const { t } = useI18n();

  const content =
    type === "all-players" ? (
      <AllPlayersCharts />
    ) : type === "all-teams" ? (
      <AllTeamsCharts />
    ) : type === "all-games" ? (
      <AllGamesCharts />
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
    <div className="flex flex-col min-h-screen pb-24" style={{ background: BG_PAGE }}>
      <div
        className="sticky top-0 z-40 px-4 pt-12 pb-3"
        style={{ background: BG_HEADER, backdropFilter: "blur(16px)", borderBottom: "1px solid #2f3b28" }}
      >
        <div className="flex items-center gap-2">
          {/* Always returns to Stats rather than stepping back through history —
              charts link to each other (team → player → all-players), so a
              history-based back could land several charts deep. */}
          <button onClick={() => navigate("/stats")} className="text-[#3a5060] text-lg shrink-0" aria-label={t("stats.title")}>
            ←
          </button>
          <FramedLabel text={t("chart.title")} />
          <ChartNav type={type} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">{content}</div>

      <BottomNav />
    </div>
  );
}
