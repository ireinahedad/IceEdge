/**
 * gameDay.ts — le JOUR d'un match, écrit pour un humain.
 *
 * Deux usages, sur l'accueil et sur Stats :
 *   - `weekdayShort`   le jour de semaine sur la carte (« lun. », « Mon ») ;
 *   - `dayHeading`     le titre posé au-dessus des matchs d'une même journée
 *                      (« Aujourd'hui · lundi 21 sept. »).
 *   - `groupByDay`     découpe une liste déjà triée en journées, dans l'ordre.
 *
 * Le jour vient de `gameDate` (`YYYY-MM-DD`, la date que la LNH donne au
 * match), lu comme une date LOCALE à midi — jamais via `new Date("2026-09-21")`,
 * qui la lit en UTC minuit et la recule d'un jour à l'ouest de Greenwich. C'est
 * aussi la clé de regroupement : un match de 22 h à Vancouver reste dans la
 * journée où la LNH l'a mis, même s'il tombe le lendemain en heure de Bali.
 */

export type Lang = "en" | "fr" | string;

/**
 * La semaine de l'accueil : aujourd'hui et les 7 jours suivants, en dates
 * `YYYY-MM-DD` (même calcul que l'accueil a toujours fait). Partagée entre
 * `HockeyLanding` et le préchargement de `main.tsx` (PERF_PLAN.md, P2.4) : les
 * deux doivent demander EXACTEMENT la même URL `/games/range`, sinon le
 * préchargement serait perdu.
 */
export function homeWeek(now = new Date()): { offset: number; d: Date; dateStr: string }[] {
  return Array.from({ length: 8 }, (_, offset) => {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    return { offset, d, dateStr: d.toISOString().split("T")[0] };
  });
}

const locale = (lang: Lang) => (lang === "fr" ? "fr-CA" : "en-US");

/** `YYYY-MM-DD…` → Date locale à midi ; `null` si illisible. */
export function parseGameDay(iso?: string | null): Date | null {
  if (!iso) return null;
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 12);
}

/** Clé de journée (`YYYY-MM-DD`) d'une date ISO, ou `""`. */
export function dayKey(iso?: string | null): string {
  return parseGameDay(iso) ? String(iso).slice(0, 10) : "";
}

/** Écart en jours avec aujourd'hui (0 = aujourd'hui, 1 = demain…). */
function daysFromToday(d: Date): number {
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  return Math.round((start(d) - start(new Date())) / 86_400_000);
}

const cap = (s: string) => (s ? s.charAt(0).toLocaleUpperCase() + s.slice(1) : s);

/** « lun. » / « Mon » — le jour de semaine d'une carte de match. */
export function weekdayShort(iso: string | null | undefined, lang: Lang): string {
  const d = parseGameDay(iso);
  return d ? cap(d.toLocaleDateString(locale(lang), { weekday: "short" })) : "";
}

/**
 * Titre d'une journée : « Aujourd'hui · lundi 21 sept. », « Demain · … »,
 * sinon « Mercredi 23 sept. ». Le jour de semaine y est toujours — c'est ce
 * que le titre est là pour dire.
 */
export function dayHeading(iso: string | null | undefined, lang: Lang): string {
  const d = parseGameDay(iso);
  if (!d) return "";
  const full = d.toLocaleDateString(locale(lang), { weekday: "long", day: "numeric", month: "short" });
  const n = daysFromToday(d);
  if (n === 0) return `${lang === "fr" ? "Aujourd'hui" : "Today"} · ${full}`;
  if (n === 1) return `${lang === "fr" ? "Demain" : "Tomorrow"} · ${full}`;
  return cap(full);
}

/**
 * Découpe une liste en journées, dans l'ordre où les journées apparaissent.
 * La liste doit déjà être triée par mise au jeu : on ne retrie rien ici.
 */
export function groupByDay<T>(items: T[], isoOf: (x: T) => string | null | undefined): { day: string; items: T[] }[] {
  const byDay = new Map<string, T[]>();
  for (const it of items) {
    const day = dayKey(isoOf(it));
    const list = byDay.get(day);
    if (list) list.push(it); else byDay.set(day, [it]);
  }
  return [...byDay.entries()].map(([day, list]) => ({ day, items: list }));
}
