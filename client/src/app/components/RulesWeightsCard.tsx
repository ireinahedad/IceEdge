/**
 * RulesWeightsCard.tsx
 * Section « paramètres » repliable : réglage des poids des facteurs des règles.
 * Pie chart de la répartition + saisie manuelle (nombre + mini-curseur) par facteur.
 * Persisté en localStorage et synchronisé au compte.
 */
import { useState, useEffect } from "react";
import { toast } from "sonner";
import {
  FactorWeights,
  DEFAULT_WEIGHTS,
  WEIGHT_META,
  getWeights,
  saveWeights,
  resetWeights,
  applyServerWeights,
  FACTOR_COLORS,
} from "../services/ruleWeightsService";
import { profileApiService } from "../services/userService";
import { FactorPie } from "./FactorPie";

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

export function RulesWeightsCard({ serverWeights }: { serverWeights?: Record<string, number> | null }) {
  const [open, setOpen] = useState(true);
  const [w, setW] = useState<FactorWeights>(() =>
    serverWeights ? { ...DEFAULT_WEIGHTS, ...serverWeights } : getWeights(),
  );

  // Le profil se charge de façon asynchrone : hydrate localStorage + état.
  useEffect(() => {
    if (serverWeights !== undefined) {
      applyServerWeights(serverWeights);
      setW(serverWeights ? { ...DEFAULT_WEIGHTS, ...serverWeights } : { ...DEFAULT_WEIGHTS });
    }
  }, [serverWeights]);

  const total = (Object.values(w) as number[]).reduce((s, v) => s + v, 0);
  const overLimit = total > 1.0001;

  function update(id: keyof FactorWeights, value: number) {
    setW((prev) => ({ ...prev, [id]: clamp01(value) }));
  }
  function handleSave() {
    if (overLimit) {
      toast.error(`La somme des poids (${total.toFixed(2)}) dépasse 1. Réduis-les avant d’enregistrer.`);
      return;
    }
    saveWeights(w);
    profileApiService.updateProfile({ ruleWeights: w }).catch(() => {
      toast.error("Enregistré sur cet appareil, mais échec de la sync au compte.");
    });
    toast.success("Pondérations enregistrées. Elles s’appliquent aux prochaines prédictions.");
  }
  function handleReset() {
    resetWeights();
    setW({ ...DEFAULT_WEIGHTS });
    profileApiService.updateProfile({ ruleWeights: null }).catch(() => {});
    toast.success("Pondérations réinitialisées aux valeurs recommandées.");
  }

  return (
    <div id="rules-weights" className="icy-card rounded-2xl p-4 flex flex-col gap-3 scroll-mt-24">
      {/* En-tête repliable */}
      <button onClick={() => setOpen((v) => !v)} className="flex items-center justify-between w-full">
        <span className="text-white text-xs font-medium">Pondération des règles</span>
        <span className="text-white/40 text-xs">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <>
          <p className="text-white/50 text-[10px] leading-relaxed">
            Ces poids ne s’appliquent qu’aux prédictions de <span className="text-white/80 font-semibold">résultat du match</span> (victoire d’une équipe). Les props de joueur (buts, passes, tirs…) reposent sur le taux propre du joueur et ne sont pas affectées.
          </p>

          <div className="rounded-xl bg-[#86d1ea]/10 border border-[#86d1ea]/30 p-2.5">
            <p className="text-[#86d1ea] text-[10px] leading-relaxed">
              ⚠️ Les valeurs par défaut ont été retenues après des tests sur des
              données historiques comme offrant les meilleurs résultats. Les
              modifier peut dégrader la fiabilité.
            </p>
          </div>

          {/* Pie (sans légende) + saisie manuelle à côté */}
          <div className="flex gap-3 items-start">
            <FactorPie
              hideLegend
              size={116}
              thickness={18}
              slices={WEIGHT_META.map((m) => ({ label: m.label, value: w[m.id], color: FACTOR_COLORS[m.id] }))}
            />

            <div className="flex-1 flex flex-col gap-1.5 min-w-0">
              {WEIGHT_META.map((m) => (
                <div key={m.id} className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: FACTOR_COLORS[m.id] }} />
                  <span className="text-white/80 text-[10px] flex-1 truncate">{m.label}</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={w[m.id]}
                    onChange={(e) => update(m.id, Number(e.target.value))}
                    className="w-12 accent-[#86d1ea] flex-shrink-0"
                  />
                  <input
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={w[m.id]}
                    onChange={(e) => update(m.id, Number(e.target.value))}
                    className="w-12 flex-shrink-0 bg-black/20 border border-white/25 rounded px-1 py-0.5 text-[10px] text-white text-right outline-none focus:border-[#90C9F0]/60"
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-[10px] font-semibold tabular-nums ${overLimit ? "text-red-400" : "text-white/50"}`}>
              Total : {total.toFixed(2)} / 1.00
            </span>
            {overLimit && (
              <span className="text-red-400 text-[9px]">la somme ne doit pas dépasser 1</span>
            )}
            <span className="flex-1" />
            <button
              onClick={handleSave}
              disabled={overLimit}
              className="px-3 py-1.5 rounded-lg text-[11px] font-bold disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: "#86d1ea", color: "#0A0E0C" }}
            >
              Enregistrer
            </button>
            <button
              onClick={handleReset}
              className="px-3 py-1.5 rounded-lg text-[11px] font-semibold text-white/70 border border-white/20 hover:text-white"
            >
              Réinitialiser
            </button>
          </div>
        </>
      )}
    </div>
  );
}
