import { useState } from "react";
import { toast } from "sonner";
import { profileApiService } from "../../../services/userService";
import { useI18n } from "../../../i18n";
import { AppButton } from "../../../components/AppButton";
import type { ChatRoom } from "../../../types/user";

// ─── Create room modal ────────────────────────────────────────────────────────

// Preset accent colors the creator can pick for their salon.
const ROOM_COLORS = ["#90c9f0", "#22ff00", "#f2994a", "#eb5757", "#bb6bd9", "#f2c94c", "#2d9cdb", "#6fcf97"];

export function CreateRoomModal({ onClose, onCreate }: {
  onClose: () => void;
  onCreate: (room: ChatRoom) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [color, setColor] = useState(ROOM_COLORS[0]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdRoom, setCreatedRoom] = useState<ChatRoom | null>(null);

  async function handleCreate() {
    if (!name.trim()) {
      setError(t("chat.roomNameRequired"));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const room = await profileApiService.createRoom({
        name: name.trim(),
        icon: name.trim().charAt(0).toUpperCase() || "#",
        description: desc.trim() || "Community chat",
        isPrivate,
        color,
      });
      if (room.isPrivate && room.joinCode) {
        // Show the join code before closing so the creator can share it
        setCreatedRoom(room);
      } else {
        onCreate(room);
        onClose();
      }
    } catch (e: any) {
      const message = e?.message ?? t("chat.createFailed");
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  if (createdRoom) {
    return (
      <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={() => { onCreate(createdRoom); onClose(); }}>
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
        <div
          className="relative w-full max-w-[430px] icy-card rounded-t-3xl p-6 pb-10"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-5" />
          <p className="text-white font-bold text-base mb-1">{t("chat.privateCreated")}</p>
          <p className="text-white/50 text-xs mb-4">{t("chat.shareCode")}</p>
          <div className="icy-tile border-[#90C9F0]/40 rounded-2xl py-4 text-center mb-4">
            <p className="text-[#90C9F0] text-2xl font-bold tracking-[0.3em]">{createdRoom.joinCode}</p>
          </div>
          <AppButton
            variant="ghost"
            onClick={() => { navigator.clipboard?.writeText(createdRoom.joinCode ?? ""); }}
            fullWidth
            className="mb-2"
          >
            {t("chat.copyCode")}
          </AppButton>
          <AppButton
            variant="secondary"
            onClick={() => { onCreate(createdRoom); onClose(); }}
            fullWidth
          >
            {t("chat.openRoom")}
          </AppButton>
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

        <p className="text-white/60 text-[10px] uppercase tracking-wider mb-1.5">
          {t("chat.roomName")} <span className="text-red-400">*</span>
        </p>
        <input
          value={name}
          onChange={(e) => { setName(e.target.value); if (error) setError(null); }}
          placeholder="e.g. Western Conference"
          maxLength={32}
          required
          aria-required="true"
          className={`w-full icy-tile rounded-xl px-3 py-2.5 text-white text-sm outline-none placeholder-white/30 mb-3 transition-colors ${
            error && !name.trim() ? "border border-red-400/60" : "focus:border-[#90C9F0]/50"
          }`}
        />

        <p className="text-white/60 text-[10px] uppercase tracking-wider mb-1.5">{t("chat.description")}</p>
        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="What's this room about?"
          maxLength={64}
          className="w-full icy-tile rounded-xl px-3 py-2.5 text-white text-sm outline-none placeholder-white/30 mb-4 focus:border-[#90C9F0]/50 transition-colors"
        />

        {/* Color picker */}
        <p className="text-white/60 text-[10px] uppercase tracking-wider mb-1.5">{t("chat.roomColor")}</p>
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          {ROOM_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              aria-label={c}
              className={`w-7 h-7 rounded-full transition-all ${color === c ? "ring-2 ring-white ring-offset-2 ring-offset-[#0A0E0C] scale-110" : "opacity-80"}`}
              style={{ background: c }}
            />
          ))}
        </div>

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
            className={`relative rounded-full transition-colors flex-shrink-0 ${isPrivate ? "bg-[#86d1ea]" : "bg-white/10"}`}
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
          <AppButton variant="ghost" onClick={onClose} className="flex-1">
            {t("common.cancel")}
          </AppButton>
          <AppButton
            variant="secondary"
            onClick={handleCreate}
            disabled={!name.trim() || loading}
            loading={loading}
            className="flex-1"
          >
            {t("chat.create")}
          </AppButton>
        </div>
      </div>
    </div>
  );
}
