/**
 * NHLPredictionsPage.tsx
 * Page dédiée aux prédictions NHL — tous les types de bets bet365,
 * prédictions par règles · section ML (à venir) · bouton Ask LLM.
 */

import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router";
import { BottomNav } from "./BottomNav";
import { useSport } from "../context/SportContext";
import { useNHLData } from "../hooks/useNHLData";
import { nhlApiService } from "../services/nhlApiService";
import { teamEmoji } from "../data/teamEmoji";
import {
  MARKET_DEFINITIONS,
  CATEGORY_LABELS,
  CATEGORY_ICONS,
  MarketDefinition,
} from "../data/betMarkets";
import type { BetMarketType } from "../types/bet";
// MLSection used only in PredictionSheet (per-bet click), not here

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
  game: GameOption
): { pct: number; note: string } {
  const { homeWinPct: hw, awayWinPct: aw, homeGoalsPerGame: hgf, awayGoalsPerGame: agf } = game;
  const avgGoals = hgf + agf;

  switch (market.type) {
    case "moneyline":
      return { pct: hw, note: `${game.homeAbbr} domicile · win% historique vs adversaire` };

    case "puck_line":
      // prob de gagner par 2+ buts ≈ winPct × 0.55
      return { pct: Math.round(hw * 0.55), note: `${game.homeAbbr} gagne par ≥2 buts` };

    case "total_goals": {
      const line = 5.5;
      const overPct = Math.min(80, Math.max(20, Math.round(50 + (avgGoals - line) * 25)));
      return { pct: overPct, note: `Moy. ${avgGoals.toFixed(1)} buts/match · ligne ${line}` };
    }

    case "regulation_result":
      return { pct: Math.round(hw * 0.85), note: `Victoire en 60 min (sans OT/SO)` };

    case "game_to_ot":
      return { pct: Math.round((100 - Math.abs(hw - aw)) * 0.35), note: `Matchs serrés → OT` };

    case "both_teams_score":
      return {
        pct: Math.min(85, Math.round((hgf * agf) / (hgf * agf + 0.8) * 100)),
        note: `GF/G domicile ${hgf.toFixed(1)} · ext ${agf.toFixed(1)}`,
      };

    case "winning_margin":
      return { pct: Math.round(hw * 0.4), note: `Marge de victoire exacte` };

    case "double_chance":
      return { pct: Math.round(hw * 1.3 + 5), note: `Double chance — protège contre nul` };

    case "alt_puck_line":
      return { pct: Math.round(hw * 0.38), note: `Ligne alternative ±2.5 buts` };

    case "ot_winner":
      return { pct: Math.round(hw * 0.45 + 5), note: `Favori en OT si prolongation` };

    case "period1_winner":
      return { pct: Math.round(hw * 0.75), note: `Win% en 1ère période` };

    case "period2_winner":
      return { pct: Math.round(hw * 0.78), note: `Win% en 2e période` };

    case "period3_winner":
      return { pct: Math.round(hw * 0.80), note: `Win% en 3e période` };

    case "highest_scoring_period":
      return { pct: 38, note: `2e période souvent la + productive (NHL avg)` };

    case "period1_total_goals": {
      const p1avg = avgGoals / 3;
      return { pct: Math.round(50 + (p1avg - 1.5) * 30), note: `Moy. ${p1avg.toFixed(1)} buts/P1` };
    }
    case "period2_total_goals": {
      const p2avg = avgGoals / 3 * 1.1;
      return { pct: Math.round(50 + (p2avg - 1.5) * 30), note: `Moy. ${p2avg.toFixed(1)} buts/P2` };
    }
    case "period3_total_goals": {
      const p3avg = avgGoals / 3 * 0.95;
      return { pct: Math.round(50 + (p3avg - 1.5) * 30), note: `Moy. ${p3avg.toFixed(1)} buts/P3` };
    }

    case "first_team_score":
      return { pct: hw, note: `Premier à marquer = avantage domicile` };

    case "last_team_score":
      return { pct: Math.round(hw * 0.85 + 7), note: `Dernier but → souvent l'équipe qui mène` };

    case "team_total_goals": {
      const line = 2.5;
      return { pct: Math.round(50 + (hgf - line) * 30), note: `${game.homeAbbr} avg ${hgf.toFixed(1)} buts/match` };
    }

    case "team_pp_goals":
      return { pct: 42, note: `Power play goals · moyenne ~0.8/match` };

    case "clean_sheet":
      return { pct: Math.round((100 - agf * 25)), note: `${game.homeAbbr} concède 0 but` };

    case "team_score_every_period":
      return { pct: Math.round(hgf * 12), note: `Marquer dans les 3 périodes` };

    case "total_penalties":
      return { pct: 52, note: `Total PIM · ligne 12.5 min · NHL avg` };

    case "anytime_goal":
      return { pct: 30, note: `Buteur en tout temps — top scorer ~30%` };

    case "first_goal_scorer":
      return { pct: 12, note: `1er buteur — top scorer ~12% de chance` };

    case "last_goal_scorer":
      return { pct: 10, note: `Dernier buteur — probabilité similaire` };

    case "shots_ou":
      return { pct: 55, note: `Tirs sur but · moyenne attaquant élite ~3/match` };

    case "assists_ou":
      return { pct: 48, note: `Passes décisives · ligne 0.5` };

    case "points_ou":
      return { pct: 52, note: `Points (B+P) · top players ~0.8 pts/match` };

    case "pp_point":
      return { pct: 25, note: `Point en avantage numérique` };

    case "goalie_saves_ou":
      return { pct: 54, note: `Arrêts · moyenne gardien élite ~28/match` };

    case "penalty_minutes_ou":
      return { pct: 45, note: `Minutes de pénalité joueur · ligne 0.5` };

    case "blocked_shots_ou":
      return { pct: 50, note: `Tirs bloqués · défenseur avg ~1.8/match` };

    case "time_on_ice_ou":
      return { pct: 53, note: `Temps sur glace · ligne 18.5 min` };

    case "faceoff_wins_ou":
      return { pct: 51, note: `Mises en jeu gagnées · ligne 9.5` };

    case "hits_ou":
      return { pct: 48, note: `Mises en échec · ligne 1.5` };

    default:
      return { pct: 50, note: "Prédiction basée sur les données saisonnières" };
  }
}

// ─── Couleur selon % ──────────────────────────────────────────────────────────

function pctColor(pct: number): string {
  if (pct >= 65) return "#4ade80";
  if (pct >= 50) return "#86d1ea";
  if (pct >= 38) return "#facc15";
  return "#f87171";
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
              <span className="text-white text-xs font-semibold">Règles statistiques</span>
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
                  <span className="text-purple-300 text-xs font-semibold">Avis du LLM</span>
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
                    Analyse en cours...
                  </>
                ) : (
                  <>✨ Ask LLM</>
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
            <span>{g.homeLogo}</span>
            <span className="font-bold">{g.homeAbbr}</span>
            <span className="opacity-50">vs</span>
            <span className="font-bold">{g.awayAbbr}</span>
            <span>{g.awayLogo}</span>
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
  rulePct: number
): Promise<string> {
  // Placeholder — remplacer par un vrai appel API LLM
  await new Promise((r) => setTimeout(r, 1200));
  return (
    `Analyse ${market.label} pour ${game.homeAbbr} vs ${game.awayAbbr} : ` +
    `les règles statistiques donnent ${rulePct}%. ` +
    `En tenant compte du contexte (domicile, forme récente, confrontations directes), ` +
    `ce marché présente ${rulePct >= 55 ? "une bonne valeur" : "une valeur modérée"}. ` +
    `Confidence: ${rulePct >= 60 ? "élevée" : "moyenne"}. ` +
    `[Connectez votre modèle LLM via /api/chat pour une analyse plus détaillée]`
  );
}

// ─── Page principale ──────────────────────────────────────────────────────────

const NHL_CATEGORIES: MarketDefinition["category"][] = ["match", "period", "team", "player", "special"];

export function NHLPredictionsPage() {
  const navigate = useNavigate();
  const { theme } = useSport();
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

        const hw = g.winPct1 || Math.min(75, Math.max(25, Math.round(50 + (t1.winPct - 50) * 0.8)));
        const aw = 100 - hw;

        return {
          id: g.id,
          label: `${t1.abbr} vs ${t2.abbr}`,
          homeAbbr: t1.abbr,
          awayAbbr: t2.abbr,
          homeLogo: t1.logo || teamEmoji(t1.abbr),
          awayLogo: t2.logo || teamEmoji(t2.abbr),
          time: g.time || "Aujourd'hui",
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
  }, [games, getTeamById]);

  // ── Calculer les prédictions quand le match change ─────────────────────────
  useEffect(() => {
    if (!selectedGame) return;
    const preds: Record<string, BetPrediction> = {};
    for (const market of MARKET_DEFINITIONS) {
      const { pct, note } = computeRulePrediction(market, selectedGame);
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
  }, [selectedGame]);

  // ── Ask LLM handler ────────────────────────────────────────────────────────
  const handleAskLLM = useCallback(async (market: MarketDefinition) => {
    if (!selectedGame) return;
    setPredictions((prev) => ({
      ...prev,
      [market.type]: { ...prev[market.type], llmLoading: true },
    }));
    try {
      const response = await askLLMForMarket(market, selectedGame, predictions[market.type]?.rulePct ?? 50);
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
    <div className="flex flex-col min-h-screen bg-transparent text-white max-w-[430px] mx-auto">
      {/* ── Header ── */}
      <header className="px-4 pt-12 pb-3 bg-[#0A0E0C]/80 backdrop-blur-md sticky top-0 z-40 border-b border-white/[0.04]">
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={() => navigate(-1)}
            className="w-9 h-9 rounded-xl bg-[#131A12] border border-white/20 flex items-center justify-center flex-shrink-0"
            style={{ color: accent }}
          >
            ←
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-white font-bold text-base leading-tight">🏒 Prédictions NHL</h1>
            <p className="text-[#8a9ea6] text-[11px]">Tous les marchés bet365 · Règles + ML + LLM</p>
          </div>
        </div>

        {/* Sélecteur de match — pills horizontaux */}
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
                <span className="text-3xl">{selectedGame.homeLogo}</span>
                <span className="text-white text-sm font-bold">{selectedGame.homeAbbr}</span>
                <span className="text-xs font-bold" style={{ color: accent }}>{selectedGame.homeWinPct}%</span>
              </div>
              <div className="flex flex-col items-center gap-1 px-4">
                <span className="text-[#4a6068] text-xs">{selectedGame.time}</span>
                <span className="text-white font-bold">VS</span>
                <div className="flex items-center gap-2 mt-1">
                  <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: accent }} />
                  <span className="text-[11px] font-medium" style={{ color: accent }}>Live Data</span>
                </div>
              </div>
              <div className="flex-1 flex flex-col items-center gap-1">
                <span className="text-3xl">{selectedGame.awayLogo}</span>
                <span className="text-white text-sm font-bold">{selectedGame.awayAbbr}</span>
                <span className="text-[#8a9ea6] text-xs">{selectedGame.awayWinPct}%</span>
              </div>
            </div>

            {/* Liste des marchés */}
            <div className="flex flex-col gap-2">
              <p className="text-[#bfc8cc] text-xs uppercase tracking-widest mb-1">
                {CATEGORY_ICONS[activeCategory]} {CATEGORY_LABELS[activeCategory]} — {categoryMarkets.length} marchés
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
