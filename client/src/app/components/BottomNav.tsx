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

const ACCENT = "#9BF019"; // acid green — design system

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

  return (
    <nav
      className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] flex items-center justify-around px-2 py-2 z-50"
      style={{
        background: "rgba(10,14,12,0.95)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
        borderTop: "1px solid #283323",
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
            onClick={() => navigate(path)}
            className="flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-xl transition-all relative"
            style={{ opacity: active ? 1 : 0.45 }}
          >
            <div className="relative">
              {isProfile && user?.avatar_url ? (
                <img
                  src={user.avatar_url}
                  alt="avatar"
                  className="w-5 h-5 rounded-full object-cover"
                  style={{ border: `1.5px solid ${active ? ACCENT : "#283323"}` }}
                />
              ) : (
                <Icon
                  size={19}
                  strokeWidth={active ? 2.5 : 1.8}
                  color={active ? ACCENT : "#92A08A"}
                />
              )}

              {showBadge && (
                <span
                  className="absolute -top-1.5 -right-1.5 text-[8px] rounded-full w-3.5 h-3.5 flex items-center justify-center font-bold"
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

            <span className="text-[9px]" style={{ color: active ? ACCENT : "#92A08A" }}>
              {label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
