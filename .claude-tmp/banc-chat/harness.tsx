/**
 * Le composant harnais : il monte le VRAI `useChatSocket` et pose son retour
 * sur `window` pour que le test puisse le lire et l'appeler.
 * Le chemin du hook est réécrit par build.mjs (variable CLIENT).
 */
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
// @ts-ignore — chemin réécrit à la construction
import { useChatSocket } from '__HOOK__';

function App() {
  const [roomId, setRoomId] = useState<string | null>('salon-A');
  const h = useChatSocket(roomId);
  (window as any).__hook = h;
  (window as any).__setRoom = setRoomId;
  return <pre id="etat">{JSON.stringify({
    resyncKey: h.resyncKey, authError: h.authError, roomError: h.roomError,
    connected: h.connected, ids: h.messages.map((m: any) => m.id),
  })}</pre>;
}

createRoot(document.getElementById('root')!).render(<App />);
