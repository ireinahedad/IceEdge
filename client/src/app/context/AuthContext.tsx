import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import {
  AuthUser, AuthResult, PendingVerification,
  apiLogin, apiRegister, apiLogout, apiLogoutAll, apiVerifyEmail,
} from '../services/authService';
import { tokenStore, onSessionCleared } from '../services/tokenStore';
import { decodeJwtPayload } from '../services/jwt';
import { profileApiService } from '../services/userService';

interface AuthContextValue {
  user:        AuthUser | null;
  token:       string   | null;
  loading:     boolean;
  login:       (email: string, password: string, remember?: boolean) => Promise<void>;
  register:    (email: string, username: string, password: string, firstName?: string) => Promise<PendingVerification | AuthResult>;
  verifyEmail: (email: string, code: string) => Promise<void>;
  logout:      () => Promise<void>;
  logoutAll:   () => Promise<void>;            // revoke every device's session
  setSession:  (result: AuthResult) => void;   // used by AuthCallback after Google OAuth
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user,    setUser]    = useState<AuthUser | null>(null);
  const [token,   setToken]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Rehydrate from the token store on mount. Async since R3.6: the native
  // store is promise-based, and `loading` already covers the gap — the router
  // waits for it before deciding whether to send anyone to /login.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const stored = await tokenStore.getAccess();
      if (cancelled) return;

      if (stored) {
        // Decode payload to get user info (no network call needed)
        // base64url, pas base64 : voir services/jwt.ts. L'ancien `atob` brut
        // levait sur certaines charges utiles et le `catch` effaçait alors la
        // session — une déconnexion aléatoire au démarrage.
        const payload = decodeJwtPayload(stored);
        if (payload) {
          // Le jeton ne porte que sub/email/role. `username: ''` et l'absence
          // d'`avatar_url` sont donc un état PROVISOIRE — l'écran complet
          // arrive par `hydrateProfile()` juste en dessous.
          setToken(stored);
          setUser({ id: payload.sub, email: payload.email, username: '', first_name: null, last_name: null, role: payload.role ?? 'user' });
        } else {
          await tokenStore.clear();
        }
      }
      if (!cancelled) setLoading(false);
    })();

    return () => { cancelled = true; };
  }, []);

  /**
   * Compléter l'utilisateur réhydraté avec son profil serveur.
   *
   * Le JWT ne contient ni le pseudo ni l'avatar, et rien ne les rechargeait :
   * **l'avatar disparaissait de la barre de navigation à chaque rechargement
   * de page**, remplacé par l'icône générique, et le pseudo restait vide. Ça se
   * réparait tout seul dès qu'on ouvrait la page Profil — ce qui rendait le
   * défaut d'autant plus déroutant.
   *
   * ⚠️ Déclenché par `token`, PAS par `user` : `setUser` plus bas remettrait
   * l'effet en marche à chaque fois qu'il écrit, donc en boucle. Le jeton, lui,
   * ne change qu'à une vraie transition de session.
   *
   * ⚠️ Un échec est ignoré volontairement. `login()` et `setSession()`
   * renseignent déjà l'utilisateur complet ; ici on ne fait qu'enrichir. Un
   * réseau coupé au démarrage ne doit ni déconnecter, ni afficher une erreur
   * pour un avatar.
   */
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    profileApiService.getProfile()
      .then((p) => {
        if (cancelled) return;
        setUser((u) => (u ? {
          ...u,
          username:   p.username || u.username,
          avatar_url: p.avatarUrl ?? u.avatar_url ?? null,
        } : u));
      })
      .catch(() => { /* enrichissement seulement — voir plus haut */ });

    return () => { cancelled = true; };
  }, [token]);

  /**
   * R3.8 — the session can end without anyone here asking for it: a refresh
   * fails, the store clears itself, and until now the UI carried on believing
   * it was signed in and rendered 401s. Dropping the user is enough to fix it —
   * the app is browsable signed-out, and `Protected` already redirects to
   * /login (with returnTo) for the pages that do need an account. No forced
   * navigation from here, so nobody gets bounced off /stats.
   */
  useEffect(() => onSessionCleared(() => {
    setUser(null);
    setToken(null);
  }), []);

  const setSession = useCallback((result: AuthResult) => {
    // On web the refresh token is not in this payload — it is in the httpOnly
    // cookie, and the store drops the argument. Native gets it here.
    void tokenStore.setTokens(result.tokens.access_token, result.tokens.refresh_token);
    setToken(result.tokens.access_token);
    setUser(result.user);
  }, []);

  const login = useCallback(async (email: string, password: string, remember = false) => {
    const result = await apiLogin(email, password, remember);
    setSession(result);
  }, [setSession]);

  // Register no longer logs in — it returns a pending state; the user must
  // confirm the emailed code via verifyEmail() before a session is created.
  const register = useCallback(async (email: string, username: string, password: string, firstName?: string) => {
    const result = await apiRegister(email, username, password, firstName);
    // If the server bypassed verification, it returns a full session → log in.
    if ('tokens' in result) setSession(result);
    return result;
  }, [setSession]);

  const verifyEmail = useCallback(async (email: string, code: string) => {
    const result = await apiVerifyEmail(email, code);
    setSession(result);
  }, [setSession]);

  const logout = useCallback(async () => {
    await apiLogout();
    setUser(null);
    setToken(null);
  }, []);

  const logoutAll = useCallback(async () => {
    await apiLogoutAll();
    setUser(null);
    setToken(null);
  }, []);

  // Valeur mémoïsée : sans ça, chaque rendu du provider donnait un objet neuf à
  // tous les `useAuth()` de l'application.
  const value = useMemo(
    () => ({ user, token, loading, login, register, verifyEmail, logout, logoutAll, setSession }),
    [user, token, loading, login, register, verifyEmail, logout, logoutAll, setSession],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
