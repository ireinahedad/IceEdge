/**
 * SchedulePage — calendrier des matchs de la saison NHL.
 * Navigation mois par mois ; chaque jour liste ses matchs (AWAY @ HOME · heure).
 * Un clic sur un match ouvre sa page de prédiction (/stats/prediction/game/:id).
 *
 * Les bornes et le mois par défaut sont ancrés à la date « courante » et à la
 * fenêtre de saison renvoyées par l'API NHL (nhlApiService.getScheduleAnchor),
 * et NON à l'horloge locale — sinon un décalage entre l'horloge de la machine
 * et les données réelles ferait s'ouvrir la page sur un mois vide.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { BottomNav } from "../components/BottomNav";
import { nhlApiService } from "../services/nhlApiService";
import type { NHLGame } from "../types/bet";
import { useI18n } from "../i18n";

const ACCENT = "#86d1ea";

// ── Helpers de dates (toutes en 'YYYY-MM-DD', heure locale) ──────────────────
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const monthStart = (y: number, m: number) => iso(y, m, 1);
const monthEnd = (y: number, m: number) => iso(y, m, new Date(y, m + 1, 0).getDate());
const monthIndex = (y: number, m: number) => y * 12 + m;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

type YM = { y: number; m: number };
type Bounds = { first: YM; last: YM };

// Fenêtre de navigation : ~1 an de chaque côté de la date d'ancrage, pour
// pouvoir atteindre librement n'importe quel mois de la saison (et au-delà).
const MONTHS_EACH_SIDE = 12;
const today = () => new Date().toISOString().slice(0, 10);
const safeDate = (d: string) => (isoDate.test(d) ? d : today());
const fromIdx = (idx: number): YM => ({ y: Math.floor(idx / 12), m: ((idx % 12) + 12) % 12 });

/** {y, m(0-11)} depuis une date ISO 'YYYY-MM-DD'. */
function monthOf(date: string): YM {
  const [y, m] = safeDate(date).split("-").map(Number);
  return { y, m: m - 1 };
}

/** Fenêtre glissante centrée sur `date` (± MONTHS_EACH_SIDE mois). */
function windowAround(date: string): Bounds {
  const { y, m } = monthOf(date);
  const c = monthIndex(y, m);
  return { first: fromIdx(c - MONTHS_EACH_SIDE), last: fromIdx(c + MONTHS_EACH_SIDE) };
}

/**
 * Mois d'ouverture : le mois de `date`, sauf en intersaison (juil.–sept.) où
 * l'on saute directement au coup d'envoi de la saison (octobre) pour tomber
 * sur des matchs plutôt que sur un mois vide.
 */
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

export function SchedulePage() {
  const navigate = useNavigate();
  const { t, lang } = useI18n();
  const locale = lang === "fr" ? "fr-FR" : "en-US";

  // Bornes + mois affiché : d'abord estimés depuis l'horloge locale (fallback),
  // puis corrigés dès que l'ancre API arrive.
  const [bounds, setBounds] = useState<Bounds>(() => windowAround(today()));
  const [cursor, setCursor] = useState<YM>(() => defaultMonth(today(), windowAround(today())));

  const [games, setGames] = useState<NHLGame[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // 1) Ancre le calendrier sur la date/saison réelles de l'API (une fois).
  useEffect(() => {
    let alive = true;
    nhlApiService
      .getScheduleAnchor()
      .then((a) => {
        if (!alive || !a?.today) return;
        // On élargit (jamais rétrécit) la fenêtre pour englober à la fois la
        // saison réelle et ± MONTHS_EACH_SIDE autour de l'ancre courante.
        const anchor = safeDate(a.today);
        const b = windowAround(anchor);
        if (isoDate.test(a.seasonStart)) {
          const s = monthOf(a.seasonStart);
          if (monthIndex(s.y, s.m) < monthIndex(b.first.y, b.first.m)) b.first = s;
        }
        if (isoDate.test(a.seasonEnd)) {
          const e = monthOf(a.seasonEnd);
          if (monthIndex(e.y, e.m) > monthIndex(b.last.y, b.last.m)) b.last = e;
        }
        setBounds(b);
        setCursor(defaultMonth(anchor, b));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const minIdx = monthIndex(bounds.first.y, bounds.first.m);
  const maxIdx = monthIndex(bounds.last.y, bounds.last.m);
  const curIdx = monthIndex(cursor.y, cursor.m);
  const canPrev = curIdx > minIdx;
  const canNext = curIdx < maxIdx;

  // 2) Charge les matchs du mois affiché.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    nhlApiService
      .getGamesRange(monthStart(cursor.y, cursor.m), monthEnd(cursor.y, cursor.m))
      .then((g) => alive && setGames(g))
      .catch(() => alive && setError(true))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [cursor.y, cursor.m]);

  // Regroupe les matchs par date.
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

  const step = (delta: number) => setCursor(clampCursor(curIdx + delta, bounds));

  return (
    <div className="flex flex-col min-h-screen pb-24" style={{ background: "#0A0E0C" }}>
      {/* Header */}
      <header
        className="sticky top-0 z-40 px-4 pt-12 pb-3"
        style={{ background: "rgba(10,14,12,0.92)", backdropFilter: "blur(16px)", borderBottom: "1px solid #283323" }}
      >
        <div className="flex items-center gap-3 mb-3">
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

        {/* Sélecteur de mois */}
        <div className="flex items-center justify-between bg-white/5 rounded-xl p-1">
          <button
            onClick={() => step(-1)}
            disabled={!canPrev}
            aria-label="Previous month"
            className="w-9 h-8 rounded-lg flex items-center justify-center transition-all disabled:opacity-25"
            style={{ color: ACCENT }}
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
            onClick={() => step(1)}
            disabled={!canNext}
            aria-label="Next month"
            className="w-9 h-8 rounded-lg flex items-center justify-center transition-all disabled:opacity-25"
            style={{ color: ACCENT }}
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </header>

      {/* Contenu */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
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

      <BottomNav />
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
