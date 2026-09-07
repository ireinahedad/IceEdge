/**
 * Doublure de `socket.io-client`.
 *
 * On garde exactement l'API que `useChatSocket` utilise, et on expose `fire()`
 * pour déclencher à la main les évènements que le vrai serveur enverrait :
 * `connect`, `disconnect`, `connect_error`, `room_error`.
 */
type H = (...a: any[]) => void;

export class FakeSocket {
  handlers: Record<string, H[]> = {};
  connected = false;
  emitted: any[] = [];
  connectCalls = 0;
  disconnectCalls = 0;
  on(ev: string, h: H) { (this.handlers[ev] ||= []).push(h); return this; }
  emit(ev: string, ...a: any[]) { this.emitted.push([ev, ...a]); return this; }
  connect() { this.connectCalls++; return this; }
  disconnect() { this.disconnectCalls++; this.connected = false; return this; }
  /** Déclenche un évènement comme le ferait le serveur. */
  fire(ev: string, ...a: any[]) { for (const h of this.handlers[ev] || []) h(...a); }
}

export const __sockets: FakeSocket[] = [];

export function io(_url: string, _opts: any) {
  const s = new FakeSocket();
  __sockets.push(s);
  (window as any).__sockets = __sockets;
  return s as any;
}

export type Socket = FakeSocket;
