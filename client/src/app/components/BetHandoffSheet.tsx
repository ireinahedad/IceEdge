/**
 * BetHandoffSheet — « à chercher chez ton livre », avant de l'ouvrir (2026-10-02).
 *
 * Bet365 ne permet pas d'ouvrir un match ou un pari précis depuis l'extérieur :
 * ses adresses internes changent, et The Odds API ne le cote pas en LNH, donc
 * aucun identifiant de match ne nous parvient. L'app ne peut ouvrir que sa page
 * hockey. Décision du user : on montre d'abord, bien lisibles, le match, le
 * marché, la sélection et la COTE MINIMALE, avec un bouton pour copier le tout,
 * puis on ouvre le livre. Le pari se retrouve en deux touches, et la cote
 * minimale dit tout de suite si le prix chez son livre vaut encore le coup.
 *
 * Monté UNE fois, sous tous les providers (`App.tsx`) : il lit le ticket posé
 * par `openBetFor` (`BookmakerContext`) et utilise le format de cote, qui vit
 * sous `BookmakerProvider`.
 */

import { useState } from "react";
import { Copy, Check, ExternalLink } from "lucide-react";
import { useBookmaker } from "../context/BookmakerContext";
import { useOddsFormat } from "../context/OddsFormatContext";
import { useI18n } from "../i18n";
import { openBet } from "../services/bookmakers";

/**
 * « Rentable au-dessus de 2.38 » — sauf en format pourcentage, où une cote plus
 * généreuse s'écrit avec un % plus PETIT : là, c'est « sous 42 % ».
 */
export function useMinOddsText(): (minOdds: number) => string {
  const { t } = useI18n();
  const { odds, format } = useOddsFormat();
  return (minOdds) => t(format === "percent" ? "handoff.minOddsPct" : "handoff.minOdds", { min: odds(minOdds) });
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 border-b border-white/5 last:border-0">
      <span className="text-[#8a9ea6] text-xs flex-shrink-0">{label}</span>
      <span className={`text-right text-sm ${strong ? "text-green-400 font-bold" : "text-white font-semibold"}`}>{value}</span>
    </div>
  );
}

export function BetHandoffHost() {
  const { ticket, closeTicket, bookmaker } = useBookmaker();
  const { t } = useI18n();
  const { odds } = useOddsFormat();
  const minOddsText = useMinOddsText();
  const [copied, setCopied] = useState(false);
  if (!ticket) return null;

  const minText = ticket.minOdds != null ? minOddsText(ticket.minOdds) : null;
  const summary = [ticket.match, ticket.when, ticket.market, ticket.selection, minText]
    .filter(Boolean).join(" · ");

  const close = () => { setCopied(false); closeTicket(); };
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(summary);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const go = () => { openBet("hockey"); close(); };

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center" onClick={close}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("handoff.title", { book: bookmaker.label })}
        className="relative w-full max-w-[430px] md:max-w-lg icy-card rounded-t-3xl p-6 pb-nav-safe"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-4" />
        <p className="text-white font-bold text-base">{t("handoff.title", { book: bookmaker.label })}</p>
        <p className="text-white/60 text-xs mt-1 mb-3">{t("handoff.why", { book: bookmaker.label })}</p>

        <div className="rounded-2xl bg-white/[0.03] border border-white/10 px-3 py-1 mb-3">
          <Row label={t("handoff.match")} value={ticket.when ? `${ticket.match} · ${ticket.when}` : ticket.match} />
          {ticket.market && <Row label={t("handoff.market")} value={ticket.market} />}
          <Row label={t("handoff.selection")} value={ticket.selection} />
          {minText && <Row label={t("handoff.minLabel")} value={minText} strong />}
          {ticket.shownPrice != null && (
            <Row label={t("handoff.shown", { book: ticket.shownBook ?? t("pred.bookOdds") })} value={odds(ticket.shownPrice)} />
          )}
        </div>
        {minText && <p className="text-[#bfc8cc] text-[11px] leading-snug mb-4">{t("handoff.minHint")}</p>}

        <div className="flex gap-2">
          <button
            onClick={copy}
            className="tap-44 flex-1 flex items-center justify-center gap-1.5 py-3 rounded-2xl border border-white/10 text-white/80 text-sm"
          >
            {copied ? <Check size={15} className="text-green-400" /> : <Copy size={15} />}
            {copied ? t("handoff.copied") : t("handoff.copy")}
          </button>
          <button
            onClick={go}
            className="tap-44 flex-1 flex items-center justify-center gap-1.5 py-3 rounded-2xl text-sm font-bold"
            style={{ background: bookmaker.colors.bg, color: bookmaker.colors.fg }}
          >
            {t("handoff.open", { book: bookmaker.label })}
            <ExternalLink size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
