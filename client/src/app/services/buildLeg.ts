/**
 * buildLeg.ts — construire une jambe de coupon.
 *
 * Sorti de `MarketSelectorSheet.tsx` le 2026-09-28 (SLIP_COMMANDE_PLAN.md § 4)
 * pour que la feuille ET la commande en langage naturel construisent la même
 * jambe de la même façon : même `id`, même `gameId`, même `selectionValue`,
 * même probabilité. Le code est DÉPLACÉ, pas réécrit ; les commentaires
 * d'origine suivent. Changements, tous décidés par le user le 2026-09-28 :
 *
 *   - le contrôle de doublon vit ici (`deps.hasLeg`) et passe AVANT l'appel au
 *     modèle, comme avant : un doublon rend `reason: "duplicate"` sans appel
 *     réseau ;
 *   - un pari JOUEUR porte son match comme un pari d'équipe (`input.game`,
 *     choisi dans la feuille sur 14 jours). Avant, la feuille le cherchait
 *     dans `useNHLData().games`, qui ne porte que la soirée du jour : un
 *     joueur qui jouait demain partait sans `gameId` et sa jambe ne se
 *     réglait jamais. Le match entre donc dans l'id de la jambe, dans son
 *     `gameId` et dans la ligne d'affiche, comme pour une équipe.
 */

import { predictionApiService, isPredictionUnavailable } from "./predictionApiService";
import { mlLegProbability } from "./mlLegProbability";
import type { MarketDefinition } from "../data/betMarkets";
import type { UIGame, UIPlayer, UITeam } from "../hooks/useNHLData";
import type { UpcomingGame } from "../pages/prediction/predictionShared";
import type { BetLeg, BetMarketType } from "../types/bet";

/** Ce sur quoi porte le pari — une équipe, un joueur ou un match. */
export interface LegSubject {
  id: string;
  type: "team" | "player" | "game";
  name: string;
  logo: string;
  subtitle: string;
}

// Les trois sujets, tels que la feuille les a toujours construits. La commande
// passe par les mêmes fonctions : même nom, même logo, même sous-titre, donc
// même jambe.
export function teamSubject(t: UITeam): LegSubject {
  return { id: t.id, type: "team", name: t.name, logo: t.logo, subtitle: `${t.record} · ${t.conf}ern` };
}

export function playerSubject(p: UIPlayer, team: UITeam | undefined): LegSubject {
  return {
    id: p.id,
    type: "player",
    name: p.name,
    logo: team?.logo ?? "",
    subtitle: `${team?.abbr ?? ""} · #${p.number} · ${p.position}`,
  };
}

/** `home` / `away` = équipes de `team1Id` / `team2Id`. */
export function gameSubject(g: UIGame, home: UITeam | undefined, away: UITeam | undefined): LegSubject {
  return {
    id: g.id,
    type: "game",
    name: home && away ? `${home.abbr} vs ${away.abbr}` : g.id,
    logo: "",
    subtitle: `${g.date} · ${g.time}`,
  };
}

export interface BuildLegInput {
  subject: LegSubject;
  market: MarketDefinition;
  /** Sélection choisie ; vide → « yes » (marchés sans sélection). */
  selection: string | null;
  /** Ligne choisie ; vide → la première des `lineOptions` du marché. */
  line: number | null;
  /**
   * Pari d'équipe ou de joueur : l'affiche choisie, vue depuis l'équipe du
   * sujet. `null` pour un pari sur un match (le match EST le sujet).
   */
  game: UpcomingGame | null;
  /**
   * Pari sur un MATCH : ses deux équipes (abréviations), pour poser la
   * question au modèle ML du bon côté. Ignoré pour une équipe ou un joueur
   * (l'affiche `game` les porte déjà).
   */
  teams?: { home: string; away: string } | null;
}

export interface BuildLegDeps {
  players: readonly UIPlayer[];
  getTeamById: (id: string) => UITeam | undefined;
  hasLeg: (legId: string) => boolean;
}

export type BuildLegResult =
  | { ok: true; leg: BetLeg }
  | { ok: false; reason: "duplicate" | "unavailable" };

/** « vs BOS » / « @ BOS » — même formulation que le sélecteur des pages prédiction. */
export function matchupLabel(g: UpcomingGame): string {
  return `${g.isHome ? "vs" : "@"} ${g.opponentAbbr}`;
}

function buildSelectionLabel(
  market: MarketDefinition,
  subject: LegSubject,
  selection: string,
  line: number | undefined,
  getTeamById: BuildLegDeps["getTeamById"]
) {
  const lineStr = line ? ` ${line}` : "";
  const selStr = selection === "over" ? "Over" : selection === "under" ? "Under" : selection;

  if (market.requiresLine && market.requiresSelection) {
    return {
      full: `${selStr}${lineStr} ${market.lineUnit} — ${market.label}`,
      short: `${selStr[0]}${lineStr} ${market.shortLabel}`,
    };
  }
  if (market.type === "double_chance") {
    // « EDM or draw » / « No draw » : la sélection seule ne dit pas l'issue.
    const teamData = selection === "no_draw" ? undefined : getTeamById(selection);
    return teamData
      ? { full: `${teamData.name} or draw — ${market.label}`, short: `${teamData.abbr}/X ${market.shortLabel}` }
      : { full: `No draw — ${market.label}`, short: `No draw ${market.shortLabel}` };
  }
  if (market.requiresSelection) {
    const teamData = getTeamById(selection);
    return {
      full: teamData ? `${teamData.name} — ${market.label}` : `${selStr} — ${market.label}`,
      short: teamData ? `${teamData.abbr} ${market.shortLabel}` : `${selStr} ${market.shortLabel}`,
    };
  }
  return {
    full: `${subject.name} — ${market.label}`,
    short: `${subject.name.split(" ").pop()} ${market.shortLabel}`,
  };
}

/**
 * Construit la jambe : id déterministe, contrôle de doublon, probabilité du
 * modèle, libellés, champs de règlement. Une erreur autre que « prédiction
 * indisponible » est relancée telle quelle, comme avant.
 */
export async function buildLeg(input: BuildLegInput, deps: BuildLegDeps): Promise<BuildLegResult> {
  const { subject, market, game } = input;
  const gameId = game?.id ?? null;

  const selectionValue = input.selection || "yes";
  const lineValue = input.line ?? market.lineOptions?.[0];
  // Équipe : l'affiche choisie donne l'adversaire et le côté, envoyés
  // explicitement (le chemin « page stats » de resolveSubjects) en plus du
  // gameId. Deux raisons de ne pas s'en remettre au seul gameId : le serveur
  // n'y déduit l'équipe sujet que si la sélection EST une abréviation
  // d'équipe — un « over » y ancrerait le calcul sur le côté domicile du
  // match, pas sur l'équipe choisie — et sa lecture du match est dans un
  // try/catch qui retombe silencieusement sur le corps de la requête.
  // Pari joueur : la requête au modèle reste celle d'avant (ni adversaire ni
  // côté) — le match ne sert ici qu'au règlement et à l'affichage.
  const teamGame = subject.type === "team" ? game : null;
  const teamIsHome = teamGame ? teamGame.isHome : undefined;
  const teamOpponentId = teamGame ? teamGame.opponentAbbr.toLowerCase() : undefined;

  // Build a unique and deterministic ID
  // Le match fait partie de l'identité d'un pari d'équipe : sans lui, la même
  // équipe sur le même marché pour DEUX affiches donnait le même id, donc
  // `hasLeg` refermait la feuille sans rien ajouter à la deuxième. Même règle
  // pour un joueur (« Suzuki marque » ce soir, puis demain).
  const legId = `${subject.id}_${market.type}_${selectionValue}_${lineValue ?? ""}`
    + (subject.type !== "game" && gameId ? `_${gameId}` : "");

  if (deps.hasLeg(legId)) return { ok: false, reason: "duplicate" };

  // 2026-10-02 (demande du user) : le chiffre ML d'abord — celui des tuiles
  // et de l'accueil (voir `mlLegProbability.ts`). Les règles ne servent qu'au
  // pari que le modèle ne sait pas chiffrer.
  const mlPct = await mlLegProbability({
    subjectType: subject.type,
    subjectId: subject.id,
    marketType: market.type,
    selection: selectionValue,
    line: lineValue,
    gameId: subject.type === "game" ? subject.id : gameId,
    homeAbbr: subject.type === "game" ? input.teams?.home : game?.homeAbbr,
    awayAbbr: subject.type === "game" ? input.teams?.away : game?.awayAbbr,
  });

  // La probabilité vient du service de prédiction. Sans elle, on n'ajoute
  // rien : une jambe porte sa probabilité jusqu'au règlement du coupon, donc
  // un chiffre inventé ici survivrait bien après la panne qui l'a produit.
  let response: { probability: number };
  if (mlPct != null) response = { probability: mlPct };
  else try {
    response = await predictionApiService.getSinglePrediction({
      marketType: market.type as BetMarketType,
      gameId:
        subject.type === "game"
          ? subject.id
          : subject.type === "team"
          ? gameId ?? undefined
          : undefined,
      teamId: subject.type === "team" ? subject.id : undefined,
      opponentId: teamOpponentId,
      isHome: teamIsHome,
      playerId: subject.type === "player" ? subject.id : undefined,
      line: lineValue,
      selection: selectionValue,
    });
  } catch (e) {
    if (!isPredictionUnavailable(e)) throw e;
    console.warn("[buildLeg] prédiction indisponible :", e.reason);
    return { ok: false, reason: "unavailable" };
  }

  const selectionLabel = buildSelectionLabel(market, subject, selectionValue, lineValue, deps.getTeamById);

  // Pari joueur : le coupon porte l'ÉQUIPE du joueur comme sujet, et ce qui
  // a été parié — nom du joueur compris — comme sélection (même règle que
  // PredictionSheet). « Over 2.5 Shots » seul ne dirait pas de qui il s'agit.
  const isPlayer = subject.type === "player";
  const playerTeamAbbr = isPlayer
    ? (deps.getTeamById(deps.players.find((p) => p.id === subject.id)?.teamId ?? "")?.abbr ?? "")
    : "";
  const withName = (txt: string) =>
    isPlayer && !txt.startsWith(subject.name) ? `${subject.name} · ${txt}` : txt;

  const leg = {
    id: legId,
    marketType: market.type as BetMarketType,
    marketLabel: market.label,
    subjectType: subject.type,
    subjectId: subject.id,
    subjectName: isPlayer ? playerTeamAbbr : subject.name,
    subjectLogo: subject.logo,
    selection: withName(selectionLabel.full),
    selectionShort: selectionLabel.short,
    probability: response.probability,
    line: lineValue,
    gameInfo: game
      ? `${matchupLabel(game)} · ${game.date}${game.startTime ? ` · ${game.startTime}` : ""}`
      : subject.subtitle,
    addedAt: new Date().toISOString(),
    // Machine-readable fields for automatic settlement
    gameId: subject.type === "game" ? subject.id : gameId ?? undefined,
    selectionValue: selectionValue != null ? String(selectionValue) : undefined,
  } as BetLeg;

  return { ok: true, leg };
}
