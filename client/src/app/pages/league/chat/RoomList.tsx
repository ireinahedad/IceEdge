import { useEffect, useState } from "react";
import { profileApiService } from "../../../services/userService";
import { useI18n } from "../../../i18n";
import type { ChatRoom } from "../../../types/user";

// ─── Room list ────────────────────────────────────────────────────────────────
// Single page (no tabs): a "Public" section (all public rooms) and a "Private"
// section (private rooms the user belongs to). Each section is collapsible.

const HIDDEN_ROOMS_KEY = "iceedge_hidden_rooms";

export function RoomList({ rooms, onSelect, onCreateNew, onPinToggle, onJoined }: {
  rooms: ChatRoom[];
  onSelect: (room: ChatRoom) => void;
  onCreateNew: () => void;
  onPinToggle: (room: ChatRoom) => void;
  onJoined: (room: ChatRoom) => void;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [openPublic, setOpenPublic] = useState(true);
  const [openPrivate, setOpenPrivate] = useState(true);
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

  // Public = every public room · Private = private rooms I belong to.
  // Pinned rooms float to the top of their section.
  const byPinned = (a: ChatRoom, b: ChatRoom) => Number(!!b.isPinned) - Number(!!a.isPinned);
  const publicRooms  = rooms.filter((r) => !r.isPrivate && !hiddenIds.includes(r.id) && matches(r)).sort(byPinned);
  const privateRooms = rooms.filter((r) => r.isPrivate && r.isMember && matches(r)).sort(byPinned);
  const hiddenCount  = rooms.filter((r) => !r.isPrivate && hiddenIds.includes(r.id)).length;

  // If the search looks like a join code and matches no visible room, offer a lookup.
  const looksLikeCode = /^[a-zA-Z0-9]{4,10}$/.test(search.trim()) && publicRooms.length === 0 && privateRooms.length === 0;

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
    const timer = setTimeout(() => {
      profileApiService.lookupRoomByCode(search.trim())
        .then(setCodeResult)
        .catch(() => setCodeError("No room found for this code"));
    }, 400);
    return () => clearTimeout(timer);
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

  function RoomRow({ room }: { room: ChatRoom }) {
    const isMine = !!room.isMember;
    // Glossy frost is reserved for pinned rooms; everything else is flat.
    const tileClass = room.isPinned ? "icy-tile" : "chat-tile";
    return (
      <div className={`w-full flex items-center gap-3 px-4 py-3 ${tileClass} rounded-2xl active:bg-white/10 transition-all`}>
        <button onClick={() => onSelect(room)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
          <div className="relative flex-shrink-0">
            <div
              className="w-11 h-11 rounded-xl flex items-center justify-center text-xl"
              style={{ background: room.color ?? "rgba(255,255,255,0.10)" }}
            >
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

        {isMine ? (
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

  function SectionHeader({ title, count, open, onToggle }: {
    title: string; count: number; open: boolean; onToggle: () => void;
  }) {
    return (
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-1 py-1 text-left"
      >
        <span className="text-white/60 text-[11px] uppercase tracking-widest font-semibold">
          {title} <span className="text-white/30">({count})</span>
        </span>
        <span className={`text-white/40 text-xs transition-transform ${open ? "rotate-0" : "-rotate-90"}`}>▾</span>
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-4 overflow-y-auto">
      {/* Search / join by code (no clear button — keeps the keyboard-free view calm) */}
      <div className="chat-tile rounded-2xl flex items-center gap-2 px-3 py-2.5">
        <span className="text-white/40 text-sm">🔎</span>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("chat.searchRooms")}
          className="flex-1 bg-transparent text-white text-xs outline-none placeholder-white/30"
        />
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

      {/* Private section */}
      <div className="flex flex-col gap-2">
        <SectionHeader title={t("chat.sectionPrivate")} count={privateRooms.length} open={openPrivate} onToggle={() => setOpenPrivate((v) => !v)} />
        {openPrivate && (
          privateRooms.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {privateRooms.map((r) => <RoomRow key={r.id} room={r} />)}
            </div>
          ) : (
            <p className="text-white/40 text-[10px] px-1 py-2">{t("chat.noPrivateRooms")}</p>
          )
        )}
      </div>

      {/* Public section */}
      <div className="flex flex-col gap-2">
        <SectionHeader title={t("chat.sectionPublic")} count={publicRooms.length} open={openPublic} onToggle={() => setOpenPublic((v) => !v)} />
        {openPublic && (
          publicRooms.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {publicRooms.map((r) => <RoomRow key={r.id} room={r} />)}
            </div>
          ) : (
            !codeResult && <p className="text-white/40 text-[10px] px-1 py-2">{t("chat.noPublicRooms")}</p>
          )
        )}
        {openPublic && hiddenCount > 0 && (
          <button
            onClick={resetHidden}
            className="text-white/40 text-[10px] underline self-center"
          >
            Show {hiddenCount} hidden room{hiddenCount > 1 ? "s" : ""}
          </button>
        )}
      </div>

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
