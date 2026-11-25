import { createContext, useContext, useState, useCallback } from "react";
import type { ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";
import { useAuth } from "./AuthContext";
import { useI18n } from "../i18n";
import { AppButton } from "../components/AppButton";

import { Lock } from "lucide-react";
/**
 * AuthGate — lets signed-out visitors browse the app while blocking any action
 * that writes data (posting a message, creating/joining a room, reacting, …).
 *
 * Usage inside a component:
 *   const { requireAuth } = useAuthGate();
 *   function handleSend() {
 *     if (!requireAuth("gate.sendMessage")) return; // shows the popup for guests
 *     …proceed…
 *   }
 *
 * `requireAuth(actionKey)` returns true when the user is signed in (the caller
 * proceeds). For guests it returns false and opens a modal — "You need to be
 * connected to <action>" — with a button that routes to the login page.
 *
 * « Se connecter » mène à /login avec `returnTo` : après la connexion, le
 * visiteur revient là où il était (2026-11-25), ou sur la page qu'il voulait
 * ouvrir quand l'appelant la passe en second argument (onglets de BottomNav).
 *
 * Mounted once from the router's RootLayout so a single modal instance serves
 * the whole app. Must sit inside <AuthProvider> and the router (uses useNavigate).
 */

interface AuthGateValue {
  /**
   * True if signed in. If not, opens the login prompt and returns false.
   * `returnTo` : chemin interne où revenir après la connexion (par défaut, la
   * page courante).
   */
  requireAuth: (actionKey: string, returnTo?: string) => boolean;
}

const AuthGateContext = createContext<AuthGateValue | null>(null);

export function AuthGateProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const [gate, setGate] = useState<{ key: string; returnTo?: string } | null>(null);
  const actionKey = gate?.key ?? null;

  const requireAuth = useCallback((key: string, returnTo?: string) => {
    if (user) return true;
    setGate({ key, returnTo });
    return false;
  }, [user]);

  const close = useCallback(() => setGate(null), []);

  const goToLogin = useCallback(() => {
    // Toujours un chemin interne : soit celui de l'appelant (une route de
    // l'app), soit la page courante.
    const target = gate?.returnTo ?? location.pathname + location.search;
    setGate(null);
    navigate(`/login?returnTo=${encodeURIComponent(target)}`);
  }, [navigate, gate, location.pathname, location.search]);

  return (
    <AuthGateContext.Provider value={{ requireAuth }}>
      {children}

      {actionKey && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center px-6"
          onClick={close}
          role="dialog"
          aria-modal="true"
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div
            className="relative w-full max-w-[360px] icy-card rounded-3xl p-6 text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex justify-center text-[#86d1ea]"><Lock size={28} /></div>
            <p className="text-white font-bold text-base mb-1">{t("gate.title")}</p>
            <p className="text-white/60 text-xs mb-5">
              {t("gate.message", { action: t(actionKey) })}
            </p>
            <div className="flex flex-col gap-2">
              <AppButton variant="primary" onClick={goToLogin} fullWidth>
                {t("gate.signIn")}
              </AppButton>
              <AppButton variant="ghost" onClick={close} fullWidth>
                {t("common.cancel")}
              </AppButton>
            </div>
          </div>
        </div>
      )}
    </AuthGateContext.Provider>
  );
}

export function useAuthGate() {
  const ctx = useContext(AuthGateContext);
  if (!ctx) throw new Error("useAuthGate must be used within AuthGateProvider");
  return ctx;
}
