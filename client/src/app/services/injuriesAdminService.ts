/**
 * injuriesAdminService.ts
 * Appels CRUD (admin) vers /api/injuries pour la saisie manuelle des
 * blessures/alignements. Écriture protégée côté serveur par requireRole('admin').
 */
import { tokenStore } from './tokenStore';
import { env } from '../env';

const API_BASE = env.apiBase;

const INJURIES_URL = `${API_BASE}/injuries`;

export interface InjuryPlayer { player: string; role?: string; status?: string; impact: number }
export interface GameInjuries {
  home?: InjuryPlayer[];
  away?: InjuryPlayer[];
  lineupAdj?: number;
  lineupNote?: string;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await tokenStore.getAccess();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** Toutes les entrées, clé "AWAY@HOME" → GameInjuries. */
export async function fetchAllInjuries(): Promise<Record<string, GameInjuries>> {
  const res = await fetch(INJURIES_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Injuries ${res.status}`);
  return res.json();
}

/** Upsert d'une entrée (admin). */
export async function saveInjuries(key: string, entry: GameInjuries): Promise<void> {
  const res = await fetch(`${INJURIES_URL}/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: await authHeaders(),
    body: JSON.stringify(entry),
  });
  if (!res.ok) throw new Error((await res.text().catch(() => '')) || `Injuries save ${res.status}`);
}

/** Suppression d'une entrée (admin). */
export async function deleteInjuries(key: string): Promise<void> {
  const res = await fetch(`${INJURIES_URL}/${encodeURIComponent(key)}`, {
    method: 'DELETE',
    headers: await authHeaders(),
  });
  if (!res.ok) throw new Error(`Injuries delete ${res.status}`);
}
