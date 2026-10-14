/** Le `<Toaster>` de sonner, dans son propre chunk — voir `toast.tsx`. */
import { useEffect } from "react";
import { Toaster, toast as sonner } from "sonner";
import { attachToaster } from "./toast";

export default function ToasterHost() {
  // L'effet du parent passe APRÈS celui du <Toaster> enfant (qui s'abonne) :
  // les toasts en file sont donc bien affichés.
  useEffect(() => attachToaster(({ kind, args }) => (sonner[kind] as (...a: unknown[]) => unknown)(...args)), []);
  return (
    <Toaster
      theme="dark"
      richColors
      position="top-center"
      toastOptions={{
        style: {
          background: "#131A12",
          border: "1px solid #283323",
          color: "white",
        },
      }}
    />
  );
}
