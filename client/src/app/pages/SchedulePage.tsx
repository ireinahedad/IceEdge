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
 * Bornes/mois par défaut ancrés à la date réelle de l'API (getScheduleAnchor),
 * pas à l'horloge locale.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { BottomNav } from "../components/BottomNav";
import { nhlApiService } from "../services/nhlApiService";
import type { NHLGame } from "../types/bet";
import { useI18n } from "../i18n";
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

export function SchedulePage() {
  const navigate = useNavigate();
  const { t } = useI18n();

  return (
    <div className="flex flex-col min-h-screen pb-24 max-w-[430px] md:max-w-5xl mx-auto w-full" style={{ background: "#0A0E0C" }}>
      {/* Header */}
      <header
        className="sticky top-0 z-40"
        style={{ background: "rgba(10,14,12,0.92)", backdropFilter: "blur(16px)", paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <div className="rink-boards" aria-hidden />
        <div className="px-4 pt-3 pb-3 flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            aria-label="Back"
            className="w-9 h-9 rounded-xl bg-[#131A12] border border-white/20 flex items-center justify-center flex-shrink-0"
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

  const [anchor, setAnchor] = useState<string>(() => todayIso());
  const [bounds, setBounds] = useState<Bounds>(() => windowAround(todayIso()));
  const [cursor, setCursor] = useState<YM>(() => defaultMonth(todayIso(), windowAround(todayIso())));
  const [week, setWeek] = useState<Week | null>(null);

  const [games, setGames] = useState<NHLGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const weeks = useMemo(() => buildWeeks(cursor.y, cursor.m), [cursor.y, cursor.m]);

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
        setCursor(defaultMonth(at, b));
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
    const inMonth = anchor >= ws[0].start && anchor <= ws[ws.length - 1].end;
    setWeek((inMonth && ws.find((w) => anchor >= w.start && anchor <= w.end)) || ws[0]);
  }, [cursor.y, cursor.m, anchor]);

  // 3) Charge UNIQUEMENT la semaine sélectionnée.
  useEffect(() => {
    if (!week) return;
    let alive = true;
    setLoading(true);
    setError(false);
    nhlApiService
      .getGamesRange(week.start, week.end)
      .then((g) => alive && setGames(g))
      .catch(() => alive && setError(true))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [week?.start, week?.end]);

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

  const stepMonth = (delta: number) => setCursor(clampCursor(curIdx + delta, bounds));

  return (
    <div className="flex flex-col">
      {/* Sélecteur de mois */}
      <div className="flex items-center justify-between bg-white/5 rounded-xl p-1">
        <button
          onClick={() => stepMonth(-1)}
          disabled={curIdx <= minIdx}
          aria-label="Previous month"
          className="w-9 h-8 rounded-lg flex items-center justify-center transition-all disabled:opacity-25"
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
          className="w-9 h-8 rounded-lg flex items-center justify-center transition-all disabled:opacity-25"
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
              onClick={() => setWeek(w)}
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
          <div className="text-center py-16">
            <p className="text-[#f87171] text-sm">{t("schedule.error")}</p>
          </div>
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
                    <GameRow key={g.id} game={g} onOpen={() => navigate(`/stats/prediction/game/${g.id}`)} t={t} />
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

function GameRow({
  game,
  onOpen,
  t,
}: {
  game: NHLGame;
  onOpen: () => void;
  t: (k: string) => string;
}) {
  const isFinal = game.status === "final";
  const isLive = game.status === "live";

  return (
    <button
      onClick={onOpen}
      className="w-full flex items-center gap-3 px-4 py-3 rounded-2xl icy-tile text-left active:scale-[0.99] transition-transform"
    >
      {/* Équipes */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-white text-sm font-bold">
          <span className="tabular-nums">{game.awayTeam.abbreviation}</span>
          <span className="text-[#4a6068] font-normal">{t("schedule.at")}</span>
          <span className="tabular-nums">{game.homeTeam.abbreviation}</span>
        </div>
        <p className="text-[#8a9ea6] text-[11px] truncate">
          {game.awayTeam.name} {t("schedule.at")} {game.homeTeam.name}
        </p>
      </div>

      {/* Heure / statut */}
      <div className="flex-shrink-0 text-right">
        {isLive ? (
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: "#f8717122", color: "#f87171" }}>
            LIVE
          </span>
        ) : isFinal ? (
          <>
            <div className="text-white text-sm font-bold tabular-nums">
              {game.awayTeam.score}–{game.homeTeam.score}
            </div>
            <div className="text-[#4a6068] text-[10px] uppercase">Final</div>
          </>
        ) : (
          <div className="text-sm font-bold tabular-nums" style={{ color: ACCENT }}>
            {game.startTime}
          </div>
        )}
      </div>
    </button>
  );
}
