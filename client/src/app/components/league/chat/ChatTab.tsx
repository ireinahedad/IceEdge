// components/league/chat/ChatTab.tsx

import { useEffect, useRef, useState } from "react";
import { MessageBubble } from "./MessageBubble";
import { profileApiService } from "../../../services/userService";
import { useChatSocket } from "../../../hooks/useChatSocket";
import type { ChatRoom, ChatMessage } from "../../../types/user";

// ─── Tag styles ───────────────────────────────────────────────────────────────

const TAG_STYLE = {
  pick:     "bg-green-500/15 text-green-400 border-green-500/30",
  analysis: "bg-[#86d1ea]/15 text-[#86d1ea] border-[#86d1ea]/30",
  hot:      "bg-red-500/15 text-red-400 border-red-500/30",
} as const;

const TAG_LABEL = {
  pick: "🎯 Pick",
  analysis: "📊 Analysis",
  hot: "🔴 Live",
} as const;

// ─── Room icon picker options ─────────────────────────────────────────────────

const ROOM_ICONS = ["💬", "🎯", "📊", "🔥", "🏒", "⭐", "🧊", "🏆", "💰", "🎰", "🧠", "📈"];

// ─── Create room modal ────────────────────────────────────────────────────────

function CreateRoomModal({ onClose, onCreate }: {
  onClose: () => void;
  onCreate: (room: ChatRoom) => void;
}) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [icon, setIcon] = useState("💬");
  const [loading, setLoading] = useState(false);

  async function handleCreate() {
    if (!name.trim()) return;
    setLoading(true);
    const room = await profileApiService.createRoom({
      name: name.trim(),
      icon,
      description: desc.trim() || "Community chat",
    });
    setLoading(false);
    onCreate(room);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-[430px] bg-[#0f1416]/95 backdrop-blur-xl border-t border-white/10 rounded-t-3xl p-6 pb-10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-5" />
        <p className="text-white font-bold text-base mb-4">New Chat Room</p>

        <p className="text-white/60 text-[10px] uppercase tracking-wider mb-2">Icon</p>
        <div className="flex flex-wrap gap-2 mb-4">
          {ROOM_ICONS.map((ic) => (
            <button
              key={ic}
              onClick={() => setIcon(ic)}
              className={`w-9 h-9 rounded-xl flex items-center justify-center text-lg border transition-all ${
                icon === ic
                  ? "border-[#86d1ea] bg-[#86d1ea]/15"
                  : "border-white/10 bg-white/5"
              }`}
            >
              {ic}
            </button>
          ))}
        </div>

        <p className="text-white/60 text-[10px] uppercase tracking-wider mb-1.5">Room Name</p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Western Conference"
          maxLength={32}
          className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm outline-none placeholder-white/30 mb-3 focus:border-[#86d1ea]/50 transition-colors"
        />

        <p className="text-white/60 text-[10px] uppercase tracking-wider mb-1.5">Description</p>
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="What's this room about?"
          maxLength={64}
          className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white text-sm outline-none placeholder-white/30 mb-4 focus:border-[#86d1ea]/50 transition-colors"
        />

        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-3 rounded-2xl border border-white/10 text-white/70 text-sm"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!name.trim() || loading}
            className={`flex-1 py-3 rounded-2xl text-sm font-bold transition-all ${
              name.trim() && !loading
                ? "bg-[#86d1ea] text-[#0f1416]"
                : "bg-white/10 text-white/40"
            }`}
          >
            {loading ? "Creating…" : "Create Room"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Room list ────────────────────────────────────────────────────────────────

function RoomList({ rooms, onSelect, onCreateNew }: {
  rooms: ChatRoom[];
  onSelect: (room: ChatRoom) => void;
  onCreateNew: () => void;
}) {
  const pinned = rooms.filter((r) => r.isPinned);
  const others = rooms.filter((r) => !r.isPinned);

  function timeAgo(iso?: string) {
    if (!iso) return "";
    const diff = (Date.now() - new Date(iso).getTime()) / 60000;
    if (diff < 1) return "now";
    if (diff < 60) return `${Math.round(diff)}m`;
    if (diff < 1440) return `${Math.round(diff / 60)}h`;
    return `${Math.round(diff / 1440)}d`;
  }

  function RoomRow({ room }: { room: ChatRoom }) {
    return (
      <button
        onClick={() => onSelect(room)}
        className="w-full flex items-center gap-3 px-4 py-3 bg-white/5 backdrop-blur-sm border border-white/8 rounded-2xl active:bg-white/10 transition-all text-left"
      >
        <div className="relative flex-shrink-0">
          <div className="w-11 h-11 rounded-xl bg-white/10 flex items-center justify-center text-xl">
            {room.icon}
          </div>
          {room.isLive && (
            <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse border-2 border-[#0f1416]" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="text-white text-xs font-bold">{room.name}</span>
            {room.isLive && (
              <span className="text-[8px] text-red-400 border border-red-400/30 rounded-full px-1.5 py-0.5">LIVE</span>
            )}
          </div>
          <p className="text-white/50 text-[10px] truncate">{room.lastMessage || room.description}</p>
          <p className="text-white/40 text-[9px] mt-0.5">{room.memberCount} members</p>
        </div>

        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          <span className="text-white/40 text-[9px]">{timeAgo(room.lastMessageAt)}</span>
          {room.unread ? (
            <span className="bg-[#86d1ea] text-[#0f1416] text-[8px] font-bold w-4 h-4 rounded-full flex items-center justify-center">
              {room.unread > 9 ? "9+" : room.unread}
            </span>
          ) : null}
        </div>
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-4 overflow-y-auto">
      {pinned.length > 0 && (
        <div>
          <p className="text-white/40 text-[9px] uppercase tracking-widest mb-2 px-1">Pinned</p>
          <div className="flex flex-col gap-2">
            {pinned.map((r) => <RoomRow key={r.id} room={r} />)}
          </div>
        </div>
      )}
      {others.length > 0 && (
        <div>
          <p className="text-white/40 text-[9px] uppercase tracking-widest mb-2 px-1">Other Rooms</p>
          <div className="flex flex-col gap-2">
            {others.map((r) => <RoomRow key={r.id} room={r} />)}
          </div>
        </div>
      )}
      <button
        onClick={onCreateNew}
        className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl border border-dashed border-white/15 text-white/50 text-xs active:bg-white/5 transition-colors"
      >
        <span className="text-lg">+</span>
        <span>Create a new room</span>
      </button>
    </div>
  );
}

// ─── Active room chat ─────────────────────────────────────────────────────────

function RoomChat({ room, onBack, onUpdate }: {
  room: ChatRoom;
  onBack: () => void;
  onUpdate: (updated: ChatRoom) => void;
}) {
  const { messages, onlineCount, connected, initMessages, appendOptimistic, confirmMessage } =
    useChatSocket(room.id);
  const [input, setInput] = useState("");
  const [tag, setTag] = useState<"pick" | "analysis" | undefined>();
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [loadingMessages, setLoadingMessages] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const CURRENT_USER_ID = "u1";

  // Load HTTP history on mount, seed into socket hook
  useEffect(() => {
    setLoadingMessages(true);
    profileApiService.getRoomMessages(room.id).then((msgs) => {
      initMessages(msgs);
      setLoadingMessages(false);
    });
  }, [room.id]);

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  async function sendMessage() {
    const text = input.trim();
    if (!text) return;

    setInput("");
    const tempId = `optimistic_${Date.now()}`;

    // Optimistic: show immediately
    const optimistic: ChatMessage = {
      id: tempId,
      userId: CURRENT_USER_ID,
      username: "me",
      displayName: "You",
      avatar: "🏒",
      tier: "rookie",
      text,
      sentAt: new Date().toISOString(),
      reactions: [],
      tag,
      replyTo: replyTo ? { username: replyTo.username, text: replyTo.text } : undefined,
    };
    appendOptimistic(optimistic);
    setTag(undefined);
    setReplyTo(null);

    // Confirm with server — socket will broadcast to others, we replace the optimistic copy
    const confirmed = await profileApiService.sendMessage(room.id, {
      text,
      tag,
      replyTo: replyTo ? { username: replyTo.username, text: replyTo.text } : undefined,
    });
    confirmMessage(tempId, confirmed);

    onUpdate({ ...room, lastMessage: text, lastMessageAt: confirmed.sentAt, unread: 0 });
  }

  async function handleReact(msgId: string, emoji: string) {
    // Optimistic toggle handled inside MessageBubble via local state
    await profileApiService.toggleReaction(room.id, msgId, emoji);
  }

  const displayOnline = onlineCount > 0 ? onlineCount : room.memberCount;

  return (
    <div className="flex flex-col h-full">
      {/* Room header */}
      <div className="flex items-center gap-3 mb-3 flex-shrink-0">
        <button
          onClick={onBack}
          className="w-8 h-8 rounded-xl bg-white/8 border border-white/10 flex items-center justify-center text-[#86d1ea] flex-shrink-0"
        >
          ←
        </button>
        <div className="w-8 h-8 rounded-xl bg-white/10 flex items-center justify-center text-base flex-shrink-0">
          {room.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-white text-sm font-bold">{room.name}</p>
            {room.isLive && <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />}
          </div>
          <div className="flex items-center gap-2">
            <p className="text-white/50 text-[9px]">{room.description}</p>
            <div className="flex items-center gap-1">
              <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-green-400 animate-pulse" : "bg-white/20"}`} />
              <span className="text-[9px] text-white/40">{displayOnline} online</span>
            </div>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto flex flex-col gap-3 py-1 min-h-0">
        {loadingMessages ? (
          [1, 2, 3].map((i) => (
            <div key={i} className={`flex gap-2 ${i % 2 === 0 ? "flex-row-reverse" : ""}`}>
              <div className="w-7 h-7 rounded-full bg-white/10 animate-pulse flex-shrink-0" />
              <div className={`h-10 bg-white/5 rounded-2xl animate-pulse ${i % 2 === 0 ? "w-48" : "w-56"}`} />
            </div>
          ))
        ) : (
          <>
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center py-10 gap-2">
                <span className="text-3xl">{room.icon}</span>
                <p className="text-white text-xs font-medium">{room.name}</p>
                <p className="text-white/50 text-[10px] text-center">{room.description}<br />Be the first to say something!</p>
              </div>
            )}
            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                msg={msg}
                isOwn={msg.userId === CURRENT_USER_ID}
                onReact={handleReact}
                onReply={setReplyTo}
              />
            ))}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Reply preview */}
      {replyTo && (
        <div className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-3 py-2 mb-2 flex-shrink-0">
          <div className="flex-1 min-w-0">
            <p className="text-[#86d1ea] text-[9px] font-medium">Replying to @{replyTo.username}</p>
            <p className="text-white/50 text-[9px] truncate">{replyTo.text}</p>
          </div>
          <button onClick={() => setReplyTo(null)} className="text-white/50 text-xs">✕</button>
        </div>
      )}

      {/* Tag + input */}
      <div className="flex-shrink-0 mt-2">
        <div className="flex gap-1.5 mb-2">
          {(["pick", "analysis"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTag(tag === t ? undefined : t)}
              className={`px-2 py-1 rounded-full text-[9px] border transition-all ${
                tag === t ? TAG_STYLE[t] : "text-white/50 border-white/10"
              }`}
            >
              {TAG_LABEL[t]}
            </button>
          ))}
          {tag && <span className="text-white/40 text-[9px] self-center">tagged</span>}
        </div>
        <div className="flex items-center gap-2 bg-white/8 backdrop-blur-sm border border-white/10 rounded-2xl px-3 py-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage()}
            placeholder={`Message ${room.name}…`}
            className="flex-1 bg-transparent text-white text-xs outline-none placeholder-white/30"
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim()}
            className={`w-7 h-7 rounded-xl flex items-center justify-center text-sm transition-all flex-shrink-0 ${
              input.trim() ? "bg-[#86d1ea] text-[#0f1416]" : "bg-white/10 text-white/30"
            }`}
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}


// ─── ChatTab export ───────────────────────────────────────────────────────────

export function ChatTab({ onUnreadChange }: { onUnreadChange?: (n: number) => void }) {
  const [rooms, setRooms] = useState<(ChatRoom & { unread?: number })[]>([]);
  const [activeRoom, setActiveRoom] = useState<ChatRoom | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    profileApiService.getChatRooms().then((r) => {
      setRooms(r);
    }).catch(() => {}).finally(() => {
      setLoading(false);
    });
  }, []);

  function handleSelectRoom(room: ChatRoom) {
    setActiveRoom(room);
    setRooms((prev) => prev.map((r) => r.id === room.id ? { ...r, unread: 0 } : r));
  }

  function handleUpdateRoom(updated: ChatRoom) {
    setRooms((prev) => prev.map((r) => r.id === updated.id ? updated : r));
    setActiveRoom(updated);
  }

  function handleCreateRoom(room: ChatRoom) {
    setRooms((prev) => [...prev, room]);
    setActiveRoom(room);
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-2 pt-2">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-16 bg-white/5 rounded-2xl animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-3 flex-shrink-0">
        {activeRoom ? (
          <div />
        ) : (
          <>
            <p className="text-white/60 text-xs">{rooms.length} rooms available</p>
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1 bg-[#86d1ea] text-[#0f1416] text-xs font-bold px-3 py-1.5 rounded-xl"
            >
              + New Room
            </button>
          </>
        )}
      </div>

      {activeRoom ? (
        <RoomChat
          room={activeRoom}
          onBack={() => setActiveRoom(null)}
          onUpdate={handleUpdateRoom}
        />
      ) : (
        <RoomList
          rooms={rooms}
          onSelect={handleSelectRoom}
          onCreateNew={() => setShowCreate(true)}
        />
      )}

      {showCreate && (
        <CreateRoomModal
          onClose={() => setShowCreate(false)}
          onCreate={handleCreateRoom}
        />
      )}
    </div>
  );
}
