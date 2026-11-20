import { useEffect } from "react";
import { useAuth } from "../context/AuthContext";
import { useSubscription } from "../context/SubscriptionContext";
import { sendSignupAttribution, tagUser } from "../analytics";

/** Pose les balises « connecté / gratuit / Pro » dans Clarity quand le compte change. */
export function AnalyticsBridge() {
  const { user } = useAuth();
  const { isPro, loading } = useSubscription();
  useEffect(() => {
    if (loading) return;
    tagUser(user?.id != null ? String(user.id) : null, isPro);
    // Provenance du compte en base (migration 055) — sans effet pour un vieux compte.
    if (user?.id != null) sendSignupAttribution(String(user.id));
  }, [user?.id, isPro, loading]);
  return null;
}
