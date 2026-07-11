import { useEffect, useState } from "react";
import { predictionApiService } from "../../services/predictionApiService";
import { requestFromMLProps } from "../../services/predictionRequest";
import { useBet } from "../../context/BetContext";
import type { BetLeg } from "../../types/bet";
import { nhlApiService } from "../../services/nhlApiService";
import { nhlLogoUrl } from "../../data/teamEmoji";
import { askLLM } from "../../services/llmService";
import { MLSection } from "../../components/MLPredictionCard";
import { useI18n } from "../../i18n";
import type { MLProps } from "./markets";

/* ─── LLM data context ───────────────────────────────────────────────────────
 * Fetches the real stats the app already has for this bet's subject (team, game,
 * or player) and formats them as a compact facts block to feed the LLM, so it
 * reasons over actual numbers instead of asking the user to verify them.
 */
function fmtNum(n: number | undefined | null, digits: number, fr: boolean): string {
  if (n == null || Number.isNaN(Number(n))) return "?";
  const s = Number(n).toFixed(digits);
  return fr ? s.replace(".", ",") : s;
}

async function buildLLMDataContext(mlProps: MLProps | undefined, fr: boolean): Promise<string> {
  if (!mlProps) return "";
  try {
    // ── Player bet: subjectId is a player id ──────────────────────────────
    if (mlProps.type === "player") {
      const [info, st] = await Promise.all([
        nhlApiService.getPlayer(mlProps.subjectId).catch(() => null),
        nhlApiService.getPlayerStats(mlProps.subjectId).catch(() => null),
      ]);
      if (!st) return "";
      const name = info?.name ?? info?.fullName ?? mlProps.subjectId;
      const pos = info?.position ?? "";
      const team = info?.teamAbbr ?? "";
      const gp = st.gamesPlayed || 0;
      if (pos === "G" || st.savePct != null) {
        return fr
          ? `Données de l'application — gardien (${name}, ${team}) : ${gp} MJ, % arrêts ${fmtNum(st.savePct, 3, fr)}, moy. buts alloués ${fmtNum(st.goalsAgainstAvg, 2, fr)}.`
          : `App data — goalie (${name}, ${team}): ${gp} GP, SV% ${fmtNum(st.savePct, 3, fr)}, GAA ${fmtNum(st.goalsAgainstAvg, 2, fr)}.`;
      }
      const ppg = gp ? st.points / gp : 0;
      const pm = `${st.plusMinus >= 0 ? "+" : ""}${st.plusMinus}`;
      return fr
        ? `Données de l'application — joueur (${name}, ${pos}, ${team}) : ${gp} MJ, ${st.goals} B ${st.assists} A ${st.points} PTS (${fmtNum(ppg, 2, fr)} pts/match), tirs ${fmtNum(st.shootingPct, 1, fr)} %, ${fmtNum(st.timeOnIce, 1, fr)} min/match, ${pm}.`
        : `App data — player (${name}, ${pos}, ${team}): ${gp} GP, ${st.goals}G ${st.assists}A ${st.points}P (${fmtNum(ppg, 2, fr)} P/GP), ${fmtNum(st.shootingPct, 1, fr)}% shooting, ${fmtNum(st.timeOnIce, 1, fr)} min TOI, ${pm}.`;
    }

    // ── Team or game bet: subjectId (and opponentId) are team abbrs ────────
    const abbrs = mlProps.type === "game" && mlProps.opponentId
      ? [mlProps.subjectId, mlProps.opponentId]
      : [mlProps.subjectId];

    const results = await Promise.all(
      abbrs.map(async (a) => {
        try { return { a, s: await nhlApiService.getTeamStats(a) }; }
        catch { return null; }
      })
    );

    const lines = results
      .filter((x): x is { a: string; s: Awaited<ReturnType<typeof nhlApiService.getTeamStats>> } => x != null)
      .map(({ a, s }) => {
        const rec = `${s.wins}-${s.losses}-${s.otLosses}`;
        return fr
          ? `${a} : fiche ${rec}, 10 derniers ${s.last10 ?? "?"}, séquence ${s.streak ?? "?"}, buts ${fmtNum(s.goalsForPerGame, 1, fr)}/${fmtNum(s.goalsAgainstPerGame, 1, fr)} pour/contre, AN ${fmtNum(s.powerPlayPct, 1, fr)} % DN ${fmtNum(s.penaltyKillPct, 1, fr)} %, dom. ${s.homeRecord ?? "?"} ext. ${s.awayRecord ?? "?"}`
          : `${a}: record ${rec}, last 10 ${s.last10 ?? "?"}, streak ${s.streak ?? "?"}, goals ${fmtNum(s.goalsForPerGame, 1, fr)}/${fmtNum(s.goalsAgainstPerGame, 1, fr)} for/against, PP ${fmtNum(s.powerPlayPct, 1, fr)}% PK ${fmtNum(s.penaltyKillPct, 1, fr)}%, home ${s.homeRecord ?? "?"} away ${s.awayRecord ?? "?"}`;
      });

    if (!lines.length) return "";
    const header = fr ? "Données de l'application" : "App data";
    return `${header}:\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

/* ─── Prediction bottom sheet ───────────────── */
export function PredictionSheet({ label, rulePct, serverPct, ruleNote, accent, mlProps, onClose }: {
  label: string; rulePct: number; serverPct?: number; ruleNote: string; accent: string;
  mlProps?: MLProps; onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const [llmText, setLlmText]     = useState("");
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
    const leg: BetLeg = {
      id: legId,
      marketType: (mlProps?.propType ?? "moneyline") as BetLeg["marketType"],
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

        {/* ── 📐 Règles — avec explication exacte ── */}
        <div className="bg-[#0d1519] border border-white/[0.07] rounded-2xl overflow-hidden">
          <div className="flex items-center gap-2.5 px-4 py-3 border-b border-white/[0.05]">
            <div className="w-7 h-7 rounded-lg bg-white/05 border border-white/10 flex items-center justify-center text-sm flex-shrink-0">📐</div>
            <span className="text-white text-sm font-bold flex-1">{t("pred.rules")}</span>
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

        {/* ── Ask LLM ── */}
        {llmText ? (
          <div className="bg-purple-500/10 border border-purple-500/30 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm">✨</span>
              <span className="text-purple-300 text-xs font-semibold flex-1">{t("pred.llmAnalysis")}</span>
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
            </div>
            <p className="text-[#bfc8cc] text-xs leading-relaxed whitespace-pre-line">{llmText}</p>
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
              } catch (err: any) {
                const type = (err as any).type;
                if (type === "no_api_key") {
                  setLlmText("⚙️ " + err.message);
                } else {
                  setLlmText("❌ " + (err.message ?? "LLM error"));
                }
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
