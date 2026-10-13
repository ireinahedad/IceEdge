/**
 * serverText.ts — version anglaise des textes que le SERVEUR écrit en français.
 *
 * Deux choses arrivent du serveur déjà rédigées, et seulement en français :
 *
 *   · `ruleNote` — la formule sous la carte « Règles » de la fiche d'un pari
 *     (`server/src/services/nhlPredictions.ts`, plus `formatBreakdown` de
 *     `predictionFactors.ts` et les notes de blessures / d'état du match) ;
 *   · `factors[].label` — le nom de chaque facteur dans l'éditeur de
 *     pondération (`server/src/services/factorModel.ts`, `predictionFactors.ts`).
 *
 * Jusqu'au 2026-10-12, la version anglaise de l'app les affichait tels quels.
 * Ces textes sont des formules au gabarit fixe : on les traduit ici, côté
 * client, par tables de remplacement, plutôt que de faire descendre une langue
 * dans tous les constructeurs de marchés du serveur (que réutilisent aussi le
 * paquet ML, le widget et les meilleurs paris).
 *
 * ⚠️ Garder aligné avec le serveur : un gabarit modifié là-bas sans l'être ici
 * réapparaît en français dans l'app anglaise. Le texte français reste la
 * source ; en français, ces fonctions le rendent intact.
 */
import type { Lang } from "./index";

/* ─── Noms des facteurs ──────────────────────────────────────────────────── */
const FACTOR_EN: Record<string, string> = {
  // predictionFactors.ts (famille « match »)
  "Qualité": "Quality",
  "Domicile": "Home ice",
  "Épuisement": "Fatigue",
  "Cote marché": "Market odds",
  "Blessures": "Injuries",
  "Alignement": "Lineup",
  // factorModel.ts
  "Altitude": "Altitude",
  "Attaque adverse": "Opponent offense",
  "Attaque combinée": "Combined offense",
  "Attaque de l’équipe": "Team offense",
  "Attaque/défense période": "Period offense/defense",
  "Avantage domicile": "Home-ice advantage",
  "Buts adverses attendus": "Expected opponent goals",
  "Buts alloués / match": "Goals allowed / game",
  "Buts alloués attendus": "Expected goals allowed",
  "Buts attendus": "Expected goals",
  "Charge de tirs subie": "Shots faced",
  "Contrôle des buts": "Goal control",
  "Défense adverse": "Opponent defense",
  "Défense combinée": "Combined defense",
  "Défense de l’équipe": "Team defense",
  "Déploiement en PP": "PP deployment",
  "Efficacité (save %)": "Efficiency (save %)",
  "Efficacité du PP": "PP efficiency",
  "Faible rythme de buts": "Low scoring pace",
  "Faible total attendu": "Low expected total",
  "Finition (tir %)": "Finishing (shot %)",
  "Force de l’équipe": "Team strength",
  "Historique (SO/départ)": "History (SO/start)",
  "Infériorité numérique": "Penalty kill",
  "Jeu physique": "Physical play",
  "Menace de but (÷ buteurs)": "Scoring threat (÷ scorers)",
  "Menace de but": "Scoring threat",
  "Modèle Skellam (nul)": "Skellam model (tie)",
  "PK adverse": "Opponent PK",
  "PP adverse": "Opponent PP",
  "Part des tirs d’équipe": "Share of team shots",
  "Production en PP": "PP production",
  "Production offensive": "Offensive production",
  "Profil de passeur": "Playmaker profile",
  "Qualité du gardien": "Goalie quality",
  "Qualité d’équipe": "Team quality",
  "Rythme de tirs": "Shot pace",
  "Rôle de tireur": "Shooter role",
  "Rôle défensif": "Defensive role",
  "Rôle physique": "Physical role",
  "Style de match": "Game style",
  "Taux de blocs": "Block rate",
  "Taux de buts en PP": "PP goal rate",
  "Taux de buts": "Goal rate",
  "Taux de mises en échec": "Hit rate",
  "Taux de points en PP": "PP point rate",
  "Taux de points": "Point rate",
  "Taux de pénalités": "Penalty rate",
  "Taux de tirs": "Shot rate",
  "Taux d’assists": "Assist rate",
  "Total attendu": "Expected total",
  "Unités spéciales": "Special teams",
  "Volume de tirs": "Shot volume",
  "Écart de force": "Strength gap",
  "Équilibre buts/passes": "Goals/assists balance",
  "Équilibre des forces": "Balance of strength",
};

/** Nom d'un facteur dans la langue de l'app. Inconnu → tel quel. */
export function factorLabel(label: string, lang: Lang): string {
  if (lang === "fr" || !label) return label;
  // `volLabel` (factorModel.ts) ajoute « (Fenwick) » au nom de base.
  const m = /^(.*?)( \(Fenwick\))?$/.exec(label);
  const base = m?.[1] ?? label;
  const en = FACTOR_EN[base] ?? FACTOR_EN[base.replace(/'/g, "’")];
  return en ? en + (m?.[2] ?? "") : label;
}

/* ─── Notes de règles ────────────────────────────────────────────────────── */
// Ordre = du plus long au plus court : une phrase entière avant ses morceaux.
const NOTE_RULES: Array<[RegExp, string]> = [
  // Moneyline / Match Betting
  [/Égalité après 60 min \(score actuel \+ buts restants\)/g, "Tied after 60 min (current score + remaining goals)"],
  [/Victoire \(prolongation et fusillade comprises\)/g, "Win (incl. OT and shootout)"],
  [/Victoire en temps réglementaire/g, "Regulation win"],
  [/victoire en temps réglementaire/g, "regulation win"],
  [/P\(mène à 60 min\)/g, "P(leads at 60 min)"],
  [/P\(nul\)/g, "P(tie)"],
  [/part OT/g, "OT share"],
  [/Égalité à 60 min (\S+) \(score actuel \+ buts restants\), partagée (\S+) en prolongation/g,
    "Tied at 60 min $1 (current score + remaining goals), split $2 in overtime"],
  [/OT\/SO (\S+) du temps \(ligue ~22\.5%\), partagé (\S+) — la prolongation efface une partie de l'écart de talent/g,
    "OT/SO $1 of the time (league ~22.5%), split $2 — overtime erases part of the talent gap"],
  [/\bblessures : /g, "injuries: "],
  [/\balignement : /g, "lineup: "],
  [/avantage alignement maison/g, "home lineup edge"],
  [/avantage alignement visiteur/g, "away lineup edge"],
  [/\bmaison −/g, "home −"],
  [/\bvisiteur −/g, "away −"],
  [/non renseigné/g, "not entered"],
  // Puck line / marge
  [/P\(gagne par (\d+)\+ \| gagne\)/g, "P(wins by $1+ | wins)"],
  [/\(score final, prolongation comprise\)/g, "(final score, incl. OT)"],
  [/Couvre sauf défaite par (\d+)\+ :/g, "Covers unless losing by $1+:"],
  [/P\(par (\d\+?) \| victoire\)/g, "P(by $1 | win)"],
  [/toutes les victoires en prolongation finissent par 1 but/g, "every overtime win is by 1 goal"],
  [/P\(victoire\)/g, "P(win)"],
  // Totaux
  [/\(prolongation comprise\)/g, "(incl. OT)"],
  [/P\(total final ([<>])/g, "P(final total $1"],
  [/buts restants d'ici la fin de la/g, "remaining goals until the end of the"],
  [/buts restants : binomiale négative/g, "remaining goals: negative binomial"],
  [/buts par match : binomiale négative/g, "goals per game: negative binomial"],
  [/\+ buts restants/g, "+ remaining goals"],
  [/\+ restants/g, "+ remaining"],
  [/Score actuel/g, "Current score"],
  [/Buts attendus/g, "Expected goals"],
  [/Buts cumulés/g, "Cumulative goals"],
  [/, score final\)/g, ", final score)"],
  [/\(score final\)/g, "(final score)"],
  [/score final/g, "final score"],
  // Les deux équipes marquent
  [/finit ≥(\d+), a (\d+)\)/g, "ends ≥$1, has $2)"],
  [/Au moins une équipe sous/g, "At least one team under"],
  // Score exact
  [/gagne en marquant 5 buts ou plus/g, "wins scoring 5+ goals"],
  [/\| (\S+) gagne\)/g, "| $1 wins)"],
  [/P\((\S+) gagne\)/g, "P($1 wins)"],
  // Périodes
  [/Décidé :/g, "Decided:"],
  [/P\(égalité après (\S+) période\)/g, "P(tied after $1 period)"],
  [/(\S+) mène\)/g, "$1 leads)"],
  [/Mène après 60 min =/g, "Leads after 60 min ="],
  [/Égalité après 60 min = prolongation :/g, "Tied after 60 min = overtime:"],
  [/après la (1re|2e|3e) période/g, "after the $1 period"],
  [/entracte après la/g, "intermission after the"],
  [/ en (1re|2e|3e)\b/g, " in the $1"],
  [/(\d{1,2}:\d{2}) restantes/g, "$1 left"],
  // Spéciaux d'équipe
  [/P\(0 but adverse\)/g, "P(0 opponent goals)"],
  [/ occasions\b/g, " opportunities"],
  // En direct
  [/ ·  décidé \(/g, " ·  decided ("],
  [/ ·  en direct \(/g, " ·  live ("],
  [/\bfusillade\b/g, "shootout"],
  [/\bprolongation\b/g, "overtime"],
  // Décomposition des facteurs (`formatBreakdown`) : « Qualité 0.40×55% + … »
  [/(^|·  |\+ )(Qualité|Domicile|Épuisement|Cote marché|Blessures|Alignement) (?=\d)/g, "$1§$2§ "],
  // Mots isolés, en dernier
  [/(\d+) buts\b/g, "$1 goals"],
  [/(\d+) buts?\b/g, "$1 goal"],
  [/ buts\)/g, " goals)"],
  [/ buts en /g, " goals in "],
  [/\b1re\b/g, "1st"],
  [/\b2e\b/g, "2nd"],
  [/\b3e\b/g, "3rd"],
  [/ : /g, ": "],
];

/** Note de règles d'un pari dans la langue de l'app. */
export function ruleNote(text: string, lang: Lang): string {
  if (lang === "fr" || !text) return text;
  let out = text;
  for (const [re, rep] of NOTE_RULES) {
    out = out.replace(re, rep);
  }
  return out.replace(/§([^§]+)§/g, (_m, fr: string) => FACTOR_EN[fr] ?? fr);
}

/* ─── Explications du modèle ML ──────────────────────────────────────────────
 *
 * `explanation` (et `model_type`) de la carte ML de la fiche : écrits en
 * français par `ml/python/ml_service.py` (`_apply_score_model`,
 * `_apply_market`, corrections et côtés inverses) et, en direct, par
 * `server/src/services/gameMlBundle.ts`. Même principe que les notes de
 * règles — et même consigne : garder aligné avec ces gabarits.
 */
const ML_RULES: Array<[RegExp, string]> = [
  // Corrections / côté inverse (enveloppent l'explication de base)
  [/Corrigé \(forme, fatigue, alignement, ELO\) : /g, "Adjusted (form, fatigue, lineup, ELO): "],
  [/ ; tous les marchés du match suivent \(λ bruts /g, "; all of this game's markets follow (raw λ "],
  [/Côté « moins » = 100 − P\(plus\)\./g, "“Under” side = 100 − P(over)."],
  [/Côté « non » = 100 − P\(oui\)\./g, "“No” side = 100 − P(yes)."],
  // Direct (gameMlBundle.ts)
  [/Modèle ML \(avant-match : victoire domicile /g, "ML model (pre-game: home win "],
  [/\+ état du match \(/g, "+ game state ("],
  [/ — score actuel \+ buts restants\./g, " — current score + remaining goals."],
  // Modèle de score
  [/P\(sujet ([+−-]?[\d.]+) couvre\)/g, "P(subject $1 covers)"],
  [/ sur le score final \(λ=/g, " on the final score (λ="],
  [/Matrice jointe/g, "Joint matrix"],
  [/les deux marquent (\d+)\+ :/g, "both score $1+:"],
  [/les deux marquent :/g, "both score:"],
  [/Blanchissage d'un côté ou de l'autre :/g, "Shutout on either side:"],
  [/Score hors de la grille du modèle\./g, "Score outside the model's grid."],
  [/Score final (\d+-\d+) :/g, "Final score $1:"],
  [/, prolongation comprise\)/g, ", incl. OT)"],
  [/Victoire avec 5 buts ou plus :/g, "Win with 5+ goals:"],
  [/Après la période (\d) \(égalité\) :/g, "After period $1 (tied):"],
  [/Après la période (\d) \(le sujet mène\) :/g, "After period $1 (subject leads):"],
  [/ — buts cumulés, λ du modèle de score /g, " — cumulative goals, score-model λ "],
  [/Modèle de score \(Poisson empilé\)/g, "Score model (stacked Poisson)"],
  [/Modèle de score λ=/g, "Score model λ="],
  [/→ domicile (\d+)% \(prolongation incluse\)/g, "→ home $1% (incl. OT)"],
  [/P\(domicile gagne par ≥(\d)\)/g, "P(home wins by ≥$1)"],
  [/un match en prolongation se finit toujours à 1 but d'écart/g, "a game decided in overtime always ends with a 1-goal margin"],
  [/Distribution de score/g, "Score distribution"],
  [/total espéré/g, "expected total"],
  [/Buts du domicile \(λ=([\d.]+), but de prolongation inclus\)/g, "Home goals (λ=$1, incl. OT goal)"],
  [/Victoire du domicile en 60 minutes :/g, "Home win in 60 minutes:"],
  [/P\(nul réglementaire\)/g, "P(regulation tie)"],
  [/P\(nul après 60 minutes\)/g, "P(tie after 60 minutes)"],
  [/P\(nul après 60 min\)/g, "P(tie after 60 min)"],
  [/P\(le sujet gagne la prolongation\)/g, "P(subject wins OT)"],
  [/modèle ajusté sur l'écart de cadence, pas une pente posée à la main/g, "model fitted on the scoring-rate gap, not a hand-set slope"],
  [/modèle ajusté sur l'écart de cadence/g, "model fitted on the scoring-rate gap"],
  [/Le 3 contre 3 puis les tirs de barrage sont proches du pile ou face\./g, "3-on-3 and then the shootout are close to a coin flip."],
  [/P\(l'adversaire ne marque pas\)/g, "P(opponent doesn't score)"],
  [/score final lu sur la matrice jointe \(un 0-0 perdu en prolongation n'est pas un blanchissage\)/g,
    "final score read from the joint matrix (a 0-0 lost in overtime isn't a shutout)"],
  [/P\(win (\d)\)/g, "P(win by $1)"],
  [/P\(lose (\d)\)/g, "P(lose by $1)"],
  [/P\(win 3plus\)/g, "P(win by 3+)"],
  [/P\(lose 3plus\)/g, "P(lose by 3+)"],
  [/tout match nul après 60 minutes se finit à 1 but d'écart/g, "every game tied after 60 minutes ends with a 1-goal margin"],
  [/P\((P\d) est la période la plus prolifique\)/g, "P($1 is the highest-scoring period)"],
  [/P\((P\d) la plus prolifique\)/g, "P($1 highest-scoring)"],
  [/buts réglementaires λ=([\d.]+) répartis/g, "regulation goals λ=$1 split"],
  [/ — buts λ=/g, " — goals λ="],
  [/répartis selon les parts mesurées par période/g, "split by the measured per-period shares"],
  [/Buts de la période (\d) :/g, "Period $1 goals:"],
  [/ des buts réglementaires du modèle de score\)/g, " of the score model's regulation goals)"],
  // Heuristiques (`_apply_market`)
  [/: équipe domicile à (\d+)%\./g, ": home team at $1%."],
  [/→ gagne par ≥2 buts:/g, "→ wins by ≥2 goals:"],
  [/Ligne alternative ±2\.5 buts/g, "Alternate line ±2.5 goals"],
  [/buts\/match domicile/g, "home goals/game"],
  [/Victoire en 60 min: (\d+)% \(home (\d+)% × 0\.85 car ~15% finissent en OT\/SO\)/g,
    "Win in 60 min: $1% (home $2% × 0.85 since ~15% go to OT/SO)"],
  [/Écart win% =/g, "Win% gap ="],
  [/Moyenne NHL:/g, "NHL average:"],
  [/λdom=/g, "λhome="],
  [/λext=/g, "λaway="],
  [/% que les deux marquent\./g, "% that both teams score."],
  [/Taux de marquage: dom ([\d.]+) vs ext ([\d.]+) → (\d+)% premier but domicile\./g,
    "Scoring rate: home $1 vs away $2 → $3% home scores first."],
  [/L'équipe qui mène tend à marquer en dernier/g, "The leading team tends to score last"],
  [/\(signal atténué depuis moneyline\)/g, "(signal damped from the moneyline)"],
  [/\(plus corrélé avec résultat final\)/g, "(more correlated with the final result)"],
  [/ des buts\)/g, " of goals)"],
  [/Double chance \(gagne reg \+ OT\)/g, "Double chance (wins in reg + OT)"],
  [/ sur ~(\d+) occasions → /g, " over ~$1 opportunities → "],
  [/% de marquer en avantage numérique\./g, "% to score on the power play."],
  [/ occasions = /g, " opportunities = "],
  [/% de tout tuer\./g, "% to kill them all."],
  [/P\(ext marque 0 \|/g, "P(away scores 0 |"],
  [/P\(marquer en /g, "P(score in "],
  [/XGBoost ⊕ marché/g, "XGBoost ⊕ market"],
  [/ buts → /g, " goals → "],
  [/ : /g, ": "],
];

/** Explication (ou type de modèle) de la carte ML dans la langue de l'app. */
export function mlExplanation(text: string, lang: Lang): string {
  if (lang === "fr" || !text) return text;
  let out = text;
  for (const [re, rep] of ML_RULES) out = out.replace(re, rep);
  // L'étiquette d'état du match (direct) suit les règles des notes.
  return ruleNote(out, lang);
}
