// components/league/chat/MessageBubble.tsx

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
}: {
  msg: ChatMessage;
  isOwn: boolean;
  onReact?: (msgId: string, emoji: string) => void;
  onReply?: (msg: ChatMessage) => void;
  onDelete?: (msgId: string) => void;
}) {
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
          <span className="text-white text-[10px] font-bold">{msg.displayName}</span>
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