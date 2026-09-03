import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n";
import { features } from "../platform";
import { IceedgeLogo } from "../components/brand/IceedgeLogo";
import { AppButton } from "../components/AppButton";
import {
  apiGetSubscription, apiStartCheckout, apiStartTrial, apiCancelSubscription,
  apiRedeemPromo, SubscriptionStatus,
} from "../services/subscriptionService";

const ACCENT        = "#86d1ea";
const ACCENT_BG     = "rgba(134,209,234,0.12)";
const ACCENT_BORDER = "rgba(134,209,234,0.3)";
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
  const [promo,      setPromo]      = useState("");
  const [promoBusy,  setPromoBusy]  = useState(false);
  const [promoError, setPromoError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    apiGetSubscription().then(setSub).catch(() => {});
  }, [user]);

  async function handleUpgrade() {
    // APPLE_PLAN §7 — Guideline 3.1.1: a paid upgrade on iOS must go through
    // In-App Purchase, never Stripe Checkout. Every button below is hidden
    // when the flag is off; this guard is what makes that non-negotiable.
    if (!features.stripeCheckout) return;
    if (!user) { navigate("/login?returnTo=/pro"); return; }
    setError(null);
    setLoading(true);
    try {
      const result = await apiStartCheckout();
      if (result.url) {
        window.location.href = result.url;         // Stripe Checkout
      } else if (result.status) {
        setSub(result.status);                     // dev activation
        if (result.status.isPro) navigate("/pro/success");
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
    try {
      const status = await apiStartTrial();
      setSub(status);
      if (status.isPro) navigate("/pro/success");
    }
    catch (err: unknown) { setError(err instanceof Error ? err.message : "Error"); }
    finally { setLoading(false); }
  }

  async function handleRedeem() {
    if (!user) { navigate("/login?returnTo=/pro"); return; }
    if (!promo.trim()) return;
    setPromoError(null);
    setPromoBusy(true);
    try {
      const status = await apiRedeemPromo(promo.trim());
      setSub(status);
      setPromo("");
      if (status.isPro) navigate("/pro/success");
    } catch (err: unknown) {
      setPromoError(err instanceof Error ? err.message : "Error");
    } finally {
      setPromoBusy(false);
    }
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

      {/* Explicit back button — this page has no BottomNav, so it must never be a dead end */}
      <button
        onClick={() => navigate(-1)}
        className="flex items-center gap-1.5 text-[#bfc8cc] text-sm mb-4 self-start active:opacity-70"
        aria-label={t("pro.back") || "Retour"}
      >
        ← {t("pro.back") || "Retour"}
      </button>

      {/* Hero */}
      <div className="flex flex-col items-center text-center mb-8">
        <button onClick={() => navigate("/")} aria-label="Accueil ArakIce">
          <IceedgeLogo size={56} wordmark={false} className="mb-4" />
        </button>
        <div className="px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest mb-3"
          style={{ background: ACCENT_BG, color: ACCENT, border: `1px solid ${ACCENT_BORDER}` }}>
          ArakIce Pro
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

      {/* Price card — a price shown without a way to buy is worse than no
          price, so it travels with the checkout flag (APPLE_PLAN §7). */}
      {!isPro && features.stripeCheckout && (
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
          <AppButton variant="ghost" onClick={handleCancel} disabled={loading} loading={loading} fullWidth>
            {t("pro.cancel")}
          </AppButton>
        )
      ) : trialAvailable ? (
        <div className="flex flex-col gap-2">
          {/* Free trial is the primary CTA when still available */}
          <AppButton onClick={handleTrial} disabled={loading} loading={loading} fullWidth size="lg">
            {user ? t("pro.startTrial") : t("pro.loginPrompt")}
          </AppButton>
          {features.stripeCheckout && (
            <AppButton variant="ghost" onClick={handleUpgrade} disabled={loading} loading={loading} fullWidth>
              {t("pro.cta")}
            </AppButton>
          )}
        </div>
      ) : features.stripeCheckout ? (
        <AppButton onClick={handleUpgrade} disabled={loading} loading={loading} fullWidth size="lg">
          {user ? t("pro.cta") : t("pro.loginPrompt")}
        </AppButton>
      ) : null}

      {/* Promo code — activate Pro without payment */}
      {!isPro && (
        <div className="mt-6">
          <div className="text-[11px] uppercase tracking-wider mb-2" style={{ color: MUTED }}>
            {t("pro.promo.label")}
          </div>
          <div className="flex gap-2">
            <input
              value={promo}
              onChange={(e) => { setPromo(e.target.value); setPromoError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") handleRedeem(); }}
              placeholder={t("pro.promo.placeholder")}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              className="flex-1 py-3 px-3 rounded-xl text-sm outline-none uppercase tracking-wide"
              style={{ background: SURFACE, border: `1px solid ${BORDER}`, color: "#F3F7F0" }}
            />
            <AppButton
              variant="secondary"
              onClick={handleRedeem}
              disabled={promoBusy || !promo.trim()}
              loading={promoBusy}
            >
              {t("pro.promo.apply")}
            </AppButton>
          </div>
          {promoError && (
            <div className="text-red-400 text-xs mt-2">{promoError}</div>
          )}
        </div>
      )}

      <p className="text-center text-[10px] mt-4" style={{ color: MUTED, opacity: 0.6 }}>
        {t("pro.devNote")}
      </p>
    </div>
  );
}
