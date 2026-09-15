/**
 * devml/shared.tsx — types des réponses /dev/*, utilitaires de format et petits
 * composants communs aux onglets du dashboard ML (`../DevMLDashboard.tsx`).
 */

import { pctColor } from "../../data/pctScale";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FeatureImportance {
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

export interface MLInfoResponse {
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

export interface TestResult {
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
export interface RoiRow {
  edge: number;
  n_bets: number;
  n_push?: number;
  hit_rate: number;
  roi_flat_pct: number;
  roi_kelly_pct?: number;
  roi_se_pct?: number;
  z?: number;
}

export interface MLReportsResponse {
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

export interface DataHealthResponse {
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

export interface LivePerformanceResponse {
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

export type Tab = "service" | "data" | "model" | "backtest" | "live";

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
export function signColor(v: number | null | undefined, invert = false) {
  if (v == null) return "#8a9ea6";
  const good = invert ? v < 0 : v > 0;
  if (v === 0) return "#8a9ea6";
  return good ? "#4ade80" : "#f87171";
}

export function fmt(v: number | null | undefined, digits = 2, suffix = "") {
  return v == null || Number.isNaN(v) ? "—" : `${v.toFixed(digits)}${suffix}`;
}

/** « il y a 3 j » — la seule façon de voir d'un coup d'œil qu'un job est mort. */
export function timeAgo(iso: string | null | undefined): { label: string; days: number | null } {
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

export function bytes(n: number | null | undefined) {
  if (n == null) return "—";
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

// ── Sub-components ────────────────────────────────────────────────────────────

export function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${ok ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
  );
}

export function Card({ title, children, hint }: { title: string; children: React.ReactNode; hint?: string }) {
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
export function Metric({
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

export function FeatureBar({ fi, maxImp }: { fi: FeatureImportance; maxImp: number }) {
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
export const TEST_MARKETS: Array<{ id: string; group: string }> = [
  ...["moneyline", "puck_line", "total_goals", "both_teams_score"]
    .map(id => ({ id, group: "dérivable (distribution)" })),
  ...["last_team_score", "period1_winner", "period2_winner", "period3_winner",
      "winning_margin", "double_chance"]
    .map(id => ({ id, group: "heuristique (base_prob → S4 ④)" })),
];

export function SampleCard({ label, sample }: { label: string; sample: MLSample | null }) {
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
export function DataTable({
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
export function CalibrationChart({ rows, minSample }: { rows: Array<PerfBucket & { bucket: string }>; minSample: number }) {
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
export function PanelState({ loading, error, empty }: { loading: boolean; error: string | null; empty?: string }) {
  if (loading) return <div className="h-24 bg-white/5 rounded-xl animate-pulse" />;
  if (error) return (
    <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-xs">{error}</div>
  );
  return <p className="text-[#bfc8cc]/60 text-xs">{empty ?? "Aucune donnée."}</p>;
}
