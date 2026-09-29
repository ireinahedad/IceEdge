/**
 * PlayerCharts.tsx
 *
 * Extrait de ChartPage.tsx le 2026-08-10 (3106 lignes → 11 fichiers).
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { useNavigate } from "react-router";
import { useEffect, useState, useRef } from "react";
import { Search, X } from "lucide-react";
import { useSport } from "../../context/SportContext";
import { useI18n } from "../../i18n";
import { nhlLogoUrl } from "../../data/teamEmoji";
import { nhlApiService } from "../../services/nhlApiService";
import type { TeamPlayerSeasons } from "../../services/nhlApiService";
import type { NHLTeamInfo, NHLPlayerInfo } from "../../types/bet";
import { FactorPie } from "../../components/FactorPie";
import { CardsSkeleton, ChartMessage, TeamSelect } from "./ChartControls";
import { buildGoalieExtraMetrics, buildGoalieMetrics, buildSkaterExtraMetrics, buildSkaterMetrics, playerLowBetter } from "./chartsMetrics";
import { COMPARE_B_COLOR, CompareBars } from "./ChartVisuals";
import { BG_CARD, BG_CELL, DASH, int, seasonLabel, selectCls } from "./chartsTheme";

/* ── Player charts ─────────────────────────────────────────
 * Bet365-style single-player view: pick a team, then a player, and see that
 * player's current-season breakdown (Total / per-game / vs-another-player).
 * The 4th column lets you search any other skater or goalie and drops their
 * stat line in for a side-by-side comparison, plus a points-share pie chart.
 * Reuses the team charts' player-seasons endpoint for both the main player and
 * whoever is picked to compare against.
 *
 * `teamSpace` réutilise cette même page comme section « joueurs » de l'espace
 * d'un club (`/stats/chart/team/mtl/players`). L'équipe n'est alors plus un
 * choix mais l'espace où l'on se trouve : elle vient de l'URL, et en changer
 * fait changer d'espace. Le joueur regardé, lui, reste un choix — il vit dans
 * `?player=`, une query string plutôt qu'un segment de chemin, pour que l'URL
 * continue d'être celle du club : c'est elle qui donne à l'en-tête ses
 * couleurs et au fil d'Ariane son point de remontée.
 */
export function PlayerCharts({
  initialPlayerId,
  teamSpace,
}: {
  initialPlayerId?: string;
  teamSpace?: string;
}) {
  const { t } = useI18n();
  const { theme } = useSport();
  const navigate = useNavigate();
  const accent = theme.accent;

  const [teams, setTeams] = useState<NHLTeamInfo[]>([]);
  // DÉRIVÉE de l'URL dans l'espace d'un club : passer de Montréal à Toronto ne
  // remonte pas ce composant, un état initial resterait bloqué sur le premier.
  const scopedTeam = (teamSpace ?? "").toLowerCase();
  const [pickedTeam, setPickedTeam] = useState<string>("");
  const teamAbbr = scopedTeam || pickedTeam;
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
    // Dans l'espace d'un club, l'équipe est déjà connue : l'aller-retour
    // serait une requête pour rien, et sa réponse écraserait l'espace courant.
    if (!initialPlayerId || scopedTeam) return;
    nhlApiService
      .getPlayer(initialPlayerId)
      .then((info) => { if (info?.teamAbbr) setPickedTeam(info.teamAbbr.toLowerCase()); })
      .catch(() => {});
  }, [initialPlayerId, scopedTeam]);

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
  // Dans l'espace d'un club l'URL reste CELLE DU CLUB — sinon l'en-tête
  // perdrait ses couleurs et le retour ne saurait plus où remonter.
  useEffect(() => {
    if (!playerId) return;
    navigate(
      scopedTeam
        ? `/stats/chart/team/${scopedTeam}/players?player=${playerId}`
        : `/stats/chart/player/${playerId}`,
      { replace: true },
    );
  }, [playerId, scopedTeam, navigate]);

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
          <TeamSelect
            value={teamAbbr}
            onChange={(next) => {
              if (!scopedTeam) { setPickedTeam(next); return; }
              navigate(next ? `/stats/chart/team/${next}/players` : "/stats/chart/all-players");
            }}
            teams={teamOptions}
          />
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
          {/* Vers la comparaison joueur-joueur, ce joueur déjà posé à gauche. */}
          <button
            onClick={() => navigate(`/stats/chart/compare-players${playerId ? `?a=${playerId}` : ""}`)}
            className={selectCls}
            style={{ background: BG_CELL, color: COMPARE_B_COLOR, borderColor: COMPARE_B_COLOR + "66" }}
          >
            {t("chart.compare.cta")}
          </button>
        </div>
      </div>

      {!teamAbbr ? (
        <ChartMessage large>{t("chart.choosePlayerPrompt")}</ChartMessage>
      ) : loading ? (
        <CardsSkeleton />
      ) : error || !playerSeasons ? (
        <ChartMessage>{t("chart.noData")}</ChartMessage>
      ) : !selected ? (
        <ChartMessage>{t("chart.choosePlayerPrompt")}</ChartMessage>
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
                      className="tap-44 text-[#8a9ea6] hover:text-white transition-colors flex-shrink-0"
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
                          <span className="text-[#8a9ea6] text-[11px] flex-shrink-0">
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

          {/* ── Comparaison (2026-09-29) : un joueur choisi dans la colonne
              « Comparer » remplace le diagramme du joueur seul par un face à
              face des deux, stat par stat. ── */}
          {compareSelected && stat && compareStat && (
            <CompareBars
              title={t("chart.compare.chart")}
              leftLabel={selected.name}
              rightLabel={compareSelected.name}
              leftColor={accent}
              items={metrics.map((m) => ({
                key: m.key,
                label: m.label,
                left: m.totalNum(stat),
                right: m.totalNum(compareStat),
                leftText: m.total(stat),
                rightText: m.total(compareStat),
                lowBetter: playerLowBetter(m.key),
              }))}
            />
          )}

          {/* ── Points breakdown (skaters only): share of points from goals vs assists ── */}
          {!(compareSelected && compareStat) && !isGoalie && stat && (stat.points ?? 0) > 0 && (
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
