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
 *
 * Découpé le 2026-09-15 (1473 lignes) : ce fichier garde la page et l'onglet
 * Service ; types, utilitaires et petits composants vivent dans
 * `devml/shared.tsx`, les quatre autres onglets dans `devml/<Onglet>Tab.tsx`.
 */

import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../context/AuthContext";
import { authedFetch } from "../services/authService";
import { Card, SampleCard, StatusDot, TEST_MARKETS } from "./devml/shared";
import type {
  DataHealthResponse,
  LivePerformanceResponse,
  MLInfoResponse,
  MLReportsResponse,
  Tab,
  TestResult,
} from "./devml/shared";
import { BacktestTab } from "./devml/BacktestTab";
import { DataTab } from "./devml/DataTab";
import { LiveTab } from "./devml/LiveTab";
import { ModelTab } from "./devml/ModelTab";

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
  //
  // ⚠️ La condition exclut l'ÉCHEC, et pas seulement « déjà chargé » / « en
  // cours ». Sans `!reportsError` (etc.), un échec laissait `reports` à `null`
  // et faisait repasser `reportsLoading` à `false` : la dépendance changeait,
  // l'effet repartait, et ainsi de suite — mesuré le 2026-09-16 à 29 requêtes/s
  // sur un 404 (routes dev non montées en prod) et 488 tentatives/s hors ligne,
  // jusqu'à mettre tout le compte admin en 429. Après un échec, seul le bouton
  // ↻ (`refreshCurrent`) réessaie : c'est la règle de `services/http.ts`.
  useEffect(() => {
    if ((tab === "model" || tab === "backtest") && !reports && !reportsLoading && !reportsError) fetchReports();
    if (tab === "data" && !health && !healthLoading && !healthError) fetchHealth();
    if (tab === "live" && !perf && !perfLoading && !perfError) fetchPerf(perfDays);
  }, [tab, reports, reportsLoading, reportsError, health, healthLoading, healthError,
      perf, perfLoading, perfError, fetchReports, fetchHealth, fetchPerf, perfDays]);

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
