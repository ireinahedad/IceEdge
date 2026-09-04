/**
 * betParts.tsx
 *
 * Extrait de BetBuilderPage.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { useState, useEffect, type Ref } from "react";
import { Plus, X, Lock, Share2, ChevronRight } from "lucide-react";
import type { BetLeg } from "../../types/bet";
import { openBet } from "../../services/bookmakers";
import { features } from "../../platform";
import { useBookmaker } from "../../context/BookmakerContext";
import { useI18n } from "../../i18n";


// ─── Helpers ──────────────────────────────────────────────────────────────────

export function toOddsLabel(pct: number): string {
  const p = Math.max(5, Math.min(95, pct)) / 100;
  return p >= 0.5
    ? `-${Math.round((p / (1 - p)) * 100)}`
    : `+${Math.round(((1 - p) / p) * 100)}`;
}

// ─── Probability gauge ────────────────────────────────────────────────────────

export function ProbabilityGauge({ pct, size = 180 }: { pct: number; size?: number }) {
  const { t } = useI18n();
  const [displayed, setDisplayed] = useState(0);
  const radius = (size - 24) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - displayed / 100);

  const color =
    pct >= 65 ? "#86d1ea" :
    pct >= 45 ? "#90C9F0" :
    pct >= 25 ? "#facc15" : "#f87171";

  useEffect(() => {
    setDisplayed(0);
    let current = 0;
    const target = Math.min(pct, 100);
    const step = () => {
      current = Math.min(current + 1.5, target);
      setDisplayed(Math.round(current));
      if (current < target) requestAnimationFrame(step);
    };
    const t = setTimeout(() => requestAnimationFrame(step), 80);
    return () => clearTimeout(t);
  }, [pct]);

  const label =
    pct === 0 ? t("slip.gaugeAddLegs") :
    pct >= 65 ? t("slip.gaugeStrong") :
    pct >= 45 ? t("slip.gaugeModerate") :
    pct >= 25 ? t("slip.gaugeRisky") : t("slip.gaugeLongShot");

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#131A12" strokeWidth={14} />
        {pct > 0 && (
          <circle cx={size / 2} cy={size / 2} r={radius} fill="none"
            stroke={color} strokeWidth={14} strokeLinecap="round"
            strokeDasharray={circumference} strokeDashoffset={offset}
            style={{ transition: "stroke-dashoffset 0.04s linear, stroke 0.4s ease" }}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {pct > 0 ? (
          <>
            <span className="text-white text-4xl font-bold">{displayed}<span className="text-2xl">%</span></span>
            <span className="text-xs mt-0.5 font-medium" style={{ color }}>{label}</span>
          </>
        ) : (
          <>
            <span className="text-[#1B2419] text-4xl font-bold">--</span>
            <span className="text-[#4a6068] text-[10px] mt-1 text-center px-4 leading-snug">{t("slip.addToSee")}</span>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Single leg card (builder) ────────────────────────────────────────────────

export function LegCard({ leg, index, onRemove }: { leg: BetLeg; index: number; onRemove: () => void }) {
  const { t } = useI18n();
  const { bookmaker } = useBookmaker();
  const barColor =
    leg.probability >= 65 ? "#86d1ea" :
    leg.probability >= 50 ? "#90C9F0" :
    leg.probability >= 35 ? "#facc15" : "#f87171";

  return (
    <div className="icy-card rounded-2xl p-4">
      <div className="flex items-start gap-3">
        <div className="flex flex-col items-center gap-1.5 flex-shrink-0">
          <div className="w-7 h-7 rounded-full bg-[#90C9F0]/10 border border-[#90C9F0]/25 flex items-center justify-center text-[10px] font-bold text-[#90C9F0]">
            {index + 1}
          </div>
          {leg.subjectLogo?.startsWith("http")
            ? <img src={leg.subjectLogo} alt="" className="w-6 h-6 object-contain" />
            : <span className="text-base">{leg.subjectLogo}</span>}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-white text-xs font-bold">{leg.subjectName}</p>
          <p className="text-[#90C9F0] text-[10px] font-medium">{leg.marketLabel}</p>
          <p className="text-[#8a9ea6] text-[10px] mt-0.5 leading-relaxed">{leg.selection}</p>
          {leg.gameInfo && <p className="text-[#4a6068] text-[9px] mt-0.5">{leg.gameInfo}</p>}
          <div className="mt-2 flex items-center gap-2">
            <div className="flex-1 bg-[#0A0E0C] rounded-full h-1.5">
              <div className="h-1.5 rounded-full transition-all duration-500"
                style={{ width: `${leg.probability}%`, backgroundColor: barColor }} />
            </div>
            <span className="text-xs font-bold flex-shrink-0" style={{ color: barColor }}>{leg.probability}%</span>
            <span className="text-[10px] text-[#4a6068] flex-shrink-0 font-mono">{toOddsLabel(leg.probability)}</span>
          </div>
          {/* APPLE_PLAN §4 — Guideline 5.3: the leg keeps its price, the link out
              to the sportsbook does not ship on iOS. */}
          {features.bookmakerLinks && (
            <button
              onClick={() => openBet("hockey")}
              className="mt-2 inline-flex items-center gap-1.5 bg-[#126e51] hover:bg-[#0f5c44] text-[#ffd700] text-[10px] font-bold px-2.5 py-1.5 rounded-lg transition-colors"
              title={`${bookmaker.label} — ${t("slip.placeBet")}`}
            >
              <span className="bg-[#ffd700] text-[#126e51] rounded px-1 py-0.5 text-[8px] font-black leading-none">{bookmaker.badge}</span>
              {t("slip.placeBet", { book: bookmaker.label })}
            </button>
          )}
        </div>
        <button onClick={onRemove}
          className="w-7 h-7 rounded-full icy-tile flex items-center justify-center text-[#8a9ea6] flex-shrink-0 active:bg-red-500/20 active:text-red-400 active:border-red-400/30 transition-colors">
          <X size={10} />
        </button>
      </div>
    </div>
  );
}

// ─── Empty builder state ──────────────────────────────────────────────────────

export function EmptySlip({ onAdd }: { onAdd: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center justify-center py-10 gap-4">
      <div className="w-20 h-20 rounded-full icy-card flex items-center justify-center">
        <div className="w-8 h-8 rounded-full bg-[#90C9F0]/15 border border-[#90C9F0]/30 flex items-center justify-center">
          <div className="w-3 h-3 rounded-full bg-[#90C9F0]/60" />
        </div>
      </div>
      <div className="text-center">
        <p className="text-white font-bold mb-1" style={{ fontFamily: "'Merriweather', Georgia, serif" }}>
          {t("slip.empty")}
        </p>
        <p className="text-[#8a9ea6] text-xs leading-relaxed max-w-[220px]">
          {t("slip.emptyHint")}
        </p>
      </div>
      <button onClick={onAdd}
        className="bg-[#86d1ea] text-[#072E49] font-bold px-6 py-3 rounded-2xl text-sm flex items-center gap-2 active:scale-95 transition-transform">
        <Plus size={14} /> {t("slip.browse")}
      </button>
    </div>
  );
}

// ─── Lock CTA ─────────────────────────────────────────────────────────────────

export function LockSlipCTA({
  legs, combinedProbability, onAdd, onLock, isSubmitting, panelRef,
}: {
  legs: BetLeg[]; combinedProbability: number | null;
  onAdd: () => void; onLock: () => void; isSubmitting: boolean;
  /** Posé sur le bloc flottant pour que la page puisse MESURER sa hauteur et
   *  se réserver autant de marge basse. Sans ça, la carte recouvre la fin du
   *  contenu, qu'aucun défilement ne peut faire remonter : le bloc est
   *  `fixed`, il ne fait pas partie du flux. Une constante ne suffisait pas —
   *  la hauteur change avec la langue (le texte de visibilité passe de deux à
   *  trois lignes en français) et avec la largeur de l'écran. */
  panelRef?: Ref<HTMLDivElement>;
}) {
  const { t } = useI18n();
  if (legs.length === 0) return null;
  const color =
    combinedProbability == null ? "#8a9ea6" :
    combinedProbability >= 65 ? "#86d1ea" :
    combinedProbability >= 45 ? "#90C9F0" :
    combinedProbability >= 25 ? "#facc15" : "#f87171";

  return (
    <div ref={panelRef} className="fixed bottom-[68px] left-1/2 -translate-x-1/2 max-w-[430px] md:max-w-5xl w-full px-4 z-40">
      <div className="icy-card bet-ink-black rounded-2xl p-3 shadow-xl shadow-black/40">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center"
              style={{ backgroundColor: `${color}15`, border: `1px solid ${color}30` }}>
              <Lock size={13} style={{ color }} />
            </div>
            <div>
              <p className="text-white text-xs font-bold">{t("slip.legsReady", { n: legs.length })}</p>
              <p className="text-[#4a6068] text-[10px]">{t("slip.signinRequired")}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[10px] text-[#8a9ea6]">{t("slip.combined")}</p>
            <p className="text-lg font-black" style={{ color }}>{combinedProbability != null ? `${combinedProbability}%` : "—"}</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={onAdd} disabled={isSubmitting}
            className="flex items-center justify-center gap-1.5 flex-1 py-3 rounded-xl icy-tile text-[#90C9F0] text-xs font-bold active:scale-[0.97] transition-transform disabled:opacity-40">
            <Plus size={13} /> {t("slip.addLeg")}
          </button>
          <button onClick={onLock} disabled={isSubmitting}
            className="flex items-center justify-center gap-2 flex-[2] py-3 rounded-xl text-[#072E49] text-sm font-bold active:scale-[0.97] transition-transform disabled:opacity-60"
            style={{ backgroundColor: color }}>
            {isSubmitting ? (
              <>
                <div className="w-4 h-4 rounded-full border-2 border-[#0A0E0C]/40 border-t-[#0A0E0C] animate-spin" />
                {t("slip.submitting")}
              </>
            ) : (
              <>
                <Share2 size={14} />
                {t("slip.lockSlip")}
                <ChevronRight size={14} className="ml-auto" />
              </>
            )}
          </button>
        </div>

        {/*
          Divulgation de visibilité, au moment de la collecte.

          C'est CETTE ligne qui rend le consentement éclairé, pas les CGU : la
          personne apprend ce qu'il adviendra de son coupon à l'instant où elle
          le dépose, pas dans un document qu'elle n'ouvrira jamais.

          Formulée comme la RÈGLE et non comme l'état du compte : afficher le
          réglage réel imposerait de charger le profil dans un CTA collant, avec
          le mode de panne qui va avec. Le texte mentionne l'opt-out, il reste
          donc vrai pour qui s'est retiré — et l'imprécision, s'il en reste une,
          va dans le sens de la sur-information.
        */}
        <p className="text-[#4a6068] text-[9px] leading-snug mt-2.5 text-center">
          {t("slip.visibilityNotice")}
        </p>
      </div>
    </div>
  );
}
