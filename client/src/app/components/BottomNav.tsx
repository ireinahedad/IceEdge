import { useNavigate, useLocation } from "react-router";
import { useBet } from "../context/BetContext";
import { useAuth } from "../context/AuthContext";

const navItems = [
  { icon: "🏒", label: "Home",    path: "/" },
  { icon: "📊", label: "Stats",   path: "/stats" },
  { icon: "🎯", label: "Slip",    path: "/bet" },
  { icon: "🏆", label: "League",  path: "/league" },
  { icon: "👤", label: "Profile", path: "/profile" },
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
    <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[430px] bg-white/5 backdrop-blur-md border-t border-white/10 flex items-center justify-around px-2 py-3 z-50">
      {navItems.map((item) => {
        const active    = isActive(item.path);
        const showBadge = item.path === "/bet" && legs.length > 0;
        const isProfile = item.path === "/profile";

        return (
          <button
            key={item.label}
            onClick={() => navigate(item.path)}
            className={`flex flex-col items-center gap-0.5 px-3 py-1 rounded-xl transition-all relative ${
              active ? "opacity-100" : "opacity-50"
            }`}
          >
            <span className="text-xl relative">
              {/* Profile icon: show avatar thumbnail when logged in */}
              {isProfile && user?.avatar_url ? (
                <img
                  src={user.avatar_url}
                  alt="avatar"
                  className="w-6 h-6 rounded-full object-cover border border-white/20"
                />
              ) : (
                item.icon
              )}

              {showBadge && (
                <span className="absolute -top-1 -right-1 bg-[#86d1ea] text-[#0f1416] text-[9px] rounded-full w-4 h-4 flex items-center justify-center font-bold">
                  {legs.length}
                </span>
              )}

              {/* Dot indicator: profile has no account */}
              {isProfile && !user && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-[#86d1ea] rounded-full" />
              )}
            </span>

            <span className={`text-[9px] ${active ? "text-[#86d1ea]" : "text-[#bfc8cc]"}`}>
              {item.label}
            </span>

            {active && <span className="w-4 h-0.5 bg-[#86d1ea] rounded-full" />}
          </button>
        );
      })}
    </nav>
  );
}
