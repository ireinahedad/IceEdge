/** devml/BacktestTab.tsx — onglet « Backtest » du dashboard ML (`../DevMLDashboard.tsx`). */

import { Card, DataTable, Metric, PanelState, fmt, signColor } from "./shared";
import type { MLReportsResponse, RoiRow } from "./shared";

// ── Onglet Backtest ───────────────────────────────────────────────────────────

export function BacktestTab({
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
