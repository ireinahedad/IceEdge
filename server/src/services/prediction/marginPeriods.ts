/**
 * prediction/marginPeriods.ts — écart de victoire, prolongation, marchés par
 * période et futures. Point d'entrée public : `../predictionEngine.ts`.
 */

import { fetchTeams } from '../nhlApiClient';
import {
  LEAGUE_AVG_GPG,
  LEAGUE_OT_RATE,
  MAX_GOALS,
  expectedGoals,
  getTeam,
  goalsPmf,
  pWinsOvertime,
  pct,
  poissonOver,
  poissonUnder,
  scoreDistribution,
} from './scoreModel';
import { predictMoneyline } from './markets';

// ── Écart de victoire ─────────────────────────────────────────────────────────

/**
 * Seaux d'écart proposés par l'UI, du point de vue du SUJET.
 *   `win_1`     — le sujet gagne par exactement 1 but
 *   `win_2`     — par exactement 2
 *   `win_3plus` — par 3 ou plus
 *   `lose_*`    — les mêmes trois, côté adverse
 */
export type MarginBucket = 'win_1' | 'win_2' | 'win_3plus' | 'lose_1' | 'lose_2' | 'lose_3plus';

/**
 * Ce que l'UI peut DEMANDER : les six seaux disjoints, plus les deux seaux
 * ouverts « par 2 ou plus » que `betMarkets.ts` propose et qui sont la somme de
 * deux d'entre eux.
 */
export type MarginSelection = MarginBucket | 'win_2plus' | 'lose_2plus';

/**
 * Parse le `selection` d'un marché d'écart. L'UI a deux vocabulaires :
 *   - les tuiles de `gameMarkets.tsx` envoient l'écart seul ("1", "2", "3+"),
 *     le CÔTÉ étant porté par le sujet de la requête (`gml` = domicile,
 *     `gmla` = extérieur) ;
 *   - `betMarkets.ts` envoie un couple explicite ("home_1", "away_2plus").
 * Les deux doivent tomber sur le même seau, sinon le coupon et la page de
 * prédiction affichent deux chiffres pour le même pari.
 */
export function parseMarginBucket(
  selection: string | undefined,
  isHome: boolean
): MarginSelection | null {
  const s = (selection ?? '').trim().toLowerCase().replace(/[\s-]/g, '_');
  if (!s) return null;

  // Côté explicite : "home_1", "away_2plus", "away_3+"…
  const sided = /^(home|away)_(.+)$/.exec(s);
  let sizeToken = s;
  let subjectWins = true;
  if (sided) {
    const sideIsHome = sided[1] === 'home';
    // Le seau est nommé du point de vue du terrain, la réponse du point de vue
    // du sujet : ils coïncident seulement si le sujet est de ce côté-là.
    subjectWins = sideIsHome === isHome;
    sizeToken   = sided[2];
  }

  const size =
    /^(1|by_1|exactly_1)$/.test(sizeToken)                 ? 1 :
    /^(2|by_2|exactly_2)$/.test(sizeToken)                 ? 2 :
    /^(3|3\+|3plus|by_3|by_3\+|3_plus|2plus|2\+)$/.test(sizeToken) ? 3 : null;
  if (size === null) return null;

  // "2plus" de `betMarkets.ts` veut dire « 2 buts ou plus », pas « 3 ou plus » :
  // on le traite comme le seau ouvert, mais à partir de 2.
  if (/^(2plus|2\+)$/.test(sizeToken)) return subjectWins ? 'win_2plus' : 'lose_2plus';

  const name = size === 3 ? '3plus' : String(size);
  return (subjectWins ? `win_${name}` : `lose_${name}`) as MarginSelection;
}

/**
 * Probabilité de chaque seau d'écart, du point de vue du sujet.
 *
 * Deux choses que la constante `12` ne pouvait pas faire :
 *
 *  1. **Les six seaux sont calculés ensemble et somment à 1.** Six tuiles à 12 %
 *     totalisaient 72 % pour une partition EXHAUSTIVE des issues — il n'existe
 *     pas de match sans vainqueur en NHL, donc ces six cases couvrent tout.
 *  2. **La prolongation est traitée.** Un match nul après 60 minutes se termine
 *     toujours 1–0 en prolongation ou aux tirs de barrage : toute la masse de
 *     l'écart 0 bascule sur « par 1 », répartie par `pWinsOvertime`. C'est ce
 *     qui fait de « par 1 » l'écart le plus fréquent du hockey, et aucun modèle
 *     qui l'ignore ne peut retrouver la forme réelle de la distribution.
 */
export async function predictMarginDistribution(
  teamId?: string,
  opponentId?: string,
  isHome = true
): Promise<Record<MarginBucket, number> | null> {
  const d = await scoreDistribution(teamId, opponentId, isHome);
  if (!d) return null;

  const acc: Record<MarginBucket, number> = {
    win_1: 0, win_2: 0, win_3plus: 0, lose_1: 0, lose_2: 0, lose_3plus: 0,
  };

  // La matrice porte déjà l'inclinaison des écarts ET la calibration des nuls :
  // il ne reste qu'à ranger ses cellules dans les seaux.
  for (let s = 0; s <= MAX_GOALS; s++) {
    for (let o = 0; o <= MAX_GOALS; o++) {
      const p = d.M[s][o];
      if (p <= 0) continue;
      const diff = s - o;
      if (diff === 0) continue;          // traité juste après, via la prolongation
      const size = Math.abs(diff);
      const side = diff > 0 ? 'win' : 'lose';
      const key  = (size === 1 ? `${side}_1` : size === 2 ? `${side}_2` : `${side}_3plus`) as MarginBucket;
      acc[key] += p;
    }
  }

  // 60 minutes nulles → un seul but d'écart, pour l'un ou pour l'autre.
  const pOT = pWinsOvertime(d, isHome);
  acc.win_1  += d.tie * pOT;
  acc.lose_1 += d.tie * (1 - pOT);

  return acc;
}

/**
 * Écart de victoire pour UN seau. Retourne le taux de ligue du seau quand les
 * cadences manquent (intersaison, présaison) plutôt qu'un chiffre dérivé de
 * valeurs par défaut, et `null` quand le seau demandé n'a pas pu être lu — le
 * routeur doit alors dire qu'il ne sait pas, pas servir une constante.
 */
export async function predictWinningMargin(
  teamId?: string,
  opponentId?: string,
  isHome = true,
  selection?: string
): Promise<number | null> {
  const bucket = parseMarginBucket(selection, isHome);
  if (!bucket) return null;

  const dist = await predictMarginDistribution(teamId, opponentId, isHome);
  if (!dist) return null;

  // Seaux ouverts « par 2 ou plus » de `betMarkets.ts`.
  if (bucket === 'win_2plus')  return pct(dist.win_2  + dist.win_3plus);
  if (bucket === 'lose_2plus') return pct(dist.lose_2 + dist.lose_3plus);

  return pct(dist[bucket]);
}

// ── Prolongation ──────────────────────────────────────────────────────────────

/**
 * P(le match va en prolongation) = P(égalité après 60 minutes).
 *
 * Remplace la constante 24 du routeur, qui donnait le même chiffre à un duel de
 * deux défenses verrouillées (où l'égalité est fréquente) et à une affiche
 * ouverte entre la meilleure attaque et la pire défense de la ligue.
 *
 * La diagonale de la loi jointe, recalibrée par TIE_INFLATION : deux équipes de
 * cadence proche et basse se retrouvent à égalité bien plus souvent que le
 * contraire.
 *
 * Sans cadence exploitable (intersaison, présaison, équipe inconnue), sert le
 * taux de ligue — même aveu d'ignorance qu'ailleurs dans ce fichier, mais avec
 * la bonne valeur.
 */
export async function predictGameToOvertime(
  teamId?: string,
  opponentId?: string,
  isHome = true
): Promise<number> {
  const d = await scoreDistribution(teamId, opponentId, isHome);
  if (!d) return pct(LEAGUE_OT_RATE);
  return pct(d.tie);
}

// ── Période la plus prolifique ────────────────────────────────────────────────

/** Périodes proposées par le marché, plus l'égalité que les books cotent aussi. */
export type PeriodSelection = 'P1' | 'P2' | 'P3' | 'tie';

function parsePeriodSelection(selection: string | undefined): PeriodSelection | null {
  const s = (selection ?? '').trim().toLowerCase();
  if (/^(p1|1|1st|period1|first)$/.test(s))  return 'P1';
  if (/^(p2|2|2nd|period2|second)$/.test(s)) return 'P2';
  if (/^(p3|3|3rd|period3|third)$/.test(s))  return 'P3';
  if (/^(tie|tied|draw|equal)$/.test(s))     return 'tie';
  return null;
}

/**
 * P(la période demandée est la plus prolifique du match).
 *
 * Remplace la constante 38, qui avait deux défauts distincts : elle ignorait
 * l'affiche, et les trois périodes totalisaient 114 % pour trois issues qui
 * s'excluent.
 *
 * Le modèle répartit la cadence du match en trois tiers ÉGAUX et compare les
 * trois tirages. C'est délibérément conservateur : la NHL marque un peu plus au
 * 3e (fatigue, filets déserts, jeu ouvert par le score), mais l'application n'a
 * aucune donnée par période, et inventer un coefficient d'asymétrie
 * reproduirait exactement le problème qu'on corrige. Le modèle dit donc ce
 * qu'il sait — l'égalité y est fréquente, et c'est vrai — et ce biais est à
 * lever le jour où les statistiques par période sont branchées.
 *
 * Retourne `null` pour une sélection illisible : le routeur doit dire qu'il ne
 * sait pas, pas servir une constante.
 */
export async function predictHighestScoringPeriod(
  teamId?: string,
  opponentId?: string,
  selection?: string,
  isHome = true
): Promise<number | null> {
  const want = parsePeriodSelection(selection);
  if (!want) return null;

  const d = await scoreDistribution(teamId, opponentId, isHome);
  const combined = d
    ? d.lambdaSubject + d.lambdaOpponent
    : LEAGUE_AVG_GPG * 2;

  // Buts d'UNE période : un tiers de la cadence du match. La dispersion reste
  // celle du fichier, pour que ce marché et les totaux par période partagent la
  // même loi.
  const pmf = goalsPmf(combined / 3);

  // Les trois périodes sont i.i.d. sous ce modèle : P(Pk strictement max) est la
  // même pour les trois, et le reste est la masse d'égalité au sommet. On somme
  // explicitement plutôt que de poser (1 − tie)/3, pour que le calcul reste
  // juste si les cadences par période deviennent un jour distinctes.
  let strictMax = 0;
  for (let n = 0; n <= MAX_GOALS; n++) {
    let below = 0;
    for (let m = 0; m < n; m++) below += pmf[m];
    strictMax += pmf[n] * below * below;   // les DEUX autres périodes sous n
  }

  if (want === 'tie') return pct(1 - 3 * strictMax);
  return pct(strictMax);
}

/** Period winner: dampened moneyline (single period is noisier than full game). */
export async function predictPeriodWinner(
  teamId: string,
  opponentId?: string,
  isHome = true
): Promise<number> {
  const ml = await predictMoneyline(teamId, opponentId, isHome);
  return Math.max(20, Math.round(50 + (ml - 50) * 0.55));
}

/**
 * Part des buts d'un match inscrite dans chaque période.
 *
 * Les trois périodes ne se valent PAS : la première est la plus prudente, la
 * deuxième la plus ouverte (changements longs, l'équipe en défense est coincée
 * dans sa zone). `nhlPredictions.ts` connaît déjà cette répartition et la
 * nomme `PERIOD_DIST` — mêmes valeurs ici, volontairement, pour que les deux
 * moteurs ne donnent pas deux totaux différents pour la même période.
 *
 * Diviser par 3 rendait P1, P2 et P3 STRICTEMENT identiques : trois tuiles, un
 * seul chiffre, et le 2e sous-évalué de 10 % relatifs.
 */
const PERIOD_SHARE = [0.305, 0.365, 0.330] as const;

/**
 * O/U des buts d'UNE période.
 *
 * `period` est l'indice 1-3. L'appelant DOIT le fournir : sans lui il n'y a pas
 * de question posée, seulement trois tuiles qui se ressemblent.
 */
export async function predictPeriodTotalGoals(
  line: number,
  selection: string,
  teamId?: string,
  opponentId?: string,
  period: 1 | 2 | 3 = 1
): Promise<number> {
  const [team, opp] = await Promise.all([
    teamId     ? getTeam(teamId)     : null,
    opponentId ? getTeam(opponentId) : null,
  ]);
  // Même cadence que le total du match — défense adverse comprise.
  const combined = (expectedGoals(team, opp) ?? LEAGUE_AVG_GPG)
                 + (expectedGoals(opp, team) ?? LEAGUE_AVG_GPG);
  const lambda   = combined * PERIOD_SHARE[period - 1];
  return pct(
    selection === 'under'
      ? poissonUnder(lambda, line)
      : poissonOver(lambda, line)
  );
}

// ── Futures ───────────────────────────────────────────────────────────────────

/**
 * Futures probability derived from conference standings rank.
 * propType: 'cup' | 'conf' | 'playoff'
 */
export async function predictFutures(
  teamId: string,
  propType: string
): Promise<number> {
  const teams = await fetchTeams();
  const team  = teams.find(
    (t: any) =>
      t.id?.toLowerCase() === teamId.toLowerCase() ||
      t.abbreviation?.toLowerCase() === teamId.toLowerCase()
  );
  if (!team) return 20;

  const conf = teams
    .filter((t: any) => t.conference === team.conference)
    .sort((a: any, b: any) => b.points - a.points);

  const rank = conf.findIndex((t: any) => t.id === team.id) + 1;

  if (propType === 'cup') {
    // Historical Cup win rates by regular-season rank (rough priors)
    if (rank === 1) return 28;
    if (rank <= 3)  return 18;
    if (rank <= 8)  return 10;
    return 4;
  }

  if (propType === 'conf') {
    if (rank <= 2)  return 35;
    if (rank <= 4)  return 22;
    if (rank <= 8)  return 12;
    return 5;
  }

  // playoff berth
  if (rank <= 3)  return 92;
  if (rank <= 8)  return 72;
  if (rank <= 11) return 38;
  return 12;
}
