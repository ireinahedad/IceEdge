import { useEffect, useState } from "react";
import { profileApiService } from "../../../services/userService";
import { useAuth } from "../../../context/AuthContext";
import { useI18n } from "../../../i18n";
import type { ChatRoom, UserProfile } from "../../../types/user";
import { CreateRoomModal } from "./CreateRoomModal";
import { RoomList } from "./RoomList";
import { RoomChat } from "./RoomChat";

// ─── ChatTab — orchestrates room list / active room / create modal ────────────

export function ChatTab() {
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
              className="flex items-center gap-1 bg-[#86d1ea] text-[#072E49] text-xs font-bold px-3 py-1.5 rounded-xl"
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
