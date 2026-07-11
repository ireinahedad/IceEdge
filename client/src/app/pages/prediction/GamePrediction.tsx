import { useEffect, useMemo, useState } from "react";
import { nhlApiService } from "../../services/nhlApiService";
import { predictionApiService } from "../../services/predictionApiService";
import { nhlLogoUrl } from "../../data/teamEmoji";
import { getTeamById, getGameById } from "../../data/hockeyData";
import { useSport } from "../../context/SportContext";
import { useI18n } from "../../i18n";
import {
  generateForm, GameRecentForm, NotFound,
  PredictionsRevealBar, RevealAllCtx,
} from "./common";
import { buildGameGroups, MarketGroup, type MLProps } from "./markets";

interface LiveGameView {
  id: string;
  home: { abbr: string; name: string; logo: string; score?: number; winPct: number };
  away: { abbr: string; name: string; logo: string; score?: number; winPct: number };
  period?: string; time?: string; overUnder: number;
}

/* ─── GamePrediction ────────────────────────── */
export function GamePrediction({ gameId }: { gameId: string }) {
  const { theme } = useSport();
  const { t } = useI18n();
  const accent = theme.accent;
  const [gameView, setGameView] = useState<LiveGameView | null>(null);
  const [apiGroups, setApiGroups] = useState<ReturnType<typeof buildGameGroups> | null>(null);
  const [loading, setLoading] = useState(true);
  const [revealAll, setRevealAll] = useState(false);
  const [pickedSide, setPickedSide] = useState<"home" | "away" | null>(null);
  const homeForm = useMemo<("W" | "L" | "OT")[]>(
    () => (gameView ? generateForm(8, gameView.home.winPct / 100) : []),
    [gameView?.home.winPct],
  );
  const awayForm = useMemo<("W" | "L" | "OT")[]>(
    () => (gameView ? generateForm(8, gameView.away.winPct / 100) : []),
    [gameView?.away.winPct],
  );

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

  // Choose which team you're betting on before revealing the markets.
  if (pickedSide === null) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-center text-white text-sm font-bold mt-2">{t("pred.chooseTeam")}</p>
        <div className="grid grid-cols-2 gap-3">
          {([{ side: "home", team: home }, { side: "away", team: away }] as const).map(({ side, team }) => (
            <button
              key={side}
              onClick={() => setPickedSide(side)}
              className="flex flex-col items-center gap-2 bg-[#131A12] border border-white/20 rounded-2xl p-4 active:scale-[0.98] transition-all"
            >
              <img src={team.logo} alt={team.name} className="w-14 h-14 object-contain" />
              <span className="text-white text-sm font-bold text-center">{team.name}</span>
              <span className="text-[11px] font-semibold" style={{ color: accent }}>{Math.round(team.winPct)}%</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const pickedTeam = pickedSide === "home" ? home : away;
  const isLive = !!gameView.period;
  const finalPct = Math.min(85, Math.max(15, home.winPct));
  const localGroups = buildGameGroups(home.abbr, away.abbr, finalPct, gameView.overUnder ?? 5.5);
  // Inject mlProps from localGroups into apiGroups (server groups have better rulePct but no mlProps)
  const groups = apiGroups
    ? (() => {
        const mlMap = new Map<string, MLProps>();
        localGroups.forEach(g => g.options.forEach(o => { if (o.mlProps) mlMap.set(o.id, o.mlProps); }));
        return apiGroups.map(g => ({
          ...g,
          options: g.options.map(o => ({ ...o, mlProps: mlMap.get(o.id) })),
        }));
      })()
    : localGroups;

  return (
    <div className="flex flex-col gap-3">
      {/* Chosen team + change */}
      <div className="flex items-center justify-between rounded-xl px-3 py-2 bg-[#131A12] border border-white/15">
        <div className="flex items-center gap-2">
          <img src={pickedTeam.logo} alt={pickedTeam.name} className="w-5 h-5 object-contain" />
          <span className="text-white text-xs font-semibold">{t("pred.bettingOn")} {pickedTeam.name}</span>
        </div>
        <button onClick={() => setPickedSide(null)} className="text-[11px] font-semibold" style={{ color: accent }}>
          {t("pred.change")}
        </button>
      </div>

      {/* ── Match header ── */}
      <div className="bg-[#131A12] border border-white/20 rounded-2xl p-4">
        {isLive && (
          <div className="flex items-center justify-center gap-1.5 mb-3">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            <span className="text-red-400 text-[10px] font-semibold uppercase tracking-widest">{gameView.period}</span>
          </div>
        )}
        <div className="flex items-center justify-between">
          <div className="flex flex-col items-center gap-1.5 flex-1">
            <img src={home.logo} alt={home.name} className="w-12 h-12 object-contain" />
            <span className="text-white text-sm font-bold">{home.name}</span>
            {home.score !== undefined && <span className="text-white text-3xl font-black">{home.score}</span>}
          </div>
          <div className="flex flex-col items-center gap-1 px-2">
            {!isLive && <span className="text-[#8a9ea6] text-xs">{gameView.time ?? t("pred.today")}</span>}
            <span className="text-[#8a9ea6] font-bold text-base">VS</span>
            <span className="text-[#4a6070] text-[10px]">O/U {gameView.overUnder}</span>
          </div>
          <div className="flex flex-col items-center gap-1.5 flex-1">
            <img src={away.logo} alt={away.name} className="w-12 h-12 object-contain" />
            <span className="text-white text-sm font-bold">{away.name}</span>
            {away.score !== undefined && <span className="text-white text-3xl font-black">{away.score}</span>}
          </div>
        </div>
      </div>

      {/* Recent form — both teams, shown above the markets */}
      <GameRecentForm
        home={{ abbr: home.abbr, logo: home.logo }}
        away={{ abbr: away.abbr, logo: away.logo }}
        homeForm={homeForm}
        awayForm={awayForm}
      />

      {/* ── Market groups ── */}
      <PredictionsRevealBar revealAll={revealAll} onToggle={() => setRevealAll(v => !v)} />
      <RevealAllCtx.Provider value={revealAll}>
        {groups.map(g => <MarketGroup key={g.id} group={g} accent={accent} />)}
      </RevealAllCtx.Provider>

    </div>
  );
}
