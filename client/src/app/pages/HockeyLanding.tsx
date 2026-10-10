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
 *   EvSection.tsx         paris à valeur (EV), réservé aux abonnés Pro — lus au serveur
 *   BestBetsSection.tsx   Best Bets : tri, paliers de risque, cotes implicites
 *   BestParlaySection.tsx Best Parlay : combinés du serveur, repliés, chargés à l'ouverture
 *   LandingCards.tsx      en-tête de marque, pastilles de cote, cartes de match
 *
 * `HockeyLanding` reste le seul export public : `routes.tsx` est inchangé.
 */

import { useState, useEffect, useMemo, useRef } from "react";
import { useNavigate, useNavigationType } from "react-router";
import { ChevronLeft, ChevronRight, CalendarDays, Gamepad2 } from "lucide-react";
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
import { BestParlaySection } from "./landing/BestParlaySection";
import { EvSection } from "./landing/EvSection";
import { LiveGamesRow, SportSelector, UpcomingGameRow, gameIsoDay } from "./landing/LandingCards";
import { dayHeading, groupByDay } from "../data/gameDay";
import { useFoldState } from "../hooks/useFoldState";
import { TeamCarousel } from "./landing/TeamCarousel";
import { ProUpsell } from "./landing/ProUpsell";
import { AddSheetState, DisplayGame, extractSpreadOdds, toDisplayGame } from "./landing/landingTypes";


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

// ─── Navigation gardée ─────────────────────────────────────────────────────────
/**
 * Où en était le lecteur sur l'accueil (demande du user, 2026-10-06) : en
 * revenant d'un match — bouton Retour, barre du bas — il retombe sur la même
 * journée (« Matchs de demain »…) et, au Retour, à la même hauteur de page.
 *
 *   · la journée : sa DATE dans `sessionStorage` (pas son rang : après minuit,
 *     « J+1 » ne désigne plus le même soir). Une date passée ou sans match est
 *     ignorée, et l'accueil s'ouvre comme avant sur la première journée.
 *   · le défilement : en mémoire seulement, et rendu sur un Retour (POP)
 *     uniquement — toucher « Accueil » dans la barre du bas repart du haut.
 *
 * `sessionStorage` lève dans un onglet privé verrouillé : on retombe alors sur
 * le comportement d'avant, sans erreur.
 */
const DAY_KEY = "iceedge.home.day";
function readSavedDay(): string | null {
  try { return sessionStorage.getItem(DAY_KEY); } catch { return null; }
}
function writeSavedDay(date: string) {
  try { sessionStorage.setItem(DAY_KEY, date); } catch { /* stockage indisponible */ }
}
/** Hauteur de défilement de l'accueil au moment où on l'a quitté. */
let savedScrollY: number | null = null;

/** Le conteneur qui défile vraiment (celui d'`App.tsx`, pas la fenêtre). */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight) return n;
  }
  return null;
}

// ─── Main component ────────────────────────────────────────────────────────────

export function HockeyLanding() {
  const navigate = useNavigate();
  const { theme } = useSport();
  const { t, lang } = useI18n();
  const { isPro } = useSubscription();
  const accent = theme.accent;
  const [addSheet, setAddSheet] = useState<AddSheetState>({ open: false });
  // Matchs SANS cotes ; les cotes sont posées au rendu (voir `oddsEvents`).
  const [liveGamesRaw, setLiveGames] = useState<DisplayGame[]>([]);
  const [upcomingGamesRaw, setUpcomingGames] = useState<DisplayGame[]>([]);

  // Vrais prix du livre relayé (voir `oddsApiService`) — stockés à part, ils
  // n'écrasent JAMAIS la probabilité du modèle. `fetchHockeyOdds` partage sa
  // requête avec les pages Prédiction : une seule clé de cache côté proxy.
  // ⚠️ 2026-10-01 : les cotes sont gardées en état et posées AU RENDU. Avant,
  // l'effet les collait une fois sur les listes du moment — or les cotes
  // arrivent presque toujours AVANT les matchs (qui attendent le modèle) : on
  // les collait sur une liste vide, puis les matchs arrivaient sans elles, et
  // la colonne Vainqueur restait sans cote. Même perte à chaque rechargement
  // des matchs (langue, réessai).
  const [oddsEvents, setOddsEvents] = useState<Awaited<ReturnType<typeof fetchHockeyOdds>>>([]);
  useEffect(() => {
    let alive = true;
    fetchHockeyOdds().then((events) => { if (alive && events.length) setOddsEvents(events); });
    return () => { alive = false; };
  }, []);
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
  const liveGames = useMemo(() => applyOdds(liveGamesRaw, oddsEvents), [liveGamesRaw, oddsEvents]);
  const upcomingGames = useMemo(() => applyOdds(upcomingGamesRaw, oddsEvents), [upcomingGamesRaw, oddsEvents]);
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

  /**
   * Navigation par journée (demande du user, 2026-10-02) : deux flèches au
   * titre des matchs à venir, jusqu'à J+7. La semaine arrive en UNE requête
   * (`/games/range`) ; seules les journées qui ont des matchs sont des pas.
   * Les prédictions ML ne sont calculées que pour la journée AFFICHÉE (un
   * paquet ML par match, plafonné par `predictLimiter`), puis gardées.
   */
  type RawGame = Awaited<ReturnType<typeof nhlApiService.getLiveGames>>[number];
  const [gameDays, setGameDays] = useState<{ offset: number; dateStr: string; label: string; games: RawGame[] }[]>([]);
  const [dayIdx, setDayIdx] = useState(0);
  const [dayLoading, setDayLoading] = useState(false);
  const displayCache = useRef(new Map<string, DisplayGame>());
  const wantedDay = useRef(0);
  /** Au-delà de J+2, pas de cote (demande du user, 2026-10-02). */
  const dayOffset = gameDays[dayIdx]?.offset ?? 0;
  const showOdds = dayOffset <= 2;

  // En-tête qui se réduit au défilement (2026-09-27). Ce n'est pas la fenêtre
  // qui défile mais le conteneur de `App.tsx` : on écoute donc TOUS les
  // défilements en phase de capture, et on ne garde que celui d'un ancêtre de
  // l'en-tête (le bandeau des équipes, qui défile à l'horizontale, est ignoré).
  // Deux seuils (56 / 8 px) : réduire l'en-tête remonte la page, un seuil
  // unique la ferait osciller.
  const headerRef = useRef<HTMLDivElement>(null);
  const [compactHeader, setCompactHeader] = useState(false);
  // Section « matchs du jour » : dépliée au départ, puis gardée comme
  // l'utilisateur l'a laissée (2026-10-11).
  const [gamesCollapsed, toggleGames] = useFoldState("home.games", false);
  // Défilement à rendre au Retour (voir « Navigation gardée » plus haut).
  const navType = useNavigationType();
  const pendingScroll = useRef<number | null>(navType === "POP" ? savedScrollY : null);
  const lastScrollY = useRef(0);
  useEffect(() => () => { savedScrollY = lastScrollY.current; }, []);
  useEffect(() => {
    const onScroll = (e: Event) => {
      const target = e.target;
      const header = headerRef.current;
      let y: number | null = null;
      if (target === document || target === document.documentElement) y = window.scrollY || 0;
      else if (target instanceof Element && header && target.contains(header)) y = target.scrollTop;
      if (y == null) return;
      lastScrollY.current = y;
      const top = y;
      setCompactHeader((c) => (c ? top > 8 : top > 56));
    };
    document.addEventListener("scroll", onScroll, { passive: true, capture: true });
    return () => document.removeEventListener("scroll", onScroll, { capture: true });
  }, []);

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

        // Toutes les journées de la semaine qui ont des matchs ; la première
        // est celle qu'on affiche d'abord (comme avant : ce soir, sinon la
        // prochaine soirée de hockey).
        const week = days.map(({ offset, d, dateStr }) => ({
          offset,
          dateStr,
          label: offset === 0 ? t("home.tonightGames")
            : offset === 1 ? t("home.tomorrowGames")
            : t("home.gamesOn", { date: d.toLocaleDateString(locale, { weekday: "long", month: "short", day: "numeric" }) }),
          games: range.filter((g) =>
            String(g.gameDate ?? "").slice(0, 10) === dateStr &&
            ["scheduled", "live", "preview"].includes(g.status)).sort(byFaceoff),
        })).filter((x) => x.games.length > 0);
        // La journée que le lecteur regardait avant de quitter l'accueil, si
        // elle est toujours dans la semaine ; sinon la première, comme avant.
        const savedDay = readSavedDay();
        const startIdx = Math.max(0, week.findIndex((w) => w.dateStr === savedDay));
        const scheduled = week[startIdx]?.games ?? [];
        const label = week[startIdx]?.label ?? t("home.tonightGames");
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
        displayCache.current = new Map(displayed);
        setGameDays(week);
        setDayIdx(startIdx);
        wantedDay.current = startIdx;
        setDayLoading(false);
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

  // Changer de journée : ses matchs, prédictions ML comprises (cache).
  async function goToDay(idx: number) {
    const target = gameDays[idx];
    if (!target || idx === dayIdx) return;
    wantedDay.current = idx;
    setDayIdx(idx);
    setUpcomingLabel(target.label);
    writeSavedDay(target.dateStr);
    const missing = target.games.filter((g) => !displayCache.current.has(g.id));
    if (missing.length) {
      setDayLoading(true);
      const done = await Promise.all(missing.map(async (g) => [g.id, await toDisplayGame(g)] as const));
      for (const [id, dg] of done) displayCache.current.set(id, dg);
    }
    // La journée a pu changer pendant le chargement : on ne montre que la dernière demandée.
    if (wantedDay.current !== idx) return;
    setUpcomingGames(target.games.map((g) => displayCache.current.get(g.id)!).filter(Boolean));
    setDayLoading(false);
  }

  // Rendre la hauteur de page une fois les matchs affichés : avant, la page
  // n'a que des squelettes et le défilement serait borné trop haut.
  useEffect(() => {
    if (loading || dayLoading || pendingScroll.current == null) return;
    const y = pendingScroll.current;
    pendingScroll.current = null;
    requestAnimationFrame(() => {
      const el = scrollParent(headerRef.current);
      if (el) el.scrollTop = y;
      else window.scrollTo(0, y);
    });
  }, [loading, dayLoading]);

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
              <div className={`flex items-center justify-between ${gamesCollapsed ? "" : "mb-3"}`}>
                {/* Repliable comme Meilleurs paris (2026-10-11), état gardé en mémoire. */}
                <button
                  type="button"
                  onClick={toggleGames}
                  aria-expanded={!gamesCollapsed}
                  title={gamesCollapsed ? t("home.show") : t("home.hide")}
                  className="h-8 flex items-center gap-2 select-none min-w-0"
                >
                  <ChevronRight
                    size={14}
                    className="text-[#8a9ea6] transition-transform shrink-0"
                    style={{ transform: gamesCollapsed ? "rotate(0deg)" : "rotate(90deg)" }}
                  />
                  <h2 className="text-white text-sm font-bold uppercase tracking-wider truncate">{upcomingLabel}</h2>
                </button>
                {/* h-8 : même hauteur que les flèches, sinon le titre grandit de 12 px à
                    l'arrivée des matchs et pousse la liste (CLS, PSI mobile 2026-10-06). */}
                {gamesCollapsed ? null : loading ? <div className="h-8 flex items-center"><div className="w-16 h-3 bg-white/5 rounded animate-pulse" /></div> : gameDays.length > 1 && (
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => goToDay(dayIdx - 1)}
                      disabled={dayIdx === 0}
                      aria-label={t("home.prevDay")}
                      className="tap-44 w-8 h-8 rounded-full border border-white/15 bg-white/[0.06] text-white flex items-center justify-center active:scale-95 transition-transform disabled:opacity-30 disabled:active:scale-100"
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <button
                      onClick={() => goToDay(dayIdx + 1)}
                      disabled={dayIdx >= gameDays.length - 1}
                      aria-label={t("home.nextDay")}
                      className="tap-44 w-8 h-8 rounded-full border border-white/15 bg-white/[0.06] text-white flex items-center justify-center active:scale-95 transition-transform disabled:opacity-30 disabled:active:scale-100"
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                )}
              </div>
              {gamesCollapsed ? null : loading || dayLoading ? (
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
                        <UpcomingGameRow key={g.id} game={g} showOdds={showOdds} onOpenSheet={() => openGameSheet(g.id)} />
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

          </div>

          <div className="rink-line rink-line--blue" aria-hidden />

          {/* ── Centre ice: whoever is playing right now ───────────────── */}
          {/* The red line and the faceoff circle are decoration behind the
              cards. 2026-10-04 (demande du user) : sans match en direct, la
              section n'est plus affichée du tout — plus de cercle vide avec
              « aucun match en direct ». Même chose pendant le chargement et
              en cas d'échec : la section du haut porte déjà l'erreur et son
              bouton « Réessayer ». */}
          {liveGames.length > 0 && (
            <section className="relative px-4 py-12">
              <div className="rink-line rink-line--red absolute inset-x-0 top-1/2 -translate-y-1/2" aria-hidden />
              <div className="rink-faceoff" aria-hidden />

              <div className="relative z-10">
                <div className="flex items-center justify-center gap-2 mb-4">
                  <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                  <h2 className="text-white text-sm font-bold uppercase tracking-wider">{t("home.liveNow")}</h2>
                </div>
                {/* Flèches + glissement au doigt (2026-09-30), comme le
                    bandeau des équipes — voir `LiveGamesRow`. */}
                <LiveGamesRow games={liveGames} />
              </div>
            </section>
          )}

          {/* Calendrier — un panneau de bande, pas une tuile givrée : c'est de
              la navigation, il ne doit pas se lire comme une carte de match de
              plus. Déplacé SOUS les matchs en direct et resserré dans la
              gouttière de la page, bouton en bleu pâle (demande du user,
              2026-09-30) ; il courait avant d'un bord à l'autre, sous les
              matchs à venir. */}
          {/* Sans la section « en direct » au-dessus, le calendrier reprend
              l'espace sous la ligne bleue. */}
          <div className={`px-4 pb-8 ${liveGames.length > 0 ? "" : "pt-8"}`}>
            <LazySection minHeight={72}>
              <button
                onClick={() => navigate("/schedule")}
                className="rink-signboard rounded-2xl w-full"
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

          {/* ── Defensive zone: the model's picks ──────────────────────── */}
          {/* 2026-09-27 : pour un abonné, Meilleurs paris PUIS Value bets. Pour
              les autres, UN seul gros bloc « Passer à Pro » qui regroupe les
              deux, au lieu de deux sections floutées l'une sous l'autre. */}
          <div className="px-4 py-4 flex flex-col gap-6">
            {/* Best Parlay (2026-10-04) — AU-DESSUS de Meilleurs paris, pour
                tout le monde : deux combinés gratuits, les autres Pro (le
                serveur tranche). Repliée, et sans aucune requête tant qu'on
                ne l'ouvre pas : pas besoin de `LazySection`. Elle porte le
                `px-4` de `BestBetsSection` et s'aligne donc sur elle ; pour
                un non-abonné, c'est `ProUpsell` (sans `px-4`) qui suit. */}
            <div className={isPro ? undefined : "-mx-4"}>
              <BestParlaySection accent={accent} />
            </div>
            {isPro ? (
              <>
                <LazySection minHeight={360}>
                  <BestBetsSection accent={accent} isLoading={loading} locked={false} />
                </LazySection>
                <LazySection minHeight={180}>
                  <EvSection accent={accent} />
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

/** Pose les prix du livre sur les matchs, sans toucher aux probabilités du modèle. */
function applyOdds(games: DisplayGame[], events: Awaited<ReturnType<typeof fetchHockeyOdds>>): DisplayGame[] {
  if (!events.length) return games;
  return games.map((g) => {
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
