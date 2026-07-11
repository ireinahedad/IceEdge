import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import {
  AuthUser, AuthResult, PendingVerification,
  getAccessToken, storeTokens, clearTokens,
  apiLogin, apiRegister, apiLogout, apiLogoutAll, apiVerifyEmail,
} from '../services/authService';

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

  // Rehydrate from localStorage on mount
  useEffect(() => {
    const stored = getAccessToken();
    if (stored) {
      // Decode payload to get user info (no network call needed)
      try {
        const payload = JSON.parse(atob(stored.split('.')[1]));
        // We only have sub/email/role in the JWT; fetch full profile lazily
        setToken(stored);
        setUser({ id: payload.sub, email: payload.email, username: '', first_name: null, last_name: null, role: payload.role });
      } catch {
        clearTokens();
      }
    }
    setLoading(false);
  }, []);

  const setSession = useCallback((result: AuthResult) => {
    storeTokens(result.tokens.access_token); // refresh token lives in an httpOnly cookie
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

  return (
    <AuthContext.Provider value={{ user, token, loading, login, register, verifyEmail, logout, logoutAll, setSession }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
