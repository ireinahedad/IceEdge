import { useEffect } from "react";
import { useAuth } from "../context/AuthContext";
import { useSubscription } from "../context/SubscriptionContext";
import { tagUser } from "../analytics";

/** Pose les balises « connecté / gratuit / Pro » dans Clarity quand le compte change. */
export function AnalyticsBridge() {
  const { user } = useAuth();
  const { isPro, loading } = useSubscription();
  useEffect(() => {
    if (loading) return;
    tagUser(user?.id != null ? String(user.id) : null, isPro);
  }, [user?.id, isPro, loading]);
  return null;
}
