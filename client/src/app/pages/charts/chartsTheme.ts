/**
 * chartsTheme.ts
 *
 * Extrait de ChartPage.tsx le 2026-08-10 (3106 lignes → 11 fichiers).
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */



// Distinct line/slice colours cycled across players.
export const SERIES_COLORS = [
  "#86d1ea", "#4ade80", "#facc15", "#f472b6", "#a78bfa", "#fb923c",
  "#38bdf8", "#34d399", "#f87171", "#c084fc", "#2dd4bf", "#e879f9",
];

/* ── Palette ───────────────────────────────────────────────
 * Same visual language as the prediction page, but every surface is nudged a
 * shade lighter so the user recognises they are on the Charts page.
 */
export const BG_PAGE = "#12180F";
export const BG_HEADER = "rgba(18,24,15,0.92)";
export const BG_CARD = "#1A2216";
export const BG_CELL = "#12180F";

export type View = "skater" | "goalie";
export type PosFilter = "all" | "forwards" | "defense";
export type SortCol = "name" | "total" | "avg";
export type SortDir = "asc" | "desc";
export const DASH = "—";

export const selectCls =
  "rounded-full px-3 py-1.5 text-xs font-semibold border border-white/15 outline-none";

/** 20252026 → "25/26" */
export function seasonLabel(id: number): string {
  const s = String(id);
  return s.length === 8 ? `${s.slice(2, 4)}/${s.slice(6, 8)}` : s;
}

/** Current NHL season id (e.g. 20252026). Same rollover as the server's
 *  `currentSeason()` (services/nhl/core.ts): the new season id starts in
 *  SEPTEMBER. It used to be October here, which kept the app on 25/26 while
 *  2026-27 had already opened on 2026-09-29 (fixed 2026-09-30). */
export const currentSeasonId = (() => {
  const now = new Date();
  const y = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return Number(`${y}${y + 1}`);
})();

/* ── Value formatters ──────────────────────────────────── */
export const int = (v?: number | null) => (v == null ? DASH : String(Math.round(v)));
export const sign = (v?: number | null) => (v == null ? DASH : v > 0 ? `+${v}` : String(v));
export const num2 = (v?: number | null) => (v == null ? DASH : v.toFixed(2));
export const snum2 = (v?: number | null) =>
  v == null ? DASH : v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2);
export const svpct = (v?: number | null) => (v == null ? DASH : v.toFixed(3).replace(/^0/, ""));
export const per = (v?: number | null, gp?: number | null) =>
  v != null && gp && gp > 0 ? v / gp : null;
export const pct1 = (v?: number | null) => (v == null ? DASH : `${v.toFixed(1)}%`);
/** Decimal minutes (e.g. 21.87) → "MM:SS" for time-on-ice display. */
export const toiFmt = (v?: number | null) => {
  if (v == null) return DASH;
  const m = Math.floor(v);
  const s = Math.round((v - m) * 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};
