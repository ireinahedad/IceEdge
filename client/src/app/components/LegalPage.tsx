import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { IceedgeLogo } from "./brand/IceedgeLogo";

/**
 * Coquille commune des pages Confidentialité, Conditions et Support :
 * colonne étroite, retour, logo vers l'accueil, titre.
 */
export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <div className="flex flex-col min-h-screen text-white max-w-[430px] mx-auto px-5 pt-14 pb-16" style={{ background: "#0A0E0C" }}>
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate(-1)} className="tap-44 text-[#bfc8cc] text-lg">←</button>
        <button onClick={() => navigate("/")} aria-label="Accueil ArakIce"><IceedgeLogo size={28} wordmark={false} /></button>
        <h1 className="text-white text-base font-bold flex-1">{title}</h1>
      </div>
      {children}
    </div>
  );
}

/** Document juridique : date de mise à jour puis sections titre + texte. */
export function LegalDocument({
  title,
  content,
}: {
  title: string;
  content: { updated: string; sections: { h: string; b: string }[] };
}) {
  return (
    <LegalPage title={title}>
      <p className="text-[#8a9ea6] text-xs mb-6">{content.updated}</p>
      <div className="flex flex-col gap-5">
        {content.sections.map((s, i) => (
          <div key={i}>
            <p className="text-white text-sm font-semibold mb-1.5">{s.h}</p>
            <p className="text-[#bfc8cc] text-xs leading-relaxed">{s.b}</p>
          </div>
        ))}
      </div>
    </LegalPage>
  );
}
