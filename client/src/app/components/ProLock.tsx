import { ReactNode } from "react";
import { useNavigate } from "react-router";
import { useI18n } from "../i18n";

const ACCENT = "#86d1ea";

/**
 * Wraps Pro-only content. When `locked` is true the children are blurred and a
 * lock overlay explains the feature and links to the upgrade page. When false
 * the children render normally.
 */
export function ProLock({
  locked,
  title,
  description,
  children,
}: {
  locked: boolean;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const { t } = useI18n();

  if (!locked) return <>{children}</>;

  return (
    <div className="relative overflow-hidden rounded-2xl">
      {/* Blurred, non-interactive preview */}
      <div
        className="pointer-events-none select-none"
        style={{ filter: "blur(6px)", opacity: 0.5 }}
        aria-hidden
      >
        {children}
      </div>

      {/* Lock overlay */}
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-6"
        style={{ background: "rgba(10,14,12,0.6)" }}>
        <div className="text-white text-sm font-bold mb-1">🔒 {title}</div>
        <div className="text-[#B7C4AD] text-xs mb-3 max-w-[300px]">{description}</div>
        <button
          onClick={() => navigate("/pro")}
          className="px-4 py-2 rounded-xl text-xs font-bold active:scale-[0.98] transition-all"
          style={{ background: ACCENT, color: "#0A0E0C" }}
        >
          {t("pro.unlock")}
        </button>
      </div>
    </div>
  );
}
