/**
 * MySlipsTab.tsx
 *
 * Extrait de BetBuilderPage.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router";
import { Lock, Share2, Clock, History, Trophy, AlertCircle, RefreshCw, MessageSquare, X } from "lucide-react";
import { profileApiService } from "../../services/userService";
import type { ChatRoom } from "../../types/user";
import { getMySlips, settleMySlips } from "../../services/slipApiService";
import { ErrorState } from "../../components/ErrorState";
import type { BetSlip } from "../../services/slipApiService";
import { shareImageBlob, ShareUnavailableError } from "../../services/shareImage";
import { renderSlipShareCard } from "../../services/slipShareCanvas";
import type { SlipShareLabels } from "../../services/slipShareCanvas";
import { toOddsLabel } from "./betParts";
import { useI18n } from "../../i18n";
import { outcomeKey } from "../../services/slipOutcome";
import { toast } from "sonner";


// ─── Textes de l'image de partage ─────────────────────────────────────────────

/**
 * `slipShareCanvas` ne traduit rien : c'est un module de dessin, sans React ni
 * `useI18n` (et `translate` n'est pas exporté). Les textes de l'image sont donc
 * composés ici, là où le hook existe, et passés au rendu.
 */
function shareLabels(
  slip: BetSlip,
  { t, lang }: Pick<ReturnType<typeof useI18n>, "t" | "lang">,
): SlipShareLabels {
  const settled = slip.outcome !== "pending";
  const when    = new Date(settled && slip.resolvedAt ? slip.resolvedAt : slip.placedAt);
  const date    = when.toLocaleDateString(lang === "fr" ? "fr-CA" : "en-US", { month: "long", day: "numeric" });
  const n       = Array.isArray(slip.legs) ? slip.legs.length : 0;
  const odds    = slip.combinedProbability != null ? toOddsLabel(slip.combinedProbability) : "—";

  return {
    dateLine:   t(settled ? "share.settledOn" : "share.lockedOn", { date }),
    combined:   t("share.combined"),
    summary:    t(n === 1 ? "share.summaryOne" : "share.summary", { n, odds }),
    // L'issue est un mot, pas une couleur d'anneau : l'anneau garde l'échelle
    // de probabilité, y compris sur un coupon gagné à 27 %.
    // Trois issues possibles une fois réglé, pas deux : un coupon `void`
    // affiché « PERDU » accuserait le joueur d'avoir raté un pari que le
    // serveur n'a jamais jugé.
    outcome:    settled ? t(outcomeKey(slip.outcome)).toLocaleUpperCase(lang) : null,
    xp:         slip.xpAwarded > 0 ? `+${slip.xpAwarded} XP` : null,
    disclaimer: t("share.disclaimer"),
    moreLegs:   (k: number) => t("share.moreLegs", { n: k }),
  };
}

// ─── Envoyer un coupon dans une salle ─────────────────────────────────────────

/**
 * Choisir la salle, puis envoyer — sans passer par l'écran du salon.
 *
 * ⚠️ Le message ne transporte que le `slipId` : c'est le SERVEUR qui reconstruit
 * la carte depuis `bet_slips`, en filtrant sur le propriétaire (voir migration
 * 036). Deux conséquences à ne pas défaire :
 *   - on ne peut envoyer que SON coupon, et personne ne peut fabriquer une
 *     carte de toutes pièces depuis le client ;
 *   - ce chemin ne touche pas `show_slips`. Envoyer un coupon dans une salle ne
 *     le rend PAS visible sur la page joueur, et avoir masqué sa page joueur
 *     n'empêche pas de l'envoyer.
 */
function ShareToRoomSheet({ slip, onClose }: { slip: BetSlip; onClose: () => void }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [rooms, setRooms] = useState<ChatRoom[] | null>(null);
  const [sending, setSending] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    profileApiService.getChatRooms()
      .then((r) => { if (alive) setRooms(r.filter((room) => room.isMember !== false)); })
      .catch(() => { if (alive) setRooms([]); });
    return () => { alive = false; };
  }, []);

  async function send(room: ChatRoom) {
    setSending(room.id);
    try {
      await profileApiService.sendMessage(room.id, {
        // Le texte reste MODÉRÉ et obligatoire côté serveur : la carte ne
        // remplace pas le message, elle l'accompagne.
        text:   t("slip.shareRoomMessage", {
          n:   slip.legCount,
          pct: slip.combinedProbability != null ? `${slip.combinedProbability}%` : "—",
        }),
        slipId: slip.id,
      });
      onClose();
      toast.success(t("slip.sharedToRoom", { room: room.name }), {
        action: { label: t("slip.openRoom"), onClick: () => navigate("/league") },
      });
    } catch (err: any) {
      toast.error(err?.message ?? t("slip.shareRoomFailed"));
    } finally {
      setSending(null);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70" onClick={onClose}>
      <div
        className="icy-card bet-ink-black w-full max-w-[430px] rounded-t-3xl p-4 pb-nav-safe flex flex-col gap-3"
        style={{ background: "#131A12" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <p className="text-white text-sm font-bold">{t("slip.pickRoom")}</p>
          <button onClick={onClose} aria-label={t("common.close")}
            className="tap-44 w-7 h-7 rounded-full icy-tile flex items-center justify-center text-[#8a9ea6]">
            <X size={12} />
          </button>
        </div>

        {rooms === null ? (
          <div className="flex flex-col gap-2">
            {[1, 2, 3].map((i) => <div key={i} className="h-12 icy-tile rounded-xl animate-pulse" />)}
          </div>
        ) : rooms.length === 0 ? (
          <p className="text-[#8a9ea6] text-xs py-6 text-center">{t("slip.noRooms")}</p>
        ) : (
          <div className="flex flex-col gap-1.5 max-h-[46vh] overflow-y-auto">
            {rooms.map((room) => (
              <button
                key={room.id}
                onClick={() => { void send(room); }}
                disabled={sending !== null}
                className="tap-44 flex items-center gap-3 px-3 py-2.5 rounded-xl icy-tile text-left active:scale-[0.98] transition-transform disabled:opacity-50"
              >
                <span className="text-base flex-shrink-0">{room.icon}</span>
                <span className="flex-1 min-w-0">
                  <span className="block text-white text-xs font-medium truncate">{room.name}</span>
                  <span className="block text-[#8a9ea6] text-[11px]">
                    {t("slip.roomMembers", { n: room.memberCount })}
                  </span>
                </span>
                {sending === room.id && (
                  <span className="w-4 h-4 rounded-full border-2 border-white/20 border-t-white animate-spin flex-shrink-0" />
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Slip card (My Slips) ─────────────────────────────────────────────────────

function SlipCard({ slip }: { slip: BetSlip }) {
  const { t, lang } = useI18n();
  const [sharing, setSharing] = useState(false);
  const [roomPicker, setRoomPicker] = useState(false);

  async function handleShare() {
    setSharing(true);
    try {
      // L'image est DESSINÉE, pas capturée : elle ne dépend donc plus de ce que
      // cette carte-ci affiche, ni d'un logo tiers qui refuserait le CORS.
      const png = await renderSlipShareCard(slip, shareLabels(slip, { t, lang }));
      await shareImageBlob(png, `arakice-slip-${slip.id}.png`, "ArakIce");
    } catch (err) {
      // Avant : un `console.warn` seul. L'utilisateur touchait « Partager » et
      // il ne se passait rien — le pire mode d'échec possible, parce qu'il est
      // indiscernable d'un bouton mort.
      console.warn("[Share] failed:", err);
      toast.error(
        err instanceof ShareUnavailableError
          ? t("slip.shareUnavailable")
          : t("slip.shareFailed"),
      );
    } finally {
      setSharing(false);
    }
  }

  const isPending = slip.outcome === "pending";
  const isWin = slip.outcome === "win";
  const isVoid = slip.outcome === "void";
  const date = new Date(slip.placedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const time = new Date(slip.placedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  // Un coupon annulé se lit comme « en attente » : gris, neutre, sans anneau
  // de couleur. C'est un non-événement, pas une défaite.
  const isNeutral    = isPending || isVoid;
  const outcomeColor = isNeutral ? "#8a9ea6" : isWin ? "#86d1ea" : "#f87171";
  const outcomeBg    = isNeutral ? "bg-white/5 border-white/10" : isWin ? "bg-green-500/10 border-green-500/20" : "bg-red-500/10 border-red-500/20";
  const outcomeLabel = t(outcomeKey(slip.outcome));
  const OutcomeIcon  = isNeutral ? Clock : isWin ? Trophy : AlertCircle;

  const combinedColor =
    (slip.combinedProbability ?? 0) >= 65 ? "#86d1ea" :
    (slip.combinedProbability ?? 0) >= 45 ? "#90C9F0" :
    (slip.combinedProbability ?? 0) >= 25 ? "#facc15" : "#f87171";

  return (
    <div className={`icy-card rounded-2xl overflow-hidden transition-all ${
      isNeutral ? "" : isWin ? "ring-1 ring-green-500/40" : "ring-1 ring-red-500/40"
    }`} style={{ background: "#131A12" }}>
      {/* Header row */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-bold ${outcomeBg}`}
            style={{ color: outcomeColor }}>
            <OutcomeIcon size={10} />
            {outcomeLabel}
          </div>
          {slip.isParlay && (
            <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-[#90C9F0]/10 text-[#90C9F0] border border-[#90C9F0]/20">
              {slip.legCount}-leg parlay
            </span>
          )}
          {!slip.isParlay && (
            <span className="text-[11px] text-[#4a6068]">Single</span>
          )}
        </div>
        <div className="text-right">
          <p className="text-[11px] text-[#4a6068]">{date} · {time}</p>
          {slip.combinedProbability != null && (
            <p className="text-sm font-black" style={{ color: combinedColor }}>
              {slip.combinedProbability}%
            </p>
          )}
        </div>
      </div>

      {/* Legs */}
      <div className="px-4 pb-3 flex flex-col gap-1.5">
        {(slip.legs as any[]).map((leg, i) => (
          <div key={i} className="flex items-center gap-2 py-1.5 border-t border-white/[0.05] first:border-0">
            {leg.subjectLogo?.startsWith("http")
              ? <img
                  src={leg.subjectLogo}
                  alt=""
                  // Ce logo portait `crossOrigin="anonymous"` et un `onError`
                  // qui le retirait : c'était pour que la CAPTURE DOM ne
                  // contamine pas son canvas. Depuis que l'image de partage est
                  // dessinée (`slipShareCanvas.ts`), elle ne charge plus aucun
                  // logo — le mode CORS ne protégeait donc plus rien et coûtait
                  // une requête refusée par logo sur les CDN sans en-tête.
                  className="w-5 h-5 object-contain flex-shrink-0"
                />
              : <span className="text-sm flex-shrink-0">{leg.subjectLogo}</span>}
            <div className="flex-1 min-w-0">
              <p className="text-white text-[11px] font-medium truncate">{leg.subjectName}</p>
              <p className="text-[#8a9ea6] text-[11px] truncate">{leg.selection ?? leg.marketType}</p>
            </div>
            <span className="text-[11px] font-bold flex-shrink-0" style={{ color: combinedColor }}>
              {leg.probability}%
            </span>
          </div>
        ))}
      </div>

      {/* XP awarded / deducted */}
      {slip.xpAwarded > 0 && (
        <div className="mx-4 mb-3 flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-yellow-500/10 border border-yellow-500/20">
          <Trophy size={11} className="text-yellow-400" />
          <span className="text-yellow-400 text-[11px] font-bold">+{slip.xpAwarded} {t("slip.xpEarned")}</span>
        </div>
      )}
      {slip.xpAwarded < 0 && (
        <div className="mx-4 mb-3 flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-red-500/10 border border-red-500/20">
          <AlertCircle size={11} className="text-red-400" />
          <span className="text-red-400 text-[11px] font-bold">{slip.xpAwarded} XP</span>
        </div>
      )}

      {/* Pending: results are settled automatically */}
      {isPending && (
        <div className="mx-4 mb-3 flex items-center gap-1.5 px-3 py-1.5 rounded-xl icy-tile">
          <Clock size={11} className="text-[#8a9ea6]" />
          <span className="text-[#8a9ea6] text-[11px]">{t("slip.autoSettle")}</span>
        </div>
      )}

      {/* Footer: ArakIce branding (kept in the shared image) + share button (excluded) */}
      <div className="flex items-center justify-between px-4 py-2.5 border-t border-white/[0.06]">
        <span className="text-[11px] font-bold tracking-[0.14em]"
          style={{ fontFamily: "'Oswald','Arial Narrow',sans-serif", color: "#86d1ea" }}>
          ARAKICE
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setRoomPicker(true)}
            aria-label={t("slip.shareToRoom")}
            className="tap-44 flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold active:scale-95 transition-transform"
            style={{ background: "rgba(144,201,240,0.10)", color: "#90C9F0", border: "1px solid rgba(144,201,240,0.25)" }}
          >
            <MessageSquare size={11} />
            {t("slip.shareToRoom")}
          </button>
          <button
            onClick={handleShare}
            disabled={sharing}
            className="tap-44 flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-bold disabled:opacity-50 active:scale-95 transition-transform"
            style={{ background: "rgba(134,209,234,0.12)", color: "#86d1ea", border: "1px solid rgba(134,209,234,0.3)" }}
          >
            <Share2 size={11} />
            {sharing ? "…" : t("slip.sharePhoto")}
          </button>
        </div>
      </div>

      {roomPicker && <ShareToRoomSheet slip={slip} onClose={() => setRoomPicker(false)} />}
    </div>
  );
}

// ─── My Slips tab ─────────────────────────────────────────────────────────────

export function MySlipsTab({ user }: { user: any }) {
  const { t } = useI18n();
  const [slips, setSlips] = useState<BetSlip[]>([]);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * L'échec du CHARGEMENT, séparé du bandeau `error`.
   *
   * Ce bandeau sert aussi aux avis `TIER_UP:` du règlement des coupons, et il
   * s'affiche AU-DESSUS de la liste : un chargement raté y posait une ligne
   * rouge, puis rendait quand même l'état vide « aucun coupon » juste en
   * dessous — deux messages contradictoires. Un état à part permet de
   * remplacer la liste plutôt que de la doubler.
   */
  const [loadError, setLoadError] = useState<unknown>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    setLoadError(null);
    try {
      const data = await getMySlips(100);
      setSlips(data);
    } catch (err: any) {
      setLoadError(err ?? new Error("Could not load slips"));
    } finally {
      setLoading(false);
    }
    // `user?.id` et non `user` : AuthContext remplace l'objet quand le profil
    // arrive, ce qui rechargeait les 100 coupons une seconde fois.
  }, [user?.id]);

  useEffect(() => { load(); }, [load]);

  // Ask the server to settle pending slips against real NHL results
  async function handleCheckResults() {
    setResolving("all");
    try {
      const summary = await settleMySlips();
      if (summary.settled > 0) {
        setError(`TIER_UP:${summary.settled} slip${summary.settled > 1 ? "s" : ""} settled — ${summary.wins} won, ${summary.losses} lost`);
        setTimeout(() => setError(null), 4000);
        await load();
      } else {
        setError("TIER_UP:No finished games yet — check back later");
        setTimeout(() => setError(null), 3000);
      }
    } catch (err: any) {
      setError(err.message ?? "Failed to check results");
      setTimeout(() => setError(null), 3000);
    } finally {
      setResolving(null);
    }
  }

  if (!user) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4 px-6 text-center">
        <div className="w-16 h-16 rounded-full bg-[#90C9F0]/10 border border-[#90C9F0]/20 flex items-center justify-center">
          <Lock size={22} className="text-[#90C9F0]" />
        </div>
        <div>
          <p className="text-white font-bold text-sm" style={{ fontFamily: "'Merriweather', Georgia, serif" }}>{t("slip.signin")}</p>
          <p className="text-[#8a9ea6] text-xs mt-1 leading-relaxed">{t("slip.signinHint")}</p>
        </div>
      </div>
    );
  }

  const pending = slips.filter((s) => s.outcome === "pending");
  const resolved = slips.filter((s) => s.outcome !== "pending");

  return (
    <div className="flex flex-col gap-4 pb-32 pt-3">
      {/* Tier-up / error banner */}
      {error && (
        <div className={`rounded-2xl px-4 py-3 flex items-center gap-3 ${
          error.startsWith("TIER_UP:")
            ? "bg-yellow-500/10 border border-yellow-500/25"
            : "bg-red-500/10 border border-red-500/25"
        }`}>
          {error.startsWith("TIER_UP:") ? (
            <Trophy size={14} className="text-yellow-400 flex-shrink-0" />
          ) : (
            <AlertCircle size={14} className="text-red-400 flex-shrink-0" />
          )}
          <p className={`text-xs font-medium ${error.startsWith("TIER_UP:") ? "text-yellow-300" : "text-red-300"}`}>
            {error.replace("TIER_UP:", "")}
          </p>
        </div>
      )}

      {loading ? (
        <div className="flex flex-col gap-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-28 icy-tile rounded-2xl animate-pulse" />
          ))}
        </div>
      ) : loadError ? (
        <ErrorState error={loadError} onRetry={() => { void load(); }} />
      ) : slips.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-4 text-center">
          <div className="w-16 h-16 rounded-full icy-card flex items-center justify-center">
            <History size={22} className="text-[#4a6068]" />
          </div>
          <div>
            <p className="text-white font-bold text-sm" style={{ fontFamily: "'Merriweather', Georgia, serif" }}>{t("slip.noSlips")}</p>
            <p className="text-[#8a9ea6] text-xs mt-1">{t("slip.noSlipsHint")}</p>
          </div>
        </div>
      ) : (
        <>
          {/* Active / pending */}
          {pending.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-[#90C9F0] animate-pulse" />
                  <p className="text-[#8a9ea6] text-[11px] uppercase tracking-wider font-medium">{t("slip.active")} · {pending.length}</p>
                </div>
                <button
                  onClick={handleCheckResults}
                  disabled={resolving === "all"}
                  className="tap-44 flex items-center gap-1.5 text-[#90C9F0] text-[11px] font-bold border border-[#90C9F0]/30 bg-[#90C9F0]/10 px-2.5 py-1 rounded-lg active:scale-95 transition-all disabled:opacity-50"
                >
                  <RefreshCw size={11} className={resolving === "all" ? "animate-spin" : ""} />
                  {t("slip.checkResults")}
                </button>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {pending.map((s) => (
                  <SlipCard key={s.id} slip={s} />
                ))}
              </div>
            </div>
          )}

          {/* History */}
          {resolved.length > 0 && (
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <History size={12} className="text-[#4a6068]" />
                <p className="text-[#8a9ea6] text-[11px] uppercase tracking-wider font-medium">{t("slip.history")} · {resolved.length}</p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {resolved.map((s) => (
                  <SlipCard key={s.id} slip={s} />
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
