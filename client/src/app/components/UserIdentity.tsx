import type { ReactNode } from "react";

import { User as UserIcon } from "lucide-react";
/**
 * UserIdentity — la façon dont un compte s'affiche, partout.
 *
 * Avant, chaque écran redessinait la même chose à sa manière : la liste des
 * membres, la liste des utilisateurs bloqués et la bulle de chat avaient chacune
 * leur cercle d'avatar, leur taille de nom et leur `@pseudo`. Trois variantes de
 * la même information, qui divergeaient à chaque retouche.
 *
 * Deux briques ici, et rien d'autre :
 *   • `UserBadge`  — l'avatar seul, rond, avec le repli sur l'emoji.
 *   • `UserRow`    — avatar + nom affiché + `@pseudo`, avec un emplacement pour
 *                    des pastilles (admin, « toi ») et un pour des actions.
 *
 * `UserRow` ne décide pas de ce qui l'entoure : pas de fond, pas de bordure. Une
 * liste met la sienne. C'est ce qui lui permet de servir aussi bien dans une
 * feuille modale que dans une carte de réglages.
 */

type Size = "sm" | "md" | "lg";

const AVATAR: Record<Size, string> = {
  sm: "w-7 h-7 text-sm",
  md: "w-9 h-9 text-lg",
  lg: "w-16 h-16 text-3xl",
};

export interface UserIdentityData {
  userId: string;
  username: string;
  displayName: string;
  avatar?: string;
  avatarUrl?: string | null;
}

export function UserBadge({ user, size = "md" }: { user: UserIdentityData; size?: Size }) {
  return (
    <div
      className={`${AVATAR[size]} rounded-full bg-white/10 border border-white/15 flex items-center justify-center overflow-hidden flex-shrink-0`}
    >
      {user.avatarUrl
        ? <img src={user.avatarUrl} alt="" className="w-full h-full object-cover rounded-full" />
        : (user.avatar && user.avatar !== "👤" ? user.avatar : <UserIcon size={16} className="text-white/60" />)}
    </div>
  );
}

export function UserRow({
  user,
  size = "md",
  badges,
  actions,
  onClick,
}: {
  user: UserIdentityData;
  size?: Size;
  /** Pastilles à droite du nom : admin, « toi »… */
  badges?: ReactNode;
  /** Boutons alignés à droite. Leur clic ne déclenche pas `onClick`. */
  actions?: ReactNode;
  onClick?: () => void;
}) {
  const body = (
    <>
      <UserBadge user={user} size={size} />
      <div className="flex-1 min-w-0 text-left">
        <div className="flex items-center gap-1.5">
          <p className="text-white text-xs font-medium truncate">{user.displayName || user.username}</p>
          {badges}
        </div>
        <p className="text-white/40 text-[11px] truncate">@{user.username}</p>
      </div>
    </>
  );

  return (
    <div className="flex items-center gap-3 min-w-0">
      {onClick ? (
        // Un vrai bouton : atteignable au clavier et annoncé comme actionnable,
        // ce qu'un <div onClick> n'est pas.
        <button onClick={onClick} className="flex items-center gap-3 flex-1 min-w-0 active:opacity-70 transition-opacity">
          {body}
        </button>
      ) : (
        <div className="flex items-center gap-3 flex-1 min-w-0">{body}</div>
      )}
      {actions && <div className="flex gap-1.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>{actions}</div>}
    </div>
  );
}

/** Pastille de rôle / statut, au format unique du produit. */
export function UserTag({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" }) {
  return (
    <span
      className={`text-[11px] rounded-full px-1.5 py-0.5 flex-shrink-0 border ${
        tone === "accent"
          ? "text-[#90C9F0] border-[#90C9F0]/40"
          : "text-white/40 border-white/20"
      }`}
    >
      {children}
    </span>
  );
}
