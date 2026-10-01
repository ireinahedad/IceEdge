/**
 * MLPredictionCard — reusable component showing ML model output.
 *
 * Used in:
 *   - PredictionPage (team / player / game / futures handlers)
 *   - NHLPredictionsPage (per-market chip)
 *
 * ⚠️ IL N'Y A PAS DE REPLI LOCAL, ET IL NE DOIT JAMAIS Y EN AVOIR.
 * Quand le service ML Python ne répond pas, `MLSection` affiche un état
 * « indisponible » — jamais un pourcentage.
 *
 * Pourquoi cette règle existe ici aussi : jusqu'au 2026-09-13 ce fichier
 * portait `fallbackResult()`, qui fabriquait `rulePct ± 3`, l'étiquetait
 * « Random Forest », lui attribuait une confiance de 62 % et le rendait
 * exactement comme une vraie sortie de modèle. Son propre commentaire assumait
 * que l'écart de ±3 existait « pour que ça ait l'air distinct du pourcentage de
 * règles ». Le disjoncteur du client ML s'ouvrant après 5 échecs, une panne du
 * service Python convertissait en silence CHAQUE tuile en chiffre inventé, sans
 * le moindre état d'erreur.
 *
 * C'est la même règle que `services/predictionApiService.ts` applique déjà en
 * tête de fichier, et pour la même raison : un chiffre faux qui a l'air juste
 * est pire que pas de chiffre du tout.
 */
import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { FramedLabel } from "./brand/FramedLabel";
import { env } from "../env";
import { fetchWithTimeout } from "../services/http";
import { pctColor } from "../data/pctScale";

type TFn = (key: string, params?: Record<string, string | number>) => string;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MLFeatureImportance {
  name:       string;
  importance: number;
  direction:  "positive" | "negative";
}

export interface MLPredictionResult {
  probability:         number;
  /** Recalculé sur l'état du match en cours (paquet ML en direct). */
  live?:               boolean;
  /**
   * `null` quand le service n'a pas envoyé de confiance. Elle valait 0,7 par
   * défaut (soit « 70 % de confiance » affiché à l'écran) pour toute réponse
   * qui n'en portait pas, et 62 dans le repli fabriqué. On ne montre plus une
   * confiance qu'on n'a pas reçue.
   */
  confidence:          number | null;
  feature_importances: MLFeatureImportance[];
  /**
   * Renseignés SEULEMENT si le service les a envoyés. Ils étaient auparavant
   * remplis par défaut avec « Random Forest » / « 1.0.0 », ce qui nommait un
   * modèle précis sous un chiffre dont on ignorait la provenance. Le rendu les
   * omet quand ils manquent.
   */
  model_version?:      string;
  model_type?:         string;
  explanation:         string;
}

// ── Mini animated gauge (violet theme) ───────────────────────────────────────

function MLGauge({ pct }: { pct: number }) {
  const [displayed, setDisplayed] = useState(0);
  const size = 100;
  const radius = 40;
  const circ = 2 * Math.PI * radius;
  const offset = circ * (1 - displayed / 100);

  useEffect(() => {
    setDisplayed(0);
    let cur = 0;
    const step = () => {
      cur = Math.min(cur + 1.5, pct);
      setDisplayed(Math.round(cur));
      if (cur < pct) requestAnimationFrame(step);
    };
    const t = setTimeout(() => requestAnimationFrame(step), 120);
    return () => clearTimeout(t);
  }, [pct]);

  const color = pctColor(pct);

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#1a1230" strokeWidth={9} />
        {pct > 0 && (
          <circle
            cx={size / 2} cy={size / 2} r={radius} fill="none"
            stroke={color} strokeWidth={9} strokeLinecap="round"
            strokeDasharray={circ} strokeDashoffset={offset}
            style={{ transition: "stroke-dashoffset 0.04s linear" }}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-white text-xl font-black">{displayed}<span className="text-sm">%</span></span>
      </div>
    </div>
  );
}

// ── Feature importance bar ────────────────────────────────────────────────────

/**
 * Libellé affichable d'un facteur du modèle.
 *
 * Depuis S4 ②, le service ML renvoie une CLÉ (`factor.attack`, `factor.goalie`,
 * …) plutôt qu'un libellé : la décomposition de log λ produit sept concepts, et
 * une clé permet de les traduire comme le reste de l'interface.
 *
 * Tout ce qui ne ressemble pas à une clé s'affiche tel quel — c'est le repli
 * quand le modèle de score ne répond pas et que le service retombe sur les
 * gains du classifieur, dont les « noms » sont des colonnes brutes. Même
 * prudence si le service ajoute une clé que ce client ne connaît pas encore :
 * `t()` rend la clé quand elle manque du dictionnaire, on préfère alors le nom
 * d'origine à un `ml.factor.xxx` affiché à l'écran.
 */
function factorLabel(name: string, t: TFn): string {
  if (!name.startsWith("factor.")) return name;
  const key = `ml.${name}`;
  const label = t(key);
  return label === key ? name : label;
}

function ImportanceBar({ fi, maxImp }: { fi: MLFeatureImportance; maxImp: number }) {
  const { t } = useI18n();
  const [width, setWidth] = useState(0);
  const pct = maxImp > 0 ? (fi.importance / maxImp) * 100 : 0;
  const color = fi.direction === "positive" ? "#a78bfa" : "#f87171";

  useEffect(() => {
    const t = setTimeout(() => setWidth(pct), 300);
    return () => clearTimeout(t);
  }, [pct]);

  return (
    <div className="flex items-center gap-2">
      <span className={`text-[11px] flex-shrink-0 ${fi.direction === "positive" ? "text-[#a78bfa]" : "text-[#f87171]"}`}>
        {fi.direction === "positive" ? "▲" : "▼"}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-[#c0cdd4] text-[11px] truncate mb-0.5">{factorLabel(fi.name, t)}</p>
        <div className="w-full bg-[#0A0E0C] rounded-full h-1">
          <div
            className="h-1 rounded-full transition-all duration-700 ease-out"
            style={{ width: `${width}%`, backgroundColor: color }}
          />
        </div>
      </div>
      <span className="text-[11px] font-mono flex-shrink-0" style={{ color }}>
        {fi.importance.toFixed(2)}
      </span>
    </div>
  );
}

// ── Verdict label ─────────────────────────────────────────────────────────────

function verdictLabel(pct: number, t: TFn): { text: string; color: string; bg: string } {
  const color = pctColor(pct);
  const bg = color + "1f";
  if (pct >= 70) return { text: t("ml.verdictStrong"),  color, bg };
  if (pct >= 58) return { text: t("ml.verdictPos"),     color, bg };
  if (pct >= 45) return { text: t("ml.verdictNeutral"), color, bg };
  return           { text: t("ml.verdictWeak"),         color, bg };
}

// ── Animated big gauge (hero) ─────────────────────────────────────────────────

function MLGaugeLarge({ pct, color }: { pct: number; color: string }) {
  const [displayed, setDisplayed] = useState(0);
  const size = 130;
  const radius = 52;
  const circ = 2 * Math.PI * radius;
  const offset = circ * (1 - displayed / 100);

  useEffect(() => {
    setDisplayed(0);
    let cur = 0;
    const step = () => {
      cur = Math.min(cur + 2, pct);
      setDisplayed(Math.round(cur));
      if (cur < pct) requestAnimationFrame(step);
    };
    const t = setTimeout(() => requestAnimationFrame(step), 80);
    return () => clearTimeout(t);
  }, [pct]);

  return (
    <div className="relative flex items-center justify-center flex-shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={radius} fill="none" stroke="#1a1230" strokeWidth={11} />
        <circle cx={size/2} cy={size/2} r={radius} fill="none"
          stroke={color} strokeWidth={11} strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.04s linear", filter: `drop-shadow(0 0 6px ${color}88)` }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-black leading-none" style={{ color }}>{displayed}</span>
        <span className="text-sm font-bold" style={{ color }}>%</span>
      </div>
    </div>
  );
}

// ── Simple card (PredictionSheet) ────────────────────────────────────────────

function MLSimpleCard({ result }: { result: MLPredictionResult; ruleBasedPct?: number }) {
  const { t, lang } = useI18n();
  const { probability, confidence, explanation } = result;
  const [open, setOpen] = useState(false);
  const [barWidth, setBarWidth] = useState(0);

  useEffect(() => {
    if (!open) { setBarWidth(0); return; }
    const timer = setTimeout(() => setBarWidth(probability), 120);
    return () => clearTimeout(timer);
  }, [probability, open]);

  const probColor = pctColor(probability);
  const confColor = confidence === null ? null : pctColor(confidence);

  return (
    <div className="bg-[#0d0a1a] border border-[#a78bfa]/25 rounded-2xl overflow-hidden">
      {/* Header — fermé : seulement le score ML */}
      <div className="flex items-center gap-2.5 px-4 py-3">
        <FramedLabel text="ML" />
        <div className="flex-1" />
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-[11px] text-[#a78bfa] font-semibold px-2.5 py-1 rounded-lg border border-[#a78bfa]/30 hover:bg-[#a78bfa]/10 flex-shrink-0"
        >
          {lang === "fr" ? "Détails" : "Details"} {open ? "▲" : "▼"}
        </button>
        <span className="text-xl font-black flex-shrink-0" style={{ color: probColor }}>{probability}%</span>
      </div>

      {/* Corps — ouvert : barre sur la même rangée que le score, confiance en dessous */}
      {open && (
        <div className="px-4 pb-3 border-t border-[#a78bfa]/10 pt-3">
          <div className="flex items-center gap-3">
            <span className="text-3xl font-black leading-none flex-shrink-0" style={{ color: probColor }}>
              {probability}<span className="text-base font-bold" style={{ color: probColor + "bb" }}>%</span>
            </span>
            <div className="flex-1 bg-[#0A0E0C] rounded-full h-2 overflow-hidden">
              <div className="h-full rounded-full transition-all duration-700 ease-out"
                style={{ width: `${barWidth}%`, backgroundColor: probColor, boxShadow: `0 0 6px ${probColor}88` }} />
            </div>
          </div>
          {confidence !== null && confColor && (
            <div className="flex items-center gap-1.5 mt-2">
              <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: confColor }} />
              <span className="text-[11px] font-semibold" style={{ color: confColor }}>{t("ml.conf", { n: confidence })}</span>
            </div>
          )}
          <p className="text-[#9a8ab8] text-[11px] leading-relaxed mt-2">{explanation}</p>
        </div>
      )}
    </div>
  );
}

// ── Main card ─────────────────────────────────────────────────────────────────

interface MLPredictionCardProps {
  result:          MLPredictionResult;
  ruleBasedPct?:   number;
  compact?:        boolean;  // badge inline pour les listes
  hero?:           boolean;  // version pleine page dans PredictionSheet
  simple?:         boolean;  // carte simple : barre + % + explication (PredictionSheet)
  label?:          string;   // marché ciblé, ex. "Total Buts (O/U 22.5)"
}

function MLPredictionCard({ result, ruleBasedPct, compact = false, hero = false, simple = false, label }: MLPredictionCardProps) {
  const { t } = useI18n();
  const { probability, confidence, feature_importances, model_type, model_version, explanation } = result;

  const probColor = pctColor(probability);
  const confColor = confidence === null ? null : pctColor(confidence);

  // Le service ne renvoie pas toujours de nom de modèle. On n'en invente pas un.
  const modelLine = [model_type, model_version].filter(Boolean).join(" · ");

  // ── Compact badge ──────────────────────────────────────────────────────────
  if (compact) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-[#1a1230] border border-[#a78bfa]/25">
        <span className="text-[11px] text-[#a78bfa] font-bold">🤖 ML</span>
        <span className="text-xs font-black" style={{ color: probColor }}>{probability}%</span>
        {model_type && <span className="text-[11px] text-[#4a4060]">{model_type.split(' ')[0]}</span>}
      </div>
    );
  }

  const maxImp = Math.max(...feature_importances.map((f) => f.importance), 0.001);
  const delta = ruleBasedPct !== undefined ? probability - ruleBasedPct : null;
  const verdict = verdictLabel(probability, t);

  // ── Simple layout (PredictionSheet — barre + % + explication) ────────────
  if (simple) {
    return <MLSimpleCard result={result} ruleBasedPct={ruleBasedPct} />;
  }

  // ── Hero layout (PredictionSheet) ──────────────────────────────────────────
  if (hero) {
    return (
      <div className="rounded-2xl overflow-hidden" style={{ background: "linear-gradient(160deg, #0d0a1a 0%, #0a0d1a 100%)", border: "1px solid rgba(167,139,250,0.25)" }}>

        {/* ── Header ── */}
        <div className="px-4 py-3 flex items-center gap-2 border-b border-[#a78bfa]/10">
          <div className="w-8 h-8 rounded-xl bg-[#a78bfa]/15 border border-[#a78bfa]/30 flex items-center justify-center text-base">🤖</div>
          <div className="flex-1 min-w-0">
            <p className="text-white text-sm font-bold">{t("ml.title")}</p>
            {label
              ? <p className="text-[#a78bfa] text-[11px] font-semibold truncate">↳ {label}</p>
              : modelLine ? <p className="text-[#6b5a8a] text-[11px] truncate">{modelLine}</p> : null
            }
          </div>
          {confidence !== null && confColor && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full" style={{ background: confColor + "18", border: `1px solid ${confColor}40` }}>
              <div className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: confColor }} />
              <span className="text-[11px] font-semibold" style={{ color: confColor }}>{t("ml.conf", { n: confidence })}</span>
            </div>
          )}
        </div>

        {/* ── Hero probability ── */}
        <div className="px-4 pt-5 pb-3">
          <div className="flex items-center gap-5">
            <MLGaugeLarge pct={probability} color={probColor} />
            <div className="flex-1 min-w-0">
              {/* Verdict */}
              <div className="inline-flex items-center px-2.5 py-1 rounded-full mb-2 text-[11px] font-bold"
                style={{ backgroundColor: verdict.bg, color: verdict.color }}>
                {verdict.text}
              </div>
              {/* Big number */}
              <div className="flex items-baseline gap-1 mb-1">
                <span className="text-4xl font-black" style={{ color: probColor }}>{probability}</span>
                <span className="text-xl font-black" style={{ color: probColor + "bb" }}>%</span>
              </div>
              {/* Delta vs rules */}
              {delta !== null && (
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[11px] text-[#4a4060]">{t("ml.rules")}</span>
                  <span className="text-[11px] font-bold text-[#86d1ea]">{ruleBasedPct}%</span>
                  <span className="text-[11px] text-[#4a4060]">→ ML</span>
                  {Math.abs(delta) >= 3 ? (
                    <span className="text-[11px] font-bold px-1.5 py-0.5 rounded-full"
                      style={{
                        backgroundColor: (Math.abs(delta) >= 12 ? "#f87171" : "#facc15") + "22",
                        color: Math.abs(delta) >= 12 ? "#f87171" : "#facc15",
                      }}>
                      {delta > 0 ? "+" : ""}{delta}%
                    </span>
                  ) : (
                    <span className="text-[11px] text-[#4a4060]">{t("ml.sameSignal")}</span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Explanation */}
          <p className="text-[#9a8ab8] text-[11px] leading-relaxed mt-3 px-1">{explanation}</p>
        </div>

        {/* ── Facteurs clés ── */}
        {feature_importances.length > 0 && (
          <div className="px-4 pb-5 border-t border-[#a78bfa]/08 pt-3">
            <p className="text-[#5a4a7a] text-[11px] uppercase tracking-widest mb-3 font-semibold">{t("ml.keyFactors")}</p>
            <div className="flex flex-col gap-2.5">
              {feature_importances.map((fi, i) => (
                <ImportanceBar key={i} fi={fi} maxImp={maxImp} />
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Standard layout (NHLPredictionsPage expanded cards) ───────────────────
  return (
    <div className="bg-[#0d0a1a] border border-[#a78bfa]/20 rounded-2xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-[#a78bfa]/10">
        <div className="w-7 h-7 rounded-lg bg-[#a78bfa]/15 border border-[#a78bfa]/30 flex items-center justify-center text-sm">🤖</div>
        <div className="flex-1">
          <p className="text-white text-xs font-bold">{t("ml.aiPrediction")}</p>
          {modelLine && <p className="text-[#6b5a8a] text-[11px]">{modelLine}</p>}
        </div>
        {confidence !== null && confColor && (
          <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-white/5 border border-white/10">
            <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: confColor }} />
            <span className="text-[11px]" style={{ color: confColor }}>{t("ml.confidence", { n: confidence })}</span>
          </div>
        )}
      </div>
      <div className="p-4">
        <div className="flex items-center gap-4 mb-4">
          <MLGauge pct={probability} />
          <div className="flex-1 min-w-0">
            <p className="text-white text-sm font-black mb-1">
              {probability}%
              <span className="text-[#6b5a8a] text-[11px] font-normal ml-1.5">{t("ml.probability")}</span>
            </p>
            <p className="text-[#8a7aaa] text-[11px] leading-relaxed">{explanation}</p>
            {ruleBasedPct !== undefined && delta !== null && (
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <span className="text-[11px] text-[#4a4060]">{t("ml.rulesColon")} <span className="text-[#86d1ea] font-bold">{ruleBasedPct}%</span></span>
                <span className="text-[11px] text-[#4a4060]">→ ML: <span style={{ color: probColor }} className="font-bold">{probability}%</span></span>
                {Math.abs(delta) >= 5 && (
                  <span className="text-[11px] px-1.5 py-0.5 rounded-full"
                    style={{ backgroundColor: (Math.abs(delta) >= 10 ? "#f87171" : "#facc15") + "22", color: Math.abs(delta) >= 10 ? "#f87171" : "#facc15" }}>
                    Δ{delta > 0 ? "+" : ""}{delta}%
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        {feature_importances.length > 0 && (
          <div>
            <p className="text-[#8a9ea6] text-[11px] uppercase tracking-wider mb-2 font-semibold">{t("ml.topFactors")}</p>
            <div className="flex flex-col gap-1.5">
              {feature_importances.slice(0, 5).map((f, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="text-[#8a9ea6] text-[11px] w-28 truncate">{factorLabel(f.name, t)}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-white/5">
                    <div
                      className="h-1.5 rounded-full"
                      // `accent` n'a jamais été défini dans ce fichier : cette ligne jetait un
                      // ReferenceError dès que `feature_importances` n'était pas vide, donc
                      // chaque fois que la carte ML avait quelque chose à montrer. Remplacé
                      // par le violet ML de la carte, celui d'`ImportanceBar`.
                      style={{ width: `${Math.round(f.importance * 100)}%`, background: "#a78bfa" }}
                    />
                  </div>
                  <span className="text-[11px] text-[#8a9ea6]">{Math.round(f.importance * 100)}%</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── MLSection — fetches from /api/predict/ml and renders MLPredictionCard ───

const ML_BASE = `${env.nhlServerUrl}/api/predict`;

/**
 * Extract the ML probability (0-100 integer) from a raw ML-service response.
 * SINGLE source of truth for both the stats tile (fetchMLProbability) and the
 * detail card (normalizeMLResponse) so they can never round differently and
 * show two different ML numbers for the same bet. Returns null when the
 * response carries no usable probability.
 */
function mlPctFromResponse(data: Record<string, unknown>): number | null {
  const raw =
    typeof data.probability === "number" ? data.probability :
    typeof data.homeWinProb  === "number" ? data.homeWinProb  : null;
  if (raw === null) return null;
  // Paquet ML en direct : toujours en points, où 0 et 1 % sont de vraies valeurs.
  if (data.probability_scale === "pct") return Math.round(raw);
  return raw > 1 ? Math.round(raw) : Math.round(raw * 100);
}

/**
 * Fetch ONLY the ML probability (0-100) for a bet — used by the stats-page
 * tiles when the "ML" reveal mode is active. Uses the exact same extraction
 * (mlPctFromResponse) as the detail card, so a tile and the card the user opens
 * always show the same number.
 *
 * Retourne `null` quand le service ne donne pas de probabilité exploitable —
 * hors ligne, 503, corps illisible, disjoncteur ouvert. La tuile doit alors dire
 * « indisponible » ; elle ne doit NI fabriquer un chiffre, NI afficher
 * discrètement le pourcentage de règles sous une étiquette « ML », ce qui
 * revient au même mensonge en moins visible.
 */
export type MLProbabilityRequest = {
  // `selection` porte le CÔTÉ d'un marché binaire (« yes » / « no »). Il était
  // absent de ce type, donc les deux tuiles d'un même marché envoyaient une
  // requête identique et affichaient le même pourcentage des deux côtés.
  // `isHome` dit si le SUJET reçoit. Sans lui, le serveur passait le sujet comme
  // équipe à domicile au service Python : les deux tuiles moneyline d'un même
  // match recevaient chacune l'avantage de la glace et totalisaient 109–112 %.
  type: "game" | "player" | "team"; subjectId: string; opponentId?: string; propType?: string; line?: number; selection?: string; isHome?: boolean;
};

/**
 * Clé d'une demande de probabilité ML : exactement les champs envoyés au
 * serveur, dans un ordre fixe. Sert au cache ci-dessous ET de dépendance
 * d'effet aux tuiles (`BetOption`) — une chaîne est stable d'un rendu à
 * l'autre, là où l'objet `mlProps` est recréé à chaque rendu du parent.
 */
export function mlProbabilityKey(req: MLProbabilityRequest): string {
  return JSON.stringify([
    req.type, req.subjectId, req.opponentId ?? null, req.propType ?? null,
    req.line ?? null, req.selection ?? null, req.isHome ?? null,
  ]);
}

/**
 * Cache des probabilités ML, partagé par toutes les tuiles de l'application.
 *
 * Mesuré le 2026-09-16 : une page de match tirait 31 `POST /predict/ml` à la
 * première bascule en mode ML, et 31 de plus à CHAQUE retour Règles → ML. Avec
 * `predictLimiter` à 60/min par compte (par IP pour un invité), un seul
 * aller-retour suffisait à prendre des 429 et à afficher « — » sur les tuiles.
 * La page joueur envoyait en plus des corps identiques (12 appels, 7 distincts).
 *
 * On garde la PROMESSE, pas le résultat : deux tuiles qui demandent la même
 * chose au même instant partagent un seul appel. Un `null` (hors ligne, 429,
 * 503) n'est PAS conservé : la prochaine demande retente, sinon une panne
 * passagère resterait affichée cinq minutes.
 */
const ML_PROB_TTL_MS = 5 * 60_000;
const ML_PROB_MAX_ENTRIES = 300;
const mlProbCache = new Map<string, { at: number; promise: Promise<number | null> }>();

export function fetchMLProbability(req: MLProbabilityRequest): Promise<number | null> {
  const key = mlProbabilityKey(req);
  const hit = mlProbCache.get(key);
  if (hit && Date.now() - hit.at < ML_PROB_TTL_MS) return hit.promise;

  const entry = { at: Date.now(), promise: requestMLProbability(req) };
  entry.promise.then((p) => {
    if (p === null && mlProbCache.get(key) === entry) mlProbCache.delete(key);
  });
  mlProbCache.delete(key);
  if (mlProbCache.size >= ML_PROB_MAX_ENTRIES) {
    const oldest = mlProbCache.keys().next();
    if (!oldest.done) mlProbCache.delete(oldest.value);
  }
  mlProbCache.set(key, entry);
  return entry.promise;
}

async function requestMLProbability(req: MLProbabilityRequest): Promise<number | null> {
  try {
    const r = await fetchWithTimeout(`${ML_BASE}/ml`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (!data || typeof data !== "object") return null;
    return mlPctFromResponse(data as Record<string, unknown>);
  } catch {
    return null;
  }
}

/* ─── Paquet ML d'un match ──────────────────────────────────────────────────
 *
 * Toutes les tuiles d'une page de match en UNE requête
 * (`GET /api/predict/game/:id/bundle`), au lieu d'un `POST /predict/ml` par
 * tuile — ~95 appels, et des 429 dès la première bascule en mode ML.
 *
 * Résultat : `{ [identifiant de tuile]: résultat | null }`, ou `null` si le
 * paquet entier est indisponible. La promesse est partagée 5 min ; un échec
 * n'est pas conservé (la prochaine bascule retente).
 */
export interface GameMlBundle {
  /** Par identifiant de tuile de la page match. */
  byId:  Record<string, MLPredictionResult | null>;
  /** Par question (`mlBundleKey`) — pages équipe et joueur. */
  byKey: Record<string, MLPredictionResult | null>;
  /** Match commencé : chiffres du modèle conditionnés par le score (serveur). */
  live?: { label: string; final: boolean };
}
const BUNDLE_TTL_MS = 5 * 60_000;
/** Match en cours : le serveur recalcule toutes les 30 s, on ne garde pas plus. */
const LIVE_BUNDLE_TTL_MS = 25_000;
const bundleCache = new Map<string, { at: number; promise: Promise<GameMlBundle | null>; live?: boolean }>();

export function fetchGameMlBundle(gameId: string): Promise<GameMlBundle | null> {
  const hit = bundleCache.get(gameId);
  const ttl = hit?.live ? LIVE_BUNDLE_TTL_MS : BUNDLE_TTL_MS;
  if (hit && Date.now() - hit.at < ttl) return hit.promise;
  const entry: { at: number; promise: Promise<GameMlBundle | null>; live?: boolean } = {
    at: Date.now(),
    promise: (async (): Promise<GameMlBundle | null> => {
      try {
        const r = await fetchWithTimeout(`${ML_BASE}/game/${encodeURIComponent(gameId)}/bundle`);
        if (!r.ok) return null;
        const data = await r.json() as {
          results?: Record<string, unknown>; byKey?: Record<string, unknown>;
          live?: { label?: unknown; final?: unknown };
        };
        if (!data?.results || typeof data.results !== "object") return null;
        const norm = (m: Record<string, unknown> | undefined) => {
          const out: Record<string, MLPredictionResult | null> = {};
          for (const [id, v] of Object.entries(m ?? {})) {
            out[id] = v && typeof v === "object" ? normalizeMLResponse(v as Record<string, unknown>) : null;
          }
          return out;
        };
        const live = data.live && typeof data.live.label === "string"
          ? { label: data.live.label, final: data.live.final === true }
          : undefined;
        return { byId: norm(data.results), byKey: norm(data.byKey), ...(live ? { live } : {}) };
      } catch {
        return null;
      }
    })(),
  };
  entry.promise.then(b => {
    if (b === null && bundleCache.get(gameId) === entry) bundleCache.delete(gameId);
    // Match en cours : la promesse ne sert que 25 s (voir `LIVE_BUNDLE_TTL_MS`).
    if (b?.live && !b.live.final) entry.live = true;
  });
  bundleCache.set(gameId, entry);
  return entry.promise;
}

interface MLSectionProps {
  type:         "game" | "player" | "team";
  subjectId:    string;
  opponentId?:  string;
  propType?:    string;
  line?:        number;
  /** Côté d'un marché binaire servi sous un seul `propType` : « yes » | « no ». */
  selection?:   string;
  /** Le sujet reçoit-il ? Décide de quel côté le service applique la glace. */
  isHome?:      boolean;
  ruleBasedPct?: number;
  label?:       string;
  simple?:      boolean;
  hero?:        boolean;
  /**
   * Résultat déjà calculé (grilles de paris joueur) : affiché tel quel, SANS
   * appel au service. `null` = indisponible. Absent = on interroge le modèle.
   */
  preset?:      MLPredictionResult | null;
}

/**
 * Normalise any server response shape into the MLPredictionResult the card
 * expects — ou `null` si la réponse ne porte pas de probabilité exploitable.
 *
 * Le `?? 50` qui occupait cette ligne transformait toute réponse inattendue en
 * pile ou face parfaitement présentable, et les valeurs par défaut
 * « Random Forest » / « 1.0.0 » lui collaient un nom de modèle par-dessus. La
 * confiance n'est plus inventée non plus : absente, elle n'est pas affichée.
 */
function normalizeMLResponse(data: Record<string, unknown>): MLPredictionResult | null {
  // Same extraction/rounding the stats tile uses → identical ML % in both.
  const pct = mlPctFromResponse(data);
  if (pct === null) return null;

  const rawConf = typeof data.confidence === "number" ? data.confidence : null;
  const conf    = rawConf === null ? null : rawConf > 1 ? Math.round(rawConf) : Math.round(rawConf * 100);

  return {
    probability:         pct,
    confidence:          conf,
    feature_importances: Array.isArray(data.feature_importances)
      ? (data.feature_importances as MLFeatureImportance[])
      : [],
    model_type:          typeof data.model_type    === "string" ? data.model_type    : undefined,
    model_version:       typeof data.model_version === "string" ? data.model_version : undefined,
    explanation:         typeof data.explanation   === "string" ? data.explanation   : "",
    // Recalculé sur l'état du match en cours (paquet ML) : blanc opaque à l'écran.
    ...(data.live === true ? { live: true } : {}),
  };
}

/**
 * État « le modèle n'a pas répondu » — le seul repli autorisé.
 *
 * Même cadre que la carte, pour que la mise en page ne saute pas, et un texte
 * qui dit la vérité : pas de pourcentage, pas de jauge, pas de nom de modèle.
 * L'utilisateur garde le score de règles, affiché juste en dessous sous sa
 * propre étiquette — c'est un chiffre honnête, lui.
 */
function MLUnavailable({ t }: { t: TFn }) {
  return (
    <div className="bg-[#0d0a1a] border border-[#a78bfa]/15 rounded-2xl overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 py-3">
        <FramedLabel text="ML" />
        <div className="flex-1" />
        <span className="text-[#6b5a8a] text-[11px] font-semibold">{t("ml.unavailable")}</span>
        <span className="text-[#4a4060] text-xl font-black leading-none">—</span>
      </div>
      <div className="px-4 pb-3 -mt-1">
        <p className="text-[#6b5a8a] text-[11px] leading-relaxed">{t("ml.unavailableHint")}</p>
      </div>
    </div>
  );
}

/**
 * Placeholder affiché pendant l'appel au service ML — même cadre que la carte,
 * pour que rien ne bouge quand le vrai résultat arrive.
 */
function MLSkeleton() {
  return (
    <div className="bg-[#0d0a1a] border border-[#a78bfa]/25 rounded-2xl overflow-hidden">
      <div className="flex items-center gap-2.5 px-4 py-3">
        <FramedLabel text="ML" />
        <div className="flex-1" />
        <div className="h-6 w-16 rounded-lg bg-[#a78bfa]/10 animate-pulse" />
      </div>
    </div>
  );
}

/**
 * Trois états, et trois seulement : en attente, une vraie prédiction, ou
 * « indisponible ». Il n'y a pas de quatrième état où l'on montre un chiffre
 * que le modèle n'a pas produit.
 */
type MLState =
  | { status: "loading" }
  | { status: "ready";       result: MLPredictionResult }
  | { status: "unavailable" };

export function MLSection({ type, subjectId, opponentId, propType, line, selection, isHome, ruleBasedPct, label, simple, hero, preset }: MLSectionProps) {
  const { t } = useI18n();
  const [state, setState] = useState<MLState>(() =>
    preset === undefined ? { status: "loading" }
    : preset === null    ? { status: "unavailable" }
    : { status: "ready", result: preset });

  useEffect(() => {
    if (preset !== undefined) {
      setState(preset === null ? { status: "unavailable" } : { status: "ready", result: preset });
      return;
    }
    let alive = true;
    // Aucun chiffre tant que le modèle n'a pas répondu. Jusqu'au 2026-09-04 la
    // carte affichait immédiatement le repli (rulePct ± 3) puis le remplaçait
    // par la vraie probabilité une seconde plus tard : le pourcentage sautait
    // sous les yeux de l'utilisateur. Depuis le 2026-09-13 le repli n'existe
    // plus du tout — un échec donne l'état « indisponible ».
    setState({ status: "loading" });

    fetchWithTimeout(`${ML_BASE}/ml`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, subjectId, opponentId, propType, line, selection, isHome }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!alive) return;
        const result = data && typeof data === "object"
          ? normalizeMLResponse(data as Record<string, unknown>)
          : null;
        setState(result ? { status: "ready", result } : { status: "unavailable" });
      })
      .catch(() => { if (alive) setState({ status: "unavailable" }); });
    return () => { alive = false; };
  }, [type, subjectId, opponentId, propType, line, selection, isHome, preset]);

  if (state.status === "loading")     return <MLSkeleton />;
  if (state.status === "unavailable") return <MLUnavailable t={t} />;

  return (
    <MLPredictionCard
      result={state.result}
      ruleBasedPct={ruleBasedPct}
      label={label}
      simple={simple}
      hero={hero}
    />
  );
}
