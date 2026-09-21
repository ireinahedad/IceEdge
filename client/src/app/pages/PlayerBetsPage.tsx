import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router";
import { toast } from "sonner";
import { BottomNav } from "../components/BottomNav";
import { ProLock } from "../components/ProLock";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { profileApiService, ApiError } from "../services/userService";
import { useAuth } from "../context/AuthContext";
import { useBlocks } from "../context/BlockContext";
import { useI18n } from "../i18n";
import "../components/rink-theme.css";
import type { PlayerSummary, PublicSlip, PublicSlipLeg } from "../types/user";
import { outcomeKey } from "../services/slipOutcome";

const ACCENT = "#86d1ea";
const WIN    = "#4ade80";
const LOSS   = "#f87171";
const MUTED  = "#8a9ea6";

/**
 * Page joueur — les derniers coupons d'un autre membre, jambe par jambe.
 *
 * Réservée aux abonnés Pro (le serveur renvoie 402 sinon ; on ne se contente
 * jamais de masquer côté client). Trois refus distincts arrivent ici et
 * n'appellent pas la même réaction :
 *   402 → il faut être Pro          → mur Pro + lien vers /pro
 *   403 → ce joueur masque ses coupons → message neutre, l'abonnement n'est pas en cause
 *   404 → ce joueur n'existe pas
 */

type LoadState =
  | { kind: "loading" }
  | { kind: "ok"; summary: PlayerSummary; slips: PublicSlip[] }
  | { kind: "pro" }
  | { kind: "hidden" }
  | { kind: "missing" }
  | { kind: "error"; message: string };

function initials(name: string): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function outcomeColor(outcome: PublicSlip["outcome"]): string {
  // `void` retombe sur MUTED avec `pending` : un coupon annulé n'est pas rouge.
  return outcome === "win" ? WIN : outcome === "loss" ? LOSS : MUTED;
}

/**
 * Pictogramme d'une jambe.
 *
 * `undefined` (coupon réglé avant que les résultats par jambe soient conservés)
 * et `"unknown"` (marché que le règlement automatique ne sait pas trancher)
 * donnent tous deux « — ». Jamais une croix : afficher un pari non évalué comme
 * perdu fausserait la lecture d'un bilan, ce qui est exactement ce que cette
 * page est censée rendre fiable.
 */
function legMark(result: PublicSlipLeg["result"], slipPending: boolean): { icon: string; color: string } {
  if (result === "win")  return { icon: "✅", color: WIN };
  if (result === "loss") return { icon: "❌", color: LOSS };
  if (slipPending)       return { icon: "⏳", color: MUTED };
  return { icon: "—", color: MUTED };
}

// ─── Carte d'un coupon ────────────────────────────────────────────────────────

function SlipCard({ slip }: { slip: PublicSlip }) {
  const { t, lang } = useI18n();
  const [open, setOpen] = useState(false);

  const locale  = lang === "fr" ? "fr-CA" : "en-US";
  const color   = outcomeColor(slip.outcome);
  const pending = slip.outcome === "pending";
  const label   = t(outcomeKey(slip.outcome));

  const date = new Date(slip.placedAt).toLocaleDateString(locale, { month: "short", day: "numeric" });
  const kind = slip.isParlay ? t("player.parlayLegs", { n: String(slip.legCount) }) : t("player.single");

  // Coupon verrouillé : le serveur n'a pas envoyé les jambes. Rien à déplier —
  // on annonce l'heure de dévoilement plutôt qu'un état mort.
  if (slip.locked) {
    const unlock = slip.locksAt
      ? new Date(slip.locksAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })
      : null;
    return (
      <div className="rounded-2xl px-3.5 py-3" style={{ background: "#111a1f" }}>
        <div className="flex items-center gap-2.5">
          <span className="text-sm">🔒</span>
          <div className="flex-1 min-w-0">
            <p className="text-white text-[12px] font-medium">{date} · {kind}</p>
            <p className="text-[11px]" style={{ color: MUTED }}>
              {unlock ? t("player.unlocksAt", { time: unlock }) : t("player.unlocksAtStart")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const legs = slip.legs ?? [];

  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: "#111a1f" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2.5 px-3.5 py-3 text-left active:opacity-80"
        aria-expanded={open}
      >
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
        <div className="flex-1 min-w-0">
          <p className="text-white text-[12px] font-medium truncate">{date} · {kind}</p>
          {slip.combinedProbability != null && (
            <p className="text-[11px]" style={{ color: MUTED }}>{slip.combinedProbability}%</p>
          )}
        </div>
        <span className="text-[11px] font-bold flex-shrink-0" style={{ color }}>{label}</span>
        <span className="text-[11px] flex-shrink-0" style={{ color: MUTED }}>{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="px-3.5 pb-3 flex flex-col gap-1.5">
          {legs.length === 0 && (
            <p className="text-[11px]" style={{ color: MUTED }}>{t("player.noLegDetail")}</p>
          )}
          {legs.map((leg, i) => {
            const mark = legMark(leg.result, pending);
            // La jambe qui a fait tomber le combiné : c'est l'information qu'on
            // cherche en ouvrant un coupon perdu, elle mérite d'être trouvée
            // sans lire toute la liste.
            const isCulprit = slip.outcome === "loss" && leg.result === "loss";
            return (
              <div
                key={`${slip.id}-${i}`}
                className="flex items-center gap-2 rounded-xl px-2.5 py-2"
                style={{
                  background: isCulprit ? "rgba(248,113,113,0.10)" : "rgba(255,255,255,0.03)",
                  border: isCulprit ? "1px solid rgba(248,113,113,0.35)" : "1px solid transparent",
                }}
              >
                <span className="text-[11px] flex-shrink-0" style={{ color: mark.color }}>{mark.icon}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-white text-[11px] truncate">
                    {leg.selection ?? leg.subjectName}
                    {leg.line != null ? ` ${leg.line}` : ""}
                  </p>
                  <p className="text-[11px] truncate" style={{ color: MUTED }}>{leg.subjectName}</p>
                </div>
                <span className="text-[11px] flex-shrink-0" style={{ color: MUTED }}>
                  {Math.round(leg.probability)}%
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── En-tête : forme récente ──────────────────────────────────────────────────

function FormCard({ summary }: { summary: PlayerSummary }) {
  const { t, lang } = useI18n();
  const { form, overall } = summary;

  // hitRate à null = sous le plancher d'échantillon. Le serveur refuse de
  // calculer le pourcentage ; le client ne doit surtout pas le reconstituer.
  const enoughSample = form.hitRate != null;

  const sinceLabel = overall.since
    ? new Date(overall.since).toLocaleDateString(lang === "fr" ? "fr-CA" : "en-US", { month: "long", day: "numeric", year: "numeric" })
    : null;

  return (
    <div className="rounded-2xl px-4 py-3.5 mb-3" style={{ background: "#111a1f" }}>
      {enoughSample ? (
        <p className="text-white text-[13px] font-semibold leading-snug">
          <span style={{ color: ACCENT }}>{form.hitRate}%</span>{" "}
          {t("player.formLine", { settled: String(form.settled) })}
        </p>
      ) : (
        <p className="text-white text-[13px] font-semibold leading-snug">
          {t("player.formTooFew", { settled: String(form.settled) })}
        </p>
      )}

      {overall.settled > 0 && (
        <p className="text-[11px] mt-1.5" style={{ color: MUTED }}>
          {overall.hitRate != null ? `${overall.hitRate}% · ` : ""}
          {t("player.overallLine", { settled: String(overall.settled) })}
          {sinceLabel ? ` ${t("player.since", { date: sinceLabel })}` : ""}
        </p>
      )}
    </div>
  );
}

/** Squelette inerte affiché sous le mur Pro — jamais de vraies données floutées. */
function LockedPreview() {
  return (
    <div className="flex flex-col gap-2">
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-2.5 rounded-2xl px-3.5 py-3" style={{ background: "#111a1f" }}>
          <span className="w-2 h-2 rounded-full bg-white/25" />
          <div className="flex-1">
            <div className="h-2.5 w-28 bg-white/15 rounded mb-1.5" />
            <div className="h-2 w-16 bg-white/10 rounded" />
          </div>
          <span className="text-[11px] font-bold text-white/25">••</span>
        </div>
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function PlayerBetsPage() {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const { t } = useI18n();
  const { user } = useAuth();
  const { isBlocked, block, unblock, ensureLoaded } = useBlocks();
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  // La liste de blocage doit être chargée pour savoir quel bouton afficher.
  useEffect(() => { ensureLoaded(); }, [ensureLoaded]);

  useEffect(() => {
    if (!userId) { setState({ kind: "missing" }); return; }

    let cancelled = false;
    setState({ kind: "loading" });

    Promise.all([
      profileApiService.getPlayerSummary(userId),
      profileApiService.getPlayerSlips(userId),
    ])
      .then(([summary, slips]) => {
        if (!cancelled) setState({ kind: "ok", summary, slips });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError) {
          if (err.status === 402) return setState({ kind: "pro" });
          if (err.status === 403) return setState({ kind: "hidden" });
          if (err.status === 404) return setState({ kind: "missing" });
        }
        setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      });

    return () => { cancelled = true; };
  }, [userId]);

  const title =
    state.kind === "ok" ? state.summary.displayName : t("player.title");

  // ── Bloquer depuis la page joueur ────────────────────────────────────────
  // Deuxième porte après la fiche de compte : on arrive souvent ici par un lien
  // ou un partage, sans passer par le chat, et il faut pouvoir agir sur place.
  //
  // Réservé à l'état `ok` : le blocage optimiste a besoin du pseudo et de
  // l'avatar pour dessiner la ligne dans les Réglages, et un profil masqué ou
  // verrouillé par le mur Pro ne les fournit pas.
  const isSelf = !!user && !!userId && user.id === userId;
  const blocked = isBlocked(userId);

  async function handleBlock() {
    if (state.kind !== "ok") return;
    setConfirmBlock(false);
    setBlocking(true);
    try {
      await block({
        id: state.summary.userId,
        username: state.summary.username,
        displayName: state.summary.displayName,
        avatar: state.summary.avatar,
        avatarUrl: state.summary.avatarUrl,
      });
      toast.success(t("block.done", { name: state.summary.displayName }));
    } catch (e: any) {
      toast.error(e?.message ?? t("block.failed"));
    } finally { setBlocking(false); }
  }

  async function handleUnblock() {
    if (!userId) return;
    setBlocking(true);
    try {
      await unblock(userId);
      toast.success(t("block.unblockDone", { name: title }));
    } catch (e: any) {
      toast.error(e?.message ?? t("block.unblockFailed"));
    } finally { setBlocking(false); }
  }

  return (
    <div className="flex flex-col min-h-screen pb-[calc(6rem+env(safe-area-inset-bottom,0px))]" style={{ background: "#0A0E0C" }}>
      <div
        className="sticky top-0 z-40"
        style={{ background: "rgba(10,14,12,0.92)", backdropFilter: "blur(16px)", paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <div className="px-4 pt-3 pb-3 flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="tap-44 text-[#3a5060] text-lg" aria-label={t("common.back")}>←</button>
          <h1 className="text-white text-base font-bold flex-1 truncate">{title}</h1>
        </div>
      </div>

      <div className="px-4 pt-4 max-w-[430px] w-full mx-auto">
        {state.kind === "loading" && (
          <div className="flex flex-col gap-2">
            <div className="h-16 rounded-2xl bg-white/5 animate-pulse" />
            {[1, 2, 3].map((i) => <div key={i} className="h-14 rounded-2xl bg-white/5 animate-pulse" />)}
          </div>
        )}

        {state.kind === "pro" && (
          <ProLock locked title={t("player.proTitle")} description={t("player.proDesc")}>
            <LockedPreview />
          </ProLock>
        )}

        {state.kind === "hidden" && (
          <div className="rounded-2xl px-4 py-6 text-center" style={{ background: "#111a1f" }}>
            <p className="text-2xl mb-2">🙈</p>
            <p className="text-white text-sm font-semibold mb-1">{t("player.hiddenTitle")}</p>
            <p className="text-[11px]" style={{ color: MUTED }}>{t("player.hiddenDesc")}</p>
          </div>
        )}

        {state.kind === "missing" && (
          <div className="rounded-2xl px-4 py-6 text-center" style={{ background: "#111a1f" }}>
            <p className="text-white text-sm font-semibold">{t("player.notFound")}</p>
          </div>
        )}

        {state.kind === "error" && (
          <div className="rounded-2xl px-4 py-6 text-center" style={{ background: "#111a1f" }}>
            <p className="text-white text-sm font-semibold mb-1">{t("player.errorTitle")}</p>
            <p className="text-[11px]" style={{ color: MUTED }}>{state.message}</p>
          </div>
        )}

        {state.kind === "ok" && (
          <>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-14 h-14 rounded-2xl flex items-center justify-center text-base font-bold text-white/80 overflow-hidden flex-shrink-0"
                style={{ background: "#111a1f" }}>
                {state.summary.avatarUrl
                  ? <img src={state.summary.avatarUrl} alt="" className="w-full h-full object-cover" />
                  : initials(state.summary.displayName)}
              </div>
              <div className="min-w-0">
                <p className="text-white text-sm font-bold truncate">{state.summary.displayName}</p>
                <p className="text-[11px] truncate" style={{ color: MUTED }}>
                  @{state.summary.username}{state.summary.tier ? ` · ${state.summary.tier}` : ""}
                </p>
              </div>
            </div>

            {!isSelf && (
              <div className="flex gap-2 mb-3">
                {blocked ? (
                  <button
                    onClick={handleUnblock}
                    disabled={blocking}
                    className="flex-1 py-2.5 rounded-2xl bg-[#86d1ea] text-[#072E49] text-xs font-bold disabled:opacity-50"
                  >
                    {t("blocked.unblock")}
                  </button>
                ) : (
                  <button
                    onClick={() => setConfirmBlock(true)}
                    disabled={blocking}
                    className="flex-1 py-2.5 rounded-2xl border border-red-400/30 text-red-400 text-xs font-semibold disabled:opacity-50"
                  >
                    🚫 {t("chat.blockUser")}
                  </button>
                )}
              </div>
            )}

            <FormCard summary={state.summary} />

            {state.slips.length === 0 ? (
              // Un joueur actif mais sans coupon depuis la coupure n'est PAS un
              // joueur qui se cache : les deux situations n'appellent pas la
              // même réaction, elles ne partagent donc pas le même écran.
              <div className="rounded-2xl px-4 py-6 text-center" style={{ background: "#111a1f" }}>
                <p className="text-[11px]" style={{ color: MUTED }}>{t("player.noSlipsYet")}</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {state.slips.map((s) => <SlipCard key={s.id} slip={s} />)}
              </div>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirmBlock}
        title={t("block.title", { name: title })}
        description={t("block.description")}
        confirmLabel={t("block.confirm")}
        onConfirm={handleBlock}
        onCancel={() => setConfirmBlock(false)}
      />

      <BottomNav />
    </div>
  );
}
