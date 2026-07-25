// ============================================================
//  Absents confirmés du soir — override manuel (blessés / scratches)
// ============================================================
// Même logique que startingGoalies.ts : la compo confirmée n'est pas exposée de
// façon fiable/stable par une API gratuite avant le match (Daily Faceoff =
// Cloudflare + build-id volatil + ToS). On lit donc un petit fichier JSON
// éditable à la main avec les absents du soir. Sans entrée → aucun absent (le
// modèle suppose l'alignement complet, comportement par défaut).
//
// Fichier : ml/data/scratches.json  (chemin surchargeable SCRATCHES_PATH)
// Format, daté (date locale Est) → { ABBR: ["Nom complet MoneyPuck", ...] } :
//   {
//     "2026-01-15": { "TOR": ["Auston Matthews"], "MTL": ["Kaiden Guhle"] },
//     "2026-01-16": { "EDM": ["Mattias Ekholm", "Zach Hyman"] }
//   }
// Le NOM doit correspondre à l'orthographe MoneyPuck (ex. "Auston Matthews") car
// le service Python matche par nom exact (insensible à la casse) contre son pool
// de joueurs clés (top-6 attaquants + top-4 défenseurs).

import fs from 'fs';
import path from 'path';

type ScratchMap = Record<string, Record<string, string[]>>;

let cache: { data: ScratchMap; mtimeMs: number; checkedAt: number } | null = null;
const TTL = 30_000; // re-vérifie le fichier au plus toutes les 30 s

function filePath(): string {
  if (process.env.SCRATCHES_PATH) return process.env.SCRATCHES_PATH;
  return path.resolve(process.cwd(), '..', 'ml', 'data', 'scratches.json');
}

/** Date locale Est (YYYY-MM-DD) — cohérent avec le calendrier NHL. */
function easternToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function load(): ScratchMap {
  const file = filePath();
  const now = Date.now();
  try {
    if (cache && now - cache.checkedAt < TTL) return cache.data;
    const stat = fs.statSync(file);
    if (cache && stat.mtimeMs === cache.mtimeMs) {
      cache.checkedAt = now;
      return cache.data;
    }
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as ScratchMap;
    cache = { data, mtimeMs: stat.mtimeMs, checkedAt: now };
    return data;
  } catch {
    // Fichier absent/illisible → pas d'absents (comportement par défaut du modèle)
    cache = { data: {}, mtimeMs: 0, checkedAt: now };
    return {};
  }
}

/**
 * Liste des absents confirmés pour une équipe aujourd'hui (noms MoneyPuck),
 * ou un tableau vide.
 * @param abbr    abréviation d'équipe (ex. "TOR")
 * @param dateISO date du match "YYYY-MM-DD" (défaut : aujourd'hui, heure Est)
 */
export function getScratches(abbr: string, dateISO?: string): string[] {
  if (!abbr) return [];
  const day = load()[dateISO ?? easternToday()] ?? {};
  const list = day[abbr.toUpperCase()];
  return Array.isArray(list) ? list.filter((n) => typeof n === 'string' && n.trim()) : [];
}
