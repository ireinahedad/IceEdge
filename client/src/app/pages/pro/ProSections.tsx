/**
 * ProSections.tsx — les blocs de vente de /pro (refonte CRO du 2026-11-21).
 *
 * Principe : chaque bloc répond à UNE hésitation d'un parieur NHL devant un
 * abonnement de pronostics.
 *
 *   « Est-ce que ça vaut quelque chose ? »   → ProofChips (+ lien vers les résultats complets)
 *     (les chiffres PUBLIÉS d'arakiceML, `data/accuracyRecord.ts` — jamais de
 *     ROI ni de « locks » : dans ce marché, c'est ce qui fait fuir les gens
 *     sérieux, et ce serait invérifiable).
 *   « Qu'est-ce que je rate concrètement ? » → TonightTeaser (les VRAIS
 *     meilleurs paris de ce soir, choix masqué, probabilité visible) et
 *     CompareTable (gratuit vs Pro, avec les vrais plafonds).
 *   « Et si je regrette ? »                 → RiskReversal + Faq.
 *
 * ⚠️ Tout ce qui est affirmé ici doit être vrai côté serveur :
 *   - 2 combinés gratuits (`FREE_PARLAYS`, bestParlays.service) — on lit
 *     `meta.freeCount` / `meta.total`, pas une constante ;
 *   - 3 scans par jour (`SCAN_FREE_DAILY`) ;
 *   - quota IA : `sub.llmMonthlyQuota`, sinon formulation sans chiffre ;
 *   - value bets et « Plus de parlays » derrière `requirePro`.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Lock, Minus, ChevronDown, ShieldCheck, Trophy } from "lucide-react";
import { useI18n } from "../../i18n";
import { trackEvent } from "../../analytics";
import { accuracyRecord, ACCURACY_PAGE } from "../../data/accuracyRecord";
import type { ApiBestBet } from "../../services/predictionApiService";
import { marketName } from "../landing/BestBetsSection";
import { authedFetch } from "../../services/authService";
import { features } from "../../platform";

export const ACCENT        = "#86d1ea";
export const ACCENT_BG     = "rgba(134,209,234,0.12)";
export const ACCENT_BORDER = "rgba(134,209,234,0.3)";
export const SURFACE       = "#131A12";
export const BORDER        = "#283323";
export const MUTED         = "#92A08A";
const TEXT                 = "#F3F7F0";
const SUBTLE               = "#B7C4AD";

/** Gratuit au moment de l'écriture (scanQuota.service). Affiché seulement. */
export const FREE_SCANS_PER_DAY = 3;

function fmtPct(n: number, lang: "en" | "fr"): string {
  return `${n.toLocaleString(lang === "fr" ? "fr-CA" : "en-US", { maximumFractionDigits: 1 })} %`;
}
function fmtInt(n: number, lang: "en" | "fr"): string {
  return n.toLocaleString(lang === "fr" ? "fr-CA" : "en-US");
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[11px] uppercase tracking-wider font-bold mb-3" style={{ color: ACCENT }}>
      {children}
    </h2>
  );
}

// ─── Preuves en une ligne, sous le titre ────────────────────────────────────

export function ProofChips() {
  const { t, lang } = useI18n();
  const r = accuracyRecord;
  const favs = r.bins[r.bins.length - 1];
  const chips = [
    { v: fmtPct(r.winnerPct, lang),   l: t("pro.proof.winners", { games: fmtInt(r.games, lang) }) },
    { v: fmtPct(favs.wonPct, lang),   l: t("pro.proof.favs") },
    { v: "=",                         l: t("pro.proof.closing") },
  ];
  return (
    <div className="grid grid-cols-3 gap-2 w-full mt-5">
      {chips.map((c, i) => (
        <div key={i} className="rounded-xl px-2 py-2.5 text-center"
          style={{ background: SURFACE, border: `1px solid ${BORDER}` }}>
          <div className="text-base font-bold" style={{ color: ACCENT }}>{c.v}</div>
          <div className="text-[10.5px] leading-tight mt-0.5" style={{ color: MUTED }}>{c.l}</div>
        </div>
      ))}
      <a href={ACCURACY_PAGE} className="col-span-3 text-[11px] font-semibold mt-1" style={{ color: ACCENT }}>
        {t("pro.trust.more")}
      </a>
    </div>
  );
}

// ─── Bilan des 7 derniers jours ────────────────────────────────────────────
//
// `GET /api/track-record` (trackRecord.service.ts) : le top 10 de chaque jour,
// réglé sur les résultats officiels. Taux de réussite seulement, pas d'argent.
// Public : visible aussi d'un visiteur déconnecté. Affiché tel quel, bon ou
// mauvais ; masqué seulement sous l'échantillon minimal (`enough`) ou en échec.

interface TrackRecord {
  from: string; to: string; topN: number;
  wins: number; losses: number; voids: number; pending: number;
  avgSaidPct: number | null; hitPct: number | null; enough: boolean;
}

export function TrackRecordCard() {
  const { t, lang } = useI18n();
  const [rec, setRec] = useState<TrackRecord | null>(null);

  useEffect(() => {
    let cancelled = false;
    authedFetch("/track-record")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: TrackRecord | null) => { if (!cancelled && d) setRec(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (!rec || !rec.enough || rec.hitPct == null) return null;
  const settled = rec.wins + rec.losses;
  const day = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(
    lang === "fr" ? "fr-CA" : "en-US", { day: "numeric", month: "short", timeZone: "UTC" });

  return (
    <section className="mb-8">
      <SectionTitle>{t("pro.track.title")}</SectionTitle>
      <div className="rounded-2xl p-4" style={{ background: SURFACE, border: `1px solid ${ACCENT_BORDER}` }}>
        <div className="flex items-end gap-3">
          <span className="text-4xl font-bold leading-none" style={{ color: ACCENT }}>{fmtPct(rec.hitPct, lang)}</span>
          <span className="text-xs pb-1" style={{ color: SUBTLE }}>
            {t("pro.track.hits", { wins: rec.wins, total: settled, n: rec.topN })}
          </span>
        </div>
        {/* La barre : gagnés vs perdus, à l'échelle. */}
        <div className="flex h-2 rounded-full overflow-hidden mt-3" role="img"
          aria-label={t("pro.track.aria", { wins: rec.wins, losses: rec.losses })}>
          <div style={{ width: `${(rec.wins / settled) * 100}%`, background: ACCENT }} />
          <div style={{ flex: 1, background: "rgba(255,255,255,0.1)" }} />
        </div>
        {/* Pas de « probabilité annoncée en moyenne » (décision du
            2026-11-21) : sur ~80 paris, l'écart avec le taux est du bruit
            (±5 pts) et ne prouve rien dans un sens ni dans l'autre. La
            calibration sur 4 304 matchs reste dans les preuves du haut. */}
        <p className="text-[11px] mt-2" style={{ color: MUTED }}>
          {t("pro.track.note", { from: day(rec.from), to: day(rec.to), n: rec.topN })}
        </p>
      </div>
    </section>
  );
}

// ─── Ce soir, derrière le cadenas ───────────────────────────────────────────
//
// Les meilleurs paris du jour existent déjà pour un compte gratuit
// (`/predict/best-bets` exige un compte, pas Pro ; l'accueil les verrouille
// côté client). On en montre le MARCHÉ, le MATCH et la PROBABILITÉ, jamais le
// choix : c'est la « boucle ouverte » qui donne envie, sans rien donner.
// Échec ou aucun pari → le bloc disparaît (rien de pire qu'un teaser vide).

// Depuis le 2026-11-20 le contenu exige un compte : les deux blocs lisent la
// vitrine PUBLIQUE `GET /api/pro-teaser` (proTeaser.service.ts), une seule
// requête partagée. Le serveur y a déjà retiré le choix, le côté du pari
// (`context` → match neutre « VIS @ DOM ») et l'identité des joueurs.

interface TeaserBet {
  id: string; marketType: string; marketLabel: string;
  matchup: string | null; startTimeUTC: string | null; pct: number;
}
interface ProTeaserData {
  tonight: { count: number; bets: TeaserBet[]; parlays: { total: number; free: number } | null } | null;
  leaders: { rank: number; name: string; hitRate: number; totalBets: number }[];
}

let teaserPromise: Promise<ProTeaserData | null> | null = null;
/** Une requête pour les deux blocs ; un échec n'est pas gardé (prochaine visite = nouvel essai). */
function loadProTeaser(): Promise<ProTeaserData | null> {
  if (!teaserPromise) {
    teaserPromise = authedFetch("/pro-teaser")
      .then((r) => (r.ok ? (r.json() as Promise<ProTeaserData>) : null))
      .catch(() => null)
      .then((d) => { if (!d) teaserPromise = null; else setTimeout(() => { teaserPromise = null; }, 60_000); return d; });
  }
  return teaserPromise;
}

export function TonightTeaser() {
  const { t, lang } = useI18n();
  const [data, setData] = useState<ProTeaserData["tonight"]>(null);

  useEffect(() => {
    let cancelled = false;
    loadProTeaser().then((d) => {
      if (cancelled || !d?.tonight) return;
      const now = Date.now();
      // Le serveur filtre déjà ; on refiltre au cas où la réponse est en cache depuis 60 s.
      const bets = d.tonight.bets.filter((b) => {
        const start = b.startTimeUTC ? Date.parse(b.startTimeUTC) : NaN;
        return !Number.isFinite(start) || start > now;
      });
      setData({ ...d.tonight, bets });
      if (bets.length > 0) trackEvent("pro_teaser_view");
    });
    return () => { cancelled = true; };
  }, []);

  const top = data?.bets ?? [];
  if (!data || top.length === 0) return null;

  const hiddenParlays = data.parlays ? Math.max(0, data.parlays.total - data.parlays.free) : 0;

  return (
    <section className="mb-8">
      <SectionTitle>{t("pro.tonight.title")}</SectionTitle>
      <div className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
        <div className="px-4 py-3 text-sm font-semibold" style={{ background: SURFACE, color: TEXT }}>
          {t("pro.tonight.bets", { n: data.count })}
        </div>
        {top.map((b) => {
          const p = b.pct;
          const time = b.startTimeUTC
            ? new Date(b.startTimeUTC).toLocaleTimeString(lang === "fr" ? "fr-CA" : "en-US", { hour: "numeric", minute: "2-digit" })
            : null;
          return (
            <div key={b.id} className="flex items-center gap-3 px-4 py-3" style={{ borderTop: `1px solid ${BORDER}` }}>
              <Lock size={14} className="shrink-0" style={{ color: "#f2c744" }} />
              <div className="flex-1 min-w-0">
                <div className="text-[11px] truncate" style={{ color: MUTED }}>
                  {marketName(b as Pick<ApiBestBet, "marketType" | "marketLabel">, t)}{b.matchup ? ` · ${b.matchup}` : ""}{time ? ` · ${time}` : ""}
                </div>
                {/* Choix masqué : un bloc flou de longueur fixe, pas le vrai
                    texte flouté (lisible avec un zoom ou dans le DOM). */}
                <div aria-label={t("pro.tonight.hidden")} className="mt-1 h-3.5 w-32 rounded"
                  style={{ background: "rgba(243,247,240,0.18)", filter: "blur(3px)" }} />
              </div>
              <div className="text-right">
                <div className="text-base font-bold" style={{ color: ACCENT }}>{fmtPct(Math.round(p), lang)}</div>
                <div className="text-[10px]" style={{ color: MUTED }}>{t("pro.tonight.chance")}</div>
              </div>
            </div>
          );
        })}
        {hiddenParlays > 0 && (
          <div className="px-4 py-3 text-xs" style={{ borderTop: `1px solid ${BORDER}`, color: SUBTLE }}>
            {t("pro.tonight.parlays", { total: data.parlays!.total, free: data.parlays!.free })}
          </div>
        )}
      </div>
    </section>
  );
}

// ─── Les meilleurs du classement ───────────────────────────────────────────
//
// Le classement est visible avec un compte gratuit ; les COUPONS et les stats
// détaillées d'un autre joueur sont réservés aux Pro (`requireProForOthers`,
// profile.routes.ts). On montre donc les 3 premiers — vrais noms, vrai taux de
// réussite — et le cadenas sur ce qu'ils ont parié. Échec ou classement vide
// (personne n'a encore de pari réglé) → le bloc disparaît.

export function LeaderTeaser() {
  const { t } = useI18n();
  const [top, setTop] = useState<ProTeaserData["leaders"] | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Déjà filtré (paris réglés > 0), trié et limité à 3 côté serveur.
    loadProTeaser().then((d) => { if (!cancelled) setTop(d?.leaders ?? []); });
    return () => { cancelled = true; };
  }, []);

  if (!top || top.length === 0) return null;
  const medal = ["#f2c744", "#c9d1d6", "#d08a52"];

  return (
    <section className="mb-8">
      <SectionTitle>{t("pro.leaders.title")}</SectionTitle>
      <div className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
        {top.map((e, i) => (
          <div key={e.rank} className="flex items-center gap-3 px-4 py-3" style={{ borderTop: i ? `1px solid ${BORDER}` : undefined }}>
            <Trophy size={15} className="shrink-0" style={{ color: medal[i] ?? MUTED }} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold truncate" style={{ color: TEXT }}>
                {e.name}
              </div>
              <div className="text-[11px]" style={{ color: MUTED }}>
                {t("pro.leaders.stats", { rate: e.hitRate, n: e.totalBets })}
              </div>
            </div>
            <span className="flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-full"
              style={{ background: "rgba(242,199,68,0.1)", color: "#f2c744" }}>
              <Lock size={11} /> {t("pro.leaders.locked")}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Gratuit vs Pro ─────────────────────────────────────────────────────────

type Cell = true | false | string;

export function CompareTable({ llmMonthlyQuota }: { llmMonthlyQuota?: number }) {
  const { t } = useI18n();
  // 2026-11-21 : 6 lignes (page raccourcie) — les prédictions gratuites, le
  // meilleur pari par match et les alertes (fusionnées avec +EV) sortent.
  const rows: { label: string; free: Cell; pro: Cell }[] = [
    { label: t("pro.cmp.bestbets"), free: false,                                   pro: t("pro.cmp.bestbetsPro") },
    { label: t("pro.cmp.evAlerts"), free: false,                                   pro: true },
    { label: t("pro.cmp.parlays"),  free: t("pro.cmp.parlaysFree"),                pro: t("pro.cmp.parlaysPro") },
    { label: t("pro.cmp.others"),   free: false,                                   pro: true },
    { label: t("pro.cmp.ai"),       free: t("pro.cmp.aiFree"),
      pro: llmMonthlyQuota ? t("pro.cmp.aiPro", { n: llmMonthlyQuota }) : t("pro.cmp.aiProNoCount") },
    // Scan masqué tant que VITE_SLIP_SCAN n'est pas « true » (features.slipScan).
    ...(features.slipScan ? [{ label: t("pro.cmp.scan"), free: t("pro.cmp.scanFree", { n: FREE_SCANS_PER_DAY }), pro: t("pro.cmp.unlimited") }] : []),
  ];

  const cell = (c: Cell, pro: boolean) =>
    c === true  ? <Check size={15} strokeWidth={3} className="mx-auto" style={{ color: pro ? ACCENT : SUBTLE }} aria-label={t("pro.cmp.yes")} /> :
    c === false ? <Minus size={15} className="mx-auto" style={{ color: "#4d5a49" }} aria-label={t("pro.cmp.no")} /> :
    <span className="text-[11px] font-semibold leading-tight" style={{ color: pro ? ACCENT : SUBTLE }}>{c}</span>;

  return (
    <section className="mb-8">
      <SectionTitle>{t("pro.cmp.title")}</SectionTitle>
      <div className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
        <div className="grid grid-cols-[1fr_72px_88px] px-4 py-2.5 text-[11px] uppercase tracking-wider font-bold"
          style={{ background: SURFACE }}>
          <span />
          <span className="text-center" style={{ color: MUTED }}>{t("pro.cmp.free")}</span>
          <span className="text-center" style={{ color: ACCENT }}>Pro</span>
        </div>
        {rows.map((r, i) => (
          <div key={i} className="grid grid-cols-[1fr_72px_88px] items-center px-4 py-2.5 gap-1"
            style={{ borderTop: `1px solid ${BORDER}` }}>
            <span className="text-xs" style={{ color: TEXT }}>{r.label}</span>
            <span className="text-center">{cell(r.free, false)}</span>
            <span className="text-center rounded-md py-0.5" style={{ background: "rgba(134,209,234,0.06)" }}>
              {cell(r.pro, true)}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── Inversion du risque, juste sous chaque bouton ──────────────────────────

export function RiskReversal({ trial }: { trial: boolean }) {
  const { t } = useI18n();
  const items = trial
    ? [t("pro.rr.noCardShort"), t("pro.rr.noChargeShort"), t("pro.rr.keepFreeShort")]
    : [t("pro.rr.cancelShort"), t("pro.rr.secureShort")];
  return (
    <p className="flex items-center justify-center gap-1.5 mt-2 text-[11px]" style={{ color: SUBTLE }}>
      <ShieldCheck size={12} className="shrink-0" style={{ color: ACCENT }} />
      {items.join(" · ")}
    </p>
  );
}

// ─── FAQ : les objections, une par une ─────────────────────────────────────

export function Faq() {
  const { t } = useI18n();
  const [open, setOpen] = useState<number | null>(null);
  const items = [
    { q: t("pro.faq.win.q"),    a: t("pro.faq.win.a") },
    { q: t("pro.faq.trial.q"),  a: t("pro.faq.trial.a") },
    { q: t("pro.faq.cancel.q"), a: t("pro.faq.cancel.a") },
  ];
  return (
    <section className="mb-8">
      <SectionTitle>{t("pro.faq.title")}</SectionTitle>
      <div className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${BORDER}` }}>
        {items.map((it, i) => {
          const isOpen = open === i;
          return (
            <div key={i} style={{ borderTop: i ? `1px solid ${BORDER}` : undefined }}>
              <button type="button" aria-expanded={isOpen}
                onClick={() => {
                  setOpen(isOpen ? null : i);
                  if (!isOpen) trackEvent("pro_faq_open");
                }}
                className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left tap-44"
                style={{ background: SURFACE }}>
                <span className="text-sm font-semibold" style={{ color: TEXT }}>{it.q}</span>
                <ChevronDown size={16} className="shrink-0 transition-transform"
                  style={{ color: MUTED, transform: isOpen ? "rotate(180deg)" : undefined }} />
              </button>
              {isOpen && (
                <p className="px-4 pb-3 pt-1 text-xs leading-relaxed" style={{ background: SURFACE, color: SUBTLE }}>{it.a}</p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── Barre d'achat collante ────────────────────────────────────────────────
//
// Visible seulement quand AUCUN des boutons principaux n'est à l'écran : elle
// ne double jamais un bouton déjà visible, et disparaît sur la carte de prix.

export function useAnyVisible(refs: React.RefObject<HTMLElement | null>[]): boolean {
  const [visible, setVisible] = useState(true);
  const seen = useRef(new Map<Element, boolean>());
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const els = refs.map((r) => r.current).filter(Boolean) as HTMLElement[];
    if (els.length === 0) return;
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) seen.current.set(e.target, e.isIntersecting);
      setVisible([...seen.current.values()].some(Boolean));
    });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, refs.map((r) => r.current));
  return visible;
}

export function StickyCta({ show, label, sub, onClick, disabled }: {
  show: boolean; label: string; sub?: string; onClick: () => void; disabled?: boolean;
}) {
  return (
    <div aria-hidden={!show}
      className="fixed left-1/2 -translate-x-1/2 w-[94%] max-w-[420px] z-50 transition-all duration-200"
      style={{
        bottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))",
        opacity: show ? 1 : 0,
        transform: `translate(-50%, ${show ? "0" : "12px"})`,
        pointerEvents: show ? "auto" : "none",
      }}>
      <button type="button" onClick={onClick} disabled={disabled} tabIndex={show ? 0 : -1}
        className="w-full rounded-2xl px-4 py-3 flex items-center justify-between gap-3 active:opacity-80"
        style={{ background: ACCENT, color: "#0A0E0C", boxShadow: "0 8px 24px rgba(0,0,0,0.45)" }}>
        <span className="text-sm font-bold">{label}</span>
        {sub && <span className="text-[11px] font-semibold opacity-80">{sub}</span>}
      </button>
    </div>
  );
}

export { TEXT, SUBTLE };
