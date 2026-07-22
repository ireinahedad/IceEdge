/**
 * RuleFactorEditor.tsx
 * Carte « Règles » d'un pari : score = moyenne pondérée des facteurs de sa
 * famille. La section « Pondération » (repliable, fermée par défaut) montre
 * d'ABORD le pie de décomposition (voir la pondération), puis les curseurs
 * (la modifier). Poids propres à chaque famille, persistés en localStorage.
 */
import { useState, useRef, useEffect } from "react";
import { toast } from "sonner";
import { FactorPie } from "./FactorPie";
import { FramedLabel } from "./brand/FramedLabel";
import {
  SimpleFactor,
  factorColor,
  getFamilyWeights,
  saveFamilyWeights,
  resetFamilyWeights,
  blendFactors,
} from "../services/ruleWeightsService";

export function RuleFactorEditor({
  factors,
  factorGroup,
  label,
}: {
  factors: SimpleFactor[];
  factorGroup: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [weights, setWeights] = useState<Record<string, number>>(() => getFamilyWeights(factorGroup, factors));
  const sectionRef = useRef<HTMLDivElement>(null);

  // Défile la section à l'écran quand on l'ouvre.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 60);
      return () => clearTimeout(t);
    }
  }, [open]);

  const blended = blendFactors(factors, weights);
  const total = factors.reduce((s, f) => s + (weights[f.id] ?? f.weight), 0);
  const overLimit = total > 100.0001;
  const pctColor = blended >= 65 ? "#4ade80" : blended >= 50 ? "#86d1ea" : blended >= 38 ? "#facc15" : "#f87171";

  const slices = factors.map((f) => ({
    label: f.label,
    value: (weights[f.id] ?? f.weight) * f.value,
    color: factorColor(f.id),
    sub: `${Math.round(f.value * 100)}%`,
  }));

  function setW(id: string, v: number) {
    setWeights((prev) => ({ ...prev, [id]: Math.max(0, Math.min(100, Number.isFinite(v) ? v : 0)) }));
  }
  /**
   * Coche/décoche un facteur.
   * Décocher : son poids est redistribué au prorata entre les facteurs restants.
   * Recocher : il reprend son poids par défaut, repris au prorata sur les autres
   * (le total reste inchangé).
   */
  function toggleFactor(f: SimpleFactor) {
    setWeights((prev) => {
      const get = (o: SimpleFactor) => prev[o.id] ?? o.weight;
      const cur = get(f);
      const next: Record<string, number> = { ...prev };
      const others = factors.filter((o) => o.id !== f.id && get(o) > 0);
      const sum = others.reduce((s, o) => s + get(o), 0);

      if (cur > 0) {
        // Exclure → redistribue `cur` proportionnellement aux poids des autres.
        if (sum > 0) {
          let rest = cur;
          others.forEach((o, i) => {
            const share = i === others.length - 1 ? rest : Math.round(cur * (get(o) / sum));
            next[o.id] = Math.min(100, get(o) + share);
            rest -= share;
          });
        }
        next[f.id] = 0;
      } else {
        // Réinclure → reprend son poids par défaut au prorata sur les autres.
        const take = Math.min(f.weight, sum);
        if (sum > 0) {
          let rest = take;
          others.forEach((o, i) => {
            const share = i === others.length - 1 ? rest : Math.round(take * (get(o) / sum));
            next[o.id] = Math.max(0, get(o) - share);
            rest -= share;
          });
        }
        next[f.id] = take > 0 ? take : f.weight;
      }
      return next;
    });
  }
  function handleSave() {
    if (overLimit) { toast.error(`La somme des poids (${Math.round(total)}) dépasse 100.`); return; }
    saveFamilyWeights(factorGroup, weights);
    toast.success("Pondération enregistrée pour ce type de pari.");
  }
  function handleReset() {
    resetFamilyWeights(factorGroup);
    const def: Record<string, number> = {};
    factors.forEach((f) => (def[f.id] = f.weight));
    setWeights(def);
    toast.success("Pondération réinitialisée.");
  }

  return (
    <div className="bg-[#0d1519] border border-white/[0.07] rounded-2xl">
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-white/[0.05]">
        <FramedLabel text={label} />
        <div className="flex-1" />
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-[10px] text-[#90C9F0] font-semibold px-2.5 py-1 rounded-lg border border-[#90C9F0]/30 hover:bg-[#90C9F0]/10 flex-shrink-0"
        >
          Pondération {open ? "▲" : "▼"}
        </button>
        <span className="text-xl font-black flex-shrink-0" style={{ color: pctColor }}>{blended}%</span>
      </div>

      <div className="px-4 py-3">
        <div className="w-full bg-[#0A0E0C] rounded-full h-2 overflow-hidden">
          <div className="h-2 rounded-full transition-all duration-500" style={{ width: `${blended}%`, backgroundColor: pctColor }} />
        </div>

        {open && (
          <div ref={sectionRef} className="mt-3 scroll-mt-4">
            {/* ── 1) Voir la pondération : pie de décomposition ── */}
            <div>
              <FactorPie reverse size={104} thickness={16} slices={slices} centerLabel={`${blended}%`} centerSub="Règle" />
              <p className="text-white/30 text-[9px] mt-2 leading-snug">
                Part de chaque facteur dans le calcul (poids × valeur) ; « · % » = probabilité estimée par ce facteur.
              </p>
            </div>

            {/* ── 2) Modifier la pondération : curseurs ── */}
            <div className="mt-3 pt-3 border-t border-white/[0.06] flex flex-col gap-2">
              {factors.map((f) => {
                const w = weights[f.id] ?? f.weight;
                const on = w > 0;
                return (
                  <div key={f.id} className={`flex items-center gap-2 ${on ? "" : "opacity-40"}`}>
                    <input type="checkbox" checked={on} onChange={() => toggleFactor(f)} className="accent-[#86d1ea] flex-shrink-0" />
                    <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: factorColor(f.id) }} />
                    <span className="text-white/80 text-[10px] flex-1 truncate">{f.label}</span>
                    <input
                      type="range" min={0} max={100} step={1} value={w}
                      onChange={(e) => setW(f.id, Number(e.target.value))}
                      className="w-14 accent-[#86d1ea] flex-shrink-0"
                    />
                    <input
                      type="number" min={0} max={100} step={1} value={w}
                      onChange={(e) => setW(f.id, Number(e.target.value))}
                      className="w-11 flex-shrink-0 bg-black/20 border border-white/25 rounded px-1 py-0.5 text-[10px] text-white text-right outline-none focus:border-[#90C9F0]/60"
                    />
                  </div>
                );
              })}

              <div className="flex items-center gap-2 flex-wrap mt-1">
                <span className={`text-[10px] font-semibold tabular-nums ${overLimit ? "text-red-400" : "text-white/50"}`}>
                  Total : {Math.round(total)} / 100
                </span>
                <span className="flex-1" />
                <button
                  onClick={handleSave} disabled={overLimit}
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
              <p className="text-white/30 text-[9px] leading-snug">
                Décoche un facteur pour l'exclure. Réglages propres à ce type de pari, gardés sur cet appareil.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
