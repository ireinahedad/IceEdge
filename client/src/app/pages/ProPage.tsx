import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { trackEvent } from "../analytics";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n";
import { features, isIOS } from "../platform";
import { IceedgeLogo } from "../components/brand/IceedgeLogo";
import { AppButton } from "../components/AppButton";
import {
  apiGetSubscription, apiStartCheckout, apiStartTrial, apiCancelSubscription,
  apiRedeemPromo, SubscriptionStatus, type BillingPeriod,
} from "../services/subscriptionService";

import { Check } from "lucide-react";
import {
  ProofChips, TrackRecordCard, TonightTeaser, LeaderTeaser, CompareTable, RiskReversal, Faq,
  StickyCta, SectionTitle, useAnyVisible,
} from "./pro/ProSections";
import { userErrorMessage } from "../services/errors";
import { usePostHog } from "@posthog/react";

// APPLE_PLAN Phase 5 — l'achat iOS (StoreKit). `isIOS` est une constante de
// build : sur le web, ni le composant ni le plugin Capacitor ne sont empaquetés.
const AppleProSection = isIOS ? lazy(() => import("../components/AppleProSection")) : null;
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
    // 2026-11-21 : « Tous les marchés & calendrier complet / chaque marché
    // bet365 » retiré — le calendrier et les marchés sont gratuits, et les
    // cotes viennent de DraftKings. Remplacé par ce que Pro donne vraiment.
    { title: t("pro.b.parlays.t"),  desc: t("pro.b.parlays.d") },
    // Scan masqué tant que VITE_SLIP_SCAN n'est pas « true » (features.slipScan).
    ...(features.slipScan ? [{ title: t("pro.b.scan.t"), desc: t("pro.b.scan.d") }] : []),
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
  const posthog = usePostHog();
  const backTo = useProBackTarget();
  useEffect(() => { trackEvent("pro_page_view"); }, []);

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
  const [promoOpen,  setPromoOpen]  = useState(false);
  // Les deux zones d'achat ; la barre collante ne s'affiche que si aucune
  // n'est à l'écran.
  const heroCtaRef  = useRef<HTMLDivElement>(null);
  const priceRef    = useRef<HTMLElement>(null);
  const finalCtaRef = useRef<HTMLDivElement>(null);
  const anyCtaVisible = useAnyVisible([heroCtaRef, priceRef, finalCtaRef]);

  // `user?.id` et non `user` : l'objet est remplacé quand AuthContext enrichit
  // le profil, ce qui relançait `GET /subscription/me` (audit du 2026-09-16).
  useEffect(() => {
    if (!user) return;
    apiGetSubscription().then(setSub).catch(() => {});
  }, [user?.id]);

  async function handleUpgrade() {
    trackEvent("pro_checkout_click");
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
        posthog?.capture("pro_checkout_started", { billing_period: period });
        window.location.href = result.url;         // Stripe Checkout
      } else if (result.status) {
        setSub(result.status);                     // dev activation
        if (result.status.isPro) navigate("/pro/success");
      }
    } catch (err: unknown) {
      setError(userErrorMessage(err, t("error.generic")));
    } finally {
      setLoading(false);
    }
  }

  async function handleTrial() {
    trackEvent("pro_trial_click");
    // Pas connecté : connexion, puis retour ici avec `?trial=1`, et l'essai
    // démarre tout seul (voir l'effet `autoTrial`).
    if (!user) { navigate(`/login?returnTo=${encodeURIComponent("/pro?trial=1")}`); return; }
    setError(null);
    setLoading(true);
    try {
      const status = await apiStartTrial();
      posthog?.capture("pro_trial_started");
      setSub(status);
      if (status.isPro) navigate("/pro/success");
    }
    catch (err: unknown) { setError(userErrorMessage(err, t("error.generic"))); }
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
      setPromoError(userErrorMessage(err, t("error.generic")));
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
  // 2026-11-18 : l'essai se montre AUSSI aux visiteurs non connectés (avant,
  // seulement aux connectés : un nouveau visiteur ne le voyait jamais).
  const trialAvailable = features.serverTrial && !sub?.trialUsed;

  // Retour de connexion avec `?trial=1` : l'essai démarre sans second clic.
  const autoTrial = useRef(false);
  useEffect(() => {
    if (autoTrial.current || !user || !sub || sub.trialUsed || sub.isPro) return;
    if (new URLSearchParams(window.location.search).get("trial") !== "1") return;
    autoTrial.current = true;
    void handleTrial();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, sub]);

  // Prix ramené au jour, arrondi au cent SUPÉRIEUR : « moins de 0,20 $ »
  // doit rester vrai (5,99 / 30 = 0,1997).
  const perDay = Math.ceil(((isYearly ? PRICE_YEARLY / 365 : PRICE_MONTHLY / 30)) * 100) / 100;
  const perDayLabel  = formatPrice(perDay, lang);
  const monthlyLabel = `${formatPrice(PRICE_MONTHLY, lang)}${t("pro.perMonth")}`;

  // Le bouton principal, le même en haut, sous le prix et dans la barre.
  // Essai d'abord (aucun risque) ; sinon l'achat, prix dans le libellé.
  const primary: { label: string; onClick: () => void } | null =
    trialAvailable
      ? { label: t("pro.startTrial"), onClick: () => void handleTrial() }
      : features.stripeCheckout
        ? { label: user ? t("pro.ctaPrice", { price: monthlyLabel }) : t("pro.loginPrompt"),
            onClick: () => void handleUpgrade() }
        : null;

  return (
    <div className="flex flex-col min-h-screen text-white max-w-[430px] md:max-w-5xl mx-auto w-full px-5 pt-14 pb-28"
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

      {/* Hero — la promesse (le résultat pour le parieur), pas le nom du
          produit ; puis trois preuves vérifiables, avant toute demande. */}
      <div className="flex flex-col items-center text-center mb-6">
        <button onClick={() => navigate("/")} aria-label={t("common.homeAria")}>
          <IceedgeLogo size={48} wordmark={false} className="mb-3" />
        </button>
        <div className="px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-widest mb-3"
          style={{ background: ACCENT_BG, color: ACCENT, border: `1px solid ${ACCENT_BORDER}` }}>
          ArakIce Pro
        </div>
        <h1 className="text-[26px] leading-tight font-bold mb-2" style={{ fontFamily: "'Oswald', 'Oswald Fallback', 'Arial Narrow', sans-serif" }}>
          {isPro ? "ArakIce Pro" : t("pro.hero.title")}
        </h1>
        {!isPro && <p className="text-sm" style={{ color: "#B7C4AD" }}>{t("pro.hero.sub")}</p>}
        {!isPro && <ProofChips />}
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

      {AppleProSection ? (
        <Suspense fallback={null}>
          <AppleProSection sub={sub} onStatus={setSub}>
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
          </AppleProSection>
          {/* Pro payé sur le web (Stripe) : résilier depuis l'iPhone reste
              possible — résilier n'est pas un achat. */}
          {isPro && sub?.source === "stripe" && !sub?.cancelAtPeriodEnd && (
            <AppButton variant="ghost" onClick={handleCancel} disabled={loading} loading={loading} fullWidth>
              {t("pro.cancel")}
            </AppButton>
          )}
        </Suspense>
      ) : (
        <>
      {/* ── Refonte CRO 2026-11-21 ─────────────────────────────────────────
          Ordre voulu, une hésitation par bloc (voir pro/ProSections.tsx) :
          bouton tout de suite → ce que vous ratez ce soir → gratuit vs Pro →
          preuves → prix ancré → objections. Le bouton revient sous le prix,
          et une barre collante le garde à portée entre les deux. */}
      {!isPro && primary && (
        <div ref={heroCtaRef} className="mb-7">
          <AppButton onClick={primary.onClick} disabled={loading} loading={loading} fullWidth size="lg">
            {primary.label}
          </AppButton>
          {features.stripeCheckout && (
            <p className="text-center text-[11.5px] mt-2" style={{ color: MUTED }}>
              {trialAvailable
                ? t("pro.heroThen", { price: monthlyLabel })
                : t("pro.perDayLine", { price: perDayLabel })}
            </p>
          )}
          <RiskReversal trial={trialAvailable} />
        </div>
      )}

      {error && (
        <div className="text-red-400 text-xs text-center py-2 px-3 rounded-xl bg-red-500/10 border border-red-500/20 mb-6">
          {error}
        </div>
      )}

      {isPro ? (
        /* Abonné : la liste de ce qu'il a, sans argumentaire de vente. */
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
      ) : (
        <CompareTable llmMonthlyQuota={sub?.llmMonthlyQuota} />
      )}

      {/* Price card — a price shown without a way to buy is worse than no
          price, so it travels with the checkout flag (APPLE_PLAN §7). */}
      {!isPro && features.stripeCheckout && (
        <section ref={priceRef} className="mb-8">
          <SectionTitle>{t("pro.priceTitle")}</SectionTitle>
          <div className="rounded-2xl p-5 text-center"
            style={{ background: SURFACE, border: `1px solid ${ACCENT_BORDER}` }}>

            {/* Sélecteur de cadence. Absent tant que le serveur n'annonce pas de
                tarif annuel — voir `yearlyAvailable`. Mensuel par défaut (le
                moindre engagement) ; l'annuel porte son économie en badge. */}
            {yearlyAvailable && (
              <div role="radiogroup" aria-label={t("pro.billingPeriod")}
                className="flex gap-1 p-1 rounded-xl mb-4"
                style={{ background: "rgba(255,255,255,0.05)" }}>
                {(["monthly", "yearly"] as BillingPeriod[]).map((p) => (
                  <button
                    key={p}
                    role="radio"
                    aria-checked={period === p}
                    onClick={() => { setPeriod(p); if (p === "yearly") trackEvent("pro_yearly_select"); }}
                    className="flex-1 py-2 rounded-lg text-xs font-bold transition-colors tap-44 flex items-center justify-center gap-1.5"
                    style={period === p
                      ? { background: ACCENT, color: "#0A0E0C" }
                      : { color: MUTED, background: "transparent" }}
                  >
                    {t(p === "yearly" ? "pro.planYearly" : "pro.planMonthly")}
                    {p === "yearly" && (
                      <span className="text-[9.5px] px-1.5 py-0.5 rounded-full"
                        style={period === p
                          ? { background: "rgba(10,14,12,0.15)" }
                          : { background: ACCENT_BG, color: ACCENT }}>
                        {t("pro.yearlyBadge")}
                      </span>
                    )}
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

            {/* Ancrage : le prix ramené au jour, la comparaison qui le rend
                petit ; sur l'annuel, aussi ramené au mois. */}
            <div className="text-xs" style={{ color: "#B7C4AD" }}>
              {t("pro.perDayLine", { price: perDayLabel })}
            </div>
            {/* 2026-11-21 (demande du user) : l'argument « un pari le
                rembourse », avec le rappel de jeu responsable juste dessous.
                10 $ gagnés à cote paire couvrent 5,99 $ (et 5 $/mois à l'année). */}
            <div className="text-[11.5px] mt-3 px-3 py-2 rounded-lg text-left"
              style={{ background: ACCENT_BG, color: "#F3F7F0" }}>
              {t("pro.payback")}
              <div className="text-[10.5px] mt-1" style={{ color: MUTED }}>{t("pro.payback.responsible")}</div>
            </div>
            {yearlyAvailable && (
              <div className="text-[11px] mt-1" style={{ color: MUTED }}>
                {isYearly
                  ? t("pro.yearlyNote")
                  : t("pro.annualNote", { price: `${formatPrice(PRICE_YEARLY, lang)} ${CURRENCY}` })}
              </div>
            )}

            <div ref={finalCtaRef} className="mt-5 flex flex-col gap-2 text-left">
              {trialAvailable ? (
                <>
                  <AppButton onClick={handleTrial} disabled={loading} loading={loading} fullWidth size="lg">
                    {t("pro.startTrial")}
                  </AppButton>
                  <AppButton variant="ghost" onClick={handleUpgrade} disabled={loading} loading={loading} fullWidth>
                    {t(isYearly ? "pro.ctaNowYearly" : "pro.ctaNow")}
                  </AppButton>
                </>
              ) : (
                <AppButton onClick={handleUpgrade} disabled={loading} loading={loading} fullWidth size="lg">
                  {user ? t(isYearly ? "pro.ctaNowYearly" : "pro.ctaNow") : t("pro.loginPrompt")}
                </AppButton>
              )}
              <RiskReversal trial={trialAvailable} />
            </div>
          </div>
        </section>
      )}

      {/* Preuves et « ce que vous ratez », après le tableau et le prix
          (2026-11-21, demande du user : comparer et voir le prix d'abord). */}
      {!isPro && <TrackRecordCard />}
      {!isPro && user && <TonightTeaser />}
      {!isPro && user && <LeaderTeaser />}

      {/* Essai sans paiement possible mais pas de Stripe (cas théorique) :
          le bouton du haut suffit. */}

      {!isPro && <Faq />}

      {/* CTA abonné : résiliation */}
      {isPro && !sub?.cancelAtPeriodEnd && (
        // Acheté sur iPhone : seul Apple peut l'annuler. Le serveur refuserait
        // (409 APPLE_MANAGED) ; mieux vaut dire où aller que d'afficher un
        // bouton qui échoue.
        sub?.source === "apple" ? (
          <p className="text-xs text-center" style={{ color: MUTED }}>{t("pro.apple.managedOnIphone")}</p>
        ) : (
          <AppButton variant="ghost" onClick={handleCancel} disabled={loading} loading={loading} fullWidth>
            {t("pro.cancel")}
          </AppButton>
        )
      )}

      {/* Code promo — replié : un champ « code promo » bien visible envoie les
          gens chercher un code ailleurs au lieu d'acheter (classique en CRO). */}
      {!isPro && features.promoCodes && (
        <div className="mt-2 mb-4">
          {!promoOpen ? (
            <button type="button" onClick={() => setPromoOpen(true)}
              className="text-xs underline underline-offset-2" style={{ color: MUTED }}>
              {t("pro.promo.label")}
            </button>
          ) : (
            <>
              <div className="flex gap-2">
                <input
                  value={promo}
                  onChange={(e) => { setPromo(e.target.value); setPromoError(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") handleRedeem(); }}
                  placeholder={t("pro.promo.placeholder")}
                  autoFocus
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
            </>
          )}
        </div>
      )}

      {!isPro && primary && (
        <StickyCta
          show={!anyCtaVisible}
          label={primary.label}
          sub={features.stripeCheckout ? (trialAvailable ? t("pro.sticky.trialSub") : monthlyLabel) : undefined}
          disabled={loading}
          onClick={() => { trackEvent("pro_sticky_cta_click"); primary.onClick(); }}
        />
      )}

        </>
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
