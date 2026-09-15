/** devml/LiveTab.tsx — onglet « Live » du dashboard ML (`../DevMLDashboard.tsx`). */

import { CalibrationChart, Card, DataTable, Metric, PanelState, fmt, signColor } from "./shared";
import type { LivePerformanceResponse } from "./shared";

// ── Onglet Live ───────────────────────────────────────────────────────────────

export function LiveTab({
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
