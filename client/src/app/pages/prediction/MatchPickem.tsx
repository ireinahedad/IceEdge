/**
 * MatchPickem.tsx — vote de la communauté, sur la page d'un match.
 * NEWS_CONSENSUS_PLAN.md, F3, session A.
 *
 * Décisions (2026-10-23) : seuls les VRAIS votes, nombre réel de votants
 * affiché ; sous 10 votes, pas de pourcentage. Vote modifiable jusqu'à la mise
 * au jeu, refusé après — le serveur décide, l'écran ne fait que suivre.
 * Visiteur non connecté : il voit la répartition, le vote ouvre l'invite de
 * connexion. Échec de lecture : rien n'est affiché.
 *
 * Refait sobre le 2026-10-24 (demande du user : « trop intense ») : pas d'aplat
 * de couleur, boutons au contour fin avec le logo, barre fine aux couleurs des
 * deux clubs (les mêmes que dans le chat). Vote fermé : plus de boutons.
 */

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { useI18n } from "../../i18n";
import { useAuth } from "../../context/AuthContext";
import { useAuthGate } from "../../context/AuthGateContext";
import { nhlLogoUrl } from "../../data/teamEmoji";
import { sideColors } from "../../data/teamContrast";
import { fetchPickem, castPickem, PickemError, type PickemState } from "../../services/pickemService";

/** `accent` n'est plus utilisé (couleurs des clubs à la place) ; gardé pour l'appelant. */
interface Props { gameId: string; home: string; away: string; accent?: string }

export function MatchPickem({ gameId, home, away }: Props) {
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

  const colors = sideColors(state.away.team, state.home.team);
  // Visiteur à gauche, domicile à droite — comme dans le chat.
  const sides = [
    { s: state.away, label: away, color: colors.away },
    { s: state.home, label: home, color: colors.home },
  ];
  const showPct = state.enough && state.home.pct != null && state.away.pct != null;

  return (
    <div className="bg-[#111a1f] border border-white/10 rounded-2xl px-4 py-3 flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-white/90 text-[13px] font-semibold">{t("pickem.title")}</p>
        <span className="text-[#8a9ea6] text-[11px]">
          {state.locked ? t("pickem.closed") : t("pickem.voters", { n: state.total })}
        </span>
      </div>

      {state.locked ? (
        state.myVote && (
          <p className="text-[11px] text-[#8a9ea6]">
            {t("pickem.yourPick")} : <span className="font-semibold text-white/90">{state.myVote}</span>
          </p>
        )
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {sides.map(({ s, label, color }) => {
            const mine = state.myVote === s.team;
            return (
              <button
                key={s.team}
                type="button"
                onClick={() => vote(s.team)}
                disabled={busy}
                aria-pressed={mine}
                className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-left transition active:scale-[0.98] disabled:active:scale-100 ${
                  mine ? "bg-white/[0.04] text-white" : "border-white/10 text-white/75"
                }`}
                style={mine ? { borderColor: `${color}99` } : undefined}
              >
                <img src={nhlLogoUrl(s.team)} alt="" className="w-5 h-5 object-contain" loading="lazy" />
                <span className="text-[12px] font-semibold">{label}</span>
                <span className="ml-auto flex items-center gap-1 text-[11px] text-white/45">
                  {showPct && `${s.pct} %`}
                  {mine && <Check aria-label={t("pickem.yourPick")} className="w-3.5 h-3.5" style={{ color }} />}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {showPct ? (
        <div className="flex flex-col gap-1">
          <div className="flex h-1 rounded-full overflow-hidden bg-white/10" role="img"
               aria-label={`${state.away.team} ${state.away.pct} % · ${state.home.team} ${state.home.pct} %`}>
            <div style={{ width: `${state.away.pct}%`, background: colors.away, opacity: 0.85 }} />
            <div className="flex-1" style={{ background: colors.home, opacity: 0.85 }} />
          </div>
          {state.locked && (
            <div className="flex justify-between text-[11px] text-[#8a9ea6]">
              <span>{away} {state.away.pct} %</span>
              <span>{state.home.pct} % {home}</span>
            </div>
          )}
        </div>
      ) : (
        <p className="text-[#8a9ea6] text-[11px]">{t("pickem.notEnough", { n: state.total, min: state.minVotes })}</p>
      )}

      <p className="text-[#4a6070] text-[10px]">{t("pickem.note")}</p>
      {error && <p className="text-amber-300 text-[11px]">{error}</p>}
    </div>
  );
}
