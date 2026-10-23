/**
 * MatchNews.tsx — dernières nouvelles des deux équipes, sur la page d'un match.
 * NEWS_CONSENSUS_PLAN.md, F1. Rien n'est affiché tant qu'il n'y a aucune nouvelle :
 * une carte vide n'apprend rien à l'utilisateur.
 */

import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { fetchMatchNews, type NewsItem } from "../../services/newsService";

function ago(iso: string, lang: string): string {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (min < 60) return lang === "fr" ? `il y a ${min} min` : `${min}m ago`;
  const h = Math.round(min / 60);
  return lang === "fr" ? `il y a ${h} h` : `${h}h ago`;
}

export function MatchNews({ home, away, accent }: { home: string; away: string; accent: string }) {
  const { t, lang } = useI18n();
  const [items, setItems] = useState<NewsItem[] | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchMatchNews([home, away], ctrl.signal).then((r) => { if (!ctrl.signal.aborted) setItems(r); });
    return () => ctrl.abort();
  }, [home, away]);

  if (!items || items.length === 0) return null;

  return (
    <div className="bg-[#111a1f] border border-white/20 rounded-2xl p-4 flex flex-col gap-3">
      <p className="text-white text-sm font-bold">{t("news.title")}</p>
      {items.slice(0, 6).map((n) => (
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
  );
}
