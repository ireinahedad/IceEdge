/**
 * useChatSocket — real-time chat via Socket.io
 *
 * Usage:
 *   const { messages, onlineCount, connected, initMessages, appendOptimistic, confirmMessage } =
 *     useChatSocket(roomId);
 *
 * Flow:
 *   1. On mount, caller fetches HTTP history and calls initMessages(msgs)
 *   2. Socket emits 'new_message' → deduped and appended automatically
 *   3. For own sends: appendOptimistic(msg) immediately, then confirmMessage(tempId, serverMsg)
 *
 * Survivre à un passage en arrière-plan (audit pré-freeze iOS)
 * ───────────────────────────────────────────────────────────
 * Trois trous se cumulaient, tous visibles dès le premier verrouillage d'écran :
 *
 *   a. `connect` ne faisait que `join_room`. Ce qui est arrivé pendant la
 *      coupure n'est diffusé qu'aux sockets vivantes : c'était **perdu
 *      définitivement**, un trou silencieux dans la conversation. D'où
 *      `resyncKey`, que la page surveille pour redemander l'historique.
 *   b. Aucun écouteur `connect_error`. Le jeton d'accès expire en 15 min, le
 *      serveur refuse alors le handshake et socket.io réessayait en boucle
 *      avec le même jeton mort — chat mort, un point gris pour tout signe.
 *   c. `room_error` était émis par le serveur et écouté par personne.
 *
 * Et `visibilitychange`, qui n'est dans aucun des trois : iOS gèle la
 * WKWebView, la socket peut se croire vivante au réveil et son ping met une
 * vingtaine de secondes à découvrir qu'elle est morte.
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { io as socketIO, Socket } from 'socket.io-client';
import type { ChatMessage } from '../types/user';
import { tokenStore } from '../services/tokenStore';
import { refreshSession } from '../services/authService';
import { env } from '../env';

const SOCKET_URL = env.socketUrl;

export function useChatSocket(roomId: string | null) {
  const socketRef = useRef<Socket | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [onlineCount, setOnlineCount] = useState(0);
  const [connected, setConnected] = useState(false);
  /** Monte de 1 à chaque fois que l'historique doit être redemandé. */
  const [resyncKey, setResyncKey] = useState(0);
  /** La session est morte : le refresh a échoué après un handshake refusé. */
  const [authError, setAuthError] = useState(false);
  /** Message brut d'un `room_error` du serveur ('Access denied', …). */
  const [roomError, setRoomError] = useState<string | null>(null);

  // Changer de salon remet le compteur à zéro AVANT que la page ne lise sa
  // valeur : sinon son effet croirait revenir d'une coupure et **fusionnerait
  // l'historique du nouveau salon dans les messages de l'ancien**. Ajuster
  // l'état pendant le rendu est le patron prévu pour ça — React rejette ce
  // rendu et recommence avant de lancer le moindre effet.
  const [lastRoomId, setLastRoomId] = useState(roomId);
  if (lastRoomId !== roomId) {
    setLastRoomId(roomId);
    setResyncKey(0);
    setAuthError(false);
    setRoomError(null);
  }

  useEffect(() => {
    if (!roomId) return;

    // Portées à l'effet, pas au composant : elles doivent repartir de zéro
    // avec chaque socket.
    let cancelled = false;
    let hasConnectedOnce = false;
    let refreshTried = false;

    const socket = socketIO(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      path: '/socket.io',
      // Callback form, not a literal: reading the token is async since R3.6.
      // Socket.io calls this before each (re)connection, so a token refreshed
      // in the meantime is picked up instead of the one captured at mount.
      auth: (cb: (data: object) => void) => {
        tokenStore.getAccess().then((token) => cb({ token: token ?? '' }));
      },
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      setAuthError(false);
      refreshTried = false;          // la prochaine expiration aura droit à son refresh
      socket.emit('join_room', roomId);

      // La PREMIÈRE connexion n'a rien à resynchroniser : la page est déjà en
      // train de charger l'historique. Les suivantes sont des RE-connexions.
      if (hasConnectedOnce) setResyncKey((n) => n + 1);
      hasConnectedOnce = true;
    });

    socket.on('disconnect', () => setConnected(false));

    /**
     * Handshake refusé. Le serveur répond 'Invalid or expired token' ou
     * 'Authentication required' (`socket.ts`) ; tout le reste est une panne
     * réseau, que socket.io retente très bien tout seul.
     *
     * Une seule tentative de refresh par cycle : `refreshTried` n'est remis à
     * false que par un `connect` réussi. Sans ce garde, chaque tentative de
     * reconnexion relancerait une rotation de jeton — une tempête de refresh
     * sur un réseau qui va mal.
     */
    socket.on('connect_error', async (err: Error) => {
      setConnected(false);
      if (!/token|auth/i.test(String(err?.message ?? ''))) return;
      if (refreshTried) { setAuthError(true); return; }
      refreshTried = true;
      const ok = await refreshSession();
      if (cancelled) return;
      if (ok) socket.connect();      // le callback `auth` relira le jeton neuf
      else setAuthError(true);
    });

    // Émis par le serveur quand `join_room` est refusé. Personne ne l'écoutait :
    // l'utilisateur restait dans un salon qui ne recevait rien, sans un mot.
    socket.on('room_error', ({ error }: { roomId: string; error: string }) => {
      setRoomError(error);
    });

    socket.on('new_message', (msg: ChatMessage) => {
      setMessages((prev) => {
        // Ignore if already present (own optimistic or duplicate)
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
    });

    socket.on('message_deleted', ({ messageId }: { messageId: string }) => {
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
    });

    socket.on('room_users', (count: number) => setOnlineCount(count));

    /**
     * Retour au premier plan. iOS gèle la WKWebView : au réveil la socket peut
     * se croire connectée alors que la connexion est morte, et le ping de
     * socket.io met une vingtaine de secondes à s'en apercevoir. On ne l'attend
     * pas — on relance la socket si elle est tombée, et on redemande
     * l'historique tout de suite.
     */
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (!socket.connected) socket.connect();
      setResyncKey((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      socket.emit('leave_room', roomId);
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [roomId]);

  /** Seed the initial HTTP history */
  const initMessages = useCallback((msgs: ChatMessage[]) => {
    setMessages(msgs);
  }, []);

  /**
   * Fusionner un historique fraîchement rechargé avec ce qui est déjà à
   * l'écran — c'est ce qu'il faut après une coupure, jamais `initMessages`.
   *
   * Écraser perdrait deux choses : les messages optimistes encore en vol, et
   * tout ce qui est plus ancien que la fenêtre que renvoie l'API. Le serveur
   * fait foi sur les identifiants qu'il renvoie ; le tri se fait sur `sentAt`
   * parce que l'ordre d'arrivée d'une reconnexion ne veut plus rien dire.
   *
   * ⚠️ Connu et assumé : un message supprimé pendant l'absence n'est pas dans
   * l'historique rechargé, donc la fusion le laisse affiché jusqu'au prochain
   * `message_deleted` ou au prochain montage. C'est le prix de ne rien perdre.
   */
  const mergeMessages = useCallback((msgs: ChatMessage[]) => {
    setMessages((prev) => {
      const byId = new Map(prev.map((m) => [m.id, m]));
      for (const m of msgs) byId.set(m.id, m);
      return [...byId.values()].sort(
        (a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime(),
      );
    });
  }, []);

  /** Optimistically add own message before the server confirms */
  const appendOptimistic = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  /** Replace the optimistic message with the confirmed server version.
   *  Also removes any socket-delivered copy that may have arrived first
   *  (race: socket fires before the HTTP await resolves → double message). */
  const confirmMessage = useCallback((tempId: string, confirmed: ChatMessage) => {
    setMessages((prev) =>
      prev
        .filter((m) => m.id !== confirmed.id && m.id !== tempId).concat(confirmed)
    );
  }, []);

  /** Remove a message locally (optimistic delete before/without the socket event). */
  const removeMessage = useCallback((messageId: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
  }, []);

  return {
    messages, onlineCount, connected,
    initMessages, mergeMessages, appendOptimistic, confirmMessage, removeMessage,
    resyncKey, authError, roomError,
  };
}
