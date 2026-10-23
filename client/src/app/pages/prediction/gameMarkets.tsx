/**
 * gameMarkets.tsx
 *
 * Extrait de PredictionPage.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { nhlApiService } from "../../services/nhlApiService";
import { normalizeMarket } from "../../services/predictionRequest";
import type { MLPredictionResult } from "../../services/mlApi";


/* ─── Game Prediction ──────────────── */


export interface LiveGameView {
  id: string;
  // `null` = probabilité du modèle indisponible ; la page masque les marchés
  // dérivés du modèle au lieu d'en inventer un.
  home: { abbr: string; name: string; logo: string; score?: number; winPct: number | null };
  away: { abbr: string; name: string; logo: string; score?: number; winPct: number | null };
  period?: string; time?: string; overUnder: number;
  /** `scheduled` | `live` | `final` — c'est lui qui dit si le match est en cours, pas `period`. */
  status?: string;
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
  /**
   * Pari JOUEUR seulement — ce que le coupon affiche, jamais ce qu'il règle.
   *
   * `subjectId` d'un joueur est son identifiant NHL (« 8478402 ») : posé tel
   * quel dans `subjectName`, c'est ce code qui s'affichait dans le coupon, et
   * `nhlLogoUrl(subjectId)` y cherchait le logo d'une « équipe » 8478402.
   * Le coupon montre désormais l'ÉQUIPE du joueur (logo + abréviation) et, à la
   * place du code, ce qui a été parié — nom du joueur compris. `subjectId`
   * reste l'identifiant : c'est lui que le règlement lit.
   */
  teamAbbr?: string;
  playerName?: string;
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
export interface BetOpt {
  id: string; label: string; rulePct: number; ruleNote: string;
  mlProps?: MLProps; factors?: RuleFactor[]; factorGroup?: string;
  /**
   * Marché ML annoncé PAR LE SERVEUR pour cette tuile (`BetMlProps` dans
   * `nhlPredictions.ts`). `GamePrediction.tsx` le préfère à l'appariement par
   * identifiant, qui ratait 17 tuiles parce que client et serveur n'ont jamais
   * nommé les options pareil.
   */
  ml?: MLProps;
  /**
   * Fraction appliquée au mélange des facteurs, pour une tuile qui n'est pas
   * exactement la question que ses facteurs décrivent.
   *
   * Le cas qui l'a fait naître : « ${équipe} en temps réglementaire ». Ses
   * facteurs sont ceux de « qui gagne ? » — c'est bien la même question — mais
   * la tuile en exclut les prolongations. Sans ce facteur d'échelle, l'éditeur
   * de pondération recalculait le score depuis les facteurs et la tuile
   * remontait à P(victoire, prolongations comprises) : le chiffre du marché
   * voisin, sur une tuile qui dit le contraire.
   *
   * Posée par le serveur (`nhlPredictions.ts`), appliquée APRÈS le mélange, donc
   * une repondération par l'utilisateur la traverse. Absente = 1.
   */
  pctScale?: number;
  /**
   * Résultat ML DÉJÀ CALCULÉ pour cette tuile — la tuile et sa fiche l'affichent
   * sans appeler `/predict/ml`. Posé par les grilles de paris joueur, qui
   * reçoivent les cadences de tout l'alignement en une requête
   * (`/predictions/player-rates/...`). `null` = pas de chiffre ML pour cette
   * case (statistique non publiée) ; absent = la tuile interroge le modèle
   * comme avant.
   */
  mlPreset?: MLPredictionResult | null;
  /**
   * Le chiffre ML de cette tuile vient de son CONTENEUR (`mlPreset`), jamais
   * d'un appel `/predict/ml`. Tant que `mlPreset` est absent, la tuile attend
   * (« … ») au lieu de partir interroger le modèle case par case.
   */
  mlExternal?: boolean;
  /**
   * Sous ce pourcentage, la tuile affiche « <3% » au lieu du chiffre. Une
   * grille de joueurs est pleine de 0,4 % et de 1,8 % : les écrire donnerait
   * une précision qu'une moyenne de saison n'a pas, les remonter à 3 % (ou à
   * 5 %) rendait Demidov et Danault identiques sur « 2+ buts ».
   */
  belowFloor?: number;
  /**
   * `true` = chiffre recalculé sur l'état du match en cours (serveur, ou grille
   * joueur). Pendant une partie : blanc opaque ; sans lui, chiffre d'avant-match
   * affiché plus pâle (voir `BetOption`).
   */
  live?: boolean;
}
/**
 * Mise en tableau d'un groupe — le jumeau de `MarketTable` côté serveur
 * (`nhlPredictions.ts`). Les cases référencent les options du groupe par
 * identifiant ; `options` reste la liste plate de tous les paris.
 */
export interface MktTable {
  title?: string;
  rowHeader?: string;
  columnGroups?: { label: string; span: number }[];
  columns: string[];
  rows: { label: string; cells: (string | null)[] }[];
}
export interface MktGroup { id: string; title: string; cols: 2 | 3; options: BetOpt[]; tables?: MktTable[]; }

/**
 * Clé d'une QUESTION posée au modèle ML sur un match : marché, ligne,
 * sélection, côté du sujet. Sert à retrouver un chiffre dans le paquet ML du
 * match (`byKey`) depuis une page qui a ses propres tuiles (équipe, joueur).
 *
 * ⚠️ Jumelle de `mlBundleKey` côté serveur (`gameMlBundle.ts`) — même chaîne.
 * Les marchés « sans côté » (totaux, les deux marquent, prolongation, score
 * exact, égalité) prennent toujours le côté domicile.
 */
const SIDELESS = new Set([
  "total_goals", "total_goals_over", "total_goals_under", "both_teams_score",
  "game_to_ot", "period1_total_goals", "period2_total_goals", "period3_total_goals",
  "correct_score",
]);
export function mlBundleKey(market: string, line: number | null | undefined,
                            selection: string | null | undefined, subjectIsHome: boolean): string {
  const sel = (selection ?? "").trim().toLowerCase();
  const side = SIDELESS.has(market) || sel === "draw" ? "h" : (subjectIsHome ? "h" : "a");
  return `${market}|${line ?? ""}|${sel}|${side}`;
}

/**
 * Le score de règles d'une tuile, facteurs et échelle compris.
 *
 * Une seule fonction pour la tuile ET pour la fiche ouverte : les deux la
 * calculaient séparément, et c'est exactement ainsi qu'un pari finit par
 * afficher deux pourcentages différents selon qu'on le regarde ou qu'on
 * l'ouvre.
 */
export function scaledRulePct(blended: number, pctScale?: number): number {
  if (!pctScale || pctScale === 1 || !Number.isFinite(pctScale)) return blended;
  return Math.round(Math.max(3, Math.min(97, blended * pctScale)));
}

/* Les tuiles des pages match viennent toutes du serveur (`nhlPredictions.ts`),
 * marché ML compris (`option.ml`, imposé par un test côté serveur, avant-match
 * ET en direct). Le constructeur local `buildGameGroups` — des `rulePct`
 * constants ou approximatifs (over 54 %, −1,5 = victoire − 18 %) qui ne
 * servaient plus que de table de repli des `mlProps` — a été supprimé le
 * 2026-10-05. */

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

/**
 * Lignes de faits pour l'« Analyse IA » d'un pari JOUEUR ou ÉQUIPE (le serveur
 * bâtit lui-même celles d'un pari de match). Une ligne = un fait chiffré, que
 * le LLM peut citer ; une donnée absente n'est JAMAIS écrite (« ? » invitait le
 * modèle à combler le trou). Vide si rien n'est disponible.
 */
export async function buildLLMExtraFacts(mlProps: MLProps | undefined, fr: boolean): Promise<string[]> {
  if (!mlProps) return [];
  const teamLine = (a: string, s: any): string | null => {
    if (!s) return null;
    const parts: string[] = [];
    if (s.wins != null) parts.push(fr ? `fiche ${s.wins}-${s.losses}-${s.otLosses}` : `record ${s.wins}-${s.losses}-${s.otLosses}`);
    if (s.last10) parts.push(fr ? `10 derniers ${s.last10}` : `last 10 ${s.last10}`);
    if (s.goalsForPerGame != null) parts.push(fr ? `buts pour/contre ${fmtNum(s.goalsForPerGame, 2, fr)}/${fmtNum(s.goalsAgainstPerGame, 2, fr)}` : `goals for/against ${fmtNum(s.goalsForPerGame, 2, fr)}/${fmtNum(s.goalsAgainstPerGame, 2, fr)}`);
    if (s.powerPlayPct != null) parts.push(fr ? `AN ${fmtNum(s.powerPlayPct, 1, fr)} %, DN ${fmtNum(s.penaltyKillPct, 1, fr)} %` : `PP ${fmtNum(s.powerPlayPct, 1, fr)}%, PK ${fmtNum(s.penaltyKillPct, 1, fr)}%`);
    return parts.length ? `${a} : ${parts.join(", ")}` : null;
  };
  try {
    if (mlProps.type === "player") {
      const [info, st, oppStats] = await Promise.all([
        nhlApiService.getPlayer(mlProps.subjectId).catch(() => null),
        nhlApiService.getPlayerStats(mlProps.subjectId).catch(() => null),
        mlProps.opponentId ? nhlApiService.getTeamStats(mlProps.opponentId).catch(() => null) : Promise.resolve(null),
      ]);
      if (!st) return [];
      const name = info?.name ?? info?.fullName ?? mlProps.playerName ?? "";
      const team = info?.teamAbbr ?? mlProps.teamAbbr ?? "";
      const gp = st.gamesPlayed || 0;
      const out: string[] = [];
      if (info?.position === "G" || st.savePct != null) {
        out.push(fr
          ? `Gardien ${name} (${team}) : ${gp} MJ, % d'arrêts ${fmtNum(st.savePct, 3, fr)}, moyenne de buts alloués ${fmtNum(st.goalsAgainstAvg, 2, fr)}`
          : `Goalie ${name} (${team}): ${gp} GP, SV% ${fmtNum(st.savePct, 3, fr)}, GAA ${fmtNum(st.goalsAgainstAvg, 2, fr)}`);
      } else {
        const per = (n: number) => (gp ? n / gp : 0);
        out.push(fr
          ? `Saison de ${name} (${team}) : ${gp} MJ, ${st.goals} B, ${st.assists} A, ${st.points} PTS (${fmtNum(per(st.points), 2, fr)} pt/match)`
          : `${name} (${team}) season: ${gp} GP, ${st.goals} G, ${st.assists} A, ${st.points} P (${fmtNum(per(st.points), 2, fr)} P/GP)`);
        const rate: Record<string, [number, string, string]> = {
          goals: [per(st.goals), "but", "goal"], assists: [per(st.assists), "passe", "assist"], points: [per(st.points), "point", "point"],
        };
        const r = mlProps.propType ? rate[mlProps.propType] : undefined;
        if (r && mlProps.line != null) {
          out.push(fr
            ? `Cadence : ${fmtNum(r[0], 2, fr)} ${r[1]}/match contre une ligne de ${fmtNum(mlProps.line, 1, fr)}`
            : `Rate: ${fmtNum(r[0], 2, fr)} ${r[2]}/game vs a line of ${fmtNum(mlProps.line, 1, fr)}`);
        }
        out.push(fr
          ? `Utilisation : ${fmtNum(st.timeOnIce, 1, fr)} min/match, tirs ${fmtNum(st.shootingPct, 1, fr)} %, ${st.plusMinus >= 0 ? "+" : ""}${st.plusMinus}`
          : `Usage: ${fmtNum(st.timeOnIce, 1, fr)} min/game, shooting ${fmtNum(st.shootingPct, 1, fr)}%, ${st.plusMinus >= 0 ? "+" : ""}${st.plusMinus}`);
      }
      const opp = teamLine(mlProps.opponentId?.toUpperCase() ?? "", oppStats);
      if (opp) out.push(fr ? `Adversaire — ${opp}` : `Opponent — ${opp}`);
      return out.filter(l => !/NaN|undefined|\?/.test(l));
    }
    const abbrs = mlProps.type === "game" && mlProps.opponentId ? [mlProps.subjectId, mlProps.opponentId] : [mlProps.subjectId];
    const lines = await Promise.all(abbrs.map(async a => teamLine(a, await nhlApiService.getTeamStats(a).catch(() => null))));
    return lines.filter((l): l is string => !!l);
  } catch {
    return [];
  }
}

/* ─── Cache des réponses LLM (localStorage) ──────────────────────────────────
   Une réponse générée est gardée 24 h par pari : rouvrir la même prédiction ne
   re-demande pas la même question au LLM. */
const LLM_CACHE_KEY = "iceedge.llmCache";
// 3 h et non plus 24 h : l'analyse parle de gardiens, d'alignements et de cotes,
// qui bougent dans la journée. Une analyse écrite à 10 h ne doit pas survivre à
// l'annonce du gardien de 17 h.
const LLM_CACHE_TTL = 3 * 60 * 60 * 1000; // 3 h

export function llmCacheId(label: string, mlProps: MLProps | undefined, lang: string): string {
  // « ml2 » : depuis le 2026-10-04 l'analyse est structurée (faits calculés par
  // le serveur, JSON). Le préfixe écarte les anciennes réponses en texte libre
  // (« Verdict : … »). Avant : « ml » (2026-10-01, chiffre ML au lieu des règles).
  return ["ml2", mlProps?.subjectId ?? "", mlProps?.opponentId ?? "", mlProps?.propType ?? "", mlProps?.line ?? "", label, lang].join("|");
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

