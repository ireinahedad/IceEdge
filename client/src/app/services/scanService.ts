/**
 * scanService.ts — « Scanner un ticket » (SCAN_TICKET_PLAN S3) : le COMPTEUR de scans.
 *
 * L'image et le texte du ticket ne quittent jamais l'appareil (OCR et `scanSlip` en
 * local). Le serveur ne fait que décompter les scans gratuits : 3 par jour (D2,
 * tranché le 2026-10-27), illimité en Pro.
 */
import { authedFetch } from "./authService";

export interface ScanUsage {
  pro: boolean;
  used: number;
  /** null = illimité (Pro). */
  limit: number | null;
  remaining: number | null;
  resetsAt: string;
}

/** Les scans gratuits du jour sont épuisés. */
export class ScanQuotaError extends Error {
  constructor(public readonly limit: number, public readonly resetsAt: string) {
    super("scan_quota");
  }
}

export async function getScanUsage(): Promise<ScanUsage> {
  const res = await authedFetch("/scan/usage");
  if (!res.ok) throw new Error("scan_usage_unavailable");
  return res.json();
}

/** Décompte un scan, au moment où l'analyse démarre (« Ajouter au coupon »). */
export async function startScan(): Promise<void> {
  const res = await authedFetch("/scan/start", { method: "POST" });
  if (res.status === 429) {
    const b = (await res.json().catch(() => ({}))) as { limit?: number; resetsAt?: string };
    throw new ScanQuotaError(b.limit ?? 3, b.resetsAt ?? "");
  }
  if (!res.ok) throw new Error("scan_unavailable");
}

/** Rend le scan quand aucune jambe n'a pu être ajoutée. Best-effort. */
export async function refundScan(): Promise<void> {
  await authedFetch("/scan/refund", { method: "POST" }).catch(() => undefined);
}
