import { useEffect } from "react";
import { useNavigate } from "react-router";
import { useI18n } from "../i18n";
import { useSubscription } from "../context/SubscriptionContext";
import { IceedgeLogo } from "../components/brand/IceedgeLogo";

const ACCENT        = "#86d1ea";
const ACCENT_BG     = "rgba(134,209,234,0.12)";
const ACCENT_BORDER = "rgba(134,209,234,0.3)";

/**
 * Shown right after a user activates Pro (upgrade / trial / promo).
 * Confirms the upgrade, then offers a clear path back to the home page.
 */
export function ProSuccessPage() {
  const navigate = useNavigate();
  const { t } = useI18n();
  const { refresh } = useSubscription();

  // Make sure the global Pro flag reflects the fresh status.
  useEffect(() => { refresh(); }, [refresh]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen text-white max-w-[430px] mx-auto px-6 text-center"
      style={{ background: "#0A0E0C" }}>
      <button onClick={() => navigate("/", { replace: true })} aria-label="Accueil ArakIce">
        <IceedgeLogo size={64} wordmark={false} className="mb-5" />
      </button>

      <div className="px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest mb-4"
        style={{ background: ACCENT_BG, color: ACCENT, border: `1px solid ${ACCENT_BORDER}` }}>
        ArakIce Pro
      </div>

      <h1 className="text-2xl font-bold mb-3" style={{ fontFamily: "'Oswald','Arial Narrow',sans-serif" }}>
        {t("pro.successTitle")}
      </h1>
      <p className="text-sm mb-8" style={{ color: "#B7C4AD" }}>
        {t("pro.successBody")}
      </p>

      <button
        onClick={() => navigate("/", { replace: true })}
        className="w-full py-4 rounded-xl text-sm font-bold transition-all active:scale-[0.98]"
        style={{ background: ACCENT, color: "#0A0E0C" }}
      >
        {t("pro.successHome")}
      </button>
    </div>
  );
}
