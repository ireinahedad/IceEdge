/**
 * TeamPrediction.tsx
 *
 * Extrait de PredictionPage.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { nhlApiService } from "../../services/nhlApiService";
import { useSport } from "../../context/SportContext";
import { useI18n } from "../../i18n";
import { nhlLogoUrl } from "../../data/teamEmoji";
import { MarketGroup, PredictionsRevealBar } from "./PredictionSheet";
import { PlayerPropGrid } from "./PlayerPropGrid";
import { BetOpt, MLProps, MktGroup, RuleFactor, mlBundleKey } from "./gameMarkets";
import { fetchGameMlBundle, type GameMlBundle, type MLPredictionResult } from "../../components/MLPredictionCard";
import { BetOddsCtx, GameSelector, LoadingSkeleton, NotFound, RevealMode, RevealModeCtx, ServerGroupsPending, StatsBanner, useGameOdds, useSelectedGame, useServerGroups, useUpcomingGames } from "./predictionShared";


/* ─── Team Prediction ─────────────────────────── */
export function TeamPrediction({ teamId }: { teamId: string }) {
  const { theme } = useSport();
  const { t } = useI18n();
  const navigate = useNavigate();
  const accent = theme.accent;
  const [data, setData] = useState<{
    name: string; abbr: string; logo: string; conf: string; pts: number;
    homeRecord: string; awayRecord: string; streak: string;
    winPct: number; ppPct: number; pkPct: number;
    goalsFor: number; goalsAgainst: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  // 2026-10-01 : ML partout ; les règles ne se voient que dans la fiche d'un pari.
  const revealMode: RevealMode = "ml";
  // Abréviation → nom complet, pour tout le circuit. Le flux de cotes nomme ses
  // issues « Edmonton Oilers » ; sans le nom de l'ADVERSAIRE, impossible
  // d'identifier le match avec certitude, et un appariement approximatif
  // collerait le prix d'une autre affiche du même soir.
  const [teamNames, setTeamNames] = useState<Record<string, string>>({});

  // Which game these bets are for. Defaults to the team's next game, switchable
  // from the dropdown, and overridden by a `?game=` param. The id is stamped on
  // every bet so it can be auto-settled (see settlementFields()).
  const [searchParams] = useSearchParams();
  const games = useUpcomingGames(data?.abbr || undefined, searchParams.get("game") ?? undefined);
  const { selected: selectedGame, select: selectGame } = useSelectedGame(games);

  // Marchés du moteur de règles, calculés par le serveur — les SEULS pourcentages
  // affichés. Chargés dès que l'abréviation de l'équipe est connue.
  const teamAbbr = data?.abbr;
  const { groups: apiGroups, failed: apiFailed, retry: retryApi } =
    useServerGroups(() => nhlApiService.getTeamPredictions(teamAbbr ?? ""), teamAbbr);

  useEffect(() => {
    async function load() {
      try {
        const [teams, stats] = await Promise.all([
          nhlApiService.getAllTeams(),
          nhlApiService.getTeamStats(teamId),
        ]);
        setTeamNames(Object.fromEntries(
          teams
            .filter(t => t.abbreviation && t.name)
            .map(t => [t.abbreviation!.toUpperCase(), t.name!]),
        ));
        const info = teams.find(t => t.abbreviation?.toLowerCase() === teamId.toLowerCase());
        const abbr = info?.abbreviation ?? teamId.toUpperCase();
        const winPct = stats.wins + stats.losses + stats.otLosses > 0
          ? Math.round((stats.wins / (stats.wins + stats.losses + stats.otLosses)) * 100) : 50;
        setData({
          name: info?.name ?? abbr, abbr,
          logo: nhlLogoUrl(abbr),
          conf: info?.conference === "Eastern" ? "East" : "West",
          pts: stats.points ?? stats.wins * 2,
          homeRecord: stats.homeRecord ?? "", awayRecord: stats.awayRecord ?? "",
          streak: stats.streak ?? "", winPct,
          ppPct: stats.powerPlayPct ?? 0, pkPct: stats.penaltyKillPct ?? 0,
          goalsFor: stats.goalsForPerGame ?? 0, goalsAgainst: stats.goalsAgainstPerGame ?? 0,
        });
      } catch (e) { console.error("TeamPrediction load error", e); }
      finally { setLoading(false); }
    }
    load();
  }, [teamId]);

  // Cotes du match sélectionné, chez le livre réglé.
  //
  // Les deux noms complets sont nécessaires : `useGameOdds` n'apparie un
  // événement que si les DEUX côtés tombent juste, faute de quoi le prix d'une
  // autre affiche du même soir pourrait s'afficher ici. `teamNames` arrive du
  // même appel `getAllTeams` que l'en-tête de la page ; tant qu'il est vide, le
  // hook rend simplement « pas de cotes ».
  //
  // ⚠️ Avant les retours anticipés : c'est un hook.
  const oppAbbr = selectedGame?.opponentAbbr?.toUpperCase() ?? "";
  const odds = useGameOdds(
    data ? { abbr: data.abbr, name: teamNames[data.abbr.toUpperCase()] ?? data.name } : undefined,
    oppAbbr && teamNames[oppAbbr] ? { abbr: oppAbbr, name: teamNames[oppAbbr] } : undefined,
  );

  // Paquet ML du match choisi — UNE requête pour toutes les tuiles de la page,
  // à la bascule en mode ML (`GET /api/predict/game/:id/bundle`, partagé avec
  // la page du match). Sans match choisi, il n'y a pas d'adversaire : aucune
  // tuile de match n'a de chiffre ML.
  const [mlBundle, setMlBundle] = useState<GameMlBundle | null | undefined>(undefined);
  const bundleGameId = selectedGame?.id;
  useEffect(() => {
    if (revealMode !== "ml") return;
    if (!bundleGameId) { setMlBundle(null); return; }
    let alive = true;
    setMlBundle(undefined);
    fetchGameMlBundle(bundleGameId).then(b => { if (alive) setMlBundle(b); });
    return () => { alive = false; };
  }, [revealMode, bundleGameId]);

  if (loading) return <LoadingSkeleton />;
  if (!data) return <NotFound />;

  const hp = data.winPct;
  const ou = parseFloat(((data.goalsFor + data.goalsAgainst)).toFixed(1)) || 5.5;

  // ── build team-level bet groups ──────────────────────────────────────────
  //
  // ⚠️ Ces tuiles ne donnent que la FORME d'un pari (libellé, marché ML,
  // règlement). Leurs `rulePct` locaux sont des constantes et des règles de
  // pouce : ils sont TOUS remplacés par le chiffre du serveur plus bas
  // (`teamGroupsF`), et une tuile sans chiffre serveur n'est pas affichée.
  // Jamais un pourcentage calculé ici ne doit atteindre l'écran (2026-09-24).
  const tml = (propType: string, line?: number): MLProps =>
    ({ type: "team", subjectId: data.abbr, propType, line, gameId: selectedGame?.id });

  // Moneyline : le choix direct entre les deux équipes (2026-09-27). La tuile
  // « perd » est le pari sur l'ADVERSAIRE — sujet = l'adversaire, pour que le
  // coupon le règle comme sa victoire et que la cote affichée soit la sienne.
  // Elle pointait sur `tml("moneyline")`, c'est-à-dire sur la victoire de
  // l'équipe de la page : un pari « perd » s'enregistrait en pari « gagne ».
  // Sans match choisi, il n'y a pas d'adversaire, donc pas de marché.
  const oppMl: MLProps | undefined = oppAbbr
    ? { type: "team", subjectId: oppAbbr, opponentId: data.abbr, propType: "moneyline", gameId: selectedGame?.id }
    : undefined;

  const teamGroups: MktGroup[] = [
    {
      id: "moneyline", title: "Moneyline", cols: 2,
      options: [
        { id: "t-win",  label: `${data.abbr} wins`,            rulePct: hp,
          ruleNote: `Season win rate of ${hp}% based on ${data.pts} pts, record ${data.homeRecord} home / ${data.awayRecord} away.`,
          mlProps: tml("moneyline") },
        { id: "t-lose", label: oppAbbr ? `${oppAbbr} wins` : `${data.abbr} loses`, rulePct: 100 - hp,
          ruleNote: `Inverse of win probability: ${100 - hp}%. Current streak: ${data.streak || "—"}.`,
          mlProps: oppMl },
      ],
    },
    {
      id: "match", title: "Overtime", cols: 2,
      options: [
        { id: "t-ml-ot",label: "Match Goes to OT",             rulePct: 22,
          ruleNote: "~22-24% of NHL games go to OT/SO regardless of team strength.",
          mlProps: tml("game_to_ot") },
      ],
    },
    {
      id: "puckline", title: "Puck Line", cols: 2,
      options: [
        { id: "t-pl-fav", label: `${data.abbr} -1.5`,          rulePct: Math.max(10, hp - 18),
          ruleNote: "Win by 2+ goals — ~18% harder than a straight moneyline win.",
          mlProps: tml("puck_line") },
        { id: "t-pl-dog", label: `${data.abbr} +1.5`,          rulePct: Math.min(90, hp + 18),
          ruleNote: "Win OR lose by 1 goal. Probability boosted ~18% vs straight moneyline.",
          mlProps: tml("alt_puck_line") },
      ],
    },
    {
      id: "totals", title: "Team Goals", cols: 2,
      options: [
        { id: "t-over",    label: `Over ${ou}`,                  rulePct: 54,
          ruleNote: `Based on ${data.abbr}'s ${data.goalsFor.toFixed(2)} goals/game average.`,
          mlProps: tml("total_goals_over", ou) },
        { id: "t-under",   label: `Under ${ou}`,                 rulePct: 46,
          ruleNote: `${data.abbr} allows ${data.goalsAgainst.toFixed(2)} goals/game. Solid defense could keep this low.`,
          mlProps: tml("total_goals_under", ou) },
        { id: "t-team-over", label: `${data.abbr} Over 2.5`,   rulePct: Math.min(80, Math.round(data.goalsFor * 22 + 5)),
          ruleNote: `${data.abbr} averages ${data.goalsFor.toFixed(2)} goals/game. Scoring 3+ requires above-average output.`,
          mlProps: tml("total_goals_over", 2.5) },
        { id: "t-team-under",label: `${data.abbr} Under 2.5`,  rulePct: Math.max(20, 100 - Math.min(80, Math.round(data.goalsFor * 22 + 5))),
          ruleNote: `${data.abbr} held under 3 goals in a significant portion of games.`,
          mlProps: tml("total_goals_under", 2.5) },
      ],
    },
    {
      id: "clean", title: "Clean Sheet / Both Score", cols: 2,
      options: [
        { id: "t-cs",   label: `${data.abbr} Shutout`,          rulePct: Math.max(8, Math.round((100 - data.pkPct) * 0.20)),
          ruleNote: `Shutouts happen in ~15-22% of games. ${data.abbr}'s PK at ${data.pkPct.toFixed(1)}% is a factor.`,
          mlProps: tml("clean_sheet") },
        { id: "t-btts", label: "Both Teams Score",               rulePct: Math.min(88, Math.round(data.goalsFor * 18 + data.goalsAgainst * 12 + 25)),
          ruleNote: "Both offenses producing. Very common in NHL (~75-80% of games).",
          mlProps: tml("both_teams_score") },
      ],
    },
    {
      id: "period", title: "Period Results", cols: 3,
      options: [
        { id: "t-p1", label: `${data.abbr} Leads P1`,           rulePct: Math.round(hp * 0.42 + 10),
          ruleNote: `${data.abbr} leads after the 1st period in ~${Math.round(hp * 0.42 + 10)}% of games.`,
          mlProps: tml("period1_winner") },
        { id: "t-p2", label: `${data.abbr} Leads P2`,           rulePct: Math.round(hp * 0.44 + 8),
          ruleNote: `${data.abbr} leads after P2. More predictive than P1.`,
          mlProps: tml("period2_winner") },
        { id: "t-p3", label: `${data.abbr} Leads P3`,           rulePct: Math.round(hp * 0.48 + 6),
          ruleNote: `Leading after P3 strongly correlates with winning the game.`,
          mlProps: tml("period3_winner") },
      ],
    },
    {
      id: "pp", title: "Special Teams", cols: 2,
      options: [
        { id: "t-pp-goal", label: `${data.abbr} PP Goal`,       rulePct: Math.min(75, Math.round(data.ppPct * 1.8)),
          ruleNote: `${data.abbr}'s power play is at ${data.ppPct.toFixed(1)}%. League avg is ~20%. Scoring on the PP ~${Math.min(75, Math.round(data.ppPct * 1.8))}% of games.`,
          mlProps: tml("pp_goal") },
        { id: "t-pk",      label: `${data.abbr} Kills All PKs`, rulePct: Math.min(80, Math.round(data.pkPct * 0.9)),
          ruleNote: `${data.abbr} penalty kill at ${data.pkPct.toFixed(1)}%. Successfully killing all penalties ~${Math.min(80, Math.round(data.pkPct * 0.9))}% of games.`,
          mlProps: tml("penalty_kill") },
      ],
    },
    {
      id: "margin", title: "Winning Margin", cols: 3,
      options: [
        { id: "t-w1", label: `${data.abbr} by 1`, rulePct: Math.round(hp * 0.18),
          ruleNote: "One-goal wins are the most common margin in the NHL.",
          mlProps: tml("winning_margin") },
        { id: "t-w2", label: `${data.abbr} by 2`, rulePct: Math.round(hp * 0.13),
          ruleNote: "Two-goal victory — comfortable but not a blowout.",
          mlProps: tml("winning_margin") },
        { id: "t-w3", label: `${data.abbr} by 3+`, rulePct: Math.round(hp * 0.09),
          ruleNote: "Blowout wins are less frequent, even for dominant teams.",
          mlProps: tml("winning_margin") },
      ],
    },
  ];

  // Injecte la décomposition en facteurs (données serveur) dans les paris
  // victoire/défaite locaux → affiche le pie chart des règles.
  const teamGroupsF: MktGroup[] = (() => {
    if (!apiGroups) return [];
    // Table de correspondance ids locaux (vue équipe) → ids serveur.
    const TEAM_ID_MAP: Record<string, string> = {
      "t-win": "ml-home",   "t-lose": "ml-away",
      "t-ml-ot": "ot-yes",  "t-dc": "dc-home",
      "t-pl-fav": "pl-home","t-pl-dog": "pl-away",
      // `t-over` / `t-under` n'ont PAS d'équivalent : leur ligne (buts pour +
      // contre de l'équipe) ne tombe jamais pile sur une ligne du serveur, et
      // leur donner le chiffre de o55/o65 afficherait la probabilité d'une autre
      // ligne que celle du libellé. Le tableau « totals » du serveur les remplace.
      "t-team-over": "tg-o25", "t-team-under": "tg-u25",
      "t-cs": "cs-for",     "t-btts": "btts-yes",
      "t-p1": "p1-home",    "t-p2": "p2-home",  "t-p3": "p3-home",
      "t-pp-goal": "ppgoal","t-pk": "pk-perfect",
      "t-w1": "wm-1",       "t-w2": "wm-2",     "t-w3": "wm-3p",
    };
    // On reprend AUSSI le rulePct du serveur : la carte ouverte recalcule le
    // score depuis les facteurs reçus, donc laisser le rulePct local sur la
    // tuile faisait dire deux chiffres différents au même pari — visiblement sur
    // « Kills All PKs », à 0 % en tuile (PK% local à 0) et à sa vraie valeur une
    // fois la carte ouverte.
    //
    // ⚠️ `pctScale` est DÉFAIT ici, il n'est pas recopié.
    //
    // Depuis le passage du marché Match Betting du serveur à quatre tuiles,
    // `ml-home` ne vaut plus « gagne » mais « gagne en temps réglementaire » :
    // son `rulePct` est le mélange des facteurs multiplié par `pctScale`, la
    // part hors prolongation. Or la tuile d'équipe en face s'appelle
    // « {ÉQUIPE} Wins (ML) » — victoire toutes issues confondues, prolongations
    // comprises. Recopier le score tel quel aurait retiré ~10 points à un pari
    // qui ne les perd pas, en silence et sur toutes les pages d'équipe.
    //
    // On divise donc par l'échelle pour retrouver la question large, qui est
    // celle que pose cette page. Les FACTEURS, eux, se recopient sans
    // retouche : ils décrivent « qui gagne ? » dans les deux cas.
    const byServerId: Record<string, { factors?: RuleFactor[]; factorGroup?: string; rulePct?: number }> = {};
    for (const g of apiGroups) for (const o of g.options as any[]) {
      if (typeof o.rulePct !== "number") continue;
      const scale = typeof o.pctScale === "number" && o.pctScale > 0 ? o.pctScale : 1;
      const unscaled = typeof o.rulePct === "number"
        ? Math.round(Math.max(3, Math.min(97, o.rulePct / scale)))
        : undefined;
      byServerId[o.id] = {
        ...(o.factors?.length ? { factors: o.factors, factorGroup: o.factorGroup } : {}),
        rulePct: unscaled,
      };
    }
    // Une tuile sans chiffre serveur DISPARAÎT, elle ne garde pas son calcul
    // local ; un groupe vidé disparaît avec elle.
    return teamGroups
      .map((g) => ({
        ...g,
        options: g.options.flatMap((o) => {
          const src = TEAM_ID_MAP[o.id] ? byServerId[TEAM_ID_MAP[o.id]] : undefined;
          return src && typeof src.rulePct === "number" ? [{ ...o, ...src, rulePct: src.rulePct }] : [];
        }),
      }))
      // Moneyline : les deux côtés font 100 % — le dé-scaling de `ml-away`
      // arrondit de son côté et pouvait donner 101.
      .map((g) => {
        if (g.id !== "moneyline") return g;
        const win = g.options.find((o) => o.id === "t-win");
        return win
          ? { ...g, options: g.options.map((o) => o.id === "t-lose" ? { ...o, rulePct: 100 - win.rulePct } : o) }
          : g;
      })
      .filter((g) => g.options.length > 0);
  })();

  // ── Tableaux du serveur qui REMPLACENT ceux de la page ────────────────────
  //
  // Puck line (±1.5/2.5/3.5), total du match (2.5 → 7.5), buts de l'équipe
  // (0.5 → 4.5), les deux marquent (1+/2+/3+) et les trois cartes de période
  // sont les MÊMES tableaux que sur la page d'un match, calculés par le même
  // code serveur (`computeGameMarkets`, vue équipe = contre un adversaire
  // moyen). Les tuiles locales qu'ils remplacent étaient des constantes et des
  // règles de pouce (« −1.5 = victoire − 18 % »).
  //
  // Le serveur désigne l'adversaire moyen par `OPP`. Un pari posé depuis cette
  // page se règle sur le match CHOISI dans le sélecteur : `OPP` y devient donc
  // l'adversaire réel, et le côté domicile/extérieur celui du vrai match. Sans
  // match choisi, les tuiles qui portent sur l'adversaire n'ont pas de sujet —
  // elles s'affichent, mais sans marché (pas de ML, pas de règlement).
  const SERVER_TABLES = ["puckline", "totals", "teamtotals", "btts", "p1", "p2", "p3"];
  const adaptMl = (ml: MLProps | undefined): MLProps | undefined => {
    if (!ml) return undefined;
    const opp = selectedGame?.opponentAbbr?.toUpperCase();
    const onOpp = ml.subjectId === "OPP";
    const subjectId = onOpp ? opp : ml.subjectId;
    if (!subjectId) return undefined;
    const teamIsHome = selectedGame ? selectedGame.isHome : ml.isHome;
    return {
      ...ml,
      subjectId,
      opponentId: onOpp ? data.abbr : (opp ?? undefined),
      isHome: onOpp ? (teamIsHome == null ? undefined : !teamIsHome) : teamIsHome,
      gameId: selectedGame?.id,
    };
  };
  const serverTables: MktGroup[] = (apiGroups ?? [])
    .filter(g => SERVER_TABLES.includes(g.id) && g.tables?.length)
    .map(g => ({
      ...g,
      options: g.options.map(o => ({ ...o, mlProps: adaptMl((o as { ml?: MLProps }).ml) })),
    }));
  const byServerGroup = new Map(serverTables.map(g => [g.id, g] as const));

  // On parcourt l'ordre des groupes LOCAUX (non filtrés) : un groupe local vidé
  // faute de chiffre serveur doit quand même laisser sa place au tableau du
  // serveur qui le remplace.
  const filteredById = new Map(teamGroupsF.map(g => [g.id, g] as const));
  const shownGroups: MktGroup[] = teamGroups.flatMap((local): MktGroup[] => {
    const g = filteredById.get(local.id);
    const own = g ? [g] : [];
    const take = (...ids: string[]) => ids.map(id => byServerGroup.get(id)).filter((x): x is MktGroup => !!x);
    if (local.id === "puckline") return take("puckline").length ? take("puckline") : own;
    if (local.id === "totals")   return take("totals", "teamtotals").length ? take("totals", "teamtotals") : own;
    if (local.id === "period")   return take("p1", "p2", "p3").length ? take("p1", "p2", "p3") : own;
    if (local.id === "clean") {
      // Le blanchissage reste une tuile ; « les deux marquent » passe au tableau.
      const btts = take("btts");
      if (!btts.length) return own;
      const cs = g ? g.options.filter(o => o.id !== "t-btts") : [];
      return [...(cs.length ? [{ ...local, title: "Clean Sheet", options: cs }] : []), ...btts];
    }
    return own;
  });

  // ── Chiffre ML de chaque tuile, lu dans le paquet par la QUESTION posée ──
  //
  // Les tuiles de cette page ne sont pas celles de la page match : on les
  // retrouve par leur marché (`mlBundleKey`), pas par leur identifiant. Les
  // tuiles locales disent explicitement la question qu'elles posent ; les
  // tableaux venus du serveur la portent dans leur `mlProps`, déjà recalé sur
  // le vrai match (`adaptMl`).
  const teamHome = selectedGame?.isHome ?? true;
  const LOCAL_KEYS: Record<string, [string, number | null, string | null, boolean]> = {
    "t-win":        ["moneyline", null, null, teamHome],
    "t-lose":       ["moneyline", null, null, !teamHome],
    "t-ml-ot":      ["game_to_ot", null, "yes", true],
    "t-cs":         ["clean_sheet", null, "yes", teamHome],
    "t-btts":       ["both_teams_score", null, "yes", true],
    "t-pp-goal":    ["team_pp_goals", null, "yes", teamHome],
    "t-pk":         ["team_penalty_kill", null, "yes", teamHome],
    "t-w1":         ["winning_margin", null, "1", teamHome],
    "t-w2":         ["winning_margin", null, "2", teamHome],
    "t-w3":         ["winning_margin", null, "3+", teamHome],
    "t-pl-fav":     ["puck_line", -1.5, null, teamHome],
    "t-pl-dog":     ["puck_line", -1.5, "no", !teamHome],
    "t-team-over":  ["team_total_goals", 2.5, "over", teamHome],
    "t-team-under": ["team_total_goals", 2.5, "under", teamHome],
    "t-p1":         ["period1_winner", null, null, teamHome],
    "t-p2":         ["period2_winner", null, null, teamHome],
    "t-p3":         ["period3_winner", null, null, teamHome],
  };
  const mlFor = (o: BetOpt): MLPredictionResult | null | undefined => {
    if (mlBundle === undefined) return undefined;
    if (mlBundle === null) return null;
    const local = LOCAL_KEYS[o.id];
    if (local) return mlBundle.byKey[mlBundleKey(...local)] ?? null;
    const m = o.mlProps;
    if (!m?.propType || m.type !== "game") return null;
    return mlBundle.byKey[mlBundleKey(m.propType, m.line, m.selection, m.isHome !== false)] ?? null;
  };
  const groupsWithMl: MktGroup[] = shownGroups.map(g => {
    const options = g.options.map(o => {
      // `mlBundleKey` lit un résultat de TUILE : un pari « +x » est déclaré
      // comme le « −x » adverse côté « non ». Le paquet renvoie déjà le côté
      // demandé — rien à inverser ici.
      return { ...o, mlExternal: true, mlPreset: mlFor(o) };
    });
    if (g.id !== "moneyline") return { ...g, options };
    // Moneyline : le chiffre ML de l'adversaire est le complément exact.
    const win = options.find(o => o.id === "t-win")?.mlPreset;
    return {
      ...g,
      options: options.map(o => o.id === "t-lose" && win && o.mlPreset
        ? { ...o, mlPreset: { ...o.mlPreset, probability: 100 - win.probability } }
        : o),
    };
  });

  return (
    <div className="flex flex-col gap-3">
      {/* Which game these bets are for — next game by default */}
      <GameSelector games={games} selected={selectedGame} onSelect={selectGame} accent={accent} />

      {/* Team header */}
      <div className="bg-[#131A12] border border-white/20 rounded-2xl p-4">
        <div className="flex items-center gap-3 mb-3">
          <img src={data.logo} alt={data.name} className="w-12 h-12 object-contain" />
          <div className="flex-1">
            <p className="text-white font-bold text-base">{data.name}</p>
            <p className="text-[#8a9ea6] text-xs">{data.conf}ern · {data.pts} pts · {data.streak || "—"}</p>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {[
            { label: "Home",   value: data.homeRecord || "—" },
            { label: "Away",   value: data.awayRecord  || "—" },
            { label: "PP%",    value: data.ppPct ? data.ppPct.toFixed(1)+"%" : "—" },
            { label: "PK%",    value: data.pkPct ? data.pkPct.toFixed(1)+"%" : "—" },
          ].map(s => (
            <div key={s.label} className="bg-[#0A0E0C] rounded-xl p-2 text-center">
              <p className="text-white text-xs font-bold">{s.value}</p>
              <p className="text-[#8a9ea6] text-[11px]">{s.label}</p>
            </div>
          ))}
        </div>
      </div>
      {/* Recent form — shown above the markets */}

      {/* Market groups — reveal-all toggle */}
      <StatsBanner type="team" id={teamId} />
      <PredictionsRevealBar />
      <BetOddsCtx.Provider value={odds}>
        <RevealModeCtx.Provider value={revealMode}>
          {apiGroups == null
            ? <ServerGroupsPending failed={apiFailed} onRetry={retryApi} />
            : groupsWithMl.map(g => <MarketGroup key={g.id} group={g} accent={accent} />)}

          {/* Paris joueur du club, en grille — le match sélectionné les suit,
              pour qu'ils se règlent sur cette affiche. */}
          <PlayerPropGrid metric="goals"   sides={[{ key: "team", abbr: data.abbr, name: data.name }]} gameId={selectedGame?.id} accent={accent} />
          <PlayerPropGrid metric="points"  sides={[{ key: "team", abbr: data.abbr, name: data.name }]} gameId={selectedGame?.id} accent={accent} />
          <PlayerPropGrid metric="shots"   sides={[{ key: "team", abbr: data.abbr, name: data.name }]} gameId={selectedGame?.id} accent={accent} />
          <PlayerPropGrid metric="assists" sides={[{ key: "team", abbr: data.abbr, name: data.name }]} gameId={selectedGame?.id} accent={accent} />
          <PlayerPropGrid metric="blocks"  sides={[{ key: "team", abbr: data.abbr, name: data.name }]} gameId={selectedGame?.id} accent={accent} />
          <PlayerPropGrid metric="hits"    sides={[{ key: "team", abbr: data.abbr, name: data.name }]} gameId={selectedGame?.id} accent={accent} />
          {/* Gardiens — seule grille où ils apparaissent. */}
          <PlayerPropGrid metric="saves"   sides={[{ key: "team", abbr: data.abbr, name: data.name }]} gameId={selectedGame?.id} accent={accent} />
        </RevealModeCtx.Provider>
      </BetOddsCtx.Provider>

      {/* Les lignes de saison complètes vivent sur la page Statistiques. */}
      <button
        onClick={() => navigate(`/stats/chart/team/${teamId}`)}
        className="w-full py-3 rounded-2xl text-xs font-semibold border transition-transform active:scale-[0.98]"
        style={{ background: accent + "14", color: accent, borderColor: accent + "44" }}
      >
        {t("pred.viewRoster")}
      </button>
    </div>
  );
}
