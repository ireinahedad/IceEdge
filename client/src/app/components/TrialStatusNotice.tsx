import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Crown, X } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { useSubscription } from "../context/SubscriptionContext";
import { useI18n } from "../i18n";
import { features } from "../platform";
import { trackEvent } from "../analytics";

/**
 * Fin d'essai Pro, dans l'app (2026-11-20, audit Growth).
 *
 * Avant : un essai de 7 jours se terminait en silence — le Pro disparaissait
 * et rien ne disait pourquoi ni comment le garder. 2 essais finis, 0 converti.
 *
 *   • Essai en cours, ≤ 2 jours restants → bandeau discret « Essai Pro : plus
 *     que N jours » vers /pro (masquable pour la session).
 *   • Essai fini → fiche « Votre essai est terminé » UNE fois par compte et
 *     par navigateur, avec le bouton vers /pro.
 *
 * Mesure (product_events + Clarity) : `trial_ended_paywall_view`, `_click`,
 * `_dismiss`, `trial_ending_banner_click`. Les courriels de fin d'essai
 * (trialLifecycle.service.ts côté serveur) couvrent ceux qui ne reviennent pas.
 *
 * Rien sur /pro elle-même ni sur /login, et rien sur iOS tant qu'aucun chemin
 * d'achat n'existe (`features.proUpgrade`, Guideline 3.1.1).
 */
const ENDED_SEEN_KEY = "ae.trialEndedSeen";
const ENDING_HIDDEN_KEY = "ae.trialEndingHidden";
const DAY_MS = 24 * 60 * 60 * 1000;

export function TrialStatusNotice() {
  const { user } = useAuth();
  const { status, isPro, loading } = useSubscription();
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const [endedOpen, setEndedOpen] = useState(false);
  const [endingHidden, setEndingHidden] = useState(() => {
    try { return sessionStorage.getItem(ENDING_HIDDEN_KEY) === "1"; } catch { return false; }
  });

  const onProOrAuth = /^\/(pro|login|auth)/.test(location.pathname);
  const end = status?.currentPeriodEnd ? new Date(status.currentPeriodEnd).getTime() : null;
  const isLocalTrial = !!status && status.status === "trialing" && (status.source ?? "local") === "local";
  const trialEnded = !loading && !!user && isLocalTrial && !isPro && end !== null && end <= Date.now();
  const daysLeft = isLocalTrial && isPro && end !== null ? Math.ceil((end - Date.now()) / DAY_MS) : null;
  const showEnding = !onProOrAuth && !endingHidden && daysLeft !== null && daysLeft >= 1 && daysLeft <= 2;

  useEffect(() => {
    if (!trialEnded || onProOrAuth || !features.proUpgrade || !user) return;
    const key = `${ENDED_SEEN_KEY}.${user.id}`;
    try { if (localStorage.getItem(key)) return; localStorage.setItem(key, "1"); } catch { /* montrée quand même */ }
    setEndedOpen(true);
    trackEvent("trial_ended_paywall_view");
  }, [trialEnded, onProOrAuth, user]);

  if (!features.proUpgrade) return null;

  const goPro = (event: string) => {
    trackEvent(event);
    setEndedOpen(false);
    navigate("/pro", { state: { from: location.pathname + location.search } });
  };

  if (endedOpen) {
    return (
      <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/60" role="dialog" aria-modal="true" aria-label={t("trial.endedTitle")}>
        <div className="w-full max-w-[420px] rounded-t-3xl sm:rounded-3xl border border-white/15 p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom,0px))]" style={{ background: "rgba(10, 22, 30, 0.98)" }}>
          <div className="flex items-start justify-between mb-3">
            <span className="w-9 h-9 rounded-full flex items-center justify-center bg-[#9BF019]">
              <Crown size={18} color="#0A0E0C" />
            </span>
            <button
              type="button"
              aria-label={t("trial.notNow")}
              onClick={() => { trackEvent("trial_ended_paywall_dismiss"); setEndedOpen(false); }}
              className="p-1 text-[#bfc8cc]"
            >
              <X size={20} />
            </button>
          </div>
          <p className="text-white text-lg font-bold mb-1">{t("trial.endedTitle")}</p>
          <p className="text-[#bfc8cc] text-sm leading-relaxed mb-4">{t("trial.endedBody")}</p>
          <button
            type="button"
            onClick={() => goPro("trial_ended_paywall_click")}
            className="w-full h-11 rounded-xl bg-[#9BF019] text-[#0A0E0C] text-sm font-bold active:scale-95 transition-transform"
          >
            {t("trial.keepPro")}
          </button>
          <button
            type="button"
            onClick={() => { trackEvent("trial_ended_paywall_dismiss"); setEndedOpen(false); }}
            className="w-full h-10 mt-2 text-[#bfc8cc] text-sm"
          >
            {t("trial.notNow")}
          </button>
        </div>
      </div>
    );
  }

  if (showEnding) {
    return (
      <div className="fixed left-1/2 -translate-x-1/2 top-[calc(0.5rem+env(safe-area-inset-top,0px))] z-[55] w-[94%] max-w-[420px] flex items-center gap-2 rounded-2xl border border-[#9BF019]/40 px-3 py-2" style={{ background: "rgba(10, 22, 30, 0.96)" }}>
        <Crown size={16} color="#9BF019" className="shrink-0" />
        <button type="button" onClick={() => goPro("trial_ending_banner_click")} className="flex-1 text-left text-white text-xs font-semibold">
          {t(daysLeft === 1 ? "trial.endingOne" : "trial.endingMany", { n: daysLeft ?? 0 })}{" "}
          <span className="text-[#9BF019]">{t("trial.keepPro")} ›</span>
        </button>
        <button
          type="button"
          aria-label={t("trial.notNow")}
          onClick={() => { try { sessionStorage.setItem(ENDING_HIDDEN_KEY, "1"); } catch { /* rien */ } setEndingHidden(true); }}
          className="p-1 text-[#bfc8cc] shrink-0"
        >
          <X size={14} />
        </button>
      </div>
    );
  }

  return null;
}
