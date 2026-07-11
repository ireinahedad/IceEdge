/**
 * TennisPredictionsPage.tsx
 * Tennis prediction page — same NHL-style UI:
 *   • Collapsible MarketGroups
 *   • Tap BetOption to reveal % → click % to open PredictionSheet
 *   • PredictionSheet: ML section + Rules bar + Ask LLM
 *
 * Navigated to from HockeyLanding tennis cards via /predictions/tennis?id=matchId
 */

import { useEffect, useState, useCallback, createContext, useContext } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { BottomNav } from "../components/BottomNav";
import { useSport } from "../context/SportContext";
import { MLSection } from "../components/MLPredictionCard";
import { tennisApiService, TennisApiMatch, TennisRankingEntry } from "../services/tennisApiService";
import { useBet } from "../context/BetContext";
import type { BetLeg } from "../types/bet";
import { askLLM } from "../services/llmService";
import { useI18n } from "../i18n";

// ─── Types ────────────────────────────────────────────────────────────────────

interface MatchOption {
  id: string;
  tournament: string;
  surface: string;
  surfaceIcon: string;
  isLive: boolean;
  p1Name: string;
  p1Country: string;
  p1WinPct: number;
  p1Points: number;
  p2Name: string;
  p2Country: string;
  p2WinPct: number;
  p2Points: number;
  timeLabel: string;
}

interface TennisMLProps {
  p1Name: string;
  p2Name: string;
  surface: string;
  propType: string;
  p1WinPct: number;
  p2WinPct: number;
}

interface TennisBetOpt {
  id: string;
  label: string;
  rulePct: number;
  ruleNote: string;
  mlProps?: TennisMLProps;
  slipLeg?: Partial<BetLeg>;
}

interface TennisMktGroup {
  id: string;
  title: string;
  cols: 2 | 3;
  options: TennisBetOpt[];
}

// ─── Fallback matches ─────────────────────────────────────────────────────────

const FALLBACK_MATCHES: MatchOption[] = [
  {
    id: "demo-1", tournament: "Wimbledon", surface: "Grass", surfaceIcon: "🟩",
    isLive: false, timeLabel: "14:00",
    p1Name: "C. Alcaraz", p1Country: "🇪🇸", p1WinPct: 62, p1Points: 8750,
    p2Name: "N. Djokovic", p2Country: "🇷🇸", p2WinPct: 38, p2Points: 7200,
  },
  {
    id: "demo-2", tournament: "Roland Garros", surface: "Clay", surfaceIcon: "🟫",
    isLive: true, timeLabel: "Live",
    p1Name: "I. Swiatek", p1Country: "🇵🇱", p1WinPct: 71, p1Points: 10890,
    p2Name: "A. Sabalenka", p2Country: "🇧🇾", p2WinPct: 29, p2Points: 8730,
  },
];

// ─── Build bet groups for a match ─────────────────────────────────────────────

function buildTennisGroups(match: MatchOption): TennisMktGroup[] {
  const { p1Name, p2Name, surface, p1WinPct, p2WinPct } = match;
  const balance = 1 - Math.abs(p1WinPct - 50) / 50;
  const isClay  = surface === "Clay";
  const isGrass = surface === "Grass";

  const ml = (propType: string): TennisMLProps => ({
    p1Name, p2Name, surface, propType, p1WinPct, p2WinPct,
  });

  const slipBase = (label: string, pct: number, propType: string): Partial<BetLeg> => ({
    marketType: propType as BetLeg["marketType"],
    marketLabel: label,
    subjectType: "player",
    subjectId: p1Name,
    subjectName: p1Name,
    subjectLogo: match.p1Country,
    selection: label,
    selectionShort: label.slice(0, 16),
    probability: pct,
    gameInfo: `${p1Name} vs ${p2Name} · ${match.tournament}`,
    addedAt: new Date().toISOString(),
  });

  return [
    {
      id: "match", title: "Match Winner", cols: 2,
      options: [
        {
          id: "mw-p1", label: `${p1Name} to win`, rulePct: p1WinPct, mlProps: ml("tennis_match_winner"),
          ruleNote: `Win probability based on ranking points (${match.p1Points.toLocaleString()} pts) and surface performance on ${surface}.`,
          slipLeg: slipBase(`${p1Name} to win`, p1WinPct, "tennis_match_winner"),
        },
        {
          id: "mw-p2", label: `${p2Name} to win`, rulePct: p2WinPct, mlProps: ml("tennis_match_winner"),
          ruleNote: `Inverse of ${p1Name}'s probability. ${p2Name} has ${match.p2Points.toLocaleString()} ranking pts.`,
          slipLeg: { ...slipBase(`${p2Name} to win`, p2WinPct, "tennis_match_winner"), subjectId: p2Name, subjectName: p2Name, subjectLogo: match.p2Country },
        },
      ],
    },
    {
      id: "sets", title: "Total Sets", cols: 2,
      options: [
        {
          id: "sets-over", label: "Over 2.5 Sets", mlProps: ml("tennis_total_sets"),
          rulePct: Math.round(35 + balance * 40),
          ruleNote: `Balanced match (balance score ${Math.round(balance * 100)}%) → more sets likely. Clay & grass both favour 3 sets when players are close.`,
          slipLeg: slipBase("Over 2.5 Sets", Math.round(35 + balance * 40), "tennis_total_sets"),
        },
        {
          id: "sets-under", label: "Under 2.5 Sets", mlProps: ml("tennis_total_sets"),
          rulePct: 100 - Math.round(35 + balance * 40),
          ruleNote: `Dominant favourite wins straight sets. Probability increases when gap between players is large.`,
          slipLeg: slipBase("Under 2.5 Sets", 100 - Math.round(35 + balance * 40), "tennis_total_sets"),
        },
      ],
    },
    {
      id: "set1", title: "1st Set Winner", cols: 2,
      options: [
        {
          id: "s1-p1", label: `${p1Name} wins Set 1`, mlProps: ml("tennis_first_set"),
          rulePct: p1WinPct,
          ruleNote: `First-set winner correlates strongly with match winner (~70% of the time).`,
          slipLeg: slipBase(`${p1Name} wins Set 1`, p1WinPct, "tennis_first_set"),
        },
        {
          id: "s1-p2", label: `${p2Name} wins Set 1`, mlProps: ml("tennis_first_set"),
          rulePct: p2WinPct,
          ruleNote: `Underdog takes Set 1 — significant upset signal. ${p2Name} must break early.`,
          slipLeg: { ...slipBase(`${p2Name} wins Set 1`, p2WinPct, "tennis_first_set"), subjectId: p2Name, subjectName: p2Name, subjectLogo: match.p2Country },
        },
      ],
    },
    {
      id: "correct_score", title: "Correct Score", cols: 3,
      options: [
        {
          id: "cs-20", label: "2-0", mlProps: ml("tennis_correct_score"),
          rulePct: Math.round(p1WinPct * 0.52),
          ruleNote: `${p1Name} wins in straight sets. Most likely when they are the dominant favourite (${p1WinPct}%).`,
          slipLeg: slipBase("2-0", Math.round(p1WinPct * 0.52), "tennis_correct_score"),
        },
        {
          id: "cs-21", label: "2-1", mlProps: ml("tennis_correct_score"),
          rulePct: Math.round(p1WinPct * 0.40),
          ruleNote: `${p1Name} wins in three sets — more likely in balanced matchups or when ${p2Name} fights back.`,
          slipLeg: slipBase("2-1", Math.round(p1WinPct * 0.40), "tennis_correct_score"),
        },
        {
          id: "cs-02", label: "0-2", mlProps: ml("tennis_correct_score"),
          rulePct: Math.round(p2WinPct * 0.52),
          ruleNote: `${p2Name} wins in straight sets — upset scenario.`,
          slipLeg: { ...slipBase("0-2", Math.round(p2WinPct * 0.52), "tennis_correct_score"), subjectId: p2Name, subjectName: p2Name, subjectLogo: match.p2Country },
        },
        {
          id: "cs-12", label: "1-2", mlProps: ml("tennis_correct_score"),
          rulePct: Math.round(p2WinPct * 0.40),
          ruleNote: `${p2Name} wins in three sets after dropping the first.`,
          slipLeg: { ...slipBase("1-2", Math.round(p2WinPct * 0.40), "tennis_correct_score"), subjectId: p2Name, subjectName: p2Name, subjectLogo: match.p2Country },
        },
      ],
    },
    {
      id: "handicap", title: "Set Handicap", cols: 2,
      options: [
        {
          id: "hc-p1-minus", label: `${p1Name} -1.5`, mlProps: ml("tennis_set_handicap"),
          rulePct: Math.round(p1WinPct * 0.85),
          ruleNote: `${p1Name} must win 2-0 — covers straight sets. Based on ${p1WinPct}% win probability.`,
          slipLeg: slipBase(`${p1Name} -1.5`, Math.round(p1WinPct * 0.85), "tennis_set_handicap"),
        },
        {
          id: "hc-p2-plus", label: `${p2Name} +1.5`, mlProps: ml("tennis_set_handicap"),
          rulePct: Math.min(90, p2WinPct + 30),
          ruleNote: `${p2Name} covers even losing 0-2 — very high hit rate for underdogs.`,
          slipLeg: { ...slipBase(`${p2Name} +1.5`, Math.min(90, p2WinPct + 30), "tennis_set_handicap"), subjectId: p2Name, subjectName: p2Name, subjectLogo: match.p2Country },
        },
      ],
    },
    {
      id: "tiebreak", title: "Tiebreak", cols: 2,
      options: [
        {
          id: "tb-yes", label: "Tiebreak in match", mlProps: ml("tennis_tiebreak"),
          rulePct: Math.round(25 + balance * 45),
          ruleNote: `Tiebreaks are more likely in balanced matches. Balance score: ${Math.round(balance * 100)}%.`,
          slipLeg: slipBase("Tiebreak in match", Math.round(25 + balance * 45), "tennis_tiebreak"),
        },
        {
          id: "tb-no", label: "No tiebreak", mlProps: ml("tennis_tiebreak"),
          rulePct: 100 - Math.round(25 + balance * 45),
          ruleNote: `No tiebreaks — one player dominates their service games throughout.`,
          slipLeg: slipBase("No tiebreak", 100 - Math.round(25 + balance * 45), "tennis_tiebreak"),
        },
      ],
    },
    {
      id: "total_games", title: "Total Games", cols: 2,
      options: [
        {
          id: "tg-over", label: `Over ${isClay ? "23.5" : "21.5"}`, mlProps: ml("tennis_total_games"),
          rulePct: isClay ? 62 : isGrass ? 38 : 50,
          ruleNote: `${surface} surface: avg ${isClay ? "24.5" : isGrass ? "21.5" : "22.8"} games/match. ${isClay ? "Long clay rallies produce more games." : isGrass ? "Fast grass leads to shorter matches." : "Hard courts favour balanced game counts."}`,
          slipLeg: slipBase(`Over ${isClay ? "23.5" : "21.5"}`, isClay ? 62 : 50, "tennis_total_games"),
        },
        {
          id: "tg-under", label: `Under ${isClay ? "23.5" : "21.5"}`, mlProps: ml("tennis_total_games"),
          rulePct: isClay ? 38 : isGrass ? 62 : 50,
          ruleNote: `Fewer total games — more likely on fast surfaces or when one player dominates.`,
          slipLeg: slipBase(`Under ${isClay ? "23.5" : "21.5"}`, isClay ? 38 : 50, "tennis_total_games"),
        },
      ],
    },
    {
      id: "set1_games", title: "1st Set Games", cols: 2,
      options: [
        {
          id: "s1g-over", label: "Over 9.5 games", mlProps: ml("tennis_first_set_games"),
          rulePct: isClay ? 62 : 45,
          ruleNote: `1st set: avg ${isClay ? "10.8" : "9.6"} games on ${surface}. ${isClay ? "Clay rallies keep sets long." : "Fast surfaces favour shorter sets."}`,
          slipLeg: slipBase("Over 9.5 games", isClay ? 62 : 45, "tennis_first_set_games"),
        },
        {
          id: "s1g-under", label: "Under 9.5 games", mlProps: ml("tennis_first_set_games"),
          rulePct: isClay ? 38 : 55,
          ruleNote: `Under 10 games in Set 1 — more likely when one player has a dominant serve or return game.`,
          slipLeg: slipBase("Under 9.5 games", isClay ? 38 : 55, "tennis_first_set_games"),
        },
      ],
    },
    {
      id: "game_handicap", title: "Game Handicap", cols: 2,
      options: [
        {
          id: "gh-p1-minus", label: `${p1Name} -3.5 games`, mlProps: ml("tennis_game_handicap"),
          rulePct: Math.round(p1WinPct * 0.70),
          ruleNote: `${p1Name} needs to win significantly more games — reserved for dominant favourites.`,
          slipLeg: slipBase(`${p1Name} -3.5 games`, Math.round(p1WinPct * 0.70), "tennis_game_handicap"),
        },
        {
          id: "gh-p2-plus", label: `${p2Name} +3.5 games`, mlProps: ml("tennis_game_handicap"),
          rulePct: Math.min(88, p2WinPct + 35),
          ruleNote: `${p2Name} stays competitive — covers even in a loss if games are close.`,
          slipLeg: { ...slipBase(`${p2Name} +3.5 games`, Math.min(88, p2WinPct + 35), "tennis_game_handicap"), subjectId: p2Name, subjectName: p2Name, subjectLogo: match.p2Country },
        },
      ],
    },
  ];
}

// ─── Context: reveal all options ─────────────────────────────────────────────

const RevealAllCtx = createContext<boolean>(false);

// ─── PredictionSheet (bottom sheet) ──────────────────────────────────────────

function TennisPredictionSheet({
  opt, match, accent, onClose,
}: {
  opt: TennisBetOpt;
  match: MatchOption;
  accent: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [llmText, setLlmText]   = useState("");
  const [llmLoading, setLlmLoading] = useState(false);
  const { addLeg, removeLeg, hasLeg } = useBet();

  const legId = `tennis-pred-${match.id}-${opt.id}`;
  const inSlip = hasLeg(legId);
  const pctColor = opt.rulePct >= 65 ? "#4ade80" : opt.rulePct >= 50 ? accent : opt.rulePct >= 38 ? "#facc15" : "#f87171";

  function handleSlip() {
    if (inSlip) { removeLeg(legId); return; }
    const leg: BetLeg = {
      id: legId,
      marketType: (opt.slipLeg?.marketType ?? "tennis_match_winner") as BetLeg["marketType"],
      marketLabel: opt.slipLeg?.marketLabel ?? opt.label,
      subjectType: "player",
      subjectId: opt.slipLeg?.subjectId ?? match.p1Name,
      subjectName: opt.slipLeg?.subjectName ?? match.p1Name,
      subjectLogo: opt.slipLeg?.subjectLogo ?? match.p1Country,
      selection: opt.label,
      selectionShort: opt.label.slice(0, 16),
      probability: opt.rulePct,
      gameInfo: opt.slipLeg?.gameInfo ?? `${match.p1Name} vs ${match.p2Name} · ${match.tournament}`,
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

        {/* Title + Slip */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <p className="text-white font-bold text-base leading-snug flex-1">{opt.label}</p>
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

        {/* Match context chip */}
        <div className="flex items-center gap-2 text-[10px] text-[#8a9ea6]">
          <span>{match.p1Country} {match.p1Name}</span>
          <span>vs</span>
          <span>{match.p2Country} {match.p2Name}</span>
          <span className="ml-auto">{match.surfaceIcon} {match.surface} · {match.tournament}</span>
        </div>

        {/* ── ML section ── */}
        {opt.mlProps && (
          <MLSection
            type="tennis"
            subjectId={opt.mlProps.p1Name}
            opponentId={opt.mlProps.p2Name}
            propType={opt.mlProps.propType}
            ruleBasedPct={opt.rulePct}
            label={opt.label}
            simple
            meta={{
              p1WinPct: opt.mlProps.p1WinPct,
              p2WinPct: opt.mlProps.p2WinPct,
              surface:  opt.mlProps.surface,
            }}
          />
        )}

        {/* ── Rules ── */}
        <div className="bg-[#0d1519] border border-white/[0.07] rounded-2xl overflow-hidden">
          <div className="flex items-center gap-2.5 px-4 py-3 border-b border-white/[0.05]">
            <div className="w-7 h-7 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-sm flex-shrink-0">📐</div>
            <span className="text-white text-sm font-bold flex-1">{t("pred.rules")}</span>
            <span className="text-xl font-black flex-shrink-0" style={{ color: pctColor }}>{opt.rulePct}%</span>
          </div>
          <div className="px-4 py-3">
            <div className="w-full bg-[#0A0E0C] rounded-full h-2 mb-2.5 overflow-hidden">
              <div className="h-2 rounded-full transition-all duration-700"
                style={{ width: `${opt.rulePct}%`, backgroundColor: pctColor }} />
            </div>
            <p className="text-[#8a9ea6] text-[11px] leading-relaxed">{opt.ruleNote}</p>
          </div>
        </div>

        {/* ── Ask LLM ── */}
        {llmText ? (
          <div className="bg-purple-500/10 border border-purple-500/30 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm">✨</span>
              <span className="text-purple-300 text-xs font-semibold">{t("pred.llmAnalysis")}</span>
            </div>
            <p className="text-[#bfc8cc] text-xs leading-relaxed">{llmText}</p>
          </div>
        ) : (
          <button
            disabled={llmLoading}
            onClick={async () => {
              setLlmLoading(true);
              setLlmText("");
              try {
                const text = await askLLM(
                  `You are a tennis betting analyst. Analyse this bet for the user:\n` +
                  `Match: ${match.p1Name} (${match.p1Country}) vs ${match.p2Name} (${match.p2Country})\n` +
                  `Tournament: ${match.tournament} · Surface: ${match.surface}\n` +
                  `Bet: "${opt.label}"\n` +
                  `Rules-based probability: ${opt.rulePct}%\n` +
                  `Rule note: ${opt.ruleNote}\n\n` +
                  `Provide a concise 3-4 sentence analysis covering: market value, key factors, and a recommendation. Be direct and actionable.`,
                  { systemPrompt: "You are a sharp tennis betting analyst. Be concise, data-driven, and direct. No disclaimers." }
                );
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
            style={{
              background: llmLoading ? "#1B2419" : "linear-gradient(135deg,#7c3aed,#a855f7)",
              color: "#fff",
              border: "1px solid rgba(168,85,247,0.3)",
            }}
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

// ─── BetOption ────────────────────────────────────────────────────────────────

function TennisBetOption({ opt, match, accent }: { opt: TennisBetOpt; match: MatchOption; accent: string }) {
  const { t } = useI18n();
  const revealAll = useContext(RevealAllCtx);
  const [revealed, setRevealed] = useState(false);
  const [sheet, setSheet] = useState(false);
  const isRevealed = revealAll || revealed;
  const pctColor = opt.rulePct >= 65 ? "#4ade80" : opt.rulePct >= 50 ? accent : opt.rulePct >= 38 ? "#facc15" : "#f87171";

  return (
    <>
      <button
        onClick={() => setRevealed(v => !v)}
        className="flex flex-col items-center justify-between p-3 rounded-xl border transition-all active:scale-[0.97] w-full"
        style={{
          minHeight: 64,
          background: isRevealed ? "#131A12" : "#0d1519",
          borderColor: isRevealed ? pctColor + "55" : "rgba(255,255,255,0.08)",
        }}
      >
        <span className="text-white text-[11px] font-medium text-center leading-tight">{opt.label}</span>
        {isRevealed ? (
          <button
            onClick={e => { e.stopPropagation(); setSheet(true); }}
            className="mt-2 px-3 py-0.5 rounded-full text-xs font-bold active:scale-95 transition-transform"
            style={{ background: pctColor + "22", color: pctColor, border: `1px solid ${pctColor}55` }}
          >
            {opt.rulePct}%
          </button>
        ) : (
          <span className="mt-2 text-[#3a5060] text-[9px] font-medium">{t("pred.tap")}</span>
        )}
      </button>
      {sheet && (
        <TennisPredictionSheet opt={opt} match={match} accent={accent} onClose={() => setSheet(false)} />
      )}
    </>
  );
}

// ─── MarketGroup ──────────────────────────────────────────────────────────────

function TennisMarketGroup({ group, match, accent }: { group: TennisMktGroup; match: MatchOption; accent: string }) {
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
        <div className="p-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${group.cols}, 1fr)` }}>
          {group.options.map(opt => (
            <TennisBetOption key={opt.id} opt={opt} match={match} accent={accent} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Reveal-all bar ───────────────────────────────────────────────────────────

function RevealBar({ revealAll, onToggle, accent }: { revealAll: boolean; onToggle: () => void; accent: string }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-between px-1">
      <span className="text-[#4a6070] text-[10px] font-semibold uppercase tracking-wider">{t("pred.markets")}</span>
      <button
        onClick={onToggle}
        className="flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-semibold transition-all active:scale-95"
        style={revealAll
          ? { background: accent + "22", color: accent, border: `1px solid ${accent}44` }
          : { background: "rgba(255,255,255,0.05)", color: "#8a9ea6", border: "1px solid rgba(255,255,255,0.08)" }}
      >
        {revealAll ? t("pred.hideAll") : t("pred.revealAll")}
      </button>
    </div>
  );
}

// ─── Match selector dropdown ──────────────────────────────────────────────────

function MatchSelector({
  matches, selected, onSelect, accent,
}: {
  matches: MatchOption[];
  selected: MatchOption | null;
  onSelect: (m: MatchOption) => void;
  accent: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (matches.length === 0) return (
    <div className="bg-[#131A12] border border-white/20 rounded-2xl px-4 py-3 text-center">
      <p className="text-[#bfc8cc] text-sm">{t("tennis.noMatches")}</p>
    </div>
  );

  return (
    <div>
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full bg-[#131A12] border border-white/20 rounded-2xl px-4 py-3 flex items-center gap-2"
      >
        {selected ? (
          <>
            <span className="text-base">{selected.p1Country}</span>
            <span className="text-white text-sm font-semibold truncate">{selected.p1Name}</span>
            <span className="text-[#4a6068] text-xs flex-shrink-0">vs</span>
            <span className="text-white text-sm font-semibold truncate">{selected.p2Name}</span>
            <span className="text-base">{selected.p2Country}</span>
            {selected.isLive && (
              <span className="text-[10px] text-red-400 flex items-center gap-1 flex-shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse inline-block" />
                {t("home.live")}
              </span>
            )}
          </>
        ) : (
              <span className="text-[#4a6068] text-sm flex-1 text-left">{t("tennis.selectMatch")}</span>
        )}
        <span className="text-[#3a5060] text-xs ml-auto">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="mt-2 bg-[#0A0E0C] border border-white/10 rounded-2xl overflow-hidden">
          {matches.map((m) => (
            <button
              key={m.id}
              onClick={() => { onSelect(m); setOpen(false); }}
              className="w-full flex items-center gap-2 px-4 py-3 hover:bg-white/5 transition-all text-left border-b border-white/[0.04] last:border-0"
            >
              <span className="text-base">{m.p1Country}</span>
              <span className="text-white text-xs font-medium truncate">{m.p1Name}</span>
              <span className="text-[#4a6068] text-[10px] flex-shrink-0">vs</span>
              <span className="text-white text-xs font-medium truncate">{m.p2Name}</span>
              {m.isLive && <span className="text-[10px] text-red-400 ml-auto flex-shrink-0">● Live</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function TennisPredictionsPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { theme } = useSport();
  const { t } = useI18n();
  const accent = "#3bc47a";
  const [matches, setMatches] = useState<MatchOption[]>([]);
  const [selected, setSelected] = useState<MatchOption | null>(null);
  const [revealAll, setRevealAll] = useState(false);
  const [loading, setLoading] = useState(true);

  const urlId = searchParams.get("id");

  useEffect(() => {
    async function load() {
      try {
        const [liveRaw, fixturesRaw, rankingsAtp, rankingsWta] = await Promise.all([
          tennisApiService.getLiveMatches().catch(() => [] as TennisApiMatch[]),
          tennisApiService.getFixtures().catch(() => [] as TennisApiMatch[]),
          tennisApiService.getRankings("ATP").catch(() => [] as TennisRankingEntry[]),
          tennisApiService.getRankings("WTA").catch(() => [] as TennisRankingEntry[]),
        ]);
        const rankings = [...rankingsAtp, ...rankingsWta];
        const toOption = (m: TennisApiMatch): MatchOption => {
          const r1 = rankings.find((r) => r.player.id === m.player1.id);
          const r2 = rankings.find((r) => r.player.id === m.player2.id);
          const pts1 = r1?.points ?? 3000;
          const pts2 = r2?.points ?? 3000;
          const p1WinPct = Math.round(pts1 / (pts1 + pts2) * 100);
          return {
            id: m.id, tournament: m.tournament, surface: m.surface, surfaceIcon: m.surfaceIcon,
            isLive: m.isLive,
            p1Name: m.player1.name, p1Country: m.player1.country, p1WinPct, p1Points: pts1,
            p2Name: m.player2.name, p2Country: m.player2.country, p2WinPct: 100 - p1WinPct, p2Points: pts2,
            timeLabel: m.isLive ? "LIVE" : (m.scheduledIso ? new Date(m.scheduledIso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "TBD"),
          };
        };
        const all = [...liveRaw, ...fixturesRaw].map(toOption);
        setMatches(all);
        if (urlId) {
          const found = all.find((m) => m.id === urlId) ?? (all.length > 0 ? all[0] : null);
          setSelected(found);
        } else if (all.length > 0) {
          setSelected(all[0]);
        }
      } catch {
        setMatches([]);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const groups = selected ? buildTennisGroups(selected) : [];

  return (
    <RevealAllCtx.Provider value={revealAll}>
      <div className="flex flex-col min-h-screen pb-24" style={{ background: "#0A0E0C" }}>
        <div className="sticky top-0 z-40 px-4 pt-12 pb-3"
          style={{ background: "rgba(10,14,12,0.92)", backdropFilter: "blur(16px)", borderBottom: "1px solid #283323" }}>
          <div className="flex items-center gap-3 mb-3">
            <button onClick={() => navigate(-1)} className="text-[#3a5060] text-lg">←</button>
            <h1 className="text-white text-base font-bold flex-1">{t("tennis.title")}</h1>
          </div>
          <MatchSelector matches={matches} selected={selected} onSelect={setSelected} accent={accent} />
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {loading ? (
            <div className="flex flex-col gap-3">
              {[1, 2, 3].map((i) => <div key={i} className="h-20 bg-white/5 rounded-2xl animate-pulse" />)}
            </div>
          ) : selected ? (
            <div className="flex flex-col gap-3">
              <div className="bg-[#131A12] border border-white/10 rounded-2xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ color: accent, backgroundColor: `${accent}1a` }}>
                    {selected.surfaceIcon} {selected.surface}
                  </span>
                  <span className="text-[#4a6068] text-[10px]">{selected.tournament}</span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex-1 text-right">
                    <span className="text-base">{selected.p1Country}</span>
                    <p className="text-white text-sm font-bold">{selected.p1Name}</p>
                    <p className="text-[10px] font-bold" style={{ color: accent }}>{selected.p1WinPct}%</p>
                  </div>
                  <span className="text-[#4a6068] text-xs">vs</span>
                  <div className="flex-1 text-left">
                    <span className="text-base">{selected.p2Country}</span>
                    <p className="text-white text-sm font-bold">{selected.p2Name}</p>
                    <p className="text-[#bfc8cc] text-[10px] font-bold">{selected.p2WinPct}%</p>
                  </div>
                </div>
              </div>

              <RevealBar revealAll={revealAll} onToggle={() => setRevealAll((v) => !v)} accent={accent} />

              {groups.map((g) => (
                <TennisMarketGroup key={g.title} group={g} match={selected} accent={accent} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-20">
              <p className="text-[#4a6068] text-sm">{t("tennis.noMatchesAvail")}</p>
            </div>
          )}
        </div>

        <BottomNav />
      </div>
    </RevealAllCtx.Provider>
  );
}
