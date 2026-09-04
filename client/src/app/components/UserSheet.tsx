import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { UserBadge, UserTag, type UserIdentityData } from "./UserIdentity";
import { ConfirmDialog } from "./ConfirmDialog";
import { useBlocks } from "../context/BlockContext";
import { useI18n } from "../i18n";

/**
 * UserSheet — la fiche d'un compte, la même d'où qu'on l'ouvre.
 *
 * Ouverte depuis la liste des membres d'un salon et depuis le nom d'un message.
 * Elle porte le bouton « Bloquer », ce qui donne à R4 un deuxième chemin : avant,
 * bloquer quelqu'un exigeait de trouver un de ses messages ET le petit menu
 * dessus — impossible dès que la personne avait supprimé ce message.
 *
 * ── Aucun appel réseau, volontairement ──────────────────────────────────────
 * La fiche se dessine avec ce que l'appelant a déjà en main. Le résumé complet
 * d'un joueur (`GET /users/:id/summary`) est réservé aux membres Pro pour les
 * autres comptes : le charger ici afficherait un 402 à la moitié des visiteurs,
 * sur un écran dont le rôle est de proposer « bloquer ». « Voir le profil
 * complet » mène à la page joueur, qui gère ce mur elle-même.
 *
 * Bloquer et débloquer passent par `BlockContext`, donc l'effet est immédiat
 * partout : les messages de la personne disparaissent du salon derrière la
 * feuille, sans rechargement.
 */

export function UserSheet({
  user,
  isSelf,
  badges,
  onClose,
}: {
  user: UserIdentityData;
  isSelf: boolean;
  /** Pastilles contextuelles (admin du salon, par exemple). */
  badges?: React.ReactNode;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { isBlocked, block, unblock } = useBlocks();
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [busy, setBusy] = useState(false);

  const blocked = isBlocked(user.userId);
  const name = user.displayName || user.username;

  async function doBlock() {
    setConfirmBlock(false);
    setBusy(true);
    try {
      await block({ id: user.userId, username: user.username, displayName: user.displayName, avatar: user.avatar, avatarUrl: user.avatarUrl });
      toast.success(t("block.done", { name }));
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? t("block.failed"));
    } finally { setBusy(false); }
  }

  async function doUnblock() {
    setBusy(true);
    try {
      await unblock(user.userId);
      toast.success(t("block.unblockDone", { name }));
    } catch (e: any) {
      toast.error(e?.message ?? t("block.unblockFailed"));
    } finally { setBusy(false); }
  }

  return (
    <>
      <div className="fixed inset-0 z-[60] flex items-end justify-center" onClick={onClose}>
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
        <div
          className="relative w-full max-w-[430px] md:max-w-lg icy-card rounded-t-3xl p-6 pb-10"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-5" />

          <div className="flex flex-col items-center gap-2 mb-6">
            <UserBadge user={user} size="lg" />
            <div className="flex items-center gap-1.5 mt-1">
              <p className="text-white text-base font-bold">{name}</p>
              {badges}
              {blocked && <UserTag>{t("user.blocked")}</UserTag>}
            </div>
            <p className="text-white/40 text-[11px]">@{user.username}</p>
          </div>

          <div className="flex flex-col gap-2">
            <button
              onClick={() => { onClose(); navigate(`/player/${user.userId}`); }}
              className="w-full py-3 rounded-2xl border border-white/10 text-white/80 text-sm"
            >
              {t("user.viewProfile")}
            </button>

            {/* Se bloquer soi-même est refusé par le serveur (400) : ne pas
                proposer un geste qui ne peut qu'échouer. */}
            {!isSelf && (
              blocked ? (
                <button
                  onClick={doUnblock}
                  disabled={busy}
                  className="w-full py-3 rounded-2xl bg-[#86d1ea] text-[#072E49] text-sm font-bold disabled:opacity-50"
                >
                  {t("blocked.unblock")}
                </button>
              ) : (
                <button
                  onClick={() => setConfirmBlock(true)}
                  disabled={busy}
                  className="w-full py-3 rounded-2xl border border-red-400/30 text-red-400 text-sm font-semibold disabled:opacity-50"
                >
                  🚫 {t("chat.blockUser")}
                </button>
              )
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmBlock}
        title={t("block.title", { name })}
        description={t("block.description")}
        confirmLabel={t("block.confirm")}
        onConfirm={doBlock}
        onCancel={() => setConfirmBlock(false)}
      />
    </>
  );
}
