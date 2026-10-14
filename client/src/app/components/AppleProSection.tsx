/**
 * AppleProSection — l'achat Pro sur iOS (APPLE_PLAN Phase 5, Guideline 3.1.1).
 *
 * Remplace sur iPhone la carte de prix Stripe, l'essai web et le code promo de
 * /pro. Chargé par `lazy()` derrière `isIOS` : absent du bundle web.
 *
 * Ce que la review d'Apple vérifie sur cet écran, et où c'est :
 *  • prix et durée venus de la boutique (`displayPrice`), jamais écrits en dur ;
 *  • ce que l'essai devient (« 7 jours gratuits, puis … ») AVANT le bouton ;
 *  • bouton « Restaurer les achats » visible ;
 *  • mention du renouvellement automatique + liens Conditions, EULA, Confidentialité ;
 *  • aucun lien ni mention d'un achat ailleurs (pas de « moins cher sur le web »).
 */
import { ReactNode, useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useAuth } from "../context/AuthContext";
import { useSubscription } from "../context/SubscriptionContext";
import { useI18n } from "../i18n";
import { AppButton } from "./AppButton";
import type { BillingPeriod, SubscriptionStatus } from "../services/subscriptionService";
import {
  AppleIapError, loadAppleProducts, manageAppleSubscription, purchaseApplePro,
  restoreApplePurchases, type StoreProduct,
} from "../services/appleIap";

const ACCENT  = "#86d1ea";
const SURFACE = "#131A12";
const BORDER  = "#283323";
const MUTED   = "#92A08A";

const APPLE_EULA = "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/";

type Products = Partial<Record<BillingPeriod, StoreProduct>>;

export default function AppleProSection({
  sub, onStatus, children,
}: {
  sub: SubscriptionStatus | null;
  onStatus: (s: SubscriptionStatus) => void;
  /** La liste des avantages, rendue entre la carte de prix et le bouton. */
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { refresh } = useSubscription();
  const { t, lang } = useI18n();

  const [products, setProducts] = useState<Products | null>(null);
  /**
   * Échec du chargement des produits, en deux cas distincts :
   *  • "empty" — StoreKit a répondu, mais sans aucun de nos produits. Ce n'est PAS le réseau :
   *    contrat « Paid Apps » pas encore actif, produits en « Missing Metadata », ID différent
   *    ou produits trop récents (docs/ios/APP_STORE_IAP_SETUP.md §1–3).
   *  • "error" — StoreKit a levé une erreur (réseau, boutique injoignable…) ; `loadErrorDetail`
   *    garde le message d'Apple pour le diagnostic.
   */
  const [loadFailed, setLoadFailed] = useState<null | "empty" | "error">(null);
  const [loadErrorDetail, setLoadErrorDetail] = useState<string | null>(null);
  const [period, setPeriod] = useState<BillingPeriod>("monthly");
  const [busy, setBusy] = useState<"buy" | "restore" | "manage" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadFailed(null);
    setLoadErrorDetail(null);
    loadAppleProducts()
      .then((p) => { setProducts(p); if (!p.monthly && p.yearly) setPeriod("yearly"); if (!p.monthly && !p.yearly) setLoadFailed("empty"); })
      .catch((err: unknown) => {
        setLoadErrorDetail(err instanceof Error ? err.message : typeof err === "string" ? err : null);
        setLoadFailed("error");
      });
  }, []);
  useEffect(load, [load]);

  const isPro = sub?.isPro ?? false;
  const appleManaged = isPro && sub?.source === "apple";
  const product = products?.[period];
  const per = t(period === "yearly" ? "pro.apple.perYearShort" : "pro.apple.perMonthShort");
  const freeTrial = !!product?.eligibleForIntroOffer && product.introOffer?.paymentMode === "freeTrial";

  function errorText(err: unknown): string {
    if (err instanceof AppleIapError) {
      if (err.code === "APPLE_OTHER_ACCOUNT") return t("pro.apple.otherAccount");
      return t("pro.apple.verifyFailed");
    }
    return err instanceof Error ? err.message : "Error";
  }

  function accepted(s: SubscriptionStatus) {
    onStatus(s);
    void refresh();
  }

  async function handleBuy() {
    if (!user) { navigate("/login?returnTo=/pro"); return; }
    if (!product) return;
    setError(null); setNotice(null); setBusy("buy");
    try {
      const out = await purchaseApplePro(period, user.id);
      if (out.kind === "success") {
        accepted(out.status);
        if (out.status.isPro) navigate("/pro/success");
      } else if (out.kind === "pending") {
        setNotice(t("pro.apple.pending"));
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleRestore() {
    if (!user) { navigate("/login?returnTo=/pro"); return; }
    setError(null); setNotice(null); setBusy("restore");
    try {
      const s = await restoreApplePurchases();
      if (s) { accepted(s); setNotice(t(s.isPro ? "pro.apple.restored" : "pro.apple.nothingToRestore")); }
      else setNotice(t("pro.apple.nothingToRestore"));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleManage() {
    setBusy("manage");
    try { await manageAppleSubscription(); }
    catch { /* feuille fermée ou indisponible : rien à signaler */ }
    finally { setBusy(null); void refresh(); }
  }

  /** Équivalent mensuel de l'annuel, dans la devise de la boutique. */
  const yearlyEquiv = (() => {
    const y = products?.yearly;
    if (!y) return null;
    try {
      return new Intl.NumberFormat(lang === "fr" ? "fr-CA" : "en-CA", { style: "currency", currency: y.currencyCode, currencyDisplay: "narrowSymbol" })
        .format(Math.floor((y.price / 12) * 100) / 100);
    } catch { return null; }
  })();

  // ── Déjà Pro ────────────────────────────────────────────────────────────
  if (isPro) {
    return (
      <>
        {children}
        {appleManaged && (
          <AppButton variant="ghost" onClick={handleManage} disabled={busy !== null} loading={busy === "manage"} fullWidth>
            {t("pro.apple.manage")}
          </AppButton>
        )}
      </>
    );
  }

  // ── Pas encore Pro ──────────────────────────────────────────────────────
  return (
    <>
      <div className="rounded-2xl p-5 mb-6 text-center" style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
        {loadFailed ? (
          <div className="flex flex-col items-center gap-3">
            <p className="text-xs" style={{ color: MUTED }}>
              {t(loadFailed === "empty" ? "pro.apple.notAvailable" : "pro.apple.unavailable")}
            </p>
            {loadFailed === "error" && loadErrorDetail && (
              <p className="text-[11px] break-words" style={{ color: MUTED, opacity: 0.7 }}>{loadErrorDetail}</p>
            )}
            <AppButton variant="secondary" onClick={load}>{t("pro.apple.retry")}</AppButton>
          </div>
        ) : !products ? (
          <div className="h-16 animate-pulse rounded-xl" style={{ background: "rgba(255,255,255,0.04)" }} />
        ) : (
          <>
            {products.monthly && products.yearly && (
              <div role="radiogroup" aria-label={t("pro.billingPeriod")}
                className="flex gap-1 p-1 rounded-xl mb-4" style={{ background: "rgba(255,255,255,0.05)" }}>
                {(["monthly", "yearly"] as BillingPeriod[]).map((p) => (
                  <button key={p} role="radio" aria-checked={period === p} onClick={() => setPeriod(p)}
                    className="flex-1 py-2 rounded-lg text-xs font-bold transition-colors tap-44"
                    style={period === p ? { background: ACCENT, color: "#0A0E0C" } : { color: MUTED, background: "transparent" }}>
                    {t(p === "yearly" ? "pro.planYearly" : "pro.planMonthly")}
                  </button>
                ))}
              </div>
            )}
            {product && (
              <>
                <div className="flex items-end justify-center gap-1 mb-1">
                  <span className="text-4xl font-bold" style={{ color: ACCENT }}>{product.displayPrice}</span>
                  <span className="text-sm mb-1" style={{ color: MUTED }}>{per}</span>
                </div>
                {period === "yearly" && yearlyEquiv && (
                  <div className="text-xs" style={{ color: MUTED }}>{t("pro.apple.yearlyEquiv", { price: yearlyEquiv })}</div>
                )}
                {freeTrial && (
                  <div className="text-[11px] font-semibold mt-2" style={{ color: ACCENT }}>
                    {t("pro.apple.trialNote", { price: product.displayPrice, per })}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>

      {children}

      {error && (
        <div className="text-red-400 text-xs text-center py-2 px-3 rounded-xl bg-red-500/10 border border-red-500/20 mb-3">{error}</div>
      )}
      {notice && (
        <div className="text-xs text-center py-2 px-3 rounded-xl mb-3" style={{ color: "#B7C4AD", background: "rgba(134,209,234,0.08)" }}>{notice}</div>
      )}

      <div className="flex flex-col gap-2">
        <AppButton onClick={handleBuy} disabled={!product || busy !== null} loading={busy === "buy"} fullWidth size="lg">
          {!user
            ? t("pro.loginPrompt")
            : freeTrial
              ? t("pro.apple.trialCta")
              : t("pro.apple.subscribe", { price: product?.displayPrice ?? "", per })}
        </AppButton>
        <AppButton variant="ghost" onClick={handleRestore} disabled={busy !== null} loading={busy === "restore"} fullWidth>
          {t("pro.apple.restore")}
        </AppButton>
      </div>

      {products && (products.monthly || products.yearly) && (
        <p className="text-[10px] leading-relaxed mt-5" style={{ color: MUTED }}>
          {t("pro.apple.legal", {
            monthly: products.monthly?.displayPrice ?? "—",
            yearly: products.yearly?.displayPrice ?? "—",
          })}
        </p>
      )}
      <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 mt-3 text-[11px]" style={{ color: ACCENT }}>
        <Link to="/terms">{t("pro.apple.terms")}</Link>
        <a href={APPLE_EULA} target="_blank" rel="noreferrer">{t("pro.apple.eula")}</a>
        <Link to="/privacy">{t("pro.apple.privacy")}</Link>
      </div>
    </>
  );
}
