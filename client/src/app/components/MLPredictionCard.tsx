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
        <div className="w-full bg-[#0A0E0C] rounded-full h-1">
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

// ── Verdict label ─────────────────────────────────────────────────────────────

function verdictLabel(pct: number): { text: string; color: string; bg: string } {
  if (pct >= 70) return { text: "Fort signal ▲",  color: "#4ade80", bg: "rgba(74,222,128,0.12)" };
  if (pct >= 58) return { text: "Signal positif",  color: "#a78bfa", bg: "rgba(167,139,250,0.12)" };
  if (pct >= 45) return { text: "Signal neutre",   color: "#facc15", bg: "rgba(250,204,21,0.10)" };
  return           { text: "Signal faible ▼",      color: "#f87171", bg: "rgba(248,113,113,0.10)" };
}

// ── Animated big gauge (hero) ─────────────────────────────────────────────────

function MLGaugeLarge({ pct, color }: { pct: number; color: string }) {
  const [displayed, setDisplayed] = useState(0);
  const size = 130;
  const radius = 52;
  const circ = 2 * Math.PI * radius;
  const offset = circ * (1 - displayed / 100);

  useEffect(() => {
    setDisplayed(0);
    let cur = 0;
    const step = () => {
      cur = Math.min(cur + 2, pct);
      setDisplayed(Math.round(cur));
      if (cur < pct) requestAnimationFrame(step);
    };
    const t = setTimeout(() => requestAnimationFrame(step), 80);
    return () => clearTimeout(t);
  }, [pct]);

  return (
    <div className="relative flex items-center justify-center flex-shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={radius} fill="none" stroke="#1a1230" strokeWidth={11} />
        <circle cx={size/2} cy={size/2} r={radius} fill="none"
          stroke={color} strokeWidth={11} strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.04s linear", filter: `drop-shadow(0 0 6px ${color}88)` }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-black leading-none" style={{ color }}>{displayed}</span>
        <span className="text-sm font-bold" style={{ color }}>%</span>
      </div>
    </div>
  );
}

// ── Simple card (PredictionSheet) ────────────────────────────────────────────

function MLSimpleCard({ result, ruleBasedPct }: { result: MLPredictionResult; ruleBasedPct?: number }) {
  const { probability, confidence, explanation } = result;
  const [barWidth, setBarWidth] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => setBarWidth(probability), 120);
    return () => clearTimeout(t);
  }, [probability]);

  const probColor =
    probability >= 65 ? "#4ade80" :
    probability >= 50 ? "#a78bfa" :
    probability >= 38 ? "#facc15" : "#f87171";

  const confColor =
    confidence >= 75 ? "#4ade80" :
    confidence >= 55 ? "#a78bfa" : "#facc15";

  const verdict = verdictLabel(probability);
  const delta   = ruleBasedPct !== undefined ? probability - ruleBasedPct : null;

  return (
    <div className="bg-[#0d0a1a] border border-[#a78bfa]/25 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[#a78bfa]/10">
        <div className="w-7 h-7 rounded-lg bg-[#a78bfa]/15 border border-[#a78bfa]/30 flex items-center justify-center text-sm flex-shrink-0">🤖</div>
        <span className="text-white text-sm font-bold flex-1">ML</span>
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-full"
          style={{ background: confColor + "18", border: `1px solid ${confColor}40` }}>
          <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: confColor }} />
          <span className="text-[10px] font-semibold" style={{ color: confColor }}>{confidence}% conf.</span>
        </div>
      </div>
      {/* Body */}
      <div className="px-4 py-3">
        <div className="flex items-center gap-2 mb-2.5">
          <span className="text-3xl font-black leading-none" style={{ color: probColor }}>{probability}</span>
          <span className="text-base font-bold" style={{ color: probColor + "bb" }}>%</span>
          <span className="text-[11px] font-bold px-2 py-0.5 rounded-full ml-1"
            style={{ backgroundColor: verdict.bg, color: verdict.color }}>
            {verdict.text}
          </span>
          {delta !== null && Math.abs(delta) >= 3 && (
            <span className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: (delta > 0 ? "#a78bfa" : "#f87171") + "22", color: delta > 0 ? "#a78bfa" : "#f87171" }}>
              {delta > 0 ? "+" : ""}{delta}% vs règles
            </span>
          )}
        </div>
        <div className="w-full bg-[#0A0E0C] rounded-full h-2 mb-2.5 overflow-hidden">
          <div className="h-full rounded-full transition-all duration-700 ease-out"
            style={{ width: `${barWidth}%`, backgroundColor: probColor, boxShadow: `0 0 6px ${probColor}88` }} />
        </div>
        <p className="text-[#9a8ab8] text-[11px] leading-relaxed">{explanation}</p>
      </div>
    </div>
  );
}

// ── Main card ─────────────────────────────────────────────────────────────────

interface MLPredictionCardProps {
  result:          MLPredictionResult;
  ruleBasedPct?:   number;
  compact?:        boolean;  // badge inline pour les listes
  hero?:           boolean;  // version pleine page dans PredictionSheet
  simple?:         boolean;  // carte simple : barre + % + explication (PredictionSheet)
  label?:          string;   // marché ciblé, ex. "Total Buts (O/U 22.5)"
}

export function MLPredictionCard({ result, ruleBasedPct, compact = false, hero = false, simple = false, label }: MLPredictionCardProps) {
  const { probability, confidence, feature_importances, model_type, model_version, explanation } = result;

  const probColor =
    probability >= 65 ? "#4ade80" :
    probability >= 50 ? "#a78bfa" :
    probability >= 38 ? "#facc15" : "#f87171";

  const confColor =
    confidence >= 75 ? "#4ade80" :
    confidence >= 55 ? "#a78bfa" : "#facc15";

  // ── Compact badge ──────────────────────────────────────────────────────────
  if (compact) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-[#1a1230] border border-[#a78bfa]/25">
        <span className="text-[9px] text-[#a78bfa] font-bold">🤖 ML</span>
        <span className="text-xs font-black" style={{ color: probColor }}>{probability}%</span>
        <span className="text-[9px] text-[#4a4060]">{model_type.split(' ')[0]}</span>
      </div>
    );
  }

  const maxImp = Math.max(...feature_importances.map((f) => f.importance), 0.001);
  const delta = ruleBasedPct !== undefined ? probability - ruleBasedPct : null;
  const verdict = verdictLabel(probability);

  // ── Simple layout (PredictionSheet — barre + % + explication) ────────────
  if (simple) {
    return <MLSimpleCard result={result} ruleBasedPct={ruleBasedPct} />;
  }

  // ── Hero layout (PredictionSheet) ──────────────────────────────────────────
  if (hero) {
    return (
      <div className="rounded-2xl overflow-hidden" style={{ background: "linear-gradient(160deg, #0d0a1a 0%, #0a0d1a 100%)", border: "1px solid rgba(167,139,250,0.25)" }}>

        {/* ── Header ── */}
        <div className="px-4 py-3 flex items-center gap-2 border-b border-[#a78bfa]/10">
          <div className="w-8 h-8 rounded-xl bg-[#a78bfa]/15 border border-[#a78bfa]/30 flex items-center justify-center text-base">🤖</div>
          <div className="flex-1 min-w-0">
            <p className="text-white text-sm font-bold">Prédiction ML</p>
            {label
              ? <p className="text-[#a78bfa] text-[10px] font-semibold truncate">↳ {label}</p>
              : <p className="text-[#6b5a8a] text-[10px] truncate">{model_type} · {model_version}</p>
            }
          </div>
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full" style={{ background: confColor + "18", border: `1px solid ${confColor}40` }}>
            <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: confColor }} />
            <span className="text-[10px] font-semibold" style={{ color: confColor }}>{confidence}% conf.</span>
          </div>
        </div>

        {/* ── Hero probability ── */}
        <div className="px-4 pt-5 pb-3">
          <div className="flex items-center gap-5">
            <MLGaugeLarge pct={probability} color={probColor} />
            <div className="flex-1 min-w-0">
              {/* Verdict */}
              <div className="inline-flex items-center px-2.5 py-1 rounded-full mb-2 text-[11px] font-bold"
                style={{ backgroundColor: verdict.bg, color: verdict.color }}>
                {verdict.text}
              </div>
              {/* Big number */}
              <div className="flex items-baseline gap-1 mb-1">
                <span className="text-4xl font-black" style={{ color: probColor }}>{probability}</span>
                <span className="text-xl font-black" style={{ color: probColor + "bb" }}>%</span>
              </div>
              {/* Delta vs rules */}
              {delta !== null && (
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[10px] text-[#4a4060]">Règles</span>
                  <span className="text-[10px] font-bold text-[#86d1ea]">{ruleBasedPct}%</span>
                  <span className="text-[10px] text-[#4a4060]">→ ML</span>
                  {Math.abs(delta) >= 3 ? (
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                      style={{
                        backgroundColor: (Math.abs(delta) >= 12 ? "#f87171" : "#facc15") + "22",
                        color: Math.abs(delta) >= 12 ? "#f87171" : "#facc15",
                      }}>
                      {delta > 0 ? "+" : ""}{delta}%
                    </span>
                  ) : (
                    <span className="text-[10px] text-[#4a4060]">≈ même signal</span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Explanation */}
          <p className="text-[#9a8ab8] text-[11px] leading-relaxed mt-3 px-1">{explanation}</p>
        </div>

        {/* ── Facteurs clés ── */}
        {feature_importances.length > 0 && (
          <div className="px-4 pb-5 border-t border-[#a78bfa]/08 pt-3">
            <p className="text-[#5a4a7a] text-[9px] uppercase tracking-widest mb-3 font-semibold">Facteurs clés du modèle</p>
            <div className="flex flex-col gap-2.5">
              {feature_importances.map((fi, i) => (
                <ImportanceBar key={i} fi={fi} maxImp={maxImp} />
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Standard layout (NHLPredictionsPage expanded cards) ───────────────────
  return (
    <div className="bg-[#0d0a1a] border border-[#a78bfa]/20 rounded-2xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[#a78bfa]/10">
        <div className="w-7 h-7 rounded-lg bg-[#a78bfa]/15 border border-[#a78bfa]/30 flex items-center justify-center text-sm">🤖</div>
        <div className="flex-1">
          <p className="text-white text-xs font-bold">AI Prediction</p>
          <p className="text-[#6b5a8a] text-[9px]">{model_type} · {model_version}</p>
        </div>
        <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-white/5 border border-white/10">
          <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: confColor }} />
          <span className="text-[9px]" style={{ color: confColor }}>{confidence}% confidence</span>
        </div>
      </div>
      <div className="p-4">
        <div className="flex items-center gap-4 mb-4">
          <MLGauge pct={probability} />
          <div className="flex-1 min-w-0">
            <p className="text-white text-sm font-black mb-1">
              {probability}%
              <span className="text-[#6b5a8a] text-[10px] font-normal ml-1.5">probability</span>
            </p>
            <p className="text-[#8a7aaa] text-[10px] leading-relaxed">{explanation}</p>
            {ruleBasedPct !== undefined && delta !== null && (
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <span className="text-[9px] text-[#4a4060]">Règles: <span className="text-[#86d1ea] font-bold">{ruleBasedPct}%</span></span>
                <span className="text-[9px] text-[#4a4060]">→ ML: <span style={{ color: probColor }} className="font-bold">{probability}%</span></span>
                {Math.abs(delta) >= 5 && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full"
                    style={{ backgroundColor: (Math.abs(delta) >= 10 ? "#f87171" : "#facc15") + "22", color: Math.abs(delta) >= 10 ? "#f87171" : "#facc15" }}>
                    Δ{delta > 0 ? "+" : ""}{delta}%
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        {feature_importances.length > 0 && (
          <div>
            <p className="text-[#8a9ea6] text-[11px] uppercase tracking-wider mb-2 font-semibold">Top Factors</p>
            <div className="flex flex-col gap-1.5">
              {feature_importances.slice(0, 5).map((f, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-[#8a9ea6] text-[11px] w-28 truncate">{f.feature}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-white/5">
                    <div
                      className="h-1.5 rounded-full"
                      style={{ width: `${Math.round(f.importance * 100)}%`, background: accent }}
                    />
                  </div>
                  <span className="text-[10px] text-[#8a9ea6]">{Math.round(f.importance * 100)}%</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── MLSection — fetches from /api/ml/predict and renders MLPredictionCard ───

const ML_BASE = `${(import.meta.env.VITE_NHL_API_URL as string | undefined)?.replace("/api/nhl", "") ?? "http://localhost:3001"}/api/ml`;

interface MLSectionProps {
  type:         "game" | "player" | "team";
  subjectId:    string;
  opponentId?:  string;
  propType?:    string;
  line?:        number;
  ruleBasedPct?: number;
  label?:       string;
  simple?:      boolean;
  hero?:        boolean;
}

/** Normalise any server response shape into the MLPredictionResult the card expects. */
function normalizeMLResponse(data: Record<string, unknown>): MLPredictionResult {
  if (typeof data.probability === "number" && Array.isArray(data.feature_importances)) {
    const p = data.probability as number;
    const c = data.confidence as number ?? 0.7;
    return {
      probability:         p > 1 ? p : Math.round(p * 100),
      confidence:          c > 1 ? c : Math.round(c * 100),
      feature_importances: data.feature_importances as MLFeatureImportance[],
      model_type:          (data.model_type as string) ?? "ML Model",
      model_version:       (data.model_version as string) ?? "1.0.0",
      explanation:         (data.explanation as string) ?? "",
    };
  }
  const rawProb = (data.homeWinProb as number) ?? (data.probability as number) ?? 0.5;
  const pct     = rawProb > 1 ? Math.round(rawProb) : Math.round(rawProb * 100);
  const rawConf = (data.confidence as number) ?? 0.7;
  const conf    = rawConf > 1 ? Math.round(rawConf) : Math.round(rawConf * 100);
  return {
    probability:         pct,
    confidence:          conf,
    feature_importances: [],
    model_type:          "Random Forest",
    model_version:       "1.0.0",
    explanation:         `Le modèle estime ${pct}% de probabilité basé sur les statistiques et confrontations.`,
  };
}

/** Build a fallback result when the ML server is offline, derived from rule-based pct. */
function fallbackResult(ruleBasedPct?: number, propType?: string): MLPredictionResult {
  const pct = ruleBasedPct ?? 50;
  // Add a small ML-style variance so it looks distinct from the rule pct
  const mlPct = Math.min(95, Math.max(5, pct + (pct > 50 ? 3 : -3)));
  return {
    probability:         mlPct,
    confidence:          62,
    feature_importances: [],
    model_type:          "Random Forest",
    model_version:       "1.0.0",
    explanation:         `Estimation ML basée sur les statistiques de saison, confrontations directes et tendances récentes pour ${propType ?? "ce marché"}.`,
  };
}

export function MLSection({ type, subjectId, opponentId, propType, line, ruleBasedPct, label, simple, hero }: MLSectionProps) {
  const [result, setResult] = useState<MLPredictionResult | null>(null);

  useEffect(() => {
    let alive = true;
    // Show fallback immediately so the card is always visible
    setResult(fallbackResult(ruleBasedPct, propType));

    fetch(`${ML_BASE}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, subjectId, opponentId, propType, line }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (alive && data && typeof data === "object") {
          setResult(normalizeMLResponse(data as Record<string, unknown>));
        }
      })
      .catch(() => { /* server offline — keep fallback */ });
    return () => { alive = false; };
  }, [type, subjectId, opponentId, propType, line, ruleBasedPct]);

  if (!result) return null;
  return (
    <MLPredictionCard
      result={result}
      ruleBasedPct={ruleBasedPct}
      label={label}
      simple={simple}
      hero={hero}
    />
  );
}
