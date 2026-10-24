/**
 * PickemLeaderboard.tsx — classement hebdomadaire du pick'em, sous les anneaux
 * de « Votes du jour ». NEWS_CONSENSUS_PLAN.md, F3 session B.
 *
 * Replié par défaut (la section doit rester compacte) et chargé seulement à
 * l'ouverture. Semaine lundi → dimanche (heure de l'Est), 10 picks réglés
 * minimum pour être classé. Trois repères côte à côte : le modèle ICEEDGE et
 * le choix majoritaire du public sur les MÊMES matchs, et votre propre taux.
 */

import { useEffect, useState } from "react";
import { useI18n } from "../../../i18n";
import { useAuth } from "../../../context/AuthContext";
import { fetchPickemLeaderboard, type PickemLeaderboard as Board } from "../../../services/pickemService";

type Week = "current" | "previous";

export function PickemLeaderboard() {
  const { t, lang } = useI18n();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [week, setWeek] = useState<Week>("current");
  const [board, setBoard] = useState<Board | null | undefined>(undefined); // undefined = en cours

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    setBoard(undefined);
    fetchPickemLeaderboard(week, ctrl.signal).then((b) => { if (!ctrl.signal.aborted) setBoard(b); });
    return () => ctrl.abort();
  }, [open, week, user?.id]);

  const range = (b: Board) => {
    const f = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(lang === "fr" ? "fr-CA" : "en-US", { day: "numeric", month: "short", timeZone: "UTC" });
    return `${f(b.weekStart)} – ${f(b.weekEnd)}`;
  };

  return (
    <div className="chat-tile rounded-2xl px-3 py-2">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="w-full flex items-center justify-between text-left">
        <span className="text-white text-xs font-bold">🏆 {t("pickem.board.title")}</span>
        <span className={`text-white/40 text-xs transition-transform ${open ? "rotate-0" : "-rotate-90"}`}>▾</span>
      </button>

      {open && (
        <div className="flex flex-col gap-2 mt-2">
          <div className="flex gap-1">
            {(["current", "previous"] as Week[]).map((w) => (
              <button key={w} type="button" onClick={() => setWeek(w)}
                className={`flex-1 rounded-lg py-1 text-[10px] font-bold border ${
                  week === w ? "bg-[#86d1ea] text-[#072E49] border-[#86d1ea]" : "text-white/60 border-white/10"}`}>
                {t(w === "current" ? "pickem.board.thisWeek" : "pickem.board.lastWeek")}
              </button>
            ))}
          </div>

          {board === undefined ? (
            <div className="h-24 rounded-xl bg-white/5 animate-pulse" />
          ) : board === null ? (
            <p className="text-white/50 text-[11px]">{t("pickem.error.load")}</p>
          ) : (
            <>
              <p className="text-white/40 text-[10px]">{range(board)}</p>

              <div className="grid grid-cols-3 gap-1.5">
                <Chip label={t("pickem.board.model")} pct={board.model.pct} sub={`${board.model.wins}/${board.model.games}`} color="#86d1ea" />
                <Chip label={t("pickem.board.crowd")} pct={board.crowd.pct} sub={`${board.crowd.wins}/${board.crowd.games}`} color="#ffd257" />
                <Chip label={t("pickem.board.you")} pct={board.me?.pct ?? null}
                      sub={board.me ? `${board.me.wins}/${board.me.picks}` : "—"} color="#7ee0a8" />
              </div>
              <p className="text-white/35 text-[9px] leading-tight">{t("pickem.board.sameGames")}</p>

              {board.ranked.length === 0 ? (
                <p className="text-white/50 text-[11px] py-1">{t("pickem.board.empty", { min: board.minPicks })}</p>
              ) : (
                <ol className="flex flex-col">
                  {board.ranked.slice(0, 10).map((r) => {
                    const me = r.userId === user?.id;
                    return (
                      <li key={r.userId}
                          className={`grid grid-cols-[1.5rem_1fr_3rem_2.5rem] items-center gap-2 py-1 border-b border-white/5 last:border-0 ${me ? "bg-white/5 rounded-md" : ""}`}>
                        <span className={`text-[11px] font-bold text-center ${r.rank === 1 ? "text-[#ffd257]" : "text-white/50"}`}>{r.rank}</span>
                        <span className="text-[11px] text-white truncate">{r.displayName || r.username}</span>
                        <span className="relative h-1.5 rounded-full bg-white/10 overflow-hidden">
                          <span className="absolute inset-y-0 left-0 rounded-full bg-[#86d1ea]" style={{ width: `${r.pct}%` }} />
                        </span>
                        <span className="text-[11px] font-bold text-white text-right">{r.pct}%</span>
                      </li>
                    );
                  })}
                </ol>
              )}

              {board.me && (
                <p className="text-white/55 text-[10px]">
                  {board.me.rank != null
                    ? t("pickem.board.myRank", { ord: lang === "fr" ? (board.me.rank === 1 ? "1er" : `${board.me.rank}e`) : `#${board.me.rank}`, n: board.rankedCount })
                    : t("pickem.board.notRanked", { n: board.me.picks, min: board.minPicks })}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Chip({ label, pct, sub, color }: { label: string; pct: number | null; sub: string; color: string }) {
  return (
    <div className="rounded-xl bg-black/25 border border-white/10 px-1.5 py-1.5 flex flex-col items-center gap-0.5">
      <span className="text-[9px] uppercase tracking-wider text-white/50">{label}</span>
      <span className="text-[15px] font-bold leading-none" style={{ color }}>{pct == null ? "—" : `${pct}%`}</span>
      <span className="text-[9px] text-white/40">{sub}</span>
    </div>
  );
}
