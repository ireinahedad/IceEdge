/**
 * slipCommandLegs.ts — d'une intention (`slipCommand.ts`) à une jambe du coupon.
 *
 * L'analyseur rend des intentions (`qui`, `quel marché`, `quelle sélection`,
 * `quelle ligne`, `quel match`) ; ce module les traduit dans les entrées de
 * `buildLeg` — le MÊME chemin que la feuille « + Ajouter » : mêmes sujets
 * (`teamSubject`, `playerSubject`, `gameSubject`), même définition de marché,
 * même affiche. La probabilité vient donc du modèle, jamais d'ici.
 *
 * Décision du user (2026-09-28) : dans une phrase à plusieurs paris, on ajoute
 * ce qui marche et on signale le reste (doublon, probabilité indisponible).
 */

import {
  SLIP_COMMAND_MARKETS,
  type SlipContext, type SlipIntent,
} from "../../../../server/src/services/slipCommand";
import { MARKET_DEFINITIONS, type MarketDefinition } from "../data/betMarkets";
import { toUIGame, type UIPlayer, type UITeam } from "../hooks/useNHLData";
import { toUpcoming } from "../pages/prediction/predictionShared";
import { buildLeg, teamSubject, playerSubject, gameSubject, type BuildLegInput } from "./buildLeg";
import type { BetLeg, NHLGame } from "../types/bet";

/** Les lignes autorisées par marché plus/moins, tirées de `MARKET_DEFINITIONS`. */
export function slipCommandLines(): SlipContext["lines"] {
  const lines: SlipContext["lines"] = {};
  for (const type of SLIP_COMMAND_MARKETS) {
    const def = MARKET_DEFINITIONS.find((m) => m.type === type);
    if (def?.lineOptions) lines[type] = def.lineOptions;
  }
  return lines;
}

export interface SlipCommandData {
  /** Matchs de la fenêtre (`fetchUpcomingWindow`), tels que l'API les rend. */
  games: readonly NHLGame[];
  players: readonly UIPlayer[];
  getTeamById: (id: string) => UITeam | undefined;
}

/** Entrées de `buildLeg` pour une intention ; `null` si une donnée manque. */
export function intentToLegInput(intent: SlipIntent, data: SlipCommandData): BuildLegInput | null {
  const market: MarketDefinition | undefined = MARKET_DEFINITIONS.find((m) => m.type === intent.marketType);
  const raw = data.games.find((g) => String(g.id) === intent.gameId);
  if (!market || !raw) return null;
  const common = { market, selection: intent.selection, line: intent.line ?? null };

  if (intent.subjectType === "team") {
    const team = data.getTeamById(intent.subjectId);
    if (!team) return null;
    return { ...common, subject: teamSubject(team), game: toUpcoming(raw, team.abbr) };
  }
  if (intent.subjectType === "player") {
    const player = data.players.find((p) => p.id === intent.subjectId);
    if (!player) return null;
    return { ...common, subject: playerSubject(player, data.getTeamById(player.teamId)), game: toUpcoming(raw, player.teamId) };
  }
  const g = toUIGame(raw);
  return { ...common, subject: gameSubject(g, data.getTeamById(g.team1Id), data.getTeamById(g.team2Id)), game: null };
}

/** Libellé court d'une intention non ajoutée (« Nick Suzuki · Shots O/U over 2.5 »). */
export function describeInput(input: BuildLegInput): string {
  const sel = input.selection === "over" || input.selection === "under" ? ` ${input.selection}` : "";
  const line = input.line != null ? ` ${input.line}` : "";
  return `${input.subject.name} · ${input.market.shortLabel}${sel}${line}`;
}

export type CommandLegResult =
  | { status: "added"; leg: BetLeg }
  | { status: "duplicate" | "unavailable" | "missing"; label: string };

/**
 * Construit et ajoute chaque jambe, dans l'ordre de la phrase. Ce qui passe
 * est ajouté ; le reste revient avec sa raison.
 */
export async function addIntents(
  intents: readonly SlipIntent[],
  data: SlipCommandData,
  slip: { hasLeg: (id: string) => boolean; addLeg: (leg: BetLeg) => void },
): Promise<CommandLegResult[]> {
  const out: CommandLegResult[] = [];
  for (const intent of intents) {
    const input = intentToLegInput(intent, data);
    if (!input) { out.push({ status: "missing", label: intent.subjectId }); continue; }
    const r = await buildLeg(input, { players: data.players, getTeamById: data.getTeamById, hasLeg: slip.hasLeg });
    if (r.ok) {
      slip.addLeg(r.leg);
      out.push({ status: "added", leg: r.leg });
    } else {
      out.push({ status: r.reason, label: describeInput(input) });
    }
  }
  return out;
}
