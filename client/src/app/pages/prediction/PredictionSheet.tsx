/**
 * PredictionSheet.tsx
 *
 * Extrait de PredictionPage.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { useEffect, useMemo, useState, useContext } from "react";
import { predictionApiService } from "../../services/predictionApiService";
import { requestFromMLProps } from "../../services/predictionRequest";
import { useI18n } from "../../i18n";
import { nhlLogoUrl } from "../../data/teamEmoji";
import { useBet } from "../../context/BetContext";
import type { BetLeg, PredictionCaveat } from "../../types/bet";
import { askLLM } from "../../services/llmService";
import { MLSection, fetchMLProbability, mlProbabilityKey, type MLProbabilityRequest } from "../../components/MLPredictionCard";
import { RuleFactorEditor } from "../../components/RuleFactorEditor";
import { FramedLabel } from "../../components/brand/FramedLabel";
import { BetOpt, MLProps, MktGroup, RuleFactor, buildLLMDataContext, llmCacheId, loadLlmCache, saveLlmCache, scaledRulePct, settlementFields } from "./gameMarkets";
import { pctColor } from "../../data/pctScale";
import { blendFactors, getFamilyWeights } from "../../services/ruleWeightsService";
import { BetOddsCtx, RevealMode, RevealModeCtx } from "./predictionShared";
import { priceForBet } from "../../services/gameOdds";
import { useOddsFormat } from "../../context/OddsFormatContext";

/* ─── Identifiant de la jambe de coupon ──────────────────────────────────────
 *
 * Il vivait DANS `PredictionSheet`, donc seule la fiche ouverte savait si un
 * pari était déjà au coupon. La tuile, elle, ne pouvait pas le savoir — et
 * c'est précisément ce qu'on veut lui faire dire (encadré vert). Recalculer la
 * même chaîne à deux endroits, c'est garantir qu'elles finiront par diverger :
 * la fiche retirerait alors une jambe que la tuile croit absente.
 *
 * ⚠️ `rulePct` entre dans l'identifiant des paris SANS `mlProps` (il n'y a rien
 * d'autre pour les distinguer). La tuile doit donc passer le MÊME `rulePct` que
 * celui qu'elle transmet à la fiche — c'est-à-dire le score pondéré par
 * l'utilisateur, pas `opt.rulePct` brut.
 */
export function betLegId(label: string, mlProps: MLProps | undefined, rulePct: number): string {
  const slug = label.replace(/\s+/g, "-").toLowerCase().slice(0, 24);
  return mlProps
    ? `${mlProps.subjectId}-${mlProps.propType ?? "bet"}-${slug}`
    : `rule-${slug}-${rulePct}`;
}

/* ─── Prediction bottom sheet ───────────────── */
function PredictionSheet({ label, rulePct, serverPct, ruleNote, accent, mlProps, factors, factorGroup, pctScale, onClose }: {
  label: string; rulePct: number; serverPct?: number; ruleNote: string; accent: string;
  mlProps?: MLProps; factors?: RuleFactor[]; factorGroup?: string; pctScale?: number; onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const { odds } = useOddsFormat();
  const { table: oddsTable, bookTitle, nameByAbbr } = useContext(BetOddsCtx);
  const bookPrice = priceForBet(oddsTable, mlProps, nameByAbbr);
  const llmId = llmCacheId(label, mlProps, lang);
  const [llmText, setLlmText]     = useState(() => loadLlmCache(llmId)); // réponse en cache si déjà générée
  const [llmOpen, setLlmOpen]     = useState(false); // repliée par défaut pour ne pas cacher les autres cartes
  const [llmLoading, setLlmLoading] = useState(false);
  const [copied, setCopied]       = useState(false);
  const ruleColor = pctColor(rulePct);

  // Fall back to fetching the server prediction if the parent hasn't yet.
  const [ownServerPct, setOwnServerPct] = useState<number | undefined>(serverPct);
  // Réserve renvoyée avec la probabilité : moyenne de ligue faute de données par
  // joueur, estimateur partagé avec un autre marché, périodes supposées
  // équivalentes. Le chiffre est bon ; ce qu'il vaut n'est pas devinable en le
  // regardant, donc on l'écrit sous la carte des règles.
  const [caveat, setCaveat] = useState<PredictionCaveat | undefined>(undefined);
  // Dépendance = le CONTENU de `mlProps`, pas l'objet : les pages parentes le
  // recréent à chaque rendu (`{ ...o.mlProps, gameId }`), ce qui rejouait
  // `POST /predict/single` à chaque re-rendu tant que la carte était ouverte.
  const mlPropsKey = mlProps ? JSON.stringify(mlProps) : null;
  useEffect(() => {
    if (serverPct !== undefined) { setOwnServerPct(serverPct); return; }
    if (!mlProps) return;
    let alive = true;
    setCaveat(undefined);
    predictionApiService
      .getSinglePrediction(requestFromMLProps(mlProps))
      .then(r => { if (alive) { setOwnServerPct(r.probability); setCaveat(r.caveat); } })
      .catch(() => { /* keep undefined → falls back to rulePct */ });
    return () => { alive = false; };
  }, [serverPct, mlPropsKey]);

  // The probability stored in the coupon — identical to what the stats grid shows.
  const legPct = ownServerPct ?? rulePct;

  const { addLeg, removeLeg, hasLeg } = useBet();
  const legId = betLegId(label, mlProps, rulePct);
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
      // Nécessaires au calcul de corrélation d'un coupon multi-jambes sur un
      // même match (cf. `BetLeg.opponentId`).
      opponentId: mlProps?.opponentId,
      isHome: mlProps?.isHome,
    };
    addLeg(leg);
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col justify-end"
      style={{ background: "rgba(0,0,0,0.75)" }}
      onClick={onClose}
    >
      <div
        className="bg-[#0A0E0C] rounded-t-3xl flex flex-col gap-3 max-h-[90vh] overflow-y-auto"
        style={{ padding: "20px 16px calc(6rem + env(safe-area-inset-bottom, 0px))" }}
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

        {/* ── 💰 Le PRIX du livre, quand il en propose un ──────────────────
            Séparé de tout ce qui suit, et étiqueté du nom du livre : ce n'est
            pas une sortie de nos modèles mais une offre extérieure. Absent
            partout où le fournisseur ne cote pas le marché — c'est-à-dire
            presque partout hors vainqueur / totaux / handicap. */}
        {bookPrice != null && (
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl border border-[#4ade80]/25 bg-[#4ade80]/[0.07]">
            <span className="text-[#4ade80] text-[11px] font-semibold uppercase tracking-wider">
              {bookTitle ?? t("pred.bookOdds")}
            </span>
            <span className="ml-auto text-[#4ade80] text-lg font-black tabular-nums">
              {odds(bookPrice)}
            </span>
          </div>
        )}

        {/* ── 🤖 ML — prédiction du modèle ── */}
        {mlProps ? (
          <MLSection
            type={mlProps.type}
            subjectId={mlProps.subjectId}
            opponentId={mlProps.opponentId}
            propType={mlProps.propType}
            line={mlProps.line}
            selection={mlProps.selection}
            isHome={mlProps.isHome}
            ruleBasedPct={rulePct}
            label={label}
            simple
          />
        ) : null}

        {/* ── ⓘ Réserve sur le chiffre, quand il y en a une ── */}
        {caveat && (
          <div className="flex items-start gap-2 px-3 py-2.5 rounded-xl border border-[#facc15]/25 bg-[#facc15]/[0.07]">
            <span className="text-[#facc15] text-[11px] leading-none mt-0.5 flex-shrink-0">ⓘ</span>
            <p className="text-[#c9b87a] text-[11px] leading-relaxed">{t(`ml.caveat.${caveat}`)}</p>
          </div>
        )}

        {/* ── 📐 Règles — éditeur de facteurs par pari, ou note simple ── */}
        {factors && factors.length > 0 && factorGroup ? (
          <RuleFactorEditor factors={factors} factorGroup={factorGroup} pctScale={pctScale} label={t("pred.rules")} />
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

/* ─── BetOption ─────────────────────────────────────────────────────────────
 *
 * `compact` rend la MÊME tuile, en case de tableau : sans l'étiquette (la
 * grille la porte déjà en en-tête de colonne et en tête de ligne) et sans
 * hauteur minimale. Tout le reste est identique — état coupon, bascule
 * Règles/ML, prix du livre, fiche à l'ouverture — parce qu'une case de grille
 * EST un pari, et qu'un second composant qui se contenterait d'y ressembler
 * finirait par diverger sur l'un de ces quatre points.
 */
export function BetOption({ opt, accent, compact = false }: { opt: BetOpt; accent: string; compact?: boolean }) {
  const { t } = useI18n();
  const mode = useContext(RevealModeCtx);
  const { odds } = useOddsFormat();
  const { table: oddsTable, nameByAbbr } = useContext(BetOddsCtx);
  const { hasLeg } = useBet();
  const [sheet, setSheet] = useState(false);

  // Score de règles de la tuile = celui que la carte ouverte affichera, donc
  // pondération de l'utilisateur comprise. Sans ça, la tuile montrait le blend
  // par défaut et la carte le blend réglé : deux chiffres pour un même pari.
  // `sheet` est dans les dépendances exprès : refermer la carte après avoir
  // enregistré de nouveaux poids recalcule la tuile.
  //
  // `pctScale` : une tuile qui pose une question plus étroite que ses facteurs
  // (« gagne en temps réglementaire » vs « gagne ») en porte la fraction. Sans
  // elle, repondérer les facteurs ramenait la tuile réglementaire à
  // P(victoire, prolongations comprises) — le chiffre du marché voisin.
  const rulePct = useMemo(() => (
    opt.factors?.length && opt.factorGroup
      ? scaledRulePct(blendFactors(opt.factors, getFamilyWeights(opt.factorGroup, opt.factors)), opt.pctScale)
      : opt.rulePct
  ), [opt.factors, opt.factorGroup, opt.rulePct, opt.pctScale, sheet]);

  // Ce pari est-il DÉJÀ au coupon ? La tuile le dit d'un liseré vert, pour
  // qu'on le voie sans ouvrir la fiche — c'est toute la question quand on
  // parcourt cinquante marchés d'affilée.
  //
  // ⚠️ `rulePct` (pondéré) et non `opt.rulePct` : l'identifiant d'un pari sans
  // `mlProps` en dépend, et la fiche reçoit cette même valeur. Voir `betLegId`.
  const inSlip = hasLeg(betLegId(opt.label, opt.mlProps, rulePct));

  // Le prix du livre, s'il en cote un pour ce marché. Presque toujours absent :
  // le fournisseur ne sert que vainqueur, totaux et handicap.
  const bookPrice = priceForBet(oddsTable, opt.mlProps, nameByAbbr);

  // Predictions are always shown. The toggle picks the source: ML model % when
  // "ml" is selected, otherwise the rule-based %.
  const source: "rules" | "ml" = mode === "ml" ? "ml" : "rules";

  // ML % is fetched lazily, only while ML mode is active on this tile.
  //
  // Trois valeurs, trois sens distincts — c'est tout l'objet de ce state :
  //   `undefined` → requête en cours ;
  //   `null`      → le modèle n'a pas répondu, la tuile n'a PAS de chiffre ML ;
  //   un nombre   → une vraie probabilité du modèle.
  //
  // `null` valait « en attente » ici, et `fetchMLProbability` ne renvoyait
  // jamais rien d'autre qu'un nombre : hors ligne, elle fabriquait `rulePct ± 3`
  // et la tuile l'affichait comme une sortie de modèle. Retomber en silence sur
  // `rulePct` serait le même mensonge, simplement plus discret : en mode ML on
  // montre « — », et l'utilisateur peut basculer sur les règles pour un chiffre.
  const [mlPct, setMlPct] = useState<number | null | undefined>(undefined);
  // ⚠️ Dépendances = `source` + une CLÉ texte, jamais l'objet `opt.mlProps` :
  // GamePrediction / PlayerPrediction recréent cet objet à chaque rendu, donc
  // l'effet repartait sur toutes les tuiles à chaque re-rendu de la page. Le
  // cache de `fetchMLProbability` absorbe en plus les retours Règles → ML et
  // les tuiles qui demandent la même chose (mesuré le 2026-09-16 : 31 appels
  // par bascule sur une page de match, 429 dès le premier aller-retour).
  const mlReq: MLProbabilityRequest | null = opt.mlProps
    ? { type: opt.mlProps.type, subjectId: opt.mlProps.subjectId, opponentId: opt.mlProps.opponentId, propType: opt.mlProps.propType, line: opt.mlProps.line, selection: opt.mlProps.selection, isHome: opt.mlProps.isHome }
    : null;
  const mlKey = mlReq ? mlProbabilityKey(mlReq) : null;
  useEffect(() => {
    if (source !== "ml" || !mlReq) return;
    let alive = true;
    setMlPct(undefined);
    fetchMLProbability(mlReq).then(p => { if (alive) setMlPct(p); });
    return () => { alive = false; };
  }, [source, mlKey]);

  const mlMode      = source === "ml" && !!opt.mlProps;
  const loadingMl   = mlMode && mlPct === undefined;
  const mlMissing   = mlMode && mlPct === null;
  const shownPct    = mlMode ? (mlPct ?? rulePct) : rulePct;
  // Tuile sans chiffre : grise, pour qu'elle ne se lise pas comme une prédiction
  // faible (un « — » coloré en rouge dirait quelque chose, et on ne sait rien).
  const shownColor  = mlMissing ? "#4a5a60" : pctColor(shownPct);

  return (
    <>
      <button
        onClick={() => setSheet(true)}
        aria-pressed={inSlip}
        aria-label={compact ? opt.label : undefined}
        title={compact ? opt.label : undefined}
        className={`relative flex flex-col items-center justify-between rounded-xl border transition-all active:scale-[0.97] w-full ${compact ? "p-1.5" : "p-3"}`}
        style={inSlip
          // Vert franc et fond teinté : à côté d'une tuile ordinaire bordée de
          // la couleur du pourcentage, un vert pâle ne se lirait pas comme un
          // état mais comme une nuance de plus.
          ? { minHeight: compact ? 0 : 64, background: "#132116", borderColor: "#4ade80", borderWidth: 2 }
          : { minHeight: compact ? 0 : 64, background: "#131A12", borderColor: shownColor + "55" }}
      >
        {/* La coche dit CE QUE le vert veut dire. Un liseré seul se devine ;
            une couleur seule ne se voit pas non plus en vision daltonienne. */}
        {inSlip && (
          <span
            aria-hidden
            className="absolute top-1 right-1.5 text-[#4ade80] text-[10px] font-black leading-none"
          >
            ✓
          </span>
        )}
        {/* En grille, l'étiquette est portée par la ligne et la colonne — la
            répéter dans chaque case rendrait le tableau illisible. Elle reste
            accessible par `aria-label` et l'infobulle. */}
        {!compact && (
          <span className="text-white text-[11px] font-medium text-center leading-tight">{opt.label}</span>
        )}
        <span
          className={`${compact ? "" : "mt-2 px-3"} py-0.5 rounded-full text-xs font-bold`}
          data-compact={compact || undefined}
          style={{ background: shownColor + "22", color: shownColor, border: `1px solid ${shownColor}55` }}
          title={mlMissing ? t("ml.unavailable") : undefined}
        >
          {loadingMl ? "…" : mlMissing ? "—" : `${shownPct}%`}
        </span>
        {/* Le prix du livre, sous le pourcentage et visiblement à part : ce
            sont deux choses différentes — notre estimation, et une offre. Rien
            ne s'affiche quand le livre ne cote pas ce marché ; pas de tiret,
            qui ferait croire à une donnée manquante alors que c'est l'état
            normal de la quasi-totalité des marchés. */}
        {bookPrice != null && (
          <span className="mt-1 text-[#4ade80] text-[10px] font-bold tabular-nums leading-none">
            {odds(bookPrice)}
          </span>
        )}
      </button>
      {sheet && (
        <PredictionSheet
          label={opt.label} rulePct={rulePct} ruleNote={opt.ruleNote}
          accent={accent} mlProps={opt.mlProps} factors={opt.factors} factorGroup={opt.factorGroup}
          pctScale={opt.pctScale} onClose={() => setSheet(false)}
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

/* ─── Tableau d'effectif — RETIRÉ le 2026-09-19 ──────────────────────────────
 *
 * `PlayersStatsTable`, `GamePlayersTable`, `TeamPlayersTable` et
 * `PlayerRowActions` fermaient les pages de prédiction d'un match et d'une
 * équipe avec la ligne de saison de chaque joueur.
 *
 * Ils partent parce que la page a désormais mieux au même endroit :
 * `PlayerPropGrid` montre les mêmes joueurs, classés par la statistique qui
 * nous intéresse, et chaque case y EST un pari. L'ancien tableau ne donnait que
 * des nombres à lire ; pour miser sur les buts d'un joueur, il fallait toucher
 * sa ligne, ouvrir sa page, y retrouver le bon groupe de marchés — et la
 * comparaison entre coéquipiers, qui est la raison même de regarder un
 * effectif, se perdait au premier changement d'écran.
 *
 * Les lignes de saison complètes n'ont pas disparu du produit : elles vivent
 * sur la page Statistiques (`/stats/chart/...`), vers laquelle les deux pages
 * pointent maintenant par un bouton en pied de page.
 *
 * Aucun autre appelant : `grep` sur les quatre noms ne rend plus que ce
 * commentaire.
 */
