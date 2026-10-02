/**
 * CompareCharts.tsx — comparaisons joueur-joueur et équipe-équipe (2026-09-29).
 *
 *   /stats/chart/compare-players?a=<id>&b=<id>
 *   /stats/chart/compare-teams?a=<abbr>&b=<abbr>
 *
 * Deux côtés, A (accent de l'app) et B (jaune, la couleur de la colonne
 * « Comparer » de la page d'un joueur). Les choix vivent dans la query string :
 * une comparaison se partage et survit à un rechargement, et les boutons
 * « Comparer » des pages joueur / équipe y arrivent avec A déjà posé.
 *
 * Sous les sélecteurs : un tableau A | B de toutes les statistiques, puis le
 * diagramme face à face (`CompareBars`) sur les principales.
 *
 * Chaque côté choisi mène ailleurs (2026-09-29) : son NOM ouvre sa page de
 * statistiques individuelle, et le bouton « Prédiction » sa page de prédiction.
 */

import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { X } from "lucide-react";
import { useSport } from "../../context/SportContext";
import { useI18n } from "../../i18n";
import { nhlLogoUrl } from "../../data/teamEmoji";
import { nhlApiService } from "../../services/nhlApiService";
import type { AllTeamsSeason, PlayerSeasons } from "../../services/nhlApiService";
import type { NHLPlayerInfo, NHLTeamInfo } from "../../types/bet";
import { CardsSkeleton, ChartMessage, PlayerSearchBox, SeasonSelect, TeamSelect } from "./ChartControls";
import { COMPARE_B_COLOR, CompareBars } from "./ChartVisuals";
import {
  buildGoalieExtraMetrics, buildGoalieMetrics, buildSkaterExtraMetrics, buildSkaterMetrics,
  buildTeamMetrics, playerLowBetter,
} from "./chartsMetrics";
import { BG_CARD, BG_CELL, DASH, currentSeasonId, int, seasonLabel, selectCls } from "./chartsTheme";
import { loadTeamDirectory } from "./teamSpace";

type SideKey = "a" | "b";

/** Lit / écrit un côté dans la query string, sans empiler l'historique. */
function useSides() {
  const [params, setParams] = useSearchParams();
  const get = (k: SideKey) => params.get(k) ?? "";
  const set = (k: SideKey, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    setParams(next, { replace: true });
  };
  return { a: get("a"), b: get("b"), set };
}

/* ── Tableau A | B ─────────────────────────────────────── */
function CompareTable({
  title,
  leftLabel,
  rightLabel,
  leftColor,
  rows,
}: {
  title: string;
  leftLabel: string;
  rightLabel: string;
  leftColor: string;
  rows: { key: string; label: string; left: string; right: string }[];
}) {
  return (
    <div className="rounded-2xl border border-white/20 overflow-hidden" style={{ background: BG_CARD }}>
      <div className="px-4 pt-3 pb-2 border-b border-white/10">
        <p className="text-white text-sm font-semibold">{title}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="text-[#8a9ea6]">
              <th className="text-left font-semibold px-4 py-2 sticky left-0 z-10" style={{ background: BG_CARD }}>&nbsp;</th>
              <th className="font-semibold px-3 py-2 text-center truncate max-w-[8rem]" style={{ color: leftColor }}>{leftLabel}</th>
              <th className="font-semibold px-3 py-2 text-center truncate max-w-[8rem]" style={{ color: COMPARE_B_COLOR }}>{rightLabel}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-white/[0.06]">
                <td className="px-4 py-2.5 sticky left-0 z-10 whitespace-nowrap text-white font-medium" style={{ background: BG_CARD }}>
                  {r.label}
                </td>
                <td className="px-3 py-2.5 text-center tabular-nums" style={{ color: leftColor }}>{r.left}</td>
                <td className="px-3 py-2.5 text-center tabular-nums" style={{ color: COMPARE_B_COLOR }}>{r.right}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * La case d'un côté une fois choisi : visuel, nom (lien vers ses statistiques),
 * sous-titre, bouton vers sa prédiction, et la croix pour le retirer.
 */
function PickedSlot({
  img,
  fallbackImg,
  name,
  sub,
  color,
  onClear,
  clearLabel,
  statsTo,
  predictionTo,
}: {
  img: string;
  fallbackImg: string;
  name: string;
  sub: string;
  color: string;
  onClear: () => void;
  clearLabel: string;
  /** Page de statistiques individuelle (le nom y mène). */
  statsTo: string;
  /** Page de prédiction (le bouton « Prédiction » y mène). */
  predictionTo: string;
}) {
  const navigate = useNavigate();
  const { t } = useI18n();
  return (
    <div className="rounded-xl border p-2.5 flex items-center gap-2.5 min-w-0" style={{ background: BG_CELL, borderColor: `${color}66` }}>
      <img
        src={img || fallbackImg}
        alt=""
        className="w-10 h-10 rounded-full object-cover bg-black/20 shrink-0"
        onError={(e) => { (e.currentTarget as HTMLImageElement).src = fallbackImg; }}
      />
      <div className="flex-1 min-w-0">
        <button
          onClick={() => navigate(statsTo)}
          className="block max-w-full text-left text-sm font-bold truncate hover:underline underline-offset-2"
          style={{ color }}
        >
          {name} <span className="text-[#5c6f63]">›</span>
        </button>
        <p className="text-[#8a9ea6] text-[11px] truncate">{sub}</p>
      </div>
      <button
        onClick={() => navigate(predictionTo)}
        className="shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold border transition-colors active:scale-95"
        style={{ color, borderColor: `${color}66`, background: `${color}14` }}
      >
        {t("pred.title")}
      </button>
      <button onClick={onClear} className="tap-44 text-[#8a9ea6] hover:text-white transition-colors shrink-0" aria-label={clearLabel}>
        <X size={14} />
      </button>
    </div>
  );
}

/* ═══════════════════════ Joueur contre joueur ═══════════════════════ */

type PlayerSide = { entry: PlayerSeasons | null; goalie: boolean; teamAbbr: string; loading: boolean; error: boolean };
const EMPTY_SIDE: PlayerSide = { entry: null, goalie: false, teamAbbr: "", loading: false, error: false };

/**
 * Un joueur par son identifiant : sa fiche (`/players/:id`) donne son club,
 * dont les saisons (`/teams/:abbr/player-seasons`, la requête de la page d'un
 * joueur) portent ses lignes de statistiques.
 */
function usePlayerSide(id: string): PlayerSide {
  const [side, setSide] = useState<PlayerSide>(EMPTY_SIDE);
  useEffect(() => {
    if (!id) { setSide(EMPTY_SIDE); return; }
    let alive = true;
    setSide({ ...EMPTY_SIDE, loading: true });
    (async () => {
      try {
        const info = await nhlApiService.getPlayer(id);
        const abbr = (info?.teamAbbr ?? "").toUpperCase();
        if (!abbr) throw new Error("player without team");
        const ps = await nhlApiService.getTeamPlayerSeasons(abbr);
        const goalie = ps.goalies.find((p) => p.id === id);
        const entry = goalie ?? ps.skaters.find((p) => p.id === id) ?? null;
        if (alive) setSide({ entry, goalie: !!goalie, teamAbbr: abbr, loading: false, error: !entry });
      } catch {
        if (alive) setSide({ ...EMPTY_SIDE, error: true });
      }
    })();
    return () => { alive = false; };
  }, [id]);
  return side;
}

export function ComparePlayersCharts() {
  const { t } = useI18n();
  const { theme } = useSport();
  const accent = theme.accent;
  const { a, b, set } = useSides();
  const A = usePlayerSide(a);
  const B = usePlayerSide(b);
  const [season, setSeason] = useState<number | null>(null);

  // Les saisons que les deux ont jouées, la plus récente d'abord.
  const seasonsOf = (s: PlayerSide) => (s.entry?.seasons ?? []).map((x) => x.seasonId);
  const common = seasonsOf(A).filter((sid) => seasonsOf(B).includes(sid)).sort((x, y) => y - x);
  const activeSeason = season != null && common.includes(season) ? season : common[0] ?? null;
  const statA = A.entry?.seasons.find((s) => s.seasonId === activeSeason) ?? null;
  const statB = B.entry?.seasons.find((s) => s.seasonId === activeSeason) ?? null;

  // Un gardien se compare à un gardien : la recherche de l'autre côté ne
  // propose que des joueurs du même type, et jamais celui déjà choisi.
  const sameKind = (other: PlayerSide, otherId: string) => (p: NHLPlayerInfo) => {
    if (String(p.id) === otherId) return false;
    if (!other.entry) return true;
    return ((p.position ?? "").toUpperCase() === "G") === other.goalie;
  };

  const headshot = (side: PlayerSide, id: string) => {
    const last = side.entry?.seasons.map((s) => s.seasonId).sort((x, y) => y - x)[0];
    return last && side.teamAbbr ? `https://assets.nhle.com/mugs/nhl/${last}/${side.teamAbbr}/${id}.png` : "";
  };

  const slot = (key: SideKey, id: string, side: PlayerSide, other: PlayerSide, otherId: string, color: string) =>
    id ? (
      side.loading ? (
        <div className="h-[62px] rounded-xl animate-pulse" style={{ background: BG_CELL }} />
      ) : (
        <PickedSlot
          img={headshot(side, id)}
          fallbackImg={nhlLogoUrl(side.teamAbbr)}
          name={side.entry?.name ?? DASH}
          sub={[side.entry?.position, side.teamAbbr].filter(Boolean).join(" · ") || t("chart.noData")}
          color={color}
          onClear={() => set(key, "")}
          clearLabel={t("chart.compare.clear")}
          statsTo={`/stats/chart/player/${id}`}
          predictionTo={`/stats/prediction/player/${id}`}
        />
      )
    ) : (
      <PlayerSearchBox
        placeholder={t("chart.searchPlayer")}
        onPick={(p) => set(key, String(p.id))}
        filter={sameKind(other, otherId)}
      />
    );

  const goalie = A.entry ? A.goalie : B.goalie;
  const metrics = goalie
    ? [...buildGoalieMetrics(t), ...buildGoalieExtraMetrics(t)]
    : [...buildSkaterMetrics(t), ...buildSkaterExtraMetrics(t)];
  // Le diagramme garde les statistiques principales ; le tableau les a toutes.
  const mainKeys = new Set((goalie ? buildGoalieMetrics(t) : buildSkaterMetrics(t)).map((m) => m.key));
  const nameA = A.entry?.name ?? "A";
  const nameB = B.entry?.name ?? "B";

  const bothReady = !!(a && b && A.entry && B.entry);
  const mixed = bothReady && A.goalie !== B.goalie;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-white/20 p-4 flex flex-col gap-3" style={{ background: BG_CARD }}>
        <div className="min-w-0">
          <p className="text-white font-bold text-base">{t("chart.compare.players")}</p>
          <p className="text-[#8a9ea6] text-xs">{t("chart.compare.playersDesc")}</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {slot("a", a, A, B, b, accent)}
          {slot("b", b, B, A, a, COMPARE_B_COLOR)}
        </div>
      </div>

      {!a || !b ? (
        <ChartMessage large>{t("chart.compare.pickTwoPlayers")}</ChartMessage>
      ) : A.loading || B.loading ? (
        <CardsSkeleton />
      ) : A.error || B.error ? (
        <ChartMessage>{t("chart.noData")}</ChartMessage>
      ) : mixed ? (
        <ChartMessage>{t("chart.compare.mixed")}</ChartMessage>
      ) : activeSeason == null || !statA || !statB ? (
        <ChartMessage>{t("chart.compare.noCommonSeason")}</ChartMessage>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={activeSeason}
              onChange={(e) => setSeason(Number(e.target.value))}
              className={selectCls}
              style={{ background: BG_CELL, color: "#c8d3cc" }}
              aria-label={t("chart.season")}
            >
              {common.map((sid) => (
                <option key={sid} value={sid}>{seasonLabel(sid)}</option>
              ))}
            </select>
          </div>

          <CompareTable
            title={t("chart.playerStats")}
            leftLabel={nameA}
            rightLabel={nameB}
            leftColor={accent}
            rows={[
              { key: "gp", label: "GP", left: int(statA.gp), right: int(statB.gp) },
              ...metrics.map((m) => ({ key: m.key, label: m.label, left: m.total(statA), right: m.total(statB) })),
            ]}
          />

          <CompareBars
            title={t("chart.compare.chart")}
            leftLabel={nameA}
            rightLabel={nameB}
            leftColor={accent}
            items={metrics
              .filter((m) => mainKeys.has(m.key))
              .map((m) => ({
                key: m.key,
                label: m.label,
                left: m.totalNum(statA),
                right: m.totalNum(statB),
                leftText: m.total(statA),
                rightText: m.total(statB),
                lowBetter: playerLowBetter(m.key),
              }))}
          />
        </>
      )}
    </div>
  );
}

/* ═══════════════════════ Équipe contre équipe ═══════════════════════ */

/** Les statistiques d'équipe reprises dans le diagramme (le tableau les a toutes). */
const TEAM_CHART_KEYS = new Set([
  "points", "wins", "goalsFor", "goalsAgainst", "gfPerGame", "gaPerGame", "ppPct", "pkPct", "shotsFor", "faceoffPct",
  "corsiPct5v5", "fenwickPct5v5",
]);

export function CompareTeamsCharts() {
  const { t } = useI18n();
  const { theme } = useSport();
  const accent = theme.accent;
  const { a, b, set } = useSides();
  const [teams, setTeams] = useState<NHLTeamInfo[]>([]);
  const [season, setSeasonState] = useState<number>(currentSeasonId);
  // Tant que l'utilisateur n'a pas choisi de saison, elle est « automatique » :
  // en début de saison, la moitié des clubs n'ont pas encore joué et leur
  // ligne est ABSENTE de la réponse NHL. Une comparaison avec l'un d'eux
  // tombait entière en « Aucune donnée » (signalé le 2026-10-02) ; on recule
  // alors d'une saison et on le dit.
  const [seasonTouched, setSeasonTouched] = useState(false);
  const [fellBackFrom, setFellBackFrom] = useState<{ season: number; team: string } | null>(null);
  const setSeason = (s: number) => { setSeasonTouched(true); setFellBackFrom(null); setSeasonState(s); };
  const [data, setData] = useState<AllTeamsSeason | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    loadTeamDirectory().then((tm) => { if (alive) setTeams(tm); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Une requête pour les 32 clubs (celle de « toutes les équipes »), puis on
  // y lit les deux lignes.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    nhlApiService
      .getAllTeamsSeason(season)
      .then((res) => { if (alive) setData(res); })
      .catch(() => { if (alive) setError(true); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [season]);

  // Nouveau duo → on repart de la saison en cours (si elle n'a pas été choisie).
  useEffect(() => {
    if (seasonTouched) return;
    setFellBackFrom(null);
    setSeasonState(currentSeasonId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, b]);

  useEffect(() => {
    if (seasonTouched || loading || !data || data.season !== season || season !== currentSeasonId) return;
    if (!a || !b) return;
    const has = (abbr: string) => data.teams.some((r) => r.abbr.toUpperCase() === abbr.toUpperCase());
    const missing = !has(a) ? a : !has(b) ? b : "";
    if (!missing) return;
    setFellBackFrom({ season, team: missing.toUpperCase() });
    setSeasonState(currentSeasonId - 10001);
  }, [data, loading, season, seasonTouched, a, b]);

  const teamOptions = [...teams].sort((x, y) => (x.name ?? "").localeCompare(y.name ?? ""));
  const row = (abbr: string) => data?.teams.find((r) => r.abbr.toUpperCase() === abbr.toUpperCase()) ?? null;
  const rowA = a ? row(a) : null;
  const rowB = b ? row(b) : null;
  const nameOf = (abbr: string) =>
    teams.find((x) => (x.abbreviation ?? "").toUpperCase() === abbr.toUpperCase())?.name ?? abbr.toUpperCase();
  const rec = (r: typeof rowA) => (r ? `${r.wins}-${r.losses}-${r.otLosses}` : DASH);

  const slot = (key: SideKey, abbr: string, other: string, color: string) =>
    abbr ? (
      <PickedSlot
        img={nhlLogoUrl(abbr.toUpperCase())}
        fallbackImg={nhlLogoUrl(abbr.toUpperCase())}
        name={nameOf(abbr)}
        sub={`${t("chart.tm.record")} ${rec(key === "a" ? rowA : rowB)} ${t("chart.recordLegend")}`}
        color={color}
        onClear={() => set(key, "")}
        clearLabel={t("chart.compare.clear")}
        statsTo={`/stats/chart/team/${abbr.toLowerCase()}`}
        predictionTo={`/stats/prediction/team/${abbr.toLowerCase()}`}
      />
    ) : (
      <TeamSelect
        value=""
        onChange={(next) => set(key, next)}
        teams={teamOptions.filter((x) => (x.abbreviation ?? "").toLowerCase() !== other.toLowerCase())}
      />
    );

  const metrics = buildTeamMetrics(t);
  const abbrA = a.toUpperCase();
  const abbrB = b.toUpperCase();

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-white/20 p-4 flex flex-col gap-3" style={{ background: BG_CARD }}>
        <div className="min-w-0">
          <p className="text-white font-bold text-base">{t("chart.compare.teams")}</p>
          <p className="text-[#8a9ea6] text-xs">{t("chart.compare.teamsDesc")}</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {slot("a", a, b, accent)}
          {slot("b", b, a, COMPARE_B_COLOR)}
        </div>
      </div>

      {!a || !b ? (
        <ChartMessage large>{t("chart.compare.pickTwoTeams")}</ChartMessage>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <SeasonSelect season={season} onChange={setSeason} />
          </div>

          {fellBackFrom && (
            <p className="text-[#8a9ea6] text-xs -mt-2">
              {t("chart.compare.fellBack", { team: nameOf(fellBackFrom.team), from: seasonLabel(fellBackFrom.season), to: seasonLabel(season) })}
            </p>
          )}

          {loading ? (
            <CardsSkeleton />
          ) : error || (!rowA && !rowB) ? (
            <ChartMessage>{t("chart.noData")}</ChartMessage>
          ) : (
            <>
              {/* Une seule équipe sans match cette saison : on garde le
                  tableau (ses valeurs à « — ») plutôt que de tout masquer. */}
              {(!rowA || !rowB) && (
                <p className="text-[#8a9ea6] text-xs -mt-2">
                  {t("chart.compare.noGames", { team: nameOf(!rowA ? a : b), season: seasonLabel(season) })}
                </p>
              )}
              <CompareTable
                title={t("chart.teamStats")}
                leftLabel={abbrA}
                rightLabel={abbrB}
                leftColor={accent}
                rows={[
                  { key: "gp", label: "GP", left: int(rowA?.gamesPlayed), right: int(rowB?.gamesPlayed) },
                  { key: "record", label: `${t("chart.tm.record")} ${t("chart.recordLegend")}`, left: rec(rowA), right: rec(rowB) },
                  ...metrics.map((m) => ({ key: m.key, label: m.label, left: rowA ? m.fmt(rowA) : DASH, right: rowB ? m.fmt(rowB) : DASH })),
                ]}
              />
              <p className="text-[#5c6f63] text-[11px] -mt-2 px-1">{t("chart.mpCredit")}</p>

              {rowA && rowB && <CompareBars
                title={t("chart.compare.chart")}
                leftLabel={abbrA}
                rightLabel={abbrB}
                leftColor={accent}
                items={metrics
                  .filter((m) => TEAM_CHART_KEYS.has(m.key))
                  // Corsi/Fenwick absents (−1) : pas de barre plutôt qu'une barre fausse.
                  .filter((m) => m.num(rowA) >= 0 && m.num(rowB) >= 0)
                  .map((m) => ({
                    key: m.key,
                    label: m.label,
                    left: m.num(rowA),
                    right: m.num(rowB),
                    leftText: m.fmt(rowA),
                    rightText: m.fmt(rowB),
                    lowBetter: m.lowBetter,
                  }))}
              />}
            </>
          )}
        </>
      )}
    </div>
  );
}
