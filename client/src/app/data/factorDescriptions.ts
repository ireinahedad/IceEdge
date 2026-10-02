/**
 * factorDescriptions.ts
 * Phrase courte affichée sous chaque facteur dans la section « Pondération »
 * d'une carte de règles : ce que le facteur prend en compte.
 *
 * Les facteurs viennent du serveur (`server/src/services/factorModel.ts` et
 * `predictionFactors.ts`) avec un `id` et un `factorGroup` (famille de pari).
 * Un même `id` peut désigner des calculs différents d'une famille à l'autre
 * (`model`, `balance`, `offense`…) : la clé `famille:id` est donc cherchée
 * d'abord, puis l'`id` seul. Garder ce fichier aligné avec le serveur quand un
 * facteur est ajouté ou modifié. Formulations neutres : elles restent vraies
 * pour le côté inverse d'un pari (moins de / équipe visiteuse / non).
 */
import type { Lang } from "../i18n";

type Desc = { fr: string; en: string };

const BY_ID: Record<string, Desc> = {
  // ── Résultat du match (famille « match ») ──
  quality: {
    fr: "% de victoires de la saison (70 %) et forme des 10 derniers matchs (30 %), comparés entre les deux équipes.",
    en: "Season win % (70%) and last-10 form (30%), compared between the two teams.",
  },
  homeIce: {
    fr: "Fiche à domicile de l'équipe locale vs fiche à l'extérieur du visiteur, autour de ~55 % pour le local.",
    en: "Home team's home record vs visitor's road record, around ~55% for the home side.",
  },
  fatigue: {
    fr: "Jours de repos, matchs consécutifs (back-to-back), distance, fuseaux horaires et altitude du déplacement.",
    en: "Rest days, back-to-backs, travel distance, time zones and altitude.",
  },
  odds: {
    fr: "Probabilité implicite de la cote du marché, marge du bookmaker retirée.",
    en: "Implied probability of the market odds, bookmaker margin removed.",
  },
  injuries: {
    fr: "Blessures saisies manuellement et leur impact estimé sur chaque équipe.",
    en: "Manually entered injuries and their estimated impact on each team.",
  },
  lineup: {
    fr: "Changements d'alignement ou joueurs manquants saisis manuellement.",
    en: "Manually entered lineup changes or missing players.",
  },

  // ── Totaux ──
  offense: {
    fr: "Buts marqués par match des deux équipes : plus elles marquent, plus il y a de buts attendus.",
    en: "Goals scored per game by both teams: the more they score, the more goals expected.",
  },
  defense: {
    fr: "Buts accordés par match des deux équipes : des défenses perméables font monter le total.",
    en: "Goals allowed per game by both teams: leaky defenses push the total up.",
  },
  shotPace: {
    fr: "Fenwick des deux équipes (tentatives de tir non bloquées, toutes situations — leur volume face à ce que l'adversaire concède), converti en buts au taux moyen de la ligue (~7 %). Repli sur les tirs au but si la donnée manque.",
    en: "Both teams' Fenwick (unblocked shot attempts, all situations — their volume against what the opponent allows), converted to goals at the league-average rate (~7%). Falls back to shots on goal if the data is missing.",
  },
  specialTeams: {
    fr: "Efficacité en avantage numérique des deux équipes, qui ajoute ou retire des buts attendus.",
    en: "Both teams' power-play efficiency, adding or removing expected goals.",
  },
  altitude: {
    fr: "Altitude de l'aréna : l'air raréfié (Denver, Salt Lake) favorise un peu plus de buts.",
    en: "Arena altitude: thinner air (Denver, Salt Lake) slightly favors more goals.",
  },
  referee: {
    fr: "Tendance des arbitres désignés à siffler : plus de pénalités → plus d'avantages numériques → plus de buts.",
    en: "Assigned referees' whistle tendency: more penalties → more power plays → more goals.",
  },

  // ── Période ──
  periodAD: {
    fr: "Buts attendus de chaque équipe ramenés à la période (attaque vs défense adverse).",
    en: "Each team's expected goals scaled to the period (attack vs opposing defense).",
  },
  drawModel: {
    fr: "Probabilité d'égalité calculée à partir des buts attendus de chaque équipe dans la période.",
    en: "Tie probability computed from each team's expected goals in the period.",
  },
  lowScoring: {
    fr: "Peu de buts attendus dans la période → plus de chances d'un 0-0 ou d'un 1-1.",
    en: "Few goals expected in the period → higher chance of 0-0 or 1-1.",
  },
  balance: {
    fr: "Équilibre des forces : plus les deux équipes sont proches, plus une égalité est probable.",
    en: "Balance of strength: the closer the two teams, the likelier a tie.",
  },

  // ── Marge ──
  forceGap: {
    fr: "Écart de qualité entre les équipes : un gros écart favorise une victoire large.",
    en: "Quality gap between teams: a big gap favors a wide win.",
  },
  expectedTotal: {
    fr: "Nombre total de buts attendus : un match à gros total laisse place à des marges plus larges.",
    en: "Total goals expected: a high-scoring game leaves room for wider margins.",
  },

  // ── Prolongation ──
  lowTotal: {
    fr: "Peu de buts attendus au total → plus de chances d'être à égalité après 60 minutes.",
    en: "Few total goals expected → higher chance of being tied after 60 minutes.",
  },

  // ── Extras équipe ──
  teamOffense: {
    fr: "Buts marqués par match par l'équipe cette saison.",
    en: "Goals scored per game by the team this season.",
  },
  oppDefense: {
    fr: "Buts accordés par match par l'adversaire.",
    en: "Goals allowed per game by the opponent.",
  },
  ppStrength: {
    fr: "Pourcentage de réussite de l'équipe en avantage numérique.",
    en: "Team's power-play success rate.",
  },
  oppAttack: {
    fr: "Buts marqués par match par l'adversaire : une attaque faible aide à ne rien concéder.",
    en: "Opponent's goals per game: a weak attack helps keep a clean sheet.",
  },
  teamDefense: {
    fr: "Buts accordés par match par l'équipe.",
    en: "Goals allowed per game by the team.",
  },
  pkStrength: {
    fr: "Pourcentage de pénalités tuées par l'équipe en infériorité numérique.",
    en: "Team's penalty-kill success rate.",
  },
  ppEfficiency: {
    fr: "Réussite de l'équipe en avantage numérique × ~3 occasions par match.",
    en: "Team's power-play success × ~3 opportunities per game.",
  },
  oppPkWeak: {
    fr: "Faiblesse du désavantage numérique adverse (pénalités mal tuées).",
    en: "Weakness of the opponent's penalty kill.",
  },
  oppPpWeak: {
    fr: "Inefficacité de l'avantage numérique adverse.",
    en: "Inefficiency of the opponent's power play.",
  },

  // ── Joueur ──
  scoringRate: {
    fr: "Buts par match du joueur cette saison.",
    en: "Player's goals per game this season.",
  },
  finishing: {
    fr: "% de tirs convertis en buts, comparé à la moyenne de la ligue (~10 %).",
    en: "Shooting %, compared with the league average (~10%).",
  },
  ppUsage: {
    fr: "Points marqués en avantage numérique par match : signe d'un rôle sur la 1re unité.",
    en: "Power-play points per game: a sign of first-unit usage.",
  },
  anytimeShare: {
    fr: "Chance de marquer dans le match, divisée par le nombre habituel de buteurs.",
    en: "Chance to score in the game, divided by the usual number of scorers.",
  },
  shotShare: {
    fr: "Part des tirs de l'équipe que prend ce joueur.",
    en: "Share of the team's shots taken by this player.",
  },
  assistRate: {
    fr: "Passes décisives par match du joueur cette saison.",
    en: "Player's assists per game this season.",
  },
  playmaking: {
    fr: "Part de ses points qui sont des passes : profil de passeur plutôt que de marqueur.",
    en: "Share of points that are assists: playmaker rather than finisher.",
  },
  offenseEnv: {
    fr: "Points par match du joueur : son implication globale en attaque.",
    en: "Player's points per game: overall offensive involvement.",
  },
  pointsRate: {
    fr: "Points (buts + passes) par match du joueur cette saison.",
    en: "Player's points (goals + assists) per game this season.",
  },
  shotRate: {
    fr: "Tirs au but par match du joueur cette saison.",
    en: "Player's shots on goal per game this season.",
  },
  shooterRole: {
    fr: "Volume de tirs comparé à un patineur moyen (~2,2 par match).",
    en: "Shot volume compared with an average skater (~2.2 per game).",
  },
  goalThreat: {
    fr: "Buts par match : un vrai marqueur tire plus souvent.",
    en: "Goals per game: real scorers shoot more often.",
  },
  hitRate: {
    fr: "Mises en échec par match du joueur (moyenne de sa position à défaut).",
    en: "Player's hits per game (position average if unknown).",
  },
  physicalRole: {
    fr: "Style de jeu physique ; les défenseurs frappent davantage.",
    en: "Physical playing style; defensemen hit more.",
  },
  blockRate: {
    fr: "Tirs bloqués par match du joueur (moyenne de sa position à défaut).",
    en: "Player's blocked shots per game (position average if unknown).",
  },
  defensiveRole: {
    fr: "Position : les défenseurs bloquent beaucoup plus de tirs que les attaquants.",
    en: "Position: defensemen block far more shots than forwards.",
  },
  ppRate: {
    fr: "Production du joueur en avantage numérique par match.",
    en: "Player's power-play production per game.",
  },
  pimRate: {
    fr: "Minutes de pénalité par match du joueur (moyenne de sa position à défaut).",
    en: "Player's penalty minutes per game (position average if unknown).",
  },
  physicality: {
    fr: "Mises en échec par match : un jeu robuste mène plus souvent au banc des pénalités.",
    en: "Hits per game: a rugged style leads to the box more often.",
  },

  // ── Gardien ──
  workload: {
    fr: "Tirs cadrés reçus par match : plus il y en a, plus il y a d'arrêts (et de buts possibles).",
    en: "Shots faced per game: more shots mean more saves (and more possible goals).",
  },
  efficiency: {
    fr: "% d'arrêts du gardien comparé à la moyenne de la ligue (~90 %).",
    en: "Goalie's save % compared with the league average (~90%).",
  },
  gameScript: {
    fr: "Tendance de l'équipe à subir beaucoup de tirs (plus ou moins de 30 par match).",
    en: "Team's tendency to give up many shots (above or below 30 per game).",
  },
  gaRate: {
    fr: "Moyenne de buts alloués par match du gardien.",
    en: "Goalie's goals-against average.",
  },
  teamStrength: {
    fr: "% de victoires du gardien cette saison, reflet de l'équipe devant lui.",
    en: "Goalie's win % this season, reflecting the team in front of him.",
  },
  goalieQuality: {
    fr: "% d'arrêts du gardien comparé à la moyenne de la ligue.",
    en: "Goalie's save % compared with the league average.",
  },
  gaControl: {
    fr: "Chance de limiter l'adversaire à 2 buts ou moins, d'après sa moyenne de buts alloués.",
    en: "Chance of holding the opponent to 2 goals or fewer, based on GAA.",
  },
  history: {
    fr: "Blanchissages par départ du gardien cette saison.",
    en: "Goalie's shutouts per start this season.",
  },
};

/** Surcharges quand un même id change de sens selon la famille. */
const BY_FAMILY: Record<string, Desc> = {
  "period:quality": {
    fr: "Écart de % de victoires entre les deux équipes cette saison.",
    en: "Win % gap between the two teams this season.",
  },
  "totals:fatigue": {
    fr: "Matchs consécutifs (back-to-back) : des jambes lourdes produisent un peu moins de buts.",
    en: "Back-to-backs: tired legs produce slightly fewer goals.",
  },
  "totals:model": {
    fr: "Chance que chaque équipe marque au moins un but, d'après ses buts attendus dans ce match.",
    en: "Chance each team scores at least once, from its expected goals in this game.",
  },
  "team_shutout:model": {
    fr: "Chance que l'adversaire ne marque aucun but, d'après ses buts attendus dans ce match.",
    en: "Chance the opponent scores zero, from its expected goals in this game.",
  },
  "goalie_shutout:model": {
    fr: "Chance de n'accorder aucun but, d'après la moyenne de buts alloués du gardien.",
    en: "Chance of allowing zero goals, from the goalie's goals-against average.",
  },
  "team_special:offense": {
    fr: "Buts marqués par match par l'équipe.",
    en: "Goals scored per game by the team.",
  },
  "ot:balance": {
    fr: "Équilibre des forces : plus les deux équipes sont proches, plus le match risque d'aller en prolongation.",
    en: "Balance of strength: the closer the two teams, the likelier overtime.",
  },
  "player_points:balance": {
    fr: "Joueur qui marque ET fait des passes : plusieurs façons d'obtenir un point.",
    en: "Player who both scores and assists: more ways to get a point.",
  },
  "team_totals:shotVolume": {
    fr: "Fenwick de l'équipe (tentatives de tir non bloquées, face à ce que l'adversaire concède) converti en buts au taux moyen de la ligue.",
    en: "Team's Fenwick (unblocked shot attempts, against what the opponent allows) converted to goals at the league-average rate.",
  },
  "player_goals:shotVolume": {
    fr: "Tirs au but par match du joueur : plus il tire, plus il a de chances de marquer.",
    en: "Player's shots per game: more shots, more chances to score.",
  },
  "player_points:shotVolume": {
    fr: "Tirs au but par match du joueur : signe d'implication en attaque.",
    en: "Player's shots per game: a sign of offensive involvement.",
  },
  "player_first_goal:ppUsage": {
    fr: "Utilisation en avantage numérique, où tombent beaucoup de premiers buts.",
    en: "Power-play usage, where many first goals are scored.",
  },
  "goalie_ga:workload": {
    fr: "Tirs cadrés reçus par match : plus de tirs subis, plus de buts possibles.",
    en: "Shots faced per game: more shots, more possible goals.",
  },
  "goalie_ga:efficiency": {
    fr: "% d'arrêts du gardien : sous la moyenne de la ligue, il accorde plus de buts.",
    en: "Goalie's save %: below league average, he allows more goals.",
  },
};

/** Phrase explicative d'un facteur, ou `undefined` s'il n'est pas documenté. */
export function factorDescription(family: string, id: string, lang: Lang): string | undefined {
  const d = BY_FAMILY[`${family}:${id}`] ?? BY_ID[id];
  return d ? d[lang] : undefined;
}
