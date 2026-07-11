import { useParams, useNavigate } from "react-router";
import { BottomNav } from "../../components/BottomNav";
import { useI18n } from "../../i18n";
import { RevealAllCtx, NotFound } from "./common";
import { TeamPrediction } from "./TeamPrediction";
import { GamePrediction } from "./GamePrediction";
import { PlayerPrediction } from "./PlayerPrediction";
import { TennisPlayerPrediction } from "./TennisPlayerPrediction";

/* ─── Main PredictionPage ──────────────────────────── */
export function PredictionPage() {
  const { type, id } = useParams<{ type: string; id: string }>();
  const navigate = useNavigate();
  const { t } = useI18n();

  const renderContent = () => {
    if (!type || !id) return <NotFound />;
    switch (type) {
      case "game":    return <GamePrediction gameId={id} />;
      case "team":    return <TeamPrediction teamId={id} />;
      case "player":  return <PlayerPrediction playerId={id} />;
      case "tennis":  return <TennisPlayerPrediction playerId={id} />;
      default:        return <NotFound />;
    }
  };

  return (
    <RevealAllCtx.Provider value={false}>
      <div className="flex flex-col min-h-screen pb-24" style={{ background: "#0A0E0C" }}>
        {/* Header */}
        <div className="sticky top-0 z-40 px-4 pt-12 pb-3"
          style={{ background: "rgba(10,14,12,0.92)", backdropFilter: "blur(16px)", borderBottom: "1px solid #283323" }}>
          <div className="flex items-center gap-3">
            <button onClick={() => navigate(-1)} className="text-[#3a5060] text-lg">←</button>
            <h1 className="text-white text-base font-bold flex-1">{t("pred.title")}</h1>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {renderContent()}
        </div>

        <BottomNav />
      </div>
    </RevealAllCtx.Provider>
  );
}
