// ============================================================
//  Gardiens partants — override manuel
// ============================================================
// Le gardien partant confirmé n'est pas exposé de façon fiable/stable par une
// API gratuite avant le match (Daily Faceoff = Cloudflare + build-id volatil).
// On garde donc une petite table éditable à la main. Elle sert À DEUX CHOSES :
//   • le modèle — le partant saisi remplace le gardien HABITUEL (plus grande
//     part des 10 derniers départs, inference_state.json), pris sans entrée ;
//   • c'est donc une table d'EXCEPTIONS depuis le 2026-10-20 : on ne saisit que
//     quand le n° 2 part. Les value bets n'exigent plus de saisie
//     (`valueBets.service.ts`, critère 2).
// (Corrigé le 2026-10-03, ml/INCOHERENCES_ML.md §19 : l'en-tête disait
// « elle ne sert qu'aux EXCEPTIONS ».)
//
// ── Source : la base, plus `ml/data/starting_goalies.json` ──────────────────
// Le chemin `cwd/../ml/data` n'existe pas dans le conteneur (le Dockerfile ne
// copie que `dist/`), donc cette table était vide en production, en silence.
// Voir `db/migrations/034_manual_data.sql`.
//
// La saisie passe maintenant par `PUT /api/manual/lineups/:date` et la carte
// admin (Profil → Paramètres), ce qui la rend faisable depuis un téléphone
// 1-2 h avant la mise au jeu — ce que l'édition d'un fichier local ne permettait
// pas.
//
// Stockage : kind `starting_goalies`, une ligne par DATE (heure de l'Est) :
//   entry_key '2026-01-15'  →  { "TOR": "Joseph Woll", "MTL": "Cayden Primeau" }
//
// Le NOM est apparié par le service Python à l'orthographe MoneyPuck (ex.
// « Joseph Woll ») sans tenir compte de la casse, des accents, des points ni
// des espaces en trop (`_name_key`). Un nom qu'il ne reconnaît pas est traité
// comme un gardien de RELÈVE, et signalé dans ses logs (« introuvable »).

import { getEntry } from './manualData.service';

/** Une journée de gardiens partants : { ABBR: "Nom complet MoneyPuck" }. */
export type GoalieDay = Record<string, string>;

/** Date locale Est (YYYY-MM-DD) — cohérent avec le calendrier NHL. */
export function easternToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * La journée entière, en un seul accès.
 *
 * C'est la forme que les appelants doivent préférer : `buildGameFeatures` a
 * besoin des deux équipes d'un match, et une lecture par équipe ferait deux
 * fois le travail pour la même ligne. Le cache de 30 s de `manualData.service`
 * rendrait la seconde gratuite, mais autant ne pas la demander.
 */
export async function getStartingGoalies(dateISO?: string): Promise<GoalieDay> {
  const day = await getEntry<GoalieDay>('starting_goalies', dateISO ?? easternToday());
  return day && typeof day === 'object' ? day : {};
}
