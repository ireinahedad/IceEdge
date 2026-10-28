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

/** Un SGP entièrement chiffré, tel qu'envoyé au journal anonyme des prix (migration 052). */
export interface SgpPriceLogGroup {
  gameId: string;
  odds: string;
  modelPct: number;
  modelSource: "server" | "local";
  legs: { market: string; subjectType: "team" | "player" | "game"; subjectId: string; selection: string; line?: number; modelPct: number }[];
}

/**
 * Journal ANONYME des prix SGP (plan « Parlay Tax ») : cote, bookmaker, marchés, proba du
 * modèle. Rien du compte n'est envoyé ni écrit côté serveur. Best-effort, jamais attendu.
 */
export async function logSgpPrices(body: {
  book: string; lang: string | null; oddsFormat: string | null; groups: SgpPriceLogGroup[];
}): Promise<void> {
  if (!body.groups.length) return;
  await authedFetch("/scan/price-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => undefined);
}
