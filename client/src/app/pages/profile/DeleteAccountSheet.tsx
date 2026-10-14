/**
 * DeleteAccountSheet — suppression de compte depuis l'app (Guideline 5.1.1(v)).
 *
 * Deux étapes : l'avertissement, puis la reconfirmation. L'étape 2 ne s'ouvre
 * qu'après la réponse du serveur, qui décide de la méthode : mot de passe, ou
 * code par courriel pour un compte Google (qui n'a pas de mot de passe). Le
 * client ne devine pas — il ne sait pas quel type de compte il a en main.
 */
import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "../../toast";
import { useAuth } from "../../context/AuthContext";
import { useSubscription } from "../../context/SubscriptionContext";
import { tokenStore } from "../../services/tokenStore";
import { accountApiService, ApiError, type ReauthMethod } from "../../services/userService";
import { useI18n } from "../../i18n";

export function DeleteAccountSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const { logout } = useAuth();
  const { isPro, status: subStatus } = useSubscription();
  const navigate = useNavigate();
  const [method, setMethod] = useState<ReauthMethod | null>(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  function close() {
    if (busy) return;
    setMethod(null);
    setSecret("");
    setError(null);
    onClose();
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const r = await accountApiService.startDeletion();
      setMethod(r.method);
    } catch (e: any) {
      setError(e?.message ?? t("account.deleteFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!method || !secret.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await accountApiService.deleteAccount(method === "password" ? { password: secret } : { code: secret.trim() });
    } catch (e: any) {
      setBusy(false);
      if (e instanceof ApiError && e.code === "REAUTH_FAILED") setError(t("account.wrongPassword"));
      else if (e instanceof ApiError && e.status === 400) setError(t("account.wrongCode"));
      // 502 (Stripe) et le reste : le message serveur dit déjà que rien n'a été supprimé.
      else setError(e instanceof ApiError && e.status < 500 ? t("account.deleteFailed") : (e?.message ?? t("account.deleteFailed")));
      return;
    }
    // Le compte n'existe plus : ses jetons non plus. `logout` peut échouer sur
    // un jeton déjà effacé — la session locale doit tomber quand même.
    try { await logout(); } catch { await tokenStore.clear(); }
    toast.success(t("account.deleted"));
    navigate("/", { replace: true });
  }

  const fieldCls =
    "w-full bg-black/20 border border-white/15 rounded-lg px-3 py-2.5 text-white text-sm placeholder-white/25 outline-none focus:border-red-400/60 transition-colors";

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center" onClick={close}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-account-title"
        className="relative w-full max-w-[430px] md:max-w-lg icy-card rounded-t-3xl p-6 pb-nav-safe"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-5" />
        <p id="delete-account-title" className="text-white font-bold text-base mb-1.5">{t("account.deleteTitle")}</p>
        <p className="text-white/60 text-xs mb-2">{t("account.deleteWhat")}</p>
        {isPro && (
          <p className="text-white/60 text-xs mb-2">
            {/* Un abonnement Apple ne s'annule pas avec le compte (APPLE_PLAN 6.4) :
                le serveur n'a aucun moyen de l'arrêter. */}
            {t(subStatus?.source === "apple" ? "account.deleteSubApple" : "account.deleteSub")}
          </p>
        )}

        {method && (
          <form
            className="flex flex-col gap-2 mt-3"
            onSubmit={(e) => { e.preventDefault(); void confirm(); }}
          >
            <label className="text-white/70 text-xs" htmlFor="delete-account-secret">
              {method === "password" ? t("account.passwordPrompt") : t("account.codePrompt")}
            </label>
            <input
              id="delete-account-secret"
              className={fieldCls}
              type={method === "password" ? "password" : "text"}
              inputMode={method === "code" ? "numeric" : undefined}
              autoComplete={method === "password" ? "current-password" : "one-time-code"}
              maxLength={method === "code" ? 6 : undefined}
              placeholder={method === "password" ? t("account.password") : t("account.code")}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoFocus
            />
          </form>
        )}

        {error && <p className="text-red-400 text-[11px] mt-2" role="alert">{error}</p>}

        <div className="flex gap-2 mt-5">
          <button
            onClick={close}
            disabled={busy}
            className="flex-1 py-3 rounded-2xl border border-white/10 text-white/70 text-sm disabled:opacity-50"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={method ? confirm : start}
            disabled={busy || (!!method && !secret.trim())}
            className="flex-1 py-3 rounded-2xl text-sm font-bold bg-red-500 text-white disabled:opacity-50"
          >
            {busy ? (method ? t("account.deleting") : "…") : method ? t("account.deleteForever") : t("account.deleteContinue")}
          </button>
        </div>
      </div>
    </div>
  );
}
