import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n";
import { IceedgeLogo } from "./brand/IceedgeLogo";
import {
  apiGetSubscription, apiStartCheckout, apiStartTrial, apiCancelSubscription,
  SubscriptionStatus,
} from "../services/subscriptionService";

const ACCENT        = "#9BF019";
const ACCENT_BG     = "rgba(155,240,25,0.12)";
const ACCENT_BORDER = "rgba(155,240,25,0.3)";
const SURFACE       = "#131A12";
const BORDER        = "#283323";
const MUTED         = "#92A08A";

// ── Pricing (edit freely) ──────────────────────────────────────────────────
const PRICE_MONTHLY = "11,99 $";
const CURRENCY      = "CAD";

// Pro-exclusive benefits only. Anything also available on Free is intentionally
// left out of this page.
interface Benefit { title: string; desc: string; }

function useBenefits(): Benefit[] {
  const { t } = useI18n();
  return [
    { title: t("pro.b.bestbets.t"), desc: t("pro.b.bestbets.d") },
    { title: t("pro.b.ev.t"),       desc: t("pro.b.ev.d") },
    { title: t("pro.b.alerts.t"),   desc: t("pro.b.alerts.d") },
    { title: t("pro.b.llm.t"),      desc: t("pro.b.llm.d") },
    { title: t("pro.b.markets.t"),  desc: t("pro.b.markets.d") },
    { title: t("pro.b.others.t"),   desc: t("pro.b.others.d") },
  ];
}

export function ProPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { t } = useI18n();
  const benefits = useBenefits();

  const [sub,     setSub]     = useState<SubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    apiGetSubscription().then(setSub).catch(() => {});
  }, [user]);

  async function handleUpgrade() {
    if (!user) { navigate("/login?returnTo=/pro"); return; }
    setError(null);
    setLoading(true);
    try {
      const result = await apiStartCheckout();
      if (result.url) {
        window.location.href = result.url;         // Stripe Checkout
      } else if (result.status) {
        setSub(result.status);                     // dev activation
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setLoading(false);
    }
  }

  async function handleTrial() {
    if (!user) { navigate("/login?returnTo=/pro"); return; }
    setError(null);
    setLoading(true);
    try { setSub(await apiStartTrial()); }
    catch (err: unknown) { setError(err instanceof Error ? err.message : "Error"); }
    finally { setLoading(false); }
  }

  async function handleCancel() {
    setLoading(true);
    try { setSub(await apiCancelSubscription()); }
    finally { setLoading(false); }
  }

  const fmtDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString() : "";

  const isPro = sub?.isPro ?? false;
  const isTrial = sub?.status === "trialing";
  const trialAvailable = !!user && !sub?.trialUsed;

  return (
    <div className="flex flex-col min-h-screen text-white max-w-[430px] mx-auto px-5 pt-14 pb-12"
      style={{ background: "#0A0E0C" }}>

      {/* Hero */}
      <div className="flex flex-col items-center text-center mb-8">
        <IceedgeLogo size={56} wordmark={false} className="mb-4" />
        <div className="px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest mb-3"
          style={{ background: ACCENT_BG, color: ACCENT, border: `1px solid ${ACCENT_BORDER}` }}>
          IceEdge Pro
        </div>
        <h1 className="text-2xl font-bold mb-2" style={{ fontFamily: "'Oswald','Arial Narrow',sans-serif" }}>
          {t("pro.title")}
        </h1>
        <p className="text-sm" style={{ color: "#B7C4AD" }}>{t("pro.subtitle")}</p>
      </div>

      {/* Pro active banner */}
      {isPro && (
        <div className="rounded-2xl p-4 mb-6 text-center"
          style={{ background: ACCENT_BG, border: `1px solid ${ACCENT_BORDER}` }}>
          <div className="font-bold mb-1" style={{ color: ACCENT }}>
            {isTrial ? t("pro.trialActive") : t("pro.isProTitle")}
          </div>
          <div className="text-xs" style={{ color: "#B7C4AD" }}>
            {sub?.cancelAtPeriodEnd
              ? `${t("pro.cancelScheduled")} ${fmtDate(sub.currentPeriodEnd)}`
              : isTrial && sub?.currentPeriodEnd
                ? `${t("pro.trialEnds")} ${fmtDate(sub.currentPeriodEnd)}`
                : sub?.currentPeriodEnd
                  ? `${t("pro.renews")} ${fmtDate(sub.currentPeriodEnd)}`
                  : t("pro.isProBody")}
          </div>
        </div>
      )}

      {/* Price card */}
      {!isPro && (
        <div className="rounded-2xl p-5 mb-6 text-center"
          style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
          <div className="flex items-end justify-center gap-1 mb-1">
            <span className="text-4xl font-bold" style={{ color: ACCENT }}>{PRICE_MONTHLY}</span>
            <span className="text-sm mb-1" style={{ color: MUTED }}>{CURRENCY} {t("pro.perMonth")}</span>
          </div>
          <div className="text-xs" style={{ color: MUTED }}>{t("pro.annualNote")}</div>
          {trialAvailable && (
            <div className="text-[11px] font-semibold mt-2" style={{ color: ACCENT }}>{t("pro.trialNote")}</div>
          )}
        </div>
      )}

      {/* Pro-exclusive benefits */}
      <div className="rounded-2xl overflow-hidden mb-6" style={{ border: `1px solid ${BORDER}` }}>
        <div className="px-4 py-3 text-[11px] uppercase tracking-wider"
          style={{ background: SURFACE, color: ACCENT }}>
          {t("pro.included")}
        </div>
        {benefits.map((b, i) => (
          <div key={i} className="flex items-start gap-3 px-4 py-3"
            style={{ borderTop: `1px solid ${BORDER}` }}>
            <span className="mt-0.5 shrink-0" style={{ color: ACCENT, fontWeight: 700 }}>✓</span>
            <div>
              <div className="text-sm font-semibold" style={{ color: "#F3F7F0" }}>{b.title}</div>
              <div className="text-xs mt-0.5" style={{ color: MUTED }}>{b.desc}</div>
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div className="text-red-400 text-xs text-center py-2 px-3 rounded-xl bg-red-500/10 border border-red-500/20 mb-3">
          {error}
        </div>
      )}

      {/* CTA */}
      {isPro ? (
        !sub?.cancelAtPeriodEnd && (
          <button onClick={handleCancel} disabled={loading}
            className="w-full py-3 rounded-xl text-sm font-medium disabled:opacity-50"
            style={{ background: SURFACE, border: `1px solid ${BORDER}`, color: MUTED }}>
            {t("pro.cancel")}
          </button>
        )
      ) : trialAvailable ? (
        <div className="flex flex-col gap-2">
          {/* Free trial is the primary CTA when still available */}
          <button onClick={handleTrial} disabled={loading}
            className="w-full py-4 rounded-xl text-sm font-bold transition-all active:scale-[0.98] disabled:opacity-50"
            style={{ background: ACCENT, color: "#0A0E0C" }}>
            {loading ? "..." : user ? t("pro.startTrial") : t("pro.loginPrompt")}
          </button>
          <button onClick={handleUpgrade} disabled={loading}
            className="w-full py-3 rounded-xl text-sm font-medium disabled:opacity-50"
            style={{ background: SURFACE, border: `1px solid ${BORDER}`, color: "#F3F7F0" }}>
            {t("pro.cta")}
          </button>
        </div>
      ) : (
        <button onClick={handleUpgrade} disabled={loading}
          className="w-full py-4 rounded-xl text-sm font-bold transition-all active:scale-[0.98] disabled:opacity-50"
          style={{ background: ACCENT, color: "#0A0E0C" }}>
          {loading ? "..." : user ? t("pro.cta") : t("pro.loginPrompt")}
        </button>
      )}

      <p className="text-center text-[10px] mt-4" style={{ color: MUTED, opacity: 0.6 }}>
        {t("pro.devNote")}
      </p>
    </div>
  );
}
