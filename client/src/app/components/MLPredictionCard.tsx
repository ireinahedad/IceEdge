/**
 * MLPredictionCard — reusable component showing ML model output.
 *
 * Used in:
 *   - PredictionPage (team / player / game / futures handlers)
 *   - NHLPredictionsPage (per-market chip)
 *
 * If the Python ML service is down, the card is simply not rendered
 * (the parent MLSection component receives null and returns null).
 */
import { useEffect, useState } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MLFeatureImportance {
  name:       string;
  importance: number;
  direction:  "positive" | "negative";
}

export interface MLPredictionResult {
  probability:         number;
  confidence:          number;
  feature_importances: MLFeatureImportance[];
  model_version:       string;
  model_type:          string;
  explanation:         string;
}

// ── Mini animated gauge (violet theme) ───────────────────────────────────────

function MLGauge({ pct }: { pct: number }) {
  const [displayed, setDisplayed] = useState(0);
  const size = 100;
  const radius = 40;
  const circ = 2 * Math.PI * radius;
  const offset = circ * (1 - displayed / 100);

  useEffect(() => {
    setDisplayed(0);
    let cur = 0;
    const step = () => {
      cur = Math.min(cur + 1.5, pct);
      setDisplayed(Math.round(cur));
      if (cur < pct) requestAnimationFrame(step);
    };
    const t = setTimeout(() => requestAnimationFrame(step), 120);
    return () => clearTimeout(t);
  }, [pct]);

  const color =
    pct >= 65 ? "#4ade80" :
    pct >= 50 ? "#a78bfa" :
    pct >= 38 ? "#facc15" : "#f87171";

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#1a1230" strokeWidth={9} />
        {pct > 0 && (
          <circle
            cx={size / 2} cy={size / 2} r={radius} fill="none"
            stroke={color} strokeWidth={9} strokeLinecap="round"
            strokeDasharray={circ} strokeDashoffset={offset}
            style={{ transition: "stroke-dashoffset 0.04s linear" }}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-white text-xl font-black">{displayed}<span className="text-sm">%</span></span>
      </div>
    </div>
  );
}

// ── Feature importance bar ────────────────────────────────────────────────────

function ImportanceBar({ fi, maxImp }: { fi: MLFeatureImportance; maxImp: number }) {
  const [width, setWidth] = useState(0);
  const pct = maxImp > 0 ? (fi.importance / maxImp) * 100 : 0;
  const color = fi.direction === "positive" ? "#a78bfa" : "#f87171";

  useEffect(() => {
    const t = setTimeout(() => setWidth(pct), 300);
    return () => clearTimeout(t);
  }, [pct]);

  return (
    <div className="flex items-center gap-2">
      <span className={`text-[9px] flex-shrink-0 ${fi.direction === "positive" ? "text-[#a78bfa]" : "text-[#f87171]"}`}>
        {fi.direction === "positive" ? "▲" : "▼"}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[#c0cdd4] text-[10px] truncate mb-0.5">{fi.name}</p>
        <div className="w-full bg-[#0a1014] rounded-full h-1">
          <div
            className="h-1 rounded-full transition-all duration-700 ease-out"
            style={{ width: `${width}%`, backgroundColor: color }}
          />
        </div>
      </div>
      <span className="text-[10px] font-mono flex-shrink-0" style={{ color }}>
        {fi.importance.toFixed(2)}
      </span>
    </div>
  );
}

// ── Main card ─────────────────────────────────────────────────────────────────

interface MLPredictionCardProps {
  result:          MLPredictionResult;
  ruleBasedPct?:   number;   // to show "vs rule-based" comparison
  compact?:        boolean;  // smaller inline version for market lists
}

export function MLPredictionCard({ result, ruleBasedPct, compact = false }: MLPredictionCardProps) {
  const { probability, confidence, feature_importances, model_type, model_version, explanation } = result;

  const probColor =
    probability >= 65 ? "#4ade80" :
    probability >= 50 ? "#a78bfa" :
    probability >= 38 ? "#facc15" : "#f87171";

  if (compact) {
    // Inline badge for market lists (NHLPredictionsPage)
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-[#1a1230] border border-[#a78bfa]/25">
        <span className="text-[9px] text-[#a78bfa] font-bold">🤖 ML</span>
        <span className="text-xs font-black" style={{ color: probColor }}>{probability}%</span>
        <span className="text-[9px] text-[#4a4060]">{model_type.split(' ')[0]}</span>
      </div>
    );
  }

  const maxImp = Math.max(...feature_importances.map((f) => f.importance), 0.001);
  const confColor =
    confidence >= 75 ? "#4ade80" :
    confidence >= 55 ? "#a78bfa" :
    "#facc15";

  return (
    <div className="bg-[#0d0a1a] border border-[#a78bfa]/20 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[#a78bfa]/10">
        <div className="w-7 h-7 rounded-lg bg-[#a78bfa]/15 border border-[#a78bfa]/30 flex items-center justify-center text-sm">
          🤖
        </div>
        <div className="flex-1">
          <p className="text-white text-xs font-bold">AI Prediction</p>
          <p className="text-[#6b5a8a] text-[9px]">{model_type} · {model_version}</p>
        </div>
        {/* Confidence chip */}
        <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-white/5 border border-white/10">
          <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: confColor }} />
          <span className="text-[9px]" style={{ color: confColor }}>{confidence}% confidence</span>
        </div>
      </div>

      {/* Body */}
      <div className="p-4">
        <div className="flex items-center gap-4 mb-4">
          {/* Mini gauge */}
          <MLGauge pct={probability} />

          {/* Explanation + comparison */}
          <div className="flex-1 min-w-0">
            <p className="text-white text-sm font-black mb-1">
              {probability}%
              <span className="text-[#6b5a8a] text-[10px] font-normal ml-1.5">probability</span>
            </p>
            <p className="text-[#8a7aaa] text-[10px] leading-relaxed">{explanation}</p>

            {ruleBasedPct !== undefined && (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-[9px] text-[#4a4060]">Rule-based:</span>
                <span className="text-[9px] font-bold text-[#86d1ea]">{ruleBasedPct}%</span>
                <span className="text-[9px] text-[#4a4060]">→</span>
                <span className="text-[9px] font-bold" style={{ color: probColor }}>ML: {probability}%</span>
                {Math.abs(probability - ruleBasedPct) >= 5 && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full"
                    style={{
                      backgroundColor: `${Math.abs(probability - ruleBasedPct) >= 10 ? "#f87171" : "#facc15"}22`,
                      color: Math.abs(probability - ruleBasedPct) >= 10 ? "#f87171" : "#facc15",
                    }}>
                    Δ{probability > ruleBasedPct ? "+" : ""}{probability - ruleBasedPct}%
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Feature importances */}
        {feature_importances.length > 0 && (
          <div>
            <p className="text-[#4a4060] text-[9px] uppercase tracking-wider mb-2">Feature Importances</p>
            <div className="flex flex-col gap-2">
              {feature_importances.map((fi, i) => (
                <ImportanceBar key={i} fi={fi} maxImp={maxImp} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Self-contained section with its own data fetching ────────────────────────

const API_BASE = import.meta.env.VITE_PREDICTION_API_URL || "";

interface MLSectionProps {
  type:          "game" | "player" | "team";
  subjectId:     string;
  opponentId?:   string;
  propType?:     string;
  line?:         number;
  selection?:    string;
  ruleBasedPct?: number;
}

export function MLSection({
  type, subjectId, opponentId, propType, line, selection, ruleBasedPct,
}: MLSectionProps) {
  const [result, setResult]   = useState<MLPredictionResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    if (!API_BASE) {
      setError("VITE_PREDICTION_API_URL non défini");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    fetch(`${API_BASE}/predict/ml`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ type, subjectId, opponentId, propType, line, selection }),
    })
      .then(async (r) => {
        if (r.ok) return r.json();
        const text = await r.text().catch(() => r.statusText);
        throw new Error(`${r.status}: ${text}`);
      })
      .then((data) => { setResult(data); setError(null); })
      .catch((e) => {
        console.error("[MLSection] fetch failed:", e.message, { type, subjectId, propType });
        setError(e.message);
        setResult(null);
      })
      .finally(() => setLoading(false));
  }, [type, subjectId, opponentId, propType]);

  if (loading) {
    return (
      <div className="bg-[#0d0a1a] border border-[#a78bfa]/10 rounded-2xl p-4 animate-pulse">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-7 h-7 rounded-lg bg-[#a78bfa]/10" />
          <div className="h-3 bg-[#a78bfa]/10 rounded w-24" />
        </div>
        <div className="h-2 bg-[#a78bfa]/10 rounded w-full mb-2" />
        <div className="h-2 bg-[#a78bfa]/10 rounded w-3/4" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-[#1a0a0a] border border-red-500/20 rounded-2xl px-4 py-3 flex items-center gap-3">
        <span className="text-base flex-shrink-0">🤖</span>
        <div className="min-w-0">
          <p className="text-red-400 text-xs font-semibold">ML indisponible</p>
          <p className="text-red-400/60 text-[10px] truncate">{error}</p>
        </div>
      </div>
    );
  }

  if (!result) return null;

  return <MLPredictionCard result={result} ruleBasedPct={ruleBasedPct} />;
}
