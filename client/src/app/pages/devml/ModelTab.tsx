/** devml/ModelTab.tsx — onglet « Modèle » du dashboard ML (`../DevMLDashboard.tsx`). */

import {
  Card,
  DataTable,
  FeatureBar,
  Metric,
  PanelState,
  bytes,
  fmt,
  signColor,
  timeAgo,
} from "./shared";
import type { FeatureImportance, MLReportsResponse } from "./shared";

// ── Onglet Modèle ─────────────────────────────────────────────────────────────

export function ModelTab({
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
