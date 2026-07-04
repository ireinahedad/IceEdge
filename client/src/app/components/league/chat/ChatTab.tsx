// components/league/chat/ChatTab.tsx

import { useEffect, useRef, useState } from "react";
import { MessageBubble } from "./MessageBubble";
import { profileApiService } from "../../../services/userService";
import { useChatSocket } from "../../../hooks/useChatSocket";
import { useAuth } from "../../../context/AuthContext";
import { useI18n } from "../../../i18n";
import type { ChatRoom, ChatMessage, ChatRoomMember, UserProfile } from "../../../types/user";

// ─── Tag styles ───────────────────────────────────────────────────────────────

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

// ─── Room icon picker options ─────────────────────────────────────────────────

const ROOM_ICONS = ["💬", "🎯", "📊", "🔥", "🏒", "⭐", "🧊", "🏆", "💰", "🎰", "🧠", "📈"];

// ─── Create room modal ────────────────────────────────────────────────────────

function CreateRoomModal({ onClose, onCreate }: {
  onClose: () => void;
  onCreate: (room: ChatRoom) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [icon, setIcon] = useState("💬");
  const [isPrivate, setIsPrivate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdRoom, setCreatedRoom] = useState<ChatRoom | null>(null);

  async function handleCreate() {
    if (!name.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const room = await profileApiService.createRoom({
        name: name.trim(),
        icon,
        description: desc.trim() || "Community chat",
        isPrivate,
      });
      if (room.isPrivate && room.joinCode) {
        // Show the join code before closing so the creator can share it
        setCreatedRoom(room);
      } else {
        onCreate(room);
        onClose();
      }
    } catch (e: any) {
      setError(e.message ?? "Could not create room");
    } finally {
      setLoading(false);
    }
  }

  if (createdRoom) {
    return (
      <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={() => { onCreate(createdRoom); onClose(); }}>
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
        <div
          className="relative w-full max-w-[430px] md:max-w-lg icy-card rounded-t-3xl p-6 pb-10"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-5" />
          <p className="text-white font-bold text-base mb-1">{t("chat.privateCreated")}</p>
          <p className="text-white/50 text-xs mb-4">{t("chat.shareCode")}</p>
          <div className="icy-tile border-[#90C9F0]/40 rounded-2xl py-4 text-center mb-4">
            <p className="text-[#90C9F0] text-2xl font-bold tracking-[0.3em]">{createdRoom.joinCode}</p>
          </div>
          <button
            onClick={() => { navigator.clipboard?.writeText(createdRoom.joinCode ?? ""); }}
            className="w-full py-3 rounded-2xl border border-white/10 text-white/70 text-sm mb-2"
          >
            {t("chat.copyCode")}
          </button>
          <button
            onClick={() => { onCreate(createdRoom); onClose(); }}
            className="w-full py-3 rounded-2xl bg-[#22ff00] text-[#072E49] text-sm font-bold"
          >
            {t("chat.openRoom")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-[430px] md:max-w-lg icy-card rounded-t-3xl p-6 pb-10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-5" />
        <p className="text-white font-bold text-base mb-4">{t("chat.createTitle")}</p>

        <p className="text-white/60 text-[10px] uppercase tracking-wider mb-2">{t("chat.icon")}</p>
        <div className="flex flex-wrap gap-2 mb-4">
          {ROOM_ICONS.map((ic) => (
            <button
              key={ic}
              onClick={() => setIcon(ic)}
              className={`w-9 h-9 rounded-xl flex items-center justify-center text-lg border transition-all ${
                icon === ic
                  ? "border-[#90C9F0] bg-[#90C9F0]/15"
                  : "icy-tile"
              }`}
            >
              {ic}
            </button>
          ))}
        </div>

        <p className="text-white/60 text-[10px] uppercase tracking-wider mb-1.5">{t("chat.roomName")}</p>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Western Conference"
          maxLength={32}
          className="w-full icy-tile rounded-xl px-3 py-2.5 text-white text-sm outline-none placeholder-white/30 mb-3 focus:border-[#90C9F0]/50 transition-colors"
        />

        <p className="text-white/60 text-[10px] uppercase tracking-wider mb-1.5">{t("chat.description")}</p>
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="What's this room about?"
          maxLength={64}
          className="w-full icy-tile rounded-xl px-3 py-2.5 text-white text-sm outline-none placeholder-white/30 mb-4 focus:border-[#90C9F0]/50 transition-colors"
        />

        {/* Public / private toggle */}
        <div className="flex items-center justify-between icy-tile rounded-xl px-3 py-3 mb-4">
          <div>
            <p className="text-white text-xs font-medium">{isPrivate ? t("chat.private") : t("chat.publicRoom")}</p>
            <p className="text-white/40 text-[9px] mt-0.5">
              {isPrivate ? t("chat.privateHint") : t("chat.publicHint")}
            </p>
          </div>
          <button
            onClick={() => setIsPrivate((v) => !v)}
            className={`relative rounded-full transition-colors flex-shrink-0 ${isPrivate ? "bg-[#22ff00]" : "bg-white/10"}`}
            style={{ height: 22, width: 40 }}
          >
            <span
              className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all"
              style={{ left: isPrivate ? "calc(100% - 18px)" : 2 }}
            />
          </button>
        </div>

        {error && <p className="text-red-400 text-xs mb-3">{error}</p>}

        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 py-3 rounded-2xl border border-white/10 text-white/70 text-sm"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={handleCreate}
            disabled={!name.trim() || loading}
            className={`flex-1 py-3 rounded-2xl text-sm font-bold transition-all ${
              name.trim() && !loading
                ? "bg-[#22ff00] text-[#072E49]"
                : "bg-white/10 text-white/40"
            }`}
          >
            {loading ? t("chat.creating") : t("chat.create")}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Members modal (admin can kick / promote) ─────────────────────────────────

function MembersModal({ room, currentUserId, onClose }: {
  room: ChatRoom;
  currentUserId: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [members, setMembers] = useState<ChatRoomMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isAdmin = room.role === "admin";

  function load() {
    profileApiService.getRoomMembers(room.id)
      .then(setMembers)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(load, [room.id]);

  async function handleKick(userId: string) {
    if (!confirm("Remove this member from the room?")) return;
    try { await profileApiService.kickMember(room.id, userId); load(); }
    catch (e: any) { setError(e.message); }
  }

  async function handlePromote(userId: string, role: "admin" | "member") {
    try { await profileApiService.setMemberRole(room.id, userId, role); load(); }
    catch (e: any) { setError(e.message); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-[430px] md:max-w-lg max-h-[70vh] overflow-y-auto icy-card rounded-t-3xl p-6 pb-10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-5" />
        <p className="text-white font-bold text-base mb-4">{t("chat.membersMenu")} · {members.length}</p>

        {error && <p className="text-red-400 text-xs mb-3">{error}</p>}
        {loading ? (
          <div className="flex flex-col gap-2">
            {[1, 2, 3].map((i) => <div key={i} className="h-12 bg-white/5 rounded-xl animate-pulse" />)}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {members.map((m) => (
              <div key={m.userId} className="flex items-center gap-3 icy-tile rounded-xl px-3 py-2.5">
                <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-base overflow-hidden flex-shrink-0">
                  {m.avatarUrl
                    ? <img src={m.avatarUrl} alt="" className="w-full h-full object-cover rounded-full" />
                    : m.avatar}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="text-white text-xs font-medium truncate">{m.displayName}</p>
                    {m.role === "admin" && (
                      <span className="text-[8px] text-[#90C9F0] border border-[#90C9F0]/40 rounded-full px-1.5 py-0.5 flex-shrink-0">admin</span>
                    )}
                    {m.userId === currentUserId && (
                      <span className="text-[8px] text-white/40 border border-white/20 rounded-full px-1.5 py-0.5 flex-shrink-0">{t("league.you")}</span>
                    )}
                  </div>
                  <p className="text-white/40 text-[9px]">@{m.username}</p>
                </div>
                {isAdmin && m.userId !== currentUserId && (
                  <div className="flex gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => handlePromote(m.userId, m.role === "admin" ? "member" : "admin")}
                      className="text-[9px] text-white/60 border border-white/15 rounded-lg px-2 py-1"
                    >
                      {m.role === "admin" ? "Demote" : "Make admin"}
                    </button>
                    <button
                      onClick={() => handleKick(m.userId)}
                      className="text-[9px] text-red-400 border border-red-400/30 rounded-lg px-2 py-1"
                    >
                      Kick
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Room list ────────────────────────────────────────────────────────────────

const HIDDEN_ROOMS_KEY = "iceedge_hidden_rooms";

function RoomList({ rooms, onSelect, onCreateNew, onPinToggle, onJoined }: {
  rooms: ChatRoom[];
  onSelect: (room: ChatRoom) => void;
  onCreateNew: () => void;
  onPinToggle: (room: ChatRoom) => void;
  onJoined: (room: ChatRoom) => void;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<"mine" | "discover">("mine");
  const [search, setSearch] = useState("");
  const [codeResult, setCodeResult] = useState<ChatRoom | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);
  const [hiddenIds, setHiddenIds] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(HIDDEN_ROOMS_KEY) ?? "[]"); } catch { return []; }
  });

  function hideRoom(id: string) {
    const next = [...hiddenIds, id];
    setHiddenIds(next);
    try { localStorage.setItem(HIDDEN_ROOMS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  }
  function resetHidden() {
    setHiddenIds([]);
    try { localStorage.setItem(HIDDEN_ROOMS_KEY, "[]"); } catch { /* ignore */ }
  }

  const q = search.trim().toLowerCase();
  const matches = (r: ChatRoom) => !q || r.name.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q);

  // My Rooms = rooms I'm a member of · Discover = public rooms I haven't joined
  const myRooms  = rooms.filter((r) => r.isMember && matches(r));
  const discover = rooms.filter((r) => !r.isMember && !hiddenIds.includes(r.id) && matches(r));
  const hiddenCount = rooms.filter((r) => !r.isMember && hiddenIds.includes(r.id)).length;

  const pinned = myRooms.filter((r) => r.isPinned);
  const others = myRooms.filter((r) => !r.isPinned);

  // If the search looks like a join code (4-10 alphanumerics, no spaces) and
  // matches no visible room, offer a code lookup.
  const looksLikeCode = /^[a-zA-Z0-9]{4,10}$/.test(search.trim()) && myRooms.length === 0 && discover.length === 0;

  async function handleJoinPublic(room: ChatRoom) {
    try {
      const joined = await profileApiService.joinRoom(room.id);
      onJoined(joined);
    } catch { /* non-blocking */ }
  }

  useEffect(() => {
    setCodeResult(null);
    setCodeError(null);
    if (!looksLikeCode) return;
    const t = setTimeout(() => {
      profileApiService.lookupRoomByCode(search.trim())
        .then(setCodeResult)
        .catch(() => setCodeError("No room found for this code"));
    }, 400);
    return () => clearTimeout(t);
  }, [search]);

  async function handleJoinByCode() {
    if (!codeResult) return;
    setJoining(true);
    try {
      const room = await profileApiService.joinRoomByCode(search.trim());
      setSearch("");
      setCodeResult(null);
      onJoined(room);
    } catch (e: any) {
      setCodeError(e.message ?? "Could not join");
    } finally {
      setJoining(false);
    }
  }

  function timeAgo(iso?: string | null) {
    if (!iso) return "";
    const diff = (Date.now() - new Date(iso).getTime()) / 60000;
    if (diff < 1) return "now";
    if (diff < 60) return `${Math.round(diff)}m`;
    if (diff < 1440) return `${Math.round(diff / 60)}h`;
    return `${Math.round(diff / 1440)}d`;
  }

  function RoomRow({ room, mode }: { room: ChatRoom; mode: "mine" | "discover" }) {
    return (
      <div className="w-full flex items-center gap-3 px-4 py-3 icy-tile rounded-2xl active:bg-white/10 transition-all">
        <button onClick={() => onSelect(room)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
          <div className="relative flex-shrink-0">
            <div className="w-11 h-11 rounded-xl bg-white/10 flex items-center justify-center text-xl">
              {room.icon}
            </div>
            {room.isLive && (
              <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse border-2 border-[#072E49]" />
            )}
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="text-white text-xs font-bold truncate">{room.name}</span>
              {room.isPrivate && <span className="text-[9px] flex-shrink-0">🔒</span>}
              {room.role === "admin" && (
                <span className="text-[8px] text-[#90C9F0] border border-[#90C9F0]/40 rounded-full px-1.5 py-0.5 flex-shrink-0">admin</span>
              )}
              {room.isLive && (
                <span className="text-[8px] text-red-400 border border-red-400/30 rounded-full px-1.5 py-0.5 flex-shrink-0">LIVE</span>
              )}
            </div>
            <p className="text-white/50 text-[10px] truncate">{room.lastMessage || room.description}</p>
            <p className="text-white/40 text-[9px] mt-0.5">{room.memberCount} members</p>
          </div>
        </button>

        {mode === "mine" ? (
          <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
            <span className="text-white/40 text-[9px]">{timeAgo(room.lastMessageAt)}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onPinToggle(room); }}
              className={`text-sm transition-opacity ${room.isPinned ? "opacity-100" : "opacity-30"}`}
              title={room.isPinned ? "Unpin" : "Pin"}
            >
              📌
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); handleJoinPublic(room); }}
              className="bg-[#22ff00] text-[#072E49] text-[10px] font-bold px-2.5 py-1 rounded-lg"
            >
              {t("chat.join")}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); hideRoom(room.id); }}
              className="text-white/40 text-[9px] hover:text-white/70"
            >
              {t("chat.hide")}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 overflow-y-auto">
      {/* Search / join by code */}
      <div className="icy-tile rounded-2xl flex items-center gap-2 px-3 py-2.5">
        <span className="text-white/40 text-sm">🔎</span>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("chat.searchRooms")}
          className="flex-1 bg-transparent text-white text-xs outline-none placeholder-white/30"
        />
        {search && <button onClick={() => setSearch("")} className="text-white/50 text-xs">✕</button>}
      </div>

      {/* Code lookup result */}
      {codeResult && (
        <div className="flex items-center gap-3 px-4 py-3 bg-[#90C9F0]/10 border border-[#90C9F0]/30 rounded-2xl">
          <div className="w-11 h-11 rounded-xl bg-white/10 flex items-center justify-center text-xl flex-shrink-0">
            {codeResult.icon}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-white text-xs font-bold truncate">{codeResult.name}</span>
              {codeResult.isPrivate && <span className="text-[9px]">🔒</span>}
            </div>
            <p className="text-white/50 text-[10px]">{codeResult.memberCount} members</p>
          </div>
          <button
            onClick={handleJoinByCode}
            disabled={joining}
            className="bg-[#22ff00] text-[#072E49] text-xs font-bold px-3 py-1.5 rounded-xl flex-shrink-0 disabled:opacity-50"
          >
            {joining ? t("chat.joining") : codeResult.isMember ? t("chat.open") : t("chat.join")}
          </button>
        </div>
      )}
      {codeError && looksLikeCode && (
        <p className="text-white/40 text-[10px] text-center">{codeError}</p>
      )}

      {/* Tabs: My Rooms / Discover */}
      <div className="flex gap-1 icy-tile rounded-xl p-1">
        <button
          onClick={() => setTab("mine")}
          className="flex-1 py-2 rounded-lg text-xs font-semibold transition-all"
          style={tab === "mine" ? { background: "#22ff00", color: "#072E49", fontWeight: 700 } : { color: "#92A08A" }}
        >
          {t("chat.myRooms")} ({myRooms.length})
        </button>
        <button
          onClick={() => setTab("discover")}
          className="flex-1 py-2 rounded-lg text-xs font-semibold transition-all"
          style={tab === "discover" ? { background: "#22ff00", color: "#072E49", fontWeight: 700 } : { color: "#92A08A" }}
        >
          {t("chat.discover")} ({discover.length})
        </button>
      </div>

      {tab === "mine" && (
        <>
          {pinned.length > 0 && (
            <div>
              <p className="text-white/40 text-[9px] uppercase tracking-widest mb-2 px-1">{t("chat.pinned")}</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {pinned.map((r) => <RoomRow key={r.id} room={r} mode="mine" />)}
              </div>
            </div>
          )}
          {others.length > 0 && (
            <div>
              <p className="text-white/40 text-[9px] uppercase tracking-widest mb-2 px-1">
                {pinned.length > 0 ? t("chat.otherRooms") : t("chat.rooms")}
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {others.map((r) => <RoomRow key={r.id} room={r} mode="mine" />)}
              </div>
            </div>
          )}
          {myRooms.length === 0 && !codeResult && (
            <div className="flex flex-col items-center py-8 gap-2">
              <span className="text-2xl">💬</span>
              <p className="text-white/60 text-xs font-medium">{t("chat.noRoomsYet")}</p>
              <p className="text-white/40 text-[10px] text-center">
                {t("chat.noRoomsHint")}
              </p>
            </div>
          )}
        </>
      )}

      {tab === "discover" && (
        <>
          {discover.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {discover.map((r) => <RoomRow key={r.id} room={r} mode="discover" />)}
            </div>
          ) : (
            !codeResult && (
              <div className="flex flex-col items-center py-8 gap-2">
                <span className="text-2xl">🌐</span>
                <p className="text-white/60 text-xs font-medium">{t("chat.nothingDiscover")}</p>
                <p className="text-white/40 text-[10px] text-center">{t("chat.noPublicRooms")}</p>
              </div>
            )
          )}
          {hiddenCount > 0 && (
            <button
              onClick={resetHidden}
              className="text-white/40 text-[10px] underline self-center"
            >
              Show {hiddenCount} hidden room{hiddenCount > 1 ? "s" : ""}
            </button>
          )}
        </>
      )}

      <button
        onClick={onCreateNew}
        className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl border border-dashed border-white/15 text-white/50 text-xs active:bg-white/5 transition-colors"
      >
        <span className="text-lg">+</span>
        <span>{t("chat.createRoom")}</span>
      </button>
    </div>
  );
}

// ─── Active room chat ─────────────────────────────────────────────────────────

function RoomChat({ room, currentUserId, me, onBack, onUpdate, onLeft, onDeleted, onPinToggle }: {
  room: ChatRoom;
  currentUserId: string;
  me: UserProfile | null;
  onBack: () => void;
  onUpdate: (updated: ChatRoom) => void;
  onLeft: (roomId: string) => void;
  onDeleted: (roomId: string) => void;
  onPinToggle: (room: ChatRoom) => void;
}) {
  const { t } = useI18n();
  const { messages, onlineCount, connected, initMessages, appendOptimistic, confirmMessage } =
    useChatSocket(room.id);
  const [input, setInput] = useState("");
  const [tag, setTag] = useState<"pick" | "analysis" | undefined>();
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [loadingMessages, setLoadingMessages] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const isAdmin = room.role === "admin";

  // Load HTTP history on mount, seed into socket hook
  useEffect(() => {
    setLoadingMessages(true);
    profileApiService.getRoomMessages(room.id)
      .then((msgs) => initMessages(msgs))
      .catch((e) => setErrorMsg(e.message ?? "Could not load messages"))
      .finally(() => setLoadingMessages(false));
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

    // Optimistic: show immediately using the user's REAL profile
    const optimistic: ChatMessage = {
      id: tempId,
      userId: currentUserId,
      username: me?.username ?? "",
      displayName: me?.displayName ?? me?.username ?? "",
      avatar: me?.avatar ?? "👤",
      avatarUrl: me?.avatarUrl ?? null,
      tier: me?.tier ?? "rookie",
      text,
      sentAt: new Date().toISOString(),
      reactions: [],
      tag,
      replyTo: replyTo ? { username: replyTo.username, text: replyTo.text } : undefined,
    };
    appendOptimistic(optimistic);
    setTag(undefined);
    setReplyTo(null);

    try {
      // Confirm with server — socket will broadcast to others, we replace the optimistic copy
      const confirmed = await profileApiService.sendMessage(room.id, {
        text,
        tag,
        replyTo: replyTo ? { username: replyTo.username, text: replyTo.text } : undefined,
      });
      confirmMessage(tempId, confirmed);
      onUpdate({ ...room, lastMessage: text, lastMessageAt: confirmed.sentAt, unread: 0 });
    } catch (e: any) {
      setErrorMsg(e.message ?? "Message not sent");
    }
  }

  async function handleReact(msgId: string, emoji: string) {
    // Optimistic toggle handled inside MessageBubble via local state
    try { await profileApiService.toggleReaction(room.id, msgId, emoji); } catch { /* non-blocking */ }
  }

  async function handleLeave() {
    if (!confirm(`Leave ${room.name}?`)) return;
    try {
      await profileApiService.leaveRoom(room.id);
      onLeft(room.id);
    } catch (e: any) {
      setErrorMsg(e.message ?? "Could not leave room");
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete ${room.name} for everyone? This cannot be undone.`)) return;
    try {
      await profileApiService.deleteRoom(room.id);
      onDeleted(room.id);
    } catch (e: any) {
      setErrorMsg(e.message ?? "Could not delete room");
    }
  }

  // Real-time count from the socket only — no fabricated fallback
  const displayOnline = connected ? onlineCount : 0;

  return (
    <div className="flex flex-col h-full w-full md:max-w-3xl md:mx-auto">
      {/* Room header */}
      <div className="flex items-center gap-3 mb-3 flex-shrink-0">
        <button
          onClick={onBack}
          className="w-8 h-8 rounded-xl icy-tile flex items-center justify-center text-[#90C9F0] flex-shrink-0"
        >
          ←
        </button>
        <div className="w-8 h-8 rounded-xl icy-tile flex items-center justify-center text-base flex-shrink-0">
          {room.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-white text-sm font-bold truncate">{room.name}</p>
            {room.isPrivate && <span className="text-[10px]">🔒</span>}
            {isAdmin && (
              <span className="text-[8px] text-[#90C9F0] border border-[#90C9F0]/40 rounded-full px-1.5 py-0.5 flex-shrink-0">admin</span>
            )}
            {room.isLive && <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-green-400 animate-pulse" : "bg-white/20"}`} />
              <span className="text-[9px] text-white/40">{displayOnline} {t("common.online")}</span>
            </div>
          </div>
        </div>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="w-8 h-8 rounded-xl icy-tile flex items-center justify-center text-white/60 flex-shrink-0"
        >
          ⋯
        </button>
      </div>

      {/* Room menu */}
      {menuOpen && (
        <div className="icy-card rounded-2xl mb-3 overflow-hidden flex-shrink-0">
          {room.joinCode && (
            <button
              onClick={() => { navigator.clipboard?.writeText(room.joinCode ?? ""); setMenuOpen(false); }}
              className="w-full flex items-center justify-between px-4 py-3 text-left border-b border-white/5 active:bg-white/5"
            >
              <span className="text-white/80 text-xs">{t("chat.joinCode")}</span>
              <span className="text-[#90C9F0] text-xs font-bold tracking-[0.2em]">{room.joinCode} 📋</span>
            </button>
          )}
          <button
            onClick={() => { onPinToggle(room); setMenuOpen(false); }}
            className="w-full flex items-center justify-between px-4 py-3 text-left border-b border-white/5 active:bg-white/5"
          >
            <span className="text-white/80 text-xs">{room.isPinned ? t("chat.unpinRoom") : t("chat.pinRoom")}</span>
            <span className="text-xs">📌</span>
          </button>
          <button
            onClick={() => { setShowMembers(true); setMenuOpen(false); }}
            className="w-full flex items-center justify-between px-4 py-3 text-left border-b border-white/5 active:bg-white/5"
          >
            <span className="text-white/80 text-xs">{t("chat.membersMenu")}</span>
            <span className="text-white/40 text-xs">{room.memberCount} 👥</span>
          </button>
          <button
            onClick={handleLeave}
            className="w-full flex items-center justify-between px-4 py-3 text-left border-b border-white/5 active:bg-white/5"
          >
            <span className="text-orange-400 text-xs">{t("chat.leaveRoom")}</span>
            <span className="text-xs">🚪</span>
          </button>
          {isAdmin && (
            <button
              onClick={handleDelete}
              className="w-full flex items-center justify-between px-4 py-3 text-left active:bg-white/5"
            >
              <span className="text-red-400 text-xs">{t("chat.deleteRoom")}</span>
              <span className="text-xs">🗑️</span>
            </button>
          )}
        </div>
      )}

      {errorMsg && (
        <div className="flex items-center justify-between bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2 mb-2 flex-shrink-0">
          <p className="text-red-400 text-[10px]">{errorMsg}</p>
          <button onClick={() => setErrorMsg(null)} className="text-red-400 text-xs">✕</button>
        </div>
      )}

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
                <p className="text-white/50 text-[10px] text-center">{room.description}<br />{t("chat.beFirst")}</p>
              </div>
            )}
            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                msg={msg}
                isOwn={msg.userId === currentUserId}
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
        <div className="flex items-center gap-2 icy-tile rounded-xl px-3 py-2 mb-2 flex-shrink-0">
          <div className="flex-1 min-w-0">
            <p className="text-[#90C9F0] text-[9px] font-medium">{t("chat.replyingTo")} @{replyTo.username}</p>
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
        <div className="flex items-center gap-2 icy-tile rounded-2xl px-3 py-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage()}
            placeholder={`${t("chat.message")} ${room.name}…`}
            className="flex-1 bg-transparent text-white text-xs outline-none placeholder-white/30"
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim()}
            className={`w-7 h-7 rounded-xl flex items-center justify-center text-sm transition-all flex-shrink-0 ${
              input.trim() ? "bg-[#22ff00] text-[#072E49]" : "bg-white/10 text-white/30"
            }`}
          >
            ↑
          </button>
        </div>
      </div>

      {showMembers && (
        <MembersModal room={room} currentUserId={currentUserId} onClose={() => setShowMembers(false)} />
      )}
    </div>
  );
}


// ─── ChatTab export ───────────────────────────────────────────────────────────

export function ChatTab({ onUnreadChange }: { onUnreadChange?: (n: number) => void }) {
  const { t } = useI18n();
  const { user } = useAuth();
  const currentUserId = user?.id ?? "";
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [activeRoom, setActiveRoom] = useState<ChatRoom | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<UserProfile | null>(null);

  useEffect(() => {
    profileApiService.getChatRooms().then((r) => {
      setRooms(r);
    }).catch(() => {}).finally(() => {
      setLoading(false);
    });
    // Load the real profile once — used for optimistic message rendering
    profileApiService.getProfile().then(setMe).catch(() => {});
  }, []);

  function handleSelectRoom(room: ChatRoom) {
    setActiveRoom(room);
    setRooms((prev) => prev.map((r) => r.id === room.id ? { ...r, unread: 0 } : r));
  }

  function handleUpdateRoom(updated: ChatRoom) {
    setRooms((prev) => prev.map((r) => r.id === updated.id ? updated : r));
    setActiveRoom((cur) => (cur && cur.id === updated.id ? updated : cur));
  }

  function handleCreateRoom(room: ChatRoom) {
    setRooms((prev) => [...prev, room]);
    setActiveRoom(room);
  }

  function handleJoined(room: ChatRoom) {
    setRooms((prev) => {
      const exists = prev.some((r) => r.id === room.id);
      return exists ? prev.map((r) => (r.id === room.id ? room : r)) : [...prev, room];
    });
    setActiveRoom(room);
  }

  function handleLeft(roomId: string) {
    setActiveRoom(null);
    // Refresh from server: the room may still be visible (public) or gone (private)
    profileApiService.getChatRooms().then(setRooms).catch(() => {
      setRooms((prev) => prev.filter((r) => r.id !== roomId));
    });
  }

  function handleDeleted(roomId: string) {
    setActiveRoom(null);
    setRooms((prev) => prev.filter((r) => r.id !== roomId));
  }

  async function handlePinToggle(room: ChatRoom) {
    try {
      const updated = await profileApiService.pinRoom(room.id, !room.isPinned);
      setRooms((prev) => {
        const next = prev.map((r) => (r.id === updated.id ? updated : r));
        // Keep pinned rooms first
        return [...next.filter((r) => r.isPinned), ...next.filter((r) => !r.isPinned)];
      });
      setActiveRoom((cur) => (cur && cur.id === updated.id ? updated : cur));
    } catch { /* non-blocking */ }
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
            <p className="text-white/60 text-xs">{rooms.length} {t("chat.roomsAvailable")}</p>
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1 bg-[#22ff00] text-[#072E49] text-xs font-bold px-3 py-1.5 rounded-xl"
            >
              {t("chat.newRoom")}
            </button>
          </>
        )}
      </div>

      {activeRoom ? (
        <RoomChat
          room={activeRoom}
          currentUserId={currentUserId}
          me={me}
          onBack={() => setActiveRoom(null)}
          onUpdate={handleUpdateRoom}
          onLeft={handleLeft}
          onDeleted={handleDeleted}
          onPinToggle={handlePinToggle}
        />
      ) : (
        <RoomList
          rooms={rooms}
          onSelect={handleSelectRoom}
          onCreateNew={() => setShowCreate(true)}
          onPinToggle={handlePinToggle}
          onJoined={handleJoined}
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
