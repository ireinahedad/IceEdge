/**
 * TennisPredictionsPage.tsx
 * Page dédiée aux prédictions Tennis — tous les marchés bet365,
 * prédictions par règles · section ML (à venir) · bouton Ask LLM.
 */

import { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router";
import { BottomNav } from "./BottomNav";
import { useSport } from "../context/SportContext";
import { tennisApiService, TennisApiMatch, TennisRankingEntry } from "../services/tennisApiService";
import {
  TENNIS_MARKET_DEFINITIONS,
  TENNIS_CATEGORY_LABELS,
  TENNIS_CATEGORY_ICONS,
  TennisMarketDefinition,
} from "../data/betMarkets";

// ─── Types locaux ──────────────────────────────────────────────────────────────

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

interface TennisPrediction {
  marketType: string;
  rulePct: number;
  ruleNote: string;
  mlPct: number | null;
  llmResponse: string | null;
  llmLoading: boolean;
}

// Fallback matches pour les jours sans API
const FALLBACK_MATCHES: MatchOption[] = [
  {
    id: "demo-1",
    tournament: "Wimbledon",
    surface: "Grass",
    surfaceIcon: "🟩",
    isLive: false,
    p1Name: "C. Alcaraz",
    p1Country: "🇪🇸",
    p1WinPct: 62,
    p1Points: 8750,
    p2Name: "N. Djokovic",
    p2Country: "🇷🇸",
    p2WinPct: 38,
    p2Points: 7200,
    timeLabel: "14:00",
  },
  {
    id: "demo-2",
    tournament: "Roland Garros",
    surface: "Clay",
    surfaceIcon: "🟫",
    isLive: true,
    p1Name: "I. Swiatek",
    p1Country: "🇵🇱",
    p1WinPct: 71,
    p1Points: 10890,
    p2Name: "A. Sabalenka",
    p2Country: "🇧🇾",
    p2WinPct: 29,
    p2Points: 8730,
    timeLabel: "Live",
  },
];

// ─── Calcul des prédictions par règles ────────────────────────────────────────

function computeTennisRule(
  market: TennisMarketDefinition,
  match: MatchOption
): { pct: number; note: string } {
  const p1w = match.p1WinPct;
  const p2w = match.p2WinPct;
  const balance = 1 - Math.abs(p1w - 50) / 50; // 0 = déséquilibré, 1 = équilibré

  switch (market.type) {
    case "tennis_match_winner":
      return { pct: p1w, note: `${match.p1Name} · Win% basé sur classement et points` };

    case "tennis_total_sets": {
      // Match équilibré → plus probable de faire 3 sets
      const over = Math.round(35 + balance * 40);
      return { pct: over, note: `Matchs serrés → plus de sets joués · équilibre ${Math.round(balance * 100)}%` };
    }

    case "tennis_correct_score": {
      const score20 = Math.round(p1w * 0.52);
      return { pct: score20, note: `2-0 pour ${match.p1Name} · score le plus probable si favori dominant` };
    }

    case "tennis_to_win_set":
      return { pct: Math.min(88, Math.round(p2w + 30)), note: `${match.p2Name} remporte au moins 1 set` };

    case "tennis_tiebreak": {
      const tie = Math.round(25 + balance * 45);
      return { pct: tie, note: `Tiebreak probable · balance du match ${Math.round(balance * 100)}%` };
    }

    case "tennis_first_set":
      return { pct: p1w, note: `${match.p1Name} gagne le 1er set · corrélé au résultat final` };

    case "tennis_set_handicap":
      return { pct: Math.round(p1w * 0.85), note: `Handicap sets -1.5 pour ${match.p1Name}` };

    case "tennis_first_set_games": {
      // Surface lente (clay) → plus de jeux par set
      const isClay = match.surface === "Clay";
      const avg = isClay ? 10.8 : 9.6;
      const line = 9.5;
      const over = Math.round(50 + (avg - line) * 25);
      return { pct: over, note: `Surface ${match.surface} · moy. ${avg} jeux/set` };
    }

    case "tennis_total_games": {
      const isClay = match.surface === "Clay";
      const isGrass = match.surface === "Grass";
      const avgGames = isClay ? 24.5 : isGrass ? 21.5 : 22.8;
      const line = 22.5;
      const over = Math.round(50 + (avgGames - line) * 12);
      return { pct: over, note: `Surface ${match.surface} · moy. ${avgGames} jeux/match` };
    }

    case "tennis_game_handicap":
      return { pct: Math.round(p1w * 0.80), note: `Handicap jeux · ${match.p1Name} domine` };

    default:
      return { pct: 50, note: "Prédiction basée sur classement et surface" };
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

// ─── Carte d'un marché tennis ─────────────────────────────────────────────────

function TennisBetCard({
  market,
  prediction,
  accent,
  onAskLLM,
}: {
  market: TennisMarketDefinition;
  prediction: TennisPrediction;
  accent: string;
  onAskLLM: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const color = pctColor(prediction.rulePct);

  return (
    <div className="bg-[#111a1f] border border-white/[0.08] rounded-2xl overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-4 py-3 flex items-center gap-3 text-left"
      >
        <MiniGauge pct={prediction.rulePct} color={color} />
        <div className="flex-1 min-w-0">
          <p className="text-white text-sm font-semibold leading-tight">{market.label}</p>
          <p className="text-[#8a9ea6] text-[11px] mt-0.5 leading-snug">{market.description}</p>
        </div>
        <span className="text-[#4a6068] text-xs flex-shrink-0">{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 flex flex-col gap-3 border-t border-white/[0.05] pt-3">
          {/* ── Règles ── */}
          <div className="bg-[#0d1518] rounded-xl p-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-base">📐</span>
              <span className="text-white text-xs font-semibold">Prédiction par règles</span>
              <span className="ml-auto text-xs font-black" style={{ color }}>{prediction.rulePct}%</span>
            </div>
            <div className="w-full bg-[#0a1014] rounded-full h-2 mb-2">
              <div
                className="h-2 rounded-full transition-all duration-700"
                style={{ width: `${prediction.rulePct}%`, backgroundColor: color }}
              />
            </div>
            <p className="text-[#8a9ea6] text-[11px] leading-snug">{prediction.ruleNote}</p>
          </div>

          {/* ── ML ── */}
          <div className="bg-[#0d1518] rounded-xl p-3 border border-dashed border-white/10">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-base">🤖</span>
              <span className="text-white text-xs font-semibold">Prédiction ML</span>
              <span className="ml-auto text-[10px] bg-yellow-500/15 text-yellow-400 border border-yellow-500/25 px-2 py-0.5 rounded-full font-medium">
                À venir
              </span>
            </div>
            <div className="w-full bg-[#0a1014] rounded-full h-2 mb-1 overflow-hidden">
              <div className="h-full bg-gradient-to-r from-[#1e2d32] to-[#2a3d44] animate-pulse rounded-full w-3/5" />
            </div>
            <p className="text-[#4a6068] text-[11px]">Le modèle ML sera disponible prochainement</p>
          </div>

          {/* ── Ask LLM ── */}
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
      )}
    </div>
  );
}

// ─── Sélecteur de match ───────────────────────────────────────────────────────

function MatchSelector({
  matches,
  selected,
  onSelect,
  accent,
}: {
  matches: MatchOption[];
  selected: MatchOption | null;
  onSelect: (m: MatchOption) => void;
  accent: string;
}) {
  const [open, setOpen] = useState(false);

  if (matches.length === 0) {
    return (
      <div className="bg-[#111a1f] border border-white/20 rounded-2xl px-4 py-3 text-center">
        <p className="text-[#bfc8cc] text-sm">Aucun match aujourd'hui</p>
      </div>
    );
  }

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full bg-[#111a1f] border border-white/20 rounded-2xl px-4 py-3 flex items-center gap-2"
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
                Live
              </span>
            )}
          </>
        ) : (
          <span className="text-[#bfc8cc] text-sm">Choisir un match…</span>
        )}
        <span style={{ color: accent }} className="ml-auto flex-shrink-0">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="mt-1 bg-[#111a1f] border border-white/20 rounded-2xl overflow-hidden">
          {matches.map((m, i) => (
            <button
              key={m.id}
              onClick={() => { onSelect(m); setOpen(false); }}
              className={`w-full flex items-center gap-2 px-4 py-3 hover:bg-[#1a2a2f] transition-colors text-left ${i > 0 ? "border-t border-[#1a2225]" : ""}`}
            >
              <span className="text-base">{m.p1Country}</span>
              <span className="text-white text-sm">{m.p1Name}</span>
              <span className="text-[#4a6068] text-xs">vs</span>
              <span className="text-white text-sm">{m.p2Name}</span>
              <span className="text-base">{m.p2Country}</span>
              <span className="ml-auto text-[10px] flex-shrink-0" style={{ color: accent }}>{m.surfaceIcon} {m.surface}</span>
              {m.isLive && (
                <span className="text-[9px] text-red-400 flex-shrink-0 flex items-center gap-0.5">
                  <span className="w-1 h-1 rounded-full bg-red-500 animate-pulse inline-block" />
                  Live
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── LLM ask (mock) ───────────────────────────────────────────────────────────

async function askTennisLLM(
  market: TennisMarketDefinition,
  match: MatchOption,
  rulePct: number
): Promise<string> {
  await new Promise((r) => setTimeout(r, 1200));
  return (
    `Analyse ${market.label} pour ${match.p1Name} vs ${match.p2Name} (${match.surface}) : ` +
    `les règles donnent ${rulePct}%. ` +
    `La surface ${match.surface} ${match.surface === "Clay" ? "favorise les longs échanges" : match.surface === "Grass" ? "accélère le jeu" : "équilibre les styles"}. ` +
    `${rulePct >= 55 ? "Valeur positive détectée" : "Marché équilibré"}. ` +
    `[Connectez votre LLM via /api/chat pour une analyse complète]`
  );
}

// ─── Page principale ──────────────────────────────────────────────────────────

const TENNIS_CATS: TennisMarketDefinition["category"][] = ["match", "set", "game", "special"];

export function TennisPredictionsPage() {
  const navigate = useNavigate();
  const { theme } = useSport();
  const accent = "#3bc47a"; // Tennis green

  const [matches, setMatches] = useState<MatchOption[]>([]);
  const [rankings, setRankings] = useState<(TennisRankingEntry & { tour: "ATP" | "WTA" })[]>([]);
  const [selected, setSelected] = useState<MatchOption | null>(null);
  const [loading, setLoading] = useState(true);
  const [predictions, setPredictions] = useState<Record<string, TennisPrediction>>({});
  const [activeCategory, setActiveCategory] = useState<TennisMarketDefinition["category"]>("match");

  // ── Charger matches et rankings ────────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    Promise.all([
      tennisApiService.getLiveMatches().catch(() => [] as TennisApiMatch[]),
      tennisApiService.getFixtures().catch(() => [] as TennisApiMatch[]),
      tennisApiService.getRankings("ATP").catch(() => [] as TennisRankingEntry[]),
      tennisApiService.getRankings("WTA").catch(() => [] as TennisRankingEntry[]),
    ]).then(([live, fixtures, atp, wta]) => {
      const allRankings: (TennisRankingEntry & { tour: "ATP" | "WTA" })[] = [
        ...atp.map((r) => ({ ...r, tour: "ATP" as const })),
        ...wta.map((r) => ({ ...r, tour: "WTA" as const })),
      ];
      setRankings(allRankings);

      const toOption = (m: TennisApiMatch, isLive: boolean): MatchOption => {
        const findRank = (name: string) =>
          allRankings.find((r) => r.player.name.toLowerCase().includes(name.split(/[.\s]/).pop()?.toLowerCase() ?? ""));
        const r1 = findRank(m.player1.name);
        const r2 = findRank(m.player2.name);
        const total = (r1?.points ?? 5000) + (r2?.points ?? 5000);
        const p1w = Math.round(Math.max(20, Math.min(80, ((r1?.points ?? 5000) / total) * 100)));
        return {
          id: m.id,
          tournament: m.tournament,
          surface: m.surface,
          surfaceIcon: m.surfaceIcon,
          isLive,
          p1Name: m.player1.name,
          p1Country: m.player1.country,
          p1WinPct: p1w,
          p1Points: r1?.points ?? 5000,
          p2Name: m.player2.name,
          p2Country: m.player2.country,
          p2WinPct: 100 - p1w,
          p2Points: r2?.points ?? 5000,
          timeLabel: isLive ? "Live" : m.scheduledIso ? new Date(m.scheduledIso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "TBD",
        };
      };

      const apiMatches = [
        ...live.map((m) => toOption(m, true)),
        ...fixtures.map((m) => toOption(m, false)),
      ];

      const finalMatches = apiMatches.length > 0 ? apiMatches : FALLBACK_MATCHES;
      setMatches(finalMatches);
      setSelected(finalMatches[0] ?? null);
      setLoading(false);
    });
  }, []);

  // ── Calculer les prédictions par règles ─────────────────────────────────────
  useEffect(() => {
    if (!selected) return;
    const preds: Record<string, TennisPrediction> = {};
    for (const market of TENNIS_MARKET_DEFINITIONS) {
      const { pct, note } = computeTennisRule(market, selected);
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
  }, [selected]);

  // ── Ask LLM ────────────────────────────────────────────────────────────────
  const handleAskLLM = useCallback(async (market: TennisMarketDefinition) => {
    if (!selected) return;
    setPredictions((prev) => ({
      ...prev,
      [market.type]: { ...prev[market.type], llmLoading: true },
    }));
    try {
      const response = await askTennisLLM(market, selected, predictions[market.type]?.rulePct ?? 50);
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
  }, [selected, predictions]);

  const categoryMarkets = TENNIS_MARKET_DEFINITIONS.filter((m) => m.category === activeCategory);

  return (
    <div className="flex flex-col min-h-screen bg-transparent text-white max-w-[430px] mx-auto">
      {/* ── Header ── */}
      <header className="px-4 pt-12 pb-3 bg-[#0a1014]/80 backdrop-blur-md sticky top-0 z-40 border-b border-white/[0.04]">
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={() => navigate(-1)}
            className="w-9 h-9 rounded-xl bg-[#111a1f] border border-white/20 flex items-center justify-center flex-shrink-0"
            style={{ color: accent }}
          >
            ←
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-white font-bold text-base leading-tight">🎾 Prédictions Tennis</h1>
            <p className="text-[#8a9ea6] text-[11px]">Tous les marchés bet365 · Règles + ML + LLM</p>
          </div>
        </div>

        {loading ? (
          <div className="h-12 bg-[#111a1f] rounded-2xl animate-pulse" />
        ) : (
          <MatchSelector matches={matches} selected={selected} onSelect={setSelected} accent={accent} />
        )}

        {selected && (
          <div className="flex gap-1.5 overflow-x-auto scrollbar-hide pb-0.5 mt-3">
            {TENNIS_CATS.map((cat) => {
              const count = TENNIS_MARKET_DEFINITIONS.filter((m) => m.category === cat).length;
              return (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  className="flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-all flex items-center gap-1"
                  style={activeCategory === cat
                    ? { backgroundColor: accent, color: "#0f1416", fontWeight: 700 }
                    : { backgroundColor: "#1a2a2f", color: "#bfc8cc" }}
                >
                  {TENNIS_CATEGORY_ICONS[cat]} {TENNIS_CATEGORY_LABELS[cat]}
                  <span className="text-[9px] opacity-70">({count})</span>
                </button>
              );
            })}
          </div>
        )}
      </header>

      {/* ── Contenu ── */}
      <div className="flex-1 px-4 pb-28 pt-4 overflow-y-auto">
        {selected && (
          <>
            {/* Résumé du match */}
            <div className="bg-[#111a1f] border border-white/20 rounded-2xl p-4 mb-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ backgroundColor: `${accent}1a`, color: accent }}>
                  {selected.surfaceIcon} {selected.surface}
                </span>
                <span className="text-[#8a9ea6] text-[11px]">{selected.tournament}</span>
                {selected.isLive && (
                  <span className="ml-auto text-[10px] text-red-400 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse inline-block" />
                    Live
                  </span>
                )}
              </div>
              <div className="flex items-center">
                <div className="flex-1 flex flex-col items-center gap-1">
                  <span className="text-3xl">{selected.p1Country}</span>
                  <span className="text-white text-sm font-bold text-center leading-tight">{selected.p1Name}</span>
                  <span className="text-xs font-bold" style={{ color: accent }}>{selected.p1WinPct}%</span>
                </div>
                <div className="flex flex-col items-center gap-0.5 px-3">
                  <span className="text-white font-bold text-sm">VS</span>
                </div>
                <div className="flex-1 flex flex-col items-center gap-1">
                  <span className="text-3xl">{selected.p2Country}</span>
                  <span className="text-white text-sm font-bold text-center leading-tight">{selected.p2Name}</span>
                  <span className="text-[#8a9ea6] text-xs">{selected.p2WinPct}%</span>
                </div>
              </div>
              {/* Barre de probabilité */}
              <div className="mt-3 flex items-center gap-2">
                <span className="text-[10px] font-bold w-7 flex-shrink-0" style={{ color: accent }}>{selected.p1WinPct}%</span>
                <div className="flex-1 bg-[#0a1014] rounded-full h-2 overflow-hidden flex">
                  <div className="h-full rounded-l-full" style={{ width: `${selected.p1WinPct}%`, backgroundColor: accent }} />
                </div>
                <span className="text-[#8a9ea6] text-[10px] font-bold w-7 text-right flex-shrink-0">{selected.p2WinPct}%</span>
              </div>
            </div>

            {/* Marchés */}
            <div className="flex flex-col gap-2">
              <p className="text-[#bfc8cc] text-xs uppercase tracking-widest mb-1">
                {TENNIS_CATEGORY_ICONS[activeCategory]} {TENNIS_CATEGORY_LABELS[activeCategory]} — {categoryMarkets.length} marchés
              </p>
              {categoryMarkets.map((market) => {
                const pred = predictions[market.type];
                if (!pred) return null;
                return (
                  <TennisBetCard
                    key={market.type}
                    market={market}
                    prediction={pred}
                    accent={accent}
                    onAskLLM={() => handleAskLLM(market)}
                  />
                );
              })}
            </div>
          </>
        )}

        {!selected && !loading && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <span className="text-5xl">🎾</span>
            <p className="text-white font-bold">Aucun match disponible</p>
          </div>
        )}
      </div>

      <BottomNav />
    </div>
  );
}
