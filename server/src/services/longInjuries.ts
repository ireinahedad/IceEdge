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
 *
 * ── Les entrées automatiques (ajout du 2026-09-29) ─────────────────────────
 * `npm run injuries:sync` (server/scripts/sync-injuries.ts) pose des entrées
 * `source: 'auto'`, avec une date de fin estimée (`until`). Trois règles :
 *
 *   1. La synchro ne touche JAMAIS une entrée saisie à la main : elle ne
 *      remplace que ses propres entrées (`mergeAutoSync`).
 *   2. Un joueur automatique que l'admin retire (« Revenu au jeu », ou décoché)
 *      est noté dans `dismissed` avec la date de sa blessure : la synchro du
 *      lendemain ne le remet pas, sauf si la source publie une NOUVELLE note
 *      (autre date). Sans ça, une note périmée le ferait revenir chaque jour.
 *   3. Un joueur automatique dont l'admin change l'importance devient une
 *      entrée manuelle : c'est lui qui en répond désormais (`mergeManualSave`).
 *
 * `until` vaut aussi pour les entrées manuelles qui en ont une : passé ce
 * jour, l'entrée reste en base (l'écran la montre) mais ne compte plus.
 */
import { mapEntries } from './manualData.service';
import { easternToday } from './startingGoalies';

export interface LongInjury {
  player: string;
  /** Même barème que `injuries` : 0.12 gardien n° 1, 0.06 joueur clé, 0.03 soutien. */
  impact: number;
  /**
   * Saisie manuelle : date de la saisie (affichée). Entrée automatique : date
   * de la blessure chez la source — c'est la clé de `dismissed`.
   */
  since?: string;
  /** Dernier jour d'absence prévu (heure de l'Est), inclus. Absent = jusqu'au retrait. */
  until?: string;
  /** `'auto'` = posé par la synchro ; absent = saisi à la main. */
  source?: 'auto';
}

/** Un joueur automatique retiré à la main, et la blessure qu'il ne faut plus reposer. */
export interface DismissedAuto { player: string; since?: string }

export interface LongInjuryEntry { players: LongInjury[]; dismissed?: DismissedAuto[] }

/** « Slafkovský » saisi à la main et « Slafkovsky » posé par la synchro sont le même joueur. */
const nameKey = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

/** L'entrée compte-t-elle ce jour-là ? Sans `until`, toujours. */
export function isActiveOn(p: LongInjury, dayISO: string): boolean {
  return !p.until || p.until >= dayISO;
}

/**
 * Toutes les équipes : { ABBR: [LongInjury, …] }, entrées invalides ET
 * expirées écartées. `dayISO` (heure de l'Est) sert aux tests.
 */
export async function getLongInjuries(dayISO: string = easternToday()): Promise<Record<string, LongInjury[]>> {
  const rows = await mapEntries<LongInjuryEntry>('long_injuries');
  const out: Record<string, LongInjury[]> = {};
  for (const [abbr, entry] of Object.entries(rows)) {
    const players = (Array.isArray(entry?.players) ? entry.players : [])
      .filter((p): p is LongInjury =>
        !!p && typeof p.player === 'string' && p.player.trim().length > 0
        && typeof p.impact === 'number' && Number.isFinite(p.impact))
      .filter((p) => isActiveOn(p, dayISO))
      .map((p) => ({ ...p, player: p.player.trim() }));
    if (players.length) out[abbr.toUpperCase()] = players;
  }
  return out;
}

/**
 * Ce que l'écran d'admin envoie (PUT d'une équipe) fusionné avec ce qui est en
 * base. L'écran ne connaît ni `dismissed` ni, pour un vieux client, `source` :
 * c'est donc le serveur qui les déduit.
 *
 *   • même joueur, entrée auto, même importance → reste auto (`source`,
 *     `until`, `since` d'origine conservés) ;
 *   • même joueur, entrée auto, importance changée → devient manuelle ;
 *   • entrée auto qui a disparu de la liste → rejoint `dismissed`.
 */
export function mergeManualSave(existing: LongInjuryEntry | null, incoming: LongInjury[]): LongInjuryEntry {
  const before = new Map((existing?.players ?? []).map((p) => [nameKey(p.player), p]));
  const players: LongInjury[] = incoming.map((p) => {
    const old = before.get(nameKey(p.player));
    if (old?.source === 'auto' && old.impact === p.impact) {
      return { player: p.player, impact: p.impact, since: old.since, until: p.until ?? old.until, source: 'auto' };
    }
    const out: LongInjury = { player: p.player, impact: p.impact };
    if (p.since) out.since = p.since;
    if (p.until) out.until = p.until;
    return out;
  });
  const kept = new Set(players.map((p) => nameKey(p.player)));
  const dismissed: DismissedAuto[] = [...(existing?.dismissed ?? [])];
  for (const old of existing?.players ?? []) {
    if (old.source !== 'auto' || kept.has(nameKey(old.player))) continue;
    if (!dismissed.some((d) => nameKey(d.player) === nameKey(old.player) && d.since === old.since)) {
      dismissed.push({ player: old.player, since: old.since });
    }
  }
  return dismissed.length ? { players, dismissed } : { players };
}

/**
 * La synchro d'une équipe : les entrées manuelles restent telles quelles, les
 * entrées automatiques sont REMPLACÉES par `auto`, sauf celles que l'admin a
 * rejetées pour la même blessure. `dismissed` est élagué de ce que la source ne
 * liste plus, pour ne pas grossir sans fin. Rend `null` quand il ne reste rien
 * (ligne à effacer).
 *
 * `keepUnseen` : une entrée automatique ABSENTE de `auto` est gardée telle
 * quelle si ce prédicat le dit. La synchro ne lit que la 1re page de la source
 * (les suivantes sont refusées aux robots, 403 mesuré le 2026-09-30) : un
 * joueur dont la dernière note est sortie de cette page n'est pas « revenu au
 * jeu », on ne sait simplement rien de neuf. Le script garde donc les entrées
 * dont le joueur n'apparaît pas sur la page et dont la date de fin n'est pas
 * passée. Sans prédicat, le comportement est le remplacement pur.
 */
export function mergeAutoSync(
  existing: LongInjuryEntry | null,
  auto: LongInjury[],
  keepUnseen: (p: LongInjury) => boolean = () => false,
): LongInjuryEntry | null {
  const manual = (existing?.players ?? []).filter((p) => p.source !== 'auto');
  const manualNames = new Set(manual.map((p) => nameKey(p.player)));
  const autoNames = new Set(auto.map((p) => nameKey(p.player)));
  const isDismissed = (p: LongInjury) =>
    (existing?.dismissed ?? []).some((d) => nameKey(d.player) === nameKey(p.player) && d.since === p.since);

  const fresh = auto
    .filter((p) => !manualNames.has(nameKey(p.player)) && !isDismissed(p))
    .map((p) => ({ ...p, source: 'auto' as const }));
  const kept = (existing?.players ?? [])
    .filter((p) => p.source === 'auto' && !autoNames.has(nameKey(p.player)) && keepUnseen(p));
  const dismissed = (existing?.dismissed ?? []).filter((d) =>
    auto.some((p) => nameKey(p.player) === nameKey(d.player) && p.since === d.since));

  const players = [...manual, ...kept, ...fresh];
  if (!players.length && !dismissed.length) return null;
  return dismissed.length ? { players, dismissed } : { players };
}

/** Union de deux listes de noms, insensible à la casse, la première gagne. */
export function mergeNames(a: string[], b: string[]): string[] {
  const seen = new Set(a.map((n) => n.trim().toLowerCase()));
  return [...a, ...b.filter((n) => !seen.has(n.trim().toLowerCase()) && seen.add(n.trim().toLowerCase()))];
}
