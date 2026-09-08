/**
 * PredictionSheet.tsx
 *
 * Extrait de PredictionPage.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { useNavigate } from "react-router";
import { Fragment, useEffect, useState, useContext } from "react";
import { nhlApiService } from "../../services/nhlApiService";
import { predictionApiService } from "../../services/predictionApiService";
import { requestFromMLProps } from "../../services/predictionRequest";
import { useI18n } from "../../i18n";
import { nhlLogoUrl } from "../../data/teamEmoji";
import { useBet } from "../../context/BetContext";
import type { BetLeg } from "../../types/bet";
import { askLLM } from "../../services/llmService";
import { MLSection, fetchMLProbability } from "../../components/MLPredictionCard";
import { RuleFactorEditor } from "../../components/RuleFactorEditor";
import { FramedLabel } from "../../components/brand/FramedLabel";
import { BetOpt, MLProps, MktGroup, RuleFactor, buildLLMDataContext, llmCacheId, loadLlmCache, saveLlmCache, settlementFields } from "./gameMarkets";
import { pctColor } from "../../data/pctScale";
import { RevealMode, RevealModeCtx } from "./predictionShared";

/* ─── Prediction bottom sheet ───────────────── */
function PredictionSheet({ label, rulePct, serverPct, ruleNote, accent, mlProps, factors, factorGroup, onClose }: {
  label: string; rulePct: number; serverPct?: number; ruleNote: string; accent: string;
  mlProps?: MLProps; factors?: RuleFactor[]; factorGroup?: string; onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const llmId = llmCacheId(label, mlProps, lang);
  const [llmText, setLlmText]     = useState(() => loadLlmCache(llmId)); // réponse en cache si déjà générée
  const [llmOpen, setLlmOpen]     = useState(false); // repliée par défaut pour ne pas cacher les autres cartes
  const [llmLoading, setLlmLoading] = useState(false);
  const [copied, setCopied]       = useState(false);
  const ruleColor = pctColor(rulePct);

  // Fall back to fetching the server prediction if the parent hasn't yet.
  const [ownServerPct, setOwnServerPct] = useState<number | undefined>(serverPct);
  useEffect(() => {
    if (serverPct !== undefined) { setOwnServerPct(serverPct); return; }
    if (!mlProps) return;
    let alive = true;
    predictionApiService
      .getSinglePrediction(requestFromMLProps(mlProps))
      .then(r => { if (alive) setOwnServerPct(r.probability); })
      .catch(() => { /* keep undefined → falls back to rulePct */ });
    return () => { alive = false; };
  }, [serverPct, mlProps]);

  // The probability stored in the coupon — identical to what the stats grid shows.
  const legPct = ownServerPct ?? rulePct;

  const { addLeg, removeLeg, hasLeg } = useBet();
  const legId = mlProps
    ? `${mlProps.subjectId}-${mlProps.propType ?? "bet"}-${label.replace(/\s+/g, "-").toLowerCase().slice(0, 24)}`
    : `rule-${label.replace(/\s+/g, "-").toLowerCase().slice(0, 24)}-${rulePct}`;
  const inSlip = hasLeg(legId);

  function handleSlip() {
    if (inSlip) { removeLeg(legId); return; }
    const { marketType, selectionValue } = settlementFields(mlProps);
    const leg: BetLeg = {
      id: legId,
      marketType: (marketType ?? mlProps?.propType ?? "moneyline") as BetLeg["marketType"],
      marketLabel: label,
      subjectType: mlProps?.type === "player" ? "player" : mlProps?.type === "team" ? "team" : "game",
      subjectId: mlProps?.subjectId ?? legId,
      subjectName: mlProps?.subjectId ?? label,
      subjectLogo: mlProps?.subjectId ? nhlLogoUrl(mlProps.subjectId) : "",
      selection: label,
      selectionShort: label.slice(0, 14),
      probability: legPct,
      line: mlProps?.line,
      addedAt: new Date().toISOString(),
      // Machine-readable fields for automatic settlement — only populated when
      // the market is unambiguous (see settlementFields); otherwise the bet
      // simply stays pending instead of risking a wrong auto-settlement.
      gameId: mlProps?.gameId,
      selectionValue,
    };
    addLeg(leg);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end"
      style={{ background: "rgba(0,0,0,0.75)" }}
      onClick={onClose}
    >
      <div
        className="bg-[#0A0E0C] rounded-t-3xl flex flex-col gap-3 max-h-[90vh] overflow-y-auto"
        style={{ padding: "20px 16px 44px" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Handle */}
        <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-1 flex-shrink-0" />

        {/* Title + Add to slip */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <p className="text-white font-bold text-base leading-snug flex-1">{label}</p>
          <button
            onClick={handleSlip}
            className="flex-shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-bold transition-all active:scale-95"
            style={inSlip
              ? { background: "#4ade8033", color: "#4ade80", border: "1px solid #4ade8055" }
              : { background: accent + "22", color: accent, border: `1px solid ${accent}55` }}
          >
            {inSlip ? t("pred.slipShort") : t("pred.slipAddShort")}
          </button>
        </div>

        {/* ── 🤖 ML — prédiction du modèle ── */}
        {mlProps ? (
          <MLSection
            type={mlProps.type}
            subjectId={mlProps.subjectId}
            opponentId={mlProps.opponentId}
            propType={mlProps.propType}
            line={mlProps.line}
            ruleBasedPct={rulePct}
            label={label}
            simple
          />
        ) : null}

        {/* ── 📐 Règles — éditeur de facteurs par pari, ou note simple ── */}
        {factors && factors.length > 0 && factorGroup ? (
          <RuleFactorEditor factors={factors} factorGroup={factorGroup} label={t("pred.rules")} />
        ) : (
          <div className="bg-[#0d1519] border border-white/[0.07] rounded-2xl overflow-hidden">
            <div className="flex items-center gap-2.5 px-4 py-3 border-b border-white/[0.05]">
              <FramedLabel text={t("pred.rules")} />
              <div className="flex-1" />
              <span className="text-xl font-black flex-shrink-0" style={{ color: ruleColor }}>{rulePct}%</span>
            </div>
            <div className="px-4 py-3">
              <div className="w-full bg-[#0A0E0C] rounded-full h-2 mb-2.5 overflow-hidden">
                <div className="h-2 rounded-full transition-all duration-700"
                  style={{ width: `${rulePct}%`, backgroundColor: ruleColor }} />
              </div>
              <p className="text-[#8a9ea6] text-[11px] leading-relaxed">{ruleNote}</p>
            </div>
          </div>
        )}

        {/* ── Ask LLM — section repliable, réponse mise en cache 24 h ── */}
        {llmText ? (
          <div className="bg-purple-500/10 border border-purple-500/30 rounded-2xl overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-3">
              <span className="text-sm">✨</span>
              <span className="text-purple-300 text-xs font-semibold flex-1">{t("pred.llmAnalysis")}</span>
              {llmOpen && (
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(llmText);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    } catch { /* clipboard unavailable */ }
                  }}
                  className="text-[11px] font-semibold px-2 py-1 rounded-md bg-purple-500/20 hover:bg-purple-500/30 text-purple-200 transition-colors"
                >
                  {copied ? (lang === "fr" ? "Copié ✓" : "Copied ✓") : (lang === "fr" ? "Copier" : "Copy")}
                </button>
              )}
              <button
                onClick={() => setLlmOpen((v) => !v)}
                className="text-[11px] text-purple-300 font-semibold px-2.5 py-1 rounded-lg border border-purple-400/30 hover:bg-purple-500/15"
              >
                {llmOpen ? "▲" : (lang === "fr" ? "Voir" : "View") + " ▼"}
              </button>
            </div>
            {llmOpen && (
              <p className="text-[#bfc8cc] text-xs leading-relaxed whitespace-pre-line px-4 pb-4">{llmText}</p>
            )}
          </div>
        ) : (
          <button
            disabled={llmLoading}
            onClick={async () => {
              setLlmLoading(true);
              setLlmText("");
              try {
                const subject = mlProps?.subjectId ?? label;
                const isFr = lang === "fr";

                // Pull the real stats the app has for this bet's subject.
                const dataContext = await buildLLMDataContext(mlProps, isFr);
                const dataBlock = dataContext ? `\n${dataContext}\n` : "";

                const userPrompt = isFr
                  ? `L'application a déjà calculé une probabilité statistique pour ce pari. ` +
                    `Donne le contexte que les chiffres ne captent pas.\n\n` +
                    `Pari : "${label}"\n` +
                    `Probabilité du modèle : ${rulePct}%\n` +
                    `Raisonnement du modèle : ${ruleNote}\n` +
                    (mlProps ? `Marché : ${mlProps.propType ?? "vainqueur"} · Sujet : ${subject}\n` : "") +
                    dataBlock +
                    `\nUtilise les « Données de l'application » ci-dessus comme des faits. ` +
                    `Énumère les facteurs clés hors statistiques et signale seulement ce que je dois vérifier avant de parier.`
                  : `The app already computed a stats-based probability for this bet. ` +
                    `Add the context the numbers DON'T capture.\n\n` +
                    `Bet: "${label}"\n` +
                    `Model probability: ${rulePct}%\n` +
                    `Model rationale: ${ruleNote}\n` +
                    (mlProps ? `Market: ${mlProps.propType ?? "moneyline"} · Subject: ${subject}\n` : "") +
                    dataBlock +
                    `\nTreat the "App data" above as facts. ` +
                    `List the key off-the-stat-sheet factors and flag only what I must verify before betting.`;

                // L'invite système vit côté SERVEUR depuis le 2026-09-08
                // (`server/src/services/llmPrompts.ts`). Elle arrivait d'ici,
                // dans le corps de la requête, et le serveur la relayait telle
                // quelle : sur le chemin Pro, facturé à l'opérateur, ça faisait
                // de `/api/llm` un proxy LLM généraliste pour tout abonné. Le
                // client ne dit plus QUE la tâche et la langue.
                const text = await askLLM(userPrompt, {
                  taskType: "explain_bet",
                  locale: isFr ? "fr" : "en",
                });
                setLlmText(text);
                setLlmOpen(true);            // ouvre la réponse fraîchement générée
                saveLlmCache(llmId, text);   // persistée 24 h — pas de 2e question identique
              } catch (err: any) {
                const type = (err as any).type;
                if (type === "no_api_key") {
                  setLlmText("⚙️ " + err.message);
                } else {
                  setLlmText("❌ " + (err.message ?? "LLM error"));
                }
                setLlmOpen(true); // les erreurs ne sont pas mises en cache
              } finally {
                setLlmLoading(false);
              }
            }}
            className="w-full py-3 rounded-2xl text-sm font-bold flex items-center justify-center gap-2 active:scale-[0.97] transition-transform"
            style={{ background: llmLoading ? "#1B2419" : "linear-gradient(135deg,#7c3aed,#a855f7)", color: "#fff", border: "1px solid rgba(168,85,247,0.3)" }}
          >
            {llmLoading
              ? <><span className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin inline-block" /> {t("nhl.analyzing")}</>
              : <>{t("nhl.askLLM")}</>}
          </button>
        )}

        <button
          onClick={onClose}
          className="w-full py-3 bg-[#131A12] border border-white/10 rounded-2xl text-[#8a9ea6] text-sm font-medium"
        >
          {t("common.close")}
        </button>
      </div>
    </div>
  );
}

/* ─── Reveal-all toggle bar ────────────────────── */
export function PredictionsRevealBar({ mode, onSelect }: { mode: RevealMode; onSelect: (m: RevealMode) => void }) {
  const { t } = useI18n();
  // Two-segment toggle: Rules | ML. Predictions are always shown; this only
  // switches which source's % every tile displays.
  const seg = (m: RevealMode, label: string, activeColor: string) => (
    <button
      onClick={() => onSelect(m)}
      className="px-3 py-1 rounded-full text-[11px] font-semibold transition-all active:scale-95"
      style={mode === m
        ? { background: activeColor + "22", color: activeColor, border: `1px solid ${activeColor}44` }
        : { background: "transparent", color: "#8a9ea6", border: "1px solid transparent" }}
    >
      {label}
    </button>
  );
  return (
    <div className="flex items-center justify-between px-1">
      <span className="text-[#4a6070] text-[11px] font-semibold uppercase tracking-wider">{t("pred.markets")}</span>
      <div className="flex items-center gap-0.5 p-0.5 rounded-full" style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)" }}>
        {seg("rules", `📐 ${t("pred.rules")}`, "#86d1ea")}
        {seg("ml", "🤖 ML", "#a78bfa")}
      </div>
    </div>
  );
}

/* ─── BetOption ─────────────────────────────── */
function BetOption({ opt, accent }: { opt: BetOpt; accent: string }) {
  const mode = useContext(RevealModeCtx);
  const [sheet, setSheet] = useState(false);

  // Predictions are always shown. The toggle picks the source: ML model % when
  // "ml" is selected, otherwise the rule-based %.
  const source: "rules" | "ml" = mode === "ml" ? "ml" : "rules";

  // ML % is fetched lazily, only while ML mode is active on this tile.
  const [mlPct, setMlPct] = useState<number | null>(null);
  useEffect(() => {
    if (source !== "ml" || !opt.mlProps) return;
    let alive = true;
    setMlPct(null);
    fetchMLProbability(
      { type: opt.mlProps.type, subjectId: opt.mlProps.subjectId, opponentId: opt.mlProps.opponentId, propType: opt.mlProps.propType, line: opt.mlProps.line },
      opt.rulePct,
    ).then(p => { if (alive) setMlPct(p); });
    return () => { alive = false; };
  }, [source, opt.mlProps, opt.rulePct]);

  const loadingMl = source === "ml" && !!opt.mlProps && mlPct === null;
  const shownPct = source === "ml" ? (mlPct ?? opt.rulePct) : opt.rulePct;
  const shownColor = pctColor(shownPct);

  return (
    <>
      <button
        onClick={() => setSheet(true)}
        className="flex flex-col items-center justify-between p-3 rounded-xl border transition-all active:scale-[0.97] w-full"
        style={{ minHeight: 64, background: "#131A12", borderColor: shownColor + "55" }}
      >
        <span className="text-white text-[11px] font-medium text-center leading-tight">{opt.label}</span>
        <span
          className="mt-2 px-3 py-0.5 rounded-full text-xs font-bold"
          style={{ background: shownColor + "22", color: shownColor, border: `1px solid ${shownColor}55` }}
        >
          {loadingMl ? "…" : `${shownPct}%`}
        </span>
      </button>
      {sheet && (
        <PredictionSheet
          label={opt.label} rulePct={opt.rulePct} ruleNote={opt.ruleNote}
          accent={accent} mlProps={opt.mlProps} factors={opt.factors} factorGroup={opt.factorGroup} onClose={() => setSheet(false)}
        />
      )}
    </>
  );
}

/* ─── MarketGroup ───────────────────────────── */
export function MarketGroup({ group, accent }: { group: MktGroup; accent: string }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="bg-[#0A0E0C] border border-white/[0.07] rounded-2xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3"
        style={{ borderBottom: open ? "1px solid rgba(255,255,255,0.06)" : "none" }}
      >
        <span className="text-[#c0cdd4] text-xs font-semibold uppercase tracking-wider">{group.title}</span>
        <span className="text-[#3a5060] text-xs">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div
          className="p-3 grid gap-2"
          style={{ gridTemplateColumns: `repeat(${group.cols}, 1fr)` }}
        >
          {group.options.map(opt => (
            <BetOption key={opt.id} opt={opt} accent={accent} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Players table (game and team prediction pages) ───────────────────────
 * One table at a time, showing each player's season line. On a game there are
 * two sides and a home/away switch; on a team page there is a single side and
 * no switch.
 *
 * A row no longer navigates on its own (2026-09-04): tapping it fades the line
 * and offers the three destinations — the player's charts, his club, his own
 * predictions — plus a × that brings the season line back.
 */

type PlayerSide = { key: string; abbr: string; name: string };

/** The destinations offered for the tapped player, and the way back. */
function PlayerRowActions({ playerId, abbr, gameId, accent, showTeam, onClose }: {
  playerId: string; abbr: string; gameId?: string; accent: string; showTeam: boolean; onClose: () => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  // Le match suit le joueur et le club, pour que la page d'arrivée parle de
  // CETTE affiche plutôt que du prochain match par défaut.
  const suffix = gameId ? `?game=${gameId}` : "";
  const act = (label: string, to: string) => (
    <button
      onClick={(e) => { e.stopPropagation(); navigate(to); }}
      className="flex-1 min-w-0 px-2 py-2 rounded-lg text-[11px] font-semibold truncate transition-transform active:scale-95"
      style={{ background: accent + "1a", color: accent, border: `1px solid ${accent}44` }}
    >
      {label}
    </button>
  );
  return (
    <div className="flex items-center gap-1.5 px-3 py-2">
      {act(t("pred.playerCharts"), `/stats/chart/player/${playerId}`)}
      {/* Sur la page prédiction de l'équipe elle-même, ce bouton pointait vers
          la page où l'on se trouve déjà : il ne se passait rien. Il n'y est
          plus (2026-09-04). */}
      {showTeam && act(t("pred.playerTeam"), `/stats/prediction/team/${abbr.toLowerCase()}${suffix}`)}
      {act(t("pred.playerPreds"),  `/stats/prediction/player/${playerId}${suffix}`)}
      <button
        onClick={(e) => { e.stopPropagation(); onClose(); }}
        aria-label={t("pred.playerBackToStats")}
        title={t("pred.playerBackToStats")}
        className="tap-44 w-8 h-8 flex-shrink-0 rounded-lg text-sm font-bold text-[#8a9ea6] bg-[#0A0E0C] border border-white/15 transition-transform active:scale-95"
      >
        ×
      </button>
    </div>
  );
}

function PlayersStatsTable({ sides, gameId, accent, showTeamAction = true }: {
  sides: PlayerSide[];
  gameId?: string;
  accent: string;
  /** false sur la page d'une équipe : le bouton mènerait à la page courante. */
  showTeamAction?: boolean;
}) {
  const { t } = useI18n();
  const [sideKey, setSideKey] = useState(sides[0]?.key ?? "");
  const [rosters, setRosters] = useState<Record<string, any[]>>({});
  const [loading, setLoading] = useState(false);
  const [openPlayer, setOpenPlayer] = useState<string | null>(null);

  const side = sides.find(s => s.key === sideKey) ?? sides[0];
  const activeAbbr = side?.abbr ?? "";

  useEffect(() => {
    if (!activeAbbr || rosters[activeAbbr]) return;
    let alive = true;
    setLoading(true);
    nhlApiService.getTeamRoster(activeAbbr.toUpperCase())
      .then((roster: any[]) => { if (alive) setRosters(prev => ({ ...prev, [activeAbbr]: roster })); })
      .catch(() => { if (alive) setRosters(prev => ({ ...prev, [activeAbbr]: [] })); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [activeAbbr]);

  // Changer de côté ferme la ligne ouverte : elle appartenait à l'autre club.
  useEffect(() => { setOpenPlayer(null); }, [activeAbbr]);

  // Server already sorts by points, but a re-sort keeps the order stable if a
  // future endpoint stops doing so.
  const players = [...(rosters[activeAbbr] ?? [])].sort((a, b) => (b.points ?? 0) - (a.points ?? 0));

  const head = (label: string) => (
    <th className="font-semibold px-2 py-2 text-center whitespace-nowrap">{label}</th>
  );
  const cell = (value: number | string) => (
    <td className="px-2 py-2 text-center tabular-nums text-[#c8d3cc]">{value}</td>
  );

  return (
    <div className="bg-[#131A12] border border-white/20 rounded-2xl overflow-hidden">
      <div className="px-4 pt-3 pb-2 flex items-center gap-2">
        <span className="text-white text-sm font-medium">{t("pred.playersTable")}</span>
        {sides.length === 1 && side && (
          <span className="text-[#8a9ea6] text-[11px]">· {side.name}</span>
        )}
        <span className="text-[#8a9ea6] text-[11px] ml-auto">{t("pred.seasonStats")}</span>
      </div>

      {/* Team tabs — only when there are two clubs to switch between */}
      {sides.length > 1 && (
        <div className="px-4 pb-3">
          <div className="flex gap-1.5 bg-[#0A0E0C] rounded-xl p-1">
            {sides.map(o => (
              <button
                key={o.key}
                onClick={() => setSideKey(o.key)}
                className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all"
                style={sideKey === o.key ? { background: accent, color: "#0A0E0C" } : { color: "#8a9ea6" }}
              >
                <img src={nhlLogoUrl(o.abbr)} alt={o.abbr} className="w-4 h-4 object-contain" />
                {o.abbr}
              </button>
            ))}
          </div>
        </div>
      )}

      {loading && players.length === 0 ? (
        <div className="px-4 pb-4 flex flex-col gap-2">
          {[1, 2, 3, 4].map(i => <div key={i} className="h-9 bg-[#0A0E0C] rounded-lg animate-pulse" />)}
        </div>
      ) : players.length === 0 ? (
        <p className="text-[#8a9ea6] text-xs text-center py-6">{t("players.none", { abbr: activeAbbr })}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="text-[#8a9ea6]">
                <th className="text-left font-semibold px-3 py-2 sticky left-0 z-10" style={{ background: "#131A12" }}>
                  {t("chart.player")}
                </th>
                {head("GP")}{head("G")}{head("A")}{head("P")}{head("+/-")}{head("SOG")}{head("PP")}
              </tr>
            </thead>
            <tbody>
              {players.map((p: any) => {
                const id = String(p.id);
                const name = p.name ?? p.fullName ?? `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim();
                const number = p.number ?? p.jerseyNumber ?? p.sweaterNumber ?? 0;
                const pm = p.plusMinus ?? 0;
                const open = openPlayer === id;
                return (
                  <Fragment key={id}>
                    <tr
                      onClick={() => setOpenPlayer(open ? null : id)}
                      aria-expanded={open}
                      className="border-t border-white/[0.06] cursor-pointer hover:bg-white/[0.04] transition-colors"
                      style={open ? { opacity: 0.45 } : undefined}
                    >
                      <td className="px-3 py-2 sticky left-0 z-10 whitespace-nowrap" style={{ background: "#131A12" }}>
                        <span className="text-[#5c6f63] tabular-nums mr-1.5">{number}</span>
                        <span className="text-white font-medium">{name}</span>
                        <span className="text-[#5c6f63] ml-1.5">{p.position ?? "—"}</span>
                      </td>
                      {cell(p.gamesPlayed ?? 0)}
                      {cell(p.goals ?? 0)}
                      {cell(p.assists ?? 0)}
                      <td className="px-2 py-2 text-center tabular-nums font-semibold" style={{ color: accent }}>{p.points ?? 0}</td>
                      {cell(pm > 0 ? `+${pm}` : String(pm))}
                      {cell(p.shots ?? 0)}
                      {cell(p.ppPoints ?? 0)}
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={8} className="p-0" style={{ background: "#0F160E" }}>
                          <PlayerRowActions
                            playerId={id}
                            abbr={activeAbbr}
                            gameId={gameId}
                            accent={accent}
                            showTeam={showTeamAction}
                            onClose={() => setOpenPlayer(null)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Both rosters of a match, with a home/away switch. */
export function GamePlayersTable({ gameId, home, away, accent }: {
  gameId: string;
  home: { abbr: string; name: string };
  away: { abbr: string; name: string };
  accent: string;
}) {
  return (
    <PlayersStatsTable
      sides={[{ key: "home", ...home }, { key: "away", ...away }]}
      gameId={gameId}
      accent={accent}
    />
  );
}

/** A single club's roster, for the team prediction page. */
export function TeamPlayersTable({ abbr, name, gameId, accent }: {
  abbr: string;
  name: string;
  gameId?: string;
  accent: string;
}) {
  return (
    <PlayersStatsTable
      sides={[{ key: "team", abbr, name }]}
      gameId={gameId}
      accent={accent}
      showTeamAction={false}
    />
  );
}
