/**
 * PickemSection.tsx — « Votes du jour » dans Communauté › Chat.
 * NEWS_CONSENSUS_PLAN.md, F3 : le remplaçant de #pickems, avec les vrais
 * utilisateurs ICEEDGE.
 *
 * Une section dépliable (état retenu par appareil), posée dans la liste des
 * salons. Dépliée : un tableau d'aréna avec les totaux du jour et le graphique
 * « Consensus du jour » (matchs classés par force du consensus), puis une
 * barre « tir à la corde » par match, aux couleurs des deux équipes. Toucher un
 * logo = voter ; le serveur décide de la fermeture (mise au jeu), l'écran suit.
 *
 * UN appel (`GET /api/pickem/today`) pour tous les matchs. Échec ou soirée sans
 * match : la section n'apparaît pas. Sous 10 votes, pas de pourcentage —
 * seulement la jauge « 3/10 votes ». Graphiques en CSS : pas de recharts ici,
 * le chat ne doit pas télécharger le paquet des graphiques.
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useI18n } from "../../../i18n";
import { useAuth } from "../../../context/AuthContext";
import { useAuthGate } from "../../../context/AuthGateContext";
import { nhlLogoUrl, teamColors } from "../../../data/teamEmoji";
import {
  fetchPickemDay, castPickem, PickemError,
  type PickemDay, type PickemDayGame,
} from "../../../services/pickemService";

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

  return (
    <div className="flex flex-col gap-2">
      <button type="button" onClick={toggle} aria-expanded={open}
        className="w-full flex items-center justify-between px-1 py-1 text-left">
        <span className="arena-section-title">
          {t("pickem.day.title")} <span className="arena-section-count">({day.games.length})</span>
        </span>
        <span className={`text-white/40 text-xs transition-transform ${open ? "rotate-0" : "-rotate-90"}`}>▾</span>
      </button>
      {open && (
        <>
          <DayBoard games={day.games} />
          <div className="flex flex-col gap-2">
            {day.games.map((g) => <GameRow key={g.gameId} game={g} onChange={update} />)}
          </div>
          <p className="text-white/40 text-[10px] px-1">{t("pickem.note")}</p>
        </>
      )}
    </div>
  );
}

// ─── Tableau du jour : totaux + graphique du consensus ────────────────────────

function DayBoard({ games }: { games: PickemDayGame[] }) {
  const { t } = useI18n();
  const total = games.reduce((n, g) => n + g.total, 0);
  const openGames = games.filter((g) => !g.locked).length;
  const mine = games.filter((g) => g.myVote).length;
  const minVotes = games[0]?.minVotes ?? 10;

  // Plus fort consensus d'abord ; seuls les matchs qui ont assez de votes.
  const ranked = useMemo(() => games
    .filter((g) => g.enough && g.home.pct != null && g.away.pct != null)
    .map((g) => {
      const fav = g.home.pct! >= g.away.pct! ? g.home : g.away;
      const other = fav === g.home ? g.away : g.home;
      return { g, fav, other, pct: fav.pct! };
    })
    .sort((a, b) => b.pct - a.pct), [games]);

  return (
    <div className="arena-scoreboard">
      <div className="arena-scoreboard-screen px-3 py-3 flex flex-col gap-3">
        <div className="grid grid-cols-3 text-center">
          <Stat value={total} label={t("pickem.day.totalVotes")} />
          <Stat value={openGames} label={t("pickem.day.open")} cool />
          <Stat value={`${mine}/${games.length}`} label={t("pickem.day.mine")} cool />
        </div>

        <div className="flex flex-col gap-1.5">
          <p className="scoreboard-label text-[9px]">{t("pickem.day.consensus")}</p>
          {ranked.length === 0 ? (
            <p className="text-[#8aa4b4] text-[11px]">{t("pickem.day.noConsensus", { min: minVotes })}</p>
          ) : ranked.map(({ g, fav, other, pct }) => {
            const color = sideColors(g.away.team, g.home.team)[fav === g.home ? "home" : "away"];
            return (
              <div key={g.gameId} className="grid grid-cols-[6rem_1fr_2.5rem] items-center gap-2"
                   aria-label={`${fav.team} ${pct} % contre ${other.team}`}>
                <span className="flex items-center gap-1 min-w-0">
                  <img src={nhlLogoUrl(fav.team)} alt="" className="w-4 h-4 object-contain" loading="lazy" />
                  <span className="text-[11px] font-bold text-white">{fav.team}</span>
                  <span className="text-[9px] text-white/40 whitespace-nowrap">/ {other.team}</span>
                </span>
                {/* Part du favori sur 100 %, repère au 50/50 : plus la barre dépasse le repère, plus le public est d'accord. */}
                <span className="relative h-2.5 rounded-full bg-white/[0.07] overflow-hidden">
                  <span className="absolute inset-y-0 left-0 rounded-full motion-safe:transition-[width] motion-safe:duration-700"
                        style={{ width: `${pct}%`, background: color, boxShadow: `0 0 10px ${color}88` }} />
                  <span className="absolute inset-y-0 left-1/2 w-px bg-white/50" />
                </span>
                <span className="scoreboard-digit text-[13px] text-right">{pct}%</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Stat({ value, label, cool }: { value: number | string; label: string; cool?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className={`scoreboard-digit ${cool ? "scoreboard-digit--cool" : ""} text-[22px] leading-none`}>{value}</span>
      <span className="scoreboard-label text-[8px]">{label}</span>
    </div>
  );
}

// ─── Un match : tir à la corde + vote ─────────────────────────────────────────

function GameRow({ game: g, onChange }: { game: PickemDayGame; onChange: (g: PickemDayGame) => void }) {
  const { t, lang } = useI18n();
  const { requireAuth } = useAuthGate();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Les barres partent du milieu puis glissent à leur place.
  const [shown, setShown] = useState(false);
  useEffect(() => { const id = requestAnimationFrame(() => setShown(true)); return () => cancelAnimationFrame(id); }, []);

  const colors = sideColors(g.away.team, g.home.team);
  const status = g.status.toLowerCase();
  const live = status === "live";
  const final = status === "final";
  const awayPct = g.enough ? g.away.pct ?? 50 : 50;
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
        className={`relative flex flex-col items-center gap-0.5 w-14 flex-shrink-0 rounded-xl py-1.5 border transition active:scale-95 disabled:active:scale-100 ${
          mine ? "bg-white/10" : "border-transparent"} ${g.locked && !mine ? "opacity-60" : ""}`}
        style={mine ? { borderColor: colors[side], boxShadow: `0 0 12px ${colors[side]}55` } : undefined}>
        <img src={nhlLogoUrl(s.team)} alt="" className="w-8 h-8 object-contain" loading="lazy" />
        <span className={`text-[11px] font-bold ${won ? "text-[#ffd257]" : "text-white"}`}>{s.team}</span>
        {mine && <span className="text-[9px] font-semibold" style={{ color: colors[side] }}>{t("pickem.yourPick")}</span>}
      </button>
    );
  };

  return (
    <div className="chat-tile rounded-2xl px-3 py-2.5 flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <button type="button" onClick={() => navigate(`/stats/prediction/game/${g.gameId}`)}
          className="text-white/80 font-semibold truncate active:opacity-70">
          {g.away.team} @ {g.home.team}
        </button>
        <span className="flex items-center gap-2 flex-shrink-0">
          <span className={live ? "text-red-400 font-bold" : "text-white/50"}>{when}</span>
          <span className="text-white/40">{t("pickem.voters", { n: g.total })}</span>
        </span>
      </div>

      <div className="flex items-center gap-2">
        <TeamButton side="away" />
        <div className="flex-1 flex flex-col gap-1 min-w-0">
          {g.enough ? (
            <>
              <div className="relative flex h-3 rounded-full overflow-hidden bg-white/10" role="img"
                   aria-label={`${g.away.team} ${g.away.pct} % · ${g.home.team} ${g.home.pct} %`}>
                <span className="h-full motion-safe:transition-[width] motion-safe:duration-700"
                      style={{ width: `${shown ? awayPct : 50}%`, background: colors.away }} />
                <span className="h-full flex-1" style={{ background: colors.home }} />
                {/* Repère du 50/50 */}
                <span className="absolute inset-y-0 left-1/2 w-px bg-black/60" />
              </div>
              <div className="flex justify-between text-[12px] font-bold">
                <span style={{ color: colors.away }}>{g.away.pct} %</span>
                <span style={{ color: colors.home }}>{g.home.pct} %</span>
              </div>
            </>
          ) : (
            <>
              {/* Pas encore de pourcentage : la jauge montre combien de votes manquent. */}
              <div className="h-3 rounded-full overflow-hidden bg-[repeating-linear-gradient(135deg,rgba(255,255,255,0.06)_0_6px,rgba(255,255,255,0.02)_6px_12px)]"
                   role="img" aria-label={t("pickem.day.votes", { n: g.total, min: g.minVotes })}>
                <span className="block h-full bg-[#86d1ea]/40 motion-safe:transition-[width] motion-safe:duration-700"
                      style={{ width: `${shown ? Math.min(100, (g.total / g.minVotes) * 100) : 0}%` }} />
              </div>
              <p className="text-center text-[10px] text-white/50">{t("pickem.day.votes", { n: g.total, min: g.minVotes })}</p>
            </>
          )}
        </div>
        <TeamButton side="home" />
      </div>

      {final && g.winner && crowdPick && (
        <p className={`text-[10px] font-semibold text-center ${crowdPick === g.winner ? "text-emerald-300" : "text-amber-300"}`}>
          {crowdPick === g.winner ? t("pickem.day.publicRight") : t("pickem.day.publicWrong")}
        </p>
      )}
      {!g.locked && !g.myVote && <p className="text-[10px] text-white/35 text-center">{t("pickem.day.tapToVote")}</p>}
      {error && <p className="text-amber-300 text-[11px] text-center">{error}</p>}
    </div>
  );
}
