/**
 * MoreParlaysPage.tsx — `/parlays?date=AAAA-MM-JJ`, « Plus de parlays » (2026-10-11).
 *
 * Ouverte par le bouton sous « Best Parlay » de l'accueil, pour le MÊME jour.
 * Demande du user :
 *   • en tête, les mêmes combinés que l'accueil — tous cotés par le livre ;
 *   • puis d'autres, plus variés, qui peuvent contenir des paris SANS cote
 *     (on n'a pas les prix de tous les marchés) : 2 à 8 sélections, même
 *     match, même équipe, même type de pari, ou mélangés ;
 *   • toujours une seule journée.
 *
 * Comme la section de l'accueil, la page NE CALCULE RIEN : tout vient de
 * `GET /api/predict/more-parlays` (`bestParlays.service.ts`), probabilité
 * finale comprise. Un combiné sans cote du livre affiche la cote juste du
 * modèle (`FairOddsPill`, dans `ParlayCard`).
 *
 * RÉSERVÉE AUX PRO (demande du user, 2026-10-11). Le serveur refuse la route
 * à un non-abonné (`requirePro`) ; ici, un non-abonné voit un écran verrouillé
 * et AUCUNE requête ne part. Le temps que l'abonnement se lise, on attend
 * plutôt que d'afficher le cadenas une fraction de seconde à un Pro.
 */

import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { Lock } from "lucide-react";
import { BottomNav } from "../components/BottomNav";
import { ErrorState } from "../components/ErrorState";
import { useSport } from "../context/SportContext";
import { useAuth } from "../context/AuthContext";
import { useSubscription } from "../context/SubscriptionContext";
import { features } from "../platform";
import { useI18n } from "../i18n";
import {
  predictionApiService,
  type ApiBestParlay,
  type ApiLockedParlay,
  type MoreParlaysResponse,
  type ParlayKind,
} from "../services/predictionApiService";
import { ParlayCard, LockedCard } from "./landing/BestParlaySection";

type Item = ApiBestParlay | ApiLockedParlay;
type Section = "featured" | Exclude<ParlayKind, "moneyline">;

const isLocked = (p: Item): p is ApiLockedParlay => p.locked === true;
const legCount = (p: Item) => (isLocked(p) ? p.legCount : p.legs.length);

/** Ordre des sections à l'écran. */
const SECTIONS: Section[] = ["featured", "same_game", "same_team", "same_market", "mixed"];
const SIZES = [2, 3, 4, 5, 6, 7, 8];

/** Ce que les jambes ont en commun, lisible : `MTL @ TOR`, `TOR`, le marché traduit. */
function groupLabel(p: Item): string | null {
  if (isLocked(p) || !p.group) return null;
  if (p.kind === "same_game") return p.group.replace("@", " @ ");
  if (p.kind === "same_market") return p.legs[0]?.marketLabel ?? p.group;
  return p.group;
}

function formatDay(day: string | null, lang: string): string {
  if (!day) return "";
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString(lang === "fr" ? "fr-CA" : "en-US", {
    weekday: "long", day: "numeric", month: "long", timeZone: "UTC",
  });
}

function Chip({ active, onClick, accent, children }: {
  active: boolean; onClick: () => void; accent: string; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="flex-shrink-0 px-3 min-h-[36px] rounded-full text-xs font-medium border transition-all"
      style={active
        ? { backgroundColor: accent + "22", borderColor: accent, color: "#fff" }
        : { backgroundColor: "#131A12", borderColor: "rgba(255,255,255,0.1)", color: "#8a9ea6" }}
    >
      {children}
    </button>
  );
}

export function MoreParlaysPage() {
  const navigate = useNavigate();
  const { theme } = useSport();
  const accent = theme.accent;
  const { t, lang } = useI18n();
  const location = useLocation();
  const { user } = useAuth();
  const { isPro, status, loading: subLoading } = useSubscription();
  // Connecté mais abonnement pas encore lu : on ne tranche pas encore.
  const subPending = !!user && status == null && subLoading;
  const blocked = !subPending && !isPro;
  const [params] = useSearchParams();
  const date = params.get("date") ?? undefined;

  const [data, setData] = useState<MoreParlaysResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [section, setSection] = useState<Section | "all">("all");
  const [size, setSize] = useState<number | null>(null);

  useEffect(() => {
    if (!isPro) return;            // jamais de requête pour un non-abonné
    let cancelled = false;
    setError(null);
    setData(null);
    predictionApiService.getMoreParlays(date)
      .then((r) => { if (!cancelled) setData(r); })
      .catch((e) => { if (!cancelled) setError(e ?? new Error("more parlays failed")); });
    return () => { cancelled = true; };
  }, [date, reloadKey, isPro]);

  /** Combinés rangés par section, filtre de taille appliqué. */
  const bySection = useMemo(() => {
    const out = new Map<Section, Item[]>();
    if (!data) return out;
    const keep = (p: Item) => size == null || legCount(p) === size;
    out.set("featured", data.featured.filter(keep));
    for (const p of data.more) {
      if (!keep(p) || p.kind === "moneyline") continue;
      const k = p.kind as Section;
      if (!out.has(k)) out.set(k, []);
      out.get(k)!.push(p);
    }
    return out;
  }, [data, size]);

  /** Sections qui ont quelque chose, toutes tailles confondues — pour les puces. */
  const available = useMemo(() => {
    if (!data) return [] as Section[];
    const kinds = new Set<string>(data.more.map((p) => p.kind));
    return SECTIONS.filter((s) => (s === "featured" ? data.featured.length > 0 : kinds.has(s)));
  }, [data]);

  const sizes = useMemo(() => {
    if (!data) return [] as number[];
    const all = new Set([...data.featured, ...data.more].map(legCount));
    return SIZES.filter((n) => all.has(n));
  }, [data]);

  const shown = SECTIONS.filter((s) => (section === "all" || section === s) && (bySection.get(s)?.length ?? 0) > 0);
  const day = data?.meta.day ?? date ?? null;
  const total = data ? data.featured.length + data.more.length : 0;

  return (
    <div className="flex flex-col min-h-screen bg-transparent text-white max-w-[430px] md:max-w-5xl mx-auto w-full">
      <header className="bg-[#0A0E0C]/80 backdrop-blur-md sticky top-0 z-40" style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}>
        <div className="px-4 pt-3 pb-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate(-1)}
            aria-label={t("common.back")}
            className="min-w-[44px] min-h-[44px] w-9 h-9 rounded-xl bg-[#131A12] border border-white/20 flex items-center justify-center flex-shrink-0"
            style={{ color: accent }}
          >
            ←
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-white font-bold text-base leading-tight uppercase" style={{ fontFamily: "'Oswald', 'Oswald Fallback', 'Arial Narrow', sans-serif" }}>
              {t("parlays.title")}
            </h1>
            <p className="text-[#8a9ea6] text-[11px] first-letter:uppercase">
              {t("parlays.subtitle", { day: formatDay(day, lang) })}
            </p>
          </div>
        </div>

        {data && total > 0 && (
          <div className="px-4 pb-3 flex flex-col gap-2">
            <div className="flex gap-2 overflow-x-auto scrollbar-hide">
              <Chip active={section === "all"} onClick={() => setSection("all")} accent={accent}>{t("parlays.all")}</Chip>
              {available.map((s) => (
                <Chip key={s} active={section === s} onClick={() => setSection(s)} accent={accent}>
                  {s === "featured" ? t("parlays.featured") : t(`parlays.kind.${s}`)}
                </Chip>
              ))}
            </div>
            <div className="flex gap-2 overflow-x-auto scrollbar-hide">
              <Chip active={size == null} onClick={() => setSize(null)} accent={accent}>{t("parlays.anySize")}</Chip>
              {sizes.map((n) => (
                <Chip key={n} active={size === n} onClick={() => setSize(n)} accent={accent}>{t("parlays.legs", { n })}</Chip>
              ))}
            </div>
          </div>
        )}
      </header>

      <div className="flex-1 px-4 pb-[calc(7rem+env(safe-area-inset-bottom,0px))] pt-3">
        <p className="text-[#8a9ea6] text-[11px] mb-3">{t("parlays.explain")}</p>

        {blocked ? (
          <div className="py-12 px-6 flex flex-col items-center text-center icy-card rounded-2xl">
            <div className="text-white text-sm font-bold mb-1 flex items-center gap-1.5">
              <Lock size={13} className="text-[#f2c744]" />{t("parlays.proTitle")}
            </div>
            <p className="text-[#B7C4AD] text-xs max-w-[300px]">{t("parlays.proDesc")}</p>
            {features.proUpgrade ? (
              <button
                type="button"
                onClick={() => navigate("/pro", { state: { from: location.pathname + location.search } })}
                className="mt-3 px-4 py-2 rounded-xl text-xs font-bold active:scale-[0.98] transition-transform"
                style={{ background: "#86d1ea", color: "#0A0E0C" }}
              >
                {t("pro.unlock")}
              </button>
            ) : (
              <p className="mt-3 text-[11px] text-[#8a9ea6]">{t("home.proOnly")}</p>
            )}
          </div>
        ) : error ? (
          <ErrorState error={error} onRetry={() => setReloadKey((k) => k + 1)} />
        ) : data == null ? (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[1, 2, 3, 4].map((i) => <div key={i} className="h-40 icy-tile rounded-xl animate-pulse" />)}
          </div>
        ) : total === 0 ? (
          <div className="py-10 text-center text-[#bfc8cc] text-xs">
            {data.meta.mlAvailable === false ? t("home.aiUnavailable") : t("parlays.noDay")}
          </div>
        ) : shown.length === 0 ? (
          <div className="py-10 text-center text-[#bfc8cc] text-xs">{t("parlays.empty")}</div>
        ) : (
          <div className="flex flex-col gap-5">
            {shown.map((s) => (
              <section key={s}>
                <h2 className="text-white text-sm font-medium mb-2">
                  {s === "featured" ? t("parlays.featured") : t(`parlays.kind.${s}`)}
                  <span className="ml-2 text-[11px] text-[#bfc8cc] icy-tile px-1.5 py-0.5 rounded-full">{bySection.get(s)!.length}</span>
                </h2>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 items-start">
                  {bySection.get(s)!.map((p) => {
                    const label = groupLabel(p);
                    return (
                      <div key={p.id} className="min-w-0">
                        {label && <div className="text-[10px] text-[#8a9ea6] font-semibold uppercase tracking-wide mb-1 truncate">{label}</div>}
                        {isLocked(p)
                          ? <LockedCard item={p} width="w-full" />
                          : <ParlayCard parlay={p} accent={accent} width="w-full" />}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      <BottomNav />
    </div>
  );
}
