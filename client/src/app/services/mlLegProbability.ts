/**
 * mlLegProbability.ts — le chiffre ML d'une jambe construite HORS d'une page
 * prédiction : bouton « + » des cartes (MarketSelectorSheet) et Bet builder IA
 * (slipCommandLegs). Les deux passent par `buildLeg`.
 *
 * 2026-10-02 (demande du user) : ces deux chemins enregistraient le chiffre du
 * moteur de RÈGLES (`POST /predict/single`), alors que les tuiles, l'accueil et
 * le coupon ouvert depuis une fiche portent le chiffre ML. Ici, on calcule le
 * chiffre ML exactement comme les pages prédiction :
 *
 *   · paris de match / d'équipe → le paquet ML du match (`fetchGameMlBundle`,
 *     clé `mlBundleKey`, mêmes conventions que les tuiles du serveur — voir
 *     `gm` / `gma` dans `server/src/services/nhlPredictions.ts`), puis
 *     `POST /predict/ml` pour une ligne que le paquet ne porte pas ;
 *   · paris joueur → les cadences du joueur (`getPlayerRates`) et la même
 *     binomiale négative que `PlayerPrediction` / `PlayerPropGrid`.
 *
 * `null` = le modèle n'a pas de chiffre pour ce pari. `buildLeg` retombe alors
 * sur les règles (le coupon a besoin d'un nombre) — même règle que la fiche.
 */
import { fetchGameMlBundle, fetchMLProbability } from "../components/MLPredictionCard";
import { mlBundleKey } from "../pages/prediction/gameMarkets";
import { dispersionFor, ratePct } from "../pages/prediction/rateMath";
import { nhlApiService, type RateStat } from "./nhlApiService";

export interface MlLegQuery {
  subjectType: "team" | "player" | "game";
  /** Équipe (abr.), joueur (id) ou match (id). */
  subjectId: string;
  marketType: string;
  selection: string;
  line: number | undefined;
  gameId: string | null;
  /** Abréviations du match, domicile / extérieur. */
  homeAbbr?: string;
  awayAbbr?: string;
}

const PLAYER_STAT: Record<string, { stat: RateStat; line?: number }> = {
  anytime_goal:       { stat: "goals", line: 0.5 },
  shots_ou:           { stat: "shots" },
  assists_ou:         { stat: "assists" },
  points_ou:          { stat: "points" },
  pp_point:           { stat: "ppPoints", line: 0.5 },
  goalie_saves_ou:    { stat: "saves" },
  blocked_shots_ou:   { stat: "blocks" },
  hits_ou:            { stat: "hits" },
  penalty_minutes_ou: { stat: "pim" },
};

async function playerPct(q: MlLegQuery): Promise<number | null> {
  const rates = await nhlApiService.getPlayerRates("player", q.subjectId, q.gameId ?? undefined).catch(() => null);
  const row = rates?.players?.[q.subjectId];
  if (!rates || !row) return null;
  if (q.marketType === "first_goal_scorer") {
    return row.firstGoal == null ? null : Math.round(row.firstGoal * 100);
  }
  const spec = PLAYER_STAT[q.marketType];
  if (!spec) return null;
  const rate = row.rates[spec.stat];
  const line = spec.line ?? q.line;
  if (rate == null || line == null) return null;
  const side = q.selection === "under" ? "under" : "over";
  return ratePct(rate, line, dispersionFor(rates, row.source, spec.stat), side);
}

/** Une question au modèle de match : clé du paquet + requête `/predict/ml` de repli. */
interface GameAsk { market: string; line: number | null; selection: string | null; subjectIsHome: boolean }

/** Traduit un marché du coupon en question(s) au modèle ; `sum` additionne, `invert` complète à 100. */
function gameAsks(q: MlLegQuery, subjectIsHome: boolean): { asks: GameAsk[]; invert?: boolean } | null {
  const sel = (q.selection ?? "").toLowerCase();
  const L = q.line ?? null;
  const home = (q.homeAbbr ?? "").toLowerCase();
  // Côté de la sélection quand elle nomme une équipe (pari sur un match).
  const teamSide = sel === home ? true : sel === (q.awayAbbr ?? "").toLowerCase() ? false : subjectIsHome;
  const one = (market: string, line: number | null, selection: string | null, side: boolean) =>
    ({ asks: [{ market, line, selection, subjectIsHome: side }] });

  switch (q.marketType) {
    case "moneyline":         return one("moneyline", null, null, teamSide);
    case "regulation_result":
      return sel === "draw" ? one("game_to_ot", null, "yes", true) : one("regulation_result", null, null, teamSide);
    case "puck_line":         return one("puck_line", -1.5, null, teamSide);
    case "alt_puck_line": {
      if (L == null) return null;
      const side = sel === "away" ? false : true;
      // Équipe à −x : la tuile du serveur ; à +x : le « non » de l'adversaire à −x.
      return L < 0 ? one("puck_line", L, null, side) : one("puck_line", -L, "no", !side);
    }
    case "total_goals":
      return L == null ? null : one(sel === "under" ? "total_goals_under" : "total_goals_over", L, null, true);
    case "game_to_ot":        return one("game_to_ot", null, sel === "no" ? "no" : "yes", true);
    case "both_teams_score":  return one("both_teams_score", null, sel === "no" ? "no" : "yes", true);
    case "ot_winner":         return one("ot_so_winner", null, null, teamSide);
    case "period1_winner": case "period2_winner": case "period3_winner":
      return one(q.marketType, null, null, teamSide);
    case "period1_total_goals": case "period2_total_goals": case "period3_total_goals":
      if (L == null) return null;
      return { asks: [{ market: q.marketType, line: L, selection: "over", subjectIsHome: true }], invert: sel === "under" };
    case "first_team_score": case "last_team_score":
      return one(q.marketType, null, null, teamSide);
    case "team_total_goals":
      return L == null ? null : one("team_total_goals", L, sel === "under" ? "under" : "over", subjectIsHome);
    case "clean_sheet":       return one("clean_sheet", null, "yes", subjectIsHome);
    case "team_pp_goals":
      // Seul « au moins un but en AN » (= over 0.5) est une question du modèle.
      if (L !== 0.5) return null;
      return { asks: [{ market: "team_pp_goals", line: null, selection: "yes", subjectIsHome }], invert: sel === "under" };
    case "winning_margin": {
      // home_1 | home_2plus | away_1 | away_2plus
      const side = !sel.startsWith("away");
      if (sel.endsWith("_1")) return one("winning_margin", null, "1", side);
      if (sel.endsWith("_2plus")) return {
        asks: [
          { market: "winning_margin", line: null, selection: "2", subjectIsHome: side },
          { market: "winning_margin", line: null, selection: "3+", subjectIsHome: side },
        ],
      };
      return null;
    }
    default: return null;
  }
}

async function gamePct(q: MlLegQuery, subjectIsHome: boolean): Promise<number | null> {
  const plan = gameAsks(q, subjectIsHome);
  if (!plan || !q.gameId) return null;
  const bundle = await fetchGameMlBundle(q.gameId);
  const home = (q.homeAbbr ?? "").toUpperCase();
  const away = (q.awayAbbr ?? "").toUpperCase();

  let total = 0;
  for (const a of plan.asks) {
    let p: number | null = null;
    const hit = bundle?.byKey[mlBundleKey(a.market, a.line, a.selection, a.subjectIsHome)];
    if (hit && Number.isFinite(hit.probability)) p = Math.round(hit.probability);
    // Ligne absente du paquet : la même question, tuile par tuile.
    if (p == null && home && away) {
      p = await fetchMLProbability({
        type: "game",
        subjectId: a.subjectIsHome ? home : away,
        opponentId: a.subjectIsHome ? away : home,
        propType: a.market,
        line: a.line ?? undefined,
        selection: a.selection ?? undefined,
        isHome: a.subjectIsHome,
      });
    }
    if (p == null) return null;
    total += p;
  }
  const pct = plan.invert ? 100 - total : total;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/** Probabilité ML (0–100) d'une jambe, ou `null` si le modèle n'en a pas. */
export async function mlLegProbability(q: MlLegQuery): Promise<number | null> {
  try {
    if (q.subjectType === "player") return await playerPct(q);
    const subjectIsHome = q.subjectType === "team"
      ? q.subjectId.toLowerCase() === (q.homeAbbr ?? "").toLowerCase()
      : true;
    return await gamePct(q, subjectIsHome);
  } catch {
    return null;
  }
}
