import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router";
import { getMySlips, BetSlip } from "../services/slipApiService";
import { BottomNav } from "./BottomNav";
import { useSport } from "../context/SportContext";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function probToOddsLabel(prob: number): string {
  if (prob <= 0 || prob >= 100) return "N/A";
  if (prob >= 50) {
    const odds = -Math.round((prob / (100 - prob)) * 100);
    return `${odds}`;
  }
  const odds = Math.round(((100 - prob) / prob) * 100);
  return `+${odds}`;
}

function outcomeColor(outcome: BetSlip["outcome"]): string {
  if (outcome === "win") return "#4ade80";
  if (outcome === "loss") return "#f87171";
  return "#bfc8cc";
}

function outcomeLabel(outcome: BetSlip["outcome"]): string {
  if (outcome === "win") return "✓ Won";
  if (outcome === "loss") return "✗ Lost";
  return "Pending";
}

// ─── Share page ───────────────────────────────────────────────────────────────

export function SharePage() {
  const { slipId } = useParams<{ slipId: string }>();
  const navigate = useNavigate();
  const { theme } = useSport();
  const accent = theme.accent;

  const [slip, setSlip] = useState<BetSlip | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!slipId) { setError("No slip ID provided."); setLoading(false); return; }
    getMySlips(100)
      .then((slips) => {
        const found = slips.find((s) => s.id === slipId);
        if (!found) { setError("Slip not found. Make sure you're logged in."); }
        else { setSlip(found); }
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message ?? "Failed to load slip.");
        setLoading(false);
      });
  }, [slipId]);

  async function handleShare() {
    const url = window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({
          title: "My ICEEDGE Bet Slip",
          text: slip
            ? `${slip.legCount}-leg parlay · ${slip.combinedProbability ?? "—"}% · ${outcomeLabel(slip.outcome)}`
            : "Check out my bet slip on ICEEDGE",
          url,
        });
      } catch { /* user cancelled */ }
    } else {
      await navigator.clipboard.writeText(url).catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  if (loading) return (
    <div className="flex flex-col min-h-screen bg-transparent text-white items-center justify-center max-w-[430px] mx-auto relative z-10">
      <div className="w-12 h-12 rounded-full bg-[#111a1f] border border-white/20 flex items-center justify-center">
        <div className="w-5 h-5 rounded-full animate-pulse" style={{ backgroundColor: `${accent}40`, borderColor: accent }} />
      </div>
      <p className="text-[#bfc8cc] text-sm mt-3">Loading slip...</p>
      <BottomNav />
    </div>
  );

  if (error || !slip) return (
    <div className="flex flex-col min-h-screen bg-transparent text-white items-center justify-center max-w-[430px] mx-auto relative z-10 px-6">
      <span className="text-4xl mb-4">🔒</span>
      <p className="text-white text-sm font-medium text-center mb-1">Slip not accessible</p>
      <p className="text-[#bfc8cc] text-xs text-center mb-6">{error ?? "This slip may belong to another account."}</p>
      <button onClick={() => navigate("/bet")} className="px-5 py-2.5 rounded-2xl text-sm font-semibold"
        style={{ backgroundColor: accent, color: "#0a1014" }}>
        Go to Bet Builder
      </button>
      <BottomNav />
    </div>
  );

  const prob = slip.combinedProbability ?? (slip.legs.length === 1 ? slip.legs[0].probability : null);
  const placedDate = new Date(slip.placedAt).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  const sportLabel = slip.sport === "tennis" ? "🎾 Tennis" : "🏒 NHL Hockey";

  return (
    <div className="flex flex-col min-h-screen bg-transparent text-white max-w-[430px] mx-auto relative z-10">
      <header className="px-4 pt-12 pb-4 bg-[#0a1014]/80 backdrop-blur-md sticky top-0 z-40 border-b border-white/[0.04]">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="w-8 h-8 rounded-xl bg-[#111a1f] border border-white/20 flex items-center justify-center text-[#bfc8cc]">
            ‹
          </button>
          <div className="flex-1">
            <h1 className="text-white text-lg font-bold" style={{ fontFamily: "'Merriweather', Georgia, serif" }}>Bet Slip</h1>
            <p className="text-[#bfc8cc] text-xs">{sportLabel} · {placedDate}</p>
          </div>
          <div className="px-2.5 py-1 rounded-full text-xs font-semibold"
            style={{ backgroundColor: `${outcomeColor(slip.outcome)}20`, color: outcomeColor(slip.outcome) }}>
            {outcomeLabel(slip.outcome)}
          </div>
        </div>
      </header>

      <div className="flex-1 px-4 pt-4 pb-28 overflow-y-auto flex flex-col gap-4">

        {/* Summary card */}
        <div className="bg-[#111a1f]/70 backdrop-blur-md border border-white/20 rounded-2xl p-5 flex flex-col items-center gap-3">
          <div className="w-16 h-16 rounded-full flex items-center justify-center text-3xl font-black"
            style={{ backgroundColor: `${accent}20`, border: `2px solid ${accent}60` }}>
            {prob !== null ? `${prob}%` : "?"}
          </div>
          <div className="text-center">
            <p className="text-white text-base font-bold">{slip.legCount}-Leg {slip.isParlay ? "Parlay" : "Single"}</p>
            {prob !== null && (
              <p className="text-[#bfc8cc] text-xs mt-0.5">
                Implied odds: <span className="font-semibold text-white">{probToOddsLabel(prob)}</span>
              </p>
            )}
          </div>
          {slip.outcome === "win" && slip.xpAwarded > 0 && (
            <div className="px-3 py-1.5 rounded-full text-xs font-semibold bg-green-500/15 text-green-400">
              +{slip.xpAwarded} XP earned
            </div>
          )}
        </div>

        {/* Legs */}
        <div className="flex flex-col gap-2">
          <p className="text-[#bfc8cc] text-xs uppercase tracking-wider font-medium">Selections</p>
          {slip.legs.map((leg, i) => (
            <div key={i} className="bg-[#111a1f]/70 backdrop-blur-md border border-white/20 rounded-2xl p-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-[#1a2a2f] flex items-center justify-center text-xl flex-shrink-0">
                {leg.subjectLogo}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-white text-sm font-medium truncate">{leg.subjectName}</p>
                <p className="text-[#bfc8cc] text-xs truncate">{leg.selection ?? leg.marketType}</p>
              </div>
              <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
                <span className="text-sm font-bold" style={{ color: accent }}>{leg.probability}%</span>
                <span className="text-[#8a9ea6] text-[10px]">{leg.oddsLabel}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Share button */}
        <button
          onClick={handleShare}
          className="w-full py-3.5 rounded-2xl text-sm font-bold transition-all active:scale-[0.98]"
          style={{ backgroundColor: accent, color: "#0a1014" }}
        >
          {copied ? "Link copied!" : "Share Slip"}
        </button>

        <button
          onClick={() => navigate("/bet")}
          className="w-full py-3 rounded-2xl text-sm font-medium border border-white/20 text-[#bfc8cc] transition-all active:scale-[0.98]"
        >
          Build a New Slip
        </button>
      </div>

      <BottomNav />
    </div>
  );
}
