import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n";
import { features } from "../platform";
import { IceedgeLogo } from "../components/brand/IceedgeLogo";
import { AppButton } from "../components/AppButton";
import {
  apiGetSubscription, apiStartCheckout, apiStartTrial, apiCancelSubscription,
  apiRedeemPromo, SubscriptionStatus, type BillingPeriod,
} from "../services/subscriptionService";

import { Check } from "lucide-react";
const ACCENT        = "#86d1ea";
const ACCENT_BG     = "rgba(134,209,234,0.12)";
const ACCENT_BORDER = "rgba(134,209,234,0.3)";
const SURFACE       = "#131A12";
const BORDER        = "#283323";
const MUTED         = "#92A08A";

// ── Pricing (edit freely) ──────────────────────────────────────────────────
//
// ⚠️ Ces trois constantes ne sont que de l'AFFICHAGE. Le montant réellement
// débité vient du tarif Stripe désigné par STRIPE_PRICE_PRO_MONTHLY /
// STRIPE_PRICE_PRO_YEARLY côté serveur. Les changer ici sans changer le tarif
// là-bas ment au client au moment le plus coûteux : entre le prix affiché et
// l'écran de paiement.
const PRICE_MONTHLY = 5.99;
const PRICE_YEARLY  = 60;
const CURRENCY      = "CAD";

/** « 5,99 $ » en français, « $5.99 » en anglais — l'écriture était figée en
 *  français pour les deux langues (2026-10-05). */
function formatPrice(amount: number, lang: "en" | "fr"): string {
  return new Intl.NumberFormat(lang === "fr" ? "fr-CA" : "en-CA", {
    style: "currency", currency: CURRENCY, currencyDisplay: "narrowSymbol",
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  }).format(amount);
}

// Pro-exclusive benefits only. Anything also available on Free is intentionally
// left out of this page.
interface Benefit { title: string; desc: string; }

/**
 * `llmMonthlyQuota` vient du serveur (`GET /subscription/me`) et non d'une
 * constante d'ici : le plafond IA est dérivé du prix de l'abonnement, donc il
 * bouge dès qu'on change le prix. Une page de vente qui annonce un chiffre figé
 * finit par mentir — c'est ce qui s'était produit avec « Analyse IA illimitée ».
 * Tant que le champ n'est pas là (serveur pas encore déployé), on prend la
 * formulation sans chiffre plutôt que d'en inventer un.
 */
function useBenefits(llmMonthlyQuota?: number): Benefit[] {
  const { t } = useI18n();
  return [
    { title: t("pro.b.bestbets.t"), desc: t("pro.b.bestbets.d") },
    { title: t("pro.b.ev.t"),       desc: t("pro.b.ev.d") },
    { title: t("pro.b.alerts.t"),   desc: t("pro.b.alerts.d") },
    {
      title: t("pro.b.llm.t"),
      desc: llmMonthlyQuota
        ? t("pro.b.llm.d", { n: llmMonthlyQuota })
        : t("pro.b.llm.dNoCount"),
    },
    { title: t("pro.b.markets.t"),  desc: t("pro.b.markets.d") },
    { title: t("pro.b.others.t"),   desc: t("pro.b.others.d") },
  ];
}

/**
 * Où renvoie le bouton « Retour » de /pro.
 *
 * ── Pourquoi ce n'est PAS `navigate(-1)` ────────────────────────────────────
 * Le parcours d'achat quitte l'app : `window.location.href = <url Stripe>`
 * empile Stripe Checkout dans l'historique du navigateur, et l'`cancel_url` de
 * la session ramène sur /pro. L'historique vaut donc
 * `… → /pro → checkout.stripe.com → /pro`, et un `navigate(-1)` depuis ce
 * dernier /pro renvoie sur Stripe — c'est le bug signalé. Aucune API ne permet
 * de retirer l'entrée Stripe de l'historique : la seule correction possible est
 * que le bouton cesse de dépendre de l'historique.
 *
 * ── Ce qu'on mémorise à la place ────────────────────────────────────────────
 * La route d'origine, passée en `state` par les appelants (`ProLock`, les deux
 * boutons des Réglages). Elle est recopiée dans `sessionStorage` parce que le
 * retour de Stripe est un CHARGEMENT COMPLET : `location.state` est alors nul,
 * et sans ce relais on retomberait sur l'accueil après un achat annulé.
 * Repli sur l'accueil : /pro n'a pas de BottomNav, elle ne doit jamais être un
 * cul-de-sac, y compris en lien direct depuis l'extérieur.
 */
const PRO_BACK_KEY = "arakice_pro_back";

function useProBackTarget(): string {
  const location = useLocation();
  const fromState = (location.state as { from?: string } | null)?.from;

  // sessionStorage lève dans un onglet privé verrouillé ; un bouton Retour ne
  // vaut pas une page blanche.
  try {
    if (fromState) sessionStorage.setItem(PRO_BACK_KEY, fromState);
    else {
      const stored = sessionStorage.getItem(PRO_BACK_KEY);
      if (stored) return stored;
    }
  } catch { /* pas de mémoire de session : on garde le repli */ }

  return fromState ?? "/";
}

export function ProPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { t, lang } = useI18n();
  const backTo = useProBackTarget();

  const [sub,     setSub]     = useState<SubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  // Déclaré APRÈS `sub` : la liste d'avantages a besoin du plafond IA que le
  // serveur renvoie. L'ordre des hooks reste stable (aucun appel conditionnel),
  // c'est la seule règle qui compte ici.
  const benefits = useBenefits(sub?.llmMonthlyQuota);
  // Cadence choisie sur la carte de prix. Mensuel par défaut : c'est le moindre
  // engagement, donc le défaut honnête.
  const [period, setPeriod] = useState<BillingPeriod>("monthly");
  const [promo,      setPromo]      = useState("");
  const [promoBusy,  setPromoBusy]  = useState(false);
  const [promoError, setPromoError] = useState<string | null>(null);

  // `user?.id` et non `user` : l'objet est remplacé quand AuthContext enrichit
  // le profil, ce qui relançait `GET /subscription/me` (audit du 2026-09-16).
  useEffect(() => {
    if (!user) return;
    apiGetSubscription().then(setSub).catch(() => {});
  }, [user?.id]);

  async function handleUpgrade() {
    // APPLE_PLAN §7 — Guideline 3.1.1: a paid upgrade on iOS must go through
    // In-App Purchase, never Stripe Checkout. Every button below is hidden
    // when the flag is off; this guard is what makes that non-negotiable.
    if (!features.stripeCheckout) return;
    if (!user) { navigate("/login?returnTo=/pro"); return; }
    setError(null);
    setLoading(true);
    try {
      const result = await apiStartCheckout(period);
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

  // N'afficher le choix annuel que si le serveur a bien un ID de tarif pour lui :
  // un bouton qui mène à une erreur de paiement coûte plus qu'un bouton absent.
  const yearlyAvailable = sub?.periods?.includes("yearly") ?? false;
  const isYearly = yearlyAvailable && period === "yearly";
  const isPro = sub?.isPro ?? false;
  const isTrial = sub?.status === "trialing";
  const trialAvailable = !!user && !sub?.trialUsed;

  return (
    <div className="flex flex-col min-h-screen text-white max-w-[430px] mx-auto px-5 pt-14 pb-12"
      style={{ background: "#0A0E0C" }}>

      {/* Explicit back button — this page has no BottomNav, so it must never be a
          dead end. Cible calculée par `useProBackTarget`, jamais l'historique :
          voir le commentaire de cette fonction. */}
      <button
        onClick={() => navigate(backTo)}
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
        <div className="px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-widest mb-3"
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

          {/* Sélecteur de cadence. Absent tant que le serveur n'annonce pas de
              tarif annuel — voir `yearlyAvailable`. */}
          {yearlyAvailable && (
            <div role="radiogroup" aria-label={t("pro.billingPeriod")}
              className="flex gap-1 p-1 rounded-xl mb-4"
              style={{ background: "rgba(255,255,255,0.05)" }}>
              {(["monthly", "yearly"] as BillingPeriod[]).map((p) => (
                <button
                  key={p}
                  role="radio"
                  aria-checked={period === p}
                  onClick={() => setPeriod(p)}
                  className="flex-1 py-2 rounded-lg text-xs font-bold transition-colors tap-44"
                  style={period === p
                    ? { background: ACCENT, color: "#0A0E0C" }
                    : { color: MUTED, background: "transparent" }}
                >
                  {t(p === "yearly" ? "pro.planYearly" : "pro.planMonthly")}
                </button>
              ))}
            </div>
          )}

          <div className="flex items-end justify-center gap-1 mb-1">
            <span className="text-4xl font-bold" style={{ color: ACCENT }}>
              {formatPrice(isYearly ? PRICE_YEARLY : PRICE_MONTHLY, lang)}
            </span>
            <span className="text-sm mb-1" style={{ color: MUTED }}>
              {CURRENCY} {t(isYearly ? "pro.perYear" : "pro.perMonth")}
            </span>
          </div>

          {/* Sur le mensuel on montre l'économie de l'annuel (argument d'achat) ;
              sur l'annuel on ramène le prix au mois, la seule comparaison que le
              lecteur veut faire à cet instant. */}
          {yearlyAvailable && (
            <div className="text-xs" style={{ color: MUTED }}>
              {isYearly
                ? t("pro.yearlyNote")
                : t("pro.annualNote", { price: `${formatPrice(PRICE_YEARLY, lang)} ${CURRENCY}` })}
            </div>
          )}

          {trialAvailable && (
            <div className="text-[11px] font-semibold mt-2" style={{ color: ACCENT }}>
              {t(isYearly ? "pro.trialNoteYearly" : "pro.trialNote")}
            </div>
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
            <Check size={15} strokeWidth={3} className="mt-0.5 shrink-0" style={{ color: ACCENT }} />
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

      {/* La ligne « Mode démo : le paiement Stripe n'est pas encore branché »
          vivait ici et s'affichait à TOUT LE MONDE en production, sous le bouton
          d'abonnement. En production Stripe EST configuré (sinon /checkout rend
          un 501), donc le message était faux ; et faux ou vrai, annoncer à un
          visiteur que le paiement n'est pas branché sur la page qui lui demande
          de payer est ce qui fait passer un produit pour un prototype.
          Clé `pro.devNote` supprimée du dictionnaire avec ce rendu. */}
    </div>
  );
}
