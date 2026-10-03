/**
 * injuryStore.ts
 * Produit deux facteurs 0-1 (faveur « victoire domicile », 0.5 = neutre) à
 * partir de la saisie manuelle, avec une note lisible :
 *   - injuries : blessures / joueurs manquants (impact par joueur)
 *   - lineup   : nouvel alignement / ajustement manuel direct
 *
 * ── Source : la base, plus `data/injuries.json` ─────────────────────────────
 * Le fichier n'existait pas dans le conteneur (`tsc` n'émet pas les `.json`,
 * le Dockerfile ne copie que `dist/`), donc cette fonction rendait TOUJOURS
 * neutre en production, sans rien signaler — et l'écriture admin échouait en
 * 500. Voir `db/migrations/034_manual_data.sql`.
 *
 * La fonction devient asynchrone. Son unique appelant, `buildGameMarkets`,
 * l'attendait déjà dans un `Promise.allSettled` d'autres sources : elle y a
 * simplement rejoint les autres, donc elle n'ajoute pas un aller-retour en
 * série. Le cache de 30 s de `manualData.service` fait le reste.
 */
import type { ManualFactor } from './predictionFactors';
import { getEntry } from './manualData.service';
import { getLongInjuries } from './longInjuries';
import { getOfficialLineupsDay, isDressed, type TeamLineup } from './officialLineup';

export interface InjuryEntry { player: string; role?: string; status?: string; impact: number }
export interface GameInjuries {
  home?: InjuryEntry[];
  away?: InjuryEntry[];
  lineupAdj?: number;    // -0.10..+0.10, + favorise la maison
  lineupNote?: string;
}

export interface ManualFactors { injuries: ManualFactor; lineup: ManualFactor }

/** Clé de saisie d'un match : « VISITEUR@MAISON », abréviations en majuscules. */
function injuryGameKey(homeAbbr: string, awayAbbr: string): string {
  return `${awayAbbr.toUpperCase()}@${homeAbbr.toUpperCase()}`;
}

function sumImpact(list?: InjuryEntry[]): number {
  return (list ?? []).reduce((s, e) => s + (Number(e.impact) || 0), 0);
}
function clamp(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, x)); }

const NEUTRAL: ManualFactor = { active: false, homeProb: 0.5, note: 'non renseigné' };

/** Facteurs manuels (blessures + alignement) pour un match. Tolérant aux pannes. */
export async function getManualFactors(homeAbbr: string, awayAbbr: string,
                                       gameDate?: string): Promise<ManualFactors> {
  // `getEntry` ne lève jamais : base injoignable → null → neutre, journalisé.
  // `gameDate` (défaut : aujourd'hui) : blessés et alignement officiel lus à la
  // date du MATCH, pas à celle du jour (ml/INCOHERENCES_ML.md §2).
  const [saisie, long, official] = await Promise.all([
    getEntry<GameInjuries>('injuries', injuryGameKey(homeAbbr, awayAbbr)),
    getLongInjuries(gameDate),
    getOfficialLineupsDay(gameDate).catch(() => ({} as Record<string, TeamLineup>)),
  ]);
  // Blessés de longue durée des deux équipes, ajoutés à la saisie du match. Un
  // joueur présent des deux côtés garde le poids saisi pour le match.
  // Un blessé de longue durée HABILLÉ dans l'alignement officiel du soir revient
  // au jeu : il ne pèse plus comme absent (la saisie du match, elle, prime).
  const withLong = (list: InjuryEntry[] | undefined, abbr: string): InjuryEntry[] => {
    const own  = list ?? [];
    const seen = new Set(own.map((e) => e.player.trim().toLowerCase()));
    const add  = (long[abbr.toUpperCase()] ?? [])
      .filter((p) => !seen.has(p.player.toLowerCase()))
      .filter((p) => !isDressed(official[abbr.toUpperCase()], p.player))
      .map((p) => ({ player: p.player, impact: p.impact, status: 'long' }));
    return [...own, ...add];
  };
  const home = withLong(saisie?.home, homeAbbr);
  const away = withLong(saisie?.away, awayAbbr);
  if (!saisie && home.length === 0 && away.length === 0) {
    return { injuries: { ...NEUTRAL }, lineup: { ...NEUTRAL } };
  }
  const entry: GameInjuries = { ...(saisie ?? {}), home, away };

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
