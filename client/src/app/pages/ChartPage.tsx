import { useParams, useNavigate } from "react-router";
import { useEffect, useState, useRef, type ReactNode } from "react";
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
} from "../services/nhlApiService";
import type { NHLTeamInfo } from "../types/bet";
import { FactorPie } from "../components/FactorPie";
import type { PieSlice } from "../components/FactorPie";
import {
  ResponsiveContainer,
  LineChart,
  Line,
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

/* ── Value formatters ──────────────────────────────────── */
const int = (v?: number | null) => (v == null ? DASH : String(Math.round(v)));
const sign = (v?: number | null) => (v == null ? DASH : v > 0 ? `+${v}` : String(v));
const num2 = (v?: number | null) => (v == null ? DASH : v.toFixed(2));
const snum2 = (v?: number | null) =>
  v == null ? DASH : v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2);
const svpct = (v?: number | null) => (v == null ? DASH : v.toFixed(3).replace(/^0/, ""));
const per = (v?: number | null, gp?: number | null) =>
  v != null && gp && gp > 0 ? v / gp : null;

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
 * player's current-season breakdown (Total / per-game / vs-opponent) plus a
 * per-game line chart. Reuses the same endpoints as the team charts — the
 * player list comes from the team's player-seasons, and vs/series data from the
 * team's opponent-splits.
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
  const [opponent, setOpponent] = useState<string>("");
  const [metricKey, setMetricKey] = useState<string>("points");
  const [splits, setSplits] = useState<TeamOpponentSplits | null>(null);
  const [splitsLoading, setSplitsLoading] = useState(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState(false);

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

  // Opponent splits + per-game series (for the vs column and the line chart).
  useEffect(() => {
    if (!teamAbbr || season == null) { setSplits(null); setSplitsLoading(false); return; }
    let alive = true;
    setSplits(null);
    setSplitsLoading(true);
    nhlApiService
      .getTeamOpponentSplits(teamAbbr, season)
      .then((sp) => { if (alive) setSplits(sp); })
      .catch(() => { if (alive) setSplits(null); })
      .finally(() => { if (alive) setSplitsLoading(false); });
    return () => { alive = false; };
  }, [teamAbbr, season]);

  // Keep the URL in sync so a chosen player is shareable / refresh-safe.
  useEffect(() => {
    if (playerId) navigate(`/stats/chart/player/${playerId}`, { replace: true });
  }, [playerId, navigate]);

  const skaters = playerSeasons?.skaters ?? [];
  const goalies = playerSeasons?.goalies ?? [];
  const selected = [...skaters, ...goalies].find((p) => p.id === playerId) ?? null;
  const isGoalie = !!selected && goalies.some((g) => g.id === selected.id);

  const metrics = isGoalie ? buildGoalieMetrics(t) : buildSkaterMetrics(t);
  const metric = metrics.find((m) => m.key === metricKey) ?? metrics[0];

  const teamOptions = [...teams].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  const abbr = (playerSeasons?.teamAbbr ?? teamAbbr ?? "").toUpperCase();
  const opponentTeams = teams
    .filter((x) => x.abbreviation && x.abbreviation.toUpperCase() !== abbr)
    .sort((a, b) => (a.abbreviation ?? "").localeCompare(b.abbreviation ?? ""));

  // Selected player's current-season stat + vs/series data.
  const stat = selected?.seasons.find((s) => s.seasonId === season) ?? null;
  const splitGroup = (isGoalie ? splits?.goalies : splits?.skaters) ?? [];
  const mySplit = splitGroup.find((p) => p.id === playerId);
  const vsObj = opponent ? mySplit?.vs[opponent] : undefined;
  const seriesById = new Map<string, SeriesGame[]>(selected ? [[selected.id, mySplit?.series ?? []]] : []);

  const makeOppSelect = () => (
    <OpponentSelect
      opponent={opponent}
      onChange={setOpponent}
      teams={opponentTeams}
      accent={accent}
      placeholder={t("chart.allOpponents")}
    />
  );

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

          {/* Current-season breakdown: rows = metrics, cols = Total / per-game / vs */}
          <div className="rounded-2xl border border-white/20 overflow-hidden" style={{ background: BG_CARD }}>
            <div className="px-4 pt-3 pb-2 border-b border-white/10">
              <p className="text-white text-sm font-semibold">{t("chart.playerStats")}</p>
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
                      <th className="px-3 py-2 whitespace-nowrap">{makeOppSelect()}</th>
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
                          <td className="px-3 py-2.5 text-center tabular-nums" style={{ color: accent }}>
                            {opponent ? (vsObj ? m.vs(vsObj) : DASH) : DASH}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Per-game line chart for the selected metric */}
          {splitsLoading ? (
            <div className="rounded-2xl border border-white/20 p-4" style={{ background: BG_CARD }}>
              <div className="h-4 w-40 rounded animate-pulse mb-3" style={{ background: BG_CELL }} />
              <div className="h-[240px] rounded-xl animate-pulse" style={{ background: BG_CELL }} />
            </div>
          ) : (
            <PlayerLineChart
              players={[{ id: selected.id, name: selected.name }]}
              seriesById={seriesById}
              metric={metric}
              title={`${metric.label} ${t("chart.byGame")}`}
              note={metric.cumulative ? t("chart.playerCumNote") : t("chart.playerRateNote")}
            />
          )}
        </>
      )}
    </div>
  );
}

/* ── Charts page shell ─────────────────────────────────────
 * Mirrors the prediction page layout on the lighter Charts palette, with the
 * framed CHART label reused as the page title.
 */
export function ChartPage() {
  const { type, id } = useParams<{ type: string; id: string }>();
  const navigate = useNavigate();
  const { t } = useI18n();

  const content =
    type === "player" ? (
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
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="text-[#3a5060] text-lg">
            ←
          </button>
          <div className="flex-1">
            <FramedLabel text={t("chart.title")} />
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">{content}</div>

      <BottomNav />
    </div>
  );
}
