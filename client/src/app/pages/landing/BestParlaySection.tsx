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
 */

import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Layers, Check, Plus, Lock } from "lucide-react";
import { useI18n } from "../../i18n";
import { useBet } from "../../context/BetContext";
import { ErrorState } from "../../components/ErrorState";
import { ProLock } from "../../components/ProLock";
import { BookPricePill, FairOddsPill } from "../../components/BookPricePill";
import {
  predictionApiService,
  type ApiBestParlay,
  type ApiLockedParlay,
  type BestParlaysResponse,
} from "../../services/predictionApiService";
import { bestBetToLeg } from "./BestBetsSection";

type TFn = ReturnType<typeof useI18n>["t"];

function isLocked(p: ApiBestParlay | ApiLockedParlay): p is ApiLockedParlay {
  return p.locked === true;
}

/** Une jambe : logo, pari, contexte — et son % ML à droite. */
function LegRow({ leg, pct }: { leg: ReturnType<typeof bestBetToLeg>; pct: number }) {
  return (
    <div className="flex items-center gap-2 py-1">
      {leg.subjectLogo?.startsWith("http")
        ? <img src={leg.subjectLogo} alt="" className="w-5 h-5 object-contain flex-shrink-0" />
        : <span className="w-5 h-5 rounded-full bg-white/5 flex-shrink-0" />}
      <div className="flex-1 min-w-0">
        <div className="text-white text-[12px] font-semibold leading-tight truncate">{leg.selection}</div>
        <div className="text-[#8a9ea6] text-[11px] truncate">{leg.gameInfo} · {leg.marketLabel}</div>
      </div>
      <span className="text-[#bfc8cc] text-[11px] font-semibold tabular-nums flex-shrink-0">{pct} %</span>
    </div>
  );
}

function kindLabel(kind: ApiBestParlay["kind"], t: TFn) {
  return t(kind === "moneyline" ? "parlay.kindMoneyline" : "parlay.kindMixed");
}

function ParlayCard({ parlay, index, accent }: { parlay: ApiBestParlay; index: number; accent: string }) {
  const { t } = useI18n();
  const { addLeg, removeLeg, hasLeg } = useBet();
  // Libellés retraduits au changement de langue, sans nouvelle requête.
  const legs = useMemo(() => parlay.legs.map((b) => ({ leg: bestBetToLeg(b, t), pct: b.mlPct ?? b.score })), [parlay, t]);
  const allIn = legs.every(({ leg }) => hasLeg(leg.id));

  // Les jambes partent dans le coupon avec LEUR % ML, comme depuis « Meilleurs paris ».
  const toggle = () => {
    if (allIn) legs.forEach(({ leg }) => removeLeg(leg.id));
    else legs.forEach(({ leg, pct }) => { if (!hasLeg(leg.id)) addLeg({ ...leg, probability: pct }); });
  };

  return (
    <div className="icy-card rounded-xl px-3 py-2.5">
      <div className="flex items-start gap-2 mb-1">
        <div className="flex-1 min-w-0">
          <div className="text-white text-[13px] font-bold leading-tight">
            {t("parlay.name", { n: index + 1 })}
          </div>
          <div className="text-[#8a9ea6] text-[11px] mt-0.5">
            {kindLabel(parlay.kind, t)} · {t("parlay.legs", { n: parlay.legs.length })}
          </div>
        </div>
        <div className="flex flex-col items-end flex-shrink-0 leading-tight">
          <div className="tabular-nums" style={{ color: accent }}>
            <span className="text-[15px] font-bold">{parlay.probability} %</span>
            <span className="text-[10px] font-medium ml-1">{t("home.chance")}</span>
          </div>
          <span className="mt-0.5">
            {parlay.bookPrice != null
              ? <BookPricePill price={parlay.bookPrice} link={false} />
              : <FairOddsPill pct={parlay.probability} title={t("home.oddsFairHint")} />}
          </span>
        </div>
      </div>

      <div className="border-t border-white/5 mt-1.5 pt-0.5">
        {legs.map(({ leg, pct }) => <LegRow key={leg.id} leg={leg} pct={pct} />)}
      </div>

      {parlay.assumesIndependence && (
        <p className="text-[#8a9ea6] text-[10px] leading-snug mt-1">{t("parlay.indepNote")}</p>
      )}

      <button
        type="button"
        onClick={toggle}
        className={`tap-44 mt-2 w-full flex items-center justify-center gap-1.5 rounded-lg border py-1.5 text-[11px] font-semibold transition-colors ${
          allIn
            ? "bg-green-500/15 border-green-500/30 text-green-400"
            : "bg-[#90C9F0]/10 border-[#90C9F0]/30 text-[#90C9F0] active:bg-[#90C9F0]/20"
        }`}
      >
        {allIn ? <Check size={13} strokeWidth={3} /> : <Plus size={13} strokeWidth={3} />}
        {allIn ? t("parlay.inSlip") : t("parlay.addAll")}
      </button>
    </div>
  );
}

/** Les combinés Pro, vus par un non-abonné : la forme, floutée, sous `ProLock`. */
function LockedParlays({ items }: { items: ApiLockedParlay[] }) {
  const { t } = useI18n();
  return (
    <ProLock locked title={t("parlay.lockTitle", { n: items.length })} description={t("parlay.lockDesc")}>
      <div className="flex flex-col gap-1.5">
        {items.map((p) => (
          <div key={p.id} className="icy-card rounded-xl px-3 py-2.5">
            <div className="flex items-center gap-2">
              <Lock size={12} className="text-[#8a9ea6]" />
              <span className="text-white text-[12px] font-semibold">
                {kindLabel(p.kind, t)} · {t("parlay.legs", { n: p.legCount })}
              </span>
            </div>
            {/* Barres neutres : aucune donnée réelle n'est arrivée ici. */}
            {Array.from({ length: p.legCount }, (_, i) => (
              <div key={i} className="h-3 rounded bg-white/[0.06] mt-1.5" style={{ width: `${85 - i * 10}%` }} />
            ))}
          </div>
        ))}
      </div>
    </ProLock>
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
            <div className="flex flex-col gap-1.5">
              {[1, 2].map((i) => <div key={i} className="h-36 icy-tile rounded-xl animate-pulse" />)}
            </div>
          ) : data.parlays.length === 0 ? (
            <div className="py-6 text-center text-[#bfc8cc] text-xs">
              {data.meta.mlAvailable === false ? t("home.aiUnavailable") : t("parlay.empty")}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {free.map((p, i) => <ParlayCard key={p.id} parlay={p} index={i} accent={accent} />)}
              {locked.length > 0 && <LockedParlays items={locked} />}
            </div>
          )}
        </>
      )}
    </section>
  );
}
