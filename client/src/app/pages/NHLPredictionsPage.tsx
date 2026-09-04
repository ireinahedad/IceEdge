/**
 * NHLPredictionsPage.tsx
 * Page dédiée aux prédictions NHL — tous les types de bets bet365,
 * prédictions par règles · section ML (à venir) · bouton Ask LLM.
 */

import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router";
import { BottomNav } from "../components/BottomNav";
import { useSport } from "../context/SportContext";
import { useNHLData } from "../hooks/useNHLData";
import { nhlApiService } from "../services/nhlApiService";
import { nhlLogoUrl } from "../data/teamEmoji";
import { pctColor } from "../data/pctScale";
import {
  MARKET_DEFINITIONS,
  CATEGORY_LABELS,
  CATEGORY_ICONS,
  MarketDefinition,
} from "../data/betMarkets";
import type { BetMarketType } from "../types/bet";
import { useI18n } from "../i18n";
import "../components/rink-theme.css";
// MLSection used only in PredictionSheet (per-bet click), not here

type TFn = (key: string, params?: Record<string, string | number>) => string;

// ─── Types locaux ──────────────────────────────────────────────────────────────

interface GameOption {
  id: string;
  label: string;
  homeAbbr: string;
  awayAbbr: string;
  homeLogo: string;
  awayLogo: string;
  time: string;
  homeWinPct: number;
  awayWinPct: number;
  homeGoalsPerGame: number;
  awayGoalsPerGame: number;
}

interface BetPrediction {
  marketType: BetMarketType;
  rulePct: number;       // règle-based
  ruleNote: string;
  mlPct: number | null;  // ML (null = pas encore disponible)
  llmResponse: string | null;
  llmLoading: boolean;
}

// ─── Calcul des prédictions par règles ────────────────────────────────────────

function computeRulePrediction(
  market: MarketDefinition,
  game: GameOption,
  t: TFn
): { pct: number; note: string } {
  const { homeWinPct: hw, awayWinPct: aw, homeGoalsPerGame: hgf, awayGoalsPerGame: agf } = game;
  const avgGoals = hgf + agf;

  switch (market.type) {
    case "moneyline":
      return { pct: hw, note: t("nhl.note.moneyline", { abbr: game.homeAbbr }) };

    case "puck_line":
      // prob de gagner par 2+ buts ≈ winPct × 0.55
      return { pct: Math.round(hw * 0.55), note: t("nhl.note.puck_line", { abbr: game.homeAbbr }) };

    case "total_goals": {
      const line = 5.5;
      const overPct = Math.min(80, Math.max(20, Math.round(50 + (avgGoals - line) * 25)));
      return { pct: overPct, note: t("nhl.note.total_goals", { goals: avgGoals.toFixed(1), line }) };
    }

    case "regulation_result":
      return { pct: Math.round(hw * 0.85), note: t("nhl.note.regulation") };

    case "game_to_ot":
      return { pct: Math.round((100 - Math.abs(hw - aw)) * 0.35), note: t("nhl.note.game_to_ot") };

    case "both_teams_score":
      return {
        pct: Math.min(85, Math.round((hgf * agf) / (hgf * agf + 0.8) * 100)),
        note: t("nhl.note.btts", { h: hgf.toFixed(1), a: agf.toFixed(1) }),
      };

    case "winning_margin":
      return { pct: Math.round(hw * 0.4), note: t("nhl.note.winning_margin") };

    case "alt_puck_line":
      return { pct: Math.round(hw * 0.38), note: t("nhl.note.alt_puck_line") };

    case "ot_winner":
      return { pct: Math.round(hw * 0.45 + 5), note: t("nhl.note.ot_winner") };

    case "period1_winner":
      return { pct: Math.round(hw * 0.75), note: t("nhl.note.p1_winner") };

    case "period2_winner":
      return { pct: Math.round(hw * 0.78), note: t("nhl.note.p2_winner") };

    case "period3_winner":
      return { pct: Math.round(hw * 0.80), note: t("nhl.note.p3_winner") };

    case "highest_scoring_period":
      return { pct: 38, note: t("nhl.note.high_period") };

    case "period1_total_goals": {
      const p1avg = avgGoals / 3;
      return { pct: Math.round(50 + (p1avg - 1.5) * 30), note: t("nhl.note.p1_total", { n: p1avg.toFixed(1) }) };
    }
    case "period2_total_goals": {
      const p2avg = avgGoals / 3 * 1.1;
      return { pct: Math.round(50 + (p2avg - 1.5) * 30), note: t("nhl.note.p2_total", { n: p2avg.toFixed(1) }) };
    }
    case "period3_total_goals": {
      const p3avg = avgGoals / 3 * 0.95;
      return { pct: Math.round(50 + (p3avg - 1.5) * 30), note: t("nhl.note.p3_total", { n: p3avg.toFixed(1) }) };
    }

    case "first_team_score":
      return { pct: hw, note: t("nhl.note.first_score") };

    case "last_team_score":
      return { pct: Math.round(hw * 0.85 + 7), note: t("nhl.note.last_score") };

    case "team_total_goals": {
      const line = 2.5;
      return { pct: Math.round(50 + (hgf - line) * 30), note: t("nhl.note.team_total", { abbr: game.homeAbbr, n: hgf.toFixed(1) }) };
    }

    case "team_pp_goals":
      return { pct: 42, note: t("nhl.note.team_pp") };

    case "clean_sheet":
      return { pct: Math.round((100 - agf * 25)), note: t("nhl.note.clean_sheet", { abbr: game.homeAbbr }) };

    case "team_score_every_period":
      return { pct: Math.round(hgf * 12), note: t("nhl.note.every_period") };

    case "total_penalties":
      return { pct: 52, note: t("nhl.note.total_pim") };

    case "anytime_goal":
      return { pct: 30, note: t("nhl.note.anytime_goal") };

    case "first_goal_scorer":
      return { pct: 12, note: t("nhl.note.first_scorer") };

    case "last_goal_scorer":
      return { pct: 10, note: t("nhl.note.last_scorer") };

    case "shots_ou":
      return { pct: 55, note: t("nhl.note.shots") };

    case "assists_ou":
      return { pct: 48, note: t("nhl.note.assists") };

    case "points_ou":
      return { pct: 52, note: t("nhl.note.points") };

    case "pp_point":
      return { pct: 25, note: t("nhl.note.pp_point") };

    case "goalie_saves_ou":
      return { pct: 54, note: t("nhl.note.saves") };

    case "penalty_minutes_ou":
      return { pct: 45, note: t("nhl.note.pim_player") };

    case "blocked_shots_ou":
      return { pct: 50, note: t("nhl.note.blocks") };

    case "time_on_ice_ou":
      return { pct: 53, note: t("nhl.note.toi") };

    case "faceoff_wins_ou":
      return { pct: 51, note: t("nhl.note.faceoffs") };

    case "hits_ou":
      return { pct: 48, note: t("nhl.note.hits") };

    default:
      return { pct: 50, note: t("nhl.note.default") };
  }
}

// ─── Jauge circulaire compacte ────────────────────────────────────────────────

function MiniGauge({ pct, color }: { pct: number; color: string }) {
  const size = 52;
  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - pct / 100);
  return (
    <div className="relative flex items-center justify-center flex-shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#1e2d32" strokeWidth={7} />
        <circle
          cx={size / 2} cy={size / 2} r={radius} fill="none"
          stroke={color} strokeWidth={7} strokeLinecap="round"
          strokeDasharray={circumference} strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.6s ease-out" }}
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-[11px] font-black" style={{ color }}>{pct}%</span>
      </div>
    </div>
  );
}

// ─── Carte de prédiction pour un type de bet ──────────────────────────────────

function BetPredictionCard({
  market,
  prediction,
  accent,
  onAskLLM,
  homeAbbr,
  awayAbbr,
}: {
  market: MarketDefinition;
  prediction: BetPrediction;
  accent: string;
  onAskLLM: () => void;
  homeAbbr: string;
  awayAbbr: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useI18n();
  const ruleColor = pctColor(prediction.rulePct);

  return (
    <div className="bg-[#131A12] border border-white/[0.08] rounded-2xl overflow-hidden">
      {/* En-tête cliquable */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-4 py-3 flex items-center gap-3 text-left"
      >
        <MiniGauge pct={prediction.rulePct} color={ruleColor} />
        <div className="flex-1 min-w-0">
          <p className="text-white text-sm font-semibold leading-tight">{market.label}</p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <p className="text-[#8a9ea6] text-[11px] leading-snug truncate">{market.description}</p>
            <span className="flex-shrink-0 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-[#a78bfa]/10 text-[#a78bfa] border border-[#a78bfa]/20">🤖 ML</span>
          </div>
        </div>
        <span className="text-[#4a6068] text-xs flex-shrink-0">{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 flex flex-col gap-3 border-t border-white/[0.05] pt-3">
          {/* ── Règles statistiques — avec explication ── */}
          <div className="bg-[#0d1518] rounded-xl p-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-base">📐</span>
              <span className="text-white text-xs font-semibold">{t("nhl.ruleStats")}</span>
              <span className="ml-auto text-xs font-black" style={{ color: ruleColor }}>{prediction.rulePct}%</span>
            </div>
            <div className="w-full bg-[#0A0E0C] rounded-full h-2 mb-2">
              <div className="h-2 rounded-full transition-all duration-700"
                style={{ width: `${prediction.rulePct}%`, backgroundColor: ruleColor }} />
            </div>
            <p className="text-[#8a9ea6] text-[11px] leading-snug">{prediction.ruleNote}</p>
          </div>

          {/* ── Ask LLM ── */}
          <div>
            {prediction.llmResponse ? (
              <div className="bg-purple-900/20 border border-purple-500/25 rounded-xl p-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-base">✨</span>
                  <span className="text-purple-300 text-xs font-semibold">{t("nhl.llmOpinion")}</span>
                </div>
                <p className="text-[#d8c8f0] text-xs leading-relaxed">{prediction.llmResponse}</p>
              </div>
            ) : (
              <button
                onClick={onAskLLM}
                disabled={prediction.llmLoading}
                className="w-full py-2.5 rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition-all active:scale-[0.98]"
                style={{
                  background: prediction.llmLoading
                    ? "rgba(139,92,246,0.1)"
                    : "linear-gradient(135deg, rgba(139,92,246,0.2), rgba(59,130,246,0.2))",
                  border: "1px solid rgba(139,92,246,0.3)",
                  color: "#c4b5fd",
                }}
              >
                {prediction.llmLoading ? (
                  <>
                    <span className="w-3 h-3 rounded-full border-2 border-purple-400/40 border-t-purple-400 animate-spin" />
                    {t("nhl.analyzing")}
                  </>
                ) : (
                  <>{t("nhl.askLLM")}</>
                )}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sélecteur de match ───────────────────────────────────────────────────────

function GamePills({
  games,
  selected,
  onSelect,
  accent,
}: {
  games: GameOption[];
  selected: GameOption | null;
  onSelect: (g: GameOption) => void;
  accent: string;
}) {
  if (games.length === 0) return null;
  return (
    <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-0.5">
      {games.map((g) => {
        const isActive = selected?.id === g.id;
        return (
          <button
            key={g.id}
            onClick={() => onSelect(g)}
            className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all border"
            style={isActive
              ? { backgroundColor: accent + "22", borderColor: accent, color: "#fff" }
              : { backgroundColor: "#131A12", borderColor: "rgba(255,255,255,0.1)", color: "#8a9ea6" }}
          >
            <img src={g.homeLogo} alt={g.homeAbbr} className="w-4 h-4 object-contain" />
            <span className="font-bold">{g.homeAbbr}</span>
            <span className="opacity-50">vs</span>
            <span className="font-bold">{g.awayAbbr}</span>
            <img src={g.awayLogo} alt={g.awayAbbr} className="w-4 h-4 object-contain" />
          </button>
        );
      })}
    </div>
  );
}

// ─── LLM Ask (mock) ───────────────────────────────────────────────────────────

async function askLLMForMarket(
  market: MarketDefinition,
  game: GameOption,
  rulePct: number,
  t: TFn
): Promise<string> {
  // Placeholder — remplacer par un vrai appel API LLM
  await new Promise((r) => setTimeout(r, 1200));
  return t("nhl.llm.body", {
    market: market.label,
    home: game.homeAbbr,
    away: game.awayAbbr,
    pct: rulePct,
    value: rulePct >= 55 ? t("nhl.llm.goodValue") : t("nhl.llm.modValue"),
    conf: rulePct >= 60 ? t("nhl.llm.high") : t("nhl.llm.medium"),
  });
}

// ─── Page principale ──────────────────────────────────────────────────────────

const NHL_CATEGORIES: MarketDefinition["category"][] = ["match", "period", "team", "player", "special"];

export function NHLPredictionsPage() {
  const navigate = useNavigate();
  const { theme } = useSport();
  const { t, lang } = useI18n();
  const accent = theme.accent;
  const { games, getTeamById } = useNHLData();

  const [gameOptions, setGameOptions] = useState<GameOption[]>([]);
  const [selectedGame, setSelectedGame] = useState<GameOption | null>(null);
  const [predictions, setPredictions] = useState<Record<string, BetPrediction>>({});
  const [loadingGames, setLoadingGames] = useState(true);
  const [activeCategory, setActiveCategory] = useState<MarketDefinition["category"]>("match");

  // ── Charger les stats des équipes pour calculer les règles ─────────────────
  useEffect(() => {
    if (games.length === 0) return;
    setLoadingGames(true);

    Promise.all(
      games.slice(0, 8).map(async (g) => {
        const t1 = getTeamById(g.team1Id);
        const t2 = getTeamById(g.team2Id);
        if (!t1 || !t2) return null;

        let hgf = 3.0, agf = 3.0;
        try {
          const [s1, s2] = await Promise.all([
            nhlApiService.getTeamStats(t1.id),
            nhlApiService.getTeamStats(t2.id),
          ]);
          hgf = s1.goalsForPerGame || 3.0;
          agf = s2.goalsForPerGame || 3.0;
        } catch { /* use defaults */ }

        // Sans probabilité du backend, le match n'est pas proposé : tout ce que
        // cette page calcule ensuite (`computeRulePrediction`) en dérive, donc un
        // repli fabriqué ici contaminerait chaque marché affiché. Avant le
        // 2026-08-29 la ligne était `g.winPct1 || <50 + (winPct saison − 50)×0,8>`.
        const hw = g.winPct1;
        if (hw == null) {
          console.warn("[NHLPredictions] pas de probabilité pour", g.id, "— match masqué");
          return null;
        }
        const aw = 100 - hw;

        return {
          id: g.id,
          label: `${t1.abbr} vs ${t2.abbr}`,
          homeAbbr: t1.abbr,
          awayAbbr: t2.abbr,
          homeLogo: t1.logo || nhlLogoUrl(t1.abbr),
          awayLogo: t2.logo || nhlLogoUrl(t2.abbr),
          time: g.time || t("nhl.today"),
          homeWinPct: hw,
          awayWinPct: aw,
          homeGoalsPerGame: hgf,
          awayGoalsPerGame: agf,
        } as GameOption;
      })
    ).then((opts) => {
      const valid = opts.filter((o): o is GameOption => o !== null);
      setGameOptions(valid);
      if (valid.length > 0) setSelectedGame(valid[0]);
      setLoadingGames(false);
    });
  }, [games, getTeamById, lang]);

  // ── Calculer les prédictions quand le match change ─────────────────────────
  useEffect(() => {
    if (!selectedGame) return;
    const preds: Record<string, BetPrediction> = {};
    for (const market of MARKET_DEFINITIONS) {
      const { pct, note } = computeRulePrediction(market, selectedGame, t);
      preds[market.type] = {
        marketType: market.type,
        rulePct: Math.min(92, Math.max(8, pct)),
        ruleNote: note,
        mlPct: null,
        llmResponse: null,
        llmLoading: false,
      };
    }
    setPredictions(preds);
  }, [selectedGame, lang]);

  // ── Ask LLM handler ────────────────────────────────────────────────────────
  const handleAskLLM = useCallback(async (market: MarketDefinition) => {
    if (!selectedGame) return;
    setPredictions((prev) => ({
      ...prev,
      [market.type]: { ...prev[market.type], llmLoading: true },
    }));
    try {
      const response = await askLLMForMarket(market, selectedGame, predictions[market.type]?.rulePct ?? 50, t);
      setPredictions((prev) => ({
        ...prev,
        [market.type]: { ...prev[market.type], llmLoading: false, llmResponse: response },
      }));
    } catch {
      setPredictions((prev) => ({
        ...prev,
        [market.type]: { ...prev[market.type], llmLoading: false },
      }));
    }
  }, [selectedGame, predictions]);

  const categoryMarkets = MARKET_DEFINITIONS.filter((m) => m.category === activeCategory);

  return (
    <div className="flex flex-col min-h-screen bg-transparent text-white max-w-[430px] md:max-w-5xl mx-auto w-full">
      {/* ── Header ── */}
      <header className="bg-[#0A0E0C]/80 backdrop-blur-md sticky top-0 z-40" style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}>
        <div className="rink-boards" aria-hidden />
        <div className="px-4 pt-3 pb-3 flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="w-9 h-9 rounded-xl bg-[#131A12] border border-white/20 flex items-center justify-center flex-shrink-0"
            style={{ color: accent }}
          >
            ←
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-white font-bold text-base leading-tight uppercase" style={{ fontFamily: "'Oswald', 'Arial Narrow', sans-serif" }}>{t("nhl.title")}</h1>
            <p className="text-[#8a9ea6] text-[11px]">{t("nhl.subtitle")}</p>
          </div>
        </div>

        {/* Sélecteur de match — pills horizontaux */}
        <div className="px-4 pb-3">
        {loadingGames ? (
          <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-0.5">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex-shrink-0 h-8 w-32 bg-[#131A12] rounded-full animate-pulse" />
            ))}
          </div>
        ) : (
          <GamePills games={gameOptions} selected={selectedGame} onSelect={setSelectedGame} accent={accent} />
        )}

        {/* Tabs catégories */}
        <div className="flex gap-1.5 overflow-x-auto scrollbar-hide pb-0.5 mt-3">
          {NHL_CATEGORIES.map((cat) => {
            const count = MARKET_DEFINITIONS.filter((m) => m.category === cat).length;
            return (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className="flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-all flex items-center gap-1"
                style={activeCategory === cat
                  ? { backgroundColor: accent, color: "#0f1416", fontWeight: 700 }
                  : { backgroundColor: "#1B2419", color: "#bfc8cc" }}
              >
                {CATEGORY_ICONS[cat]} {CATEGORY_LABELS[cat]}
                <span className="text-[9px] opacity-70">({count})</span>
              </button>
            );
          })}
        </div>
        </div>
      </header>

      {/* ── Contenu ── */}
      <div className="flex-1 px-4 pb-28 pt-4 overflow-y-auto">
        {/* Skeleton while games load */}
        {loadingGames && (
          <div className="flex flex-col gap-3">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="bg-[#131A12] rounded-2xl h-16 animate-pulse" />
            ))}
          </div>
        )}

        {!loadingGames && selectedGame && (
          <>
            {/* Résumé du match */}
            <div className="bg-[#131A12] border border-white/20 rounded-2xl p-4 mb-4 flex items-center">
              <div className="flex-1 flex flex-col items-center gap-1">
                <img src={selectedGame.homeLogo} alt={selectedGame.homeAbbr} className="w-12 h-12 object-contain" />
                <span className="text-white text-sm font-bold">{selectedGame.homeAbbr}</span>
                <span className="text-xs font-bold" style={{ color: accent }}>{selectedGame.homeWinPct}%</span>
              </div>
              <div className="flex flex-col items-center gap-1 px-4">
                <span className="text-[#4a6068] text-xs">{selectedGame.time}</span>
                <span className="text-white font-bold">VS</span>
              </div>
              <div className="flex-1 flex flex-col items-center gap-1">
                <img src={selectedGame.awayLogo} alt={selectedGame.awayAbbr} className="w-12 h-12 object-contain" />
                <span className="text-white text-sm font-bold">{selectedGame.awayAbbr}</span>
                <span className="text-[#8a9ea6] text-xs">{selectedGame.awayWinPct}%</span>
              </div>
            </div>

            {/* Liste des marchés */}
            <div className="flex flex-col gap-2">
              <p className="text-[#bfc8cc] text-xs uppercase tracking-widest mb-1">
                {CATEGORY_ICONS[activeCategory]} {CATEGORY_LABELS[activeCategory]} — {t("nhl.marketsCount", { n: categoryMarkets.length })}
              </p>
              {categoryMarkets.map((market) => {
                const pred = predictions[market.type];
                if (!pred) return null;
                return (
                  <BetPredictionCard
                    key={market.type}
                    market={market}
                    prediction={pred}
                    accent={accent}
                    onAskLLM={() => handleAskLLM(market)}
                    homeAbbr={selectedGame.homeAbbr}
                    awayAbbr={selectedGame.awayAbbr}
                  />
                );
              })}
            </div>
          </>
        )}
      </div>

      <BottomNav />
    </div>
  );
}
