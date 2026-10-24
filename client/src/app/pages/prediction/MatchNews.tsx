/**
 * MatchNews.tsx — dernières nouvelles des deux équipes, sur la page d'un match.
 * NEWS_CONSENSUS_PLAN.md, F1. Rien n'est affiché tant qu'il n'y a aucune nouvelle :
 * une carte vide n'apprend rien à l'utilisateur.
 *
 * Pliable (demande du user, 2026-10-23), REPLIÉE par défaut comme le Top 90 % :
 * l'en-tête montre déjà le nombre de nouvelles et d'alertes gardien / alignement,
 * de quoi savoir s'il vaut la peine d'ouvrir. Soumise au « Tout plier » de la page.
 */

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useI18n } from "../../i18n";
import { useSectionFold } from "./foldAll";
import { fetchMatchNews, type NewsItem } from "../../services/newsService";

function ago(iso: string, lang: string): string {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (min < 60) return lang === "fr" ? `il y a ${min} min` : `${min}m ago`;
  const h = Math.round(min / 60);
  return lang === "fr" ? `il y a ${h} h` : `${h}h ago`;
}

/**
 * Les 6 nouvelles affichées : les plus récentes, mais au plus 2 par auteur et
 * sans doublon exact. Sur le fil réel du 2026-10-24, les 6 cases de TOR–EDM
 * étaient toutes à Daily Faceoff Edmonton, surtout de la promo (étape 1).
 */
export function pickShown(items: NewsItem[], max = 6, perAuthor = 2): NewsItem[] {
  const out: NewsItem[] = [];
  const byAuthor = new Map<string, number>();
  const seen = new Set<string>();
  for (const n of items) {
    const k = n.excerpt.trim().toLowerCase();
    const c = byAuthor.get(n.author) ?? 0;
    if (seen.has(k) || c >= perAuthor) continue;
    seen.add(k);
    byAuthor.set(n.author, c + 1);
    out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

export function MatchNews({ home, away, accent }: { home: string; away: string; accent: string }) {
  const { t, lang } = useI18n();
  const [items, setItems] = useState<NewsItem[] | null>(null);
  const [collapsed, toggleFold] = useSectionFold("news", true);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchMatchNews([home, away], ctrl.signal).then((r) => { if (!ctrl.signal.aborted) setItems(r); });
    return () => ctrl.abort();
  }, [home, away]);

  if (!items || items.length === 0) return null;

  const shown = pickShown(items);
  const alerts = shown.filter((n) => n.flags.includes("goalie") || n.flags.includes("lineup")).length;

  return (
    <div className="bg-[#111a1f] border border-white/20 rounded-2xl p-4">
      <button
        type="button"
        onClick={toggleFold}
        aria-expanded={!collapsed}
        className={`w-full flex items-center justify-between gap-2 ${collapsed ? "" : "mb-3"}`}
      >
        <p className="text-white text-sm font-bold">{t("news.title")}</p>
        <span className="flex items-center gap-2">
          {alerts > 0 && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">
              {t("news.alerts", { n: alerts })}
            </span>
          )}
          <span className="text-[#8a9ea6] text-[11px]">{shown.length}</span>
          <ChevronDown
            aria-hidden
            className={`w-4 h-4 text-[#3a5060] transition-transform ${collapsed ? "" : "rotate-180"}`}
          />
        </span>
      </button>
      {collapsed ? null : (
      <div className="flex flex-col gap-3">
      {shown.map((n) => (
        <a
          key={n.id}
          href={n.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex flex-col gap-1 border-t border-white/10 pt-3 first-of-type:border-t-0 first-of-type:pt-0 active:opacity-70"
        >
          <div className="flex items-center gap-2 flex-wrap">
            {n.flags.includes("goalie") && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded" style={{ background: accent + "22", color: accent }}>{t("news.flag.goalie")}</span>
            )}
            {n.flags.includes("lineup") && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">{t("news.flag.lineup")}</span>
            )}
            <span className="text-[#c0cdd4] text-[11px] font-semibold">{n.author}</span>
            <span className="text-[#4a6070] text-[11px]">· {ago(n.postedAt, lang)}</span>
          </div>
          <p className="text-white/90 text-[12px] leading-relaxed">{n.excerpt}</p>
        </a>
      ))}
      <p className="text-[#4a6070] text-[10px]">{t("news.sourceNote")}</p>
      </div>
      )}
    </div>
  );
}
