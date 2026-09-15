/**
 * TeamCharts.tsx
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
import type { TeamPlayerSeasons, PlayerSeasons, PlayerSeasonStat, TeamOpponentSplits, OpponentSplit, TeamSeasonOfficial } from "../../services/nhlApiService";
import type { NHLTeamInfo } from "../../types/bet";
import { CardsSkeleton, ChartMessage, OpponentSelect, SortHead, TeamSelect } from "./ChartControls";
import { PieBreakdowns, PlayerLineChart, TeamStatsTable, TeamTrendsTable } from "./ChartVisuals";
import { buildGoalieMetrics, buildSkaterMetrics } from "./chartsMetrics";
import { BG_CARD, BG_CELL, DASH, PosFilter, SortCol, SortDir, View, seasonLabel, selectCls } from "./chartsTheme";

export function TeamCharts({ teamId }: { teamId?: string }) {
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
          <TeamSelect
            value={teamId ? teamId.toLowerCase() : ""}
            onChange={(abbr) => navigate(abbr ? `/stats/chart/team/${abbr}` : "/stats/chart/team")}
            teams={teamOptions}
          />
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
        <ChartMessage large>{t("chart.choosePrompt")}</ChartMessage>
      ) : loading ? (
        <CardsSkeleton />
      ) : error || !playerSeasons ? (
        <ChartMessage>{t("chart.noData")}</ChartMessage>
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
