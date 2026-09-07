/**
 * AllGamesCharts.tsx
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
import type { NHLGame } from "../../types/bet";
import { SortHead } from "./ChartControls";
import { BG_CARD, BG_CELL, DASH, SortDir, selectCls } from "./chartsTheme";

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

export function AllGamesCharts() {
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
                        onClick={() => navigate(`/stats/chart/game/${g.id}`)}
                        className="border-t border-white/[0.06] cursor-pointer hover:bg-white/[0.04] transition-colors"
                      >
                        {matchupCell(g)}
                        <td className="px-3 py-2.5 text-center tabular-nums text-[#c8d3cc] whitespace-nowrap">{dayLabel(g.gameDate)}</td>
                        <td className="px-3 py-2.5 text-center tabular-nums text-white whitespace-nowrap">{g.startTime || DASH}</td>
                        <td className="px-3 py-2.5 text-center whitespace-nowrap">
                          <span
                            className="px-2 py-0.5 rounded-full text-[11px] font-semibold"
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
                      {isActive && <span className="ml-1 text-[11px]">{sort.dir === "asc" ? "▲" : "▼"}</span>}
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
                        onClick={() => navigate(`/stats/chart/game/${g.id}`)}
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
        </>
      )}
    </div>
  );
}
