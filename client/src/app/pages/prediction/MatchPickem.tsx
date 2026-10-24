/**
 * MatchPickem.tsx — « Qui gagne ? » des utilisateurs ICEEDGE, sur la page d'un
 * match. NEWS_CONSENSUS_PLAN.md, F3, session A.
 *
 * Décisions (2026-10-23) : seuls les VRAIS votes ICEEDGE, nombre réel de
 * votants affiché ; sous 10 votes, pas de pourcentage. Vote modifiable jusqu'à
 * la mise au jeu, refusé après — le serveur décide, l'écran ne fait que suivre.
 * Visiteur non connecté : il voit la répartition, le vote ouvre l'invite de
 * connexion. Échec de lecture : rien n'est affiché.
 */

import { useEffect, useState } from "react";
import { useI18n } from "../../i18n";
import { useAuth } from "../../context/AuthContext";
import { useAuthGate } from "../../context/AuthGateContext";
import { fetchPickem, castPickem, PickemError, type PickemState } from "../../services/pickemService";

interface Props { gameId: string; home: string; away: string; accent: string }

export function MatchPickem({ gameId, home, away, accent }: Props) {
  const { t } = useI18n();
  const { user } = useAuth();
  const { requireAuth } = useAuthGate();
  const [state, setState] = useState<PickemState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Relu quand la session change : le vote affiché est celui de la personne connectée.
  useEffect(() => {
    const ctrl = new AbortController();
    fetchPickem(gameId, ctrl.signal).then((s) => { if (!ctrl.signal.aborted) setState(s); });
    return () => ctrl.abort();
  }, [gameId, user?.id]);

  if (!state) return null;

  const vote = async (team: string) => {
    if (!requireAuth("gate.pickem")) return;
    if (state.locked || busy || team === state.myVote) return;
    setBusy(true);
    setError(null);
    try {
      setState(await castPickem(gameId, team));
    } catch (e) {
      const code = e instanceof PickemError ? e.code : undefined;
      if (code === "GAME_STARTED") setState({ ...state, locked: true });
      setError(code === "GAME_STARTED" ? t("pickem.closed") : t("pickem.error"));
    } finally {
      setBusy(false);
    }
  };

  // Même ordre que l'en-tête de la page : domicile, puis visiteur.
  const sides = [
    { s: state.home, label: home },
    { s: state.away, label: away },
  ];

  return (
    <div className="bg-[#111a1f] border border-white/20 rounded-2xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-white text-sm font-bold">{t("pickem.title")}</p>
        <span className="text-[#8a9ea6] text-[11px]">
          {state.locked ? t("pickem.closed") : t("pickem.voters", { n: state.total })}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {sides.map(({ s, label }) => {
          const mine = state.myVote === s.team;
          return (
            <button
              key={s.team}
              type="button"
              onClick={() => vote(s.team)}
              disabled={state.locked || busy}
              aria-pressed={mine}
              className={`rounded-xl px-3 py-2 text-sm font-bold border transition active:scale-95 disabled:active:scale-100 ${
                mine ? "text-[#0b1215]" : "text-white border-white/20 bg-white/5"
              } ${state.locked && !mine ? "opacity-60" : ""}`}
              style={mine ? { background: accent, borderColor: accent } : undefined}
            >
              {label}
              {mine && <span className="block text-[10px] font-semibold">{t("pickem.yourPick")}</span>}
            </button>
          );
        })}
      </div>

      {state.enough && state.home.pct != null && state.away.pct != null ? (
        <div className="flex flex-col gap-1">
          <div className="flex h-2 rounded-full overflow-hidden bg-white/10" role="img"
               aria-label={`${home} ${state.home.pct} % · ${away} ${state.away.pct} %`}>
            <div style={{ width: `${state.home.pct}%`, background: accent }} />
            <div className="bg-white/40" style={{ width: `${state.away.pct}%` }} />
          </div>
          <div className="flex justify-between text-[11px] text-[#c0cdd4]">
            <span>{home} {state.home.pct} %</span>
            <span>{state.away.pct} % {away}</span>
          </div>
          <p className="text-[#4a6070] text-[10px]">{t("pickem.note")}</p>
        </div>
      ) : (
        <p className="text-[#8a9ea6] text-[11px]">{t("pickem.notEnough", { n: state.total, min: state.minVotes })}</p>
      )}

      {error && <p className="text-amber-300 text-[11px]">{error}</p>}
    </div>
  );
}
