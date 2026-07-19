import { authedFetch } from './authService';

export interface SlipLeg {
  marketType:  string;
  subjectId?:  string;
  subjectName: string;
  subjectLogo: string;
  selection?:  string;
  line?:       number;
  probability: number;
  oddsLabel:   string;
  /** NHL game id — required for automatic settlement. */
  gameId?:         string;
  /** Machine-readable selection ('over' | 'under' | team abbr…) — required for automatic settlement. */
  selectionValue?: string;
}

export interface BetSlip {
  id:                  string;
  placedAt:            string;
  sport:               string;
  legs:                SlipLeg[];
  legCount:            number;
  isParlay:            boolean;
  combinedProbability: number | null;
  outcome:             'pending' | 'win' | 'loss';
  resolvedAt:          string | null;
  xpAwarded:           number;
}

export interface ResolveResult {
  xpAwarded: number;
  newXp:     number;
  newTier:   string;
  tieredUp:  boolean;
  message:   string;
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
    throw new Error(err.error ?? `Submit failed (${res.status})`);
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

export async function resolveSlip(
  slipId:  string,
  outcome: 'win' | 'loss',
): Promise<ResolveResult> {
  const res = await authedFetch(`/slips/${slipId}/resolve`, {
    method: 'PATCH',
    body: JSON.stringify({ outcome }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `Resolve failed (${res.status})`);
  }
  return res.json() as Promise<ResolveResult>;
}
