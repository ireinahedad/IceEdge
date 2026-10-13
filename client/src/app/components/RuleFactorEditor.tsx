/**
 * RuleFactorEditor.tsx
 * Carte « Règles » d'un pari : score = moyenne pondérée des facteurs de sa
 * famille. La section « Pondération » (repliable, fermée par défaut) montre
 * d'ABORD le pie de décomposition (voir la pondération), puis les curseurs
 * (la modifier). Poids propres à chaque famille, persistés en localStorage et
 * rattachés au compte quand une session existe (cf. `ruleWeightsService`).
 *
 * Ligne « Ta règle » (2026-10-01, demande du user) : sous les facteurs, une
 * ligne vide où l'utilisateur pose SA propre règle — un nom, sa probabilité
 * pour ce pari, et un poids. Elle entre dans la moyenne pondérée comme un
 * facteur de plus. Contrairement aux poids (propres à une famille), elle est
 * propre au PARI (`betKey`) : une probabilité n'a de sens que pour une
 * question donnée. Gardée sur cet appareil seulement (localStorage).
 */
import { useState, useRef, useEffect } from "react";
import { toast } from "sonner";
import { FactorPie } from "./FactorPie";
import { pctColor } from "../data/pctScale";
import { FramedLabel } from "./brand/FramedLabel";
import {
  SimpleFactor,
  factorColor,
  getFamilyWeights,
  saveFamilyWeights,
  resetFamilyWeights,
  blendFactors,
  ensureFamilyWeightsHydrated,
  pushFamilyWeights,
} from "../services/ruleWeightsService";
import { scaledRulePct } from "../pages/prediction/gameMarkets";
import { factorDescription } from "../data/factorDescriptions";
import { useI18n } from "../i18n";
import { factorLabel } from "../i18n/serverText";

/* ─── Règle personnelle, par pari ─────────────────────────────────────────── */
interface UserRule { label: string; pct: number | null; weight: number }
const USER_RULES_KEY = "iceedge.userRules";
const USER_RULE_ID = "userRule";
const USER_RULE_COLOR = "#FFFFFF";
const USER_RULE_DEFAULT_WEIGHT = 20;
const EMPTY_RULE: UserRule = { label: "", pct: null, weight: 0 };

function loadUserRules(): Record<string, UserRule> {
  try { return JSON.parse(localStorage.getItem(USER_RULES_KEY) || "{}") || {}; } catch { return {}; }
}
function loadUserRule(betKey?: string): UserRule {
  if (!betKey) return EMPTY_RULE;
  const r = loadUserRules()[betKey];
  if (!r || typeof r !== "object") return EMPTY_RULE;
  return {
    label: typeof r.label === "string" ? r.label.slice(0, 40) : "",
    pct: typeof r.pct === "number" && Number.isFinite(r.pct) ? Math.max(0, Math.min(100, r.pct)) : null,
    weight: typeof r.weight === "number" && Number.isFinite(r.weight) ? Math.max(0, Math.min(100, r.weight)) : 0,
  };
}
function storeUserRule(betKey: string | undefined, rule: UserRule | null) {
  if (!betKey) return;
  try {
    const all = loadUserRules();
    if (rule && (rule.label.trim() || rule.pct != null)) all[betKey] = rule;
    else delete all[betKey];
    localStorage.setItem(USER_RULES_KEY, JSON.stringify(all));
  } catch { /* stockage indisponible : la règle vit le temps de la fiche */ }
}

export function RuleFactorEditor({
  factors,
  factorGroup,
  pctScale,
  label,
  betKey,
}: {
  factors: SimpleFactor[];
  factorGroup: string;
  /**
   * Fraction appliquée au mélange, pour un pari plus étroit que la question
   * que ses facteurs décrivent — « gagne en temps réglementaire » se mesure
   * avec les facteurs de « gagne », amputés de la part jouée en prolongation.
   * Sans elle, la carte affichait ici le score de la question LARGE, pendant
   * que la tuile affichait celui du pari : deux chiffres pour un même pari.
   */
  pctScale?: number;
  label: string;
  /** Identifiant stable du pari — clé de la règle personnelle (« Ta règle »). */
  betKey?: string;
}) {
  const { t, lang } = useI18n();
  const [open, setOpen] = useState(false);
  const [weights, setWeights] = useState<Record<string, number>>(() => getFamilyWeights(factorGroup, factors));
  const [userRule, setUserRule] = useState<UserRule>(() => loadUserRule(betKey));
  const sectionRef = useRef<HTMLDivElement>(null);
  // Une modification en cours ne doit pas être écrasée par l'arrivée tardive des
  // poids du compte : c'est le seul rôle de ce drapeau.
  const touchedRef = useRef(false);

  /**
   * Récupère les poids du compte au premier montage d'une carte de règles.
   * L'appel est mutualisé et ne part qu'une fois par chargement d'app (et jamais
   * pour un invité) — voir `ensureFamilyWeightsHydrated`.
   */
  useEffect(() => {
    let cancelled = false;
    ensureFamilyWeightsHydrated().then((changed) => {
      if (changed && !cancelled && !touchedRef.current) {
        setWeights(getFamilyWeights(factorGroup, factors));
      }
    });
    return () => { cancelled = true; };
    // `factors` ne change pas d'identité de valeur pour une même carte ; on se cale
    // sur la famille, qui est ce qui détermine les poids lus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [factorGroup]);

  // Défile la section à l'écran quand on l'ouvre.
  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 60);
      return () => clearTimeout(timer);
    }
  }, [open]);

  // La règle personnelle compte dès qu'elle a une probabilité et un poids. Sa
  // probabilité porte sur LE PARI : on la ramène à l'échelle des facteurs
  // (÷ `pctScale`) pour que le score affiché, re-multiplié, retombe juste.
  const userActive = userRule.pct != null && userRule.weight > 0;
  const userFactor: SimpleFactor | null = userActive
    ? {
        id: USER_RULE_ID,
        label: userRule.label.trim() || t("rules.yourRule"),
        weight: userRule.weight,
        value: Math.max(0, Math.min(1, (userRule.pct as number) / 100 / (pctScale && pctScale > 0 ? pctScale : 1))),
      }
    : null;
  const allFactors = userFactor ? [...factors, userFactor] : factors;
  const blended = scaledRulePct(blendFactors(allFactors, weights), pctScale);
  const total = factors.reduce((s, f) => s + (weights[f.id] ?? f.weight), 0) + (userFactor ? userFactor.weight : 0);
  // 100 est un repère de lecture, pas une contrainte : le score est une moyenne
  // pondérée (`blendFactors` divise par la somme des poids), donc un total de 106
  // donne exactement le même chiffre qu'un total de 100 aux mêmes proportions.
  // Il ne bloque donc plus l'enregistrement — il ne le pouvait pas honnêtement :
  // une famille peut gagner un facteur conditionnel (altitude, arbitrage) APRÈS
  // que l'utilisateur a réglé et enregistré ses curseurs, et le total repasse
  // au-dessus de 100 sans qu'il ait rien touché.
  const offBudget = Math.abs(total - 100) > 0.5;
  const blendedColor = pctColor(blended);

  const slices = allFactors.map((f) => ({
    label: f.id === USER_RULE_ID ? f.label : factorLabel(f.label, lang),
    value: (weights[f.id] ?? f.weight) * f.value,
    color: f.id === USER_RULE_ID ? USER_RULE_COLOR : factorColor(f.id),
    sub: f.id === USER_RULE_ID ? `${userRule.pct}%` : `${Math.round(f.value * 100)}%`,
  }));

  function patchUserRule(p: Partial<UserRule>) {
    setUserRule((r) => {
      const next = { ...r, ...p };
      // Taper une probabilité sur une ligne encore éteinte l'allume.
      if (p.pct != null && r.weight === 0 && p.weight == null) next.weight = USER_RULE_DEFAULT_WEIGHT;
      return next;
    });
  }

  function setW(id: string, v: number) {
    touchedRef.current = true;
    setWeights((prev) => ({ ...prev, [id]: Math.max(0, Math.min(100, Number.isFinite(v) ? v : 0)) }));
  }
  /**
   * Coche/décoche un facteur.
   * Décocher : son poids est redistribué au prorata entre les facteurs restants.
   * Recocher : il reprend son poids par défaut, repris au prorata sur les autres
   * (le total reste inchangé).
   */
  function toggleFactor(f: SimpleFactor) {
    touchedRef.current = true;
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
  /**
   * Rattache le store au compte. L'enregistrement local a déjà eu lieu quand on
   * arrive ici : un échec réseau ne doit donc rien annuler, juste le dire.
   */
  function syncToAccount(store: ReturnType<typeof saveFamilyWeights>) {
    pushFamilyWeights(store).catch(() => {
      toast.warning(t("rules.syncFailed"));
    });
  }
  function handleSave() {
    const store = saveFamilyWeights(factorGroup, weights);
    storeUserRule(betKey, userRule);
    touchedRef.current = false;
    toast.success(t("rules.saved"));
    syncToAccount(store);
  }
  function handleReset() {
    const store = resetFamilyWeights(factorGroup);
    const def: Record<string, number> = {};
    factors.forEach((f) => (def[f.id] = f.weight));
    setWeights(def);
    setUserRule(EMPTY_RULE);
    storeUserRule(betKey, null);
    touchedRef.current = false;
    toast.success(t("rules.resetDone"));
    syncToAccount(store);
  }

  return (
    <div className="bg-[#0d1519] border border-white/[0.07] rounded-2xl">
      <div className="flex items-center gap-2.5 px-4 py-3 border-b border-white/[0.05]">
        <FramedLabel text={label} />
        <div className="flex-1" />
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-[11px] text-[#90C9F0] font-semibold px-2.5 py-1 rounded-lg border border-[#90C9F0]/30 hover:bg-[#90C9F0]/10 flex-shrink-0"
        >
          {t("rules.weighting")} {open ? "▲" : "▼"}
        </button>
        <span className="text-xl font-black flex-shrink-0" style={{ color: blendedColor }}>{blended}%</span>
      </div>

      <div className="px-4 py-3">
        <div className="w-full bg-[#0A0E0C] rounded-full h-2 overflow-hidden">
          <div className="h-2 rounded-full transition-all duration-500" style={{ width: `${blended}%`, backgroundColor: blendedColor }} />
        </div>

        {open && (
          <div ref={sectionRef} className="mt-3 scroll-mt-4">
            {/* ── 1) Voir la pondération : pie de décomposition ── */}
            <div>
              <FactorPie reverse size={104} thickness={16} slices={slices} centerLabel={`${blended}%`} centerSub={t("rules.rule")} />
              <p className="text-white/30 text-[11px] mt-2 leading-snug">
                {t("rules.pieHint")}
              </p>
            </div>

            {/* ── 2) Modifier la pondération : curseurs ── */}
            <div className="mt-3 pt-3 border-t border-white/[0.06] flex flex-col gap-2">
              {factors.map((f) => {
                const w = weights[f.id] ?? f.weight;
                const on = w > 0;
                const desc = factorDescription(factorGroup, f.id, lang);
                return (
                  <div key={f.id} className={on ? "" : "opacity-40"}>
                  <div className="flex items-center gap-2">
                    <input type="checkbox" checked={on} onChange={() => toggleFactor(f)} className="accent-[#86d1ea] flex-shrink-0" />
                    <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: factorColor(f.id) }} />
                    <span className="text-white/80 text-[11px] flex-1 truncate">{factorLabel(f.label, lang)}</span>
                    <input
                      type="range" min={0} max={100} step={1} value={w}
                      onChange={(e) => setW(f.id, Number(e.target.value))}
                      className="w-14 accent-[#86d1ea] flex-shrink-0"
                    />
                    <input
                      type="number" min={0} max={100} step={1} value={w}
                      onChange={(e) => setW(f.id, Number(e.target.value))}
                      className="w-11 flex-shrink-0 bg-black/20 border border-white/25 rounded px-1 py-0.5 text-[11px] text-white text-right outline-none focus:border-[#90C9F0]/60"
                    />
                  </div>
                  {desc && (
                    <p className="text-white/40 text-[10px] leading-snug mt-0.5 pl-[42px]">{desc}</p>
                  )}
                  </div>
                );
              })}

              {/* ── Ligne vide : la règle de l'utilisateur ── */}
              <div className={`pt-2 border-t border-dashed border-white/[0.10] ${userActive ? "" : "opacity-70"}`}>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={userRule.weight > 0}
                    disabled={userRule.pct == null}
                    onChange={() => patchUserRule({ weight: userRule.weight > 0 ? 0 : USER_RULE_DEFAULT_WEIGHT })}
                    className="accent-[#86d1ea] flex-shrink-0"
                    aria-label={t("rules.includeYours")}
                  />
                  <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0 border border-white/40" style={{ background: userActive ? USER_RULE_COLOR : "transparent" }} />
                  <input
                    type="text"
                    value={userRule.label}
                    maxLength={40}
                    onChange={(e) => patchUserRule({ label: e.target.value })}
                    placeholder={t("rules.yourRulePlaceholder")}
                    className="flex-1 min-w-0 bg-black/20 border border-dashed border-white/25 rounded px-1.5 py-0.5 text-[11px] text-white outline-none placeholder:text-white/35 focus:border-[#90C9F0]/60"
                  />
                  <input
                    type="range" min={0} max={100} step={1} value={userRule.weight}
                    disabled={userRule.pct == null}
                    onChange={(e) => patchUserRule({ weight: Number(e.target.value) })}
                    className="w-14 accent-[#86d1ea] flex-shrink-0 disabled:opacity-40"
                  />
                  <input
                    type="number" min={0} max={100} step={1} value={userRule.weight}
                    disabled={userRule.pct == null}
                    onChange={(e) => patchUserRule({ weight: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })}
                    className="w-11 flex-shrink-0 bg-black/20 border border-white/25 rounded px-1 py-0.5 text-[11px] text-white text-right outline-none focus:border-[#90C9F0]/60 disabled:opacity-40"
                  />
                </div>
                <div className="flex items-center gap-1.5 mt-1 pl-[42px]">
                  <span className="text-white/50 text-[10px]">{t("rules.yourProb")}</span>
                  <input
                    type="number" min={0} max={100} step={1}
                    value={userRule.pct ?? ""}
                    placeholder="—"
                    onChange={(e) => {
                      const raw = e.target.value;
                      patchUserRule({ pct: raw === "" ? null : Math.max(0, Math.min(100, Math.round(Number(raw) || 0))) });
                    }}
                    className="w-12 bg-black/20 border border-white/25 rounded px-1 py-0.5 text-[11px] text-white text-right outline-none focus:border-[#90C9F0]/60"
                  />
                  <span className="text-white/50 text-[10px]">%</span>
                </div>
                <p className="text-white/40 text-[10px] leading-snug mt-0.5 pl-[42px]">
                  {t("rules.yourRuleHint")}
                </p>
              </div>

              <div className="flex items-center gap-2 flex-wrap mt-1">
                <span className={`text-[11px] font-semibold tabular-nums ${offBudget ? "text-white/70" : "text-white/50"}`}>
                  {offBudget
                    ? t("rules.totalScaled", { n: Math.round(total) })
                    : t("rules.total", { n: Math.round(total) })}
                </span>
                <span className="flex-1" />
                <button
                  onClick={handleSave}
                  className="px-3 py-1.5 rounded-lg text-[11px] font-bold"
                  style={{ background: "#86d1ea", color: "#0A0E0C" }}
                >
                  {t("rules.save")}
                </button>
                <button
                  onClick={handleReset}
                  className="px-3 py-1.5 rounded-lg text-[11px] font-semibold text-white/70 border border-white/20 hover:text-white"
                >
                  {t("rules.reset")}
                </button>
              </div>
              <p className="text-white/30 text-[11px] leading-snug">
                {t("rules.footer")}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
