/**
 * betParts.tsx
 *
 * Extrait de BetBuilderPage.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { useState, useEffect, type CSSProperties, type Ref } from "react";
import { Plus, X, Lock, ChevronRight, AlertCircle, Info, Radio } from "lucide-react";
import type { BetLeg } from "../../types/bet";
import type { SlipAnalysis } from "../../context/BetContext";
import { features } from "../../platform";
import { useBookmaker, minOddsFromPct } from "../../context/BookmakerContext";
import { useOddsFormat } from "../../context/OddsFormatContext";
import { useI18n } from "../../i18n";
import { SlipCommandLauncher } from "../../components/SlipCommandSheet";
import { ScanSlipLauncher } from "../../components/ScanSlipSheet";


// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * 🎨 Décision du user (2026-09-30) : sur la page du coupon, UNE couleur pour le
 * % du modèle et UNE couleur pour la cote, partout — pour qu'on reconnaisse
 * d'un coup d'œil ce qui est une chance et ce qui est une cote. La couleur ne
 * dit plus « fort / risqué » (le libellé de la jauge le dit en mots).
 *
 * La cote prend le vert des pastilles de prix du livre (`BookPricePill`) :
 * cote du modèle et cote du livre se lisent ainsi comme la même famille.
 */
export const PROB_COLOR = "#86d1ea";
export const ODDS_COLOR = "#4ade80"; // = text-green-400 de BookPricePill

/**
 * Prix décimal du livre → prix américain FIGÉ (« -150 », « +120 »), pour le
 * champ `oddsLabel` archivé avec le pari. Depuis le 2026-09-30 (décision du
 * user), `oddsLabel` porte le VRAI prix du livre au moment du verrouillage, et
 * plus la cote déduite du modèle — le ROI du tableau de bord dev
 * (`americanToProfit`) se calcule donc enfin sur un prix réel.
 */
export function decimalToAmericanLabel(decimal: number): string {
  if (!(decimal > 1)) return "";
  return decimal >= 2
    ? `+${Math.round((decimal - 1) * 100)}`
    : `-${Math.round(100 / (decimal - 1))}`;
}

/**
 * Cote combinée du LIVRE : produit des prix, seulement si TOUTES les jambes
 * sont cotées et portent sur des matchs DIFFÉRENTS (deux jambes d'un même
 * match sont corrélées : un livre ne paie pas leur produit). Une seule jambe
 * cotée → son prix. `null` sinon : rien plutôt qu'un faux.
 */
export function bookParlayPrice(legs: { gameId?: string; bookPrice?: number | null }[]): number | null {
  if (legs.length === 0) return null;
  const games = new Set(legs.map((l) => l.gameId));
  if (legs.length > 1 && (games.size !== legs.length || games.has(undefined))) return null;
  let prod = 1;
  for (const l of legs) {
    if (!l.bookPrice || !(l.bookPrice > 1)) return null;
    prod *= l.bookPrice;
  }
  return Math.round(prod * 100) / 100;
}

// ─── Probability gauge ────────────────────────────────────────────────────────

export function ProbabilityGauge({ pct, size = 180 }: { pct: number; size?: number }) {
  const { t } = useI18n();
  const [displayed, setDisplayed] = useState(0);
  const radius = (size - 24) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - displayed / 100);

  const color = PROB_COLOR;

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
            {/* Toujours en % : c'est la probabilité du modèle, pas un prix. */}
            <span className="text-4xl font-bold leading-none" style={{ color }}>{displayed}<span className="text-2xl">%</span></span>
            <span className="text-[11px] mt-1 font-medium" style={{ color }}>{t("slip.chance")}</span>
            <span className="text-[11px] mt-0.5 font-medium text-[#8a9ea6]">{label}</span>
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

export function LegCard({ leg, index, onRemove, bookPrice, started }: {
  leg: BetLeg; index: number; onRemove: () => void;
  /** Vrai prix DraftKings de cette jambe, si le livre la cote. */
  bookPrice?: number;
  /** Le match de cette jambe a commencé : le serveur refusera le coupon. */
  started?: boolean;
}) {
  const { t } = useI18n();
  const { bookmaker, openBetFor } = useBookmaker();
  const { odds } = useOddsFormat();
  const barColor = PROB_COLOR;
  // Ce qu'il faut chercher chez son livre (2026-10-02) : Bet365 n'ouvre pas un
  // pari précis. Match commencé → pas de cote minimale, notre % est d'avant-match.
  const goBet = () => openBetFor({
    match: leg.gameInfo ?? leg.subjectName,
    market: leg.marketLabel,
    selection: leg.selection,
    minOdds: started ? null : minOddsFromPct(leg.probability),
    shownPrice: bookPrice ?? null,
  });

  return (
    <div className="icy-card rounded-2xl p-4" style={started ? { boxShadow: "inset 0 0 0 1px #facc1560" } : undefined}>
      <div className="flex items-start gap-3">
        <div className="flex flex-col items-center gap-1.5 flex-shrink-0">
          <div className="w-7 h-7 rounded-full bg-[#90C9F0]/10 border border-[#90C9F0]/25 flex items-center justify-center text-[11px] font-bold text-[#90C9F0]">
            {index + 1}
          </div>
          {leg.subjectLogo?.startsWith("http")
            ? <img src={leg.subjectLogo} alt="" className="w-6 h-6 object-contain" />
            : <span className="w-6 h-6 rounded-full bg-white/5" />}
        </div>
        <div className="flex-1 min-w-0">
          {leg.subjectType === "player" ? (
            // Pari joueur : ce qui a été parié en tête, puis l'équipe du joueur
            // — son seul « sujet » affiché (voir MLProps.teamAbbr). Le libellé
            // de marché n'est pas répété quand il EST déjà la sélection.
            <>
              <p className="text-white text-xs font-bold">{leg.selection}</p>
              {leg.marketLabel && !leg.selection.includes(leg.marketLabel) && (
                <p className="text-[#90C9F0] text-[11px] font-medium">{leg.marketLabel}</p>
              )}
              {leg.subjectName && !/^\d+$/.test(leg.subjectName) && (
                <p className="text-[#8a9ea6] text-[11px] mt-0.5">{leg.subjectName.toUpperCase()}</p>
              )}
            </>
          ) : (
            <>
              <p className="text-white text-xs font-bold">{leg.subjectName}</p>
              <p className="text-[#90C9F0] text-[11px] font-medium">{leg.marketLabel}</p>
              <p className="text-[#8a9ea6] text-[11px] mt-0.5 leading-relaxed">{leg.selection}</p>
            </>
          )}
          {leg.gameInfo && <p className="text-[#4a6068] text-[11px] mt-0.5">{leg.gameInfo}</p>}
          <div className="mt-2 flex items-center gap-2">
            <div className="flex-1 bg-[#0A0E0C] rounded-full h-1.5">
              <div className="h-1.5 rounded-full transition-all duration-500"
                style={{ width: `${leg.probability}%`, backgroundColor: barColor }} />
            </div>
            <span className="text-xs font-bold flex-shrink-0" style={{ color: PROB_COLOR }}>
              {leg.probability}% <span className="text-[11px] font-medium">{t("slip.chance")}</span>
            </span>
            {/* Cote = VRAI prix du livre (DraftKings), plus la cote tirée
                du modèle (décision du user, 2026-09-30). Pas de prix → on le
                dit, sans inventer de chiffre. */}
            {bookPrice != null ? (
              <span className="text-[11px] font-bold flex-shrink-0 font-mono" style={{ color: ODDS_COLOR }}>
                {odds(bookPrice)} <span className="font-sans font-medium">{t("slip.oddsWord")}</span>
              </span>
            ) : (
              <span className="text-[11px] flex-shrink-0 text-[#4a6068]">{t("slip.noBookOdds")}</span>
            )}
          </div>
          {started && (
            <p className="mt-1.5 flex items-center gap-1 text-[11px] font-medium" style={{ color: "#facc15" }}>
              <Radio size={11} /> {t("slip.legLive")}
            </p>
          )}
          {/* APPLE_PLAN §4 — Guideline 5.3: the leg keeps its price, the link out
              to the sportsbook does not ship on iOS. */}
          {/* La cote du livre est déjà sur la ligne du % : plus de pastille ici. */}
          {features.bookmakerLinks && (
            <div className="mt-2 flex items-center gap-2 flex-wrap">
            <button
              onClick={goBet}
              // Couleurs du livre choisi (services/bookmakers.ts). Le survol passe
              // par une variable CSS : une couleur inline ne peut pas porter `:hover`.
              className="inline-flex items-center gap-1.5 bg-[var(--book-bg)] hover:bg-[var(--book-bg-hover)] text-[11px] font-bold px-2.5 py-1.5 rounded-lg transition-colors"
              style={{
                "--book-bg": bookmaker.colors.bg,
                "--book-bg-hover": bookmaker.colors.bgHover,
                color: bookmaker.colors.fg,
              } as CSSProperties}
              title={`${bookmaker.label} — ${t("slip.placeBet")}`}
            >
              <span
                className="rounded px-1 py-0.5 text-[11px] font-black leading-none"
                style={{ background: bookmaker.colors.badgeBg, color: bookmaker.colors.badgeFg }}
              >{bookmaker.badge}</span>
              {t("slip.placeBet", { book: bookmaker.label })}
            </button>
            </div>
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
        <p className="text-white font-bold mb-1" style={{ fontFamily: "'Merriweather', 'Merriweather Fallback', Georgia, serif" }}>
          {t("slip.empty")}
        </p>
        <p className="text-[#8a9ea6] text-xs leading-relaxed max-w-[220px]">
          {t("slip.emptyHint")}
        </p>
      </div>
      {/* « Bet builder IA » au-dessus de « Browse markets » (décision du user, 2026-09-28). */}
      <div className="w-full max-w-[280px] flex flex-col gap-2">
        <SlipCommandLauncher variant="block" />
        <ScanSlipLauncher variant="block" />
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
  legs, combinedProbability, onLock, isSubmitting, error, panelRef, isSignedIn,
}: {
  legs: BetLeg[]; combinedProbability: number | null;
  onLock: () => void; isSubmitting: boolean;
  /** Connecté : on ne rappelle pas « connexion requise ». */
  isSignedIn: boolean;
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
  // Bouton = cyan primaire (cf. AppButton) ; le % = PROB_COLOR, comme partout.
  const color = PROB_COLOR;

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
              {!isSignedIn && <p className="text-[#4a6068] text-[11px]">{t("slip.signinRequired")}</p>}
            </div>
          </div>
          <div className="text-right">
            <p className="text-[11px] text-[#8a9ea6]">{t("slip.combined")}</p>
            <p className="text-lg font-black leading-tight" style={{ color: combinedProbability != null ? PROB_COLOR : "#8a9ea6" }}>
              {combinedProbability != null ? `${combinedProbability}%` : "—"}
              {combinedProbability != null && <span className="text-[11px] font-medium ml-1">{t("slip.chance")}</span>}
            </p>
          </div>
        </div>
        {error && (
          <div role="alert" className="flex items-start gap-2 mb-2.5 px-3 py-2 rounded-xl bg-red-500/10 border border-red-500/25">
            <AlertCircle size={12} className="text-red-400 flex-shrink-0 mt-0.5" />
            <p className="text-red-300 text-[11px] leading-snug">{error}</p>
          </div>
        )}

        <div className="flex gap-2">
          {/* « Add Leg » retiré (décision du user, 2026-09-30) : « Ajouter »
              existe déjà au-dessus des cartes. */}
          <button onClick={onLock} disabled={isSubmitting}
            className="relative flex items-center justify-center gap-2 flex-1 py-3 rounded-xl text-[#072E49] text-sm font-bold active:scale-[0.97] transition-transform disabled:opacity-60"
            style={{ backgroundColor: color }}>
            {isSubmitting ? (
              <>
                <div className="w-4 h-4 rounded-full border-2 border-[#0A0E0C]/40 border-t-[#0A0E0C] animate-spin" />
                {t("slip.submitting")}
              </>
            ) : (
              <>
                {t("slip.lockSlip")}
                <ChevronRight size={14} className="absolute right-3" />
              </>
            )}
          </button>
        </div>

      </div>
    </div>
  );
}
