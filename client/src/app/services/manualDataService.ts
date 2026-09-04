/**
 * manualDataService.ts — client des routes `/api/manual/*` (admin).
 *
 * Remplace `injuriesAdminService.ts`. Trois différences qui comptent :
 *
 * 1. **La donnée vit en base**, plus dans `server/src/data/injuries.json`.
 *    L'ancien `PUT /api/injuries/:key` écrivait dans un `dist/data/` qui
 *    n'existe pas dans le conteneur : il rendait 500 en production, et la carte
 *    admin affichait « Échec de l'enregistrement (admin requis) » — un message
 *    qui accusait les permissions alors que le problème était ailleurs.
 *
 * 2. **`authedFetch` au lieu de `fetch` + en-têtes à la main.** L'ancienne
 *    version lisait le jeton une fois et l'envoyait tel quel : un jeton expiré
 *    (15 min) donnait un 401 sec, sans tentative de rafraîchissement. En pleine
 *    saisie d'avant-match, ça se traduisait par un enregistrement perdu.
 *    `authedFetch` rafraîchit et rejoue.
 *
 * 3. **La lecture aussi est authentifiée.** `GET /api/injuries` était public ;
 *    la liste nominative des joueurs qu'on croit absents et la pondération
 *    qu'on leur donne, c'est la méthode du modèle, pas son résultat.
 */

import { authedFetch } from './authService';

// ── Blessures / alignement ───────────────────────────────────────────────────

export interface InjuryPlayer { player: string; role?: string; status?: string; impact: number }
export interface GameInjuries {
  home?: InjuryPlayer[];
  away?: InjuryPlayer[];
  lineupAdj?: number;
  lineupNote?: string;
}

// ── Compos du soir ───────────────────────────────────────────────────────────

/** { "TOR": "Joseph Woll" } — orthographe MoneyPuck. */
export type GoalieDay = Record<string, string>;
/** { "TOR": ["Auston Matthews"] } — orthographe MoneyPuck. */
export type ScratchDay = Record<string, string[]>;

export interface LineupsDay {
  date: string;
  goalies: GoalieDay;
  scratches: ScratchDay;
}

// ── Helper ───────────────────────────────────────────────────────────────────

/**
 * Le serveur répond `{ error }` sur 4xx/5xx. On remonte SON message quand il y
 * en a un : « clé de match invalide » ou « impact: Number must be less than or
 * equal to 0.5 » disent quelque chose, « Erreur 400 » non.
 */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authedFetch(`/manual${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `Erreur ${res.status}`);
  }
  // 204 sans corps : rien à lire.
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ── Blessures ────────────────────────────────────────────────────────────────

/** Toutes les entrées, clé « VISITEUR@MAISON » → GameInjuries. */
export function fetchAllInjuries(): Promise<Record<string, GameInjuries>> {
  return call<Record<string, GameInjuries>>('/injuries');
}

/** Crée ou remplace l'entrée d'un match. Une entrée vide est supprimée. */
export function saveInjuries(key: string, entry: GameInjuries): Promise<void> {
  return call<void>(`/injuries/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify(entry),
  });
}

export function deleteInjuries(key: string): Promise<void> {
  return call<void>(`/injuries/${encodeURIComponent(key)}`, { method: 'DELETE' });
}

// ── Compos du soir ───────────────────────────────────────────────────────────

/** Gardiens partants + absents d'une journée (défaut : aujourd'hui, heure Est). */
export function fetchLineups(date?: string): Promise<LineupsDay> {
  const q = date ? `?date=${encodeURIComponent(date)}` : '';
  return call<LineupsDay>(`/lineups${q}`);
}

/**
 * Enregistre la journée. Chaque champ fourni REMPLACE sa journée entière —
 * l'écran envoie toujours l'état complet de ce qu'il affiche, ce qui est aussi
 * ce qui permet de retirer un gardien saisi par erreur.
 */
export function saveLineups(
  date: string,
  payload: { goalies?: GoalieDay; scratches?: ScratchDay },
): Promise<LineupsDay> {
  return call<LineupsDay>(`/lineups/${encodeURIComponent(date)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

// ── Arbitres (pas d'écran : une passe par saison, via API) ────────────────────

export interface RefereeTendency { name: string; ppPerGame: number; note?: string }

export function fetchReferees(): Promise<{ leagueAvgPpPerGame: number; referees: RefereeTendency[] }> {
  return call('/referees');
}

/** Remplace la table entière (atomique côté serveur). */
export function saveReferees(payload: {
  leagueAvgPpPerGame?: number;
  referees?: RefereeTendency[];
}): Promise<{ ok: true; count: number | null }> {
  return call('/referees', { method: 'PUT', body: JSON.stringify(payload) });
}
