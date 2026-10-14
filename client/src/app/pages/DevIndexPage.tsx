/**
 * DevIndexPage — le sommaire des écrans de développement.
 * Route : /dev   (admin uniquement, comme /dev/ml et /dev/moderation)
 *
 * Les outils internes n'ont aucune entrée dans la navigation : ils vivent hors
 * de BottomNav exprès, pour ne pas exister pour un utilisateur normal. Le prix,
 * c'est qu'il fallait taper l'URL exacte de mémoire. Cette page est le seul
 * point d'entrée à retenir ; les écrans restent, eux, invisibles.
 *
 * Volontairement sans appel réseau : c'est un index, pas un tableau de bord.
 * Une panne d'API ne doit pas empêcher d'atteindre les outils qui servent à la
 * diagnostiquer.
 *
 * ⚠️ Comme les deux écrans qu'elle liste, cette page est reliée dans
 * routes.tsx par une liaison CONDITIONNELLE (`features.devRoutes ? lazy(...)
 * : null`) : un `lazy()` nu enverrait son chunk dans le bundle iOS même sans
 * route enregistrée.
 */

import { useEffect } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "../context/AuthContext";

import { FileText, Shield, BarChart3, DollarSign, ScanText, type LucideIcon } from "lucide-react";
/** Les écrans internes, dans l'ordre où on les ouvre le plus souvent. */
const DEV_LINKS: { path: string; title: string; blurb: string; icon: LucideIcon }[] = [
  {
    path:  "/dev/saisie",
    title: "Saisie d'avant-match",
    blurb: "Gardiens partants et joueurs absents, match par match. À faire 1 à 2 h avant le match.",
    icon:  FileText,
  },
  {
    path:  "/dev/profit",
    title: "Profit des Best Bets",
    blurb: "Profit si tu mises 20 $ (ou autre) sur chaque best bet du jour. Bilan, ROI, détail par jour.",
    icon:  DollarSign,
  },
  {
    path:  "/dev/ocr",
    title: "Labo OCR",
    blurb: "Lire des captures de tickets sur l'appareil (Tesseract ici, Vision dans l'app iOS de test) et exporter le JSON des fixtures.",
    icon:  ScanText,
  },
  {
    path:  "/dev/moderation",
    title: "Moderation queue",
    blurb: "Signalements de chat ouverts, groupés par message. Masquer ou rejeter.",
    icon:  Shield,
  },
  {
    path:  "/dev/ml",
    title: "ML dashboard",
    blurb: "Modèles, calibration, facteurs et suivi des prédictions.",
    icon:  BarChart3,
  },
];

export function DevIndexPage() {
  const navigate = useNavigate();
  const { user, loading } = useAuth();

  // Même courtoisie que sur les deux écrans qu'elle liste : le serveur refuse
  // déjà tout non-admin (403), ce renvoi évite juste une page vide à qui
  // arriverait là par un lien.
  useEffect(() => {
    if (!loading && user && user.role !== "admin") navigate("/", { replace: true });
  }, [loading, user, navigate]);

  return (
    <div
      className="flex flex-col min-h-screen text-white max-w-[900px] mx-auto px-5 pt-14 pb-16"
      style={{ background: "#0A0E0C" }}
    >
      <div className="flex items-center gap-3 mb-2">
        <button onClick={() => navigate(-1)} className="tap-44 text-[#bfc8cc] text-lg">←</button>
        <h1 className="text-white text-base font-bold flex-1">Dev tools</h1>
      </div>
      <p className="text-white/40 text-[10px] mb-6">
        Écrans internes, admin uniquement. Ils ne sont dans aucun menu et n'existent pas dans le
        build iOS.
      </p>

      <div className="flex flex-col gap-3">
        {DEV_LINKS.map(({ path, title, blurb, icon: Icon }) => (
          <button
            key={path}
            onClick={() => navigate(path)}
            className="icy-card rounded-2xl p-4 flex items-center gap-3.5 text-left active:scale-[0.99] transition-transform"
          >
            <Icon size={22} className="text-[#86d1ea] flex-shrink-0" aria-hidden />
            <span className="flex-1 min-w-0">
              <span className="block text-white text-xs font-bold">{title}</span>
              <span className="block text-white/45 text-[10px] mt-0.5 leading-relaxed">{blurb}</span>
              <span className="block text-[#86d1ea]/70 text-[9px] font-mono mt-1">{path}</span>
            </span>
            <span className="text-[#bfc8cc] text-lg" aria-hidden>→</span>
          </button>
        ))}
      </div>
    </div>
  );
}
