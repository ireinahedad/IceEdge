/**
 * ScanSlipSheet.tsx — « Scanner un ticket » (SCAN_TICKET_PLAN § 4, étape S3).
 *
 *   1. Importer une capture d'écran (sélecteur de photos, ou coller une image sur le web).
 *   2. Lecture LOCALE : OCR sur l'appareil (`recognize`) puis `scanSlip` (parseur partagé
 *      avec le serveur, testé sur les fixtures). L'image ne quitte jamais l'appareil.
 *   3. Vérifier : une carte par jambe avec son état (§ 3.6). Une ambiguïté se résout par
 *      des choix cliquables ; une ligne ou un marché non couvert est montré tel quel.
 *   4. « Ajouter au coupon » : le scan est décompté À CE MOMENT (D2 : 3 par jour gratuits,
 *      illimité en Pro — jamais à l'import), puis chaque jambe suit le chemin de la feuille
 *      « + Ajouter » (`addIntents` → `buildLeg`) : probabilité du modèle, corrélation du
 *      coupon, règlement et XP comme d'habitude. Aucune jambe ajoutée → scan rendu.
 *
 * Repli LLM (D3) : seulement pour les jambes `unreadable`, sur demande (bouton), et
 * seulement si le Bet builder IA est allumé (`features.aiBetBuilder`) — c'est sa tâche
 * `parse_bet_command` et ses quotas. N'est envoyé que le TEXTE nettoyé de ces jambes
 * (sans mise, gains ni solde : jetés par `cleanLines`), jamais l'image.
 *
 * S4 (2026-10-27) : « Analyser ce ticket » décompte le scan, chiffre chaque jambe par
 * `buildLeg` (même chemin que « + Ajouter »), chaque groupe par `/predict/parlay`
 * (corrélation du même match), puis compare au prix payé (`slipScanValue.ts`) :
 * probabilité implicite, cote juste, « taxe », maillon faible, et le ticket entier.
 * « Ajouter au coupon » reprend ensuite ces jambes déjà chiffrées.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Camera, X, Check } from "lucide-react";
import { scanSlip, type ScanGroup, type ScanLeg, type ScanLegState, type ScanCandidate, type SlipScanResult } from "../../../../server/src/services/slipScan";
import { priceVerdict, ticketModelPct, ticketPaidDecimal, weakestLeg, type PriceVerdict } from "../../../../server/src/services/slipScanValue";
import { combineParlayLegs } from "../../../../server/src/services/parlay";
import { buildLeg } from "../services/buildLeg";
import { predictionApiService } from "../services/predictionApiService";
import type { BetLeg } from "../types/bet";
import { validateIntent, type SlipIntent } from "../../../../server/src/services/slipCommand";
import { recognize, OcrError } from "../services/ocr/ocrService";
import { useBet } from "../context/BetContext";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n";
import { useSlipCommandData } from "../hooks/useSlipCommandData";
import { describeInput, intentToLegInput } from "../services/slipCommandLegs";
import { askParseCommand, type LLMError } from "../services/llmService";
import { getScanUsage, startScan, refundScan, ScanQuotaError, type ScanUsage } from "../services/scanService";
import { features } from "../platform";

type T = ReturnType<typeof useI18n>["t"];

/** Une jambe à l'écran : celle du scan, éventuellement résolue par un choix ou par l'IA. */
interface LegView {
  key: string;
  group: number;
  leg: ScanLeg;
  state: ScanLegState;
  intent?: SlipIntent;
  /** Lue par le repli LLM : « vérifie-la » (§ 3.7). */
  ai?: boolean;
}

type Phase = "pick" | "reading" | "review" | "analysed";

/** Résultat de « Analyser ce ticket » (S4). */
interface Analysis {
  /** Jambe chiffrée par `buildLeg`, par clé de vue. */
  built: Map<string, BetLeg>;
  /** Jambes qui n'ont pas pu être chiffrées, avec leur libellé. */
  failed: Map<string, "unavailable" | "missing">;
  /** Par groupe (index) : probabilité du modèle (null = partiel) et verdict face à sa cote. */
  groups: { pct: number | null; verdict: PriceVerdict | null }[];
  ticket: PriceVerdict | null;
  weakest: string | null;
}

/** Probabilité d'un groupe : la jambe seule, sinon la probabilité raffinée du serveur (corrélation), sinon le calcul local. */
async function groupProbability(legs: BetLeg[]): Promise<number | null> {
  if (!legs.length) return null;
  if (legs.length === 1) return legs[0].probability;
  try {
    const r = await predictionApiService.getParlayPrediction({
      legs: legs.map((l) => ({
        marketType: l.marketType, probability: l.probability, gameId: l.gameId, selection: l.selectionValue,
        line: l.line, teamId: l.subjectId, opponentId: l.opponentId, isHome: l.isHome, subjectType: l.subjectType,
      })),
    });
    if (typeof r.adjustedProbability === "number") return r.adjustedProbability;
  } catch { /* hors ligne : calcul local */ }
  const local = combineParlayLegs(legs.map((l) => ({
    marketType: l.marketType, probability: l.probability, gameId: l.gameId, selection: l.selectionValue,
    line: l.line, subject: l.subjectId, subjectType: l.subjectType,
  })));
  return Number.isFinite(local.probability) ? Math.round(local.probability * 10) / 10 : null;
}

type Note =
  | { kind: "ocr"; code: "not_image" | "too_large" | "failed" }
  | { kind: "empty" }
  | { kind: "quota"; limit: number }
  | { kind: "unavailable" }
  | { kind: "ai_working" }
  | { kind: "ai_unclear" }
  | { kind: "ai_quota"; limit: number }
  | { kind: "ai_error" };

type Row =
  | { key: string; kind: "added"; legId: string; label: string; removed: boolean }
  | { key: string; kind: "duplicate" | "unavailable" | "missing"; label: string };

const STATE_STYLE: Record<ScanLegState, string> = {
  ok: "text-[#4ade80] border-[#4ade80]/30 bg-[#4ade80]/10",
  ambiguous: "text-amber-300 border-amber-300/30 bg-amber-300/10",
  unsupported_market: "text-[#bfc8cc] border-white/20 bg-white/5",
  unsupported_line: "text-[#bfc8cc] border-white/20 bg-white/5",
  no_game: "text-[#bfc8cc] border-white/20 bg-white/5",
  unreadable: "text-amber-300 border-amber-300/30 bg-amber-300/10",
};

function noteText(n: Note, t: T): string {
  switch (n.kind) {
    case "ocr":         return t(n.code === "not_image" ? "scan.errNotImage" : n.code === "too_large" ? "scan.errTooLarge" : "scan.errFailed");
    case "empty":       return t("scan.empty");
    case "quota":       return t("scan.quota", { limit: n.limit });
    case "unavailable": return t("scan.unavailable");
    case "ai_working":  return t("scan.aiWorking");
    case "ai_unclear":  return t("cmd.aiUnclear");
    case "ai_quota":    return t("cmd.aiFreeQuota", { limit: n.limit });
    case "ai_error":    return t("cmd.aiError");
  }
}

export function ScanSlipSheet({ onClose }: { onClose: () => void }) {
  const { t, lang } = useI18n();
  const { addLeg, removeLeg, hasLeg } = useBet();
  const { user } = useAuth();
  const { ctx, data, loading, error } = useSlipCommandData();
  const navigate = useNavigate();
  const location = useLocation();
  const fileRef = useRef<HTMLInputElement>(null);

  const [phase, setPhase] = useState<Phase>("pick");
  const [groups, setGroups] = useState<ScanGroup[]>([]);
  const [scan, setScan] = useState<SlipScanResult | null>(null);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [views, setViews] = useState<LegView[]>([]);
  const [note, setNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [usage, setUsage] = useState<ScanUsage | null>(null);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    getScanUsage().then((u) => { if (alive) setUsage(u); }).catch(() => { /* ligne absente */ });
    return () => { alive = false; };
  }, [user]);

  const read = useCallback(async (file: Blob) => {
    if (!ctx) return;
    setNote(null);
    setRows([]);
    setPhase("reading");
    try {
      const ocr = await recognize(file);
      const r = scanSlip(ocr, ctx);
      const vs: LegView[] = r.groups.flatMap((g, gi) => g.legs.map((leg, li) => ({
        key: `${gi}-${li}`, group: gi, leg, state: leg.state, intent: leg.state === "ok" ? leg.intent : undefined,
      })));
      setGroups(r.groups);
      setScan(r);
      setAnalysis(null);
      setViews(vs);
      if (!vs.length) setNote({ kind: "empty" });
      setPhase(vs.length ? "review" : "pick");
    } catch (e) {
      setNote({ kind: "ocr", code: e instanceof OcrError ? e.code : "failed" });
      setPhase("pick");
    }
  }, [ctx]);

  // Web : coller une capture (Cmd/Ctrl+V) pendant l'étape d'import.
  useEffect(() => {
    if (phase !== "pick" || !ctx || !user) return;
    const onPaste = (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
      const file = item?.getAsFile();
      if (file) { e.preventDefault(); void read(file); }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [phase, ctx, user, read]);

  const labelOf = (v: LegView): string => {
    const input = v.intent ? intentToLegInput(v.intent, data) : null;
    return input ? describeInput(input) : v.leg.text[0] ?? "";
  };

  /** Une ambiguïté levée par un choix : même intention, sujet choisi, revalidée. */
  function choose(v: LegView, c: ScanCandidate) {
    const p = v.leg.parsed;
    const gameId = groups[v.group]?.gameId;
    if (!ctx || !p || !p.marketType || !gameId) return;
    const subjectId = p.subjectType === "team" ? c.teamAbbr.toLowerCase() : c.id;
    const draft: SlipIntent = {
      subjectType: p.subjectType, subjectId, marketType: p.marketType, gameId,
      selection: p.selection === "team" ? subjectId : p.selection,
    };
    if (p.line !== undefined && p.marketType !== "puck_line") draft.line = p.line;
    const r = validateIntent(draft, ctx);
    setViews((vs) => vs.map((x) => (x.key !== v.key ? x
      : r.ok ? { ...x, state: "ok", intent: r.intent }
      : { ...x, state: r.code === "line" ? "unsupported_line" : x.state })));
  }

  /** Repli LLM (D3) : le texte des jambes illisibles, en UN appel. */
  async function askAi() {
    if (!ctx) return;
    const unreadable = views.filter((v) => v.state === "unreadable");
    const text = unreadable.map((v) => v.leg.text.join(" ")).join(", ").slice(0, 200);
    if (!text) return;
    setBusy(true);
    setNote({ kind: "ai_working" });
    try {
      const r = await askParseCommand(text, lang);
      const ok = r.ok ? r.intents.filter((i) => validateIntent(i, ctx).ok) : [];
      if (!ok.length) { setNote({ kind: "ai_unclear" }); return; }
      setNote(null);
      setViews((vs) => [
        ...vs.filter((v) => v.state !== "unreadable"),
        ...ok.map((intent, i): LegView => ({
          key: `ai-${Date.now()}-${i}`, group: unreadable[0].group, leg: { text: [], state: "ok" }, state: "ok", intent, ai: true,
        })),
      ]);
    } catch (e) {
      const err = e as Partial<LLMError>;
      setNote(err.type === "free_parse_quota" ? { kind: "ai_quota", limit: err.limit ?? 0 } : { kind: "ai_error" });
    } finally {
      setBusy(false);
    }
  }

  /** S4 : décompte le scan, chiffre les jambes et les groupes, compare au prix payé. */
  async function analyse() {
    const ready = views.filter((v) => v.state === "ok" && v.intent);
    if (!ready.length || busy || !scan) return;
    setBusy(true);
    setNote(null);
    try {
      try {
        await startScan();
      } catch (e) {
        setNote(e instanceof ScanQuotaError ? { kind: "quota", limit: e.limit } : { kind: "unavailable" });
        return;
      }
      const built = new Map<string, BetLeg>();
      const failed = new Map<string, "unavailable" | "missing">();
      for (const v of ready) {
        const input = intentToLegInput(v.intent!, data);
        if (!input) { failed.set(v.key, "missing"); continue; }
        const r = await buildLeg(input, { players: data.players, getTeamById: data.getTeamById, hasLeg: () => false });
        if (r.ok) built.set(v.key, r.leg); else failed.set(v.key, "unavailable");
      }
      if (!built.size) { void refundScan(); setNote({ kind: "unavailable" }); return; }

      const gs = await Promise.all(groups.map(async (g, gi) => {
        const gv = views.filter((v) => v.group === gi);
        const legs = gv.map((v) => built.get(v.key)).filter((l): l is BetLeg => !!l);
        // Partiel : une jambe du groupe n'est pas chiffrée → aucun chiffre présenté comme complet.
        const pct = gv.length && legs.length === gv.length ? await groupProbability(legs) : null;
        return { pct, verdict: pct != null && g.odds ? priceVerdict(pct, g.odds) : null };
      }));
      const tPct = ticketModelPct(gs.map((g, gi) => ({ pct: g.pct, gameId: groups[gi].gameId })));
      const tPaid = ticketPaidDecimal(scan.totalOdds, groups.map((g) => g.odds));
      const ticket = groups.length > 1 && tPct != null && tPaid ? priceVerdict(tPct, tPaid, scan.oddsFormat) : null;
      const weakest = weakestLeg([...built.entries()].map(([key, l]) => ({ key, pct: l.probability })));
      setAnalysis({ built, failed, groups: gs, ticket, weakest });
      setPhase("analysed");
      getScanUsage().then(setUsage).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  /** Les jambes déjà chiffrées entrent au coupon (règlement, XP comme d'habitude). */
  function addToSlip() {
    if (!analysis) return;
    const stamp = Date.now();
    const out: Row[] = [];
    views.forEach((v, i) => {
      const leg = analysis.built.get(v.key);
      if (leg) {
        if (hasLeg(leg.id)) out.push({ key: `${stamp}-${i}`, kind: "duplicate", label: `${leg.selection}` });
        else { addLeg(leg); out.push({ key: `${stamp}-${i}`, kind: "added", legId: leg.id, label: `${leg.selection} · ${leg.gameInfo ?? ""}`, removed: false }); }
      } else if (analysis.failed.has(v.key)) {
        out.push({ key: `${stamp}-${i}`, kind: analysis.failed.get(v.key)!, label: labelOf(v) });
      }
    });
    setRows(out);
  }

  function reset() {
    setPhase("pick"); setGroups([]); setViews([]); setRows([]); setNote(null); setScan(null); setAnalysis(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  const okCount = views.filter((v) => v.state === "ok").length;
  const unreadableCount = views.filter((v) => v.state === "unreadable").length;
  const added = rows.length > 0;

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative bg-[#0A0E0C] rounded-3xl border border-white/20 max-h-[85vh] flex flex-col max-w-[430px] w-full mx-auto"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t("scan.title")}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/20 rounded-t-3xl">
          <p className="text-white font-bold">{t("scan.title")}</p>
          <button onClick={onClose} aria-label={t("cmd.close")}
            className="tap-44 w-8 h-8 rounded-full bg-[#1B2419] flex items-center justify-center text-[#bfc8cc]"><X size={14} /></button>
        </div>

        <div className="flex flex-col gap-3 px-4 py-4 overflow-y-auto">
          {!user ? (
            <div className="flex flex-col gap-2">
              <p className="text-[#bfc8cc] text-sm">{t("scan.loginNeeded")}</p>
              <button onClick={() => navigate(`/login?returnTo=${encodeURIComponent(location.pathname)}`)}
                className="tap-44 self-start px-4 py-2 rounded-2xl text-sm font-bold bg-[#86d1ea] text-[#0A0E0C]">{t("scan.login")}</button>
            </div>
          ) : (
            <>
              {usage && !usage.pro && usage.remaining !== null && (
                <p className="text-[#bfc8cc] text-[11px]">{t("scan.freeLeft", { n: usage.remaining, limit: usage.limit ?? 0 })}</p>
              )}
              {loading && <p className="text-[#bfc8cc] text-xs">{t("cmd.loading")}</p>}
              {error && <p className="text-amber-300 text-xs">{t("cmd.loadError")}</p>}

              {phase === "pick" && (
                <div className="flex flex-col gap-2">
                  <p className="text-[#bfc8cc] text-xs leading-relaxed">{t("scan.hint")}</p>
                  <input ref={fileRef} type="file" accept="image/*" className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void read(f); }} />
                  <button onClick={() => fileRef.current?.click()} disabled={!ctx}
                    className="tap-44 flex items-center justify-center gap-2 w-full text-[#0A0E0C] text-sm font-bold bg-[#86d1ea] rounded-2xl px-4 py-3 disabled:bg-[#1B2419] disabled:text-[#bfc8cc]">
                    <Camera size={15} /> {t("scan.pick")}
                  </button>
                  <p className="text-[#8a9ea6] text-[11px]">{t("scan.privacy")}</p>
                </div>
              )}

              {phase === "reading" && <p className="text-[#86d1ea] text-sm" role="status">{t("scan.reading")}</p>}

              {note && (
                <div className="bg-[#131A12] border border-amber-300/30 rounded-2xl px-3 py-2.5" role="status">
                  <p className={`text-xs font-semibold ${note.kind === "ai_working" ? "text-[#86d1ea]" : "text-amber-300"}`}>{noteText(note, t)}</p>
                  {(note.kind === "quota" || note.kind === "ai_quota") && features.proUpgrade && (
                    <button onClick={() => navigate("/pro", { state: { from: location.pathname + location.search } })}
                      className="tap-44 mt-2 px-3 py-1.5 rounded-full text-xs font-bold bg-[#86d1ea] text-[#0A0E0C]">{t("home.proHeadline")}</button>
                  )}
                </div>
              )}

              {(phase === "review" || phase === "analysed") && (
                <>
                  {groups.map((g, gi) => {
                    const gv = views.filter((v) => v.group === gi);
                    if (!gv.length) return null;
                    return (
                      <div key={gi} className="bg-[#131A12] border border-white/20 rounded-2xl px-3 py-2.5 flex flex-col gap-2">
                        <div className="flex items-center justify-between text-[11px] text-[#bfc8cc]">
                          <span className="uppercase tracking-wider">
                            {g.kind === "sgp" ? t("scan.sgp") : t("scan.single")}
                            {g.game ? ` · ${g.game.away} @ ${g.game.home}` : ""}
                          </span>
                          {g.odds && <span className="text-white font-semibold">{g.odds}</span>}
                        </div>
                        {analysis && <VerdictLine v={analysis.groups[gi]?.verdict ?? null} pct={analysis.groups[gi]?.pct ?? null} t={t} />}
                        {gv.map((v) => (
                          <div key={v.key} className="flex flex-col gap-1">
                            <div className="flex items-start gap-2">
                              <span className="flex-1 min-w-0 text-xs text-white">{labelOf(v)}</span>
                              {analysis?.built.get(v.key) ? (
                                <span className="flex-shrink-0 flex items-center gap-1.5">
                                  {analysis.weakest === v.key && (
                                    <span className="text-[10px] font-semibold border rounded-full px-2 py-0.5 text-amber-300 border-amber-300/30 bg-amber-300/10">{t("scan.weakest")}</span>
                                  )}
                                  <span className="text-xs font-semibold text-[#86d1ea]">{analysis.built.get(v.key)!.probability}%</span>
                                </span>
                              ) : (
                                <span className={`flex-shrink-0 text-[10px] font-semibold border rounded-full px-2 py-0.5 ${STATE_STYLE[v.state]}`}>
                                  {v.ai ? t("scan.aiRead") : t(`scan.state.${v.state}`)}
                                </span>
                              )}
                            </div>
                            {!analysis && v.state === "ambiguous" && v.leg.candidates && v.leg.candidates.length > 0 && (
                              <div className="flex flex-wrap gap-1.5">
                                {v.leg.candidates.map((c) => (
                                  <button key={`${c.id}-${c.teamAbbr}`} onClick={() => choose(v, c)}
                                    className="tap-44 px-3 py-1 rounded-full text-[11px] bg-[#86d1ea]/10 border border-[#86d1ea]/30 text-[#86d1ea]">
                                    {c.name === c.teamAbbr ? c.name : `${c.name} · ${c.teamAbbr}`}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    );
                  })}

                  {okCount < views.length && (
                    <p className="text-[#bfc8cc] text-[11px]">{t("scan.partial", { ok: okCount, total: views.length })}</p>
                  )}

                  {analysis?.ticket && (
                    <div className="bg-[#131A12] border border-[#86d1ea]/30 rounded-2xl px-3 py-2.5 flex flex-col gap-1">
                      <p className="text-[11px] uppercase tracking-wider text-[#bfc8cc]">{t("scan.ticket")}</p>
                      <VerdictLine v={analysis.ticket} pct={analysis.ticket.modelPct} t={t} />
                    </div>
                  )}

                  {unreadableCount > 0 && features.aiBetBuilder && !analysis && (
                    <button onClick={() => void askAi()} disabled={busy}
                      className="tap-44 self-start px-3 py-1.5 rounded-full text-xs font-semibold text-[#86d1ea] bg-[#86d1ea]/10 border border-[#86d1ea]/30">
                      {t("scan.askAi", { n: unreadableCount })}
                    </button>
                  )}

                  {phase === "review" && (
                    <button onClick={() => void analyse()} disabled={!okCount || busy}
                      className="tap-44 w-full text-[#0A0E0C] text-sm font-bold bg-[#86d1ea] rounded-2xl px-4 py-3 disabled:bg-[#1B2419] disabled:text-[#bfc8cc]">
                      {busy ? t("scan.analysing") : t("scan.analyse")}
                    </button>
                  )}
                  {phase === "analysed" && analysis && !added && (
                    <button onClick={addToSlip} disabled={!analysis.built.size}
                      className="tap-44 w-full text-[#0A0E0C] text-sm font-bold bg-[#86d1ea] rounded-2xl px-4 py-3 disabled:bg-[#1B2419] disabled:text-[#bfc8cc]">
                      {t("scan.add", { n: analysis.built.size })}
                    </button>
                  )}
                </>
              )}

              {rows.length > 0 && (
                <ul className="flex flex-col gap-1.5">
                  {rows.map((r) => (
                    <li key={r.key} className="flex items-center gap-2 bg-[#131A12] border border-white/20 rounded-xl px-3 py-2">
                      {r.kind === "added" ? (
                        <>
                          <span className={`flex-1 min-w-0 text-xs ${r.removed ? "text-[#bfc8cc] line-through" : "text-white"}`}>
                            {!r.removed && <Check size={11} strokeWidth={3} className="inline mr-1 -mt-0.5 text-[#4ade80]" />}{r.label}
                          </span>
                          {r.removed ? <span className="text-[#bfc8cc] text-[11px]">{t("cmd.undone")}</span> : (
                            <button onClick={() => { removeLeg(r.legId); setRows((rs) => rs.map((x) => (x.key === r.key ? { ...r, removed: true } : x))); }}
                              className="tap-44 text-[#86d1ea] text-xs font-semibold flex-shrink-0">{t("cmd.undo")}</button>
                          )}
                        </>
                      ) : (
                        <span className="flex-1 min-w-0 text-xs text-amber-300">
                          {t(r.kind === "duplicate" ? "cmd.duplicate" : r.kind === "unavailable" ? "cmd.unavailable" : "cmd.missing", { label: r.label })}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {(phase === "review" || phase === "analysed") && (
                <button onClick={reset} className="tap-44 self-start text-[#86d1ea] text-xs font-semibold">{t("scan.another")}</button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** « Modèle 40 % · payé 1.83 (54,6 %) · juste 2.50 — taxe 27 % » ; « partiel » si un chiffre manque. */
function VerdictLine({ v, pct, t }: { v: PriceVerdict | null; pct: number | null; t: T }) {
  if (pct == null) return <p className="text-[11px] text-[#bfc8cc]">{t("scan.partialGroup")}</p>;
  if (!v) return <p className="text-[11px] text-[#bfc8cc]">{t("scan.modelOnly", { pct })}</p>;
  const tone = v.verdict === "tax" ? "text-[#f87171]" : v.verdict === "value" ? "text-[#4ade80]" : "text-[#86d1ea]";
  const head = v.verdict === "tax" ? t("scan.tax", { pct: Math.round(v.taxPct) })
    : v.verdict === "value" ? t("scan.value", { pct: Math.round(-v.taxPct) }) : t("scan.fair");
  return (
    <div className="flex flex-col gap-0.5">
      <p className={`text-sm font-bold ${tone}`}>{head}</p>
      <p className="text-[11px] text-[#bfc8cc]">{t("scan.verdictDetail", { model: v.modelPct, implied: v.impliedPct, fair: v.fairOdds })}</p>
    </div>
  );
}

const LAUNCHER_CLS: Record<"pill" | "block", string> = {
  pill:  "tap-44 flex items-center gap-1 text-[#90C9F0] text-xs bg-[#90C9F0]/10 border border-[#90C9F0]/25 rounded-full px-3 py-1.5 active:scale-95 transition-transform",
  block: "tap-44 w-full flex items-center justify-center gap-2 text-[#86d1ea] text-sm font-bold bg-[#86d1ea]/10 border border-[#86d1ea]/30 rounded-2xl px-4 py-3 active:scale-95 transition-transform",
};

/** Le bouton « Scanner un ticket » et sa feuille. Absent tant que `features.slipScan` est éteint. */
export function ScanSlipLauncher({ variant }: { variant: "pill" | "block" }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (!features.slipScan) return null;
  return (
    <>
      <button onClick={() => setOpen(true)} className={LAUNCHER_CLS[variant]}>
        <Camera size={variant === "pill" ? 11 : 14} /> {t("scan.open")}
      </button>
      {open && <ScanSlipSheet onClose={() => setOpen(false)} />}
    </>
  );
}
