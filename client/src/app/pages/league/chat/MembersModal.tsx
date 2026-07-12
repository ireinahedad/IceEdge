import { useEffect, useState } from "react";
import { profileApiService } from "../../../services/userService";
import { useI18n } from "../../../i18n";
import type { ChatRoom, ChatRoomMember } from "../../../types/user";

// ─── Members modal (admin can kick / promote) ─────────────────────────────────

export function MembersModal({ room, currentUserId, onClose }: {
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
        className="relative w-full max-w-[430px] max-h-[70vh] overflow-y-auto icy-card rounded-t-3xl p-6 pb-10"
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
