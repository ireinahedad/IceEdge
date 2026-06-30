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
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import { io as socketIO, Socket } from 'socket.io-client';
import type { ChatMessage } from '../types/user';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001';

export function useChatSocket(roomId: string | null) {
  const socketRef = useRef<Socket | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [onlineCount, setOnlineCount] = useState(0);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!roomId) return;

    const socket = socketIO(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      path: '/socket.io',
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      socket.emit('join_room', roomId);
    });

    socket.on('disconnect', () => setConnected(false));

    socket.on('new_message', (msg: ChatMessage) => {
      setMessages((prev) => {
        // Ignore if already present (own optimistic or duplicate)
        if (prev.some((m) => m.id === msg.id)) return prev;
        return [...prev, msg];
      });
    });

    socket.on('room_users', (count: number) => setOnlineCount(count));

    return () => {
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

  /** Optimistically add own message before the server confirms */
  const appendOptimistic = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  /** Replace a temp optimistic message with the confirmed server version */
  const confirmMessage = useCallback((tempId: string, confirmed: ChatMessage) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === tempId ? confirmed : m))
    );
  }, []);

  return { messages, onlineCount, connected, initMessages, appendOptimistic, confirmMessage };
}
