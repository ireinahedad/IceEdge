/**
 * DevMLDashboard — ML performance dashboard for admin / developer.
 * Route: /dev/ml   (gated to admin role — redirects anyone else)
 *
 * Quatre onglets, un par question qu'on se pose sur un modèle en production :
 *
 *  • Service   — le service Python répond-il, et sert-il bien les modèles
 *                entraînés ? (+ formulaire de prédiction à la volée)
 *  • Données   — la matière première est-elle fraîche ? Collecte de cotes,
 *                quota The Odds API, arriéré de règlement.
 *  • Modèle    — ce que vaut l'entraînement : log-loss vs marché, Brier,
 *                calibration, features, fraîcheur des artefacts.
 *  • Backtest  — ROI par seuil d'edge, par marché, et l'étude d'incertitude.
 *  • Live      — ce que le modèle vaut RÉELLEMENT : calibration et ROI mesurés
 *                sur les paris réglés, pas sur l'historique.
 *
 * La séparation Backtest / Live est le point du dashboard : un backtest ment
 * toujours un peu (survivorship, cotes d'archive, marchés dérivés) et seul
 * l'écart entre les deux colonnes dit de combien.
 *
 * Endpoints consommés (tous admin-only, cf. server/src/routes/dev.routes.ts) :
 *   GET /dev/ml-info · POST /dev/ml-test · GET /dev/ml-reports
 *   GET /dev/data-health · GET /dev/live-performance
 */

import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../context/AuthContext";
import { authedFetch } from "../services/authService";
import { pctColor } from "../data/pctScale";

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
  // Les deux estimateurs de P(domicile gagne), côte à côte (S4 ⑤). Optionnels :
  // absents si le modèle concerné n'a pas répondu. Ce ne sont pas
  // `probability`, qui est la probabilité du marché demandé.
  probability_score_model?: number | null;
  probability_classifier?: number | null;
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

/** Un artefact sur le disque du service ML : présent ? de quand ? */
interface ArtifactMeta {
  present: boolean;
  modified_at: string | null;
  bytes: number | null;
}

/** Une ligne de ROI par seuil d'edge (backtests). */
interface RoiRow {
  edge: number;
  n_bets: number;
  n_push?: number;
  hit_rate: number;
  roi_flat_pct: number;
  roi_kelly_pct?: number;
  roi_se_pct?: number;
  z?: number;
}

interface MLReportsResponse {
  error?: string;
  models_dir?: string;
  reports?: {
    training_report?: {
      game_model?: {
        model?: string;
        best_iteration?: number;
        n_train?: number; n_val?: number; n_test?: number;
        accuracy?: number; brier_score?: number; log_loss?: number;
        skill_score?: number; val_log_loss?: number; home_win_rate?: number;
        baselines?: Record<string, any>;
        calibration?: Record<string, any>;
        feature_importances?: FeatureImportance[] | Array<[string, number]>;
      };
      features?: { game?: string[] };
      dataset?: string;
    };
    score_report?: {
      model?: string;
      n_train?: number; n_test?: number;
      p_ot_home?: number;
      test?: Record<string, any>;
      ensemble?: Record<string, any>;
      features?: string[];
    };
    backtest_walkforward_report?: {
      seasons?: number[];
      n_games_with_odds?: number;
      log_loss?: { model: number; market: number };
      roi?: RoiRow[];
    };
    backtest_derived_report?: {
      edge_threshold?: number;
      // ⚠️ Pas seulement des tableaux de ROI : le run A2 a ajouté
      //    `puckline_diagnostics`, un OBJET. D'où le filtre à l'affichage.
      markets?: Record<string, RoiRow[] | Record<string, unknown>>;
    };
    backtest_uncertainty_report?: {
      n_bets?: number;
      edge_threshold?: number;
      n_members?: number;
      sizing?: Record<string, Record<string, number>>;
      sigma_vs_flat?: Record<string, number>;
      sigma_buckets?: Array<{
        bucket: number; n: number; sigma_mean: number;
        edge_predicted: number; edge_realized: number; gap: number;
      }>;
    };
    feature_importance_game?: Record<string, number> | FeatureImportance[];
  };
  report_errors?: Record<string, string>;
  artifacts?: Record<string, ArtifactMeta>;
  runtime?: {
    game_model_loaded: boolean;
    score_model_loaded: boolean;
    calibrated: boolean;
    blend_weights: number[] | null;
    elo_teams: number;
    inference_state_as_of: string | null;
    inference_state_teams: number;
    score_ensemble_members_loaded: number;
    score_ensemble_files_on_disk: number;
    sigma_max: number | null;
  };
  retrieved_at?: string;
}

interface DataHealthResponse {
  odds_log: {
    rows?: number; first_date?: string; last_date?: string; last_write?: string;
    with_ml_close?: number; with_total_close?: number;
    with_puckline_close?: number; with_ml_movement?: number;
    error?: string;
  };
  odds_quota: { remaining?: number; used?: number; observed_at?: string; error?: string };
  odds_snapshots?: {
    rows?: number; passes?: number; passes_today?: number;
    first_date?: string; last_date?: string; last_observed?: string;
    rows_full?: number; rows_spreads?: number; with_puckline?: number;
    error?: string;
  };
  slips: {
    total?: number; pending?: number; settled?: number;
    last_placed?: string; last_resolved?: string; stale_pending?: number;
    error?: string;
  };
  retrieved_at: string;
}

interface PerfBucket {
  n: number;
  hit_rate: number | null;
  avg_prob: number | null;
  n_priced: number;
  roi_flat_pct: number | null;
}

interface LivePerformanceResponse {
  window_days: number;
  truncated: boolean;
  n_legs: number;
  min_sample: number;
  overall: PerfBucket;
  singles: PerfBucket;
  parlays: PerfBucket;
  by_market: Record<string, PerfBucket>;
  calibration: Array<PerfBucket & { bucket: string }>;
  brier: number | null;
  log_loss: number | null;
  n_scored: number;
  n_unparseable_prob: number;
  n_unpriced: number;
  clv: { available: boolean; reason: string };
  retrieved_at: string;
}

type Tab = "service" | "data" | "model" | "backtest" | "live";

// ── Helpers ───────────────────────────────────────────────────────────────────

function probColor(p: number) {
  return pctColor(p);
}

function confidenceLabel(c: number) {
  if (c >= 80) return "Very High";
  if (c >= 65) return "High";
  if (c >= 50) return "Medium";
  if (c >= 35) return "Low";
  return "Very Low";
}

/** Un ROI positif est vert, négatif rouge — mais gris tant qu'il est nul. */
function signColor(v: number | null | undefined, invert = false) {
  if (v == null) return "#8a9ea6";
  const good = invert ? v < 0 : v > 0;
  if (v === 0) return "#8a9ea6";
  return good ? "#4ade80" : "#f87171";
}

function fmt(v: number | null | undefined, digits = 2, suffix = "") {
  return v == null || Number.isNaN(v) ? "—" : `${v.toFixed(digits)}${suffix}`;
}

/** « il y a 3 j » — la seule façon de voir d'un coup d'œil qu'un job est mort. */
function timeAgo(iso: string | null | undefined): { label: string; days: number | null } {
  if (!iso) return { label: "jamais", days: null };
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return { label: "—", days: null };
  const ms = Date.now() - then;
  const days = ms / 86_400_000;
  if (ms < 3_600_000)  return { label: `il y a ${Math.max(1, Math.round(ms / 60_000))} min`, days };
  if (days < 1)        return { label: `il y a ${Math.round(ms / 3_600_000)} h`, days };
  if (days < 30)       return { label: `il y a ${Math.round(days)} j`, days };
  return { label: new Date(iso).toLocaleDateString(), days };
}

function bytes(n: number | null | undefined) {
  if (n == null) return "—";
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${ok ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
  );
}

function Card({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="bg-[#131A12]/80 border border-white/15 rounded-2xl p-4">
      <p className="text-[#a78bfa] text-[10px] font-bold uppercase tracking-widest mb-1">{title}</p>
      {hint && <p className="text-[#bfc8cc]/60 text-[10px] mb-3 leading-relaxed">{hint}</p>}
      {!hint && <div className="mb-3" />}
      {children}
    </div>
  );
}

/** Chiffre unique + libellé. La brique de base des trois nouveaux onglets. */
function Metric({
  label, value, sub, color, warn,
}: { label: string; value: string; sub?: string; color?: string; warn?: boolean }) {
  return (
    <div className={`px-3 py-2.5 rounded-xl border ${warn ? "border-[#facc15]/40 bg-[#facc15]/5" : "border-white/8 bg-[#0A0E0C]/60"}`}>
      <p className="text-[9px] uppercase tracking-wider text-[#bfc8cc]/70 mb-1">{label}</p>
      <p className="text-lg font-black leading-none" style={{ color: color ?? "#fff" }}>{value}</p>
      {sub && <p className="text-[10px] text-[#bfc8cc]/60 mt-1">{sub}</p>}
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

/**
 * Marchés proposés au test manuel.
 *
 * Le premier groupe est pricé EXACTEMENT par la distribution de score
 * (`_apply_score_model`) : `base_prob` n'y est même pas lu. Le second retombe
 * sur les heuristiques et consomme `base_prob` — ce sont les six marchés que
 * S4 ④ a fait passer du classifieur au modèle de score. C'est là, et seulement
 * là, qu'un changement de `base_prob` se voit.
 */
const TEST_MARKETS: Array<{ id: string; group: string }> = [
  ...["moneyline", "puck_line", "total_goals", "both_teams_score"]
    .map(id => ({ id, group: "dérivable (distribution)" })),
  ...["last_team_score", "period1_winner", "period2_winner", "period3_winner",
      "winning_margin", "double_chance"]
    .map(id => ({ id, group: "heuristique (base_prob → S4 ④)" })),
];

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
      {/* S4 ⑤ — l'écart entre les deux estimateurs, celui qui décidera si le
          classifieur peut disparaître. Affiché ici et nulle part ailleurs :
          c'est un outil de dev, pas une information pour le parieur. */}
      {(sample.probability_score_model != null || sample.probability_classifier != null) && (
        <div className="mb-3 flex items-center gap-3 text-[10px]">
          <span className="text-white/50 uppercase tracking-wider">P(dom)</span>
          <span className="text-[#bfc8cc]">
            score <span className="font-mono text-white">{sample.probability_score_model ?? "—"}%</span>
          </span>
          <span className="text-[#bfc8cc]">
            classifieur <span className="font-mono text-white">{sample.probability_classifier ?? "—"}%</span>
          </span>
          {sample.probability_score_model != null && sample.probability_classifier != null && (
            <span className="font-mono"
              style={{ color: Math.abs(sample.probability_score_model - sample.probability_classifier) >= 5 ? "#facc15" : "#4ade80" }}>
              Δ{sample.probability_score_model - sample.probability_classifier > 0 ? "+" : ""}
              {sample.probability_score_model - sample.probability_classifier} pt
            </span>
          )}
        </div>
      )}
      <div>
        <p className="text-[10px] text-white/50 mb-1.5 uppercase tracking-wider">Feature Importances</p>
        {sample.feature_importances.map((fi, i) => (
          <FeatureBar key={i} fi={fi} maxImp={maxImp} />
        ))}
      </div>
    </div>
  );
}

/** Tableau compact générique — utilisé pour tous les ROI et découpages. */
function DataTable({
  columns, rows,
}: {
  columns: Array<{ key: string; label: string; align?: "left" | "right"; color?: (v: any, row: any) => string }>;
  rows: Array<Record<string, any>>;
}) {
  if (!rows.length) return <p className="text-[#bfc8cc]/60 text-xs">Aucune donnée.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-[#bfc8cc]/60 text-[9px] uppercase tracking-wider">
            {columns.map(c => (
              <th key={c.key} className={`pb-2 font-medium ${c.align === "right" ? "text-right" : "text-left"}`}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-white/5">
              {columns.map(c => (
                <td key={c.key}
                  className={`py-1.5 font-mono ${c.align === "right" ? "text-right" : "text-left"}`}
                  style={{ color: c.color ? c.color(r[c.key], r) : "#e6ecee" }}>
                  {r[c.key] ?? "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Courbe de calibration en barres : probabilité annoncée vs taux réalisé.
 *
 * Les deux barres côte à côte plutôt qu'un nuage de points sur la diagonale :
 * l'écart se lit sans savoir lire un diagramme de fiabilité, et les tranches
 * vides restent visibles (une tranche à n=0 est une information — le modèle
 * n'émet jamais dans cette zone).
 */
function CalibrationChart({ rows, minSample }: { rows: Array<PerfBucket & { bucket: string }>; minSample: number }) {
  const maxN = Math.max(...rows.map(r => r.n), 1);
  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => {
        const thin = r.n < Math.max(20, minSample / 20);
        return (
          <div key={r.bucket} className="flex items-center gap-2">
            <span className="text-[10px] text-[#bfc8cc] w-16 flex-shrink-0 font-mono">{r.bucket}</span>
            <div className="flex-1 flex flex-col gap-0.5">
              <div className="h-2 bg-[#0A0E0C] rounded-full overflow-hidden">
                <div className="h-full bg-[#a78bfa]/70 rounded-full"
                  style={{ width: `${r.avg_prob ?? 0}%` }} />
              </div>
              <div className="h-2 bg-[#0A0E0C] rounded-full overflow-hidden">
                <div className="h-full rounded-full"
                  style={{ width: `${r.hit_rate ?? 0}%`, backgroundColor: thin ? "#8a9ea6" : "#4ade80" }} />
              </div>
            </div>
            <span className="text-[10px] font-mono w-24 text-right flex-shrink-0 text-[#bfc8cc]">
              {fmt(r.avg_prob, 0)} → {fmt(r.hit_rate, 0)}
            </span>
            <span className="text-[10px] font-mono w-16 text-right flex-shrink-0"
              style={{ color: thin ? "#8a9ea6" : "#bfc8cc", opacity: 0.4 + 0.6 * (r.n / maxN) }}>
              n={r.n}
            </span>
          </div>
        );
      })}
      <p className="text-[9px] text-[#bfc8cc]/50 mt-1">
        Barre violette = probabilité annoncée · barre verte = taux réalisé. Les
        deux doivent coïncider. Gris = échantillon trop mince pour conclure.
      </p>
    </div>
  );
}

/** Bandeau d'erreur/absence homogène pour les panneaux qui dépendent d'un fetch. */
function PanelState({ loading, error, empty }: { loading: boolean; error: string | null; empty?: string }) {
  if (loading) return <div className="h-24 bg-white/5 rounded-xl animate-pulse" />;
  if (error) return (
    <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-xs">{error}</div>
  );
  return <p className="text-[#bfc8cc]/60 text-xs">{empty ?? "Aucune donnée."}</p>;
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function DevMLDashboard() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();

  const [tab, setTab] = useState<Tab>("service");

  const [info, setInfo]           = useState<MLInfoResponse | null>(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);

  const [reports, setReports]       = useState<MLReportsResponse | null>(null);
  const [reportsLoading, setRepLoading] = useState(false);
  const [reportsError, setRepError] = useState<string | null>(null);

  const [health, setHealth]         = useState<DataHealthResponse | null>(null);
  const [healthLoading, setHLoading] = useState(false);
  const [healthError, setHError]    = useState<string | null>(null);

  const [perf, setPerf]             = useState<LivePerformanceResponse | null>(null);
  const [perfLoading, setPLoading]  = useState(false);
  const [perfError, setPError]      = useState<string | null>(null);
  const [perfDays, setPerfDays]     = useState(365);

  // Live test form
  const [testType, setTestType]         = useState<"game" | "player" | "team">("game");
  const [testTeamId, setTestTeamId]     = useState("bos");
  const [testOppId, setTestOppId]       = useState("nyr");
  const [testPlayerId, setTestPlayerId] = useState("8478402");
  const [testPropType, setTestPropType] = useState("goals");
  const [testMarket, setTestMarket]     = useState("moneyline");
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

  const fetchReports = useCallback(async () => {
    setRepLoading(true);
    setRepError(null);
    try {
      const res = await authedFetch("/dev/ml-reports");
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      setReports(await res.json() as MLReportsResponse);
    } catch (e: any) {
      setRepError(e.message);
    } finally {
      setRepLoading(false);
    }
  }, []);

  const fetchHealth = useCallback(async () => {
    setHLoading(true);
    setHError(null);
    try {
      const res = await authedFetch("/dev/data-health");
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      setHealth(await res.json() as DataHealthResponse);
    } catch (e: any) {
      setHError(e.message);
    } finally {
      setHLoading(false);
    }
  }, []);

  const fetchPerf = useCallback(async (days: number) => {
    setPLoading(true);
    setPError(null);
    try {
      const res = await authedFetch(`/dev/live-performance?days=${days}`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      setPerf(await res.json() as LivePerformanceResponse);
    } catch (e: any) {
      setPError(e.message);
    } finally {
      setPLoading(false);
    }
  }, []);

  useEffect(() => { fetchInfo(); }, [fetchInfo]);

  // Chargement paresseux par onglet : les rapports pèsent ~25 ko et
  // `/live-performance` agrège jusqu'à 50 000 jambes. Les tirer au montage
  // ferait payer les cinq onglets à qui n'en ouvre qu'un.
  useEffect(() => {
    if ((tab === "model" || tab === "backtest") && !reports && !reportsLoading) fetchReports();
    if (tab === "data" && !health && !healthLoading) fetchHealth();
    if (tab === "live" && !perf && !perfLoading) fetchPerf(perfDays);
  }, [tab, reports, reportsLoading, health, healthLoading, perf, perfLoading,
      fetchReports, fetchHealth, fetchPerf, perfDays]);

  /** Le bouton ↻ rafraîchit ce qui est à l'écran, pas tout. */
  function refreshCurrent() {
    if (tab === "service") fetchInfo();
    if (tab === "model" || tab === "backtest") fetchReports();
    if (tab === "data") fetchHealth();
    if (tab === "live") fetchPerf(perfDays);
  }

  async function runTest() {
    setTestLoading(true);
    setTestError(null);
    setTestResult(null);
    try {
      const body: Record<string, unknown> = { type: testType };
      if (testType === "game")   { body.teamId = testTeamId; body.opponentId = testOppId; body.propType = testMarket; }
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
  const anyLoading = loading || reportsLoading || healthLoading || perfLoading;

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: "service",  label: "Service" },
    { id: "data",     label: "Données" },
    { id: "model",    label: "Modèle" },
    { id: "backtest", label: "Backtest" },
    { id: "live",     label: "Live" },
  ];

  return (
    <div className="min-h-screen bg-[#0A0E0C] text-white max-w-[1400px] mx-auto px-4 md:px-6 pb-16">

      {/* Header */}
      <div className="sticky top-0 bg-[#0A0E0C]/90 backdrop-blur-md border-b border-white/8 py-4 mb-5 z-10">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg">🤖</span>
              <span className="text-white font-bold text-base">ML Dashboard</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#a78bfa]/15 border border-[#a78bfa]/30 text-[#a78bfa] font-medium">DEV ONLY</span>
            </div>
            <p className="text-[#bfc8cc] text-[11px] mt-0.5">Admin: {user.email}</p>
          </div>
          <button onClick={refreshCurrent} disabled={anyLoading}
            className="px-3 py-1.5 rounded-xl bg-[#a78bfa]/10 border border-[#a78bfa]/30 text-[#a78bfa] text-xs hover:bg-[#a78bfa]/20 transition-all disabled:opacity-50">
            {anyLoading ? "…" : "↻ Refresh"}
          </button>
        </div>

        {/* Onglets */}
        <div className="flex gap-1 mt-3 overflow-x-auto">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 rounded-lg text-[11px] font-medium whitespace-nowrap transition-all ${
                tab === t.id
                  ? "bg-[#a78bfa] text-[#0A0E0C] font-bold"
                  : "text-[#8a9ea6] hover:text-white hover:bg-white/5"
              }`}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {error && tab === "service" && (
        <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-xs">
          {error}
        </div>
      )}

      {/* ══ ONGLET SERVICE ══════════════════════════════════════════════════ */}
      {tab === "service" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">

          <div className="flex flex-col gap-4">
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

            {info?.samples && (
              <Card title="Startup Samples (BOS vs NYR · Goals 0.5)">
                <div className="flex flex-col gap-3">
                  <SampleCard label="Game — BOS Moneyline" sample={info.samples.game} />
                  <SampleCard label="Player — Goals O/U 0.5" sample={info.samples.player} />
                </div>
              </Card>
            )}
          </div>

          {/* Live Test Form */}
          <Card title="Live Test Prediction">
            <div className="flex bg-white/5 rounded-xl p-0.5 mb-4 gap-0.5">
              {(["game", "player", "team"] as const).map(t => (
                <button key={t} onClick={() => setTestType(t)}
                  className={`flex-1 py-1.5 rounded-lg text-[11px] font-medium transition-all capitalize ${testType === t ? "bg-[#a78bfa] text-[#0A0E0C] font-bold" : "text-[#8a9ea6]"}`}>
                  {t}
                </button>
              ))}
            </div>

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
                <label>
                  <span className="text-[10px] text-[#bfc8cc] mb-1 block">Marché</span>
                  <select value={testMarket} onChange={e => setTestMarket(e.target.value)}
                    className="w-full bg-[#0A0E0C] border border-white/15 rounded-lg px-3 py-2 text-white text-xs focus:outline-none focus:border-[#a78bfa]/60">
                    {[...new Set(TEST_MARKETS.map(m => m.group))].map(g => (
                      <optgroup key={g} label={g}>
                        {TEST_MARKETS.filter(m => m.group === g).map(m => (
                          <option key={m.id} value={m.id}>{m.id}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
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
      )}

      {/* ══ ONGLET DONNÉES ══════════════════════════════════════════════════ */}
      {tab === "data" && (
        <DataTab health={health} loading={healthLoading} error={healthError} reports={reports} />
      )}

      {/* ══ ONGLET MODÈLE ═══════════════════════════════════════════════════ */}
      {tab === "model" && (
        <ModelTab reports={reports} loading={reportsLoading} error={reportsError} />
      )}

      {/* ══ ONGLET BACKTEST ═════════════════════════════════════════════════ */}
      {tab === "backtest" && (
        <BacktestTab reports={reports} loading={reportsLoading} error={reportsError} />
      )}

      {/* ══ ONGLET LIVE ═════════════════════════════════════════════════════ */}
      {tab === "live" && (
        <LiveTab
          perf={perf} loading={perfLoading} error={perfError}
          days={perfDays}
          onDaysChange={(d) => { setPerfDays(d); fetchPerf(d); }}
        />
      )}

      {/* Last retrieved */}
      {info?.retrieved_at && tab === "service" && (
        <p className="text-center text-[10px] text-[#bfc8cc]/40 mt-5">
          Last fetched: {new Date(info.retrieved_at).toLocaleString()}
        </p>
      )}
    </div>
  );
}

// ── Onglet Données ────────────────────────────────────────────────────────────

function DataTab({
  health, loading, error, reports,
}: { health: DataHealthResponse | null; loading: boolean; error: string | null; reports: MLReportsResponse | null }) {
  if (!health) return <PanelState loading={loading} error={error} />;

  const ol = health.odds_log ?? {};
  const q  = health.odds_quota ?? {};
  const s  = health.slips ?? {};
  const sn = health.odds_snapshots ?? {};

  const lastWrite = timeAgo(ol.last_write);
  const quotaAge  = timeAgo(q.observed_at);
  const stateAge  = timeAgo(reports?.runtime?.inference_state_as_of);

  // Une collecte qui n'a rien écrit depuis 2 jours pendant la saison est morte.
  const collectStale = lastWrite.days != null && lastWrite.days > 2;
  const quotaLow     = q.remaining != null && q.remaining < 100;
  const movementPct  = ol.rows ? (100 * (ol.with_ml_movement ?? 0)) / ol.rows : null;

  // 6 passes/jour au calendrier (2 `full` + 4 `spreads`). En dessous, le
  // planificateur ne se replanifie pas — typiquement une instance qui redémarre.
  // À 0 pendant la saison, la série temporelle du CLV ne se constitue pas, et
  // c'est irrattrapable : la cote de clôture d'hier n'existe plus nulle part.
  const snapObserved = timeAgo(sn.last_observed);
  const snapStale    = snapObserved.days != null && snapObserved.days > 2;
  const passesShort  = (sn.passes_today ?? 0) > 0 && (sn.passes_today ?? 0) < 6;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
      <Card title="Collecte des cotes (odds_log)"
            hint="Seule source de cotes récentes : l'archive publique s'arrête en 2022-23 et une cote de clôture manquée ne se rattrape pas.">
        {ol.error ? (
          <p className="text-red-400 text-xs">{ol.error}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-3">
              <Metric label="Matchs journalisés" value={String(ol.rows ?? 0)} />
              <Metric label="Dernière écriture" value={lastWrite.label}
                color={collectStale ? "#facc15" : "#4ade80"} warn={collectStale} />
              <Metric label="Couverture" value={ol.first_date ? `${ol.first_date} → ${ol.last_date}` : "—"} />
              <Metric label="Clôture ML" value={String(ol.with_ml_close ?? 0)} />
              <Metric label="Clôture total" value={String(ol.with_total_close ?? 0)} />
              <Metric label="Clôture puck line" value={String(ol.with_puckline_close ?? 0)} />
            </div>
            <div className="p-3 rounded-xl border border-white/8 bg-[#0A0E0C]/60">
              <p className="text-[9px] uppercase tracking-wider text-[#bfc8cc]/70 mb-1">
                Lignes avec mouvement open ≠ close
              </p>
              <p className="text-lg font-black leading-none"
                 style={{ color: (movementPct ?? 0) > 20 ? "#4ade80" : "#facc15" }}>
                {ol.with_ml_movement ?? 0}
                <span className="text-xs font-normal text-[#bfc8cc]"> · {fmt(movementPct, 1, " %")}</span>
              </p>
              <p className="text-[10px] text-[#bfc8cc]/60 mt-1.5 leading-relaxed">
                Si ce chiffre stagne près de zéro pendant que le volume monte, la
                collecte ne passe qu'une fois par jour : l'ouverture et la clôture
                sont le même prix, et le CLV devient structurellement inmesurable.
              </p>
            </div>
          </>
        )}
      </Card>

      <div className="flex flex-col gap-4">
        <Card title="Quota The Odds API">
          {q.error ? (
            <p className="text-red-400 text-xs">{q.error}</p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              <Metric label="Restant" value={String(q.remaining ?? "—")}
                color={quotaLow ? "#f87171" : "#4ade80"} warn={quotaLow} />
              <Metric label="Consommé" value={String(q.used ?? "—")} />
              <Metric label="Mesuré" value={quotaAge.label} />
            </div>
          )}
        </Card>

        <Card title="État d'inférence & artefacts"
              hint="Ce que le service ML sert vraiment, par opposition à ce qui traîne sur le disque.">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            <Metric label="inference_state as_of" value={reports?.runtime?.inference_state_as_of ?? "—"}
              sub={stateAge.label}
              color={stateAge.days != null && stateAge.days > 14 ? "#facc15" : undefined}
              warn={stateAge.days != null && stateAge.days > 14} />
            <Metric label="Équipes en état" value={String(reports?.runtime?.inference_state_teams ?? "—")} />
            <Metric label="Équipes ELO" value={String(reports?.runtime?.elo_teams ?? "—")} />
          </div>
          {!reports && (
            <p className="text-[10px] text-[#bfc8cc]/50 mt-2">
              Ouvre l'onglet Modèle pour charger les rapports du service ML.
            </p>
          )}
        </Card>

        <Card title="Série temporelle des cotes (odds_snapshots)"
              hint="La table qu'A1bis existe pour remplir. Son échec est SILENCIEUX : insertSnapshots avale son erreur pour ne jamais faire perdre la clôture du jour à odds_log — donc des logs normaux ne prouvent rien, seul ce bloc le fait.">
          {sn.error ? (
            <p className="text-red-400 text-xs">{sn.error}</p>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-3">
                <Metric label="Snapshots" value={String(sn.rows ?? 0)} />
                <Metric label="Passes (24 h)" value={`${sn.passes_today ?? 0} / 6`}
                  color={passesShort ? "#facc15" : (sn.passes_today ?? 0) === 6 ? "#4ade80" : undefined}
                  warn={passesShort} />
                <Metric label="Dernière passe" value={snapObserved.label}
                  color={snapStale ? "#facc15" : undefined} warn={snapStale} />
                <Metric label="Passes full" value={String(sn.rows_full ?? 0)} />
                <Metric label="Passes spreads" value={String(sn.rows_spreads ?? 0)} />
                <Metric label="Avec puck line" value={String(sn.with_puckline ?? 0)}
                  color={(sn.rows ?? 0) > 0 && (sn.with_puckline ?? 0) === 0 ? "#f87171" : undefined}
                  warn={(sn.rows ?? 0) > 0 && (sn.with_puckline ?? 0) === 0} />
              </div>
              <p className="text-[10px] text-[#bfc8cc]/60 leading-relaxed">
                Hors saison, 0 partout est normal : la collecte sort sur le
                garde-fou <code>isSeasonActive()</code> avant d'écrire. Ce qui ne
                l'est pas : « table indisponible » (migration 031 absente), ou un
                compteur à 0 pendant que <em>odds_log</em> monte. « Avec puck
                line » à 0 alors que des lignes existent veut dire que les quatre
                passes <em>spreads</em> ramènent du vide — 4 crédits/jour perdus
                sur le seul marché encore vivant.
              </p>
            </>
          )}
        </Card>

        <Card title="Paris & règlement"
              hint="Un arriéré de tickets en attente veut dire que le job de règlement ne tourne plus — et sans règlement, aucune mesure de performance live.">
          {s.error ? (
            <p className="text-red-400 text-xs">{s.error}</p>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              <Metric label="Tickets total" value={String(s.total ?? 0)} />
              <Metric label="Réglés" value={String(s.settled ?? 0)} />
              <Metric label="En attente" value={String(s.pending ?? 0)} />
              <Metric label="En attente > 2 j" value={String(s.stale_pending ?? 0)}
                color={(s.stale_pending ?? 0) > 0 ? "#facc15" : "#4ade80"}
                warn={(s.stale_pending ?? 0) > 0} />
              <Metric label="Dernier pari" value={timeAgo(s.last_placed).label} />
              <Metric label="Dernier règlement" value={timeAgo(s.last_resolved).label} />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

// ── Onglet Modèle ─────────────────────────────────────────────────────────────

function ModelTab({
  reports, loading, error,
}: { reports: MLReportsResponse | null; loading: boolean; error: string | null }) {
  if (!reports || reports.error) {
    return <PanelState loading={loading} error={error ?? reports?.error ?? null}
      empty="Service ML injoignable — rapports indisponibles." />;
  }

  const gm = reports.reports?.training_report?.game_model;
  const sr = reports.reports?.score_report;
  const rt = reports.runtime;

  // Importances : le rapport les stocke soit en objets {name, importance},
  // soit en paires [nom, poids] selon la version du script d'entraînement.
  const rawImp = gm?.feature_importances ?? [];
  const imps: FeatureImportance[] = (rawImp as any[]).map((f) =>
    Array.isArray(f)
      ? { name: String(f[0]), importance: Number(f[1]), direction: "positive" as const }
      : { name: f.name ?? f.feature ?? "?", importance: Number(f.importance ?? f.gain ?? 0), direction: f.direction ?? "positive" },
  ).filter(f => Number.isFinite(f.importance));
  const maxImp = Math.max(...imps.map(f => f.importance), 0.001);

  const artifacts = Object.entries(reports.artifacts ?? {});

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">

      <Card title="Modèle de match (moneyline)"
            hint="Le skill score compare le modèle à une prédiction constante ; c'est lui, pas l'accuracy, qui dit s'il apprend quelque chose.">
        {gm ? (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-3">
              <Metric label="Log loss (test)" value={fmt(gm.log_loss, 4)} />
              <Metric label="Log loss (val)" value={fmt(gm.val_log_loss, 4)} />
              <Metric label="Brier" value={fmt(gm.brier_score, 4)} />
              <Metric label="Accuracy" value={fmt(gm.accuracy != null ? gm.accuracy * 100 : null, 1, " %")} />
              <Metric label="Skill score" value={fmt(gm.skill_score, 4)}
                color={signColor(gm.skill_score)} />
              <Metric label="Best iteration" value={String(gm.best_iteration ?? "—")} />
            </div>
            <div className="grid grid-cols-3 gap-2 mb-3">
              <Metric label="Train" value={String(gm.n_train ?? "—")} />
              <Metric label="Val" value={String(gm.n_val ?? "—")} />
              <Metric label="Test" value={String(gm.n_test ?? "—")} />
            </div>
            <div className="flex flex-wrap gap-2 text-[10px]">
              <span className="px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-[#bfc8cc]">
                {gm.model ?? "—"}
              </span>
              <span className="px-2 py-1 rounded-lg bg-white/5 border border-white/10"
                    style={{ color: rt?.calibrated ? "#4ade80" : "#facc15" }}>
                calibration {gm.calibration?.method ?? "aucune"}{rt?.calibrated ? " · active" : " · non chargée"}
              </span>
              {rt?.blend_weights && (
                <span className="px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-[#a78bfa]">
                  blend w = [{rt.blend_weights.map(w => w.toFixed(2)).join(", ")}]
                </span>
              )}
              <span className="px-2 py-1 rounded-lg bg-white/5 border border-white/10 text-[#bfc8cc]">
                taux victoire domicile {fmt(gm.home_win_rate != null ? gm.home_win_rate * 100 : null, 1, " %")}
              </span>
            </div>
            {gm.baselines && (
              <div className="mt-3 pt-3 border-t border-white/8">
                <p className="text-[9px] uppercase tracking-wider text-[#bfc8cc]/70 mb-1.5">Baselines</p>
                <pre className="text-[10px] text-[#bfc8cc] font-mono overflow-x-auto whitespace-pre-wrap">
                  {JSON.stringify(gm.baselines, null, 1)}
                </pre>
              </div>
            )}
          </>
        ) : <p className="text-[#bfc8cc]/60 text-xs">training_report.json absent.</p>}
      </Card>

      <Card title="Modèle de score (totaux & puck line)"
            hint="Les totaux ne sont plus pricés par un modèle dédié mais par la distribution de score empilée.">
        {sr ? (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mb-3">
              <Metric label="Modèle" value={sr.model ?? "—"} />
              <Metric label="Train" value={String(sr.n_train ?? "—")} />
              <Metric label="Test" value={String(sr.n_test ?? "—")} />
              <Metric label="P(OT domicile)" value={fmt(sr.p_ot_home, 3)} />
              <Metric label="Membres ensemble" value={`${rt?.score_ensemble_members_loaded ?? 0} chargés`}
                sub={`${rt?.score_ensemble_files_on_disk ?? 0} sur disque`}
                color={(rt?.score_ensemble_members_loaded ?? 0) === 0 ? "#8a9ea6" : "#4ade80"} />
              <Metric label="σ max" value={fmt(rt?.sigma_max, 4)} />
            </div>
            {sr.test && (
              <div className="pt-3 border-t border-white/8">
                <p className="text-[9px] uppercase tracking-wider text-[#bfc8cc]/70 mb-1.5">Test</p>
                <pre className="text-[10px] text-[#bfc8cc] font-mono overflow-x-auto whitespace-pre-wrap">
                  {JSON.stringify(sr.test, null, 1)}
                </pre>
              </div>
            )}
            {(rt?.score_ensemble_files_on_disk ?? 0) === 0 && (
              <p className="mt-2 text-[10px] text-[#facc15]/90 leading-relaxed">
                Aucun membre d'ensemble embarqué : σ (probability_std) reste nul en
                production. C'est volontaire — l'ensemble est exclu de l'image ML.
              </p>
            )}
          </>
        ) : <p className="text-[#bfc8cc]/60 text-xs">score_report.json absent.</p>}
      </Card>

      <Card title="Importance des features (modèle de match)"
            hint="Top 25, telles qu'écrites par le script d'entraînement — pas celles d'une prédiction ponctuelle.">
        {imps.length
          ? imps.map((fi, i) => <FeatureBar key={i} fi={fi} maxImp={maxImp} />)
          : <p className="text-[#bfc8cc]/60 text-xs">Aucune importance dans le rapport.</p>}
      </Card>

      <Card title="Fraîcheur des artefacts"
            hint="Un modèle plus vieux que l'état d'inférence sert des features qu'il n'a jamais vues à l'entraînement.">
        <DataTable
          columns={[
            { key: "name",  label: "Fichier" },
            { key: "age",   label: "Modifié", align: "right" },
            { key: "size",  label: "Taille",  align: "right" },
          ]}
          rows={artifacts.map(([name, meta]) => {
            const age = timeAgo(meta.modified_at);
            return {
              name: meta.present ? name : `${name} (absent)`,
              age: age.label,
              size: bytes(meta.bytes),
            };
          })}
        />
        {reports.report_errors && Object.keys(reports.report_errors).length > 0 && (
          <div className="mt-3 p-2 rounded-lg bg-red-500/10 border border-red-500/30">
            <p className="text-[10px] text-red-400 font-bold mb-1">Rapports illisibles</p>
            {Object.entries(reports.report_errors).map(([k, v]) => (
              <p key={k} className="text-[10px] text-red-400/80 font-mono">{k} : {v}</p>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Onglet Backtest ───────────────────────────────────────────────────────────

function BacktestTab({
  reports, loading, error,
}: { reports: MLReportsResponse | null; loading: boolean; error: string | null }) {
  if (!reports || reports.error) {
    return <PanelState loading={loading} error={error ?? reports?.error ?? null}
      empty="Service ML injoignable — rapports indisponibles." />;
  }

  const wf  = reports.reports?.backtest_walkforward_report;
  const der = reports.reports?.backtest_derived_report;
  const unc = reports.reports?.backtest_uncertainty_report;

  const roiCols = [
    { key: "edge",     label: "Edge" },
    { key: "n_bets",   label: "N paris", align: "right" as const },
    { key: "hit_rate", label: "Hit %",   align: "right" as const },
    { key: "roi",      label: "ROI plat %", align: "right" as const,
      color: (_: any, r: any) => signColor(r._roi) },
    { key: "extra",    label: "",        align: "right" as const },
  ];

  const roiRows = (rows: RoiRow[] | undefined) => (rows ?? []).map(r => ({
    edge: `${(r.edge * 100).toFixed(0)} %`,
    n_bets: r.n_bets + (r.n_push ? ` (+${r.n_push} push)` : ""),
    hit_rate: fmt(r.hit_rate, 2),
    roi: fmt(r.roi_flat_pct, 2),
    _roi: r.roi_flat_pct,
    extra: r.roi_kelly_pct != null
      ? `kelly ${fmt(r.roi_kelly_pct, 2)} %`
      : r.z != null ? `z = ${fmt(r.z, 2)}` : "",
  }));

  // Le modèle bat-il le marché ? Écart de log-loss, en points de base.
  const edgeVsMarket = wf?.log_loss ? wf.log_loss.market - wf.log_loss.model : null;

  return (
    <div className="flex flex-col gap-4">

      <Card title="Walk-forward — moneyline"
            hint="Réentraînement saison par saison, jamais de fuite du futur. La comparaison au marché est le seul juge qui compte.">
        {wf ? (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
              <Metric label="Saisons" value={wf.seasons?.length ? `${wf.seasons[0]}–${wf.seasons[wf.seasons.length - 1]}` : "—"} />
              <Metric label="Matchs avec cotes" value={String(wf.n_games_with_odds ?? "—")} />
              <Metric label="Log loss modèle" value={fmt(wf.log_loss?.model, 4)} />
              <Metric label="Log loss marché" value={fmt(wf.log_loss?.market, 4)}
                sub={edgeVsMarket != null
                  ? `${edgeVsMarket > 0 ? "modèle devant" : "marché devant"} de ${Math.abs(edgeVsMarket).toFixed(4)}`
                  : undefined}
                color={signColor(edgeVsMarket)} />
            </div>
            <DataTable columns={roiCols} rows={roiRows(wf.roi)} />
            <p className="text-[10px] text-[#bfc8cc]/50 mt-2 leading-relaxed">
              Un ROI qui se dégrade quand le seuil d'edge monte est le signe qu'on
              sélectionne du bruit : les « gros edges » sont surtout des erreurs de
              modèle, pas des erreurs de marché.
            </p>
          </>
        ) : <p className="text-[#bfc8cc]/60 text-xs">backtest_walkforward_report.json absent.</p>}
      </Card>

      <Card title="Marchés dérivés"
            hint="Totaux et puck line, pricés par la distribution de score. Le z indique si le ROI se distingue de zéro.">
        {der?.markets ? (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            {/* Ne garder que les entrées qui SONT des tableaux de lignes de ROI.
                `backtest_derived_report.json` contient aussi
                `puckline_diagnostics`, un objet (seuil, by_season, by_leg,
                dissection) ajouté par le run A2 — le passer à `roiRows` faisait
                planter tout l'onglet avec « (rows ?? []).map is not a function ».
                Filtrer plutôt que lister les clés connues : un diagnostic ajouté
                plus tard sera ignoré au lieu de casser la page. */}
            {Object.entries(der.markets)
              .filter((e): e is [string, RoiRow[]] => Array.isArray(e[1]))
              .map(([market, rows]) => (
              <div key={market}>
                <p className="text-white text-xs font-bold mb-2 capitalize">{market}</p>
                <DataTable columns={roiCols} rows={roiRows(rows)} />
              </div>
            ))}
          </div>
        ) : <p className="text-[#bfc8cc]/60 text-xs">backtest_derived_report.json absent.</p>}
      </Card>

      {unc && (
        <Card title="Incertitude & dimensionnement"
              hint="Comparaison des règles de mise sur le même flux de paris, et fiabilité de σ comme signal de réduction.">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
            <Metric label="Paris" value={String(unc.n_bets ?? "—")} />
            <Metric label="Seuil d'edge" value={fmt(unc.edge_threshold != null ? unc.edge_threshold * 100 : null, 0, " %")} />
            <Metric label="Membres" value={String(unc.n_members ?? "—")} />
            <Metric label="p-value (perm.)" value={fmt(unc.sigma_vs_flat?.permutation_p_value, 3)}
              sub="σ vs mise plate"
              color={(unc.sigma_vs_flat?.permutation_p_value ?? 1) < 0.05 ? "#4ade80" : "#facc15"} />
          </div>

          {unc.sizing && (
            <div className="mb-4">
              <p className="text-[9px] uppercase tracking-wider text-[#bfc8cc]/70 mb-1.5">Règles de mise</p>
              <DataTable
                columns={[
                  { key: "rule",     label: "Règle" },
                  { key: "final",    label: "Bankroll finale", align: "right",
                    color: (_: any, r: any) => (r._final >= 1 ? "#4ade80" : "#f87171") },
                  { key: "drawdown", label: "Drawdown max", align: "right" },
                  { key: "staked",   label: "Total misé", align: "right" },
                ]}
                rows={Object.entries(unc.sizing).map(([rule, v]) => ({
                  rule,
                  final: fmt(v.final_bankroll, 4),
                  _final: v.final_bankroll,
                  drawdown: fmt(v.max_drawdown != null ? v.max_drawdown * 100 : null, 1, " %"),
                  staked: fmt(v.total_staked, 1),
                }))}
              />
            </div>
          )}

          {unc.sigma_buckets && (
            <>
              <p className="text-[9px] uppercase tracking-wider text-[#bfc8cc]/70 mb-1.5">
                Edge annoncé vs réalisé, par tranche de σ
              </p>
              <DataTable
                columns={[
                  { key: "bucket",    label: "σ" },
                  { key: "n",         label: "N", align: "right" },
                  { key: "sigma",     label: "σ moyen", align: "right" },
                  { key: "predicted", label: "Edge annoncé", align: "right" },
                  { key: "realized",  label: "Edge réalisé", align: "right",
                    color: (_: any, r: any) => signColor(r._realized) },
                  { key: "gap",       label: "Écart", align: "right",
                    color: (_: any, r: any) => signColor(r._gap) },
                ]}
                rows={unc.sigma_buckets.map(b => ({
                  bucket: `#${b.bucket}`,
                  n: b.n,
                  sigma: fmt(b.sigma_mean, 4),
                  predicted: fmt(b.edge_predicted * 100, 2, " %"),
                  realized: fmt(b.edge_realized * 100, 2, " %"),
                  _realized: b.edge_realized,
                  gap: fmt(b.gap * 100, 2, " %"),
                  _gap: b.gap,
                }))}
              />
              <p className="text-[10px] text-[#bfc8cc]/50 mt-2 leading-relaxed">
                Un écart qui se creuse avec σ veut dire que l'edge annoncé n'est
                pas de l'edge mais de l'incertitude : plus le modèle hésite, plus
                il croit avoir trouvé quelque chose.
              </p>
            </>
          )}
        </Card>
      )}
    </div>
  );
}

// ── Onglet Live ───────────────────────────────────────────────────────────────

function LiveTab({
  perf, loading, error, days, onDaysChange,
}: {
  perf: LivePerformanceResponse | null;
  loading: boolean;
  error: string | null;
  days: number;
  onDaysChange: (d: number) => void;
}) {
  const WINDOWS = [30, 90, 365, 1825];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider text-[#bfc8cc]/70">Fenêtre</span>
        {WINDOWS.map(d => (
          <button key={d} onClick={() => onDaysChange(d)} disabled={loading}
            className={`px-3 py-1 rounded-lg text-[11px] transition-all disabled:opacity-50 ${
              days === d ? "bg-[#a78bfa] text-[#0A0E0C] font-bold" : "bg-white/5 text-[#8a9ea6] hover:text-white"
            }`}>
            {d >= 365 ? `${Math.round(d / 365)} an${d >= 730 ? "s" : ""}` : `${d} j`}
          </button>
        ))}
      </div>

      {!perf ? <PanelState loading={loading} error={error} /> : (
        <>
          {perf.n_legs < perf.min_sample && (
            <div className="p-3 rounded-xl border border-[#facc15]/40 bg-[#facc15]/5">
              <p className="text-[#facc15] text-xs font-bold mb-1">Échantillon insuffisant</p>
              <p className="text-[#bfc8cc] text-[11px] leading-relaxed">
                {perf.n_legs} jambes réglées sur cette fenêtre, plancher fixé à {perf.min_sample}.
                Les chiffres ci-dessous sont affichés pour suivre la collecte, pas
                pour en conclure quoi que ce soit — à ce volume, le bruit domine
                largement tout écart réel.
              </p>
            </div>
          )}

          <Card title="Vue d'ensemble"
                hint="Mesuré sur les jambes réglées (result ∈ win/loss), pas sur l'outcome des tickets : une jambe est une observation, un combiné n'en est qu'une seule.">
            <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-2">
              <Metric label="Jambes réglées" value={String(perf.n_legs)}
                sub={perf.truncated ? "tronqué à 50 000" : undefined}
                warn={perf.truncated} />
              <Metric label="Hit rate" value={fmt(perf.overall.hit_rate, 2, " %")} />
              <Metric label="Prob. moyenne annoncée" value={fmt(perf.overall.avg_prob, 2, " %")}
                sub={perf.overall.hit_rate != null && perf.overall.avg_prob != null
                  ? `écart ${(perf.overall.hit_rate - perf.overall.avg_prob).toFixed(2)} pt`
                  : undefined}
                color={perf.overall.hit_rate != null && perf.overall.avg_prob != null
                  ? signColor(perf.overall.hit_rate - perf.overall.avg_prob)
                  : undefined} />
              <Metric label="ROI plat" value={fmt(perf.overall.roi_flat_pct, 2, " %")}
                sub={`${perf.overall.n_priced} jambes avec prix`}
                color={signColor(perf.overall.roi_flat_pct)} />
              <Metric label="Brier" value={fmt(perf.brier, 4)} sub={`n=${perf.n_scored}`} />
              <Metric label="Log loss" value={fmt(perf.log_loss, 4)} />
            </div>
            {(perf.n_unpriced > 0 || perf.n_unparseable_prob > 0) && (
              <p className="text-[10px] text-[#bfc8cc]/50 mt-3 leading-relaxed">
                {perf.n_unpriced} jambe(s) sans prix lisible — exclues du ROI, jamais
                comptées comme du 100 · {perf.n_unparseable_prob} sans probabilité
                exploitable — exclues de la calibration.
              </p>
            )}
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
            <Card title="Calibration en production"
                  hint="Le diagnostic qui ne dépend d'aucune cote : quand le modèle annonce 70 %, ça passe combien de fois ?">
              <CalibrationChart rows={perf.calibration} minSample={perf.min_sample} />
            </Card>

            <div className="flex flex-col gap-4">
              <Card title="Simple vs combiné"
                    hint="Les jambes de combinés sont choisies autrement (on cherche du gros prix) ; les moyenner ensemble décrit une stratégie qui n'existe pas.">
                <DataTable
                  columns={[
                    { key: "kind",  label: "Type" },
                    { key: "n",     label: "N", align: "right" },
                    { key: "hit",   label: "Hit %", align: "right" },
                    { key: "prob",  label: "Annoncé %", align: "right" },
                    { key: "roi",   label: "ROI plat %", align: "right",
                      color: (_: any, r: any) => signColor(r._roi) },
                  ]}
                  rows={[
                    { kind: "Simple",  b: perf.singles },
                    { kind: "Combiné", b: perf.parlays },
                  ].map(({ kind, b }) => ({
                    kind, n: b.n,
                    hit: fmt(b.hit_rate, 2),
                    prob: fmt(b.avg_prob, 2),
                    roi: fmt(b.roi_flat_pct, 2),
                    _roi: b.roi_flat_pct,
                  }))}
                />
              </Card>

              <Card title="CLV">
                <div className="p-3 rounded-xl border border-[#facc15]/30 bg-[#facc15]/5">
                  <p className="text-[#facc15] text-xs font-bold mb-1.5">Non mesurable en l'état</p>
                  <p className="text-[#bfc8cc] text-[11px] leading-relaxed">
                    {perf.clv.reason}
                  </p>
                  <p className="text-[#bfc8cc]/60 text-[10px] mt-2 leading-relaxed">
                    Le CLV converge bien plus vite qu'un ROI et reste lisible sur
                    quelques centaines de paris — c'est la mesure qui manque le plus
                    ici, et elle demande une écriture de plus à la soumission, pas
                    un affichage.
                  </p>
                </div>
              </Card>
            </div>
          </div>

          <Card title="Par marché"
                hint="Trié par volume. Un marché à faible N n'est pas un résultat, c'est une piste.">
            <DataTable
              columns={[
                { key: "market", label: "Marché" },
                { key: "n",      label: "N", align: "right" },
                { key: "hit",    label: "Hit %", align: "right" },
                { key: "prob",   label: "Annoncé %", align: "right" },
                { key: "gap",    label: "Écart pt", align: "right",
                  color: (_: any, r: any) => signColor(r._gap) },
                { key: "roi",    label: "ROI plat %", align: "right",
                  color: (_: any, r: any) => signColor(r._roi) },
              ]}
              rows={Object.entries(perf.by_market).map(([market, b]) => ({
                market,
                n: b.n,
                hit: fmt(b.hit_rate, 2),
                prob: fmt(b.avg_prob, 2),
                gap: b.hit_rate != null && b.avg_prob != null ? (b.hit_rate - b.avg_prob).toFixed(2) : "—",
                _gap: b.hit_rate != null && b.avg_prob != null ? b.hit_rate - b.avg_prob : null,
                roi: fmt(b.roi_flat_pct, 2),
                _roi: b.roi_flat_pct,
              }))}
            />
          </Card>

          <p className="text-center text-[10px] text-[#bfc8cc]/40">
            Fenêtre {perf.window_days} j · dernière mesure {new Date(perf.retrieved_at).toLocaleString()}
          </p>
        </>
      )}
    </div>
  );
}
