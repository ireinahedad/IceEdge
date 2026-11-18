import { useLocation, useNavigate } from "react-router";
import { Crown, ChevronRight } from "lucide-react";
import { useI18n } from "../../i18n";
import { trackEvent } from "../../analytics";
import { useTrialCta } from "../../experiments";

/**
 * Carte Pro compacte en HAUT de l'accueil — variante B du test `pro_position`
 * (voir experiments.ts). La grosse carte `ProUpsell` reste en bas pour tous.
 * Montrée seulement aux non-abonnés, et seulement si un chemin vers Pro existe
 * (`features.proUpgrade`, Guideline 3.1.1 sur iOS) : c'est l'appelant qui vérifie.
 */
export function ProTopCard({ accent }: { accent: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const trialCta = useTrialCta();
  return (
    <button
      type="button"
      onClick={() => {
        trackEvent(trialCta ? "pro_top_trial_click" : "pro_top_click");
        navigate("/pro", { state: { from: location.pathname + location.search } });
      }}
      className="w-full flex items-center gap-3 rounded-2xl border px-3 py-2.5 text-left active:scale-[0.99] transition-transform"
      style={{ borderColor: `${accent}66`, background: `${accent}14` }}
    >
      <span className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: accent }}>
        <Crown size={16} color="#0A0E0C" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-white text-sm font-bold">{t("home.proTopTitle")}</span>
        <span className="block text-[#bfc8cc] text-[11px] leading-snug truncate">{trialCta ? `${t("home.trialCta")} · ${t("home.trialNoCard")}` : t("home.proTopSub")}</span>
      </span>
      <span className="text-xs font-bold shrink-0 flex items-center" style={{ color: accent }}>
        {trialCta ? t("home.trialTry") : t("home.proTopCta")} <ChevronRight size={14} />
      </span>
    </button>
  );
}
