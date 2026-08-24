/**
 * HockeyLanding.tsx — page d'accueil.
 *
 * Ce fichier faisait 1468 lignes ; il a été découpé le 2026-08-10 en 5 fichiers
 * (`./landing/`) sans toucher une ligne de code — seuls les imports et les
 * `export` ont été ajoutés. Il ne reste ici que l'assemblage des sections et
 * `LazySection`, qui diffère le montage de chacune jusqu'à ce qu'elle approche
 * du viewport.
 *
 *   landingTypes.ts       DisplayGame et conversions
 *   EvSection.tsx         paris à valeur (EV), réservé aux abonnés Pro
 *   BestBetsSection.tsx   Best Bets : tri, paliers de risque, cotes implicites
 *   LandingCards.tsx      en-tête de marque, pastilles de cote, cartes de match
 *
 * `HockeyLanding` reste le seul export public : `routes.tsx` est inchangé.
 */

import { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router";
import { ChevronRight, CalendarDays } from "lucide-react";
import { BottomNav } from "../components/BottomNav";
import { MarketSelectorSheet } from "../components/MarketSelectorSheet";
import { nhlApiService } from "../services/nhlApiService";
import { useSport } from "../context/SportContext";
import { useSubscription } from "../context/SubscriptionContext";
import { useI18n } from "../i18n";
import { fetchBet365Odds, extractH2HOdds, ODDS_SPORT_KEYS } from "../services/oddsApiService";
import "../components/home-theme.css";
import "../components/rink-theme.css";
import { BestBetsSection } from "./landing/BestBetsSection";
import { EvItem, EvSection } from "./landing/EvSection";
import { LiveGameCard, SportSelector, UpcomingGameRow } from "./landing/LandingCards";
import { TeamCarousel } from "./landing/TeamCarousel";
import { AddSheetState, DisplayGame, calcEdge, toDisplayGame } from "./landing/landingTypes";


// ─── Lazy section ───────────────────────────────────────────────────────────
// Defers a section's rendering (and any data-fetching it does on mount) until it
// scrolls near the viewport, so the home page reveals one section at a time
// instead of mounting and loading everything at once.
function LazySection({ children, minHeight = 200 }: { children: React.ReactNode; minHeight?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") { setShow(true); return; }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) { setShow(true); io.disconnect(); }
      },
      { rootMargin: "200px" }, // start loading just before it comes into view
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} style={show ? undefined : { minHeight }}>
      {show ? children : <div className="icy-tile rounded-2xl animate-pulse" style={{ height: minHeight }} />}
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export function HockeyLanding() {
  const navigate = useNavigate();
  const { theme } = useSport();
  const { t, lang } = useI18n();
  const { isPro } = useSubscription();
  const accent = theme.accent;
  const [addSheet, setAddSheet] = useState<AddSheetState>({ open: false });
  const [liveGames, setLiveGames] = useState<DisplayGame[]>([]);
  const [upcomingGames, setUpcomingGames] = useState<DisplayGame[]>([]);
  const [topPredictions, setTopPredictions] = useState<{ teamLogo: string; team: string; label: string; pct: number; trend: string; edge: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [upcomingLabel, setUpcomingLabel] = useState(() => t("home.tonightGames"));

  // Value bets (+EV): model probability beats the bookmaker's implied probability.
  // Only meaningful when real bet365 odds are present (VITE_ODDS_API_KEY set).
  const evItems: EvItem[] = useMemo(() => {
    const out: EvItem[] = [];
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
    return out.sort((a, b) => b.edge - a.edge).slice(0, 6);
  }, [liveGames, upcomingGames, t]);

  // Load NHL games + model predictions
  useEffect(() => {
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
        const allDisplay = [...liveDisplay, ...upcomingDisplay];
        setTopPredictions(
          allDisplay
            .sort((a, b) => b.team1.winPct - a.team1.winPct)
            .slice(0, 3)
            .map((g) => ({
              teamLogo: g.team1.logo,
              team: g.team1.abbr,
              label: `Win vs ${g.team2.abbr}`,
              pct: g.team1.winPct,
              trend: "+2%",
              edge: g.bet365Home ? calcEdge(g.team1.winPct, g.bet365Home) : 0,
            }))
        );
      } catch (err) {
        console.error("[HockeyLanding] Failed to load games:", err);
        setLiveGames([]);
        setUpcomingGames([]);
        setTopPredictions([]);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [lang]);

  // Overlay real Bet365 odds — stored separately, does NOT overwrite model winPct
  useEffect(() => {
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

      // Recalculate top predictions with edge now that odds are available
      setTopPredictions((prev) =>
        prev.map((p) => {
          // Find matching event by team abbr
        
          const ev = events.find((e) => e.homeTeam?.toLowerCase().includes(p.team.toLowerCase()));
          if (!ev) return p;
          const odds = extractH2HOdds(ev);
          if (!odds) return p;
          return { ...p, edge: calcEdge(p.pct, odds.home) };
        })
      );
    });
  }, []);

  function openGameSheet(gameId: string) {
    setAddSheet({ open: true, gameId });
  }

  // Largeur : même gabarit que StatsPage (max-w-[430px] md:max-w-5xl), qui est
  // la mesure de référence de l'app. L'accueil était la seule page à courir
  // pleine largeur — sur grand écran elle se lisait comme un autre produit.
  return (
    <div className="flex flex-col min-h-screen pb-24 max-w-[430px] md:max-w-5xl mx-auto w-full" style={{ background: "#0A0E0C" }}>
      {/* Header — the boards are the very first thing on the page: nothing sits
          above them. The only top padding is env(safe-area-inset-top), which is
          0 in a browser and only grows on a notched device, where the boards
          would otherwise be hidden under the status bar. */}
      <div className="sticky top-0 z-40"
        style={{ background: "rgba(10,14,12,0.88)", backdropFilter: "blur(16px)", paddingTop: "env(safe-area-inset-top, 0px)" }}>
        <div className="rink-boards" aria-hidden />
        <div className="px-4 pt-3 pb-3">
          <SportSelector />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* The page is laid out as a rink: boards above, then the sheet, cut by
            a blue line, centre ice (red line + faceoff circle), a second blue
            line, and boards again at the foot. Everything that was already on
            the home page still lives inside the sheet. */}
        <div className="rink-ice">

          {/* ── Offensive zone: teams + tonight's slate ────────────────── */}
          <div className="px-4 py-4 flex flex-col gap-6">
            {/* All 32 teams — jerseys scrolling right → left, 6 at a time */}
            <TeamCarousel />

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

            {/* Game calendar — a board ad panel, not a frosted tile: it is
                navigation, and must not read as one more game card. Full-bleed
                (-mx-4 + the matching width) so it closes the offensive zone. */}
            <LazySection minHeight={72}>
              <button
                onClick={() => navigate("/schedule")}
                className="rink-signboard -mx-4"
                style={{ width: "calc(100% + 2rem)" }}
              >
                <span className="rink-signboard-icon">
                  <CalendarDays size={18} />
                </span>
                <span className="rink-signboard-text">
                  <span className="rink-signboard-kicker">{t("schedule.subtitle")}</span>
                  <span className="rink-signboard-label">{t("home.schedule")}</span>
                </span>
                <span className="rink-signboard-cta">
                  {t("home.scheduleCta")}
                  <ChevronRight size={13} />
                </span>
              </button>
            </LazySection>
          </div>

          <div className="rink-line rink-line--blue" aria-hidden />

          {/* ── Centre ice: whoever is playing right now ───────────────── */}
          {/* The red line and the faceoff circle are decoration behind the
              cards; when nothing is live the circle stays empty, with just the
              faceoff dot in it. */}
          <section className="relative px-4 py-12">
            <div className="rink-line rink-line--red absolute inset-x-0 top-1/2 -translate-y-1/2" aria-hidden />
            <div className="rink-faceoff" aria-hidden />

            <div className="relative z-10">
              <div className="flex items-center justify-center gap-2 mb-4">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                <h2 className="text-white text-sm font-bold uppercase tracking-wider">{t("home.liveNow")}</h2>
              </div>

              {liveGames.length > 0 ? (
                /* Same right → left marquee as the jersey carousel: no
                   scrollbar, pauses on hover. Cards are 280px + a 12px gutter,
                   scrolled at ~34px/s, with a floor so a single game doesn't
                   whip past. */
                <div
                  className="ice-marquee -mx-4"
                  style={
                    {
                      "--ice-duration": `${Math.max(18, Math.round((liveGames.length * 292) / 34))}s`,
                    } as React.CSSProperties
                  }
                >
                  <div className="ice-marquee-track">
                    {[...liveGames, ...liveGames].map((g, i) => (
                      <LiveGameCard key={`${g.id}-${i}`} game={g} onOpenSheet={() => openGameSheet(g.id)} accent={accent} />
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3 py-14">
                  <span className="rink-faceoff-dot" />
                  <p className="text-[#7f97a3] text-xs">{t("home.noLiveGames")}</p>
                </div>
              )}
            </div>
          </section>

          <div className="rink-line rink-line--blue" aria-hidden />

          {/* ── Defensive zone: the model's picks ──────────────────────── */}
          <div className="px-4 py-4 flex flex-col gap-6">
            {/* Value Bets (EV) — Pro only */}
            <LazySection minHeight={180}>
              <EvSection isPro={isPro} items={evItems} isLoading={loading} accent={accent} />
            </LazySection>

            {/* Best Bets — Pro only */}
            <LazySection minHeight={360}>
              <BestBetsSection
                games={[...liveGames, ...upcomingGames]}
                accent={accent}
                isLoading={loading}
                locked={!isPro}
              />
            </LazySection>
          </div>

          {/* Foot of the page: the boards close the rink */}
          <div className="rink-boards rink-boards--bottom" aria-hidden />
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
