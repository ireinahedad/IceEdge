import { useState, useEffect, useMemo } from "react";
import { BottomNav } from "../../components/BottomNav";
import { MarketSelectorSheet } from "../../components/MarketSelectorSheet";
import { nhlApiService } from "../../services/nhlApiService";
import { tennisApiService } from "../../services/tennisApiService";
import { useSport } from "../../context/SportContext";
import { useSubscription } from "../../context/SubscriptionContext";
import { useI18n } from "../../i18n";
import {
  fetchBet365Odds,
  extractH2HOdds,
  ODDS_SPORT_KEYS,
} from "../../services/oddsApiService";
import { calcEdge, type DisplayGame, type TennisMatch, type EvItem } from "./types";
import { toDisplayGame, toTennisMatch, TENNIS_LIVE_FALLBACK, TENNIS_UPCOMING_FALLBACK } from "./data";
import { SportSelector } from "./SportSelector";
import { LiveGameCard, UpcomingGameRow } from "./GameCards";
import { TennisLiveCard, TennisMatchRow } from "./TennisCards";
import { EvSection } from "./EvSection";
import { BestBetsSection } from "./BestBetsSection";
import "./home-theme.css";

interface AddSheetState {
  open: boolean;
  gameId?: string;
}

// ─── Main component ────────────────────────────────────────────────────────────

export function HockeyLanding() {
  const { sport, theme } = useSport();
  const { t, lang } = useI18n();
  const { isPro } = useSubscription();
  const accent = theme.accent;
  const [addSheet, setAddSheet] = useState<AddSheetState>({ open: false });
  const [liveGames, setLiveGames] = useState<DisplayGame[]>([]);
  const [upcomingGames, setUpcomingGames] = useState<DisplayGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [upcomingLabel, setUpcomingLabel] = useState(() => t("home.tonightGames"));

  // Tennis state
  const [tennisLive, setTennisLive] = useState<TennisMatch[]>([]);
  const [tennisUpcoming, setTennisUpcoming] = useState<TennisMatch[]>([]);
  const [tennisLoading, setTennisLoading] = useState(false);

  // Value bets (+EV): model probability beats the bookmaker's implied probability.
  // Only meaningful when real bet365 odds are present (VITE_ODDS_API_KEY set).
  const evItems: EvItem[] = useMemo(() => {
    const out: EvItem[] = [];
    if (sport === "hockey") {
      for (const g of [...liveGames, ...upcomingGames]) {
        if (g.bet365Home) {
          const edge = calcEdge(g.team1.winPct, g.bet365Home);
          if (edge >= 5) out.push({ id: `ev-${g.id}-h`, logo: g.team1.logo, label: `${g.team1.abbr} ML vs ${g.team2.abbr}`, context: t("home.evSpot"), pct: g.team1.winPct, edge });
        }
        if (g.bet365Away) {
          const edge = calcEdge(g.team2.winPct, g.bet365Away);
          if (edge >= 5) out.push({ id: `ev-${g.id}-a`, logo: g.team2.logo, label: `${g.team2.abbr} ML vs ${g.team1.abbr}`, context: t("home.evSpot"), pct: g.team2.winPct, edge });
        }
      }
    } else {
      for (const m of [...tennisLive, ...tennisUpcoming]) {
        if (m.player1.bet365Odds) {
          const edge = calcEdge(m.player1.winPct, m.player1.bet365Odds);
          if (edge >= 5) out.push({ id: `ev-${m.id}-1`, logo: m.player1.country, label: `${m.player1.name} to win`, context: t("home.evSpot"), pct: m.player1.winPct, edge });
        }
        if (m.player2.bet365Odds) {
          const edge = calcEdge(m.player2.winPct, m.player2.bet365Odds);
          if (edge >= 5) out.push({ id: `ev-${m.id}-2`, logo: m.player2.country, label: `${m.player2.name} to win`, context: t("home.evSpot"), pct: m.player2.winPct, edge });
        }
      }
    }
    return out.sort((a, b) => b.edge - a.edge).slice(0, 6);
  }, [sport, liveGames, upcomingGames, tennisLive, tennisUpcoming, t]);

  // Load NHL games + model predictions
  useEffect(() => {
    if (sport !== "hockey") return;
    setLoading(true);
    async function load() {
      try {
        const live = await nhlApiService.getLiveGames();
        let scheduled: typeof live = [];
        let label = t("home.tonightGames");
        const locale = lang === "fr" ? "fr-CA" : "en-US";
        for (let offset = 0; offset <= 7; offset++) {
          const d = new Date();
          d.setDate(d.getDate() + offset);
          const dateStr = d.toISOString().split("T")[0];
          const all = await nhlApiService.getGamesByDate(dateStr);
          scheduled = all.filter((g) => ["scheduled", "live", "preview"].includes(g.status));
          if (scheduled.length > 0) {
            if (offset === 1) label = t("home.tomorrowGames");
            else if (offset > 1) label = t("home.gamesOn", { date: d.toLocaleDateString(locale, { weekday: "long", month: "short", day: "numeric" }) });
            break;
          }
        }
        const [liveDisplay, upcomingDisplay] = await Promise.all([
          Promise.all(live.map(toDisplayGame)),
          Promise.all(scheduled.map(toDisplayGame)),
        ]);
        setLiveGames(liveDisplay);
        setUpcomingGames(upcomingDisplay);
        setUpcomingLabel(label);
      } catch (err) {
        console.error("[HockeyLanding] Failed to load games:", err);
        setLiveGames([]);
        setUpcomingGames([]);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [sport, lang]);

  // Overlay real Bet365 odds — stored separately, does NOT overwrite model winPct
  useEffect(() => {
    if (sport !== "hockey") return;
    fetchBet365Odds(ODDS_SPORT_KEYS.hockey).then((events) => {
      if (!events.length) return;

      function applyOdds(prev: DisplayGame[]): DisplayGame[] {
        return prev.map((g) => {
          const ev = events.find(
            (e) =>
              e.homeTeam?.toLowerCase().includes(g.team1.abbr.toLowerCase()) ||
              e.awayTeam?.toLowerCase().includes(g.team2.abbr.toLowerCase())
          );
          if (!ev) return g;
          const odds = extractH2HOdds(ev);
          if (!odds) return g;
          return { ...g, bet365Home: odds.home, bet365Away: odds.away };
        });
      }

      setLiveGames(applyOdds);
      setUpcomingGames(applyOdds);
    });
  }, [sport]);

  // Load tennis matches from API, fall back to mock data if key not set
  useEffect(() => {
    if (sport !== "tennis") return;
    setTennisLoading(true);
    async function load() {
      try {
        const [liveRaw, fixturesRaw] = await Promise.all([
          tennisApiService.getLiveMatches(),
          tennisApiService.getFixtures(),
        ]);
        const [liveDisplay, upcomingDisplay] = await Promise.all([
          Promise.all(liveRaw.map(toTennisMatch)),
          Promise.all(fixturesRaw.map(toTennisMatch)),
        ]);
        setTennisLive(liveDisplay);
        setTennisUpcoming(upcomingDisplay);
      } catch (err) {
        console.warn("[Tennis] API unavailable — using fallback data:", err);
        setTennisLive(TENNIS_LIVE_FALLBACK);
        setTennisUpcoming(TENNIS_UPCOMING_FALLBACK);
      } finally {
        setTennisLoading(false);
      }
    }
    load();
  }, [sport]);

  // Overlay Bet365 tennis odds from The Odds API
  useEffect(() => {
    if (sport !== "tennis") return;
    fetchBet365Odds(ODDS_SPORT_KEYS.tennis).then((events) => {
      if (!events.length) return;

      /** Extract last name: "Djokovic N." → "djokovic", "Novak Djokovic" → "djokovic" */
      function lastNameOf(n: string): string {
        const parts = n.trim().split(" ");
        return (parts[parts.length - 1].endsWith(".")
          ? parts[0]
          : parts[parts.length - 1]
        ).toLowerCase();
      }

      function applyTennisOdds(prev: TennisMatch[]): TennisMatch[] {
        return prev.map((m) => {
          const p1 = lastNameOf(m.player1.name);
          const p2 = lastNameOf(m.player2.name);
          const ev = events.find((e) => {
            const h = lastNameOf(e.homeTeam);
            const a = lastNameOf(e.awayTeam);
            return (h === p1 && a === p2) || (h === p2 && a === p1);
          });
          if (!ev) return m;
          const odds = extractH2HOdds(ev);
          if (!odds) return m;
          const homeIsP1 = lastNameOf(ev.homeTeam) === p1;
          return {
            ...m,
            player1: { ...m.player1, bet365Odds: homeIsP1 ? odds.home : odds.away },
            player2: { ...m.player2, bet365Odds: homeIsP1 ? odds.away : odds.home },
          };
        });
      }

      setTennisLive(applyTennisOdds);
      setTennisUpcoming(applyTennisOdds);
    });
  }, [sport]);

  function openGameSheet(gameId: string) {
    setAddSheet({ open: true, gameId });
  }

  return (
    <div className="flex flex-col min-h-screen pb-24" style={{ background: "#0A0E0C" }}>
      {/* Header */}
      <div className="sticky top-0 z-40 px-4 pt-12 pb-3"
        style={{ background: "rgba(10,14,12,0.88)", backdropFilter: "blur(16px)", borderBottom: "1px solid #283323" }}>
        <SportSelector />
      </div>

      <div className="flex-1 overflow-y-auto">
        {sport === "hockey" ? (
          <div className="px-4 py-4 flex flex-col gap-6">
            {/* Live Games */}
            {liveGames.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                  <h2 className="text-white text-sm font-bold uppercase tracking-wider">{t("home.liveNow")}</h2>
                </div>
                <div className="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4 snap-x">
                  {liveGames.map((g) => (
                    <LiveGameCard key={g.id} game={g} onOpenSheet={() => openGameSheet(g.id)} />
                  ))}
                </div>
              </section>
            )}

            {/* Upcoming Games */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-white text-sm font-bold uppercase tracking-wider">{upcomingLabel}</h2>
                {loading && <div className="w-16 h-3 bg-white/5 rounded animate-pulse" />}
              </div>
              {loading ? (
                <div className="flex flex-col gap-2">
                  {[1, 2, 3].map((i) => <div key={i} className="h-20 icy-tile rounded-2xl animate-pulse" />)}
                </div>
              ) : upcomingGames.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {upcomingGames.map((g) => (
                    <UpcomingGameRow key={g.id} game={g} onOpenSheet={() => openGameSheet(g.id)} />
                  ))}
                </div>
              ) : (
                <div className="text-center py-12">
                  <p className="text-[#4a6068] text-sm">{t("home.noGames")}</p>
                </div>
              )}
            </section>

            {/* Value Bets (EV) — Pro only */}
            <EvSection isPro={isPro} items={evItems} isLoading={loading} accent={accent} />

            {/* Best Bets — Pro only */}
            <BestBetsSection
              games={[...liveGames, ...upcomingGames]}
              tennisLive={[]}
              tennisUpcoming={[]}
              sport="hockey"
              accent={accent}
              isLoading={loading}
              locked={!isPro}
            />
          </div>
        ) : (
          /* Tennis */
          <div className="px-4 py-4 flex flex-col gap-6">

            {tennisLive.length > 0 && (
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                  <h2 className="text-white text-sm font-bold uppercase tracking-wider">{t("home.liveNow")}</h2>
                </div>
                <div className="flex gap-3 overflow-x-auto pb-2 -mx-4 px-4 snap-x">
                  {tennisLive.map((m) => (
                    <TennisLiveCard key={m.id} match={m} accent={accent} />
                  ))}
                </div>
              </section>
            )}

            <section>
              <h2 className="text-white text-sm font-bold uppercase tracking-wider mb-3">{t("home.upcomingMatches")}</h2>
              {tennisLoading ? (
                <div className="flex flex-col gap-2">
                  {[1, 2, 3].map((i) => <div key={i} className="h-20 icy-tile rounded-2xl animate-pulse" />)}
                </div>
              ) : tennisUpcoming.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {tennisUpcoming.map((m) => (
                    <TennisMatchRow key={m.id} match={m} accent={accent} />
                  ))}
                </div>
              ) : (
                <div className="text-center py-12">
                  <p className="text-[#4a6068] text-sm">{t("home.noMatches")}</p>
                </div>
              )}
            </section>

            {/* Value Bets (EV) — Pro only */}
            <EvSection isPro={isPro} items={evItems} isLoading={tennisLoading} accent={accent} />

            <BestBetsSection
              games={[]}
              tennisLive={tennisLive}
              tennisUpcoming={tennisUpcoming}
              sport="tennis"
              accent={accent}
              isLoading={tennisLoading}
              locked={!isPro}
            />
          </div>
        )}

        {/* Support contact */}
        <div className="px-4 py-6 text-center">
          <a href="mailto:arakice.support@gmail.com" className="text-xs" style={{ color: "#92A08A" }}>
            {lang === "fr" ? "Besoin d'aide ? Contacte le support : " : "Need help? Contact support: "}
            <span style={{ color: "#9BF019" }}>arakice.support@gmail.com</span>
          </a>
        </div>
      </div>

      {/* Market selector sheet */}
      {addSheet.open && (
        <MarketSelectorSheet
          onClose={() => setAddSheet({ open: false })}
          preselectedSubject={
            addSheet.gameId
              ? {
                  id: addSheet.gameId,
                  type: "game",
                  name: liveGames.concat(upcomingGames).find((g) => g.id === addSheet.gameId)?.team1.abbr ?? t("home.game"),
                  logo: "",
                  subtitle: t("home.nhlGame"),
                }
              : undefined
          }
        />
      )}

      <BottomNav />
    </div>
  );
}
