/**
 * BestParlaySection.tsx — « Best Parlay » de l'accueil (2026-10-04).
 *
 * La section NE CALCULE RIEN : les combinés sont construits par le serveur
 * (`server/src/services/bestParlays.service.ts`) sur le pool de « Meilleurs
 * paris », probabilité finale comprise (le calcul du coupon, corrélations
 * d'un même match incluses). Ici on affiche.
 *
 * Repliée par défaut, et RIEN n'est demandé tant qu'elle n'a pas été ouverte :
 * la requête part à la première ouverture, une seule fois (refermer puis
 * rouvrir ne la relance pas). L'en-tête reprend celui de « Value Bets »
 * (icône 13 px à la couleur d'accent, titre blanc `text-sm font-medium`), avec
 * le chevron de « Meilleurs paris » puisqu'elle se replie.
 *
 * Gratuit / Pro : c'est le serveur qui tranche. Un non-abonné reçoit les deux
 * premiers combinés en entier et, pour les autres, une coquille sans jambes ni
 * pourcentage — d'où les cartes verrouillées, qui ne montrent que la forme.
 *
 * 2026-10-04 (demande du user) : cartes étroites sur UNE rangée défilante
 * (classes et flèches de `LiveGamesRow`), sélections dans un menu déroulant
 * par carte. Puis (même jour) : sans titre ni ligne de type, sélections
 * toujours visibles — plus de menu déroulant.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ChevronRight, ChevronLeft, Layers, Check, Plus, Lock } from "lucide-react";
import { useI18n } from "../../i18n";
import { useBet } from "../../context/BetContext";
import { ErrorState } from "../../components/ErrorState";
import { features } from "../../platform";
import { BookPricePill, FairOddsPill } from "../../components/BookPricePill";
import {
  predictionApiService,
  type ApiBestParlay,
  type ApiLockedParlay,
  type BestParlaysResponse,
} from "../../services/predictionApiService";
import { bestBetToLeg } from "./BestBetsSection";


function isLocked(p: ApiBestParlay | ApiLockedParlay): p is ApiLockedParlay {
  return p.locked === true;
}

/**
 * Une jambe, en version étroite (carte de 176 px) : le pari sur deux lignes au
 * plus, son contexte dessous, son % ML à droite.
 */
function LegRow({ leg, pct }: { leg: ReturnType<typeof bestBetToLeg>; pct: number }) {
  return (
    <div className="flex items-start gap-1.5 py-1">
      {leg.subjectLogo?.startsWith("http")
        ? <img src={leg.subjectLogo} alt="" className="w-4 h-4 object-contain flex-shrink-0 mt-px" />
        : <span className="w-4 h-4 rounded-full bg-white/5 flex-shrink-0 mt-px" />}
      <div className="flex-1 min-w-0">
        <div className="text-white text-[11px] font-semibold leading-tight line-clamp-2">{leg.selection}</div>
        <div className="text-[#8a9ea6] text-[10px] truncate">{leg.gameInfo}</div>
      </div>
      <span className="text-[#bfc8cc] text-[10px] font-semibold tabular-nums flex-shrink-0">{pct} %</span>
    </div>
  );
}

/** Largeur d'une carte : étroite, pour en voir près de deux à 390 px (demande du user, 2026-10-04). */
const CARD_W = "w-44";

/**
 * Un combiné, en carte étroite de la rangée : %, cote, puis ses sélections,
 * toujours visibles (2026-10-04, demande du user : plus de titre « Combiné
 * n° x », plus de ligne « type · n sélections », plus de menu déroulant).
 */
function ParlayCard({ parlay, accent }: { parlay: ApiBestParlay; accent: string }) {
  const { t } = useI18n();
  const { addLeg, removeLeg, hasLeg } = useBet();
  // Libellés retraduits au changement de langue, sans nouvelle requête.
  const legs = useMemo(() => parlay.legs.map((b) => ({ leg: bestBetToLeg(b, t), pct: b.mlPct ?? b.score })), [parlay, t]);
  const allIn = legs.every(({ leg }) => hasLeg(leg.id));

  // Les jambes partent dans le coupon avec LEUR % ML, comme depuis « Meilleurs paris ».
  const toggleSlip = () => {
    if (allIn) legs.forEach(({ leg }) => removeLeg(leg.id));
    else legs.forEach(({ leg, pct }) => { if (!hasLeg(leg.id)) addLeg({ ...leg, probability: pct }); });
  };

  return (
    <div data-parlay-card className={`${CARD_W} flex-shrink-0 icy-card rounded-xl px-2.5 py-2`}>
      <div className="flex items-end justify-between gap-1">
        <div className="tabular-nums leading-none" style={{ color: accent }}>
          <span className="text-[17px] font-bold">{parlay.probability} %</span>
          <span className="block text-[10px] font-medium mt-0.5">{t("home.chance")}</span>
        </div>
        {parlay.bookPrice != null
          ? <BookPricePill price={parlay.bookPrice} link={false} />
          : <FairOddsPill pct={parlay.probability} title={t("home.oddsFairHint")} />}
      </div>

      <div className="border-t border-white/5 mt-2 pt-0.5">
        {legs.map(({ leg, pct }) => <LegRow key={leg.id} leg={leg} pct={pct} />)}
        {parlay.assumesIndependence && (
          <p className="text-[#8a9ea6] text-[9px] leading-snug mt-0.5">{t("parlay.indepNote")}</p>
        )}
      </div>

      <button
        type="button"
        onClick={toggleSlip}
        className={`mt-1.5 w-full flex items-center justify-center gap-1 rounded-lg border py-1 text-[10px] font-semibold transition-colors ${
          allIn
            ? "bg-green-500/15 border-green-500/30 text-green-400"
            : "bg-[#90C9F0]/10 border-[#90C9F0]/30 text-[#90C9F0] active:bg-[#90C9F0]/20"
        }`}
      >
        {allIn ? <Check size={12} strokeWidth={3} /> : <Plus size={12} strokeWidth={3} />}
        {allIn ? t("parlay.inSlip") : t("parlay.addShort")}
      </button>
    </div>
  );
}

/**
 * Un combiné Pro vu par un non-abonné, dans la même rangée : la forme
 * (type, nombre de sélections) et un cadenas — aucune donnée réelle n'est
 * arrivée ici. Bouton vers /pro seulement si le build en a un (Guideline
 * 3.1.1, même règle que `ProLock`).
 */
function LockedCard({ item }: { item: ApiLockedParlay }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <div data-parlay-card className={`${CARD_W} flex-shrink-0 icy-card rounded-xl px-2.5 py-2`}>
      <div className="flex items-center gap-1.5 text-white text-[12px] font-bold leading-tight">
        <Lock size={11} className="text-[#f2c744]" />{t("parlay.proCard")}
      </div>
      <div className="mt-2 flex flex-col gap-1" aria-hidden style={{ filter: "blur(2px)" }}>
        {Array.from({ length: item.legCount }, (_, i) => (
          <div key={i} className="h-2.5 rounded bg-white/[0.07]" style={{ width: `${90 - i * 12}%` }} />
        ))}
      </div>
      {features.proUpgrade ? (
        /* `state.from` : /pro ne peut pas revenir par l'historique (voir ProLock). */
        <button
          type="button"
          onClick={() => navigate("/pro", { state: { from: location.pathname + location.search } })}
          className="mt-2 w-full rounded-lg py-1 text-[10px] font-bold active:scale-[0.98] transition-transform"
          style={{ background: "#86d1ea", color: "#0A0E0C" }}
        >
          {t("pro.unlock")}
        </button>
      ) : (
        <p className="mt-2 text-[10px] text-[#8a9ea6] leading-snug">{t("home.proOnly")}</p>
      )}
    </div>
  );
}

/**
 * La rangée : mêmes classes et mêmes flèches que les matchs en direct
 * (`LiveGamesRow`) — défilement au doigt, barre masquée, accroche par carte.
 * `items-start` : ouvrir le menu d'une carte n'étire pas les autres. Flèches
 * à hauteur du titre et repoussées dans la gouttière, pour ne couvrir aucun
 * texte de la carte.
 */
function ParlayRow({ children, count }: { children: React.ReactNode; count: number }) {
  const { t } = useI18n();
  const viewport = useRef<HTMLDivElement>(null);
  const go = (dir: -1 | 1) => {
    const el = viewport.current;
    if (!el) return;
    const card = el.querySelector<HTMLElement>("[data-parlay-card]");
    el.scrollBy({ left: dir * ((card?.offsetWidth ?? 176) + 12), behavior: "smooth" });
  };
  return (
    <div className="live-carousel -mx-4">
      <div ref={viewport} className="live-viewport">
        <div className="live-track items-start">{children}</div>
      </div>
      {count > 2 && (
        <>
          <button type="button" className="jersey-arrow jersey-arrow--prev" style={{ top: 40, left: -16 }} aria-label={t("parlay.prev")} onClick={() => go(-1)}>
            <span className="jersey-arrow-dot"><ChevronLeft size={16} /></span>
          </button>
          <button type="button" className="jersey-arrow jersey-arrow--next" style={{ top: 40, right: -16 }} aria-label={t("parlay.next")} onClick={() => go(1)}>
            <span className="jersey-arrow-dot"><ChevronRight size={16} /></span>
          </button>
        </>
      )}
    </div>
  );
}

export function BestParlaySection({ accent }: { accent: string }) {
  const { t } = useI18n();
  // Repliée à chaque visite (demande du user) : pas de mémoire en localStorage.
  const [open, setOpen] = useState(false);
  // Passe à vrai à la PREMIÈRE ouverture et n'y revient jamais : refermer et
  // rouvrir (même pendant le chargement) ne relance pas la requête. Seul
  // « Réessayer » (`reloadKey`) en relance une.
  const [requested, setRequested] = useState(false);
  const [data, setData] = useState<BestParlaysResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!requested) return;
    let cancelled = false;
    setError(null);
    predictionApiService.getBestParlays()
      .then((r) => { if (!cancelled) setData(r); })
      .catch((e) => { if (!cancelled) setError(e ?? new Error("best parlays failed")); });
    return () => { cancelled = true; };
  }, [requested, reloadKey]);

  const toggle = () => { setOpen((o) => !o); setRequested(true); };

  const free = useMemo(() => (data?.parlays ?? []).filter((p): p is ApiBestParlay => !isLocked(p)), [data]);
  const locked = useMemo(() => (data?.parlays ?? []).filter(isLocked), [data]);

  return (
    <section className="px-4">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        title={open ? t("home.hide") : t("home.show")}
        className={`w-full flex items-center gap-2 select-none ${open ? "mb-3" : ""}`}
      >
        <ChevronRight
          size={14}
          className="text-[#8a9ea6] transition-transform"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
        />
        <Layers size={13} style={{ color: accent }} />
        <span className="text-white text-sm font-medium">{t("parlay.title")}</span>
        {data && data.parlays.length > 0 && (
          <span className="text-[11px] text-[#bfc8cc] icy-tile px-1.5 py-0.5 rounded-full">{data.parlays.length}</span>
        )}
      </button>

      {open && (
        <>
          <p className="text-[#8a9ea6] text-[11px] mb-2">{t("parlay.explain")}</p>
          {error ? (
            <ErrorState
              compact
              error={error}
              onRetry={() => { setData(null); setReloadKey((k) => k + 1); }}
            />
          ) : data == null ? (
            <div className="flex gap-3">
              {[1, 2].map((i) => <div key={i} className={`${CARD_W} h-32 icy-tile rounded-xl animate-pulse`} />)}
            </div>
          ) : data.parlays.length === 0 ? (
            <div className="py-6 text-center text-[#bfc8cc] text-xs">
              {data.meta.mlAvailable === false ? t("home.aiUnavailable") : t("parlay.empty")}
            </div>
          ) : (
            <ParlayRow count={data.parlays.length}>
              {free.map((p) => <ParlayCard key={p.id} parlay={p} accent={accent} />)}
              {locked.map((p) => <LockedCard key={p.id} item={p} />)}
            </ParlayRow>
          )}
        </>
      )}
    </section>
  );
}
