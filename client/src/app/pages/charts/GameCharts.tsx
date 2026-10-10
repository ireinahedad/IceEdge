/**
 * GameCharts.tsx
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
import type { AllTeamsSeason, GameDetail, GameSide, GameTeamStats, GameSkaterLine, GameGoalieLine } from "../../services/nhlApiService";
import { BG_CARD, sign, svpct } from "./chartsTheme";
import { COMPARE_B_COLOR, CompareRow } from "./ChartVisuals";

import { Star } from "lucide-react";
/* ── Single game ────────────────────────────────────────────
 * Header tells you at a glance whether it's done (FINAL, with OT/SO noted) or
 * when it starts. Everything below only renders once there's real data: a game
 * that hasn't started has no boxscore, so it falls back to a season comparison
 * of the two clubs rather than a page of dashes.
 */
export function GameCharts({ gameId }: { gameId?: string }) {
  const { t, lang } = useI18n();
  const { theme } = useSport();
  const navigate = useNavigate();
  const accent = theme.accent;
  const locale = lang === "fr" ? "fr-FR" : "en-US";

  const [data, setData] = useState<GameDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [teamsSeason, setTeamsSeason] = useState<AllTeamsSeason | null>(null);

  useEffect(() => {
    if (!gameId) { setLoading(false); setError(true); return; }
    let alive = true;
    setLoading(true);
    setError(false);
    nhlApiService
      .getGameDetail(gameId)
      .then((res) => { if (alive) setData(res); })
      .catch((e) => { console.error("GameCharts load error", e); if (alive) setError(true); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [gameId]);

  // Only needed for the pre-game view, so it's fetched lazily once we know the
  // game hasn't started.
  const needsSeason = !!data && data.teamStats == null;
  useEffect(() => {
    if (!needsSeason) return;
    let alive = true;
    nhlApiService
      .getAllTeamsSeason(data?.season ?? null)
      .then((res) => { if (alive) setTeamsSeason(res); })
      .catch(() => {});
    return () => { alive = false; };
  }, [needsSeason, data?.season]);

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-28 rounded-2xl animate-pulse" style={{ background: BG_CARD }} />
        ))}
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="rounded-2xl border border-white/10 p-6 text-center" style={{ background: BG_CARD }}>
        <p className="text-[#8a9ea6] text-sm">{t("chart.noData")}</p>
      </div>
    );
  }

  const isFinal = data.status === "final";
  const isLive = data.status === "live";
  const started = data.teamStats != null;

  const startLocal = data.startTimeUTC ? new Date(data.startTimeUTC) : null;
  const dateLabel = startLocal
    ? startLocal.toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric" })
    : data.gameDate;
  const timeLabel = startLocal
    ? startLocal.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" })
    : "";

  // "FINAL / OT" and "FINAL / SO" carry real meaning for a hockey result.
  const finalSuffix =
    data.lastPeriodType && data.lastPeriodType !== "REG" ? ` / ${data.lastPeriodType}` : "";
  const statusText = isFinal
    ? `${t("chart.gm.final")}${finalSuffix}`
    : isLive
    ? `${t("chart.gm.live")} · P${data.period ?? ""}${data.clock ? ` ${data.clock}` : ""}`
    : `${dateLabel}${timeLabel ? ` · ${timeLabel}` : ""}`;
  const statusStyle = isFinal
    ? { background: "rgba(255,255,255,0.08)", color: "#c8d3cc" }
    : isLive
    ? { background: "#f8717122", color: "#f87171" }
    : { background: accent + "22", color: accent };

  const goTeam = (abbr: string) => abbr && navigate(`/stats/chart/team/${abbr.toLowerCase()}`);

  const TeamBlock = ({ side }: { side: GameSide }) => (
    <button
      onClick={() => goTeam(side.abbr)}
      className="flex-1 min-w-0 flex flex-col items-center gap-1 group"
    >
      <img src={nhlLogoUrl(side.abbr)} alt={side.abbr} className="w-12 h-12 object-contain" />
      <span className="text-white text-sm font-bold group-hover:underline">{side.abbr}</span>
      <span className="text-[#5c6f63] text-[11px] truncate max-w-[7rem]">{side.name}</span>
    </button>
  );

  const teamStatRows: { label: string; key: keyof GameTeamStats }[] = [
    { label: t("chart.gm.shots"),     key: "sog" },
    { label: t("chart.gm.ppGoals"),   key: "ppGoals" },
    { label: t("chart.gm.pim"),       key: "pim" },
    { label: t("chart.gm.hits"),      key: "hits" },
    { label: t("chart.gm.blocks"),    key: "blockedShots" },
    { label: t("chart.gm.giveaways"), key: "giveaways" },
    { label: t("chart.gm.takeaways"), key: "takeaways" },
  ];

  const seasonRow = (abbr: string) => teamsSeason?.teams.find((x) => x.abbr === abbr) ?? null;
  const awaySeason = seasonRow(data.away.abbr);
  const homeSeason = seasonRow(data.home.abbr);

  const skaterTable = (title: string, abbr: string, lines: GameSkaterLine[]) => (
    <div className="rounded-2xl border border-white/20 overflow-hidden" style={{ background: BG_CARD }}>
      <button
        onClick={() => goTeam(abbr)}
        className="w-full px-4 pt-3 pb-2 border-b border-white/10 flex items-center gap-2 hover:bg-white/[0.04] transition-colors"
      >
        <img src={nhlLogoUrl(abbr)} alt={abbr} className="w-4 h-4 object-contain" />
        <p className="text-white text-sm font-semibold">{title}</p>
        <span className="text-[#5c6f63] ml-auto">›</span>
      </button>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="text-[#8a9ea6]">
              <th className="text-left font-semibold px-3 py-2 sticky left-0 z-10" style={{ background: BG_CARD }}>
                {t("chart.player")}
              </th>
              <th className="font-semibold px-2 py-2 text-center">G</th>
              <th className="font-semibold px-2 py-2 text-center">A</th>
              <th className="font-semibold px-2 py-2 text-center">P</th>
              <th className="font-semibold px-2 py-2 text-center">+/-</th>
              <th className="font-semibold px-2 py-2 text-center">SOG</th>
              <th className="font-semibold px-2 py-2 text-center">HIT</th>
              <th className="font-semibold px-2 py-2 text-center">BLK</th>
              <th className="font-semibold px-2 py-2 text-center">PIM</th>
              <th className="font-semibold px-2 py-2 text-center">TOI</th>
            </tr>
          </thead>
          <tbody>
            {[...lines]
              .sort((a, b) => b.points - a.points || b.toiMin - a.toiMin)
              .map((p) => (
                <tr
                  key={p.id}
                  onClick={() => navigate(`/stats/chart/player/${p.id}`)}
                  className="border-t border-white/[0.06] cursor-pointer hover:bg-white/[0.04] transition-colors"
                >
                  <td className="px-3 py-2 sticky left-0 z-10 whitespace-nowrap" style={{ background: BG_CARD }}>
                    <span className="text-[#5c6f63] tabular-nums mr-1.5">{p.number}</span>
                    <span className="text-white font-medium">{p.name}</span>
                    <span className="text-[#5c6f63] ml-1.5">{p.position}</span>
                  </td>
                  <td className="px-2 py-2 text-center tabular-nums text-white">{p.goals}</td>
                  <td className="px-2 py-2 text-center tabular-nums text-white">{p.assists}</td>
                  <td className="px-2 py-2 text-center tabular-nums font-semibold" style={{ color: accent }}>{p.points}</td>
                  <td className="px-2 py-2 text-center tabular-nums text-[#c8d3cc]">{sign(p.plusMinus)}</td>
                  <td className="px-2 py-2 text-center tabular-nums text-[#c8d3cc]">{p.sog}</td>
                  <td className="px-2 py-2 text-center tabular-nums text-[#c8d3cc]">{p.hits}</td>
                  <td className="px-2 py-2 text-center tabular-nums text-[#c8d3cc]">{p.blockedShots}</td>
                  <td className="px-2 py-2 text-center tabular-nums text-[#c8d3cc]">{p.pim}</td>
                  <td className="px-2 py-2 text-center tabular-nums text-[#c8d3cc] whitespace-nowrap">{p.toi}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  const goalieTable = (lines: GameGoalieLine[]) => {
    if (lines.length === 0) return null;
    return (
      <div className="overflow-x-auto border-t border-white/10">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="text-[#8a9ea6]">
              <th className="text-left font-semibold px-3 py-2">{t("chart.gm.goalies")}</th>
              <th className="font-semibold px-2 py-2 text-center">SV</th>
              <th className="font-semibold px-2 py-2 text-center">SA</th>
              <th className="font-semibold px-2 py-2 text-center">GA</th>
              <th className="font-semibold px-2 py-2 text-center">SV%</th>
              <th className="font-semibold px-2 py-2 text-center">TOI</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((g) => (
              <tr
                key={g.id}
                onClick={() => navigate(`/stats/chart/player/${g.id}`)}
                className="border-t border-white/[0.06] cursor-pointer hover:bg-white/[0.04] transition-colors"
              >
                <td className="px-3 py-2 whitespace-nowrap">
                  <span className="text-white font-medium">{g.name}</span>
                  {g.decision && <span className="text-[#5c6f63] ml-1.5">({g.decision})</span>}
                </td>
                <td className="px-2 py-2 text-center tabular-nums text-white">{g.saves}</td>
                <td className="px-2 py-2 text-center tabular-nums text-[#c8d3cc]">{g.shotsAgainst}</td>
                <td className="px-2 py-2 text-center tabular-nums text-[#c8d3cc]">{g.goalsAgainst}</td>
                <td className="px-2 py-2 text-center tabular-nums" style={{ color: accent }}>{svpct(g.savePct)}</td>
                <td className="px-2 py-2 text-center tabular-nums text-[#c8d3cc] whitespace-nowrap">{g.toi}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Hero: matchup, score / start time, status */}
      <div className="rounded-2xl border border-white/20 p-4" style={{ background: BG_CARD }}>
        <div className="flex items-center justify-center mb-3">
          <span className="px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-wider" style={statusStyle}>
            {statusText}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <TeamBlock side={data.away} />
          <div className="flex flex-col items-center shrink-0 px-2">
            {started ? (
              <div className="flex items-baseline gap-2">
                <span className="text-white text-3xl font-black tabular-nums">{data.away.score ?? 0}</span>
                <span className="text-[#5c6f63] text-lg">–</span>
                <span className="text-white text-3xl font-black tabular-nums">{data.home.score ?? 0}</span>
              </div>
            ) : (
              <>
                <span className="text-white text-lg font-bold">{timeLabel || t("schedule.at")}</span>
                <span className="text-[#5c6f63] text-[11px]">{dateLabel}</span>
              </>
            )}
          </div>
          <TeamBlock side={data.home} />
        </div>

        {data.venue && (
          <p className="text-center text-[#5c6f63] text-[11px] mt-3">
            {data.venue}
            {data.venueLocation ? ` · ${data.venueLocation}` : ""}
          </p>
        )}
      </div>

      {/* Period-by-period */}
      {started && data.periods.length > 0 && (
        <div className="rounded-2xl border border-white/20 overflow-hidden" style={{ background: BG_CARD }}>
          <div className="px-4 pt-3 pb-2 border-b border-white/10">
            <p className="text-white text-sm font-semibold">{t("chart.gm.periodScoring")}</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="text-[#8a9ea6]">
                  <th className="text-left font-semibold px-3 py-2">{t("chart.gm.period")}</th>
                  {data.periods.map((p) => (
                    <th key={p.label} className="font-semibold px-3 py-2 text-center">{p.label}</th>
                  ))}
                  <th className="font-semibold px-3 py-2 text-center">T</th>
                </tr>
              </thead>
              <tbody>
                {([
                  { abbr: data.away.abbr, score: data.away.score, vals: data.periods.map((p) => p.away) },
                  { abbr: data.home.abbr, score: data.home.score, vals: data.periods.map((p) => p.home) },
                ]).map((row) => (
                  <tr key={row.abbr} className="border-t border-white/[0.06]">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <img src={nhlLogoUrl(row.abbr)} alt={row.abbr} className="w-4 h-4 object-contain inline-block mr-1.5 align-text-bottom" />
                      <span className="text-white font-medium">{row.abbr}</span>
                    </td>
                    {row.vals.map((v, i) => (
                      <td key={i} className="px-3 py-2 text-center tabular-nums text-[#c8d3cc]">{v}</td>
                    ))}
                    <td className="px-3 py-2 text-center tabular-nums text-white font-bold">{row.score ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Team stat comparison */}
      {data.teamStats && (
        <div className="rounded-2xl border border-white/20 overflow-hidden" style={{ background: BG_CARD }}>
          <div className="px-4 pt-3 pb-2 border-b border-white/10 flex items-center justify-between">
            <p className="text-white text-sm font-semibold">{t("chart.gm.teamStats")}</p>
            <span className="text-[11px] font-semibold">
              <span style={{ color: "#facc15" }}>{data.away.abbr}</span>
              <span className="text-[#5c6f63] mx-1">/</span>
              <span style={{ color: accent }}>{data.home.abbr}</span>
            </span>
          </div>
          {teamStatRows.map((r) => (
            <CompareRow
              key={r.key}
              item={{ key: r.key, label: r.label, left: data.teamStats!.away[r.key], right: data.teamStats!.home[r.key] }}
              leftColor={COMPARE_B_COLOR}
              rightColor={accent}
            />
          ))}
        </div>
      )}

      {/* Scoring summary */}
      {data.scoring.length > 0 && (
        <div className="rounded-2xl border border-white/20 overflow-hidden" style={{ background: BG_CARD }}>
          <div className="px-4 pt-3 pb-2 border-b border-white/10">
            <p className="text-white text-sm font-semibold">{t("chart.gm.summary")}</p>
          </div>
          {data.scoring.map((g, i) => (
            <div key={i} className="px-4 py-2.5 border-t border-white/[0.06] flex items-start gap-3">
              <div className="flex flex-col items-center shrink-0 w-9">
                <span className="text-[#5c6f63] text-[11px]">{g.period}</span>
                <span className="text-[#8a9ea6] text-[11px] tabular-nums">{g.time}</span>
              </div>
              <img src={nhlLogoUrl(g.teamAbbr)} alt={g.teamAbbr} className="w-4 h-4 object-contain shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-white text-xs font-medium">
                  {g.scorer}
                  {g.strength !== "ev" && (
                    <span className="ml-1.5 text-[11px] font-bold uppercase" style={{ color: accent }}>{g.strength}</span>
                  )}
                </p>
                {g.assists.length > 0 && (
                  <p className="text-[#5c6f63] text-[11px] truncate">{g.assists.join(", ")}</p>
                )}
              </div>
              <span className="text-[#c8d3cc] text-xs tabular-nums shrink-0">
                {g.awayScore}–{g.homeScore}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Three stars */}
      {data.threeStars.length > 0 && (
        <div className="rounded-2xl border border-white/20 overflow-hidden" style={{ background: BG_CARD }}>
          <div className="px-4 pt-3 pb-2 border-b border-white/10">
            <p className="text-white text-sm font-semibold">{t("chart.gm.stars")}</p>
          </div>
          {data.threeStars.map((s) => (
            <button
              key={s.star}
              onClick={() => s.id && navigate(`/stats/chart/player/${s.id}`)}
              className="w-full px-4 py-2.5 border-t border-white/[0.06] flex items-center gap-3 text-left hover:bg-white/[0.04] transition-colors"
            >
              <span className="flex items-center gap-0.5 shrink-0" style={{ color: accent }}>{Array.from({ length: Math.max(1, 4 - s.star) }, (_, k) => <Star key={k} size={12} fill="currentColor" strokeWidth={0} />)}</span>
              <img src={nhlLogoUrl(s.teamAbbr)} alt={s.teamAbbr} className="w-4 h-4 object-contain shrink-0" />
              <span className="text-white text-xs font-medium flex-1 truncate">{s.name}</span>
              <span className="text-[#8a9ea6] text-[11px] tabular-nums shrink-0">
                {s.goals}G {s.assists}A · {s.points}P
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Pre-game: season comparison instead of an empty boxscore */}
      {!started && (
        <div className="rounded-2xl border border-white/20 overflow-hidden" style={{ background: BG_CARD }}>
          <div className="px-4 pt-3 pb-2 border-b border-white/10 flex items-center justify-between">
            <p className="text-white text-sm font-semibold">{t("chart.gm.seasonForm")}</p>
            <span className="text-[11px] font-semibold">
              <span style={{ color: "#facc15" }}>{data.away.abbr}</span>
              <span className="text-[#5c6f63] mx-1">/</span>
              <span style={{ color: accent }}>{data.home.abbr}</span>
            </span>
          </div>
          {!awaySeason || !homeSeason ? (
            <p className="px-4 py-6 text-center text-[#8a9ea6] text-sm">{t("chart.gm.notStarted")}</p>
          ) : (
            <>
              <CompareRow item={{ key: "points", label: t("chart.tm.points"), left: awaySeason.points, right: homeSeason.points }} leftColor={COMPARE_B_COLOR} rightColor={accent} />
              <CompareRow item={{ key: "wins", label: t("chart.tm.wins"), left: awaySeason.wins, right: homeSeason.wins }} leftColor={COMPARE_B_COLOR} rightColor={accent} />
              <CompareRow item={{ key: "goalsFor", label: t("chart.tm.goalsFor"), left: awaySeason.goalsFor, right: homeSeason.goalsFor }} leftColor={COMPARE_B_COLOR} rightColor={accent} />
              <CompareRow item={{ key: "goalsAgainst", label: t("chart.tm.goalsAgainst"), left: awaySeason.goalsAgainst, right: homeSeason.goalsAgainst }} leftColor={COMPARE_B_COLOR} rightColor={accent} />
              <CompareRow item={{ key: "ppPct", label: t("chart.tm.ppPct"), left: awaySeason.ppPct, right: homeSeason.ppPct }} leftColor={COMPARE_B_COLOR} rightColor={accent} />
              <CompareRow item={{ key: "pkPct", label: t("chart.tm.pkPct"), left: awaySeason.pkPct, right: homeSeason.pkPct }} leftColor={COMPARE_B_COLOR} rightColor={accent} />
            </>
          )}
        </div>
      )}

      {/* Player lines */}
      {data.players && (
        <>
          <div className="flex flex-col gap-0">
            {skaterTable(data.away.name || data.away.abbr, data.away.abbr, data.players.away.skaters)}
            {goalieTable(data.players.away.goalies)}
          </div>
          <div className="flex flex-col gap-0">
            {skaterTable(data.home.name || data.home.abbr, data.home.abbr, data.players.home.skaters)}
            {goalieTable(data.players.home.goalies)}
          </div>
        </>
      )}
    </div>
  );
}
