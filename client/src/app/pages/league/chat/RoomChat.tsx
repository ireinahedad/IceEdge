import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { MessageBubble } from "./MessageBubble";
import { MembersModal } from "./MembersModal";
import { ReportModal } from "./ReportModal";
import { ConfirmDialog } from "../../../components/ConfirmDialog";
import { UserSheet } from "../../../components/UserSheet";
import { profileApiService } from "../../../services/userService";
import { useChatSocket } from "../../../hooks/useChatSocket";
import { useAuthGate } from "../../../context/AuthGateContext";
import { useBlocks } from "../../../context/BlockContext";
import { useI18n } from "../../../i18n";
import type { ChatRoom, ChatMessage, UserProfile, ReportReason } from "../../../types/user";

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

// ─── Active room chat ─────────────────────────────────────────────────────────

export function RoomChat({ room, currentUserId, me, onBack, onUpdate, onLeft, onDeleted, onPinToggle }: {
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
  const navigate = useNavigate();
  const { requireAuth } = useAuthGate();
  const { isBlocked, ensureLoaded, block } = useBlocks();
  const {
    messages, onlineCount, connected,
    initMessages, mergeMessages, appendOptimistic, confirmMessage, removeMessage,
    resyncKey, authError, roomError,
  } = useChatSocket(room.id);
  const [input, setInput] = useState("");
  const [tag, setTag] = useState<"pick" | "analysis" | undefined>();
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [loadingMessages, setLoadingMessages] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [reportTarget, setReportTarget] = useState<ChatMessage | null>(null);
  const [reporting, setReporting] = useState(false);
  const [blockTarget, setBlockTarget] = useState<ChatMessage | null>(null);
  const [sheetUser, setSheetUser] = useState<ChatMessage | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const isAdmin = room.role === "admin";

  // R4.3d — la liste de blocage, chargée une fois quand on ouvre un salon.
  useEffect(() => { ensureLoaded(); }, [ensureLoaded]);

  /**
   * R4.3d — le SEUL filtre de blocage du chat, appliqué au rendu.
   *
   * Le serveur filtre déjà l'historique en SQL (R4.2f), mais PAS le direct : il
   * diffuse à toute la salle (R4.2g), donc le message d'une personne bloquée
   * arrive quand même ici. Filtrer à l'affichage couvre les deux chemins d'un
   * coup, au lieu d'un filtre dans le hook de socket plus un autre à
   * l'historique — et surtout, débloquer quelqu'un fait revenir ses messages
   * immédiatement, sans rappeler le serveur.
   */
  const visibleMessages = useMemo(
    () => messages.filter((m) => !isBlocked(m.userId)),
    [messages, isBlocked],
  );

  /**
   * L'historique HTTP — au montage, puis à chaque fois que le hook réclame une
   * resynchronisation (`resyncKey` : reconnexion du socket, ou retour au
   * premier plan).
   *
   * Une resynchro ne se comporte PAS comme un montage :
   *   • elle FUSIONNE (`mergeMessages`) au lieu d'écraser — sinon un message
   *     optimiste encore en vol disparaît, et tout ce qui précède la fenêtre
   *     d'historique aussi ;
   *   • elle ne repasse pas l'écran en « chargement », qui clignoterait à
   *     chaque retour au premier plan ;
   *   • elle n'affiche pas son échec : on est déjà en train de récupérer d'une
   *     coupure, un bandeau rouge de plus n'aide personne. Le prochain
   *     `visibilitychange` réessaiera.
   */
  useEffect(() => {
    const isResync = resyncKey > 0;
    if (!isResync) setLoadingMessages(true);
    profileApiService.getRoomMessages(room.id)
      .then((msgs) => (isResync ? mergeMessages(msgs) : initMessages(msgs)))
      .catch((e) => { if (!isResync) setErrorMsg(e.message ?? "Could not load messages"); })
      .finally(() => { if (!isResync) setLoadingMessages(false); });
  }, [room.id, resyncKey]);

  /**
   * Les deux pannes que le socket sait nommer, dans le bandeau qui existait
   * déjà. Sans ça, une session expirée ou un accès refusé se traduisaient par
   * un salon qui ne reçoit plus rien, sans un mot.
   */
  useEffect(() => {
    if (authError) setErrorMsg(t("chat.sessionExpired"));
    else if (roomError) {
      setErrorMsg(roomError === "Access denied" ? t("chat.accessDenied") : t("chat.roomJoinFailed"));
    }
  }, [authError, roomError, t]);

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [visibleMessages.length]);

  async function sendMessage() {
    const text = input.trim();
    if (!text) return;
    if (!requireAuth("gate.sendMessage")) return;

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
    if (!requireAuth("gate.react")) return;
    // Optimistic toggle handled inside MessageBubble via local state
    try { await profileApiService.toggleReaction(room.id, msgId, emoji); } catch { /* non-blocking */ }
  }

  async function handleDeleteMessage(msgId: string) {
    if (!requireAuth("gate.deleteMessage")) return;
    if (!confirm(t("chat.deleteMessageConfirm"))) return;
    removeMessage(msgId); // optimistic
    try {
      await profileApiService.deleteMessage(room.id, msgId);
    } catch (e: any) {
      setErrorMsg(e.message ?? "Could not delete message");
    }
  }

  async function handleReport(payload: { reason: ReportReason; note?: string }) {
    const target = reportTarget;
    if (!target) return;
    setReporting(true);
    try {
      const res = await profileApiService.reportMessage(room.id, target.id, payload);
      setReportTarget(null);
      toast.success(res.alreadyReported ? t("report.already") : t("report.sent"));
      // Le serveur dit si CE signalement est celui qui a fait basculer le
      // masquage automatique : dans ce cas le message n'est plus servi à
      // personne, autant le retirer tout de suite plutôt qu'au rechargement.
      if (res.hidden) removeMessage(target.id);
    } catch (e: any) {
      toast.error(e?.message ?? t("report.failed"));
    } finally {
      setReporting(false);
    }
  }

  async function handleBlock() {
    const target = blockTarget;
    if (!target) return;
    setBlockTarget(null);
    try {
      await block({
        id: target.userId,
        username: target.username,
        displayName: target.displayName,
        avatar: target.avatar,
        avatarUrl: target.avatarUrl,
      });
      toast.success(t("block.done", { name: target.displayName || target.username }));
    } catch (e: any) {
      toast.error(e?.message ?? t("block.failed"));
    }
  }

  async function handleLeave() {
    if (!requireAuth("gate.leaveRoom")) return;
    if (!confirm(`Leave ${room.name}?`)) return;
    try {
      await profileApiService.leaveRoom(room.id);
      onLeft(room.id);
    } catch (e: any) {
      setErrorMsg(e.message ?? "Could not leave room");
    }
  }

  async function handleDelete() {
    if (!requireAuth("gate.deleteRoom")) return;
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
    <div className="relative flex flex-col h-full w-full">
      {/* Ouvrir un salon privé, c'est pousser la porte du vestiaire : deux
          battants de casier s'écartent une fois sur la conversation, puis le
          calque se retire. `key={room.id}` rejoue l'animation à chaque salon
          ouvert plutôt qu'une seule fois au montage du composant. */}
      {room.isPrivate && (
        <div className="arena-doors" key={room.id} aria-hidden>
          <span />
          <span />
        </div>
      )}

      {/* En-tête du salon — il reprend la surface de la rangée d'où l'on
          vient (casier de vestiaire si privé, panneau de bande si public) :
          c'est le seul repère qui dit dans quel type de salon on est une
          fois la liste quittée. */}
      <div className={`flex items-center gap-3 mb-3 flex-shrink-0 rounded-2xl px-3 py-2 ${room.isPrivate ? "arena-locker" : "arena-adboard"}`}>
        <button
          onClick={onBack}
          className="min-w-[44px] min-h-[44px] w-8 h-8 rounded-xl chat-tile flex items-center justify-center text-[#90C9F0] flex-shrink-0"
        >
          ←
        </button>
        <div
          className="w-8 h-8 rounded-xl chat-tile flex items-center justify-center text-base flex-shrink-0"
          style={room.color ? { background: room.color } : undefined}
        >
          {room.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-white text-sm font-bold truncate">{room.name}</p>
            {room.isPrivate && <span className="text-[11px]">🔒</span>}
            {isAdmin && (
              <span className="text-[11px] text-[#90C9F0] border border-[#90C9F0]/40 rounded-full px-1.5 py-0.5 flex-shrink-0">admin</span>
            )}
            {room.isLive && <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-green-400 animate-pulse" : "bg-white/20"}`} />
              <span className="text-[11px] text-white/40">{displayOnline} {t("common.online")}</span>
            </div>
          </div>
        </div>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="min-w-[44px] min-h-[44px] w-8 h-8 rounded-xl chat-tile flex items-center justify-center text-white/60 flex-shrink-0"
        >
          ⋯
        </button>
      </div>

      {/* Room menu */}
      {menuOpen && (
        <div className="chat-tile rounded-2xl mb-3 overflow-hidden flex-shrink-0">
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
          {/* R4.3f — les règles de la communauté doivent être atteignables
              DEPUIS le chat, pas seulement enfouies dans les Conditions. */}
          <button
            onClick={() => { setMenuOpen(false); navigate("/terms"); }}
            className="w-full flex items-center justify-between px-4 py-3 text-left border-b border-white/5 active:bg-white/5"
          >
            <span className="text-white/80 text-xs">{t("chat.guidelines")}</span>
            <span className="text-xs">📋</span>
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
          <p className="text-red-400 text-[11px]">{errorMsg}</p>
          <button onClick={() => setErrorMsg(null)} className="tap-44 text-red-400 text-xs">✕</button>
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
            {visibleMessages.length === 0 && (
              <div className="flex flex-col items-center justify-center py-10 gap-2">
                <span className="text-3xl">{room.icon}</span>
                <p className="text-white text-xs font-medium">{room.name}</p>
                <p className="text-white/50 text-[11px] text-center">{room.description}<br />{t("chat.beFirst")}</p>
              </div>
            )}
            {visibleMessages.map((msg) => (
              <MessageBubble
                key={msg.id}
                msg={msg}
                isOwn={msg.userId === currentUserId}
                onReact={handleReact}
                onReply={setReplyTo}
                onDelete={msg.userId === currentUserId ? handleDeleteMessage : undefined}
                onReport={(m) => { if (requireAuth("gate.report")) setReportTarget(m); }}
                onBlock={(m) => { if (requireAuth("gate.block")) setBlockTarget(m); }}
                onOpenUser={setSheetUser}
              />
            ))}
          </>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Reply preview */}
      {replyTo && (
        <div className="flex items-center gap-2 chat-tile rounded-xl px-3 py-2 mb-2 flex-shrink-0">
          <div className="flex-1 min-w-0">
            <p className="text-[#90C9F0] text-[11px] font-medium">{t("chat.replyingTo")} @{replyTo.username}</p>
            <p className="text-white/50 text-[11px] truncate">{replyTo.text}</p>
          </div>
          <button onClick={() => setReplyTo(null)} className="tap-44 text-white/50 text-xs">✕</button>
        </div>
      )}

      {/* Tag + input */}
      <div className="flex-shrink-0 mt-2">
        <div className="flex gap-1.5 mb-2">
          {(["pick", "analysis"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTag(tag === t ? undefined : t)}
              className={`px-2 py-1 rounded-full text-[11px] border transition-all ${
                tag === t ? TAG_STYLE[t] : "text-white/50 border-white/10"
              }`}
            >
              {TAG_LABEL[t]}
            </button>
          ))}
          {tag && <span className="text-white/40 text-[11px] self-center">tagged</span>}
        </div>
        <div className="flex items-center gap-2 chat-tile rounded-2xl px-3 py-2">
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
            className={`min-w-[44px] min-h-[44px] w-7 h-7 rounded-xl flex items-center justify-center text-sm transition-all flex-shrink-0 ${
              input.trim() ? "bg-[#86d1ea] text-[#072E49] arena-glow" : "bg-white/10 text-white/30"
            }`}
          >
            ↑
          </button>
        </div>
      </div>

      {showMembers && (
        <MembersModal room={room} currentUserId={currentUserId} onClose={() => setShowMembers(false)} />
      )}

      {sheetUser && (
        <UserSheet
          user={{
            userId: sheetUser.userId,
            username: sheetUser.username,
            displayName: sheetUser.displayName,
            avatar: sheetUser.avatar,
            avatarUrl: sheetUser.avatarUrl,
          }}
          isSelf={sheetUser.userId === currentUserId}
          onClose={() => setSheetUser(null)}
        />
      )}

      {reportTarget && (
        <ReportModal
          message={reportTarget}
          submitting={reporting}
          onSubmit={handleReport}
          onCancel={() => setReportTarget(null)}
        />
      )}

      {/* R4.3c — la formulation dit ce que fait un blocage, dans les deux sens,
          et qu'il se défait. Apple vérifie qu'un blocage est réversible. */}
      <ConfirmDialog
        open={blockTarget !== null}
        title={t("block.title", { name: blockTarget?.displayName || blockTarget?.username || "" })}
        description={t("block.description")}
        confirmLabel={t("block.confirm")}
        onConfirm={handleBlock}
        onCancel={() => setBlockTarget(null)}
      />
    </div>
  );
}
