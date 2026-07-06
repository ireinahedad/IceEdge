/**
 * DevMLDashboard — ML performance dashboard for admin / developer.
 * Route: /dev/ml   (gated to admin role — redirects anyone else)
 *
 * Shows:
 *  • Python ML service health + model status
 *  • Feature importances for game & player models
 *  • Live test-prediction form (game / player / team)
 *  • Model version + confidence calibration note
 */

import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../context/AuthContext";
import { authedFetch } from "../services/authService";

// ── Types ─────────────────────────────────────────────────────────────────────

interface FeatureImportance {
  name: string;
  importance: number;
  direction: "positive" | "negative";
}

interface MLSample {
  probability: number;
  confidence: number;
  feature_importances: FeatureImportance[];
  model_version: string;
  model_type: string;
  explanation: string;
}

interface MLInfoResponse {
  ml_url: string;
  service_up: boolean;
  health: {
    status: string;
    models: Record<string, string>;
    trained_models_loaded: Record<string, boolean>;
    tip?: string;
    error?: string;
  };
  features: unknown;
  samples: { game: MLSample | null; player: MLSample | null };
  retrieved_at: string;
}

interface TestResult {
  type: string;
  result: MLSample;
  tested_at: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function probColor(p: number) {
  if (p >= 65) return "#4ade80";
  if (p >= 50) return "#a78bfa";
  if (p >= 38) return "#facc15";
  return "#f87171";
}

function confidenceLabel(c: number) {
  if (c >= 80) return "Very High";
  if (c >= 65) return "High";
  if (c >= 50) return "Medium";
  if (c >= 35) return "Low";
  return "Very Low";
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${ok ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#131A12]/80 border border-white/15 rounded-2xl p-4">
      <p className="text-[#a78bfa] text-[10px] font-bold uppercase tracking-widest mb-3">{title}</p>
      {children}
    </div>
  );
}

function FeatureBar({ fi, maxImp }: { fi: FeatureImportance; maxImp: number }) {
  const pct = maxImp > 0 ? (fi.importance / maxImp) * 100 : 0;
  const color = fi.direction === "positive" ? "#4ade80" : "#f87171";
  return (
    <div className="flex items-center gap-2 mb-1.5">
      <span className="text-[10px] text-[#bfc8cc] w-36 flex-shrink-0 truncate">{fi.name}</span>
      <div className="flex-1 bg-[#0A0E0C] rounded-full h-2 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span className="text-[10px] font-mono w-10 text-right flex-shrink-0"
        style={{ color }}>{(fi.importance * 100).toFixed(1)}%</span>
    </div>
  );
}

function ProbGauge({ pct }: { pct: number }) {
  const color = probColor(pct);
  const r = 36;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - pct / 100);
  return (
    <div className="relative flex items-center justify-center w-24 h-24">
      <svg width={96} height={96} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={48} cy={48} r={r} fill="none" stroke="#1a1230" strokeWidth={8} />
        <circle cx={48} cy={48} r={r} fill="none" stroke={color} strokeWidth={8}
          strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.6s ease" }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-white text-xl font-black">{pct}<span className="text-xs">%</span></span>
      </div>
    </div>
  );
}

function SampleCard({ label, sample }: { label: string; sample: MLSample | null }) {
  if (!sample) return (
    <div className="p-3 bg-[#0A0E0C]/60 rounded-xl border border-white/8 text-[#bfc8cc] text-xs">
      {label} — ML service returned no result
    </div>
  );
  const maxImp = Math.max(...sample.feature_importances.map(f => f.importance), 0.001);
  const color = probColor(sample.probability);
  return (
    <div className="p-3 bg-[#0A0E0C]/60 rounded-xl border border-white/8">
      <div className="flex items-center gap-3 mb-3">
        <ProbGauge pct={sample.probability} />
        <div>
          <p className="text-white text-xs font-bold mb-0.5">{label}</p>
          <p className="text-[10px]" style={{ color }}>{sample.probability}% — {confidenceLabel(sample.confidence)} confidence ({sample.confidence}%)</p>
          <p className="text-[#bfc8cc] text-[10px] mt-0.5">v{sample.model_version} · {sample.model_type}</p>
        </div>
      </div>
      <p className="text-[#bfc8cc] text-[10px] italic mb-3 leading-relaxed">{sample.explanation}</p>
      <div>
        <p className="text-[10px] text-white/50 mb-1.5 uppercase tracking-wider">Feature Importances</p>
        {sample.feature_importances.map((fi, i) => (
          <FeatureBar key={i} fi={fi} maxImp={maxImp} />
        ))}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function DevMLDashboard() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  const [info, setInfo]           = useState<MLInfoResponse | null>(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);

  // Live test form
  const [testType, setTestType]         = useState<"game" | "player" | "team">("game");
  const [testTeamId, setTestTeamId]     = useState("bos");
  const [testOppId, setTestOppId]       = useState("nyr");
  const [testPlayerId, setTestPlayerId] = useState("8478402");
  const [testPropType, setTestPropType] = useState("goals");
  const [testLine, setTestLine]         = useState("0.5");
  const [testResult, setTestResult]     = useState<TestResult | null>(null);
  const [testLoading, setTestLoading]   = useState(false);
  const [testError, setTestError]       = useState<string | null>(null);

  // Redirect non-admins
  useEffect(() => {
    if (!authLoading && user && user.role !== "admin") navigate("/", { replace: true });
    if (!authLoading && !user) navigate("/login", { state: { returnTo: "/dev/ml" } });
  }, [user, authLoading, navigate]);

  const fetchInfo = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authedFetch("/dev/ml-info");
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      setInfo(await res.json() as MLInfoResponse);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchInfo(); }, [fetchInfo]);

  async function runTest() {
    setTestLoading(true);
    setTestError(null);
    setTestResult(null);
    try {
      const body: Record<string, unknown> = { type: testType };
      if (testType === "game")   { body.teamId = testTeamId; body.opponentId = testOppId; body.propType = "moneyline"; }
      if (testType === "player") { body.playerId = testPlayerId; body.propType = testPropType; body.line = parseFloat(testLine); body.selection = "over"; }
      if (testType === "team")   { body.teamId = testTeamId; body.propType = "cup"; }

      const res = await authedFetch("/dev/ml-test", { method: "POST", body: JSON.stringify(body) });
      if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); throw new Error((e as any).error); }
      setTestResult(await res.json() as TestResult);
    } catch (e: any) {
      setTestError(e.message);
    } finally {
      setTestLoading(false);
    }
  }

  if (authLoading || (!user)) {
    return (
      <div className="min-h-screen bg-[#0A0E0C] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-[#a78bfa]/30 border-t-[#a78bfa] rounded-full animate-spin" />
      </div>
    );
  }

  const svcUp = info?.service_up ?? false;

  return (
    <div className="min-h-screen bg-[#0A0E0C] text-white max-w-[480px] mx-auto px-4 pb-16">

      {/* Header */}
      <div className="sticky top-0 bg-[#0A0E0C]/90 backdrop-blur-md border-b border-white/8 py-4 mb-5 z-10">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg">🤖</span>
              <span className="text-white font-bold text-base">ML Dashboard</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#a78bfa]/15 border border-[#a78bfa]/30 text-[#a78bfa] font-medium">DEV ONLY</span>
            </div>
            <p className="text-[#bfc8cc] text-[11px] mt-0.5">Admin: {user.email}</p>
          </div>
          <button onClick={fetchInfo} disabled={loading}
            className="px-3 py-1.5 rounded-xl bg-[#a78bfa]/10 border border-[#a78bfa]/30 text-[#a78bfa] text-xs hover:bg-[#a78bfa]/20 transition-all disabled:opacity-50">
            {loading ? "…" : "↻ Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-xs">
          {error}
        </div>
      )}

      {/* Service Health */}
      <Card title="Service Status">
        <div className="flex items-center gap-2 mb-3">
          <StatusDot ok={svcUp} />
          <span className={`text-sm font-semibold ${svcUp ? "text-green-400" : "text-red-400"}`}>
            Python ML Service — {svcUp ? "Online" : "Offline"}
          </span>
        </div>
        {info && (
          <>
            <p className="text-[#bfc8cc] text-[10px] mb-3 font-mono">{info.ml_url}</p>
            {info.health?.error ? (
              <p className="text-red-400 text-xs">{info.health.error}</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {Object.entries(info.health?.models ?? {}).map(([k, v]) => (
                  <div key={k} className="flex items-center justify-between">
                    <span className="text-[#bfc8cc] text-[11px] capitalize">{k} model</span>
                    <span className="text-white text-[11px] font-medium">{v}</span>
                  </div>
                ))}
              </div>
            )}
            {info.health?.trained_models_loaded && (
              <div className="mt-3 pt-3 border-t border-white/8 flex gap-3">
                {Object.entries(info.health.trained_models_loaded).map(([k, loaded]) => (
                  <div key={k} className="flex items-center gap-1.5">
                    <StatusDot ok={loaded} />
                    <span className="text-[10px] text-[#bfc8cc]">{k.replace("_model", "")}</span>
                  </div>
                ))}
              </div>
            )}
            {info.health?.tip && (
              <p className="mt-3 text-[10px] text-[#facc15] italic border-t border-white/8 pt-2">{info.health.tip}</p>
            )}
          </>
        )}
        {loading && !info && <div className="h-20 bg-white/5 rounded-xl animate-pulse" />}
      </Card>

      {/* Startup Samples */}
      {info?.samples && (
        <div className="mt-4">
          <Card title="Startup Samples (BOS vs NYR · Goals 0.5)">
            <div className="flex flex-col gap-3">
              <SampleCard label="Game — BOS Moneyline" sample={info.samples.game} />
              <SampleCard label="Player — Goals O/U 0.5" sample={info.samples.player} />
            </div>
          </Card>
        </div>
      )}

      {/* Live Test Form */}
      <div className="mt-4">
        <Card title="Live Test Prediction">
          {/* Type selector */}
          <div className="flex bg-white/5 rounded-xl p-0.5 mb-4 gap-0.5">
            {(["game", "player", "team"] as const).map(t => (
              <button key={t} onClick={() => setTestType(t)}
                className={`flex-1 py-1.5 rounded-lg text-[11px] font-medium transition-all capitalize ${testType === t ? "bg-[#a78bfa] text-[#0A0E0C] font-bold" : "text-[#8a9ea6]"}`}>
                {t}
              </button>
            ))}
          </div>

          {/* Fields */}
          <div className="flex flex-col gap-2 mb-4">
            {testType === "game" && <>
              <div className="flex gap-2">
                <label className="flex-1">
                  <span className="text-[10px] text-[#bfc8cc] mb-1 block">Home team</span>
                  <input value={testTeamId} onChange={e => setTestTeamId(e.target.value)}
                    className="w-full bg-[#0A0E0C] border border-white/15 rounded-lg px-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-[#a78bfa]/60" placeholder="bos" />
                </label>
                <label className="flex-1">
                  <span className="text-[10px] text-[#bfc8cc] mb-1 block">Away team</span>
                  <input value={testOppId} onChange={e => setTestOppId(e.target.value)}
                    className="w-full bg-[#0A0E0C] border border-white/15 rounded-lg px-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-[#a78bfa]/60" placeholder="nyr" />
                </label>
              </div>
            </>}
            {testType === "player" && <>
              <label>
                <span className="text-[10px] text-[#bfc8cc] mb-1 block">Player ID</span>
                <input value={testPlayerId} onChange={e => setTestPlayerId(e.target.value)}
                  className="w-full bg-[#0A0E0C] border border-white/15 rounded-lg px-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-[#a78bfa]/60" placeholder="8478402" />
              </label>
              <div className="flex gap-2">
                <label className="flex-1">
                  <span className="text-[10px] text-[#bfc8cc] mb-1 block">Prop type</span>
                  <select value={testPropType} onChange={e => setTestPropType(e.target.value)}
                    className="w-full bg-[#0A0E0C] border border-white/15 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-[#a78bfa]/60">
                    {["goals", "assists", "points", "shots", "hits", "blocks", "saves"].map(p => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </label>
                <label className="flex-1">
                  <span className="text-[10px] text-[#bfc8cc] mb-1 block">Line</span>
                  <input value={testLine} onChange={e => setTestLine(e.target.value)} type="number" step="0.5"
                    className="w-full bg-[#0A0E0C] border border-white/15 rounded-lg px-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-[#a78bfa]/60" />
                </label>
              </div>
            </>}
            {testType === "team" && <>
              <label>
                <span className="text-[10px] text-[#bfc8cc] mb-1 block">Team ID</span>
                <input value={testTeamId} onChange={e => setTestTeamId(e.target.value)}
                  className="w-full bg-[#0A0E0C] border border-white/15 rounded-lg px-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-[#a78bfa]/60" placeholder="bos" />
              </label>
            </>}
          </div>

          <button onClick={runTest} disabled={testLoading}
            className="w-full py-2.5 rounded-xl bg-[#a78bfa] text-[#0A0E0C] text-sm font-bold hover:bg-[#a78bfa]/90 active:scale-[0.98] transition-all disabled:opacity-50">
            {testLoading ? "Running prediction…" : "▶ Run Test"}
          </button>

          {testError && (
            <p className="mt-3 text-red-400 text-xs bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">{testError}</p>
          )}

          {testResult?.result && (
            <div className="mt-4">
              <SampleCard label={`${testResult.type} prediction`} sample={testResult.result} />
              <p className="text-[10px] text-[#bfc8cc]/50 mt-2 text-right">
                Tested at {new Date(testResult.tested_at).toLocaleTimeString()}
              </p>
            </div>
          )}
        </Card>
      </div>

      {/* Last retrieved */}
      {info?.retrieved_at && (
        <p className="text-center text-[10px] text-[#bfc8cc]/40 mt-5">
          Last fetched: {new Date(info.retrieved_at).toLocaleString()}
        </p>
      )}
    </div>
  );
}
