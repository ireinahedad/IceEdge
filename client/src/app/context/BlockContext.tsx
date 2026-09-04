import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from "react";
import { profileApiService } from "../services/userService";
import { useAuth } from "./AuthContext";
import type { BlockedUser } from "../types/user";

/**
 * BlockContext — la liste des personnes que l'utilisateur a bloquées.
 * PRE_IOS_PLAN.md R4.3d.
 *
 * Deux écrans en ont besoin et ne se connaissent pas : le chat, qui masque les
 * messages, et les Paramètres, qui listent et débloquent. Un état partagé évite
 * qu'un déblocage fait dans les Paramètres laisse le chat afficher l'ancienne
 * liste jusqu'au prochain rechargement.
 *
 * ── Chargement paresseux, et c'est important ────────────────────────────────
 * Le provider ne demande RIEN au montage. Il enveloppe toute l'application, et
 * la grande majorité des visites ne touche jamais au chat ; charger d'office
 * ajouterait une requête à chaque ouverture de l'app pour rien, et une requête
 * 401 pour chaque visiteur déconnecté. `ensureLoaded()` est appelé par les
 * écrans concernés, et ne part qu'une fois.
 *
 * ── Pourquoi un Set d'identifiants en plus du tableau ───────────────────────
 * Le chat teste l'appartenance à chaque rendu, pour chacun des cent messages
 * affichés. `Array.some()` là-dedans est un balayage complet par message ; le
 * Set rend le test constant et le tableau reste pour l'affichage ordonné.
 */

interface BlockContextType {
  /** Les personnes bloquées, les plus récentes d'abord. Vide tant que non chargé. */
  blocked: BlockedUser[];
  /** Test d'appartenance à coût constant. `null` (auteur supprimé) n'est jamais bloqué. */
  isBlocked: (userId: string | null | undefined) => boolean;
  /** Charge la liste au premier appel, puis ne fait plus rien. */
  ensureLoaded: () => void;
  /** Recharge depuis le serveur, même si déjà chargée. */
  refresh: () => Promise<void>;
  block: (user: { id: string; username: string; displayName?: string; avatar?: string; avatarUrl?: string | null }) => Promise<void>;
  unblock: (userId: string) => Promise<void>;
  loading: boolean;
  error: string | null;
}

const BlockContext = createContext<BlockContextType | null>(null);

export function BlockProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [blocked, setBlocked] = useState<BlockedUser[]>([]);
  const [blockedIds, setBlockedIds] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Un ref, pas un state : `ensureLoaded` ne doit pas changer d'identité quand
  // la liste arrive, sinon les effets qui l'appellent se relancent en boucle.
  const requested = useRef(false);

  const apply = useCallback((list: BlockedUser[]) => {
    setBlocked(list);
    setBlockedIds(new Set(list.map((b) => b.id)));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      apply(await profileApiService.getBlockedUsers());
    } catch (e: any) {
      setError(e?.message ?? "blocked.loadFailed");
    } finally {
      setLoading(false);
    }
  }, [apply]);

  const ensureLoaded = useCallback(() => {
    if (requested.current || !user) return;
    requested.current = true;
    void load();
  }, [load, user]);

  const refresh = useCallback(async () => {
    if (!user) return;
    requested.current = true;
    await load();
  }, [load, user]);

  /**
   * Optimiste des deux côtés : le serveur est idempotent (R4.2e), donc rejouer
   * ou annuler ne casse rien, et l'écran ne doit pas attendre un aller-retour
   * pour faire disparaître quelqu'un qu'on vient de bloquer.
   */
  const block = useCallback<BlockContextType["block"]>(async (u) => {
    const optimistic: BlockedUser = {
      id: u.id,
      username: u.username,
      displayName: u.displayName ?? u.username,
      avatar: u.avatar ?? "👤",
      avatarUrl: u.avatarUrl ?? null,
      createdAt: new Date().toISOString(),
    };
    const previous = blocked;
    apply([optimistic, ...blocked.filter((b) => b.id !== u.id)]);
    try {
      await profileApiService.blockUser(u.id);
    } catch (e) {
      apply(previous);
      throw e;
    }
  }, [blocked, apply]);

  const unblock = useCallback(async (userId: string) => {
    const previous = blocked;
    apply(blocked.filter((b) => b.id !== userId));
    try {
      await profileApiService.unblockUser(userId);
    } catch (e) {
      apply(previous);
      throw e;
    }
  }, [blocked, apply]);

  const isBlocked = useCallback(
    (userId: string | null | undefined) => (userId ? blockedIds.has(userId) : false),
    [blockedIds],
  );

  return (
    <BlockContext.Provider value={{ blocked, isBlocked, ensureLoaded, refresh, block, unblock, loading, error }}>
      {children}
    </BlockContext.Provider>
  );
}

export function useBlocks() {
  const ctx = useContext(BlockContext);
  if (!ctx) throw new Error("useBlocks must be used within a BlockProvider");
  return ctx;
}
