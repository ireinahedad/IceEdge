import { useEffect, useState } from "react";
import { toast } from "../../../toast";
import { profileApiService } from "../../../services/userService";
import { useAuthGate } from "../../../context/AuthGateContext";
import { useI18n } from "../../../i18n";
import { AppButton } from "../../../components/AppButton";
import type { ChatRoom } from "../../../types/user";
import { PickemSection } from "./PickemSection";

import { Lock, Pin, Search } from "lucide-react";
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
  const { requireAuth } = useAuthGate();
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
    if (!requireAuth("gate.joinRoom")) return;
    try {
      const joined = await profileApiService.joinRoom(room.id);
      onJoined(joined);
    } catch (e: any) {
      toast.error(e?.message ?? t("chat.joinFailed"));
    }
  }

  useEffect(() => {
    setCodeResult(null);
    setCodeError(null);
    if (!looksLikeCode) return;
    const timer = setTimeout(() => {
      profileApiService.lookupRoomByCode(search.trim())
        .then(setCodeResult)
        .catch(() => setCodeError(t("chat.noCode")));
    }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  async function handleJoinByCode() {
    if (!codeResult) return;
    if (!requireAuth("gate.joinRoom")) return;
    setJoining(true);
    try {
      const room = await profileApiService.joinRoomByCode(search.trim());
      setSearch("");
      setCodeResult(null);
      onJoined(room);
    } catch (e: any) {
      const message = e?.message ?? t("chat.joinFailed");
      setCodeError(message);
      toast.error(message);
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
    // Deux mobiliers d'aréna, pas deux nuances de la même carte :
    //   privé  → une porte de casier de vestiaire (`.arena-locker`)
    //   public → un panneau publicitaire de bord de bande (`.arena-adboard`)
    // Le halo (`.arena-glow`) est la lumière d'aréna : elle ne tombe que sur
    // ce qui compte — un salon en direct (rouge) ou épinglé (bleu glace).
    const surface = room.isPrivate ? "arena-locker" : "arena-adboard";
    const glow = room.isLive ? " arena-glow--live" : room.isPinned ? " arena-glow" : "";
    return (
      <div className={`w-full flex items-center gap-3 px-4 py-3 ${surface}${glow} rounded-2xl transition-all`}>
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
              {/* Sur un casier, le nom est gravé sur la plaque de porte. */}
              {room.isPrivate ? (
                <span className="arena-nameplate text-[11px] truncate max-w-[150px]">{room.name}</span>
              ) : (
                <span className="text-white text-xs font-bold truncate">{room.name}</span>
              )}
              {room.isPrivate && <Lock size={11} className="text-white/60 flex-shrink-0" />}
              {room.role === "admin" && (
                <span className="text-[11px] text-[#90C9F0] border border-[#90C9F0]/40 rounded-full px-1.5 py-0.5 flex-shrink-0">admin</span>
              )}
              {room.isLive && (
                <span className="text-[11px] text-red-400 border border-red-400/30 rounded-full px-1.5 py-0.5 flex-shrink-0">LIVE</span>
              )}
            </div>
            {/* Le panneau publicitaire est plus lumineux qu'une carte givrée :
                le texte secondaire y remonte d'un cran pour rester lisible. */}
            <p className={`${room.isPrivate ? "text-white/50" : "text-white/70"} text-[11px] truncate`}>{room.lastMessage || room.description}</p>
            <p className={`${room.isPrivate ? "text-white/40" : "text-white/60"} text-[11px] mt-0.5`}>{room.memberCount} {t("common.members")}</p>
          </div>
        </button>

        {isMine ? (
          <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
            <span className="text-white/40 text-[11px]">{timeAgo(room.lastMessageAt)}</span>
            <button
              onClick={(e) => { e.stopPropagation(); onPinToggle(room); }}
              className={`tap-44 text-sm transition-opacity ${room.isPinned ? "opacity-100" : "opacity-30"}`}
              title={room.isPinned ? t("chat.unpinRoom") : t("chat.pinRoom")}
            >
              <Pin size={13} />
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
            <AppButton
              variant="secondary"
              size="sm"
              onClick={(e) => { e.stopPropagation(); handleJoinPublic(room); }}
            >
              {t("chat.join")}
            </AppButton>
            <button
              onClick={(e) => { e.stopPropagation(); hideRoom(room.id); }}
              className="text-white/40 text-[11px] hover:text-white/70"
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
        <span className="arena-section-title">
          {title} <span className="arena-section-count">({count})</span>
        </span>
        <span className={`text-white/40 text-xs transition-transform ${open ? "rotate-0" : "-rotate-90"}`}>▾</span>
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-4 overflow-y-auto">
      {/* Search / join by code (no clear button — keeps the keyboard-free view calm) */}
      <div className="chat-tile rounded-2xl flex items-center gap-2 px-3 py-2.5">
        <Search size={14} className="text-white/40 flex-shrink-0" />
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
              {codeResult.isPrivate && <Lock size={11} className="text-white/60 flex-shrink-0" />}
            </div>
            <p className="text-white/50 text-[11px]">{codeResult.memberCount} {t("common.members")}</p>
          </div>
          <AppButton
            variant="secondary"
            size="sm"
            onClick={handleJoinByCode}
            disabled={joining}
            loading={joining}
            className="flex-shrink-0"
          >
            {codeResult.isMember ? t("chat.open") : t("chat.join")}
          </AppButton>
        </div>
      )}
      {codeError && looksLikeCode && (
        <p className="text-white/40 text-[11px] text-center">{codeError}</p>
      )}

      {/* Votes du jour (pick'em ICEEDGE, F3) — dépliable, au-dessus des salons. */}
      <PickemSection />

      {/* Salons privés — vus à travers un chambranle éclairé : on regarde DANS
          la pièce, sans qu'un seul mot n'ait à la nommer. Les noms de salon
          appartiennent aux utilisateurs, le vestiaire ne peut donc pas être
          une étiquette : c'est un endroit où l'on entre. */}
      <div className="arena-doorway flex flex-col gap-2">
        <SectionHeader title={t("chat.sectionPrivate")} count={privateRooms.length} open={openPrivate} onToggle={() => setOpenPrivate((v) => !v)} />
        {openPrivate && (
          privateRooms.length > 0 ? (
            <div className="grid grid-cols-1 gap-2">
              {privateRooms.map((r) => <RoomRow key={r.id} room={r} />)}
            </div>
          ) : (
            <p className="text-white/40 text-[11px] px-1 py-2">{t("chat.noPrivateRooms")}</p>
          )
        )}
      </div>

      {/* Public section */}
      <div className="flex flex-col gap-2">
        <SectionHeader title={t("chat.sectionPublic")} count={publicRooms.length} open={openPublic} onToggle={() => setOpenPublic((v) => !v)} />
        {openPublic && (
          publicRooms.length > 0 ? (
            <div className="grid grid-cols-1 gap-2">
              {publicRooms.map((r) => <RoomRow key={r.id} room={r} />)}
            </div>
          ) : (
            !codeResult && <p className="text-white/40 text-[11px] px-1 py-2">{t("chat.noPublicRooms")}</p>
          )
        )}
        {openPublic && hiddenCount > 0 && (
          <button
            onClick={resetHidden}
            className="text-white/40 text-[11px] underline self-center"
          >
            {t("chat.showHidden", { n: hiddenCount })}
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
