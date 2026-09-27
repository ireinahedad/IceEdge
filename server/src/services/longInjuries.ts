/**
 * longInjuries.ts — blessés de longue durée (kind `long_injuries`, 2026-09-27).
 *
 * ── Le problème ─────────────────────────────────────────────────────────────
 * Les deux saisies d'absents sont éphémères :
 *   • `scratches` est rangé par DATE : un joueur saisi hier n'existe plus
 *     aujourd'hui pour le modèle IA ;
 *   • `injuries` est rangé par MATCH (VISITEUR@MAISON) : il ne suit pas le
 *     joueur quand son équipe affronte un autre adversaire.
 * Un joueur absent trois semaines devait donc être retapé à chaque match, et un
 * oubli le faisait redevenir « présent » sans que rien ne le signale.
 *
 * ── La réponse ──────────────────────────────────────────────────────────────
 * Une ligne par ÉQUIPE, sans date de fin : le joueur reste absent jusqu'à ce
 * qu'un admin le retire. Rien n'est recopié dans les deux autres tables ; la
 * fusion se fait À LA LECTURE (`getScratchesDay`, `getManualFactors`), ce qui
 * veut dire que retirer le joueur ici le retire partout, immédiatement.
 *
 * Même tolérance aux pannes que le reste de `manualData` : base injoignable →
 * objet vide → comportement d'avant.
 */
import { mapEntries } from './manualData.service';

export interface LongInjury {
  player: string;
  /** Même barème que `injuries` : 0.12 gardien n° 1, 0.06 joueur clé, 0.03 soutien. */
  impact: number;
  /** Date (heure de l'Est) de la saisie — affichée, jamais utilisée pour expirer. */
  since?: string;
}

export interface LongInjuryEntry { players: LongInjury[] }

/** Toutes les équipes : { ABBR: [LongInjury, …] }, entrées invalides écartées. */
export async function getLongInjuries(): Promise<Record<string, LongInjury[]>> {
  const rows = await mapEntries<LongInjuryEntry>('long_injuries');
  const out: Record<string, LongInjury[]> = {};
  for (const [abbr, entry] of Object.entries(rows)) {
    const players = (Array.isArray(entry?.players) ? entry.players : [])
      .filter((p): p is LongInjury =>
        !!p && typeof p.player === 'string' && p.player.trim().length > 0
        && typeof p.impact === 'number' && Number.isFinite(p.impact))
      .map((p) => ({ ...p, player: p.player.trim() }));
    if (players.length) out[abbr.toUpperCase()] = players;
  }
  return out;
}

/** Union de deux listes de noms, insensible à la casse, la première gagne. */
export function mergeNames(a: string[], b: string[]): string[] {
  const seen = new Set(a.map((n) => n.trim().toLowerCase()));
  return [...a, ...b.filter((n) => !seen.has(n.trim().toLowerCase()) && seen.add(n.trim().toLowerCase()))];
}
