/**
 * AnalysisCard.tsx — l'« Analyse IA » v2 d'un pari (2026-10-04).
 *
 * Ce que l'écran montre, dans l'ordre où un lecteur pressé le cherche :
 *   1. la thèse (une phrase, le chiffre décisif) ;
 *   2. les chiffres CALCULÉS par le serveur — modèle, marché, écart, cotes —
 *      jamais écrits par le LLM ;
 *   3. les moteurs, ▲ pour / ▼ contre, les MAJEURS d'abord ; les secondaires
 *      sont repliés sous « + N facteurs secondaires » ;
 *   4. la réserve éventuelle, l'état des données (gardiens, alignements, cotes)
 *      et les étiquettes de nature du pari ;
 *   5. des questions de suivi en un geste.
 *
 * Le remplaçant de l'ancien « Verdict : Bon pari — Confiance : moyenne » : ce
 * n'est plus un jugement, c'est la position du modèle face au marché.
 */

import { useState } from "react";
import { useI18n } from "../i18n";
import { useOddsFormat } from "../context/OddsFormatContext";
import type { Analysis, AnalysisSide, AnalysisTag } from "../services/llmService";

const SIDE_MARK: Record<AnalysisSide, { mark: string; color: string }> = {
  for:     { mark: "▲", color: "#4ade80" },
  against: { mark: "▼", color: "#f87171" },
  neutral: { mark: "•", color: "#a78bfa" },
};

const TAG_COLOR: Record<AnalysisTag, string> = {
  above_market: "#4ade80", below_market: "#f87171", with_market: "#8a9ea6",
  models_disagree: "#facc15", goalie_dependent: "#facc15", high_uncertainty: "#facc15",
  long_shot: "#a78bfa", live: "#38bdf8",
};

const STATUS_COLOR = { confirmed: "#4ade80", pending: "#facc15", missing: "#8a9ea6" } as const;

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex-1 min-w-0 flex flex-col items-center gap-0.5 px-1 py-1.5 rounded-lg bg-black/25">
      <span className="text-[10px] uppercase tracking-wider text-[#8a9ea6] truncate max-w-full">{label}</span>
      <span className="text-sm font-black tabular-nums" style={{ color: color ?? "#e5e7eb" }}>{value}</span>
    </div>
  );
}

export function AnalysisCard({ analysis, onPickQuestion }: {
  analysis: Analysis;
  /** Une question de suivi suggérée est touchée : l'envoyer au champ de la fiche. */
  onPickQuestion?: (q: string) => void;
}) {
  const { t } = useI18n();
  const { odds } = useOddsFormat();
  const [showMinor, setShowMinor] = useState(false);
  const s = analysis.summary;
  const major = analysis.drivers.filter(d => d.tier === "major");
  const minor = analysis.drivers.filter(d => d.tier === "minor");
  // Sans niveau « majeur » (pari joueur / équipe, ou aucun facteur dominant) :
  // on montre tout, inutile de replier un seul moteur.
  const flat = major.length === 0;
  const shown = flat ? minor : major;
  const hidden = flat ? [] : minor;

  const edgeColor = s.edgePts == null ? undefined : s.edgePts >= 4 ? "#4ade80" : s.edgePts <= -4 ? "#f87171" : "#bfc8cc";
  const signed = (n: number, suffix: string) => `${n > 0 ? "+" : ""}${String(n).replace(".", t("pred.an.decimal"))}${suffix}`;

  return (
    <div className="flex flex-col gap-3 px-4 pb-4">
      <p className="text-white text-sm font-semibold leading-snug">{analysis.headline}</p>

      {(s.modelPct != null || s.marketPct != null) && (
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-1.5">
            {s.modelPct != null && <Stat label={t("pred.an.model")} value={`${s.modelPct} %`} />}
            {s.marketPct != null && <Stat label={t("pred.an.market")} value={`${s.marketPct} %`} />}
            {s.edgePts != null && <Stat label={t("pred.an.edge")} value={signed(s.edgePts, " pts")} color={edgeColor} />}
          </div>
          {s.fairOdds != null && s.bookOdds != null && (
            <p className="text-[11px] text-[#8a9ea6] tabular-nums">
              {t("pred.an.fair")} {odds(s.fairOdds)} · {t("pred.an.book")} {odds(s.bookOdds)}
              {s.valuePct != null && (
                <span style={{ color: s.valuePct > 0 ? "#4ade80" : "#8a9ea6" }}> · {signed(s.valuePct, " %")}</span>
              )}
            </p>
          )}
        </div>
      )}

      {shown.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {shown.map(d => (
            <li key={d.key} className="flex gap-2 text-xs leading-relaxed text-[#d4dbde]">
              <span className="flex-shrink-0 w-3 text-center" style={{ color: SIDE_MARK[d.side].color }}>{SIDE_MARK[d.side].mark}</span>
              <span>{d.text}</span>
            </li>
          ))}
        </ul>
      )}

      {hidden.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => setShowMinor(v => !v)}
            className="self-start text-[11px] font-semibold text-purple-300/80 active:opacity-70"
          >
            {showMinor ? "▲ " : "▼ "}{t("pred.an.minor").replace("{n}", String(hidden.length))}
          </button>
          {showMinor && (
            <ul className="flex flex-col gap-1.5">
              {hidden.map(d => (
                <li key={d.key} className="flex gap-2 text-[11px] leading-relaxed text-[#9fb0b6]">
                  <span className="flex-shrink-0 w-3 text-center" style={{ color: SIDE_MARK[d.side].color }}>{SIDE_MARK[d.side].mark}</span>
                  <span>{d.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {analysis.caveat && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-xl border border-[#facc15]/25 bg-[#facc15]/[0.07]">
          <span className="text-[#facc15] text-[11px] leading-none mt-0.5 flex-shrink-0">ⓘ</span>
          <p className="text-[#c9b87a] text-[11px] leading-relaxed">{analysis.caveat}</p>
        </div>
      )}

      {(analysis.tags.length > 0 || s.solidity) && (
        <div className="flex flex-wrap gap-1.5">
          {analysis.tags.map(tag => (
            <span key={tag} className="text-[10px] font-semibold px-2 py-0.5 rounded-full border"
              style={{ color: TAG_COLOR[tag], borderColor: `${TAG_COLOR[tag]}55`, background: `${TAG_COLOR[tag]}14` }}>
              {t(`pred.an.tag.${tag}`)}
            </span>
          ))}
          {s.solidity && !analysis.tags.includes("high_uncertainty") && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border border-white/15 text-[#8a9ea6]">
              {t(`pred.an.sol.${s.solidity}`)}{s.sigmaPts != null ? ` · ± ${String(s.sigmaPts).replace(".", t("pred.an.decimal"))} pts` : ""}
            </span>
          )}
        </div>
      )}

      {analysis.status.length > 0 && (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {analysis.status.map(st => (
            <span key={st.key} className="flex items-center gap-1 text-[10px] text-[#8a9ea6]">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: STATUS_COLOR[st.state] }} />
              {st.text}
            </span>
          ))}
        </div>
      )}

      {onPickQuestion && analysis.followups.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {analysis.followups.map(q => (
            <button key={q} type="button" onClick={() => onPickQuestion(q)}
              className="text-[11px] px-2.5 py-1 rounded-full border border-purple-400/30 text-purple-200 bg-purple-500/10 active:bg-purple-500/25">
              {q}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
