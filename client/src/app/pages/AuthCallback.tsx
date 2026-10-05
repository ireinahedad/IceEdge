import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../context/AuthContext";
import { decodeJwtPayload } from "../services/jwt";

/**
 * AuthCallback
 * Landed here after server redirects from Google OAuth:
 *   /auth/callback#access_token=...
 * (The refresh token was set as an httpOnly cookie by the server.)
 * Reads the access token, calls setSession, then sends user to /profile.
 *
 * ── Pourquoi le FRAGMENT ────────────────────────────────────────────────────
 * Un fragment n'est jamais envoyé au serveur : il n'entre ni dans les journaux
 * d'accès, ni dans l'en-tête `Referer` des sous-ressources de cette page, ni
 * dans l'URL que Sentry attache à chaque événement. Avec l'ancien
 * `?access_token=`, un jeton valide 15 minutes se retrouvait dans les trois.
 * Il reste l'historique du navigateur, d'où le `history.replaceState` ci-dessous.
 */
export function AuthCallback() {
  const navigate = useNavigate();
  const { setSession } = useAuth();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    // Le fragment SEULEMENT. Le repli `?access_token=` (fenêtre de déploiement
    // client/serveur) a été retiré le 2026-10-05 : le serveur n'envoie plus que
    // le fragment (`auth.routes.ts`), et un jeton en query string finirait de
    // nouveau dans les journaux, le `Referer` et Sentry.
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const access_token = hash.get("access_token");

    // Effacer AVANT tout le reste : à partir d'ici l'URL affichée, celle que
    // l'historique retient et celle que lira une capture d'erreur ne portent
    // plus de jeton. `replaceState` ne crée pas d'entrée d'historique.
    if (access_token) {
      try {
        window.history.replaceState(null, "", window.location.pathname);
      } catch { /* contexte sans history : le beforeSend de Sentry reste */ }
    }

    if (!access_token) {
      navigate("/login", { replace: true });
      return;
    }

    // Decode user payload from JWT (no verification needed on client).
    // base64url, pas base64 : voir services/jwt.ts — l'ancien `atob` brut levait
    // sur certaines charges utiles et renvoyait alors vers /login, donc une
    // connexion Google qui échouait au hasard, sans message.
    const payload = decodeJwtPayload(access_token);
    if (!payload) {
      navigate("/login?error=google_failed", { replace: true });
      return;
    }

    try {
      setSession({
        tokens: { access_token, expires_in: 900 },
        // Le jeton d'accès ne contient QUE { sub, email, role } — voir
        // `signAccessToken` côté serveur. Les lignes qui lisaient ici
        // `payload.username`, `payload.first_name`, `payload.last_name` et
        // `payload.avatar_url` retombaient donc TOUJOURS sur leur valeur par
        // défaut : elles donnaient l'illusion de renseigner le profil sans
        // jamais le faire. Les valeurs vides sont explicites, et identiques à
        // ce que fait AuthContext quand il réhydrate une session au démarrage :
        // le profil complet est chargé ensuite par l'écran qui en a besoin.
        user: {
          id:         payload.sub,
          email:      payload.email,
          username:   "",
          first_name: null,
          last_name:  null,
          role:       payload.role ?? "user",
          avatar_url: null,
        },
      });
      navigate("/profile", { replace: true });
    } catch {
      navigate("/login", { replace: true });
    }
  }, [navigate, setSession]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen text-white">
      <div className="w-12 h-12 border-2 border-[#86d1ea]/30 border-t-[#86d1ea] rounded-full animate-spin mb-4" />
      <p className="text-white/50 text-sm">Signing you in…</p>
    </div>
  );
}
