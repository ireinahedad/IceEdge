import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { useAuth } from './AuthContext';
import { apiGetSubscription, SubscriptionStatus } from '../services/subscriptionService';
import { isIOS } from '../platform';

interface SubscriptionContextValue {
  isPro:   boolean;
  status:  SubscriptionStatus | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

const SubscriptionContext = createContext<SubscriptionContextValue | null>(null);

export function SubscriptionProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [status,  setStatus]  = useState<SubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(false);

  // ⚠️ `user?.id`, pas `user`. `AuthContext` REMPLACE l'objet utilisateur quand
  // le profil arrive (enrichissement du nom et de l'avatar) : dépendre de
  // l'objet recréait `refresh`, donc relançait l'effet — `GET /subscription/me`
  // partait deux fois à chaque chargement de page, mesuré le 2026-09-16 (le
  // second à +612 ms, juste après `/users/me`). Seul un changement de COMPTE
  // doit relire l'abonnement.
  const userId = user?.id ?? null;
  const refresh = useCallback(async () => {
    if (!userId) { setStatus(null); return; }
    setLoading(true);
    try { setStatus(await apiGetSubscription()); }
    catch { setStatus(null); }
    finally { setLoading(false); }
  }, [userId]);

  // Re-check whenever the signed-in user changes.
  useEffect(() => { refresh(); }, [refresh]);

  // APPLE_PLAN Phase 5 — iOS : renvoyer au serveur les achats restés en
  // suspens (app tuée pendant l'achat, « Demander à acheter » approuvé), et
  // écouter ceux qui arrivent pendant que l'app tourne (renouvellements).
  // `isIOS` est une constante de build : ce bloc et l'import disparaissent du
  // bundle web.
  useEffect(() => {
    if (!isIOS || !userId) return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    void import('../services/appleIap').then((m) => {
      if (cancelled) return;
      stop = m.listenForAppleTransactions(() => { void refresh(); });
      void m.syncAppleTransactions().then((changed) => { if (changed && !cancelled) void refresh(); });
    });
    return () => { cancelled = true; stop?.(); };
  }, [userId, refresh]);

  // Valeur mémoïsée : un objet neuf à chaque rendu du provider re-rendait tous
  // les consommateurs (dont l'accueil) sans que rien n'ait changé.
  const value = useMemo(
    () => ({ isPro: status?.isPro ?? false, status, loading, refresh }),
    [status, loading, refresh],
  );

  return (
    <SubscriptionContext.Provider value={value}>
      {children}
    </SubscriptionContext.Provider>
  );
}

export function useSubscription() {
  const ctx = useContext(SubscriptionContext);
  if (!ctx) throw new Error('useSubscription must be used within SubscriptionProvider');
  return ctx;
}
