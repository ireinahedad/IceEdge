import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../context/AuthContext";

/**
 * AuthCallback
 * Landed here after server redirects from Google OAuth:
 *   /auth/callback?access_token=...&refresh_token=...
 * Reads the tokens, calls setSession, then sends user to /profile.
 */
export function AuthCallback() {
  const navigate = useNavigate();
  const { setSession } = useAuth();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const params = new URLSearchParams(window.location.search);
    const access_token  = params.get("access_token");
    const refresh_token = params.get("refresh_token");

    if (!access_token || !refresh_token) {
      navigate("/login", { replace: true });
      return;
    }

    try {
      // Decode user payload from JWT (no verification needed on client)
      const payload = JSON.parse(atob(access_token.split(".")[1]));
      setSession({
        tokens: { access_token, refresh_token, expires_in: 900 },
        user: {
          id:         payload.sub,
          email:      payload.email,
          username:   payload.username ?? "",
          first_name: payload.first_name ?? null,
          last_name:  payload.last_name  ?? null,
          role:       payload.role       ?? "user",
          avatar_url: payload.avatar_url ?? null,
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
