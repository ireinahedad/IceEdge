import { useNavigate, useLocation } from "react-router";
import { Home, BarChart2, Target, Trophy, User } from "lucide-react";
import { useBet } from "../context/BetContext";
import { useAuth } from "../context/AuthContext";
import { useI18n } from "../i18n";

const navItems = [
  { Icon: Home,      key: "nav.home",    path: "/" },
  { Icon: BarChart2, key: "nav.stats",   path: "/stats" },
  { Icon: Target,    key: "nav.slip",    path: "/bet" },
  { Icon: Trophy,    key: "nav.league",  path: "/league" },
  { Icon: User,      key: "nav.profile", path: "/profile" },
];

const ACCENT = "#86d1ea"; // ice blue — design system accent

/**
 * Couleur des onglets INACTIFS.
 *
 * Avant le 2026-09-11 : `#92A08A` porté par un conteneur en `opacity: 0.45`.
 * Sur le fond translucide de la barre (≈ `#343C3D` une fois le dégradé
 * composé sur le fond sombre de l'app), les 45 % ramenaient la couleur réelle
 * à ≈ `#5F6960` — soit **1,97:1**, quand WCAG AA demande 4,5:1 pour du texte
 * de 11 px. Quatre libellés de navigation sur cinq étaient donc illisibles,
 * et c'est le genre de chose qu'une revue d'accessibilité voit tout de suite.
 *
 * Deux changements, pas un : l'opacité disparaît (elle éteignait aussi
 * l'icône) et la couleur monte à `#A8B5A0`, ≈ **5,2:1** sur ce même fond. La
 * teinte sauge est conservée — c'est la valeur qui était fausse, pas le ton.
 *
 * ⚠️ Le contraste est calculé sur un fond ESTIMÉ : la barre est translucide,
 * donc son fond réel dépend de la page derrière. À vérifier à l'œil sur les
 * écrans les plus clairs.
 */
const INACTIVE = "#A8B5A0";

export function BottomNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const { legs } = useBet();
  const { user } = useAuth();
  const { t } = useI18n();

  const isActive = (path: string) => {
    if (path === "/") return location.pathname === "/";
    return location.pathname.startsWith(path);
  };

  // La barre est `fixed` : sans `env(safe-area-inset-bottom)` elle se pose à
  // 12 px du bas et chevauche l'indicateur d'accueil de l'iPhone (34 pt) —
  // les onglets deviennent durs à toucher et le geste d'accueil part à leur
  // place. L'inset s'AJOUTE à l'écart de 12 px, il ne le remplace pas.
  return (
    <nav
      className="fixed left-1/2 -translate-x-1/2 w-[94%] max-w-[420px] flex items-center justify-around px-2 py-2 z-50 rounded-[22px]"
      style={{
        bottom: "calc(0.75rem + env(safe-area-inset-bottom, 0px))",
        background:
          "linear-gradient(160deg, rgba(220,245,255,0.22), rgba(150,205,240,0.12) 45%, rgba(235,250,255,0.20))",
        backdropFilter: "blur(18px)",
        WebkitBackdropFilter: "blur(18px)",
        border: "1px solid rgba(255,255,255,0.45)",
        boxShadow:
          "inset 0 0 16px rgba(255,255,255,0.18), inset 0 -6px 14px rgba(140,200,235,0.14), 0 6px 20px rgba(0,0,0,0.18)",
      }}
    >
      {navItems.map(({ Icon, key, path }) => {
        const active    = isActive(path);
        const showBadge = path === "/bet" && legs.length > 0;
        const isProfile = path === "/profile";
        const label     = t(key);

        return (
          <button
            key={key}
            type="button"
            onClick={() => navigate(path)}
            // `aria-current="page"` : sans lui, un lecteur d'écran annonce cinq
            // onglets identiques et ne dit jamais où l'on se trouve. La couleur
            // et l'épaisseur du trait le disent à l'œil, à personne d'autre.
            aria-current={active ? "page" : undefined}
            className="flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-xl transition-all relative"
          >
            <div className="relative">
              {isProfile && user?.avatar_url ? (
                <img
                  src={user.avatar_url}
                  alt="avatar"
                  className="w-5 h-5 rounded-full object-cover"
                  // Le contour de l'avatar garde son `#283323` d'origine : il
                  // borde une photo, il ne porte aucun texte, et l'éclaircir
                  // dessinerait un anneau clair autour d'un onglet inactif.
                  style={{ border: `1.5px solid ${active ? ACCENT : "#283323"}` }}
                />
              ) : (
                <Icon
                  size={19}
                  strokeWidth={active ? 2.5 : 1.8}
                  color={active ? ACCENT : INACTIVE}
                />
              )}

              {showBadge && (
                <span
                  className="absolute -top-1.5 -right-1.5 text-[11px] rounded-full w-3.5 h-3.5 flex items-center justify-center font-bold"
                  style={{ background: ACCENT, color: "#0A0E0C" }}
                >
                  {legs.length}
                </span>
              )}

              {isProfile && !user && (
                <span
                  className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full"
                  style={{ background: ACCENT }}
                />
              )}
            </div>

            <span className="text-[11px]" style={{ color: active ? ACCENT : INACTIVE }}>
              {label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
