import { useNavigate, useLocation } from "react-router";
import { Home, BarChart2, Target, Trophy, User } from "lucide-react";
import { useBet } from "../context/BetContext";
import { useAuth } from "../context/AuthContext";

const navItems = [
  { Icon: Home,     label: "Home",    path: "/" },
  { Icon: BarChart2,label: "Stats",   path: "/stats" },
  { Icon: Target,   label: "Slip",    path: "/bet" },
  { Icon: Trophy,   label: "League",  path: "/league" },
  { Icon: User,     label: "Profile", path: "/profile" },
];

export function BottomNav() {
  const navigate  = useNavigate();
  const location  = useLocation();
  const { legs }  = useBet();
  const { user }  = useAuth();

  const isActive = (path: string) => {
    if (path === "/") return location.pathname === "/";
    return location.pathname.startsWith(path);
  };

  return (
    <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] bg-[#0a1014]/90 backdrop-blur-md border-t border-white/10 flex items-center justify-around px-2 py-2.5 z-50">
      {navItems.map(({ Icon, label, path }) => {
        const active    = isActive(path);
        const showBadge = path === "/bet" && legs.length > 0;
        const isProfile = path === "/profile";

        return (
          <button
            key={label}
            onClick={() => navigate(path)}
            className={`flex flex-col items-center gap-1 px-3 py-1 rounded-xl transition-all relative ${
              active ? "opacity-100" : "opacity-40"
            }`}
          >
            <div className="relative">
              {isProfile && user?.avatar_url ? (
                <img
                  src={user.avatar_url}
                  alt="avatar"
                  className="w-5 h-5 rounded-full object-cover border border-white/20"
                />
              ) : (
                <Icon
                  size={18}
                  strokeWidth={active ? 2.5 : 1.8}
                  className={active ? "text-[#86d1ea]" : "text-[#8a9ea6]"}
                />
              )}

              {showBadge && (
                <span className="absolute -top-1.5 -right-1.5 bg-[#86d1ea] text-[#0a1014] text-[8px] rounded-full w-3.5 h-3.5 flex items-center justify-center font-bold">
                  {legs.length}
                </span>
              )}

              {isProfile && !user && (
                <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 bg-[#86d1ea] rounded-full" />
              )}
            </div>

            <span className={`text-[9px] font-medium ${active ? "text-[#86d1ea]" : "text-[#4a6068]"}`}>
              {label}
            </span>

            {active && <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-3 h-0.5 bg-[#86d1ea] rounded-full" />}
          </button>
        );
      })}
    </nav>
  );
}
