/**
 * PredictionSheet.tsx
 *
 * Extrait de PredictionPage.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { useNavigate } from "react-router";
import { useEffect, useState, useContext } from "react";
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
  const pctColor = rulePct >= 65 ? "#4ade80" : rulePct >= 50 ? accent : rulePct >= 38 ? "#facc15" : "#f87171";

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
              <span className="text-xl font-black flex-shrink-0" style={{ color: pctColor }}>{rulePct}%</span>
            </div>
            <div className="px-4 py-3">
              <div className="w-full bg-[#0A0E0C] rounded-full h-2 mb-2.5 overflow-hidden">
                <div className="h-2 rounded-full transition-all duration-700"
                  style={{ width: `${rulePct}%`, backgroundColor: pctColor }} />
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
                  className="text-[10px] font-semibold px-2 py-1 rounded-md bg-purple-500/20 hover:bg-purple-500/30 text-purple-200 transition-colors"
                >
                  {copied ? (lang === "fr" ? "Copié ✓" : "Copied ✓") : (lang === "fr" ? "Copier" : "Copy")}
                </button>
              )}
              <button
                onClick={() => setLlmOpen((v) => !v)}
                className="text-[10px] text-purple-300 font-semibold px-2.5 py-1 rounded-lg border border-purple-400/30 hover:bg-purple-500/15"
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

                const systemPrompt = isFr
                  ? "Tu es un analyste de paris LNH pointu dont la valeur est le contexte qu'un modèle statistique manque. " +
                    "Tu n'as AUCUNE donnée en temps réel et ta connaissance a une date limite — n'affirme jamais une blessure, " +
                    "un alignement ou un gardien actuel comme un fait. " +
                    "Quand des « Données de l'application » sont fournies, considère-les comme la vérité et fonde ton « Analyse » dessus. " +
                    "Réponds EXACTEMENT dans ce format, sans introduction ni paragraphe :\n" +
                    "Analyse :\n" +
                    "- 2 à 5 points clés courts (≤ 12 mots), facteurs hors statistiques : forme, fatigue (matchs consécutifs), " +
                    "voyage, style d'affrontement, motivation (course aux séries, tanking). " +
                    "N'inclus QUE des points appuyés par les données ou tes connaissances; si une information est inconnue " +
                    "ou non fournie, OMETS le point — n'écris JAMAIS « inconnu », « non précisé », « N/D » ni « non spécifié ». " +
                    "Mieux vaut 2 bons points que 5 avec du remplissage.\n" +
                    "\n" +
                    "À vérifier :\n" +
                    "- REGROUPE ICI UNIQUEMENT les éléments externes en temps réel que l'application n'a pas : " +
                    "blessures/absences, gardien partant confirmé, changements d'alignement de dernière minute. " +
                    "N'inclus JAMAIS l'historique OT, le voyage/calendrier, la forme récente ni la fatigue — " +
                    "l'application fournit déjà ces données, sers-t'en dans « Analyse » au lieu de demander de les vérifier. " +
                    "Un élément par point, ≤ 10 mots, formulé comme une chose vérifiable (ex. « Gardien partant de MTL confirmé ? »).\n" +
                    "\n" +
                    "Verdict : Bon pari / Avantage léger / À éviter — Confiance : faible, moyenne ou élevée " +
                    "(choisis UN mot pour le verdict et UN pour la confiance)"
                  : "You are a sharp NHL betting analyst whose value is the context a stats model misses. " +
                    "You have NO live data and your knowledge has a cutoff — never state a current injury, lineup, or goalie " +
                    "start as fact. " +
                    "When 'App data' is provided, treat it as ground truth and base your 'Analysis' on it. " +
                    "Reply in EXACTLY this format, with no intro and no paragraphs:\n" +
                    "Analysis:\n" +
                    "- 2-5 short key points (≤12 words), off-the-sheet factors: form, fatigue (back-to-back), travel, " +
                    "style matchup, motivation (playoff race, tanking). " +
                    "Include ONLY points backed by the data or your knowledge; if something is unknown or not provided, " +
                    "OMIT that point — never write 'unknown', 'not specified', 'unclear' or 'N/A'. " +
                    "Two solid points beat five with filler.\n" +
                    "\n" +
                    "To verify:\n" +
                    "- GROUP HERE ONLY external live items the app does NOT have: " +
                    "injuries/absences, confirmed starting goalie, last-minute lineup changes. " +
                    "NEVER include OT history, travel/schedule, recent form or fatigue — the app already provides these, " +
                    "so use them in 'Analysis' instead of asking to verify them. " +
                    "One item per bullet, ≤10 words, phrased as a checkable question (e.g. 'MTL starting goalie confirmed?').\n" +
                    "\n" +
                    "Verdict: Good bet / Slight edge / Avoid — Confidence: low, medium or high " +
                    "(pick ONE word for the verdict and ONE for the confidence)";

                const text = await askLLM(userPrompt, { systemPrompt });
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
      className="px-3 py-1 rounded-full text-[10px] font-semibold transition-all active:scale-95"
      style={mode === m
        ? { background: activeColor + "22", color: activeColor, border: `1px solid ${activeColor}44` }
        : { background: "transparent", color: "#8a9ea6", border: "1px solid transparent" }}
    >
      {label}
    </button>
  );
  return (
    <div className="flex items-center justify-between px-1">
      <span className="text-[#4a6070] text-[10px] font-semibold uppercase tracking-wider">{t("pred.markets")}</span>
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
  const pctColor = shownPct >= 65 ? "#4ade80" : shownPct >= 50 ? accent : shownPct >= 38 ? "#facc15" : "#f87171";

  return (
    <>
      <button
        onClick={() => setSheet(true)}
        className="flex flex-col items-center justify-between p-3 rounded-xl border transition-all active:scale-[0.97] w-full"
        style={{ minHeight: 64, background: "#131A12", borderColor: pctColor + "55" }}
      >
        <span className="text-white text-[11px] font-medium text-center leading-tight">{opt.label}</span>
        <span
          className="mt-2 px-3 py-0.5 rounded-full text-xs font-bold"
          style={{ background: pctColor + "22", color: pctColor, border: `1px solid ${pctColor}55` }}
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

/* ─── GamePrediction ────────────────────────── */
/** Roster player row — clicking navigates to that player's prediction page. */
function GameRosterPlayerRow({ player, teamAbbr, accent }: {
  player: any; teamAbbr: string; accent: string;
}) {
  const navigate = useNavigate();
  const id = String(player.id);
  const name = player.name ?? player.fullName ?? `${player.firstName ?? ""} ${player.lastName ?? ""}`.trim();
  const number = player.number ?? player.jerseyNumber ?? player.sweaterNumber ?? 0;
  return (
    <button
      onClick={() => navigate(`/stats/prediction/player/${id}`)}
      className="w-full bg-[#0A0E0C] border border-white/10 rounded-xl px-3 py-2.5 flex items-center gap-2.5 active:scale-[0.98] transition-transform text-left"
    >
      <img src={nhlLogoUrl(teamAbbr)} alt={teamAbbr} className="w-7 h-7 object-contain flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-white text-xs font-medium truncate">{name}</p>
        <p className="text-[#8a9ea6] text-[10px]">#{number} · {player.position ?? "—"}</p>
      </div>
      <span className="text-[10px] font-bold flex-shrink-0" style={{ color: accent }}>
        {player.points ?? 0} PTS
      </span>
      <span className="text-[#8a9ea6] text-sm flex-shrink-0">›</span>
    </button>
  );
}

/** Togglable "Players" section on a game's prediction page — lets a user pick
 * either roster and jump straight to a player's own prediction page. */
export function GamePlayersSection({ home, away, accent }: {
  home: { abbr: string; name: string }; away: { abbr: string; name: string }; accent: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<"home" | "away">("home");
  const [rosters, setRosters] = useState<Record<string, any[]>>({});
  const [loading, setLoading] = useState(false);

  const activeAbbr = side === "home" ? home.abbr : away.abbr;

  useEffect(() => {
    if (!open || rosters[activeAbbr]) return;
    setLoading(true);
    nhlApiService.getTeamRoster(activeAbbr.toUpperCase())
      .then((roster: any[]) => setRosters(prev => ({ ...prev, [activeAbbr]: roster })))
      .catch(() => setRosters(prev => ({ ...prev, [activeAbbr]: [] })))
      .finally(() => setLoading(false));
  }, [open, activeAbbr]);

  const players = rosters[activeAbbr] ?? [];

  return (
    <div className="bg-[#131A12] border border-white/20 rounded-2xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3.5"
      >
        <span className="text-white text-sm font-medium">{t("pred.viewPlayers")}</span>
        <span className="text-[#8a9ea6] text-xs transition-transform" style={{ transform: open ? "rotate(180deg)" : "none" }}>▾</span>
      </button>
      {open && (
        <div className="px-4 pb-4 flex flex-col gap-3">
          {/* Team tabs */}
          <div className="flex gap-1.5 bg-[#0A0E0C] rounded-xl p-1">
            {[{ key: "home" as const, abbr: home.abbr }, { key: "away" as const, abbr: away.abbr }].map(o => (
              <button
                key={o.key}
                onClick={() => setSide(o.key)}
                className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all"
                style={side === o.key ? { background: accent, color: "#0A0E0C" } : { color: "#8a9ea6" }}
              >
                <img src={nhlLogoUrl(o.abbr)} alt={o.abbr} className="w-4 h-4 object-contain" />
                {o.abbr}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="flex flex-col gap-2">
              {[1, 2, 3].map(i => <div key={i} className="h-12 bg-[#0A0E0C] rounded-xl animate-pulse" />)}
            </div>
          ) : players.length === 0 ? (
            <p className="text-[#8a9ea6] text-xs text-center py-4">{t("players.none", { abbr: activeAbbr })}</p>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-80 overflow-y-auto">
              {players.map((p: any) => (
                <GameRosterPlayerRow key={p.id} player={p} teamAbbr={activeAbbr} accent={accent} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
