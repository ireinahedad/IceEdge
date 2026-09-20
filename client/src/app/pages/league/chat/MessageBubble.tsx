// components/league/chat/MessageBubble.tsx

import { useState } from "react";
import { useI18n } from "../../../i18n";
import type { ChatMessage, SlipAttachment } from "../../../types/user";
import { legAccent } from "../../../data/teamEmoji";
import { outcomeKey, isNeutralOutcome } from "../../../services/slipOutcome";

const TAG_STYLE = {
  pick:     "bg-green-500/15 text-green-400 border-green-500/30",
  analysis: "bg-[#90C9F0]/15 text-[#90C9F0] border-[#90C9F0]/30",
  hot:      "bg-red-500/15 text-red-400 border-red-500/30",
} as const;

const TAG_LABEL = {
  pick: "🎯 Pick",
  analysis: "📊 Analysis",
  hot: "🔴 Live",
} as const;

/** L'échelle de probabilité du produit — la même que `SlipCard` et l'image de partage. */
function probabilityColor(pct: number | null): string {
  if (pct == null) return "#8a9ea6";
  if (pct >= 65) return "#86d1ea";
  if (pct >= 45) return "#90C9F0";
  if (pct >= 25) return "#facc15";
  return "#f87171";
}

/**
 * Le coupon joint à un message.
 *
 * Rendu SOUS la bulle et non dedans : la bulle de ses propres messages est
 * bleu clair avec du texte foncé, une carte sombre posée à l'intérieur y
 * deviendrait illisible une fois sur deux. En dessous, elle a le même aspect
 * pour tout le monde.
 *
 * ⚠️ Instantané figé — `outcome` est celui du moment du partage, il ne se met
 * pas à jour quand le coupon est réglé. Ne pas y brancher une lecture live :
 * c'est ce qui garantit qu'un partage n'ouvre aucune fenêtre sur le compte de
 * son auteur (voir migration 036).
 */
function SlipAttachmentCard({ slip }: { slip: SlipAttachment }) {
  const { t } = useI18n();
  const color = probabilityColor(slip.combinedProbability);
  // Trois lignes au maximum : la bulle fait 78 % de la largeur du salon, une
  // liste complète y serait illisible. Le compte total reste affiché en tête.
  const shown = slip.legs.slice(0, 3);
  const rest  = Math.max(0, slip.legCount - shown.length);
  const settled = slip.outcome !== "pending";

  return (
    <div className="chat-tile rounded-2xl overflow-hidden border border-white/10 w-full">
      <div className="flex items-center justify-between px-3 pt-2 pb-1.5">
        <span
          className="text-[11px] font-bold tracking-[0.14em] text-[#86d1ea]"
          style={{ fontFamily: "'Oswald','Arial Narrow',sans-serif" }}
        >
          ARAKICE
        </span>
        <div className="flex items-center gap-1.5">
          {settled && (
            <span
              className={`text-[11px] font-bold px-1.5 py-0.5 rounded-full border ${
                slip.outcome === "win"
                  ? "bg-green-500/15 text-green-400 border-green-500/30"
                  : isNeutralOutcome(slip.outcome)
                  ? "bg-white/10 text-white/50 border-white/20"
                  : "bg-red-500/15 text-red-400 border-red-500/30"
              }`}
            >
              {t(outcomeKey(slip.outcome))}
            </span>
          )}
          <span className="text-[11px] text-white/40">
            {t("chat.slipLegs", { n: slip.legCount })}
          </span>
        </div>
      </div>

      <div className="flex items-baseline gap-1.5 px-3 pb-1.5">
        <span
          className="text-xl font-black leading-none"
          style={{ color, fontFamily: "'Oswald','Arial Narrow',sans-serif" }}
        >
          {slip.combinedProbability != null ? `${slip.combinedProbability}%` : "—"}
        </span>
        <span className="text-[11px] text-white/40">{t("slip.combined")}</span>
      </div>

      <div className="px-3 pb-2 flex flex-col">
        {shown.map((leg, i) => (
          <div key={i} className="flex items-center gap-2 py-1 border-t border-white/[0.06] first:border-0">
            <span
              className="w-[3px] h-6 rounded-full flex-shrink-0"
              style={{ background: legAccent(leg) }}
            />
            <div className="flex-1 min-w-0">
              <p className="text-white text-[11px] font-medium truncate">{leg.subjectName}</p>
              <p className="text-white/45 text-[11px] truncate">{leg.selection}</p>
            </div>
            <span className="text-[11px] font-bold flex-shrink-0 text-[#86d1ea]">{leg.probability}%</span>
          </div>
        ))}
        {rest > 0 && (
          <p className="text-white/35 text-[11px] pt-1.5 border-t border-white/[0.06]">
            {t("chat.slipMore", { n: rest })}
          </p>
        )}
      </div>
    </div>
  );
}

export function MessageBubble({
  msg,
  isOwn,
  onReact,
  onReply,
  onDelete,
  onReport,
  onBlock,
  onOpenUser,
}: {
  msg: ChatMessage;
  isOwn: boolean;
  onReact?: (msgId: string, emoji: string) => void;
  onReply?: (msg: ChatMessage) => void;
  onDelete?: (msgId: string) => void;
  /** R4.3a — signaler. Jamais passé pour ses propres messages. */
  onReport?: (msg: ChatMessage) => void;
  /** R4.3a — bloquer l'auteur. Jamais passé pour ses propres messages. */
  onBlock?: (msg: ChatMessage) => void;
  /** Ouvre la fiche de l'auteur. Remplace l'ancienne navigation directe. */
  onOpenUser?: (msg: ChatMessage) => void;
}) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);

  // R4.3a — un bouton « ⋯ », pas un appui long. L'appui long se dispute la
  // sélection de texte et le menu natif d'iOS, ne se découvre pas, et n'a
  // aucun équivalent au clavier. Le bouton reprend le motif du menu de salon
  // déjà présent dans cette page, et il n'apparaît jamais sur ses propres
  // messages : se signaler soi-même est refusé en 400 par le serveur.
  //
  // ⚠️ Il doit rester VISIBLE SANS SURVOL. La première version copiait le style
  // de la corbeille juste en dessous (`text-white/30` × `opacity-40`, soit ~12 %
  // d'opacité réelle) : introuvable, et sur mobile il n'y a aucun survol pour le
  // révéler. C'est le SEUL chemin vers « signaler » et « bloquer » — les deux
  // choses qu'un examinateur Apple cherche à l'écran. Ne pas le rendre discret
  // pour faire joli.
  const canModerate = !isOwn && (onReport || onBlock);
  const time = new Date(msg.sentAt).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div className={`flex gap-2 ${isOwn ? "flex-row-reverse" : ""}`}>
      {/* Avatar */}
      <button
        onClick={() => onReply?.(msg)}
        /* `overflow-hidden` retire : il rognait la zone tactile de `tap-44`.
            L'image interne porte deja `rounded-full`, la decoupe tient sans lui. */
        className="tap-44 w-7 h-7 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center flex-shrink-0 self-end active:scale-95 transition-transform"
      >
        {msg.avatarUrl
          ? <img src={msg.avatarUrl} alt="" className="w-full h-full object-cover rounded-full" />
          : msg.avatar}
      </button>

      <div className={`max-w-[78%] flex flex-col gap-1 ${isOwn ? "items-end" : "items-start"}`}>
        {/* Name + tag + time */}
        <div className={`flex items-center gap-1.5 flex-wrap ${isOwn ? "flex-row-reverse" : ""}`}>
          {/* Le nom ouvre la FICHE de l'auteur, plus la page joueur directement :
              c'est de là qu'on peut le bloquer, et « Voir le profil complet » y
              mène toujours en un geste de plus. L'avatar sert déjà à répondre —
              le détourner casserait le geste le plus fréquent du chat. */}
          <button
            onClick={() => onOpenUser?.(msg)}
            className="text-white text-[11px] font-bold active:opacity-60 transition-opacity"
          >
            {msg.displayName}
          </button>
          {msg.tag && (
            <span className={`text-[11px] px-1.5 py-0.5 rounded-full border ${TAG_STYLE[msg.tag]}`}>
              {TAG_LABEL[msg.tag]}
            </span>
          )}
          <span className="text-white/40 text-[11px]">{time}</span>
        </div>

        {/* Reply preview */}
        {msg.replyTo && (
          <div className="bg-white/5 rounded-lg px-2 py-1 border-l-2 border-[#90C9F0]">
            <p className="text-[#90C9F0] text-[11px] font-medium">@{msg.replyTo.username}</p>
            <p className="text-white/50 text-[11px] truncate">{msg.replyTo.text}</p>
          </div>
        )}

        {/* Bubble */}
        <div className={`group flex items-end gap-1.5 ${isOwn ? "flex-row-reverse" : ""}`}>
          <div
            className={`rounded-2xl px-3 py-2 ${
              isOwn
                ? "bg-[#90C9F0] text-[#072E49] border border-[#90C9F0]"
                : "chat-tile text-white"
            }`}
          >
            <p className="text-xs leading-relaxed">{msg.text}</p>
          </div>
          {isOwn && onDelete && (
            <button
              onClick={() => onDelete(msg.id)}
              className="tap-44 text-white/30 hover:text-red-400 text-[11px] opacity-40 hover:opacity-100 transition-opacity self-center flex-shrink-0"
              title="Delete"
            >
              🗑️
            </button>
          )}
          {canModerate && (
            <div className="relative self-center flex-shrink-0">
              <button
                onClick={() => setMenuOpen((v) => !v)}
                aria-label={t("chat.messageActions")}
                aria-expanded={menuOpen}
                className={`tap-44 w-6 h-6 rounded-lg flex items-center justify-center text-sm leading-none transition-colors ${
                  menuOpen ? "bg-white/15 text-white" : "bg-white/5 text-white/60 hover:bg-white/10 hover:text-white"
                }`}
              >
                ⋯
              </button>
              {menuOpen && (
                <>
                  {/* Calque de fermeture : un clic n'importe où referme, comme
                      les autres feuilles de l'app. */}
                  <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                  <div className="absolute z-50 bottom-full mb-1 left-0 min-w-[160px] chat-tile rounded-xl overflow-hidden border border-white/10">
                    {onReport && (
                      <button
                        onClick={() => { setMenuOpen(false); onReport(msg); }}
                        className="w-full text-left px-3 py-2.5 text-[11px] text-white/80 active:bg-white/5 border-b border-white/5"
                      >
                        🚩 {t("chat.report")}
                      </button>
                    )}
                    {onBlock && (
                      <button
                        onClick={() => { setMenuOpen(false); onBlock(msg); }}
                        className="w-full text-left px-3 py-2.5 text-[11px] text-red-400 active:bg-white/5"
                      >
                        🚫 {t("chat.blockUser")}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Coupon joint */}
        {msg.attachment?.kind === "slip" && (
          <div className="w-full max-w-[260px]">
            <SlipAttachmentCard slip={msg.attachment} />
          </div>
        )}

        {/* Reactions */}
        {msg.reactions && msg.reactions.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            {msg.reactions.map((r) => (
              <button
                key={r.emoji}
                onClick={() => onReact?.(msg.id, r.emoji)}
                className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded-full border text-[11px] transition-all ${
                  r.reacted
                    ? "bg-[#90C9F0]/20 border-[#90C9F0]/50 text-[#90C9F0]"
                    : "bg-white/5 border-white/10 text-white/50"
                }`}
              >
                {r.emoji} {r.count}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}