// components/league/chat/MessageBubble.tsx

import { useState } from "react";
import { useNavigate } from "react-router";
import { useI18n } from "../../../i18n";
import type { ChatMessage } from "../../../types/user";

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

export function MessageBubble({
  msg,
  isOwn,
  onReact,
  onReply,
  onDelete,
  onReport,
  onBlock,
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
}) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);

  // R4.3a — un bouton « ⋯ », pas un appui long. L'appui long se dispute la
  // sélection de texte et le menu natif d'iOS, ne se découvre pas, et n'a
  // aucun équivalent au clavier. Le bouton reprend le motif du menu de salon
  // déjà présent dans cette page, et il n'apparaît jamais sur ses propres
  // messages : se signaler soi-même est refusé en 400 par le serveur.
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
        className="w-7 h-7 rounded-full bg-white/10 backdrop-blur-md flex items-center justify-center flex-shrink-0 self-end active:scale-95 transition-transform overflow-hidden"
      >
        {msg.avatarUrl
          ? <img src={msg.avatarUrl} alt="" className="w-full h-full object-cover rounded-full" />
          : msg.avatar}
      </button>

      <div className={`max-w-[78%] flex flex-col gap-1 ${isOwn ? "items-end" : "items-start"}`}>
        {/* Name + tag + time */}
        <div className={`flex items-center gap-1.5 flex-wrap ${isOwn ? "flex-row-reverse" : ""}`}>
          {/* Le nom mène à la page joueur. L'avatar sert déjà à répondre — le
              détourner casserait le geste le plus fréquent du chat. */}
          <button
            onClick={() => navigate(`/player/${msg.userId}`)}
            className="text-white text-[10px] font-bold active:opacity-60 transition-opacity"
          >
            {msg.displayName}
          </button>
          {msg.tag && (
            <span className={`text-[8px] px-1.5 py-0.5 rounded-full border ${TAG_STYLE[msg.tag]}`}>
              {TAG_LABEL[msg.tag]}
            </span>
          )}
          <span className="text-white/40 text-[8px]">{time}</span>
        </div>

        {/* Reply preview */}
        {msg.replyTo && (
          <div className="bg-white/5 rounded-lg px-2 py-1 border-l-2 border-[#90C9F0]">
            <p className="text-[#90C9F0] text-[9px] font-medium">@{msg.replyTo.username}</p>
            <p className="text-white/50 text-[9px] truncate">{msg.replyTo.text}</p>
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
              className="text-white/30 hover:text-red-400 text-[11px] opacity-40 hover:opacity-100 transition-opacity self-center flex-shrink-0"
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
                className="text-white/30 hover:text-white text-[11px] opacity-40 hover:opacity-100 transition-opacity px-1"
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

        {/* Reactions */}
        {msg.reactions && msg.reactions.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            {msg.reactions.map((r) => (
              <button
                key={r.emoji}
                onClick={() => onReact?.(msg.id, r.emoji)}
                className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded-full border text-[9px] transition-all ${
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