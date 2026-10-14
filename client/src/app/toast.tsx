/**
 * toast.tsx — notifications (sonner) chargées à la demande.
 *
 * QA P4 (LCP mobile, 2026-10-13) : sonner pesait ~33 ko dans le bundle principal
 * alors qu'aucun toast ne s'affiche au premier rendu. Toute l'app importe
 * `toast` d'ICI (même API que sonner pour ce qu'on en utilise : success, error,
 * info, warning) ; sonner et le `<Toaster>` (`ToasterHost.tsx`) arrivent dans un
 * chunk à part, préchargé quand le navigateur est inactif, ou au premier toast.
 *
 * Un toast émis avant que le `<Toaster>` soit monté serait perdu (sonner ne
 * rejoue pas l'historique à l'abonnement) : les appels sont mis en file et
 * rejoués par `ToasterHost` une fois monté.
 */
import { lazy, Suspense, useEffect, useState } from "react";

type Kind = "success" | "error" | "info" | "warning";
type Call = { kind: Kind; args: unknown[] };

const queue: Call[] = [];
let deliver: ((c: Call) => void) | null = null;
const listeners = new Set<() => void>();
let wanted = false;

function want() {
  if (wanted) return;
  wanted = true;
  listeners.forEach((l) => l());
}

function push(kind: Kind) {
  return (...args: unknown[]) => {
    const call = { kind, args };
    if (deliver) deliver(call);
    else { queue.push(call); want(); }
  };
}

export const toast = {
  success: push("success"),
  error: push("error"),
  info: push("info"),
  warning: push("warning"),
};

/** Appelé par `ToasterHost` une fois sonner chargé et le `<Toaster>` monté. */
export function attachToaster(fn: (c: Call) => void): () => void {
  deliver = fn;
  queue.splice(0).forEach(fn);
  return () => { if (deliver === fn) deliver = null; };
}

const ToasterHost = lazy(() => import("./ToasterHost"));

/** À poser une fois, à la place de `<Toaster>` (App.tsx). */
export function LazyToaster() {
  const [mount, setMount] = useState(wanted);
  useEffect(() => {
    const on = () => setMount(true);
    listeners.add(on);
    if (wanted) on();
    // Préchargement quand le navigateur n'a plus rien à faire : le premier vrai
    // toast s'affiche alors sans attendre le réseau.
    const w = window as any;
    const id = w.requestIdleCallback ? w.requestIdleCallback(want, { timeout: 5000 }) : window.setTimeout(want, 3000);
    return () => {
      listeners.delete(on);
      if (w.cancelIdleCallback && w.requestIdleCallback) w.cancelIdleCallback(id); else window.clearTimeout(id);
    };
  }, []);
  return mount ? <Suspense fallback={null}><ToasterHost /></Suspense> : null;
}
