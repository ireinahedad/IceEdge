import { authedFetch } from './authService';

export interface SlipLeg {
  marketType:  string;
  subjectId?:  string;
  subjectName: string;
  subjectLogo: string;
  selection?:  string;
  line?:       number;
  probability: number;
  /** Prix AMÉRICAIN du livre au verrouillage. Absent = le livre ne cotait pas
   *  la jambe. ⚠️ Avant le 2026-09-30 : cote déduite du modèle, pas un prix. */
  oddsLabel?:  string;
  /** Prix DÉCIMAL du livre au verrouillage (depuis le 2026-09-30). */
  bookPrice?:  number;
  /** NHL game id — required for automatic settlement. */
  gameId?:         string;
  /** Machine-readable selection ('over' | 'under' | team abbr…) — required for automatic settlement. */
  selectionValue?: string;
  /**
   * Issue de CETTE sélection, posée par le serveur au fil des matchs.
   *
   * Absente tant que le match n'est pas terminé — y compris sur un pari en
   * cours dont d'autres sélections sont déjà décidées. Le serveur n'écrit
   * jamais `unknown` et n'efface jamais un résultat déjà posé
   * (`settlement.service.ts`), donc « absente » se lit toujours « pas encore ».
   */
  result?: 'win' | 'loss' | 'void';
}

export interface BetSlip {
  id:                  string;
  placedAt:            string;
  sport:               string;
  legs:                SlipLeg[];
  legCount:            number;
  isParlay:            boolean;
  combinedProbability: number | null;
  /** `void` : toutes les jambes annulées (voir `slipOutcome.ts`). */
  outcome:             'pending' | 'win' | 'loss' | 'void';
  resolvedAt:          string | null;
  xpAwarded:           number;
}



export async function submitSlip(
  legs:                SlipLeg[],
  sport:               string = 'hockey',
  combinedProbability: number | null = null,
): Promise<{ slipId: string; message: string }> {
  const res = await authedFetch('/slips', {
    method: 'POST',
    body: JSON.stringify({ legs, sport, combinedProbability }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    // `code` porté sur l'erreur : l'écran traduit les refus qu'il connaît
    // (`GAME_STARTED`) au lieu d'afficher le message anglais du serveur.
    throw Object.assign(new Error(err.error ?? `Submit failed (${res.status})`), { code: err.code });
  }
  return res.json();
}

export async function getMySlips(limit = 50): Promise<BetSlip[]> {
  const res = await authedFetch(`/slips?limit=${limit}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `Fetch failed (${res.status})`);
  }
  return res.json();
}

/** Annuler un pari en cours (avant le premier match seulement). */
export async function cancelSlip(slipId: string): Promise<void> {
  const res = await authedFetch(`/slips/${encodeURIComponent(slipId)}`, { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(err.error ?? `Cancel failed (${res.status})`), { code: err.code });
  }
}

export interface SettlementSummary {
  checked: number;
  settled: number;
  wins:    number;
  losses:  number;
}

/** Ask the server to check pending slips against real NHL results. */
export async function settleMySlips(): Promise<SettlementSummary> {
  const res = await authedFetch('/slips/settle', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `Settle failed (${res.status})`);
  }
  return res.json() as Promise<SettlementSummary>;
}


