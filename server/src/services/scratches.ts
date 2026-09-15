// ============================================================
//  Absents confirmés du soir — override manuel (blessés / scratches)
// ============================================================
// Même logique que startingGoalies.ts : la compo confirmée n'est pas exposée de
// façon fiable/stable par une API gratuite avant le match (Daily Faceoff =
// Cloudflare + build-id volatil + ToS). On garde donc une petite table éditable
// à la main avec les absents du soir. Sans entrée → aucun absent (le modèle
// suppose l'alignement complet, comportement par défaut).
//
// ── Source : la base, plus `ml/data/scratches.json` ────────────────────────
// Le chemin `cwd/../ml/data` n'existe pas dans le conteneur, donc cette table
// était vide en production, en silence. Voir
// `db/migrations/034_manual_data.sql`.
//
// Stockage : kind `scratches`, une ligne par DATE (heure de l'Est) :
//   entry_key '2026-01-15'  →  { "TOR": ["Auston Matthews"], "MTL": ["Kaiden Guhle"] }
//
// Le NOM doit correspondre à l'orthographe MoneyPuck (ex. « Auston Matthews »)
// car le service Python matche par nom exact (insensible à la casse) contre son
// pool de joueurs clés (top-6 attaquants + top-4 défenseurs). Un nom mal
// orthographié est ignoré en silence.

import { getEntry } from './manualData.service';
import { easternToday } from './startingGoalies';

/** Une journée d'absents : { ABBR: ["Nom complet MoneyPuck", …] }. */
export type ScratchDay = Record<string, string[]>;

function cleanNames(list: unknown): string[] {
  return Array.isArray(list)
    ? list.filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
    : [];
}

/**
 * La journée entière, en un seul accès — même raison que
 * `getStartingGoalies` : un match a deux équipes, une seule ligne les porte.
 */
export async function getScratchesDay(dateISO?: string): Promise<ScratchDay> {
  const day = await getEntry<ScratchDay>('scratches', dateISO ?? easternToday());
  if (!day || typeof day !== 'object') return {};
  const out: ScratchDay = {};
  for (const [abbr, list] of Object.entries(day)) {
    const names = cleanNames(list);
    if (names.length) out[abbr.toUpperCase()] = names;
  }
  return out;
}
