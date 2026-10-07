/**
 * SchedulePage — calendrier des matchs de la saison NHL.
 *
 * Deux niveaux de sélection :
 *   1. Mois  (flèches ‹ ›) — borné à la fenêtre de saison de l'API.
 *   2. Semaine (rangée de boutons sous le mois) — chaque bouton = 1er jour d'une
 *      semaine du mois. On ne charge QUE la semaine sélectionnée (lazy), pas
 *      tout le mois d'un coup.
 *
 * Un clic sur un match ouvre sa page de prédiction (/stats/prediction/game/:id).
 * Chaque match à venir porte la barre du vainqueur prédit par le modèle ML
 * (2026-09-29), glissée sous l'heure : la carte garde sa taille.
 * Bornes/mois par défaut ancrés à la date réelle de l'API (getScheduleAnchor),
 * pas à l'horloge locale.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { BottomNav } from "../components/BottomNav";
import { nhlApiService } from "../services/nhlApiService";
import type { NHLGame, NHLTeamStats } from "../types/bet";
import { predictionApiService, type ApiBestBet } from "../services/predictionApiService";
import { useSubscription } from "../context/SubscriptionContext";
import { nhlLogoUrl } from "../data/teamEmoji";
import { useI18n } from "../i18n";
import { ErrorState } from "../components/ErrorState";
import { MoneylineBar, useGameMl } from "./landing/LandingCards";
import "../components/rink-theme.css";

const ACCENT = "#86d1ea";

// ── Helpers de dates ('YYYY-MM-DD', heure locale) ────────────────────────────
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const isoLocal = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDaysLocal = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + n);
  return isoLocal(d);
};
const dowMon = (date: string) => (new Date(`${date}T00:00:00`).getDay() + 6) % 7; // 0 = lundi
const monthIndex = (y: number, m: number) => y * 12 + m;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;
const todayIso = () => new Date().toISOString().slice(0, 10);
const safeDate = (d: string) => (isoDate.test(d) ? d : todayIso());
const fromIdx = (idx: number): YM => ({ y: Math.floor(idx / 12), m: ((idx % 12) + 12) % 12 });

type YM = { y: number; m: number };
type Bounds = { first: YM; last: YM };
type Week = { start: string; end: string };

function monthOf(date: string): YM {
  const [y, m] = safeDate(date).split("-").map(Number);
  return { y, m: m - 1 };
}

// Fenêtre de navigation : ~1 an de chaque côté de l'ancre (élargie ensuite si la
// saison réelle déborde), pour atteindre librement n'importe quel mois.
const MONTHS_EACH_SIDE = 12;
function windowAround(date: string): Bounds {
  const { y, m } = monthOf(date);
  const c = monthIndex(y, m);
  return { first: fromIdx(c - MONTHS_EACH_SIDE), last: fromIdx(c + MONTHS_EACH_SIDE) };
}

/** Mois d'ouverture : le mois de `date`, sauf en intersaison (juil.–sept.) où
 *  l'on saute au coup d'envoi (octobre) pour tomber sur des matchs. */
function defaultMonth(date: string, b: Bounds): YM {
  const { y, m } = monthOf(date);
  const target = m >= 6 && m <= 8 ? monthIndex(y, 9) : monthIndex(y, m);
  return clampCursor(target, b);
}

const clampCursor = (idx: number, b: Bounds): YM => {
  const min = monthIndex(b.first.y, b.first.m);
  const max = monthIndex(b.last.y, b.last.m);
  return fromIdx(Math.min(Math.max(idx, min), max));
};

/** Découpe un mois en semaines (lundi→dimanche), 1re/dernière tronquées au mois. */
function buildWeeks(y: number, m: number): Week[] {
  const last = iso(y, m, new Date(y, m + 1, 0).getDate());
  const weeks: Week[] = [];
  let s = iso(y, m, 1);
  while (s <= last) {
    let e = addDaysLocal(s, 6 - dowMon(s)); // dimanche de cette semaine
    if (e > last) e = last;
    weeks.push({ start: s, end: e });
    s = addDaysLocal(e, 1);
  }
  return weeks;
}

/**
 * Où en était le lecteur dans le calendrier : le mois affiché et la semaine
 * qu'il a CHOISIE (demande du user, 2026-10-06). Gardé dans `sessionStorage`,
 * comme l'onglet des Statistiques : en revenant d'un match — bouton Retour,
 * barre du bas — on retombe sur la même page du calendrier au lieu de la
 * semaine en cours. Partagé entre la page Calendrier et l'onglet « Par match »
 * des Statistiques, qui montrent le même `ScheduleContent`.
 *
 * `week` n'est posée que par un CHOIX (toucher une semaine, ou la restauration
 * elle-même), jamais par la semaine par défaut : sinon l'ancre de l'API, qui
 * arrive après le premier rendu, ne pourrait plus corriger le défaut.
 *
 * `sessionStorage` lève dans un onglet privé verrouillé : on retombe alors sur
 * le comportement d'avant, sans erreur.
 */
const NAV_KEY = "iceedge.schedule.nav";
type SavedNav = { y: number; m: number; week: string | null };
function readNav(): SavedNav | null {
  try {
    const raw = sessionStorage.getItem(NAV_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!Number.isInteger(v?.y) || !Number.isInteger(v?.m) || v.m < 0 || v.m > 11) return null;
    return { y: v.y, m: v.m, week: typeof v.week === "string" && isoDate.test(v.week) ? v.week : null };
  } catch { return null; }
}
function writeNav(nav: SavedNav) {
  try { sessionStorage.setItem(NAV_KEY, JSON.stringify(nav)); } catch { /* stockage indisponible */ }
}

export function SchedulePage() {
  const navigate = useNavigate();
  const { t } = useI18n();

  return (
    <div className="flex flex-col min-h-screen pb-[calc(6rem+env(safe-area-inset-bottom,0px))] max-w-[430px] md:max-w-5xl mx-auto w-full" style={{ background: "#0A0E0C" }}>
      {/* Header */}
      <header
        className="sticky top-0 z-40"
        style={{ background: "rgba(10,14,12,0.92)", backdropFilter: "blur(16px)", paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <div className="px-4 pt-3 pb-3 flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            aria-label="Back"
            className="min-w-[44px] min-h-[44px] w-9 h-9 rounded-xl bg-[#131A12] border border-white/20 flex items-center justify-center flex-shrink-0"
            style={{ color: ACCENT }}
          >
            <ChevronLeft size={18} />
          </button>
          <div className="flex-1 min-w-0">
            <h1
              className="text-white text-xl font-bold uppercase leading-tight"
              style={{ fontFamily: "'Oswald', 'Arial Narrow', sans-serif" }}
            >
              {t("schedule.title")}
            </h1>
            <p className="text-[#8a9ea6] text-[11px]">{t("schedule.subtitle")}</p>
          </div>
        </div>
      </header>

      {/* Contenu — calendrier mois/semaine + matchs */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <ScheduleContent />
      </div>

      <BottomNav />
    </div>
  );
}

/**
 * ScheduleContent — sélecteur mois/semaine + liste des matchs de la semaine
 * sélectionnée, SANS le chrome de page (en-tête, BottomNav). Extrait pour être
 * réutilisé tel quel dans la page calendrier dédiée et embarqué ailleurs
 * (onglet « Par match » des statistiques).
 */
export function ScheduleContent({ accent = ACCENT }: { accent?: string }) {
  const navigate = useNavigate();
  const { t, lang } = useI18n();
  const locale = lang === "fr" ? "fr-FR" : "en-US";

  // Lu UNE fois au montage : la page reprend là où le lecteur l'avait laissée.
  const [saved] = useState<SavedNav | null>(readNav);
  const [anchor, setAnchor] = useState<string>(() => todayIso());
  const [bounds, setBounds] = useState<Bounds>(() => {
    const b = windowAround(todayIso());
    // Un mois restauré hors de la fenêtre par défaut l'élargit (saison longue).
    if (saved) {
      const c = monthIndex(saved.y, saved.m);
      if (c < monthIndex(b.first.y, b.first.m)) b.first = { y: saved.y, m: saved.m };
      if (c > monthIndex(b.last.y, b.last.m)) b.last = { y: saved.y, m: saved.m };
    }
    return b;
  });
  const [cursor, setCursor] = useState<YM>(() =>
    saved ? { y: saved.y, m: saved.m } : defaultMonth(todayIso(), windowAround(todayIso())));
  const [week, setWeek] = useState<Week | null>(null);
  /** Semaine CHOISIE (restaurée ou touchée) ; `null` = semaine par défaut. */
  const pinnedWeek = useRef<string | null>(saved?.week ?? null);
  /** Le mois vient d'une restauration : l'ancre de l'API ne doit pas l'écraser. */
  const restoredMonth = useRef(saved != null);

  const [games, setGames] = useState<NHLGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  // Rejouer le chargement de la semaine sans changer de semaine : incrémenter
  // ce compteur relance l'effet ci-dessous. C'est ce que « Réessayer » fait.
  const [reloadKey, setReloadKey] = useState(0);

  const weeks = useMemo(() => buildWeeks(cursor.y, cursor.m), [cursor.y, cursor.m]);

  // Accroches des cartes de match. DEUX requêtes pour toute la page, jamais
  // une par match, et toutes deux déjà mises en cache côté serveur :
  //   • `/standings`         → fiche, série, forme sur 10 de chaque équipe ;
  //   • `/predict/best-bets` → même appel que l'accueil (`limit` n'entre pas
  //     dans la clé de cache serveur), donc aucun calcul ML en plus. Il ne
  //     couvre que ce soir + demain : les matchs plus loin n'ont pas de pari.
  // Best-bets est réservé Pro sur l'accueil : même règle ici — les gratuits
  // voient un cadenas sur les matchs qui ont un pari, jamais le pari.
  const { isPro } = useSubscription();
  const [teamStats, setTeamStats] = useState<Map<string, NHLTeamStats>>(new Map());
  const [bestByGame, setBestByGame] = useState<Map<string, ApiBestBet>>(new Map());

  useEffect(() => {
    let alive = true;
    nhlApiService.getStandings()
      .then((groups) => {
        if (!alive) return;
        const m = new Map<string, NHLTeamStats>();
        for (const g of groups) for (const row of g.teams) m.set(row.team.abbreviation, row.stats);
        setTeamStats(m);
      })
      .catch(() => { /* accroche seulement — la carte reste lisible sans */ });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    predictionApiService.getBestBets({ limit: 50, source: "ml" })
      .then(({ bets }) => {
        if (!alive) return;
        const best = new Map<string, ApiBestBet>();
        for (const b of bets) {
          if (!b.gameId) continue;
          const id = String(b.gameId);
          const cur = best.get(id);
          if (!cur || b.score > cur.score) best.set(id, b);
        }
        setBestByGame(best);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const minIdx = monthIndex(bounds.first.y, bounds.first.m);
  const maxIdx = monthIndex(bounds.last.y, bounds.last.m);
  const curIdx = monthIndex(cursor.y, cursor.m);

  // 1) Ancre le calendrier sur la date/saison réelles de l'API (une fois).
  useEffect(() => {
    let alive = true;
    nhlApiService
      .getScheduleAnchor()
      .then((a) => {
        if (!alive || !a?.today) return;
        const at = safeDate(a.today);
        const b = windowAround(at);
        if (isoDate.test(a.seasonStart)) {
          const s = monthOf(a.seasonStart);
          if (monthIndex(s.y, s.m) < monthIndex(b.first.y, b.first.m)) b.first = s;
        }
        if (isoDate.test(a.seasonEnd)) {
          const e = monthOf(a.seasonEnd);
          if (monthIndex(e.y, e.m) > monthIndex(b.last.y, b.last.m)) b.last = e;
        }
        setAnchor(at);
        setBounds(b);
        // Mois restauré : on le garde (borné à la vraie saison) au lieu de
        // revenir au mois du jour.
        if (restoredMonth.current) setCursor((c) => clampCursor(monthIndex(c.y, c.m), b));
        else setCursor(defaultMonth(at, b));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // 2) À chaque changement de mois (ou d'ancre), sélectionne une semaine par
  //    défaut : celle qui contient l'ancre si le mois correspond, sinon la 1re.
  useEffect(() => {
    const ws = buildWeeks(cursor.y, cursor.m);
    // Une semaine choisie dans CE mois l'emporte sur le défaut ; changer de
    // mois l'oublie.
    const pinned = pinnedWeek.current ? ws.find((w) => w.start === pinnedWeek.current) : undefined;
    if (pinned) { setWeek(pinned); return; }
    pinnedWeek.current = null;
    const inMonth = anchor >= ws[0].start && anchor <= ws[ws.length - 1].end;
    setWeek((inMonth && ws.find((w) => anchor >= w.start && anchor <= w.end)) || ws[0]);
  }, [cursor.y, cursor.m, anchor]);

  // Mémorise le mois affiché et la semaine choisie — seulement une fois que le
  // lecteur a navigué (ou qu'on a restauré sa navigation). Sans ça, la simple
  // visite figerait le mois du jour, et la page resterait sur un mois périmé
  // à la visite suivante.
  useEffect(() => {
    if (!restoredMonth.current && !pinnedWeek.current) return;
    writeNav({ y: cursor.y, m: cursor.m, week: pinnedWeek.current });
  }, [cursor.y, cursor.m, week?.start]);

  const pickWeek = (w: Week) => {
    pinnedWeek.current = w.start;
    setWeek(w);
  };

  // 3) Charge UNIQUEMENT la semaine sélectionnée.
  useEffect(() => {
    if (!week) return;
    let alive = true;
    setLoading(true);
    setError(null);
    nhlApiService
      .getGamesRange(week.start, week.end)
      .then((g) => alive && setGames(g))
      .catch((err) => alive && setError(err ?? new Error("schedule load failed")))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [week?.start, week?.end, reloadKey]);

  const byDay = useMemo(() => {
    const map = new Map<string, NHLGame[]>();
    for (const g of games) {
      if (!map.has(g.gameDate)) map.set(g.gameDate, []);
      map.get(g.gameDate)!.push(g);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [games]);

  const monthLabel = new Date(cursor.y, cursor.m, 1).toLocaleDateString(locale, {
    month: "long",
    year: "numeric",
  });
  const weekLabel = (start: string) =>
    new Date(`${start}T00:00:00`).toLocaleDateString(locale, { day: "numeric", month: "short" });

  const stepMonth = (delta: number) => {
    // Le lecteur a choisi un mois : l'ancre de l'API, si elle arrive après,
    // ne doit pas le ramener au mois du jour.
    restoredMonth.current = true;
    setCursor(clampCursor(curIdx + delta, bounds));
  };

  return (
    <div className="flex flex-col">
      {/* Sélecteur de mois */}
      <div className="flex items-center justify-between bg-white/5 rounded-xl p-1">
        <button
          onClick={() => stepMonth(-1)}
          disabled={curIdx <= minIdx}
          aria-label="Previous month"
          className="min-w-[44px] min-h-[44px] w-9 h-8 rounded-lg flex items-center justify-center transition-all disabled:opacity-25"
          style={{ color: accent }}
        >
          <ChevronLeft size={18} />
        </button>
        <span
          className="text-white text-sm font-bold uppercase tracking-wide"
          style={{ fontFamily: "'Oswald', 'Arial Narrow', sans-serif" }}
        >
          {monthLabel}
        </span>
        <button
          onClick={() => stepMonth(1)}
          disabled={curIdx >= maxIdx}
          aria-label="Next month"
          className="min-w-[44px] min-h-[44px] w-9 h-8 rounded-lg flex items-center justify-center transition-all disabled:opacity-25"
          style={{ color: accent }}
        >
          <ChevronRight size={18} />
        </button>
      </div>

      {/* Sélecteur de semaine — chaque bouton = 1er jour de la semaine */}
      <div className="flex gap-1.5 mt-2 overflow-x-auto scrollbar-hide pb-0.5">
        {weeks.map((w) => {
          const active = week?.start === w.start;
          return (
            <button
              key={w.start}
              onClick={() => pickWeek(w)}
              className="flex-shrink-0 px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wide transition-all"
              style={
                active
                  ? { background: accent, color: "#072E49" }
                  : { background: "rgba(255,255,255,0.05)", color: "#8a9ea6" }
              }
            >
              {weekLabel(w.start)}
            </button>
          );
        })}
      </div>

      {/* Matchs de la semaine sélectionnée */}
      <div className="mt-4">
        {loading ? (
          <div className="flex flex-col gap-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-16 icy-tile rounded-2xl animate-pulse" />
            ))}
          </div>
        ) : error ? (
          <ErrorState
            error={error}
            title={t("schedule.error")}
            onRetry={() => setReloadKey((k) => k + 1)}
          />
        ) : byDay.length === 0 ? (
          <div className="text-center py-16">
            <p className="text-[#4a6068] text-sm">{t("schedule.noGames")}</p>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {byDay.map(([date, dayGames]) => (
              <section key={date}>
                <h2 className="text-[#8a9ea6] text-[11px] font-bold uppercase tracking-wider mb-2">
                  {new Date(`${date}T00:00:00`).toLocaleDateString(locale, {
                    weekday: "long",
                    day: "numeric",
                    month: "short",
                  })}
                </h2>
                <div className="flex flex-col gap-2">
                  {dayGames.map((g) => (
                    <GameRow
                      key={g.id}
                      game={g}
                      onOpen={() => navigate(`/stats/prediction/game/${g.id}`)}
                      awayStats={teamStats.get(g.awayTeam.abbreviation)}
                      homeStats={teamStats.get(g.homeTeam.abbreviation)}
                      bestBet={isPro ? bestByGame.get(String(g.id)) : undefined}
                      bestLocked={!isPro && bestByGame.has(String(g.id))}
                      onUpgrade={() => navigate("/pro")}
                      fr={lang === "fr"}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const record = (s?: NHLTeamStats) => (s ? `${s.wins}-${s.losses}-${s.otLosses}` : "");

/** « W4 » → 4, « L3 » → -3, le reste (OT, vide) → 0. */
function streakValue(s?: NHLTeamStats): number {
  const m = /^([WL])(\d+)$/i.exec(s?.streak ?? "");
  if (!m) return 0;
  return (m[1].toUpperCase() === "W" ? 1 : -1) * Number(m[2]);
}

/**
 * UNE accroche par match, la plus parlante, tirée du classement déjà chargé :
 * série de victoires ≥ 3, sinon série de défaites ≥ 4 (l'équipe en panne),
 * sinon forme brûlante sur 10 matchs (≥ 7 victoires). Rien sinon — une carte
 * sans accroche vaut mieux qu'une accroche creuse.
 */
function insightFor(game: NHLGame, away: NHLTeamStats | undefined, home: NHLTeamStats | undefined, fr: boolean): { hot: boolean; text: string } | null {
  const teams = [
    { abbr: game.awayTeam.abbreviation, s: away, v: streakValue(away) },
    { abbr: game.homeTeam.abbreviation, s: home, v: streakValue(home) },
  ];
  const hot = [...teams].sort((a, b) => b.v - a.v)[0];
  if (hot.v >= 3) return { hot: true, text: fr ? `${hot.abbr} : ${hot.v} victoires de suite` : `${hot.abbr} on a ${hot.v}-game win streak` };
  const cold = [...teams].sort((a, b) => a.v - b.v)[0];
  if (cold.v <= -4) return { hot: false, text: fr ? `${cold.abbr} : ${-cold.v} défaites de suite` : `${cold.abbr} has lost ${-cold.v} straight` };
  const form = teams
    .map((t) => ({ ...t, w: Number((t.s?.last10 ?? "").split("-")[0]) || 0 }))
    .sort((a, b) => b.w - a.w)[0];
  if (form.w >= 7) return { hot: true, text: fr ? `${form.abbr} : ${form.s!.last10} sur 10 matchs` : `${form.abbr} ${form.s!.last10} in last 10` };
  return null;
}

function TeamLine({ abbr, name, stats, score, showScore, dim, home = false }: {
  abbr: string; name: string; stats?: NHLTeamStats; score?: number; showScore: boolean; dim: boolean;
  /** Petit « H » à côté de l'équipe à domicile (2026-09-29). */
  home?: boolean;
}) {
  return (
    <div className={`flex items-center gap-2 ${dim ? "opacity-50" : ""}`}>
      <img src={nhlLogoUrl(abbr)} alt="" className="w-6 h-6 object-contain flex-shrink-0" loading="lazy" />
      <span className="text-white text-sm font-bold tabular-nums w-10">{abbr}</span>
      <span className="text-[#8a9ea6] text-[10px] font-bold w-2 flex-shrink-0">{home ? "H" : ""}</span>
      <span className="text-[#8a9ea6] text-[11px] truncate flex-1 min-w-0">
        {stats ? record(stats) : name}
      </span>
      {showScore && <span className="text-white text-base font-bold tabular-nums">{score ?? 0}</span>}
    </div>
  );
}

function GameRow({
  game,
  onOpen,
  awayStats,
  homeStats,
  bestBet,
  bestLocked,
  onUpgrade,
  fr,
}: {
  game: NHLGame;
  onOpen: () => void;
  awayStats?: NHLTeamStats;
  homeStats?: NHLTeamStats;
  bestBet?: ApiBestBet;
  bestLocked: boolean;
  onUpgrade: () => void;
  fr: boolean;
}) {
  const isFinal = game.status === "final";
  const isLive = game.status === "live";
  // 2026-10-07 : pas de « meilleur pari » sur un match commencé (en direct ou fini).
  const showBest = !isFinal && !isLive;
  const showScore = isFinal || isLive;
  const a = game.awayTeam.score ?? 0;
  const h = game.homeTeam.score ?? 0;
  const insight = !isFinal ? insightFor(game, awayStats, homeStats, fr) : null;

  // Le paquet ML n'est demandé qu'à l'approche du viewport (voir `useGameMl`) :
  // une semaine compte ~50 matchs et la route est plafonnée à 60/min.
  const rowRef = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = rowRef.current;
    if (!el || seen || isFinal || isLive) return;
    if (typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const io = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); } },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen, isFinal, isLive]);
  // Seulement avant la mise au jeu : la barre ne s'affiche que sous l'heure.
  const ml = useGameMl(String(game.id), seen && !isFinal && !isLive);
  const homeWin = ml?.homeWin ?? null;

  return (
    <div
      ref={rowRef}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      className="w-full flex flex-col gap-2 px-4 py-3 rounded-2xl icy-tile text-left cursor-pointer active:scale-[0.99] transition-transform"
    >
      <div className="flex items-center gap-3">
        {/* Équipes — visiteur en haut, domicile en bas, sans « @ » */}
        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          <TeamLine abbr={game.awayTeam.abbreviation} name={game.awayTeam.name} stats={awayStats} score={game.awayTeam.score} showScore={showScore} dim={isFinal && a < h} />
          <TeamLine abbr={game.homeTeam.abbreviation} name={game.homeTeam.name} stats={homeStats} score={game.homeTeam.score} showScore={showScore} dim={isFinal && h < a} home />
        </div>

        {/* Heure / statut */}
        <div className="flex-shrink-0 text-right pl-3 border-l border-white/10 min-w-[64px]">
          {isLive ? (
            <>
              <span className="text-[11px] font-bold px-2 py-0.5 rounded-full" style={{ background: "#f8717122", color: "#f87171" }}>
                LIVE
              </span>
              {(game.period || game.clock) && (
                <div className="text-[#8a9ea6] text-[11px] mt-1 tabular-nums">
                  {game.period ? `P${game.period}` : ""} {game.clock ?? ""}
                </div>
              )}
            </>
          ) : isFinal ? (
            <div className="text-[#4a6068] text-[11px] font-bold uppercase">Final</div>
          ) : (
            <>
              <div className="text-sm font-bold tabular-nums" style={{ color: ACCENT }}>{game.startTime}</div>
              {/* Le vainqueur prédit par le modèle ML (2026-09-29) : un trait
                  fin sous l'heure, bleu pâle du côté de la favorite (gauche =
                  visiteur, en haut ; droite = domicile). Sans chiffre ni cote,
                  et dans une place déjà là : la carte ne grandit pas. */}
              <MoneylineBar
                className="mt-1.5 ml-auto w-[64px]"
                awayPct={homeWin == null ? null : 100 - homeWin}
                loading={ml === undefined}
                awayAbbr={game.awayTeam.abbreviation}
                homeAbbr={game.homeTeam.abbreviation}
              />
              {game.gameType === "playoff" && (
                <div className="text-[10px] font-bold uppercase mt-0.5" style={{ color: "#fbbf24" }}>
                  {fr ? "Séries" : "Playoffs"}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Accroches — meilleur pari du modèle, puis tendance d'équipe */}
      {!isFinal && ((showBest && (bestBet || bestLocked)) || insight) && (
        <div className="flex flex-wrap gap-1.5">
          {showBest && bestBet ? (
            <span
              className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg max-w-full"
              style={{ background: "rgba(134,209,234,0.12)", color: ACCENT, border: "1px solid rgba(134,209,234,0.3)" }}
            >
              <span className="truncate">{bestBet.label}</span>
              <span className="font-bold tabular-nums text-white">{Math.round(bestBet.score)}%</span>
            </span>
          ) : showBest && bestLocked ? (
            <button
              onClick={(e) => { e.stopPropagation(); onUpgrade(); }}
              className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg"
              style={{ background: "rgba(251,191,36,0.10)", color: "#fbbf24", border: "1px solid rgba(251,191,36,0.3)" }}
            >
              {fr ? "Meilleur pari du modèle · Pro" : "Model's best bet · Pro"}
            </button>
          ) : null}
          {insight && (
            <span
              className="inline-flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded-lg bg-white/5 max-w-full"
              style={{ color: insight.hot ? "#fb923c" : "#8a9ea6" }}
            >
              <span className="truncate">{insight.text}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
