/**
 * predictionShared.tsx
 *
 * Extrait de PredictionPage.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { useNavigate, useSearchParams } from "react-router";
import { useCallback, useEffect, useMemo, useState, createContext } from "react";
import { nhlApiService } from "../../services/nhlApiService";
import { nhlLogoUrl } from "../../data/teamEmoji";
import { pctColor } from "../../data/pctScale";
import { useI18n } from "../../i18n";
import type { NHLGame } from "../../types/bet";
import type { CalcFactor } from "../../services/predictionApiService";

type Subject = { id: string; type: "team" | "player" | "game"; name: string; logo: string; subtitle: string };

/**
 * Prediction source shown by every BetOption on the page. Predictions are
 * always visible; a segmented toggle at the top switches which number is shown:
 *   "rules" → the rule-based % (default).
 *   "ml"    → the ML model's %.
 */
export type RevealMode = "rules" | "ml";
export const RevealModeCtx = createContext<RevealMode>("rules");
/* ─── Circular gauge ─────────────────────────────── */
function WinGauge({ pct, label, size = 140 }: { pct: number; label: string; size?: number }) {
  const [displayed, setDisplayed] = useState(0);
  const radius = (size - 20) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - displayed / 100);

  const color = pctColor(pct);

  useEffect(() => {
    const timeout = setTimeout(() => {
      let start = 0;
      const step = () => {
        start += 1;
        setDisplayed(start);
        if (start < pct) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }, 300);
    return () => clearTimeout(timeout);
  }, [pct]);

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#1e2d32" strokeWidth={10} />
        <circle
          cx={size / 2} cy={size / 2} r={radius} fill="none"
          stroke={color} strokeWidth={10}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          style={{ transition: "stroke-dashoffset 0.05s linear" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-white text-3xl font-bold">{displayed}<span className="text-xl">%</span></span>
        <span className="text-[#bfc8cc] text-[11px] mt-0.5 text-center px-2 leading-tight">{label}</span>
      </div>
    </div>
  );
}

/* ─── Reason card ─────────────────────────────────── */
function ReasonBar({ icon, label, value, maxValue, color, detail }: {
  icon: string; label: string; value: number; maxValue: number; color: string; detail: string;
}) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setWidth((value / maxValue) * 100), 400);
    return () => clearTimeout(t);
  }, [value, maxValue]);

  return (
    <div className="bg-[#131A12] border border-white/20 rounded-2xl p-3.5">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-lg">{icon}</span>
          <span className="text-white text-xs font-medium">{label}</span>
        </div>
        <span className="text-xs font-bold" style={{ color }}>{detail}</span>
      </div>
      <div className="w-full bg-[#0A0E0C] rounded-full h-2">
        <div
          className="h-2 rounded-full transition-all duration-700 ease-out"
          style={{ width: `${width}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

/* ─── Calculated Breakdown (waterfall) ─────────── */

function CalculatedBreakdown({ basePct, factors, finalPct, accent }: {
  basePct: number;
  factors: CalcFactor[];
  finalPct: number;
  accent: string;
}) {
  const { t } = useI18n();
  const [revealed, setRevealed] = useState(0);

  useEffect(() => {
    let i = 0;
    const id = setInterval(() => {
      i++;
      setRevealed(i);
      if (i >= factors.length) clearInterval(id);
    }, 220);
    return () => clearInterval(id);
  }, [factors.length]);

  let running = basePct;

  return (
    <div className="bg-[#131A12] border border-white/20 rounded-2xl overflow-hidden">
      <div className="px-4 py-3 border-b border-white/20 flex items-center justify-between">
        <span className="text-white text-sm font-semibold">{t("pred.calcPredictions")}</span>
        <span className="text-[11px] text-[#bfc8cc] bg-[#0A0E0C] px-2 py-0.5 rounded-full">{t("pred.base", { n: basePct })}</span>
      </div>
      <div className="divide-y divide-[#1e2d32]">
        {factors.map((f, i) => {
          running += f.delta;
          const isPos = f.delta >= 0;
          const color = isPos ? "#4ade80" : "#f87171";
          const show = i < revealed;
          return (
            <div key={i} className="flex items-center gap-3 px-4 py-3 transition-all duration-300"
              style={{ opacity: show ? 1 : 0, transform: show ? "translateY(0)" : "translateY(6px)" }}>
              <span className="text-base w-6 text-center flex-shrink-0">{f.icon}</span>
              <span className="text-[#bfc8cc] text-xs flex-1 leading-tight">{f.label}</span>
              <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
                <span className="text-xs font-bold" style={{ color }}>{isPos ? "+" : ""}{f.delta}%</span>
                <span className="text-[11px] text-[#bfc8cc]">{Math.round(running)}%</span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="px-4 py-4 flex items-center justify-between border-t-2" style={{ borderColor: accent }}>
        <div>
          <p className="text-[#bfc8cc] text-[11px] uppercase tracking-widest">{t("pred.aiPrediction")}</p>
          <p className="text-white text-2xl font-black mt-0.5">{finalPct}<span className="text-sm font-medium text-[#bfc8cc]">%</span></p>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium"
          style={{ color: accent, borderColor: `${accent}40`, backgroundColor: `${accent}15` }}>
          <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ backgroundColor: accent }} />
          {t("pred.liveModel")}
        </div>
      </div>
    </div>
  );
}

/* ─── Confidence badge ──────────────────────────── */
function ConfidenceBadge({ pct }: { pct: number }) {
  const { t } = useI18n();
  const label = pct >= 70 ? t("pred.confHigh") : pct >= 55 ? t("pred.confModerate") : pct >= 45 ? t("pred.confEven") : t("pred.confUnderdog");
  // Couleurs en style inline plutôt qu'en classes Tailwind : la rampe vit
  // maintenant dans pctScale, hors de portée du JIT qui n'accepte que des
  // noms de classe littéraux.
  const color = pctColor(pct);
  return (
    <span
      className="border rounded-full px-3 py-1 text-xs font-medium"
      style={{ background: color + "33", color, borderColor: color + "4d" }}
    >{label}</span>
  );
}

/* ─── Form dots ────────────────────────────────── */
function FormDots({ results }: { results: ("W" | "L" | "OT")[] }) {
  return (
    <div className="flex gap-1.5 flex-wrap">
      {results.map((r, i) => (
        <div key={i} className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold ${
          r === "W" ? "bg-green-500/20 text-green-400 border border-green-500/30" :
          r === "OT" ? "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30" :
          "bg-red-500/20 text-red-400 border border-red-500/30"
        }`}>{r}</div>
      ))}
    </div>
  );
}




/* ─── Recent form card (reusable) ─────────────── */
function FormLegend() {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-4 mt-3">
      <div className="flex items-center gap-1.5">
        <div className="w-3 h-3 rounded-full bg-green-500/40 border border-green-500/60" />
        <span className="text-[#bfc8cc] text-[11px]">{t("pred.win")}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="w-3 h-3 rounded-full bg-yellow-500/40 border border-yellow-500/60" />
        <span className="text-[#bfc8cc] text-[11px]">OT</span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="w-3 h-3 rounded-full bg-red-500/40 border border-red-500/60" />
        <span className="text-[#bfc8cc] text-[11px]">{t("pred.loss")}</span>
      </div>
    </div>
  );
}

/** Single-subject recent form card (used for player & team). */
export function RecentFormCard({ title, results }: { title?: string; results?: ("W" | "L" | "OT")[] }) {
  const { t } = useI18n();
  if (!results || results.length === 0) return null;
  return (
    <div className="bg-[#131A12] border border-white/20 rounded-2xl p-4">
      <p className="text-white text-sm font-medium mb-3">{title ?? t("pred.recentForm")}</p>
      <FormDots results={results} />
      <FormLegend />
    </div>
  );
}

/** Head-to-head — the two teams' most recent meetings this season, with scores. */
interface H2HMeeting { date: string; homeAbbr: string; awayAbbr: string; homeScore: number; awayScore: number; }

export function HeadToHead({ home, away }: {
  home: { abbr: string; logo: string };
  away: { abbr: string; logo: string };
}) {
  const { t, lang } = useI18n();
  const locale = lang === "fr" ? "fr-CA" : "en-US";
  const [meetings, setMeetings] = useState<H2HMeeting[] | null>(null);

  useEffect(() => {
    let alive = true;
    setMeetings(null);
    (async () => {
      try {
        const isoRe = /^\d{4}-\d{2}-\d{2}$/;
        const anchor = await nhlApiService.getScheduleAnchor().catch(() => null);
        const end = anchor?.today && isoRe.test(anchor.today)
          ? anchor.today
          : new Date().toISOString().slice(0, 10);
        const start = anchor?.seasonStart && isoRe.test(anchor.seasonStart)
          ? anchor.seasonStart
          : `${Number(end.slice(0, 4)) - 1}-09-01`;

        const games = await nhlApiService.getGamesRange(start, end);
        const A = home.abbr.toUpperCase();
        const B = away.abbr.toUpperCase();
        const found = games
          .filter((g) => g.status === "final")
          .filter((g) => {
            const h = g.homeTeam.abbreviation.toUpperCase();
            const a = g.awayTeam.abbreviation.toUpperCase();
            return (h === A && a === B) || (h === B && a === A);
          })
          .map((g) => ({
            date: g.gameDate,
            homeAbbr: g.homeTeam.abbreviation.toUpperCase(),
            awayAbbr: g.awayTeam.abbreviation.toUpperCase(),
            homeScore: g.homeTeam.score ?? 0,
            awayScore: g.awayTeam.score ?? 0,
          }))
          .sort((x, y) => y.date.localeCompare(x.date))
          .slice(0, 5);
        if (alive) setMeetings(found);
      } catch {
        if (alive) setMeetings([]);
      }
    })();
    return () => { alive = false; };
  }, [home.abbr, away.abbr]);

  return (
    <div className="bg-[#131A12] border border-white/20 rounded-2xl p-4">
      <p className="text-white text-sm font-medium mb-3">{t("pred.h2hTitle")}</p>
      {meetings === null ? (
        <div className="flex flex-col gap-2">
          {[1, 2, 3].map((i) => <div key={i} className="h-9 bg-[#0A0E0C] rounded-lg animate-pulse" />)}
        </div>
      ) : meetings.length === 0 ? (
        <p className="text-[#8a9ea6] text-xs">{t("pred.h2hNone")}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {meetings.map((m, i) => {
            const homeWon = m.homeScore > m.awayScore;
            return (
              <div key={i} className="flex items-center gap-3 text-xs bg-[#0A0E0C] rounded-lg px-3 py-2">
                <span className="text-[#8a9ea6] w-14 flex-shrink-0 tabular-nums">
                  {new Date(`${m.date}T00:00:00`).toLocaleDateString(locale, { day: "numeric", month: "short" })}
                </span>
                <div className="flex-1 flex items-center justify-center gap-2">
                  <span className={`font-bold tabular-nums ${!homeWon ? "text-white" : "text-[#8a9ea6]"}`}>{m.awayAbbr}</span>
                  <span className="text-white font-black tabular-nums">{m.awayScore}</span>
                  <span className="text-[#4a6070]">–</span>
                  <span className="text-white font-black tabular-nums">{m.homeScore}</span>
                  <span className={`font-bold tabular-nums ${homeWon ? "text-white" : "text-[#8a9ea6]"}`}>{m.homeAbbr}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─── Game picker (player & team prediction pages) ──────────────────────────
 * A bet placed from a player or team page needs a gameId to be auto-settled,
 * and "which game?" is only obvious once it's on screen. Both pages therefore
 * open on the subject's NEXT game and let the user switch with a dropdown.
 * The choice lives in the `?game=` search param, so a link from a game page
 * (or a shared URL) opens on the right match instead of the default one.
 */

/** One selectable game, described from the point of view of one team. */
export interface UpcomingGame {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  /** Display string from the API, e.g. "7:00 PM ET". */
  startTime: string;
  homeAbbr: string;
  awayAbbr: string;
  /** The other team — i.e. the opponent of the team this list was built for. */
  opponentAbbr: string;
  isHome: boolean;
  status: NHLGame["status"];
}

/** How far ahead the dropdown looks. One range call covers every team. */
const UPCOMING_DAYS = 14;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const shiftIso = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

function toUpcoming(g: NHLGame, teamAbbr: string): UpcomingGame {
  const homeAbbr = (g.homeTeam.abbreviation ?? "").toUpperCase();
  const awayAbbr = (g.awayTeam.abbreviation ?? "").toUpperCase();
  const isHome = homeAbbr === teamAbbr.toUpperCase();
  return {
    id: String(g.id),
    date: g.gameDate,
    startTime: g.startTime,
    homeAbbr,
    awayAbbr,
    opponentAbbr: isHome ? awayAbbr : homeAbbr,
    isHome,
    status: g.status,
  };
}

/**
 * A team's games over the next {@link UPCOMING_DAYS} days, soonest first.
 * `null` while loading, `[]` when the team has no game in that window.
 *
 * `pinnedId` (the `?game=` value) is fetched on its own and merged in when it
 * falls outside the window — without that, a link to a game further out would
 * silently switch the page over to a different match.
 */
export function useUpcomingGames(teamAbbr: string | undefined, pinnedId?: string): UpcomingGame[] | null {
  const [scheduled, setScheduled] = useState<UpcomingGame[] | null>(null);
  const [pinned, setPinned] = useState<UpcomingGame | null>(null);

  // Schedule window — refetched only when the team changes, never when the
  // user picks a different game in the dropdown.
  useEffect(() => {
    if (!teamAbbr) { setScheduled(null); return; }
    let alive = true;
    setScheduled(null);
    (async () => {
      const abbr = teamAbbr.toUpperCase();
      try {
        const anchor = await nhlApiService.getScheduleAnchor().catch(() => null);
        const start = anchor?.today && ISO_DATE.test(anchor.today)
          ? anchor.today
          : new Date().toISOString().slice(0, 10);
        const all = await nhlApiService.getGamesRange(start, shiftIso(start, UPCOMING_DAYS));
        const list = all
          .filter(g => g.status !== "final")
          .filter(g => [g.homeTeam.abbreviation, g.awayTeam.abbreviation]
            .some(a => (a ?? "").toUpperCase() === abbr))
          .map(g => toUpcoming(g, abbr));
        if (alive) setScheduled(list);
      } catch {
        // Schedule unavailable — the page still works, just without a game.
        if (alive) setScheduled([]);
      }
    })();
    return () => { alive = false; };
  }, [teamAbbr]);

  // A `?game=` id outside the window (older, or further ahead) is fetched once.
  useEffect(() => {
    if (!teamAbbr || !pinnedId || !scheduled || scheduled.some(g => g.id === pinnedId)) {
      setPinned(null);
      return;
    }
    let alive = true;
    nhlApiService.getGame(pinnedId)
      .then(g => { if (alive) setPinned(toUpcoming(g, teamAbbr)); })
      .catch(() => { if (alive) setPinned(null); }); // unknown id → fall back to the next game
    return () => { alive = false; };
  }, [teamAbbr, pinnedId, scheduled]);

  return useMemo(() => {
    if (scheduled === null) return null;
    const all = pinned ? [...scheduled, pinned] : scheduled;
    // One game per team per day, so the date alone orders them.
    return [...all].sort((a, b) => a.date.localeCompare(b.date));
  }, [scheduled, pinned]);
}

/**
 * The game the page is bound to: `?game=` when it points at a listed game,
 * otherwise the next one. `select` rewrites the param in place (replace) —
 * switching games is not a new page.
 */
export function useSelectedGame(games: UpcomingGame[] | null) {
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get("game") ?? undefined;

  const selected = useMemo(() => {
    if (!games || games.length === 0) return null;
    return games.find(g => g.id === fromUrl) ?? games[0];
  }, [games, fromUrl]);

  const select = useCallback((id: string) => {
    const next = new URLSearchParams(params);
    next.set("game", id);
    setParams(next, { replace: true });
  }, [params, setParams]);

  return { selected, select };
}

/** Header card: which game these bets are for, with a dropdown to switch. */
export function GameSelector({ games, selected, onSelect, accent }: {
  games: UpcomingGame[] | null;
  selected: UpcomingGame | null;
  onSelect: (gameId: string) => void;
  accent: string;
}) {
  const navigate = useNavigate();
  const { t, lang } = useI18n();
  const locale = lang === "fr" ? "fr-CA" : "en-US";

  const optionLabel = (g: UpcomingGame) => {
    const day = ISO_DATE.test(g.date)
      ? new Date(`${g.date}T00:00:00`).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" })
      : g.date;
    return `${g.isHome ? "vs" : "@"} ${g.opponentAbbr} · ${day}${g.startTime ? ` · ${g.startTime}` : ""}`;
  };

  if (games === null) {
    return <div className="h-16 bg-[#131A12] rounded-2xl animate-pulse" />;
  }

  return (
    <div className="bg-[#131A12] border border-white/20 rounded-2xl px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[#8a9ea6] text-[11px] uppercase tracking-wider font-semibold">{t("pred.forGame")}</span>
        {selected && (
          <button
            onClick={() => navigate(`/stats/prediction/game/${selected.id}`)}
            className="ml-auto text-[11px] font-semibold px-2 py-0.5 rounded-md border transition-colors"
            style={{ color: accent, borderColor: accent + "55", background: accent + "14" }}
          >
            {t("pred.viewGame")}
          </button>
        )}
      </div>

      {games.length === 0 || !selected ? (
        <p className="text-[#8a9ea6] text-xs">{t("pred.noUpcoming")}</p>
      ) : (
        <div className="flex items-center gap-2">
          <img src={nhlLogoUrl(selected.opponentAbbr)} alt={selected.opponentAbbr} className="w-7 h-7 object-contain flex-shrink-0" />
          <select
            value={selected.id}
            onChange={e => onSelect(e.target.value)}
            aria-label={t("pred.chooseGame")}
            className="flex-1 min-w-0 rounded-xl border border-white/15 px-2.5 py-2 text-xs font-semibold text-white outline-none"
            style={{ background: "#0A0E0C" }}
          >
            {games.map(g => (
              <option key={g.id} value={g.id}>{optionLabel(g)}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

/* --- Recent-form generator --- */
/** Deterministic-ish recent form: `count` results biased by win probability `prob` (0..1). */
// `generateForm` a été supprimée le 2026-08-29. Elle fabriquait une suite de
// W/L/OT avec `Math.random()` à partir d'un pourcentage, et cette suite était
// rendue sous le titre « Forme récente », avec sa légende W/OT/L — donc lue
// comme les vrais derniers résultats de l'équipe ou du joueur. Elle changeait à
// chaque rechargement. Aucune source ne donne aujourd'hui l'ORDRE des derniers
// résultats (`getTeamLastNGamesStats` ne rend que des totaux), donc la carte ne
// s'affiche plus du tout : `RecentFormCard` et `PredictionLayout` rendent `null`
// sans `results`. Le jour où l'API expose la séquence, il suffit de la passer.

/* --- Last-N games view model --- */
export interface NGamesView {
  teamName: string; teamAbbr: string; logo: string;
  wins: number; losses: number; otLosses: number;
  goalsFor: number; goalsAgainst: number;
  goalsForPerGame: number; goalsAgainstPerGame: number;
  ppPct: number; pkPct: number;
  streak: string; last10: string; winRateN: number;
}

/* --- Loading skeleton --- */
export function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {[1,2,3,4].map(i => <div key={i} className="h-20 bg-[#131A12] rounded-2xl animate-pulse" />)}
    </div>
  );
}


/* ─── Shared layout ────────────────────────────── */
function BetRec({ rec, note, onAddToSlip }: { rec: string; note: string; onAddToSlip?: () => void }) {
  const navigate = useNavigate();
  const { t } = useI18n();
  return (
    <div className="bg-gradient-to-br from-[#86d1ea]/10 to-[#0f1416] border border-[#86d1ea]/30 rounded-2xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-lg">💡</span>
        <p className="text-white text-sm font-medium">{t("pred.recommendedBet")}</p>
        <span className="ml-auto bg-[#86d1ea]/20 text-[#86d1ea] text-[11px] px-2 py-0.5 rounded-full font-medium">{rec}</span>
      </div>
      <p className="text-[#bfc8cc] text-xs leading-relaxed">{note}</p>
      <button
        onClick={() => onAddToSlip ? onAddToSlip() : navigate("/bet")}
        className="mt-3 w-full py-2.5 rounded-xl text-sm font-bold transition-all active:scale-[0.98] bg-[#86d1ea] text-[#0A0E0C]"
      >
        {t("pred.goToBuilder")}
      </button>
    </div>
  );
}

export function PredictionLayout({
  title, subtitle, logo, winPct, winLabel, calcFactors, basePct, accent, recentForm, betRec, betNote, extraStats,
}: {
  title: string; subtitle: string; logo: string; winPct: number; winLabel: string;
  calcFactors?: CalcFactor[]; basePct?: number; accent?: string;
  /** Vrais derniers résultats uniquement. Absent → la carte n'est pas rendue. */
  recentForm?: ("W" | "L" | "OT")[]; betRec: string; betNote: string;
  extraStats: { label: string; value: string }[];
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-col gap-5">
      {/* Hero card */}
      <div className="bg-[#131A12] border border-white/20 rounded-2xl p-5">
        <div className="flex items-center gap-3 mb-5">
          <img src={logo} alt={title} className="w-12 h-12 object-contain" />
          <div>
            <p className="text-white font-bold">{title}</p>
            <p className="text-[#bfc8cc] text-xs">{subtitle}</p>
          </div>
          <div className="ml-auto">
            <ConfidenceBadge pct={winPct} />
          </div>
        </div>

        {/* Gauge */}
        <div className="flex justify-center">
          <div className="relative flex items-center justify-center" style={{ width: 160, height: 160 }}>
            <WinGauge pct={winPct} label={winLabel} size={160} />
          </div>
        </div>

        {/* Extra stats row */}
        <div className="grid grid-cols-4 gap-2 mt-4">
          {extraStats.map((s, i) => (
            <div key={i} className="bg-[#0A0E0C] rounded-xl p-2 text-center">
              <p className="text-white text-xs font-bold">{s.value}</p>
              <p className="text-[#bfc8cc] text-[11px]">{s.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Calculated breakdown waterfall */}
      {calcFactors && basePct !== undefined && accent && (
        <CalculatedBreakdown
          basePct={basePct}
          factors={calcFactors}
          finalPct={winPct}
          accent={accent}
        />
      )}

      {/* Recent form — rendue seulement si on a de VRAIS résultats */}
      {recentForm && recentForm.length > 0 && (
        <div className="bg-[#131A12] border border-white/20 rounded-2xl p-4">
          <p className="text-white text-sm font-medium mb-3">{t("pred.recentForm")}</p>
          <FormDots results={recentForm} />
          <div className="flex items-center gap-4 mt-3">
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-full bg-green-500/40 border border-green-500/60" />
              <span className="text-[#bfc8cc] text-[11px]">{t("pred.win")}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-full bg-yellow-500/40 border border-yellow-500/60" />
              <span className="text-[#bfc8cc] text-[11px]">OT</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-full bg-red-500/40 border border-red-500/60" />
              <span className="text-[#bfc8cc] text-[11px]">{t("pred.loss")}</span>
            </div>
          </div>
        </div>
      )}

      {/* Bet recommendation */}
      <BetRec rec={betRec} note={betNote} />
    </div>
  );
}


/* ─── Main PredictionPage ──────────────────────────── */

export function NotFound() {
  const navigate = useNavigate();
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center justify-center py-24 px-6 text-center">
      <p className="text-4xl mb-4">🏒</p>
      <p className="text-white font-bold text-lg mb-2">{t("pred.notFound")}</p>
      <p className="text-[#8a9ea6] text-sm mb-6">{t("pred.notExist")}</p>
      <button onClick={() => navigate(-1)} className="px-6 py-2 rounded-xl bg-[#86d1ea]/10 border border-[#86d1ea]/30 text-[#86d1ea] text-sm">{t("pred.goBack")}</button>
    </div>
  );
}
