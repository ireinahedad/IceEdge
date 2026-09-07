/**
 * ModerationQueuePage — la file de modération du chat.
 * Route : /dev/moderation   (admin uniquement, comme /dev/ml)
 *
 * PRE_IOS_PLAN.md R4.2h-UI. Guideline 1.2 ne demande pas seulement qu'un
 * mécanisme de signalement existe : elle demande le PROCESSUS de réponse. Une
 * file qu'on ne peut lire qu'en ligne de commande n'est pas un processus.
 *
 * Écran séparé plutôt qu'un sixième onglet dans DevMLDashboard : ce fichier fait
 * déjà 1500 lignes et parle de modèles, pas de personnes. Le langage visuel est
 * repris, la page ne l'est pas.
 *
 * Une entrée = un MESSAGE, pas un signalement : le serveur regroupe (R4.2h), et
 * trancher agit sur tous les signalements ouverts du message d'un coup.
 *
 * Endpoints : GET /dev/reports · POST /dev/reports/:id
 */

import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { useAuth } from "../context/AuthContext";
import { profileApiService } from "../services/userService";
import type { ModerationQueueItem } from "../types/user";

const REASON_STYLE: Record<string, string> = {
  spam:       "bg-white/5 text-white/60 border-white/10",
  harassment: "bg-orange-500/15 text-orange-400 border-orange-500/30",
  hate:       "bg-red-500/15 text-red-400 border-red-500/30",
  sexual:     "bg-purple-500/15 text-purple-300 border-purple-500/30",
  other:      "bg-white/5 text-white/60 border-white/10",
};

function when(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

export function ModerationQueuePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [items, setItems] = useState<ModerationQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<number | null>(null);

  // Le serveur refuse déjà tout non-admin (403). Ce renvoi n'est pas une
  // sécurité, c'est de la courtoisie : éviter une page d'erreur à qui arrive
  // là par un lien.
  useEffect(() => {
    if (user && user.role !== "admin") navigate("/", { replace: true });
  }, [user, navigate]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { reports } = await profileApiService.getModerationQueue();
      setItems(reports);
    } catch (e: any) {
      setError(e?.message ?? "Could not load the moderation queue");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function decide(item: ModerationQueueItem, status: "actioned" | "dismissed") {
    setActing(item.reportId);
    try {
      const res = await profileApiService.reviewReport(item.reportId, status);
      // Retiré de la liste : le serveur ne rend que les signalements OUVERTS,
      // donc un rechargement le ferait disparaître de toute façon.
      setItems((prev) => prev.filter((i) => i.reportId !== item.reportId));
      toast.success(
        status === "actioned"
          ? `Message hidden · ${res.reportsUpdated} report(s) closed`
          : res.hidden
            ? `Dismissed · ${res.reportsUpdated} report(s) closed (message stays hidden by an admin)`
            : `Dismissed · ${res.reportsUpdated} report(s) closed, message restored`,
      );
    } catch (e: any) {
      toast.error(e?.message ?? "Could not record the decision");
    } finally {
      setActing(null);
    }
  }

  return (
    <div className="flex flex-col min-h-screen text-white max-w-[900px] mx-auto px-5 pt-14 pb-16" style={{ background: "#0A0E0C" }}>
      <div className="flex items-center gap-3 mb-2">
        <button onClick={() => navigate(-1)} className="tap-44 text-[#bfc8cc] text-lg">←</button>
        <h1 className="text-white text-base font-bold flex-1">Moderation queue</h1>
        <button
          onClick={() => void load()}
          className="text-[#86d1ea] text-[11px] font-semibold border border-[#86d1ea]/30 rounded-lg px-3 py-1.5"
        >
          Refresh
        </button>
      </div>
      <p className="text-white/40 text-[10px] mb-6">
        Open reports, grouped by message, newest first. Acting closes every open report on that
        message. <span className="text-white/60">Actioned</span> hides it; <span className="text-white/60">dismissed</span> restores
        it if it was hidden automatically.
      </p>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2 mb-4">
          <p className="text-red-400 text-[11px]">{error}</p>
        </div>
      )}

      {loading ? (
        <div className="flex flex-col gap-3">
          {[1, 2, 3].map((i) => <div key={i} className="h-28 bg-white/5 rounded-2xl animate-pulse" />)}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-2">
          <span className="text-3xl">✅</span>
          <p className="text-white text-sm font-medium">Nothing to review</p>
          <p className="text-white/40 text-[11px]">No open reports right now.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item) => (
            <div key={item.reportId} className="icy-card rounded-2xl p-4 flex flex-col gap-2.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-white text-xs font-bold">
                  {item.reportCount} report{item.reportCount > 1 ? "s" : ""}
                </span>
                {item.reasons.map((r) => (
                  <span key={r} className={`text-[9px] px-1.5 py-0.5 rounded-full border ${REASON_STYLE[r] ?? REASON_STYLE.other}`}>
                    {r}
                  </span>
                ))}
                {item.hiddenAt && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full border bg-white/5 text-white/50 border-white/10">
                    hidden · {item.hiddenReason}
                  </span>
                )}
                <span className="text-white/30 text-[9px] ml-auto">{when(item.lastReportedAt)}</span>
              </div>

              <div className="chat-tile rounded-xl px-3 py-2">
                <p className="text-[#90C9F0] text-[10px] font-medium mb-0.5">
                  @{item.authorUsername ?? "deleted account"}
                  <span className="text-white/30"> · {item.roomName ?? item.roomId} · {when(item.sentAt)}</span>
                </p>
                <p className="text-white/80 text-xs whitespace-pre-wrap break-words">{item.text}</p>
              </div>

              {item.notes.length > 0 && (
                <div className="flex flex-col gap-1">
                  {item.notes.map((n, i) => (
                    <p key={i} className="text-white/50 text-[10px] pl-2 border-l border-white/10">“{n}”</p>
                  ))}
                </div>
              )}

              <div className="flex gap-2 mt-1">
                <button
                  onClick={() => void decide(item, "dismissed")}
                  disabled={acting === item.reportId}
                  className="flex-1 py-2 rounded-xl border border-white/10 text-white/70 text-[11px] disabled:opacity-50"
                >
                  Dismiss
                </button>
                <button
                  onClick={() => void decide(item, "actioned")}
                  disabled={acting === item.reportId}
                  className="flex-1 py-2 rounded-xl bg-red-500 text-white text-[11px] font-bold disabled:opacity-50"
                >
                  Hide message
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
