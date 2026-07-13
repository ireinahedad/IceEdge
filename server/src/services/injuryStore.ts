/**
 * injuryStore.ts
 * Lit le fichier de saisie manuelle (data/injuries.json) et produit deux facteurs
 * 0-1 (faveur "victoire domicile", 0.5 = neutre) avec une note lisible :
 *   - injuries : blessures / joueurs manquants (impact par joueur)
 *   - lineup   : nouvel alignement / ajustement manuel direct
 *
 * Le fichier est relu à chaque appel (édition à chaud possible).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import type { ManualFactor } from './predictionFactors';

interface InjuryEntry { player: string; role?: string; status?: string; impact: number }
interface GameInjuries {
  home?: InjuryEntry[];
  away?: InjuryEntry[];
  lineupAdj?: number;    // -0.10..+0.10, + favorise la maison
  lineupNote?: string;
}

export interface ManualFactors { injuries: ManualFactor; lineup: ManualFactor }

const INJURIES_PATH = join(__dirname, '..', 'data', 'injuries.json');

function gameKey(homeAbbr: string, awayAbbr: string): string {
  return `${awayAbbr.toUpperCase()}@${homeAbbr.toUpperCase()}`;
}
function sumImpact(list?: InjuryEntry[]): number {
  return (list ?? []).reduce((s, e) => s + (Number(e.impact) || 0), 0);
}
function clamp(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, x)); }

const NEUTRAL: ManualFactor = { active: false, homeProb: 0.5, note: 'non renseigné' };

/** Facteurs manuels (blessures + alignement) pour un match. Tolérant aux erreurs. */
export function getManualFactors(homeAbbr: string, awayAbbr: string): ManualFactors {
  let games: Record<string, GameInjuries> = {};
  try {
    games = JSON.parse(readFileSync(INJURIES_PATH, 'utf8')).games ?? {};
  } catch {
    return { injuries: { ...NEUTRAL }, lineup: { ...NEUTRAL } };
  }

  const entry = games[gameKey(homeAbbr, awayAbbr)];
  if (!entry) return { injuries: { ...NEUTRAL }, lineup: { ...NEUTRAL } };

  // ── Facteur blessures ──
  const homeHit = sumImpact(entry.home);
  const awayHit = sumImpact(entry.away);
  let injuries: ManualFactor = { ...NEUTRAL };
  if (homeHit > 0 || awayHit > 0) {
    const parts: string[] = [];
    if (homeHit > 0) parts.push(`maison −${(homeHit*100).toFixed(0)}% (${(entry.home ?? []).map(e => e.player).join(', ')})`);
    if (awayHit > 0) parts.push(`visiteur −${(awayHit*100).toFixed(0)}% (${(entry.away ?? []).map(e => e.player).join(', ')})`);
    injuries = { active: true, homeProb: clamp(0.5 + (awayHit - homeHit), 0.05, 0.95), note: parts.join(' ; ') };
  }

  // ── Facteur alignement ──
  let lineup: ManualFactor = { ...NEUTRAL };
  if (typeof entry.lineupAdj === 'number' && entry.lineupAdj !== 0) {
    lineup = {
      active: true,
      homeProb: clamp(0.5 + entry.lineupAdj, 0.05, 0.95),
      note: entry.lineupNote ?? (entry.lineupAdj > 0 ? 'avantage alignement maison' : 'avantage alignement visiteur'),
    };
  }

  return { injuries, lineup };
}
