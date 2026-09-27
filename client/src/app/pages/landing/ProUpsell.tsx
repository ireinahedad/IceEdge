/**
 * ProUpsell.tsx — le gros bloc « Passer à Pro » de l'accueil (2026-09-27).
 *
 * Pour un non-abonné, les Meilleurs paris et les Value bets étaient deux
 * sections floutées l'une sous l'autre, chacune avec son petit cadenas. Ils
 * sont maintenant REGROUPÉS dans une seule carte, plus grande, qui dit ce que
 * Pro apporte et porte un gros bouton. Pour un abonné, cette carte disparaît
 * et les deux vraies sections reprennent leur place (Meilleurs paris d'abord).
 *
 * Guideline 3.1.1 (build iOS sans chemin vers Pro, `features.proUpgrade`
 * faux) : pas de bouton et PAS de « disponible sur le web » — seulement la
 * mention que c'est réservé aux abonnés. Même règle que `ProLock`.
 */

import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { Crown, Star, Zap, Lock } from "lucide-react";
import { useI18n } from "../../i18n";
import { features } from "../../platform";
import { EV_SAMPLE, EvRow } from "./EvSection";

function Feature({ icon, title, desc, children }: {
  icon: ReactNode; title: string; desc: string; children: ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-0.5">
        {icon}
        <span className="text-white text-sm font-bold">{title}</span>
        <Lock size={12} className="text-[#8a9ea6]" />
      </div>
      <p className="text-[#bfc8cc] text-[11px] leading-snug mb-2">{desc}</p>
      {/* Aperçu flouté, non interactif — la forme, pas le contenu. */}
      <div className="pointer-events-none select-none" style={{ filter: "blur(4px)", opacity: 0.55 }} aria-hidden>
        {children}
      </div>
    </div>
  );
}

export function ProUpsell({ accent }: { accent: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();

  const bestPreview = [
    { label: t("bb.teamWin", { abbr: "TOR" }), context: "TOR vs BOS · 19:00", pct: 74, color: "#4ade80" },
    { label: t("bb.over", { line: 5.5 }),      context: "EDM vs CGY · 21:00", pct: 66, color: "#4ade80" },
    { label: t("bb.puckLine", { abbr: "BOS" }), context: "BOS vs MTL · 19:30", pct: 52, color: "#f2c744" },
  ];

  // 2026-09-28 : plus compact, et SANS cadre autour de l'ensemble — les deux
  // aperçus restent groupés sous un même titre, mais sans carte englobante.
  return (
    <section>
      <div className="flex items-center gap-1.5 mb-1">
        <Crown size={13} style={{ color: "#f2c744" }} />
        <span className="text-[11px] font-bold uppercase tracking-[0.18em]" style={{ color: "#f2c744" }}>
          ArakIce Pro
        </span>
      </div>
      <p className="text-[#bfc8cc] text-xs mb-3">{t("home.proSub")}</p>

      <div className="flex flex-col gap-4">
        <Feature
          icon={<Star size={14} style={{ color: accent }} />}
          title={t("home.bestBets")}
          desc={t("home.proBestBetsDesc")}
        >
          <div className="flex flex-col gap-1.5">
            {bestPreview.slice(0, 2).map((r, i) => (
              <div key={i} className="flex items-center gap-2.5 icy-card rounded-xl px-3 py-1.5">
                <span className="text-sm flex-shrink-0">🏒</span>
                <div className="flex-1 min-w-0">
                  <div className="text-white text-xs font-semibold leading-tight truncate">{r.label}</div>
                  <div className="text-[#8a9ea6] text-[11px] truncate">{r.context}</div>
                </div>
                <span className="text-sm font-bold tabular-nums" style={{ color: r.color }}>{r.pct} %</span>
              </div>
            ))}
          </div>
        </Feature>

        <Feature
          icon={<Zap size={14} className="text-green-400" />}
          title={t("home.evTitle")}
          desc={t("home.proEvDesc")}
        >
          <div className="flex flex-col gap-1.5">
            {EV_SAMPLE.slice(0, 2).map((i) => <EvRow key={i.id} item={i} />)}
          </div>
        </Feature>
      </div>

      {features.proUpgrade ? (
        /* `state.from` : /pro ne peut pas revenir par l'historique, Stripe
           Checkout y est empilé. Voir `useProBackTarget` dans ProPage. */
        <div className="flex justify-center mt-3">
          <button
            onClick={() => navigate("/pro", { state: { from: location.pathname + location.search } })}
            className="tap-44 px-4 py-1.5 rounded-full text-xs font-bold active:scale-[0.97] transition-transform"
            style={{ background: accent, color: "#0A0E0C" }}
          >
            {t("pro.cta")}
          </button>
        </div>
      ) : (
        <p className="text-center text-[11px] text-[#8a9ea6] mt-3">{t("home.proOnly")}</p>
      )}
    </section>
  );
}
