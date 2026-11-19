/**
 * accuracyRecord.ts — les chiffres PUBLIÉS de l'évaluation hors échantillon
 * d'arakiceML, repris tels quels de `public/nhl-prediction-accuracy.html`
 * (dateModified 2026-09-27) pour la page d'accueil des visiteurs (IntroLanding).
 *
 * ⚠️ Une seule source : si la page publique change, mettre ce fichier à jour
 * en même temps. Rien ici n'est calculé ni arrondi autrement que sur la page.
 */

export const ACCURACY_PAGE = "/nhl-prediction-accuracy";

export const accuracyRecord = {
  /** Matchs jamais vus à l'entraînement, du 2023-02-26 au 2026-04-16. */
  games: 4304,
  winnerPct: 59.5,
  /** Écart moyen entre probabilité annoncée et résultat (ECE 0,021), en points. */
  calibrationGapPts: 2.1,
  /** « Toujours choisir l'équipe à domicile » sur les mêmes matchs. */
  homeBaselinePct: 54.0,
  /**
   * Tableau de calibration de la page publique, sans les tranches 20–30 % (12
   * matchs) et 80–90 % (7 matchs) : la page elle-même dit qu'on n'en peut rien
   * conclure.
   */
  bins: [
    { range: "30–40", games: 285,  saidPct: 37.2, wonPct: 33.3 },
    { range: "40–50", games: 1250, saidPct: 45.5, wonPct: 44.7 },
    { range: "50–60", games: 1277, saidPct: 55.1, wonPct: 54.2 },
    { range: "60–70", games: 1140, saidPct: 64.6, wonPct: 61.6 },
    { range: "70–80", games: 333,  saidPct: 73.0, wonPct: 80.2 },
  ],
  /**
   * Comparaison au marché — `docs/ML.md` (« Against the market »), source
   * `ml/models/correction_report.json` : modèle corrigé contre la cote de
   * fermeture dé-margée, walk-forward, Δ log-loss −0,0008, z = −1,0 → à égalité
   * (pas significativement meilleur). Ajoutée à l'accueil le 2026-11-19 à la
   * demande du user (première sortie de la règle « précision et calibration
   * seulement » d'octobre 2026).
   */
  closingLineGames: 11297,
  /** Tranche mise en avant dans le titre (la plus fournie). */
  headlineBin: "50–60",
} as const;
