import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import {
  AuthUser, AuthResult, PendingVerification,
  getAccessToken, storeTokens, clearTokens,
  apiLogin, apiRegister, apiLogout, apiVerifyEmail,
} from '../services/authService';

interface AuthContextValue {
  user:        AuthUser | null;
  token:       string   | null;
  loading:     boolean;
  login:       (email: string, password: string) => Promise<void>;
  register:    (email: string, username: string, password: string, firstName?: string) => Promise<PendingVerification>;
  verifyEmail: (email: string, code: string) => Promise<void>;
  logout:      () => Promise<void>;
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

  const login = useCallback(async (email: string, password: string) => {
    const result = await apiLogin(email, password);
    setSession(result);
  }, [setSession]);

  // Register no longer logs in — it returns a pending state; the user must
  // confirm the emailed code via verifyEmail() before a session is created.
  const register = useCallback(async (email: string, username: string, password: string, firstName?: string) => {
    return apiRegister(email, username, password, firstName);
  }, []);

  const verifyEmail = useCallback(async (email: string, code: string) => {
    const result = await apiVerifyEmail(email, code);
    setSession(result);
  }, [setSession]);

  const logout = useCallback(async () => {
    await apiLogout();
    setUser(null);
    setToken(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, loading, login, register, verifyEmail, logout, setSession }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
