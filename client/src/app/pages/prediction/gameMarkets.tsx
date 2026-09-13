/**
 * gameMarkets.tsx
 *
 * Extrait de PredictionPage.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { nhlApiService } from "../../services/nhlApiService";
import { normalizeMarket } from "../../services/predictionRequest";


/* ─── Game Prediction ──────────────── */


export interface LiveGameView {
  id: string;
  // `null` = probabilité du modèle indisponible ; la page masque les marchés
  // dérivés du modèle au lieu d'en inventer un.
  home: { abbr: string; name: string; logo: string; score?: number; winPct: number | null };
  away: { abbr: string; name: string; logo: string; score?: number; winPct: number | null };
  period?: string; time?: string; overUnder: number;
}

/* ─── Bet types & market groups ─────────────── */
export interface MLProps {
  type: "game" | "player" | "team"; subjectId: string; opponentId?: string; propType?: string;
  line?: number; isHome?: boolean; selection?: string;
  /** NHL game id — required for automatic settlement, injected after the game/player loads. */
  gameId?: string;
  /**
   * Canonical settlement market + selection, set ONLY on bet options where the
   * mapping is unambiguous (see settlementFields below). Left unset for options
   * whose `propType` is reused across several distinct markets (e.g. "goals" is
   * used for both "Anytime Goal" and "PP Goal" here) — auto-settling those from
   * the reused propType would risk crediting the wrong market as a win.
   */
  settleMarket?: string;
  settleSelection?: string;
}

/**
 * Resolve { marketType, selectionValue } for the bet-slip leg (used by
 * settlement.service.ts server-side), from an MLProps object.
 *   - if `settleMarket` was explicitly set on the option → use it verbatim
 *     (player props: only set where the mapping is unambiguous).
 *   - for game/team subjects, propType is already a canonical, unambiguous
 *     market name (moneyline, puck_line, total_goals_over…), so it's safe to
 *     derive it via the same normalizeMarket() the probability request uses;
 *     the team abbreviation (subjectId) is the selection for team-pick markets.
 *   - otherwise (player props with no explicit settleMarket) → leave both
 *     undefined so the leg simply stays "pending" instead of risking a wrong
 *     auto-settlement.
 */
export function settlementFields(mlProps: MLProps | undefined): { marketType?: string; selectionValue?: string } {
  if (!mlProps) return {};
  if (mlProps.settleMarket) {
    return { marketType: mlProps.settleMarket, selectionValue: mlProps.settleSelection };
  }
  if (mlProps.type === "game" || mlProps.type === "team") {
    const { marketType, selection } = normalizeMarket(mlProps.propType ?? "moneyline", mlProps.selection ?? mlProps.subjectId);
    return { marketType, selectionValue: selection };
  }
  return {};
}
export interface RuleFactor { id: string; label: string; weight: number; value: number; }
export interface BetOpt { id: string; label: string; rulePct: number; ruleNote: string; mlProps?: MLProps; factors?: RuleFactor[]; factorGroup?: string; }
export interface MktGroup { id: string; title: string; cols: 2 | 3; options: BetOpt[]; }

export function buildGameGroups(home: string, away: string, hp: number, ou: number): MktGroup[] {
  const ap = 100 - hp;
  // `selection` distingue les DEUX CÔTÉS d'un marché binaire servi sous un seul
  // `propType` (BTTS oui/non, blanchissage oui/non…). Sans lui, les deux tuiles
  // envoyaient une requête IDENTIQUE et recevaient donc le même pourcentage :
  // c'est ainsi que « les deux marquent » et « non » ont tous deux affiché 90 %
  // (Blues–Stars, 19 sept. 2026). Les marchés à un seul côté (moneyline, puck
  // line, totaux — qui portent over/under dans le `propType` lui-même) le
  // laissent undefined, exactement comme avant.
  const gml  = (propType: string, line?: number, selection?: string): MLProps =>
    ({ type: "game", subjectId: home, opponentId: away, propType, line, isHome: true,  selection });
  const gmla = (propType: string, line?: number, selection?: string): MLProps =>
    ({ type: "game", subjectId: away, opponentId: home, propType, line, isHome: false, selection });
  return [
    {
      id: "match", title: "Match Betting", cols: 3,
      options: [
        { id: "ml-home",  label: `${home} to Win`,   rulePct: hp,   mlProps: gml("moneyline"),
          ruleNote: `Win probability based on season stats: ${hp}%. Home ice advantage is included in the calculation.` },
        { id: "ml-ot",    label: "OT / Shootout",     rulePct: 22,   mlProps: gml("game_to_ot"),
          ruleNote: `~22-24% of NHL games go to OT or shootout, regardless of team strength.` },
        { id: "ml-away",  label: `${away} to Win`,   rulePct: ap,   mlProps: gmla("moneyline"),
          ruleNote: `Inverse of home probability: ${ap}%. Visitors carry a slight systemic disadvantage.` },
      ],
    },
    {
      id: "puckline", title: "Puck Line", cols: 2,
      options: [
        { id: "pl-home", label: `${home} -1.5`, rulePct: Math.max(10, hp - 18), mlProps: gml("puck_line"),
          ruleNote: `Winning by 2+ is ~18% harder than a straight win. Calculated from historical goal-differential data.` },
        // +1.5 visiteur est EXACTEMENT le complément de −1.5 domicile (pas de
        // push possible sur une demi-ligne), donc le même marché, côté « non ».
        // Il pointait sur `alt_puck_line`, qui ne veut pas dire la même chose
        // dans les deux moteurs (Node : « +1.5 couvre » ; Python : « gagne par
        // ≥3 ») et se calculait de toute façon pour l'équipe à DOMICILE.
        { id: "pl-away", label: `${away} +1.5`, rulePct: Math.min(90, ap + 18), mlProps: gml("puck_line", undefined, "no"),
          ruleNote: `Covering +1.5 means winning OR losing by exactly 1. Probability boosted ~18% vs moneyline.` },
      ],
    },
    {
      id: "totals", title: "Total Goals", cols: 2,
      options: [
        { id: "ou-over",     label: `Over ${ou}`,     rulePct: 54, mlProps: gml("total_goals_over", ou),
          ruleNote: `Based on combined offensive averages. The ${ou} line aligns with the NHL average of ~6.0 goals/game.` },
        { id: "ou-under",    label: `Under ${ou}`,    rulePct: 46, mlProps: gml("total_goals_under", ou),
          ruleNote: `Strong defense and tight games favor the under. Slightly less likely when both teams score well.` },
        { id: "ou-over-alt", label: `Over ${ou + 1}`, rulePct: 38, mlProps: gml("total_goals_over", ou + 1),
          ruleNote: `Higher alternate line — requires a more open, high-scoring game to hit.` },
        { id: "ou-under-alt",label: `Under ${ou + 1}`,rulePct: 62, mlProps: gml("total_goals_under", ou + 1),
          ruleNote: `Easier to hit — any defensive performance from either team keeps this alive.` },
      ],
    },
    {
      id: "btts", title: "Both Teams to Score", cols: 2,
      options: [
        { id: "btts-yes", label: "Yes", rulePct: Math.min(88, Math.round(hp * 0.42 + ap * 0.40 + 20)), mlProps: gml("both_teams_score", undefined, "yes"),
          ruleNote: `Both offenses producing at least one goal. Very common in NHL (~83% of games).` },
        { id: "btts-no",  label: "No",  rulePct: Math.max(12, 100 - Math.min(88, Math.round(hp * 0.42 + ap * 0.40 + 20))), mlProps: gml("both_teams_score", undefined, "no"),
          ruleNote: `Requires one team to be shut out — only ~17% of NHL games end this way.` },
      ],
    },
    {
      id: "p1", title: "1st Period Result", cols: 3,
      options: [
        { id: "p1-home", label: `${home} leads`, rulePct: Math.round(hp * 0.42 + 10), mlProps: gml("period1_winner"),
          ruleNote: `Home teams lead after P1 in ~${Math.round(hp * 0.42 + 10)}% of cases. Linked to early offensive momentum.` },
        { id: "p1-draw", label: "Tied",           rulePct: 30,
          ruleNote: `Tied after P1 in ~25-35% of NHL games. Common in balanced matchups.` },
        { id: "p1-away", label: `${away} leads`, rulePct: Math.round(ap * 0.38 + 8), mlProps: gmla("period1_winner"),
          ruleNote: `Visitors lead after P1 in ~${Math.round(ap * 0.38 + 8)}% of cases — harder without home crowd.` },
      ],
    },
    {
      id: "p1goals", title: "1st Period Goals", cols: 2,
      options: [
        { id: "p1-over", label: "Over 1.5",  rulePct: 37, mlProps: gml("period1_total_goals", 1.5),
          ruleNote: `~37% of NHL games see 2+ goals in the first period.` },
        { id: "p1-under",label: "Under 1.5", rulePct: 63,
          ruleNote: `First periods often start cautiously — under 1.5 hits ~63% of the time.` },
      ],
    },
    {
      id: "p2", title: "2nd Period Result", cols: 3,
      options: [
        { id: "p2-home", label: `${home} leads`, rulePct: Math.round(hp * 0.44 + 8), mlProps: gml("period2_winner"),
          ruleNote: `More predictive than P1 since more play has unfolded.` },
        { id: "p2-draw", label: "Tied",           rulePct: 28,
          ruleNote: `Tied after P2 in ~25-32% of games.` },
        { id: "p2-away", label: `${away} leads`, rulePct: Math.round(ap * 0.40 + 7), mlProps: gmla("period2_winner"),
          ruleNote: `Away team holding a lead after two periods.` },
      ],
    },
    {
      id: "p3", title: "3rd Period Result", cols: 3,
      options: [
        { id: "p3-home", label: `${home} leads`, rulePct: Math.round(hp * 0.48 + 6), mlProps: gml("period3_winner"),
          ruleNote: `Leading after P3 strongly correlates with the final result.` },
        { id: "p3-draw", label: "Tied → OT",      rulePct: 20, mlProps: gml("game_to_ot"),
          ruleNote: `Tied after regulation forces OT/SO — happens in ~20-22% of games.` },
        { id: "p3-away", label: `${away} leads`, rulePct: Math.round(ap * 0.44 + 5), mlProps: gmla("period3_winner"),
          ruleNote: `Away team ahead heading into OT or winning in regulation.` },
      ],
    },
    {
      id: "ot", title: "Extra Time", cols: 2,
      options: [
        { id: "ot-yes", label: "Goes to OT",      rulePct: 22, mlProps: gml("game_to_ot", undefined, "yes"),
          ruleNote: `~22-24% of NHL games go to overtime, independent of the teams involved.` },
        // « Réglé en 60 min » = complément de « va en prolongation ». Pointait
        // sur `regulation_result`, qui est P(le DOMICILE gagne en 60 min) — une
        // toute autre question, et un chiffre bien plus bas.
        { id: "ot-no",  label: "Decided in Reg",  rulePct: 78, mlProps: gml("game_to_ot", undefined, "no"),
          ruleNote: `Most games (78%) are decided inside regulation time.` },
      ],
    },
    {
      id: "margin", title: "Winning Margin", cols: 3,
      options: [
        { id: "wm-h1", label: `${home} by 1`,  rulePct: Math.round(hp * 0.18), mlProps: gml("winning_margin"),
          ruleNote: `One-goal wins are the most common margin in NHL hockey.` },
        { id: "wm-h2", label: `${home} by 2`,  rulePct: Math.round(hp * 0.13), mlProps: gml("winning_margin"),
          ruleNote: `Two-goal wins: comfortable but not a blowout.` },
        { id: "wm-h3", label: `${home} by 3+`, rulePct: Math.round(hp * 0.09), mlProps: gml("winning_margin"),
          ruleNote: `Blowout win — less common but more likely for dominant home teams.` },
        { id: "wm-a1", label: `${away} by 1`,  rulePct: Math.round(ap * 0.16), mlProps: gmla("winning_margin"),
          ruleNote: `Narrow away win — common when teams are evenly matched.` },
        { id: "wm-a2", label: `${away} by 2`,  rulePct: Math.round(ap * 0.11), mlProps: gmla("winning_margin"),
          ruleNote: `Away win by two goals.` },
        { id: "wm-a3", label: `${away} by 3+`, rulePct: Math.round(ap * 0.07), mlProps: gmla("winning_margin"),
          ruleNote: `Away blowout — rare but possible when visitors are heavily favored.` },
      ],
    },
    {
      id: "firstlast", title: "Goal Scorer", cols: 2,
      options: [
        { id: "first-home", label: `${home} scores first`, rulePct: Math.round(hp * 0.56 + 5), mlProps: gml("first_team_score"),
          ruleNote: `Correlated with win probability. Favorites open the scoring more often.` },
        { id: "first-away", label: `${away} scores first`, rulePct: Math.round(ap * 0.52 + 4), mlProps: gmla("first_team_score"),
          ruleNote: `Away team drawing first blood.` },
        { id: "last-home",  label: `${home} scores last`,  rulePct: Math.round(hp * 0.54 + 4), mlProps: gml("last_team_score"),
          ruleNote: `Final goal lightly correlates with overall team performance.` },
        { id: "last-away",  label: `${away} scores last`,  rulePct: Math.round(ap * 0.50 + 3), mlProps: gmla("last_team_score"),
          ruleNote: `Away team scoring the last goal of the game.` },
      ],
    },
  ];
}

/* ─── LLM data context ───────────────────────────────────────────────────────
 * Fetches the real stats the app already has for this bet's subject (team, game,
 * or player) and formats them as a compact facts block to feed the LLM, so it
 * reasons over actual numbers instead of asking the user to verify them.
 */
function fmtNum(n: number | undefined | null, digits: number, fr: boolean): string {
  if (n == null || Number.isNaN(Number(n))) return "?";
  const s = Number(n).toFixed(digits);
  return fr ? s.replace(".", ",") : s;
}

export async function buildLLMDataContext(mlProps: MLProps | undefined, fr: boolean): Promise<string> {
  if (!mlProps) return "";
  try {
    // ── Player bet: subjectId is a player id ──────────────────────────────
    if (mlProps.type === "player") {
      const [info, st] = await Promise.all([
        nhlApiService.getPlayer(mlProps.subjectId).catch(() => null),
        nhlApiService.getPlayerStats(mlProps.subjectId).catch(() => null),
      ]);
      if (!st) return "";
      const name = info?.name ?? info?.fullName ?? mlProps.subjectId;
      const pos = info?.position ?? "";
      const team = info?.teamAbbr ?? "";
      const gp = st.gamesPlayed || 0;
      if (pos === "G" || st.savePct != null) {
        return fr
          ? `Données de l'application — gardien (${name}, ${team}) : ${gp} MJ, % arrêts ${fmtNum(st.savePct, 3, fr)}, moy. buts alloués ${fmtNum(st.goalsAgainstAvg, 2, fr)}.`
          : `App data — goalie (${name}, ${team}): ${gp} GP, SV% ${fmtNum(st.savePct, 3, fr)}, GAA ${fmtNum(st.goalsAgainstAvg, 2, fr)}.`;
      }
      const ppg = gp ? st.points / gp : 0;
      const pm = `${st.plusMinus >= 0 ? "+" : ""}${st.plusMinus}`;
      return fr
        ? `Données de l'application — joueur (${name}, ${pos}, ${team}) : ${gp} MJ, ${st.goals} B ${st.assists} A ${st.points} PTS (${fmtNum(ppg, 2, fr)} pts/match), tirs ${fmtNum(st.shootingPct, 1, fr)} %, ${fmtNum(st.timeOnIce, 1, fr)} min/match, ${pm}.`
        : `App data — player (${name}, ${pos}, ${team}): ${gp} GP, ${st.goals}G ${st.assists}A ${st.points}P (${fmtNum(ppg, 2, fr)} P/GP), ${fmtNum(st.shootingPct, 1, fr)}% shooting, ${fmtNum(st.timeOnIce, 1, fr)} min TOI, ${pm}.`;
    }

    // ── Team or game bet: subjectId (and opponentId) are team abbrs ────────
    const abbrs = mlProps.type === "game" && mlProps.opponentId
      ? [mlProps.subjectId, mlProps.opponentId]
      : [mlProps.subjectId];

    const results = await Promise.all(
      abbrs.map(async (a) => {
        try { return { a, s: await nhlApiService.getTeamStats(a) }; }
        catch { return null; }
      })
    );

    const lines = results
      .filter((x): x is { a: string; s: Awaited<ReturnType<typeof nhlApiService.getTeamStats>> } => x != null)
      .map(({ a, s }) => {
        const rec = `${s.wins}-${s.losses}-${s.otLosses}`;
        return fr
          ? `${a} : fiche ${rec}, 10 derniers ${s.last10 ?? "?"}, séquence ${s.streak ?? "?"}, buts ${fmtNum(s.goalsForPerGame, 1, fr)}/${fmtNum(s.goalsAgainstPerGame, 1, fr)} pour/contre, AN ${fmtNum(s.powerPlayPct, 1, fr)} % DN ${fmtNum(s.penaltyKillPct, 1, fr)} %, dom. ${s.homeRecord ?? "?"} ext. ${s.awayRecord ?? "?"}`
          : `${a}: record ${rec}, last 10 ${s.last10 ?? "?"}, streak ${s.streak ?? "?"}, goals ${fmtNum(s.goalsForPerGame, 1, fr)}/${fmtNum(s.goalsAgainstPerGame, 1, fr)} for/against, PP ${fmtNum(s.powerPlayPct, 1, fr)}% PK ${fmtNum(s.penaltyKillPct, 1, fr)}%, home ${s.homeRecord ?? "?"} away ${s.awayRecord ?? "?"}`;
      });

    if (!lines.length) return "";
    const header = fr ? "Données de l'application" : "App data";
    return `${header}:\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

/* ─── Cache des réponses LLM (localStorage) ──────────────────────────────────
   Une réponse générée est gardée 24 h par pari : rouvrir la même prédiction ne
   re-demande pas la même question au LLM. */
const LLM_CACHE_KEY = "iceedge.llmCache";
const LLM_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 h

export function llmCacheId(label: string, mlProps: MLProps | undefined, lang: string): string {
  return [mlProps?.subjectId ?? "", mlProps?.opponentId ?? "", mlProps?.propType ?? "", mlProps?.line ?? "", label, lang].join("|");
}
export function loadLlmCache(id: string): string {
  try {
    const all = JSON.parse(localStorage.getItem(LLM_CACHE_KEY) || "{}");
    const e = all[id];
    return e && Date.now() - e.ts < LLM_CACHE_TTL ? e.text : "";
  } catch { return ""; }
}
export function saveLlmCache(id: string, text: string): void {
  try {
    const all = JSON.parse(localStorage.getItem(LLM_CACHE_KEY) || "{}");
    for (const k of Object.keys(all)) if (Date.now() - (all[k]?.ts ?? 0) >= LLM_CACHE_TTL) delete all[k];
    all[id] = { text, ts: Date.now() };
    localStorage.setItem(LLM_CACHE_KEY, JSON.stringify(all));
  } catch { /* stockage indisponible */ }
}

