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
import { ChevronRight, CalendarDays, Gamepad2 } from "lucide-react";
import { BottomNav } from "../components/BottomNav";
import { MarketSelectorSheet } from "../components/MarketSelectorSheet";
import { ErrorState } from "../components/ErrorState";
import { nhlApiService } from "../services/nhlApiService";
import { useSport } from "../context/SportContext";
import { useSubscription } from "../context/SubscriptionContext";
import { useI18n } from "../i18n";
import { extractH2HOdds } from "../services/oddsApiService";
import { fetchHockeyOdds, findOddsEvent } from "../services/gameOdds";
import "../components/home-theme.css";
import "../components/rink-theme.css";
import { BestBetsSection } from "./landing/BestBetsSection";
import { EvItem, EvSection } from "./landing/EvSection";
import { LiveGameCard, SportSelector, UpcomingGameRow, gameIsoDay } from "./landing/LandingCards";
import { dayHeading, groupByDay } from "../data/gameDay";
import { TeamCarousel } from "./landing/TeamCarousel";
import { ProUpsell } from "./landing/ProUpsell";
import { AddSheetState, DisplayGame, calcEdge, extractSpreadOdds, toDisplayGame } from "./landing/landingTypes";


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
  // `topPredictions` supprimé le 2026-08-29 : cet état était alimenté mais
  // JAMAIS rendu, et il portait un `trend: "+2%"` écrit en dur — une variation
  // inventée qui n'attendait qu'un composant pour s'afficher.
  const [loading, setLoading] = useState(true);
  /**
   * L'échec, gardé À PART des listes vides.
   *
   * Jusqu'ici le `catch` du chargement remettait les deux listes à `[]` et
   * l'accueil affichait « aucun match ce soir » : un réseau coupé était rendu
   * comme une soirée sans hockey, ce qui est faux et n'offre aucun recours.
   */
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [upcomingLabel, setUpcomingLabel] = useState(() => t("home.tonightGames"));

  // En-tête qui se réduit au défilement (2026-09-27). Ce n'est pas la fenêtre
  // qui défile mais le conteneur de `App.tsx` : on écoute donc TOUS les
  // défilements en phase de capture, et on ne garde que celui d'un ancêtre de
  // l'en-tête (le bandeau des équipes, qui défile à l'horizontale, est ignoré).
  // Deux seuils (56 / 8 px) : réduire l'en-tête remonte la page, un seuil
  // unique la ferait osciller.
  const headerRef = useRef<HTMLDivElement>(null);
  const [compactHeader, setCompactHeader] = useState(false);
  useEffect(() => {
    const onScroll = (e: Event) => {
      const target = e.target;
      const header = headerRef.current;
      let y: number | null = null;
      if (target === document || target === document.documentElement) y = window.scrollY || 0;
      else if (target instanceof Element && header && target.contains(header)) y = target.scrollTop;
      if (y == null) return;
      const top = y;
      setCompactHeader((c) => (c ? top > 8 : top > 56));
    };
    document.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => document.removeEventListener("scroll", onScroll, { capture: true });
  }, []);

  // Value bets (+EV): model probability beats the bookmaker's implied probability.
  // Only meaningful when real bookmaker odds are present.
  const evItems: EvItem[] = useMemo(() => {
    const out: EvItem[] = [];
    for (const g of [...liveGames, ...upcomingGames]) {
        // Sans probabilité du modèle il n'y a pas d'edge à calculer : le match
        // est simplement absent de la liste +EV.
        const homePct = g.team1.winPct;
        const awayPct = g.team2.winPct;
        if (g.bookHome && homePct != null) {
          const edge = calcEdge(homePct, g.bookHome);
          if (edge >= 5) out.push({ id: `ev-${g.id}-h`, logo: g.team1.logo, label: `${g.team1.abbr} ML vs ${g.team2.abbr}`, context: t("home.evSpot"), pct: homePct, edge });
        }
        if (g.bookAway && awayPct != null) {
          const edge = calcEdge(awayPct, g.bookAway);
          if (edge >= 5) out.push({ id: `ev-${g.id}-a`, logo: g.team2.logo, label: `${g.team2.abbr} ML vs ${g.team1.abbr}`, context: t("home.evSpot"), pct: awayPct, edge });
        }
      }
    return out.sort((a, b) => b.edge - a.edge).slice(0, 6);
  }, [liveGames, upcomingGames, t]);

  // Load NHL games + model predictions
  //
  // Les huit jours (J…J+7) arrivent en UNE requête `/games/range`, lancée en
  // même temps que `/games/live`. Avant le 2026-09-16, la boucle demandait
  // `/games?date=` jour par jour, en série : hors saison, 8 requêtes par visite
  // de l'accueil — et la boucle continuait après qu'on avait quitté la page,
  // faute de garde. `cancelled` ferme les deux.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    async function load() {
      try {
        const locale = lang === "fr" ? "fr-CA" : "en-US";
        const days = Array.from({ length: 8 }, (_, offset) => {
          const d = new Date();
          d.setDate(d.getDate() + offset);
          return { offset, d, dateStr: d.toISOString().split("T")[0] };
        });
        const [live, range] = await Promise.all([
          nhlApiService.getLiveGames(),
          nhlApiService.getGamesRange(days[0].dateStr, days[days.length - 1].dateStr),
        ]);
        if (cancelled) return;

        // Mise au jeu la plus PROCHE en premier. L'ordre venait de l'amont
        // (trié par date puis par identifiant de match) : à l'intérieur d'une
        // journée, un match de 22 h pouvait passer devant celui de 19 h.
        const byFaceoff = (a: (typeof live)[number], b: (typeof live)[number]) => {
          const ms = (g: (typeof live)[number]) => {
            const iso = g.startTimeUTC ? new Date(g.startTimeUTC).getTime() : NaN;
            return Number.isFinite(iso) ? iso : Number.MAX_SAFE_INTEGER;
          };
          const d = ms(a) - ms(b);
          return d !== 0 ? d : String(a.id).localeCompare(String(b.id));
        };

        let scheduled: typeof live = [];
        let label = t("home.tonightGames");
        for (const { offset, d, dateStr } of days) {
          scheduled = range.filter((g) =>
            String(g.gameDate ?? "").slice(0, 10) === dateStr &&
            ["scheduled", "live", "preview"].includes(g.status)).sort(byFaceoff);
          if (scheduled.length > 0) {
            if (offset === 1) label = t("home.tomorrowGames");
            else if (offset > 1) label = t("home.gamesOn", { date: d.toLocaleDateString(locale, { weekday: "long", month: "short", day: "numeric" }) });
            break;
          }
        }
        // Un match EN DIRECT figure dans les deux listes (`scheduled` garde le
        // statut "live" exprès, pour la liste du soir). Ses deux prédictions
        // (`POST /predict/single` moneyline + total, non cacheables) partaient
        // donc deux fois : 26 appels pour 18 matchs distincts, mesuré le
        // 2026-09-16. On calcule chaque match UNE fois, puis on range le même
        // résultat dans chaque liste — l'affichage ne change pas.
        const unique = new Map<string, (typeof live)[number]>();
        for (const g of [...live, ...scheduled]) if (!unique.has(g.id)) unique.set(g.id, g);
        const displayed = new Map(
          await Promise.all(
            [...unique.values()].map(async (g) => [g.id, await toDisplayGame(g)] as const),
          ),
        );
        if (cancelled) return;
        setLiveGames(live.map((g) => displayed.get(g.id)!));
        setUpcomingGames(scheduled.map((g) => displayed.get(g.id)!));
        setUpcomingLabel(label);
      } catch (err) {
        if (cancelled) return;
        console.error("[HockeyLanding] Failed to load games:", err);
        setLiveGames([]);
        setUpcomingGames([]);
        setLoadError(err ?? new Error("landing load failed"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [lang, reloadKey]);

  // Vrais prix du livre relayé (voir `oddsApiService`) — stockés à part, ils
  // n'écrasent JAMAIS la probabilité du modèle. `fetchHockeyOdds` partage sa
  // requête avec les pages Prédiction : une seule clé de cache côté proxy.
  useEffect(() => {
    fetchHockeyOdds().then((events) => {
      if (!events.length) return;

      // ⚠️ L'appariement se faisait sur « domicile OU extérieur », et par
      // `includes` d'ABRÉVIATION dans le nom complet. Deux défauts distincts :
      //
      //   • le OU suffisait à apparier deux affiches différentes du même soir —
      //     il suffisait que l'un des deux côtés corresponde — et collait alors
      //     le prix du mauvais match sur la carte ;
      //   • le `includes` ne marchait que par accident : « tor » se trouve dans
      //     « toronto », mais « nyr » n'est dans aucun mot de « New York
      //     Rangers », « tbl » dans aucun de « Tampa Bay Lightning », « vgk »
      //     dans aucun de « Vegas Golden Knights ». Ces équipes-là n'ont jamais
      //     reçu de cote, en silence.
      //
      // `findOddsEvent` compare les noms complets, des deux côtés, et refuse le
      // reste — mieux vaut pas de prix qu'un prix qui n'est pas celui du match.
      function applyOdds(prev: DisplayGame[]): DisplayGame[] {
        return prev.map((g) => {
          const ev = findOddsEvent(events, g.team1.name, g.team2.name);
          if (!ev) return g;
          const odds = extractH2HOdds(ev);
          // Handicap ±1.5 du livre, pour la colonne « Handicap » de la ligne.
          const bookSpread = extractSpreadOdds(ev, g.team1.name, g.team2.name);
          if (!odds && !bookSpread) return g;
          return {
            ...g,
            ...(odds ? { bookHome: odds.home, bookAway: odds.away } : {}),
            ...(bookSpread ? { bookSpread } : {}),
          };
        });
      }

      setLiveGames(applyOdds);
      setUpcomingGames(applyOdds);

    });
  }, []);

  function openGameSheet(gameId: string) {
    setAddSheet({ open: true, gameId });
  }

  // Largeur : même gabarit que StatsPage (max-w-[430px] md:max-w-5xl), qui est
  // la mesure de référence de l'app. L'accueil était la seule page à courir
  // pleine largeur — sur grand écran elle se lisait comme un autre produit.
  return (
    <div className="flex flex-col min-h-screen pb-[calc(6rem+env(safe-area-inset-bottom,0px))] max-w-[430px] md:max-w-5xl mx-auto w-full" style={{ background: "#0A0E0C" }}>
      {/* Header — the only top padding is env(safe-area-inset-top), which is 0
          in a browser and only grows on a notched device. */}
      <div ref={headerRef} className="sticky top-0 z-40"
        style={{ background: "rgba(10,14,12,0.88)", backdropFilter: "blur(16px)", paddingTop: "env(safe-area-inset-top, 0px)" }}>
        <div
          className="px-4"
          style={{
            paddingTop: compactHeader ? 6 : 12,
            paddingBottom: compactHeader ? 6 : 12,
            transition: "padding 0.25s ease",
          }}
        >
          <SportSelector compact={compactHeader} />
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
            {/* All 32 teams — square tiles, arrows + swipe + slow auto-scroll */}
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
              ) : loadError ? (
                /* Le bouton relance TOUT le chargement de l'accueil, matchs en
                   direct compris — d'où l'absence d'un second bouton plus bas. */
                <ErrorState error={loadError} onRetry={() => setReloadKey((k) => k + 1)} compact />
              ) : upcomingGames.length > 0 ? (
                /* Un titre par journée au-dessus de ses matchs : la section
                   peut porter aujourd'hui ET demain, et l'heure seule ne dit
                   pas de quel soir on parle. */
                <div className="flex flex-col gap-4">
                  {groupByDay(upcomingGames, gameIsoDay).map(({ day, items }) => (
                    <div key={day || "unknown"} className="flex flex-col gap-2">
                      {day && (
                        <h3 className="text-[#bfc8cc] text-[11px] font-bold uppercase tracking-wider">
                          {dayHeading(day, lang)}
                        </h3>
                      )}
                      {items.map((g) => (
                        <UpcomingGameRow key={g.id} game={g} onOpenSheet={() => openGameSheet(g.id)} />
                      ))}
                    </div>
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
                      <LiveGameCard key={`${g.id}-${i}`} game={g} onOpenSheet={() => openGameSheet(g.id)} />
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3 py-14">
                  <span className="rink-faceoff-dot" />
                  {/* Même placeholder, autre phrase : quand le chargement a
                      échoué, « aucun match en direct » serait faux. Pas de
                      bouton ici — celui de la section du haut recharge les
                      deux, et deux boutons pour la même action se piétinent. */}
                  <p className="text-[#7f97a3] text-xs">
                    {loadError ? t("common.loadFailed") : t("home.noLiveGames")}
                  </p>
                </div>
              )}
            </div>
          </section>

          <div className="rink-line rink-line--blue" aria-hidden />

          {/* ── Defensive zone: the model's picks ──────────────────────── */}
          {/* 2026-09-27 : pour un abonné, Meilleurs paris PUIS Value bets. Pour
              les autres, UN seul gros bloc « Passer à Pro » qui regroupe les
              deux, au lieu de deux sections floutées l'une sous l'autre. */}
          <div className="px-4 py-4 flex flex-col gap-6">
            {isPro ? (
              <>
                <LazySection minHeight={360}>
                  <BestBetsSection accent={accent} isLoading={loading} locked={false} />
                </LazySection>
                <LazySection minHeight={180}>
                  <EvSection isPro items={evItems} isLoading={loading} accent={accent} />
                </LazySection>
              </>
            ) : (
              <LazySection minHeight={300}>
                <ProUpsell accent={accent} />
              </LazySection>
            )}
          </div>

          {/* Aucun argent réel — tout en bas de la page (2026-09-28). */}
          <div className="px-4 pb-4 flex justify-center">
            <p className="flex items-start gap-2 text-[11px] leading-snug text-[#8a9ea6] max-w-[420px]">
              <Gamepad2 size={14} className="flex-shrink-0 mt-px" style={{ color: "#86d1ea" }} />
              <span>
                <span className="font-bold text-[#bfc8cc]">{t("home.noRealMoney")}</span>{" "}
                {t("home.noRealMoneyHint")}
              </span>
            </p>
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
