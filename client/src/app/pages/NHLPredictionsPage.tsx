/**
 * NHLPredictionsPage.tsx — `/nhl-predictions`, the landing target of the SEO pages.
 *
 * A picker over tonight's games, and under it the SAME match view as
 * `/stats/prediction/game/:id` (`GamePrediction`): every number on this page
 * comes from the server's rule engine or from the ML bundle, never from here.
 *
 * ⚠️ Until 2026-09-24 this page computed its own ~40 markets in the browser
 * (`computeRulePrediction`): constants (30 % anytime scorer, 55 % shots, 38 %
 * most productive period…) and rules of thumb (puck line = win % × 0.55), plus
 * an "Ask LLM" button whose answer was a timed placeholder. That broke the
 * product rule "no invented number" on the page the SEO pages send visitors
 * to. Do not bring a local market list back: add markets to the server
 * (`nhlPredictions.ts`) so the match, team and player pages get them too.
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { BottomNav } from "../components/BottomNav";
import { useSport } from "../context/SportContext";
import { useNHLData } from "../hooks/useNHLData";
import { nhlLogoUrl } from "../data/teamEmoji";
import { useI18n } from "../i18n";
import { ErrorState } from "../components/ErrorState";
import { GamePrediction } from "./prediction/GamePrediction";
import { RevealModeCtx } from "./prediction/predictionShared";
import "../components/rink-theme.css";

/** Statuts d'un match qu'on ne propose pas (valeurs NHL minuscules, cf. `parseGameState`). */
const UNPLAYABLE_STATUS = new Set(["ppd", "postponed", "cncl", "cancelled", "canceled", "susp", "suspended"]);

interface GameOption {
  id: string;
  homeAbbr: string;
  awayAbbr: string;
  homeLogo: string;
  awayLogo: string;
}

function GamePills({
  games,
  selectedId,
  onSelect,
  accent,
}: {
  games: GameOption[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  accent: string;
}) {
  if (games.length === 0) return null;
  return (
    <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-0.5">
      {games.map((g) => {
        const isActive = selectedId === g.id;
        return (
          <button
            key={g.id}
            type="button"
            onClick={() => onSelect(g.id)}
            aria-pressed={isActive}
            className="flex-shrink-0 flex items-center gap-1.5 px-3 min-h-[44px] rounded-full text-xs font-medium transition-all border"
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

export function NHLPredictionsPage() {
  const navigate = useNavigate();
  const { theme } = useSport();
  const { t } = useI18n();
  const accent = theme.accent;
  const { games, getTeamById, loading, error, reload } = useNHLData();

  // Plus d'appel `getTeamStats` ici : les buts par match ne servaient qu'aux
  // marchés calculés localement. `GamePrediction` charge ce qu'il affiche.
  const gameOptions: GameOption[] = useMemo(() => games
    .filter((g) => !UNPLAYABLE_STATUS.has(String(g.status ?? "").toLowerCase()))
    .map((g) => {
      const home = getTeamById(g.team1Id);
      const away = getTeamById(g.team2Id);
      if (!home || !away) return null;
      return {
        id: g.id,
        homeAbbr: home.abbr,
        awayAbbr: away.abbr,
        homeLogo: home.logo || nhlLogoUrl(home.abbr),
        awayLogo: away.logo || nhlLogoUrl(away.abbr),
      };
    })
    .filter((o): o is GameOption => o !== null)
    .slice(0, 8), [games, getTeamById]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Garde la sélection tant que le match est dans la liste ; sinon le premier.
  // Un match choisi la veille ne doit pas rester affiché une fois sorti.
  useEffect(() => {
    if (gameOptions.length === 0) { setSelectedId(null); return; }
    setSelectedId((cur) => (cur && gameOptions.some((g) => g.id === cur) ? cur : gameOptions[0].id));
  }, [gameOptions]);

  return (
    <RevealModeCtx.Provider value="ml">
      <div className="flex flex-col min-h-screen bg-transparent text-white max-w-[430px] md:max-w-5xl mx-auto w-full">
        {/* ── Header ── */}
        <header className="bg-[#0A0E0C]/80 backdrop-blur-md sticky top-0 z-40" style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}>
          <div className="px-4 pt-3 pb-3 flex items-center gap-3">
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="min-w-[44px] min-h-[44px] w-9 h-9 rounded-xl bg-[#131A12] border border-white/20 flex items-center justify-center flex-shrink-0"
              style={{ color: accent }}
            >
              ←
            </button>
            <div className="flex-1 min-w-0">
              <h1 className="text-white font-bold text-base leading-tight uppercase" style={{ fontFamily: "'Oswald', 'Arial Narrow', sans-serif" }}>{t("nhl.title")}</h1>
              <p className="text-[#8a9ea6] text-[11px]">{t("nhl.subtitle")}</p>
            </div>
          </div>

          <div className="px-4 pb-3">
            {loading ? (
              <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-0.5">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex-shrink-0 h-8 w-32 bg-[#131A12] rounded-full animate-pulse" />
                ))}
              </div>
            ) : (
              <GamePills games={gameOptions} selectedId={selectedId} onSelect={setSelectedId} accent={accent} />
            )}
          </div>
        </header>

        {/* ── Contenu ── */}
        <div className="flex-1 px-4 pb-[calc(7rem+env(safe-area-inset-bottom,0px))] pt-4 overflow-y-auto">
          {loading && (
            <div className="flex flex-col gap-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="bg-[#131A12] rounded-2xl h-16 animate-pulse" />
              ))}
            </div>
          )}

          {/* Échec du chargement ≠ aucun match : deux écrans différents. */}
          {!loading && error && gameOptions.length === 0 && (
            <ErrorState onRetry={reload} error={error} />
          )}

          {!loading && !error && gameOptions.length === 0 && (
            <div className="flex flex-col items-center justify-center text-center py-14 px-6">
              <p className="text-white font-bold text-sm">{t("home.noGames")}</p>
            </div>
          )}

          {/* `key` : un changement de match remonte la vue, donc aucun état du
              match précédent (paquet ML, cotes, mode) ne déborde sur le suivant. */}
          {!loading && selectedId && <GamePrediction key={selectedId} gameId={selectedId} />}
        </div>

        <BottomNav />
      </div>
    </RevealModeCtx.Provider>
  );
}
