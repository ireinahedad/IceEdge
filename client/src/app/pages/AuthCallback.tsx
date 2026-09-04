import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../context/AuthContext";
import { decodeJwtPayload } from "../services/jwt";

/**
 * AuthCallback
 * Landed here after server redirects from Google OAuth:
 *   /auth/callback?access_token=...
 * (The refresh token was set as an httpOnly cookie by the server.)
 * Reads the access token, calls setSession, then sends user to /profile.
 */
export function AuthCallback() {
  const navigate = useNavigate();
  const { setSession } = useAuth();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const params = new URLSearchParams(window.location.search);
    const access_token = params.get("access_token");

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
