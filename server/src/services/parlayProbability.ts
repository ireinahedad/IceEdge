/**
 * parlayProbability.ts — probabilité d'un coupon, corrélations comprises.
 *
 * Extrait TEL QUEL de `POST /api/predict/parlay` (routes/ml.routes.ts) le
 * 2026-10-04, pour que la section « Best Parlay » de l'accueil affiche le MÊME
 * chiffre que le coupon quand on y ajoute ses jambes. Deux calculs différents
 * pour la même combinaison, c'est deux chiffres différents à l'écran.
 *
 * DEUX ÉTAGES, et c'est la structure qui compte.
 *
 *  1. `combineParlayLegs` règle ce qui est LOGIQUE — incompatibilité, doublon,
 *     implication — sans lire la moindre donnée, et pour tous les marchés.
 *  2. Ce qu'il en reste est groupé PAR MATCH. Les jambes lisibles sur le score
 *     final passent par la loi jointe (`predictGameLegCorrelation`) : leur
 *     corrélation n'est plus supposée, elle est calculée.
 *
 * Entre matchs différents, on multiplie — là, l'indépendance est vraie.
 * Les jambes qu'aucun des deux étages ne couvre (périodes, buteurs, props)
 * restent multipliées conditionnellement, et `assumesIndependence` le dit.
 *
 * JAMBE JOUEUR (2026-10-15, piste 2). « X marque » et « X a 1+ point » entrent
 * dans la loi jointe par la part de X dans les buts de son équipe
 * (`GamePlayerLeg`, voir `gameParlay.ts` pour la mesure qui l'a décidé). Une
 * seule par match : deux props joueur d'un même match restent au produit,
 * faute de corrélation mesurée entre elles.
 *
 * Module SERVEUR (il lit la loi des scores) : contrairement à `parlay.ts`, le
 * client ne l'importe pas.
 */

import { combineParlayLegs } from './parlay';
import type { ParlayLeg } from './parlay';
import { isScoreDerivable, predictGameLegCorrelation, type GamePlayerLeg } from './predictionEngine';
import { fetchGameById, fetchPlayerById } from './nhlApiClient';

/** Jambe telle que la route la reçoit : `teamId` = sujet, `opponentId` + `isHome` = le match. */
export type WireParlayLeg = ParlayLeg & { teamId?: string; opponentId?: string; isHome?: boolean };

export interface ParlayProbabilityResult {
  /** Produit naïf des jambes, 0–100, arrondi au dixième ; `null` = probabilité illisible. */
  combinedProbability: number | null;
  /** Corrélations comprises, 0–100 au dixième ; `null` = probabilité illisible. */
  adjustedProbability: number | null;
  impossible: boolean;
  redundantLegs: number;
  /** Nb de jambes dont la corrélation a réellement été calculée. */
  exactLegs: number;
  /** `true` = au moins un groupe est retombé sur l'indépendance. */
  assumesIndependence: boolean;
}

/**
 * Normalise ML-vocabulary aliases (sent by the stats page) into the canonical
 * { marketType, selection } used by the prediction engine. This is what keeps
 * the coupon and the stats page in sync: both funnel into the same markets.
 */
export function normalizeMarket(
  marketType: string,
  selection: string
): { market: string; selection: string } {
  switch (marketType) {
    case "total_goals_over":  return { market: "total_goals", selection: "over" };
    case "total_goals_under": return { market: "total_goals", selection: "under" };
    case "pp_goal":           return { market: "team_pp_goals", selection };
    case "penalty_kill":      return { market: "team_penalty_kill", selection };
    default:                  return { market: marketType, selection };
  }
}

/**
 * La jambe joueur que la loi jointe sait lire : « marque » (anytime_goal, ligne
 * 0,5) ou « 1+ point » (points_ou, plus de 0,5). Rien d'autre n'a été mesuré —
 * 2+ buts, passes, tirs restent au produit.
 */
function gridPlayerKind(l: WireParlayLeg): 'goal' | 'point' | null {
  if (l.subjectType !== 'player' || !l.teamId || !l.gameId) return null;
  const sel = (l.selection ?? '').trim().toLowerCase();
  const line = l.line ?? 0.5;
  if (l.marketType === 'anytime_goal' && line === 0.5 && (sel === '' || sel === 'yes')) return 'goal';
  if (l.marketType === 'points_ou' && line === 0.5 && (sel === '' || sel === 'over')) return 'point';
  return null;
}

/**
 * Le match (domicile, extérieur) et le camp du joueur. `null` si l'un des deux
 * est illisible ou si le joueur n'est pas dans ce match : la jambe reste alors
 * au produit, plutôt que d'être posée du mauvais côté de la grille.
 */
async function playerSide(gameId: string, playerId: string):
    Promise<{ home: string; away: string; isHome: boolean } | null> {
  const [game, player] = await Promise.all([
    fetchGameById(gameId).catch(() => null),
    fetchPlayerById(playerId).catch(() => null),
  ]);
  const home = String(game?.homeTeam?.abbreviation ?? '').toUpperCase();
  const away = String(game?.awayTeam?.abbreviation ?? '').toUpperCase();
  const team = String(player?.teamAbbr ?? '').toUpperCase();
  if (!home || !away || !team || (team !== home && team !== away)) return null;
  return { home, away, isHome: team === home };
}

export async function computeParlayProbability(legs: WireParlayLeg[]): Promise<ParlayProbabilityResult> {
  const naive = legs.reduce((acc, l) => acc * (l.probability / 100), 1) * 100;
  const combinedProbability = Math.round(naive * 10) / 10;

  // ── Étage 1 : relations logiques ─────────────────────────────────────────
  // `teamId` est le sujet de la jambe (le `subjectId` du coupon) : sans lui,
  // « MTL −1.5 » + « TOR +1.5 » (= « MTL −1.5, non ») ne se reconnaissaient
  // pas comme incompatibles. Voir `ParlayLeg.subject`.
  const logical = combineParlayLegs(legs.map((l) => ({ ...l, subject: l.teamId })));
  if (logical.impossible) {
    return {
      combinedProbability, adjustedProbability: 0, impossible: true,
      redundantLegs: logical.redundantLegs, exactLegs: 0, assumesIndependence: false,
    };
  }
  if (!Number.isFinite(logical.probability)) {
    return {
      combinedProbability: null, adjustedProbability: null, impossible: false,
      redundantLegs: logical.redundantLegs, exactLegs: 0, assumesIndependence: false,
    };
  }

  // ── Étage 2 : corrélation réelle, match par match ────────────────────────
  const byGame = new Map<string, WireParlayLeg[]>();
  logical.legs.forEach((l, i) => {
    // Une jambe sans match ne peut être corrélée à rien : groupe à elle seule.
    const key = l.gameId ? `g:${l.gameId}` : `solo:${i}`;
    const bucket = byGame.get(key);
    if (bucket) bucket.push(l); else byGame.set(key, [l]);
  });

  let joint = 1;
  let exactLegs = 0;
  let assumesIndependence = false;

  for (const group of byGame.values()) {
    const derivable = group.filter(l => isScoreDerivable(
      normalizeMarket(l.marketType, l.selection ?? "").market));
    // Une jambe joueur lisible sur la grille — seulement à côté d'au moins une
    // jambe de match : seule, elle n'a rien avec quoi être corrélée.
    const playerLeg = derivable.length > 0
      ? group.find(l => !derivable.includes(l) && gridPlayerKind(l) !== null) : undefined;
    const others = group.filter(l => !derivable.includes(l) && l !== playerLeg);

    // Marchés que le score final ne décide pas : produit conditionnel.
    for (const l of others) joint *= l.probability / 100;
    if (others.length > 0 && group.length > 1) assumesIndependence = true;

    if (derivable.length === 0) continue;
    if (derivable.length === 1 && !playerLeg) { joint *= derivable[0].probability / 100; continue; }

    // Le match est décrit par la première jambe qui porte ses deux équipes ;
    // à défaut, par le match de la jambe joueur.
    const anchor = derivable.find(l => l.teamId && l.opponentId);
    const anchorIsHome = anchor?.isHome !== false;
    let homeId = anchor ? (anchorIsHome ? anchor.teamId : anchor.opponentId) : undefined;
    let awayId = anchor ? (anchorIsHome ? anchor.opponentId : anchor.teamId) : undefined;

    // Jambe joueur : son camp dans CE match, et sa cadence tirée de la
    // probabilité AFFICHÉE (P(≥ 1) = 1 − e^−μ ⇒ μ = −ln(1 − p)) — la même
    // échelle que la tuile, quel que soit le mode (ML ou règles).
    let player: GamePlayerLeg | undefined;
    const side = playerLeg ? await playerSide(playerLeg.gameId!, playerLeg.teamId!) : null;
    if (playerLeg && side) {
      const p = Math.min(0.99, Math.max(0.001, playerLeg.probability / 100));
      player = { isHome: side.isHome, rate: -Math.log(1 - p) };
      if (!homeId || !awayId) { homeId = side.home; awayId = side.away; }
    }
    const playerKept = player !== undefined;
    if (playerLeg && !playerKept) {
      // Camp introuvable : la jambe joueur repasse au produit.
      joint *= playerLeg.probability / 100;
      assumesIndependence = true;
      if (derivable.length === 1) { joint *= derivable[0].probability / 100; continue; }
    }

    if (!homeId || !awayId) {
      // Sans les équipes, pas de loi jointe. On multiplie et on le DIT.
      for (const l of derivable) joint *= l.probability / 100;
      if (playerKept) joint *= playerLeg!.probability / 100;
      assumesIndependence = true;
      continue;
    }

    const corr = await predictGameLegCorrelation(homeId, awayId, derivable.map(l => {
      const { market, selection } = normalizeMarket(l.marketType, l.selection ?? "");
      return { market, selection, line: l.line, subjectIsHome: l.isHome !== false };
    }), player);

    // Le produit des probabilités AFFICHÉES reste la base : ce sont elles que
    // l'utilisateur voit sur les tuiles. La loi jointe ne fournit que le
    // facteur de corrélation, sans dimension — voir
    // `predictGameLegCorrelation` pour pourquoi on ne sert pas sa
    // probabilité brute.
    const inGrid = playerKept ? [...derivable, playerLeg!] : derivable;
    const shown = inGrid.reduce((acc, l) => acc * (l.probability / 100), 1);

    if (corr === null) {
      // Pas de cadences exploitables : on ne fabrique pas une corrélation.
      joint *= shown;
      assumesIndependence = true;
    } else {
      // Avec une jambe joueur : jamais au-dessus de la jambe la moins probable —
      // le facteur vient d'une autre échelle (la grille) que les chiffres
      // affichés, et un joueur à forte cadence pousse le facteur loin de 1.
      const cap = playerKept ? Math.min(...inGrid.map(l => l.probability / 100)) : Infinity;
      joint *= Math.min(shown * corr.factor, cap);
      exactLegs += inGrid.length;
    }
  }

  return {
    combinedProbability,
    adjustedProbability: Math.round(joint * 1000) / 10,
    impossible: false,
    redundantLegs: logical.redundantLegs,
    exactLegs,
    assumesIndependence,
  };
}
