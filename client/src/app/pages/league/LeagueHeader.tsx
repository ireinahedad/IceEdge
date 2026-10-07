// components/league/LeagueHeader.tsx

import { useSport } from "../../context/SportContext";
import { useI18n } from "../../i18n";
import "../../components/rink-theme.css";
import "./league-theme.css";

type Tab = "leaderboard" | "chat";

export function LeagueHeader({
  tab,
  setTab,
  totalUnread = 0,
}: {
  tab: Tab;
  setTab: (tab: Tab) => void;
  totalUnread?: number;
}) {
  const { theme } = useSport();
  const { t, lang } = useI18n();
  const accent = theme.accent;

  const tabs = [
    { key: "chat",        label: lang === "fr" ? "Chat" : "Chat" },
    { key: "leaderboard", label: t("league.rankings") },
  ];

  return (
    /* Même verre dépoli que la page Coupon (`.rink-header-glass`) : les
       gradins transparaissent derrière le titre et les onglets, ce qui pose
       le bandeau DANS le bol au lieu de le faire flotter sur une barre. */
    <header
      className="rink-header-glass sticky top-0 z-40"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
    >
      <div className="px-4 pt-3 pb-3 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1
              className="text-white text-xl font-bold uppercase"
              style={{
                fontFamily: "'Oswald', 'Oswald Fallback', 'Arial Narrow', sans-serif",
                // Les projecteurs de l'aréna accrochent le titre.
                textShadow: "0 0 18px rgba(134,209,234,0.35)",
              }}
            >
              {t("nav.league")}
            </h1>
            {/* Sport badge */}
            {[theme.sportIcon, theme.sportLabel].filter(Boolean).length > 0 && (
              <span
                className="text-[11px] px-2 py-0.5 rounded-full font-medium"
                style={{ backgroundColor: `${accent}1a`, color: accent }}
              >
                {[theme.sportIcon, theme.sportLabel].filter(Boolean).join(" ")}
              </span>
            )}
          </div>
          <p className="text-white/50 text-xs">{lang === "fr" ? "Classement et chat" : "Rankings & community"}</p>
        </div>
      </div>

      {/* Même commutateur que la page Coupon : la rondelle patine d'un onglet
          à l'autre (`.puck-tabs`, rink-theme.css). Le caisson de tableau
          indicateur qui tenait ce rôle est parti d'ici — il reste le format du
          classement, où il a la place d'être un vrai jumbotron. */}
      <div
        className="puck-tabs mx-4 mb-4"
        style={{ "--puck-count": tabs.length, "--puck-index": tab === "chat" ? 0 : 1 } as React.CSSProperties}
      >
        <span className="puck-tabs-thumb" aria-hidden />
        {tabs.map((tb) => (
          <button
            key={tb.key}
            onClick={() => setTab(tb.key as Tab)}
            className={`puck-tab${tab === tb.key ? " is-active" : ""}`}
            aria-pressed={tab === tb.key}
          >
            <span>{tb.label}</span>
            {tb.key === "chat" && totalUnread > 0 && tab !== "chat" && (
              <span className="absolute top-0 right-1 bg-red-500 text-white text-[11px] font-bold w-3.5 h-3.5 rounded-full flex items-center justify-center">
                {totalUnread > 9 ? "9+" : totalUnread}
              </span>
            )}
          </button>
        ))}
      </div>
    </header>
  );
}
