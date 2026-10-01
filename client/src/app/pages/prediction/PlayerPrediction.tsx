/**
 * PlayerPrediction.tsx
 *
 * Extrait de PredictionPage.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { nhlApiService, type PlayerRatesResponse, type RateStat } from "../../services/nhlApiService";
import { fetchGameMlBundle, type GameMlBundle, type MLPredictionResult } from "../../components/MLPredictionCard";
import { useI18n } from "../../i18n";
import { BELOW_FLOOR, dispersionFor, presetResult, rateLabels, ratePct } from "./rateMath";
import { useSport } from "../../context/SportContext";
import { nhlLogoUrl } from "../../data/teamEmoji";
import { MarketGroup, PredictionsRevealBar } from "./PredictionSheet";
import { BetOpt, MktGroup, RuleFactor, mlBundleKey } from "./gameMarkets";
import { GameSelector, LoadingSkeleton, NotFound, RevealMode, RevealModeCtx, ServerGroupsPending, StatsBanner, useSelectedGame, useServerGroups, useUpcomingGames } from "./predictionShared";


/* ─── Player Prediction ──────────────────────── */
export function PlayerPrediction({ playerId }: { playerId: string }) {
  const { theme } = useSport();
  const accent = theme.accent;
  const [data, setData] = useState<{
    name: string; team: string; logo: string; position: string; number: number;
    goals: number; assists: number; points: number; plusMinus: number;
    gamesPlayed: number; goalsPerGame: number; assistsPerGame: number;
    ptsPerGame: number; ppPoints: number; shots: number; hits: number;
    blocks: number; toi: number; faceoffPct: number; penaltyMin: number;
  } | null>(null);
  // Marchés du moteur de règles, calculés par le serveur — les SEULS pourcentages
  // « règles » de la page (voir `playerGroupsF`).
  const { groups: apiGroups, failed: apiFailed, retry: retryApi } =
    useServerGroups(() => nhlApiService.getPlayerPredictions(playerId), playerId);
  const [loading, setLoading] = useState(true);
  // 2026-10-01 : ML partout ; les règles ne se voient que dans la fiche d'un pari.
  const revealMode: RevealMode = "ml";

  // Which game these props are for. Defaults to the player's next game and is
  // switchable from the dropdown; a `?game=` param (e.g. arriving from that
  // game's page) wins. Bets carry the id so they can be auto-settled — see
  // settlementFields().
  const [searchParams] = useSearchParams();
  const games = useUpcomingGames(data?.team || undefined, searchParams.get("game") ?? undefined);
  const { selected: selectedGame, select: selectGame } = useSelectedGame(games);
  const playerGameId = selectedGame?.id;

  useEffect(() => {
    async function load() {
      try {
        const [info, stats] = await Promise.all([
          nhlApiService.getPlayer(playerId),
          nhlApiService.getPlayerStats(playerId),
        ]);
        const name = info.name ?? info.fullName ?? `${info.firstName ?? ""} ${info.lastName ?? ""}`.trim();
        const gp = stats.gamesPlayed || 1;
        setData({
          name, team: info.teamAbbr ?? "",
          logo: nhlLogoUrl(info.teamAbbr ?? ""),
          position: info.position, number: info.number ?? info.jerseyNumber ?? 0,
          goals: stats.goals, assists: stats.assists, points: stats.points,
          plusMinus: stats.plusMinus, gamesPlayed: gp,
          goalsPerGame: stats.goals / gp,
          assistsPerGame: stats.assists / gp,
          ptsPerGame: stats.points / gp,
          ppPoints: stats.powerPlayPoints ?? 0,
          shots: stats.shots ?? 0,
          hits: stats.hits ?? 0,
          blocks: stats.blockedShots ?? 0,
          toi: stats.timeOnIce ?? 0,
          faceoffPct: stats.faceoffWinPct ?? 0,
          penaltyMin: stats.penaltyMinutes ?? 0,
        });
        // The game itself is resolved by useUpcomingGames(data.team) above —
        // it looks 14 days ahead and feeds the dropdown, so this loader only
        // has to publish the player's team.
      } catch (e) { console.error("PlayerPrediction load error", e); }
      finally { setLoading(false); }
    }
    load();
  }, [playerId]);

  // ── Mode ML, sans un appel par tuile ─────────────────────────────────────
  //
  // Les tuiles de cette page appelaient `/predict/ml` une par une, et le
  // service Python n'y faisait qu'une Poisson de saison bornée à 5 %. Ici,
  // DEUX requêtes au plus, à la bascule en mode ML :
  //   · les cadences de CE joueur (`/predictions/player-rates/player/:id`),
  //     ajustées à l'adversaire du match choisi — tous les seuils en découlent ;
  //   · pour un gardien, le paquet ML du match (victoire, blanchissage).
  const { t } = useI18n();
  const [rates, setRates] = useState<PlayerRatesResponse | null | undefined>(undefined);
  const [bundle, setBundle] = useState<GameMlBundle | null | undefined>(undefined);
  useEffect(() => {
    if (revealMode !== "ml") return;
    let alive = true;
    setRates(undefined);
    nhlApiService.getPlayerRates("player", playerId, playerGameId)
      .then(r => { if (alive) setRates(r); })
      .catch(() => { if (alive) setRates(null); });
    return () => { alive = false; };
  }, [revealMode, playerId, playerGameId]);
  const isGoaliePage = data?.position === "G";
  useEffect(() => {
    if (revealMode !== "ml" || !isGoaliePage) return;
    if (!playerGameId) { setBundle(null); return; }
    let alive = true;
    setBundle(undefined);
    fetchGameMlBundle(playerGameId).then(b => { if (alive) setBundle(b); });
    return () => { alive = false; };
  }, [revealMode, isGoaliePage, playerGameId]);

  if (loading) return <LoadingSkeleton />;
  if (!data) return <NotFound />;

  // ── Tuiles = marchés du SERVEUR ──────────────────────────────────────────
  //
  // Jusqu'au 2026-09-24 la page construisait ses tuiles dans le navigateur,
  // avec des lignes calées sur la moyenne du joueur et des pourcentages écrits
  // en dur (tirs 52/48 et 38/62, mises en échec 52/48, arrêts 62/38 et 44/56,
  // victoire du gardien 50, blanchissage 10). Le serveur n'y injectait que ses
  // facteurs, jamais son chiffre.
  //
  // Désormais les tuiles SONT les options du serveur (`buildPlayerMarkets`),
  // mêmes lignes, même pourcentage. Cette table n'ajoute que ce que le serveur
  // ne porte pas : le libellé, le marché ML (cadences de `rateMath`, qui
  // chiffrent n'importe quelle ligne) et le marché de règlement. Les paris
  // over/under reçoivent leur côté « under », qui est le complément exact.
  // Une option serveur absente de la table n'est pas affichée (ex. buts
  // accordés du gardien : aucun marché de règlement).
  const TILE: Record<string, {
    label: string; propType: string; line: number;
    settleMarket: string; settleSelection: "yes" | "over"; withUnder?: boolean;
  }> = {
    "g-anytime":  { label: "Anytime Goal Scorer", propType: "goals",    line: 0.5,  settleMarket: "anytime_goal",       settleSelection: "yes" },
    "g-first":    { label: "First Goal Scorer",   propType: "goals",    line: 0.5,  settleMarket: "first_goal_scorer",  settleSelection: "yes" },
    // anytime_goal se règle sur goals > line : la ligne 1.5 exige bien 2 buts.
    "g-2plus":    { label: "Goals Over 1.5",      propType: "goals",    line: 1.5,  settleMarket: "anytime_goal",       settleSelection: "yes" },
    "a-1plus":    { label: "Assists Over 0.5",    propType: "assists",  line: 0.5,  settleMarket: "assists_ou",         settleSelection: "over" },
    "a-2plus":    { label: "Assists Over 1.5",    propType: "assists",  line: 1.5,  settleMarket: "assists_ou",         settleSelection: "over" },
    "a-3plus":    { label: "Assists Over 2.5",    propType: "assists",  line: 2.5,  settleMarket: "assists_ou",         settleSelection: "over" },
    "pts-1plus":  { label: "Points Over 0.5",     propType: "points",   line: 0.5,  settleMarket: "points_ou",          settleSelection: "over" },
    "pts-2plus":  { label: "Points Over 1.5",     propType: "points",   line: 1.5,  settleMarket: "points_ou",          settleSelection: "over" },
    "pts-3plus":  { label: "Points Over 2.5",     propType: "points",   line: 2.5,  settleMarket: "points_ou",          settleSelection: "over" },
    "sog-o25":    { label: "Shots Over 2.5",      propType: "shots",    line: 2.5,  settleMarket: "shots_ou",           settleSelection: "over", withUnder: true },
    "sog-o35":    { label: "Shots Over 3.5",      propType: "shots",    line: 3.5,  settleMarket: "shots_ou",           settleSelection: "over", withUnder: true },
    "sog-o45":    { label: "Shots Over 4.5",      propType: "shots",    line: 4.5,  settleMarket: "shots_ou",           settleSelection: "over", withUnder: true },
    "hits-o15":   { label: "Hits Over 1.5",       propType: "hits",     line: 1.5,  settleMarket: "hits_ou",            settleSelection: "over", withUnder: true },
    "hits-o25":   { label: "Hits Over 2.5",       propType: "hits",     line: 2.5,  settleMarket: "hits_ou",            settleSelection: "over", withUnder: true },
    "hits-o35":   { label: "Hits Over 3.5",       propType: "hits",     line: 3.5,  settleMarket: "hits_ou",            settleSelection: "over", withUnder: true },
    "blk-o05":    { label: "Blocks Over 0.5",     propType: "blocks",   line: 0.5,  settleMarket: "blocked_shots_ou",   settleSelection: "over", withUnder: true },
    "blk-o15":    { label: "Blocks Over 1.5",     propType: "blocks",   line: 1.5,  settleMarket: "blocked_shots_ou",   settleSelection: "over", withUnder: true },
    "pp-point":   { label: "PP Point",            propType: "points",   line: 0.5,  settleMarket: "pp_point",           settleSelection: "yes" },
    "pp-goal":    { label: "PP Goal",             propType: "goals",    line: 0.5,  settleMarket: "pp_goal",            settleSelection: "yes" },
    "pim-o05":    { label: "PIM Over 0.5",        propType: "pim",      line: 0.5,  settleMarket: "penalty_minutes_ou", settleSelection: "over", withUnder: true },
    "pim-o15":    { label: "PIM Over 1.5",        propType: "pim",      line: 1.5,  settleMarket: "penalty_minutes_ou", settleSelection: "over", withUnder: true },
    "sv-o245":    { label: "Over 24.5 Saves",     propType: "saves",    line: 24.5, settleMarket: "goalie_saves_ou",    settleSelection: "over", withUnder: true },
    "sv-o275":    { label: "Over 27.5 Saves",     propType: "saves",    line: 27.5, settleMarket: "goalie_saves_ou",    settleSelection: "over", withUnder: true },
    "sv-o295":    { label: "Over 29.5 Saves",     propType: "saves",    line: 29.5, settleMarket: "goalie_saves_ou",    settleSelection: "over", withUnder: true },
    "gr-win":     { label: "Goalie Win",          propType: "wins",     line: 0.5,  settleMarket: "goalie_win",         settleSelection: "yes" },
    "gr-shutout": { label: "Shutout",             propType: "shutouts", line: 0.5,  settleMarket: "goalie_shutout",     settleSelection: "yes" },
  };
  const invert = (f: RuleFactor): RuleFactor => ({ ...f, value: Math.max(0.05, Math.min(0.95, 1 - f.value)) });

  const playerGroupsF: MktGroup[] = (apiGroups ?? []).flatMap((g): MktGroup[] => {
    const options: BetOpt[] = [];
    for (const o of g.options) {
      const tile = TILE[o.id];
      if (!tile || typeof o.rulePct !== "number") continue;
      const base = {
        type: "player" as const, subjectId: playerId,
        propType: tile.propType, line: tile.line, settleMarket: tile.settleMarket,
      };
      options.push({
        id: o.id, label: tile.label, rulePct: o.rulePct, ruleNote: o.ruleNote,
        factors: o.factors, factorGroup: o.factorGroup,
        mlProps: { ...base, settleSelection: tile.settleSelection },
      });
      if (tile.withUnder) {
        const under = 100 - o.rulePct;
        options.push({
          id: `${o.id}-u`, label: tile.label.replace("Over", "Under"), rulePct: under,
          ruleNote: `Complement of "${tile.label}": 100 − ${o.rulePct}% = ${under}%. ${o.ruleNote}`,
          factors: o.factors?.map(invert), factorGroup: o.factorGroup,
          mlProps: { ...base, settleSelection: "under" },
        });
      }
    }
    if (options.length === 0) return [];
    // Over | Under côte à côte quand le groupe a gagné ses « under ».
    return [{ ...g, cols: options.length > g.options.length ? 2 : g.cols, options }];
  });

  // ── Chiffre ML de chaque tuile ────────────────────────────────────────────
  // `undefined` = pas encore là (la tuile attend), `null` = pas de chiffre.
  const row = rates?.players?.[playerId];
  const STAT: Record<string, RateStat> = {
    goals: "goals", assists: "assists", points: "points", shots: "shots",
    hits: "hits", blocks: "blocks", saves: "saves", pim: "pim",
  };
  const mlFor = (o: BetOpt): MLPredictionResult | null | undefined => {
    const m = o.mlProps;
    if (!m) return null;
    const settle = m.settleMarket ?? "";
    // Gardien : victoire et blanchissage sont des questions de MATCH.
    if (settle === "goalie_win" || settle === "goalie_shutout") {
      if (bundle === undefined) return undefined;
      if (bundle === null || !selectedGame) return null;
      const key = settle === "goalie_win"
        ? mlBundleKey("moneyline", null, null, selectedGame.isHome)
        : mlBundleKey("clean_sheet", null, "yes", selectedGame.isHome);
      return bundle.byKey[key] ?? null;
    }
    if (rates === undefined) return undefined;
    if (rates === null || !row) return null;
    if (settle === "first_goal_scorer") {
      if (row.firstGoal == null) return null;
      const pv = Math.round(row.firstGoal * 100);
      return presetResult(pv, t(rateLabels(row.source).model), t("prop.mlFirstNote", {
        rate: (row.rates.goals ?? 0).toFixed(2), game: (row.gameGoals ?? 6).toFixed(1), pct: String(pv),
      }));
    }
    // Buts en avantage numérique : aucune cadence par joueur — pas de chiffre.
    if (settle === "pp_goal") return null;
    const stat: RateStat | undefined = settle === "pp_point" ? "ppPoints" : STAT[m.propType ?? ""];
    const rate = stat ? row.rates[stat] : undefined;
    if (!stat || rate == null || m.line == null) return null;
    const disp = dispersionFor(rates, row.source, stat);
    const labels = rateLabels(row.source);
    const side = (m.settleSelection ?? "over") === "under" ? "under" : "over";
    const pv = ratePct(rate, m.line, disp, side);
    return presetResult(pv, t(labels.model), t(labels.note, {
      rate: rate.toFixed(2), gp: String(row.gp), k: disp == null ? "∞" : String(disp),
      label: `${side === "under" ? "<" : ">"} ${m.line}`, pct: String(pv),
    }));
  };

  // Stamp the resolved game id onto every option's mlProps — plus the player's
  // team and name, which the slip shows instead of the raw player id.
  const playerGroupsG: MktGroup[] = playerGroupsF.map(g => ({
    ...g,
    options: g.options.map(o => ({
      ...(o.mlProps
        ? { ...o, mlProps: {
            ...o.mlProps,
            ...(playerGameId ? { gameId: playerGameId } : {}),
            teamAbbr: data.team || undefined,
            playerName: data.name,
          } }
        : o),
      mlExternal: true,
      mlPreset: mlFor(o),
      belowFloor: BELOW_FLOOR,
    })),
  }));

  return (
    <div className="flex flex-col gap-3">
      {/* Which game these props are for — next game by default */}
      <GameSelector games={games} selected={selectedGame} onSelect={selectGame} accent={accent} />

      {/* Player header */}
      <div className="bg-[#131A12] border border-white/20 rounded-2xl p-4">
        <div className="flex items-center gap-3 mb-3">
          <img src={data.logo} alt={data.team} className="w-12 h-12 object-contain" />
          <div className="flex-1 min-w-0">
            <p className="text-white font-bold text-base truncate">{data.name}</p>
            <p className="text-[#8a9ea6] text-xs">{data.team} · #{data.number} · {data.position}</p>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {[
            { label: "G",    value: String(data.goals)   },
            { label: "A",    value: String(data.assists)  },
            { label: "PTS",  value: String(data.points)   },
            { label: "+/-",  value: (data.plusMinus >= 0 ? "+" : "") + data.plusMinus },
          ].map(s => (
            <div key={s.label} className="bg-[#0A0E0C] rounded-xl p-2 text-center">
              <p className="text-white text-sm font-bold">{s.value}</p>
              <p className="text-[#8a9ea6] text-[11px]">{s.label}</p>
            </div>
          ))}
        </div>
      </div>
      {/* Recent form — shown above the markets */}

      {/* Market groups — server options, with their ML and settlement markets (`TILE`) */}
      <StatsBanner type="player" id={playerId} />
      <PredictionsRevealBar />
      <RevealModeCtx.Provider value={revealMode}>
        {apiGroups == null
          ? <ServerGroupsPending failed={apiFailed} onRetry={retryApi} />
          : playerGroupsG.map(g => <MarketGroup key={g.id} group={g} accent={accent} />)}
      </RevealModeCtx.Provider>

    </div>
  );
}
