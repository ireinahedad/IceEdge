import { useNavigate } from "react-router";
import { IceedgeLogo } from "../components/brand/IceedgeLogo";
import { useI18n } from "../i18n";

/**
 * 404 — catch-all route. Any URL that doesn't match a known route lands here
 * instead of the raw React Router error screen, so a broken/shared link
 * never dead-ends the user.
 */
export function NotFoundPage() {
  const navigate = useNavigate();
  const { t } = useI18n();

  return (
    <div className="flex flex-col items-center justify-center min-h-screen text-white max-w-[430px] mx-auto px-6 text-center"
      style={{ background: "#0A0E0C" }}>
      <button onClick={() => navigate("/")} aria-label="Accueil ArakIce" className="mb-6">
        <IceedgeLogo size={56} wordmark={false} />
      </button>
      <p className="text-5xl font-bold mb-2" style={{ color: "#86d1ea" }}>404</p>
      <p className="text-white font-bold text-lg mb-2">{t("notFound.title")}</p>
      <p className="text-[#92A08A] text-sm mb-8">{t("notFound.body")}</p>
      <button
        onClick={() => navigate("/")}
        className="px-6 py-2.5 rounded-xl text-sm font-bold"
        style={{ background: "#86d1ea", color: "#0A0E0C" }}
      >
        {t("share.goHome")}
      </button>
    </div>
  );
}
