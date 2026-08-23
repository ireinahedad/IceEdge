/**
 * GamePrediction.tsx
 *
 * Extrait de PredictionPage.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { useNavigate } from "react-router";
import { useEffect, useState } from "react";
import { nhlApiService } from "../../services/nhlApiService";
import { predictionApiService } from "../../services/predictionApiService";
import { useSport } from "../../context/SportContext";
import { useI18n } from "../../i18n";
import { nhlLogoUrl } from "../../data/teamEmoji";
import { getTeamById, getGameById } from "../../data/hockeyData";
import { GamePlayersSection, MarketGroup, PredictionsRevealBar } from "./PredictionSheet";
import { LiveGameView, MLProps, MktGroup, buildGameGroups } from "./gameMarkets";
import { HeadToHead, NotFound, RevealMode, RevealModeCtx } from "./predictionShared";


export function GamePrediction({ gameId }: { gameId: string }) {
  const { theme } = useSport();
  const { t } = useI18n();
  const navigate = useNavigate();
  const accent = theme.accent;
  const openTeam = (abbr: string) => navigate(`/stats/prediction/team/${abbr.toLowerCase()}`);
  const [gameView, setGameView] = useState<LiveGameView | null>(null);
  const [apiGroups, setApiGroups] = useState<MktGroup[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [revealMode, setRevealMode] = useState<RevealMode>("rules");

  useEffect(() => {
    async function load() {
      setLoading(true);
      const staticGame = getGameById(gameId);
      if (staticGame) {
        const t1 = getTeamById(staticGame.team1Id);
        const t2 = getTeamById(staticGame.team2Id);
        if (t1 && t2) {
          setGameView({ id: gameId,
            home: { abbr: t1.abbr, name: t1.name, logo: t1.logo, winPct: staticGame.winPct1 },
            away: { abbr: t2.abbr, name: t2.name, logo: t2.logo, winPct: staticGame.winPct2 },
            time: staticGame.time, overUnder: staticGame.overUnder });
          setLoading(false);
          return;
        }
      }
      try {
        const [nhlGame, homePred] = await Promise.all([
          nhlApiService.getGame(gameId),
          predictionApiService.getSinglePrediction({ marketType: "moneyline", gameId, teamId: "" })
            .catch(() => ({ probability: 55 })),
        ]);
        setGameView({
          id: gameId,
          home: {
            abbr: nhlGame.homeTeam.abbreviation, name: nhlGame.homeTeam.name,
            logo: nhlLogoUrl(nhlGame.homeTeam.abbreviation),
            score: nhlGame.homeTeam.score, winPct: homePred.probability,
          },
          away: {
            abbr: nhlGame.awayTeam.abbreviation, name: nhlGame.awayTeam.name,
            logo: nhlLogoUrl(nhlGame.awayTeam.abbreviation),
            score: nhlGame.awayTeam.score, winPct: 100 - homePred.probability,
          },
          period: nhlGame.period ? nhlGame.period + "P • " + nhlGame.clock : undefined,
          time: nhlGame.startTime,
          overUnder: 5.5,
        });
      } catch (e) {
        console.error("GamePrediction fetch error", e);
      }
      setLoading(false);
    }
    load();
    // Fetch rule-based predictions from backend (parallel, non-blocking)
    nhlApiService.getGamePredictions(gameId).then(setApiGroups).catch(() => {});
  }, [gameId]);

  if (loading) return (
    <div className="flex flex-col gap-3">
      {[1,2,3,4].map(i => <div key={i} className="h-16 bg-[#131A12] rounded-2xl animate-pulse" />)}
    </div>
  );
  if (!gameView) return <NotFound />;

  const { home, away } = gameView;
  const isLive = !!gameView.period;
  const finalPct = Math.min(85, Math.max(15, home.winPct));
  const localGroups = buildGameGroups(home.abbr, away.abbr, finalPct, gameView.overUnder ?? 5.5);
  // Inject mlProps from localGroups into apiGroups (server groups have better rulePct but no mlProps)
  const mergedGroups = apiGroups
    ? (() => {
        const mlMap = new Map<string, MLProps>();
        localGroups.forEach(g => g.options.forEach(o => { if (o.mlProps) mlMap.set(o.id, o.mlProps); }));
        return apiGroups.map(g => ({
          ...g,
          options: g.options.map(o => ({ ...o, mlProps: mlMap.get(o.id) })),
        }));
      })()
    : localGroups;
  // Stamp the game id onto every option's mlProps — without it, a bet placed
  // from this page can never be looked up for automatic settlement.
  const groups: MktGroup[] = mergedGroups.map(g => ({
    ...g,
    options: g.options.map(o => (o.mlProps ? { ...o, mlProps: { ...o.mlProps, gameId } } : o)),
  }));

  return (
    <div className="flex flex-col gap-3">
      {/* ── Match header ── */}
      <div className="bg-[#131A12] border border-white/20 rounded-2xl p-4">
        {isLive && (
          <div className="flex items-center justify-center gap-1.5 mb-3">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            <span className="text-red-400 text-[10px] font-semibold uppercase tracking-widest">{gameView.period}</span>
          </div>
        )}
        <div className="flex items-center justify-between">
          <button
            onClick={() => openTeam(home.abbr)}
            className="flex flex-col items-center gap-1.5 flex-1 active:scale-95 transition-transform"
            title={home.name}
          >
            <img src={home.logo} alt={home.name} className="w-12 h-12 object-contain" />
            <span className="text-white text-sm font-bold underline decoration-white/20 underline-offset-4">{home.name}</span>
            {home.score !== undefined && <span className="text-white text-3xl font-black">{home.score}</span>}
          </button>
          <div className="flex flex-col items-center gap-1 px-2">
            {!isLive && <span className="text-[#8a9ea6] text-xs">{gameView.time ?? t("pred.today")}</span>}
            <span className="text-[#8a9ea6] font-bold text-base">VS</span>
            <span className="text-[#4a6070] text-[10px]">O/U {gameView.overUnder}</span>
          </div>
          <button
            onClick={() => openTeam(away.abbr)}
            className="flex flex-col items-center gap-1.5 flex-1 active:scale-95 transition-transform"
            title={away.name}
          >
            <img src={away.logo} alt={away.name} className="w-12 h-12 object-contain" />
            <span className="text-white text-sm font-bold underline decoration-white/20 underline-offset-4">{away.name}</span>
            {away.score !== undefined && <span className="text-white text-3xl font-black">{away.score}</span>}
          </button>
        </div>
      </div>

      {/* Head-to-head — the teams' recent meetings, shown above the markets */}
      <HeadToHead
        home={{ abbr: home.abbr, logo: home.logo }}
        away={{ abbr: away.abbr, logo: away.logo }}
      />

      {/* Players — jump straight to any player's own prediction page */}
      <GamePlayersSection
        home={{ abbr: home.abbr, name: home.name }}
        away={{ abbr: away.abbr, name: away.name }}
        accent={accent}
      />

      {/* ── Market groups ── */}
      <PredictionsRevealBar mode={revealMode} onSelect={setRevealMode} />
      <RevealModeCtx.Provider value={revealMode}>
        {groups.map(g => <MarketGroup key={g.id} group={g} accent={accent} />)}
      </RevealModeCtx.Provider>

    </div>
  );
}
