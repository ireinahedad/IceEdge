/**
 * MySlipsTab.tsx
 *
 * Extrait de BetBuilderPage.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { Lock, Share2, Clock, History, Trophy, AlertCircle, RefreshCw } from "lucide-react";
import { getMySlips, settleMySlips } from "../../services/slipApiService";
import type { BetSlip } from "../../services/slipApiService";
import { shareNodeAsImage } from "../../services/shareImage";
import { useI18n } from "../../i18n";


// ─── Slip card (My Slips) ─────────────────────────────────────────────────────

function SlipCard({ slip }: { slip: BetSlip }) {
  const { t } = useI18n();
  const cardRef = useRef<HTMLDivElement>(null);
  const [sharing, setSharing] = useState(false);

  async function handleShare() {
    if (!cardRef.current) return;
    setSharing(true);
    try {
      await shareNodeAsImage(cardRef.current, `arakice-slip-${slip.id}.png`, "ArakIce");
    } catch (err) {
      console.warn("[Share] failed:", err);
    } finally {
      setSharing(false);
    }
  }

  const isPending = slip.outcome === "pending";
  const isWin = slip.outcome === "win";
  const date = new Date(slip.placedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const time = new Date(slip.placedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  const outcomeColor = isPending ? "#8a9ea6" : isWin ? "#86d1ea" : "#f87171";
  const outcomeBg    = isPending ? "bg-white/5 border-white/10" : isWin ? "bg-green-500/10 border-green-500/20" : "bg-red-500/10 border-red-500/20";
  const outcomeLabel = isPending ? t("slip.pending") : isWin ? t("slip.won") : t("slip.lost");
  const OutcomeIcon  = isPending ? Clock : isWin ? Trophy : AlertCircle;

  const combinedColor =
    (slip.combinedProbability ?? 0) >= 65 ? "#86d1ea" :
    (slip.combinedProbability ?? 0) >= 45 ? "#90C9F0" :
    (slip.combinedProbability ?? 0) >= 25 ? "#facc15" : "#f87171";

  return (
    <div ref={cardRef} className={`icy-card rounded-2xl overflow-hidden transition-all ${
      isPending ? "" : isWin ? "ring-1 ring-green-500/40" : "ring-1 ring-red-500/40"
    }`} style={{ background: "#131A12" }}>
      {/* Header row */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[10px] font-bold ${outcomeBg}`}
            style={{ color: outcomeColor }}>
            <OutcomeIcon size={10} />
            {outcomeLabel}
          </div>
          {slip.isParlay && (
            <span className="text-[9px] font-medium px-2 py-0.5 rounded-full bg-[#90C9F0]/10 text-[#90C9F0] border border-[#90C9F0]/20">
              {slip.legCount}-leg parlay
            </span>
          )}
          {!slip.isParlay && (
            <span className="text-[9px] text-[#4a6068]">Single</span>
          )}
        </div>
        <div className="text-right">
          <p className="text-[10px] text-[#4a6068]">{date} · {time}</p>
          {slip.combinedProbability != null && (
            <p className="text-sm font-black" style={{ color: combinedColor }}>
              {slip.combinedProbability}%
            </p>
          )}
        </div>
      </div>

      {/* Legs */}
      <div className="px-4 pb-3 flex flex-col gap-1.5">
        {(slip.legs as any[]).map((leg, i) => (
          <div key={i} className="flex items-center gap-2 py-1.5 border-t border-white/[0.05] first:border-0">
            {leg.subjectLogo?.startsWith("http")
              ? <img src={leg.subjectLogo} alt="" className="w-5 h-5 object-contain flex-shrink-0" />
              : <span className="text-sm flex-shrink-0">{leg.subjectLogo}</span>}
            <div className="flex-1 min-w-0">
              <p className="text-white text-[11px] font-medium truncate">{leg.subjectName}</p>
              <p className="text-[#8a9ea6] text-[9px] truncate">{leg.selection ?? leg.marketType}</p>
            </div>
            <span className="text-[10px] font-bold flex-shrink-0" style={{ color: combinedColor }}>
              {leg.probability}%
            </span>
          </div>
        ))}
      </div>

      {/* XP awarded / deducted */}
      {slip.xpAwarded > 0 && (
        <div className="mx-4 mb-3 flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
          <Trophy size={11} className="text-yellow-400" />
          <span className="text-yellow-400 text-[10px] font-bold">+{slip.xpAwarded} {t("slip.xpEarned")}</span>
        </div>
      )}
      {slip.xpAwarded < 0 && (
        <div className="mx-4 mb-3 flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-red-500/10 border border-red-500/20">
          <AlertCircle size={11} className="text-red-400" />
          <span className="text-red-400 text-[10px] font-bold">{slip.xpAwarded} XP</span>
        </div>
      )}

      {/* Pending: results are settled automatically */}
      {isPending && (
        <div className="mx-4 mb-3 flex items-center gap-1.5 px-3 py-1.5 rounded-xl icy-tile">
          <Clock size={11} className="text-[#8a9ea6]" />
          <span className="text-[#8a9ea6] text-[10px]">{t("slip.autoSettle")}</span>
        </div>
      )}

      {/* Footer: ArakIce branding (kept in the shared image) + share button (excluded) */}
      <div className="flex items-center justify-between px-4 py-2.5 border-t border-white/[0.06]">
        <span className="text-[11px] font-bold tracking-[0.14em]"
          style={{ fontFamily: "'Oswald','Arial Narrow',sans-serif", color: "#86d1ea" }}>
          ARAKICE
        </span>
        <button
          data-noshot
          onClick={handleShare}
          disabled={sharing}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-bold disabled:opacity-50 active:scale-95 transition-transform"
          style={{ background: "rgba(134,209,234,0.12)", color: "#86d1ea", border: "1px solid rgba(134,209,234,0.3)" }}
        >
          <Share2 size={11} />
          {sharing ? "…" : t("slip.sharePhoto")}
        </button>
      </div>
    </div>
  );
}

// ─── My Slips tab ─────────────────────────────────────────────────────────────

export function MySlipsTab({ user }: { user: any }) {
  const { t } = useI18n();
  const [slips, setSlips] = useState<BetSlip[]>([]);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const data = await getMySlips(100);
      setSlips(data);
    } catch (err: any) {
      setError(err.message ?? "Could not load slips");
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { load(); }, [load]);

  // Ask the server to settle pending slips against real NHL results
  async function handleCheckResults() {
    setResolving("all");
    try {
      const summary = await settleMySlips();
      if (summary.settled > 0) {
        setError(`TIER_UP:${summary.settled} slip${summary.settled > 1 ? "s" : ""} settled — ${summary.wins} won, ${summary.losses} lost`);
        setTimeout(() => setError(null), 4000);
        await load();
      } else {
        setError("TIER_UP:No finished games yet — check back later");
        setTimeout(() => setError(null), 3000);
      }
    } catch (err: any) {
      setError(err.message ?? "Failed to check results");
      setTimeout(() => setError(null), 3000);
    } finally {
      setResolving(null);
    }
  }

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4 px-6 text-center">
        <div className="w-16 h-16 rounded-full bg-[#90C9F0]/10 border border-[#90C9F0]/20 flex items-center justify-center">
          <Lock size={22} className="text-[#90C9F0]" />
        </div>
        <div>
          <p className="text-white font-bold text-sm" style={{ fontFamily: "'Merriweather', Georgia, serif" }}>{t("slip.signin")}</p>
          <p className="text-[#8a9ea6] text-xs mt-1 leading-relaxed">{t("slip.signinHint")}</p>
        </div>
      </div>
    );
  }

  const pending = slips.filter((s) => s.outcome === "pending");
  const resolved = slips.filter((s) => s.outcome !== "pending");

  return (
    <div className="flex flex-col gap-4 pb-32 pt-3">
      {/* Tier-up / error banner */}
      {error && (
        <div className={`rounded-2xl px-4 py-3 flex items-center gap-3 ${
          error.startsWith("TIER_UP:")
            ? "bg-yellow-500/10 border border-yellow-500/25"
            : "bg-red-500/10 border border-red-500/25"
        }`}>
          {error.startsWith("TIER_UP:") ? (
            <Trophy size={14} className="text-yellow-400 flex-shrink-0" />
          ) : (
            <AlertCircle size={14} className="text-red-400 flex-shrink-0" />
          )}
          <p className={`text-xs font-medium ${error.startsWith("TIER_UP:") ? "text-yellow-300" : "text-red-300"}`}>
            {error.replace("TIER_UP:", "")}
          </p>
        </div>
      )}

      {loading ? (
        <div className="flex flex-col gap-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-28 icy-tile rounded-2xl animate-pulse" />
          ))}
        </div>
      ) : slips.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
          <div className="w-16 h-16 rounded-full icy-card flex items-center justify-center">
            <History size={22} className="text-[#4a6068]" />
          </div>
          <div>
            <p className="text-white font-bold text-sm" style={{ fontFamily: "'Merriweather', Georgia, serif" }}>{t("slip.noSlips")}</p>
            <p className="text-[#8a9ea6] text-xs mt-1">{t("slip.noSlipsHint")}</p>
          </div>
        </div>
      ) : (
        <>
          {/* Active / pending */}
          {pending.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-[#90C9F0] animate-pulse" />
                  <p className="text-[#8a9ea6] text-[10px] uppercase tracking-wider font-medium">{t("slip.active")} · {pending.length}</p>
                </div>
                <button
                  onClick={handleCheckResults}
                  disabled={resolving === "all"}
                  className="flex items-center gap-1.5 text-[#90C9F0] text-[10px] font-bold border border-[#90C9F0]/30 bg-[#90C9F0]/10 px-2.5 py-1 rounded-lg active:scale-95 transition-all disabled:opacity-50"
                >
                  <RefreshCw size={11} className={resolving === "all" ? "animate-spin" : ""} />
                  {t("slip.checkResults")}
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {pending.map((s) => (
                  <SlipCard key={s.id} slip={s} />
                ))}
              </div>
            </div>
          )}

          {/* History */}
          {resolved.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <History size={12} className="text-[#4a6068]" />
                <p className="text-[#8a9ea6] text-[10px] uppercase tracking-wider font-medium">{t("slip.history")} · {resolved.length}</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {resolved.map((s) => (
                  <SlipCard key={s.id} slip={s} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
