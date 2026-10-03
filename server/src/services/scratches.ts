// ============================================================
//  Absents confirmés du soir — override manuel (blessés / scratches)
// ============================================================
// Trois sources, fusionnées par `getLineupDay` : la saisie du jour (prioritaire),
// les blessés de longue durée, et — depuis le 2026-10-02 — l'alignement
// OFFICIEL que l'API NHL publie peu avant la mise au jeu (`officialLineup.ts`).
// Avant sa publication, et sans saisie → aucun absent (le modèle suppose
// l'alignement complet, comportement par défaut).
//
// ── Source : la base, plus `ml/data/scratches.json` ────────────────────────
// Le chemin `cwd/../ml/data` n'existe pas dans le conteneur, donc cette table
// était vide en production, en silence. Voir
// `db/migrations/034_manual_data.sql`.
//
// Stockage : kind `scratches`, une ligne par DATE (heure de l'Est) :
//   entry_key '2026-01-15'  →  { "TOR": ["Auston Matthews"], "MTL": ["Kaiden Guhle"] }
//
// Le NOM est apparié à l'orthographe MoneyPuck (ex. « Auston Matthews ») sans
// tenir compte de la casse, des accents, des points ni des espaces en trop
// (`_name_key` côté Python) : « Slafkovský » (API NHL) = « Slafkovsky ». Contre son
// pool de joueurs clés (top-6 attaquants + top-4 défenseurs). Un nom mal
// orthographié est ignoré en silence.

import { getEntry } from './manualData.service';
import { easternToday } from './startingGoalies';
import { getLongInjuries, mergeNames } from './longInjuries';
import { getOfficialLineupsDay, isDressed, nameKeys, type TeamLineup } from './officialLineup';

/** Une journée d'absents : { ABBR: ["Nom complet MoneyPuck", …] }. */
export type ScratchDay = Record<string, string[]>;

/** Habillés du soir d'une équipe, pour le service ML (identifiants NHL + noms). */
export interface DressedList { ids: number[]; names: string[] }

export interface LineupDay {
  /** Absents : saisie du jour ∪ blessés de longue durée ∪ absents officiels. */
  scratches: ScratchDay;
  /** Alignement officiel publié, moins les absents saisis à la main. */
  dressed: Record<string, DressedList>;
}

function cleanNames(list: unknown): string[] {
  return Array.isArray(list)
    ? list.filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
    : [];
}

/**
 * La journée entière, en un seul accès — même raison que
 * `getStartingGoalies` : un match a deux équipes, une seule ligne les porte.
 *
 * ── Alignement officiel (2026-10-02) ───────────────────────────────────────
 * Dès que la NHL publie (cf. `officialLineup.ts`), elle complète la saisie :
 *   • ses absents officiels rejoignent la liste (dès T−30 min, par morceaux) ;
 *   • alignement DÉFINITIF (T−9 à T−7 min) : un blessé de longue durée qui
 *     est HABILLÉ n'est plus compté absent —
 *     c'est le joueur qui revient de blessure, la date `until` n'était qu'une
 *     estimation ;
 *   • la saisie du JOUR reste prioritaire : un joueur qu'elle déclare absent
 *     le reste, même habillé, et il est retiré de la liste des habillés.
 */
export async function getLineupDay(dateISO?: string): Promise<LineupDay> {
  const date = dateISO ?? easternToday();
  // La même date sert à l'expiration des blessés longue durée (`until`).
  const [day, long, official] = await Promise.all([
    getEntry<ScratchDay>('scratches', date),
    getLongInjuries(date),
    getOfficialLineupsDay(date).catch(() => ({} as Record<string, TeamLineup>)),
  ]);
  const manual: ScratchDay = {};
  if (day && typeof day === 'object') {
    for (const [abbr, list] of Object.entries(day)) {
      const names = cleanNames(list);
      if (names.length) manual[abbr.toUpperCase()] = names;
    }
  }
  const out: ScratchDay = { ...manual };
  // Blessés de longue durée : absents TOUS les jours, sans ressaisie — sauf
  // s'ils figurent dans l'alignement officiel du soir.
  for (const [abbr, players] of Object.entries(long)) {
    const names = players.map((p) => p.player).filter((n) => !isDressed(official[abbr], n));
    if (names.length) out[abbr] = mergeNames(out[abbr] ?? [], names);
  }
  // Absents officiels.
  const dressed: Record<string, DressedList> = {};
  for (const [abbr, lineup] of Object.entries(official)) {
    const scratched = lineup.scratches.map((p) => p.name).filter(Boolean);
    if (scratched.length) out[abbr] = mergeNames(out[abbr] ?? [], scratched);
    if (!lineup.confirmed) continue;    // absents publiés, alignement pas encore définitif
    const manualKeys = new Set((manual[abbr] ?? []).flatMap(nameKeys));
    const kept = lineup.dressed.filter((p) => !nameKeys(p.name).some((k) => manualKeys.has(k)));
    dressed[abbr] = { ids: kept.map((p) => p.id), names: kept.map((p) => p.name) };
  }
  return { scratches: out, dressed };
}

/** Les absents seuls (voir `getLineupDay`). */
export async function getScratchesDay(dateISO?: string): Promise<ScratchDay> {
  return (await getLineupDay(dateISO)).scratches;
}
