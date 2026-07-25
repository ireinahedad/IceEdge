// ============================================================
//  Gardiens partants — override manuel (ou source externe)
// ============================================================
// Le gardien partant confirmé n'est pas exposé de façon fiable/stable par une
// API gratuite avant le match (Daily Faceoff = Cloudflare + build-id volatil).
// On lit donc un petit fichier JSON éditable à la main : il ne sert qu'aux
// EXCEPTIONS (backup qui part, n°1 blessé). Sans entrée, le modèle retombe sur
// sa moyenne de gardiens pondérée par l'usage récent (inference_state.json).
//
// Fichier : ml/data/starting_goalies.json  (chemin surchargeable STARTING_GOALIES_PATH)
// Format, daté (date locale Est) → { ABBR: "Nom complet MoneyPuck" } :
//   {
//     "2026-01-15": { "TOR": "Joseph Woll", "MTL": "Cayden Primeau" },
//     "2026-01-16": { "EDM": "Calvin Pickard" }
//   }
// Le NOM doit correspondre à l'orthographe MoneyPuck (ex. "Joseph Woll") car le
// service Python matche par nom exact (insensible à la casse).

import fs from 'fs';
import path from 'path';

type GoalieMap = Record<string, Record<string, string>>;

let cache: { data: GoalieMap; mtimeMs: number; checkedAt: number } | null = null;
const TTL = 30_000; // re-vérifie le fichier au plus toutes les 30 s

function filePath(): string {
  if (process.env.STARTING_GOALIES_PATH) return process.env.STARTING_GOALIES_PATH;
  return path.resolve(process.cwd(), '..', 'ml', 'data', 'starting_goalies.json');
}

/** Date locale Est (YYYY-MM-DD) — cohérent avec le calendrier NHL. */
function easternToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function load(): GoalieMap {
  const file = filePath();
  const now = Date.now();
  try {
    if (cache && now - cache.checkedAt < TTL) return cache.data;
    const stat = fs.statSync(file);
    if (cache && stat.mtimeMs === cache.mtimeMs) {
      cache.checkedAt = now;
      return cache.data;
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as GoalieMap;
    cache = { data, mtimeMs: stat.mtimeMs, checkedAt: now };
    return data;
  } catch {
    // Fichier absent/illisible → pas d'override (comportement par défaut du modèle)
    cache = { data: {}, mtimeMs: 0, checkedAt: now };
    return {};
  }
}

/**
 * Gardien partant confirmé pour une équipe aujourd'hui, ou undefined.
 * @param abbr abréviation d'équipe (ex. "TOR")
 * @param dateISO date du match "YYYY-MM-DD" (défaut : aujourd'hui, heure Est)
 */
export function getStartingGoalie(abbr: string, dateISO?: string): string | undefined {
  if (!abbr) return undefined;
  const day = (load()[dateISO ?? easternToday()]) ?? {};
  return day[abbr.toUpperCase()];
}
