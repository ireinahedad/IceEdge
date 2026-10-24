/**
 * PickemSection.tsx — « Votes du jour » dans Communauté › Chat.
 * NEWS_CONSENSUS_PLAN.md, F3 : le remplaçant de #pickems, avec les vrais
 * utilisateurs ICEEDGE.
 *
 * Une section dépliable et COMPACTE (demande du user, 2026-10-24) : une ligne de
 * résumé, puis un anneau par match, deux par rangée. L'anneau partage le cercle
 * entre les deux équipes, à leurs couleurs ; les logos dessous servent de
 * boutons de vote. Le serveur décide de la fermeture (mise au jeu), l'écran suit.
 *
 * UN appel (`GET /api/pickem/today`) pour tous les matchs. Échec ou soirée sans
 * match : la section n'apparaît pas. Sous 10 votes, pas de pourcentage : l'anneau
 * devient une jauge « 6/10 ». Graphiques en SVG : pas de recharts ici, le chat ne
 * doit pas télécharger le paquet des graphiques.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { useI18n } from "../../../i18n";
import { useAuth } from "../../../context/AuthContext";
import { useAuthGate } from "../../../context/AuthGateContext";
import { nhlLogoUrl, teamColors } from "../../../data/teamEmoji";
import {
  fetchPickemDay, castPickem, PickemError,
  type PickemDay, type PickemDayGame,
} from "../../../services/pickemService";
import { PickemLeaderboard } from "./PickemLeaderboard";

const OPEN_KEY = "iceedge_pickem_open";

// ─── Couleurs : lisibles sur le fond sombre, et distinctes entre elles ────────

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function distance(a: string, b: string): number {
  const [x, y] = [rgb(a), rgb(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}
/** La couleur du club la plus lisible sur la glace sombre ; bleu glace si les deux sont trop foncées. */
function readable(abbr: string): string {
  const { primary, secondary } = teamColors(abbr);
  if (luminance(primary) >= 0.07) return primary;
  if (luminance(secondary) >= 0.07) return secondary;
  return "#86d1ea";
}
/** Paire visiteur / domicile : si elles se confondent, le domicile passe en blanc. */
export function sideColors(away: string, home: string): { away: string; home: string } {
  const a = readable(away);
  const h = readable(home);
  return { away: a, home: distance(a, h) < 90 ? "#dfe9ef" : h };
}

// ─── État ─────────────────────────────────────────────────────────────────────

function readOpen(): boolean {
  try { return localStorage.getItem(OPEN_KEY) !== "0"; } catch { return true; }
}
function writeOpen(v: boolean) {
  try { localStorage.setItem(OPEN_KEY, v ? "1" : "0"); } catch { /* aperçu, navigation privée */ }
}

export function PickemSection() {
  const { t } = useI18n();
  const { user } = useAuth();
  const [day, setDay] = useState<PickemDay | null>(null);
  const [open, setOpen] = useState(readOpen);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchPickemDay(ctrl.signal).then((d) => { if (!ctrl.signal.aborted) setDay(d); });
    return () => ctrl.abort();
  }, [user?.id]);

  if (!day || day.games.length === 0) return null;

  const toggle = () => setOpen((v) => { writeOpen(!v); return !v; });
  const update = (g: PickemDayGame) =>
    setDay((d) => d && { ...d, games: d.games.map((x) => (x.gameId === g.gameId ? g : x)) });

  const total = day.games.reduce((n, g) => n + g.total, 0);
  const mine = day.games.filter((g) => g.myVote).length;

  return (
    <div className="flex flex-col gap-2">
      <button type="button" onClick={toggle} aria-expanded={open}
        className="w-full flex items-center justify-between px-1 py-1 text-left">
        <span className="arena-section-title">
          {t("pickem.day.title")} <span className="arena-section-count">({day.games.length})</span>
        </span>
        <span className="flex items-center gap-2">
          {/* Le résumé reste visible replié : de quoi savoir s'il vaut la peine d'ouvrir. */}
          <span className="text-[10px] text-white/50">
            {t("pickem.day.summary", { n: total, mine, games: day.games.length })}
          </span>
          <span className={`text-white/40 text-xs transition-transform ${open ? "rotate-0" : "-rotate-90"}`}>▾</span>
        </span>
      </button>
      {open && (
        <>
          <div className="grid grid-cols-2 gap-2">
            {day.games.map((g) => <GameDonut key={g.gameId} game={g} onChange={update} />)}
          </div>
          <PickemLeaderboard />
          <p className="text-white/40 text-[10px] px-1">{t("pickem.note")}</p>
        </>
      )}
    </div>
  );
}

// ─── L'anneau ─────────────────────────────────────────────────────────────────

/** r = 100/2π : la circonférence vaut 100, un pourcentage = une longueur de trait. */
const R = 15.9155;
const GAP = 1.2;

function Ring({ g, colors, shown }: { g: PickemDayGame; colors: { away: string; home: string }; shown: boolean }) {
  const { t } = useI18n();
  const common = { cx: 18, cy: 18, r: R, fill: "none", strokeWidth: 3.6 } as const;

  if (!g.enough || g.away.pct == null || g.home.pct == null) {
    // Jauge : combien de votes avant d'afficher une répartition.
    const filled = shown ? Math.min(100, (g.total / g.minVotes) * 100) : 0;
    return (
      <svg viewBox="0 0 36 36" className="w-[72px] h-[72px] -rotate-90" role="img"
           aria-label={t("pickem.day.votes", { n: g.total, min: g.minVotes })}>
        <circle {...common} stroke="rgba(255,255,255,0.08)" strokeDasharray="2 1.2" />
        <circle {...common} stroke="rgba(134,209,234,0.55)" strokeLinecap="round"
                strokeDasharray={`${filled} ${100 - filled}`}
                className="motion-safe:transition-[stroke-dasharray] motion-safe:duration-700" />
        <text x="18" y="18" transform="rotate(90 18 18)" textAnchor="middle" dominantBaseline="central"
              className="fill-white/70 text-[7px] font-bold">{g.total}/{g.minVotes}</text>
      </svg>
    );
  }

  // Visiteur depuis midi dans le sens horaire, domicile ensuite ; un petit jour entre les deux.
  const away = shown ? g.away.pct : 50;
  const home = 100 - away;
  const fav = g.home.pct >= g.away.pct ? g.home : g.away;
  const favColor = fav === g.home ? colors.home : colors.away;
  return (
    <svg viewBox="0 0 36 36" className="w-[72px] h-[72px] -rotate-90" role="img"
         aria-label={`${g.away.team} ${g.away.pct} % · ${g.home.team} ${g.home.pct} %`}>
      <circle {...common} stroke={colors.away}
              strokeDasharray={`${Math.max(0, away - GAP)} ${100 - Math.max(0, away - GAP)}`}
              className="motion-safe:transition-[stroke-dasharray] motion-safe:duration-700" />
      <circle {...common} stroke={colors.home}
              strokeDasharray={`${Math.max(0, home - GAP)} ${100 - Math.max(0, home - GAP)}`}
              strokeDashoffset={-away}
              className="motion-safe:transition-[stroke-dasharray,stroke-dashoffset] motion-safe:duration-700" />
      <g transform="rotate(90 18 18)">
        <text x="18" y="16.6" textAnchor="middle" dominantBaseline="central"
              style={{ fill: favColor }} className="text-[8.5px] font-bold">{fav.pct}%</text>
        <text x="18" y="23" textAnchor="middle" dominantBaseline="central"
              className="fill-white/55 text-[4.6px] font-bold">{fav.team}</text>
      </g>
    </svg>
  );
}

// ─── Une carte : anneau + vote ────────────────────────────────────────────────

function GameDonut({ game: g, onChange }: { game: PickemDayGame; onChange: (g: PickemDayGame) => void }) {
  const { t, lang } = useI18n();
  const { requireAuth } = useAuthGate();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // L'anneau part du 50/50 puis tourne à sa place.
  const [shown, setShown] = useState(false);
  useEffect(() => { const id = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(id); }, []);

  const colors = sideColors(g.away.team, g.home.team);
  const status = g.status.toLowerCase();
  const live = status === "live";
  const final = status === "final";
  const crowdPick = g.enough && g.home.pct != null && g.away.pct != null && g.home.pct !== g.away.pct
    ? (g.home.pct > g.away.pct ? g.home.team : g.away.team) : null;

  const when = live ? t("pickem.day.live")
    : final ? `${t("pickem.day.final")} ${g.awayScore ?? "–"}–${g.homeScore ?? "–"}`
    : g.startsAt ? new Date(g.startsAt).toLocaleTimeString(lang === "fr" ? "fr-CA" : "en-US", { hour: "numeric", minute: "2-digit" })
    : "";

  async function vote(team: string) {
    if (!requireAuth("gate.pickem")) return;
    if (g.locked || busy || team === g.myVote) return;
    setBusy(true);
    setError(null);
    try {
      const s = await castPickem(g.gameId, team);
      onChange({ ...g, ...s });
    } catch (e) {
      const started = e instanceof PickemError && e.code === "GAME_STARTED";
      if (started) onChange({ ...g, locked: true });
      setError(started ? t("pickem.closed") : t("pickem.error"));
    } finally {
      setBusy(false);
    }
  }

  const TeamButton = ({ side }: { side: "away" | "home" }) => {
    const s = g[side];
    const mine = g.myVote === s.team;
    const won = final && g.winner === s.team;
    return (
      <button type="button" onClick={() => vote(s.team)} disabled={g.locked || busy} aria-pressed={mine}
        aria-label={`${s.team}${mine ? ` — ${t("pickem.yourPick")}` : ""}`}
        className={`flex items-center justify-center gap-1 flex-1 min-w-0 rounded-lg py-1 border transition active:scale-95 disabled:active:scale-100 ${
          mine ? "bg-white/10" : "border-white/10"} ${g.locked && !mine ? "opacity-55" : ""}`}
        style={mine ? { borderColor: colors[side], boxShadow: `0 0 8px ${colors[side]}55` } : undefined}>
        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: colors[side] }} />
        <img src={nhlLogoUrl(s.team)} alt="" className="w-4 h-4 object-contain" loading="lazy" />
        <span className={`text-[10px] font-bold ${won ? "text-[#ffd257]" : "text-white"}`}>{s.team}</span>
      </button>
    );
  };

  return (
    <div className="chat-tile rounded-2xl p-2 flex flex-col items-center gap-1.5 min-w-0">
      <div className="w-full flex items-center justify-between gap-1 text-[10px]">
        <button type="button" onClick={() => navigate(`/stats/prediction/game/${g.gameId}`)}
          className="text-white/80 font-semibold truncate active:opacity-70">
          {g.away.team} @ {g.home.team}
        </button>
        <span className={`flex-shrink-0 ${live ? "text-red-400 font-bold" : "text-white/45"}`}>{when}</span>
      </div>

      <Ring g={g} colors={colors} shown={shown} />

      <div className="w-full flex gap-1">
        <TeamButton side="away" />
        <TeamButton side="home" />
      </div>

      <p className={`text-[9px] text-center leading-tight ${
        error ? "text-amber-300"
        : final && g.winner && crowdPick ? (crowdPick === g.winner ? "text-emerald-300 font-semibold" : "text-amber-300 font-semibold")
        : "text-white/40"}`}>
        {error
          ?? (final && g.winner && crowdPick
            ? (crowdPick === g.winner ? t("pickem.day.publicRight") : t("pickem.day.publicWrong"))
            : g.myVote ? t("pickem.yourPick") + " · " + g.myVote
            : t("pickem.voters", { n: g.total }))}
      </p>
    </div>
  );
}
