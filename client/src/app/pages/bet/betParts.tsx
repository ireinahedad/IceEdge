/**
 * betParts.tsx
 *
 * Extrait de BetBuilderPage.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { useState, useEffect, type Ref } from "react";
import { Plus, X, Lock, Share2, ChevronRight, AlertCircle, Info } from "lucide-react";
import type { BetLeg } from "../../types/bet";
import type { SlipAnalysis } from "../../context/BetContext";
import { openBet } from "../../services/bookmakers";
import { features } from "../../platform";
import { useBookmaker } from "../../context/BookmakerContext";
import { useI18n } from "../../i18n";


// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Probabilité du modèle → cote américaine ÉQUIVALENTE.
 *
 * ⚠️⚠️ Ne PAS brancher cette fonction sur le format choisi dans les Réglages.
 * Ce réglage ne concerne que les cotes des BOOKMAKERS (bet365, Stake…), c'est-
 * à-dire de vrais prix. Ce que produit `toOddsLabel`, c'est la traduction d'une
 * probabilité du modèle — une mesure de confiance, pas un prix — et la laisser
 * changer de format avec les cotes du livre reviendrait à faire passer notre
 * estimation pour une offre de pari. Elle reste donc en américain, toujours,
 * exactement comme la probabilité qui l'accompagne reste en %.
 *
 * Sert aussi à remplir le champ `oddsLabel` du pari ENREGISTRÉ (voir
 * `BetBuilderPage`), relu des mois plus tard sur un autre appareil : une donnée
 * archivée doit de toute façon avoir un format fixe.
 */
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
            {/* Toujours en % : c'est la probabilité du modèle, pas un prix.
                Voir `toOddsLabel` plus haut. */}
            <span className="text-white text-4xl font-bold">{displayed}<span className="text-2xl">%</span></span>
            <span className="text-xs mt-0.5 font-medium" style={{ color }}>{label}</span>
          </>
        ) : (
          <>
            <span className="text-[#1B2419] text-4xl font-bold">--</span>
            <span className="text-[#4a6068] text-[11px] mt-1 text-center px-4 leading-snug">{t("slip.addToSee")}</span>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Ce que la combinaison a changé ───────────────────────────────────────────

/**
 * Les trois faits que `parlay.ts` établissait sans que personne les montre.
 *
 * Sans ce bloc, le coupon mentait par omission dans deux cas :
 *
 *  • deux paris incompatibles affichaient une jauge à **0 %** et pas un mot —
 *    indiscernable d'un bug, et la seule action utile (retirer un pari) n'était
 *    suggérée nulle part ;
 *  • un doublon — ou un pari déjà contenu dans un autre — sortait du calcul
 *    **en silence**, donc le total ne correspondait plus aux cartes affichées
 *    juste en dessous.
 *
 * Le troisième cas est l'inverse : le chiffre est là, mais on sait qu'il est
 * approximatif (jambes d'un même match multipliées sans lien connu). Le dire
 * coûte une ligne ; le taire, c'est vendre une précision qu'on n'a pas.
 *
 * ⚠️⚠️ **RÈGLE DU USER (2026-09-15)** : deux paris ont le DROIT de se
 * contredire. On doit pouvoir faire ici ce qu'on fait chez un bookmaker —
 * poser les deux et décider ensuite. Ce bloc INFORME, il n'interdit rien et il
 * ne demande rien : pas de blocage de « Verrouiller », pas de rouge d'erreur,
 * et surtout aucune injonction à retirer un pari. Une première version disait
 * « retires-en un » : c'est exactement ce qu'il ne faut pas écrire.
 */
export function SlipNotices({ analysis }: { analysis: SlipAnalysis }) {
  const { t } = useI18n();
  const { impossible, redundantLegs, assumesIndependence } = analysis;
  if (!impossible && redundantLegs === 0 && !assumesIndependence) return null;

  return (
    <div className="flex flex-col gap-2 mb-4">
      {impossible && (
        // `role="status"` et pas `alert` : l'annonce doit être polie, on ne
        // signale pas une faute. L'ambre est là pour que la ligne se remarque
        // au milieu des cartes, pas pour dire « interdit » — le rouge de ce
        // fichier reste réservé à l'échec de verrouillage.
        <div role="status" className="flex items-start gap-2 px-3 py-2.5 rounded-xl border"
          style={{ backgroundColor: "#facc1514", borderColor: "#facc1540" }}>
          <AlertCircle size={13} className="flex-shrink-0 mt-0.5" style={{ color: "#facc15" }} />
          <div>
            <p className="text-[11px] font-bold" style={{ color: "#facc15" }}>{t("slip.impossibleTitle")}</p>
            <p className="text-[#bfc8cc] text-[11px] leading-snug mt-0.5">{t("slip.impossibleBody")}</p>
          </div>
        </div>
      )}
      {redundantLegs > 0 && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-xl icy-tile">
          <Info size={13} className="text-[#90C9F0] flex-shrink-0 mt-0.5" />
          <p className="text-[#bfc8cc] text-[11px] leading-snug">
            {redundantLegs === 1
              ? t("slip.redundantOne")
              : t("slip.redundantMany", { n: redundantLegs })}
          </p>
        </div>
      )}
      {assumesIndependence && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-xl icy-tile">
          <Info size={13} className="text-[#8a9ea6] flex-shrink-0 mt-0.5" />
          <p className="text-[#8a9ea6] text-[11px] leading-snug">{t("slip.sameGameApprox")}</p>
        </div>
      )}
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
          <div className="w-7 h-7 rounded-full bg-[#90C9F0]/10 border border-[#90C9F0]/25 flex items-center justify-center text-[11px] font-bold text-[#90C9F0]">
            {index + 1}
          </div>
          {leg.subjectLogo?.startsWith("http")
            ? <img src={leg.subjectLogo} alt="" className="w-6 h-6 object-contain" />
            : <span className="text-base">{leg.subjectLogo}</span>}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-white text-xs font-bold">{leg.subjectName}</p>
          <p className="text-[#90C9F0] text-[11px] font-medium">{leg.marketLabel}</p>
          <p className="text-[#8a9ea6] text-[11px] mt-0.5 leading-relaxed">{leg.selection}</p>
          {leg.gameInfo && <p className="text-[#4a6068] text-[11px] mt-0.5">{leg.gameInfo}</p>}
          <div className="mt-2 flex items-center gap-2">
            <div className="flex-1 bg-[#0A0E0C] rounded-full h-1.5">
              <div className="h-1.5 rounded-full transition-all duration-500"
                style={{ width: `${leg.probability}%`, backgroundColor: barColor }} />
            </div>
            <span className="text-xs font-bold flex-shrink-0" style={{ color: barColor }}>{leg.probability}%</span>
            <span className="text-[11px] text-[#4a6068] flex-shrink-0 font-mono">{toOddsLabel(leg.probability)}</span>
          </div>
          {/* APPLE_PLAN §4 — Guideline 5.3: the leg keeps its price, the link out
              to the sportsbook does not ship on iOS. */}
          {features.bookmakerLinks && (
            <button
              onClick={() => openBet("hockey")}
              className="mt-2 inline-flex items-center gap-1.5 bg-[#126e51] hover:bg-[#0f5c44] text-[#ffd700] text-[11px] font-bold px-2.5 py-1.5 rounded-lg transition-colors"
              title={`${bookmaker.label} — ${t("slip.placeBet")}`}
            >
              <span className="bg-[#ffd700] text-[#126e51] rounded px-1 py-0.5 text-[11px] font-black leading-none">{bookmaker.badge}</span>
              {t("slip.placeBet", { book: bookmaker.label })}
            </button>
          )}
        </div>
        <button onClick={onRemove}
          className="tap-44 w-7 h-7 rounded-full icy-tile flex items-center justify-center text-[#8a9ea6] flex-shrink-0 active:bg-red-500/20 active:text-red-400 active:border-red-400/30 transition-colors">
          <X size={10} />
        </button>
      </div>
    </div>
  );
}

// ─── Empty builder state ──────────────────────────────────────────────────────

/**
 * `onBrowse` mène à la page Stats, pas à la feuille de sélection des marchés.
 *
 * Un coupon vide n'est pas un formulaire à remplir : la personne ne sait pas
 * encore SUR QUOI parier. La feuille de sélection suppose l'inverse — elle
 * demande de choisir un match puis un marché sans jamais montrer un chiffre.
 * Le point d'entrée honnête est donc l'écran qui porte les données ; la feuille
 * reste accessible par « Ajouter » une fois qu'il y a au moins une jambe.
 */
export function EmptySlip({ onBrowse }: { onBrowse: () => void }) {
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
      <button onClick={onBrowse}
        className="bg-[#86d1ea] text-[#072E49] font-bold px-6 py-3 rounded-2xl text-sm flex items-center gap-2 active:scale-95 transition-transform">
        <Plus size={14} /> {t("slip.browse")}
      </button>
    </div>
  );
}

// ─── Lock CTA ─────────────────────────────────────────────────────────────────

export function LockSlipCTA({
  legs, combinedProbability, onAdd, onLock, isSubmitting, error, panelRef,
}: {
  legs: BetLeg[]; combinedProbability: number | null;
  onAdd: () => void; onLock: () => void; isSubmitting: boolean;
  /** Pourquoi le dernier verrouillage a échoué. Affiché ICI, contre le bouton
   *  qui vient d'être touché : l'échec était jusqu'ici écrit dans un état que
   *  rien ne rendait (cf. `BetBuilderPage.tsx`). Le bloc est mesuré par un
   *  `ResizeObserver`, donc la marge basse de la page suit toute seule. */
  error?: string | null;
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
    <div ref={panelRef} className="fixed bottom-[calc(68px+env(safe-area-inset-bottom,0px))] left-1/2 -translate-x-1/2 max-w-[430px] md:max-w-5xl w-full px-4 z-40">
      <div className="icy-card bet-ink-black rounded-2xl p-3 shadow-xl shadow-black/40">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center"
              style={{ backgroundColor: `${color}15`, border: `1px solid ${color}30` }}>
              <Lock size={13} style={{ color }} />
            </div>
            <div>
              <p className="text-white text-xs font-bold">{t("slip.legsReady", { n: legs.length })}</p>
              <p className="text-[#4a6068] text-[11px]">{t("slip.signinRequired")}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[11px] text-[#8a9ea6]">{t("slip.combined")}</p>
            <p className="text-lg font-black" style={{ color }}>{combinedProbability != null ? `${combinedProbability}%` : "—"}</p>
          </div>
        </div>
        {error && (
          <div role="alert" className="flex items-start gap-2 mb-2.5 px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/25">
            <AlertCircle size={12} className="text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-red-300 text-[11px] leading-snug">{error}</p>
          </div>
        )}

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
        <p className="text-[#4a6068] text-[11px] leading-snug mt-2.5 text-center">
          {t("slip.visibilityNotice")}
        </p>
      </div>
    </div>
  );
}
