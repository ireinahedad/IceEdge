/**
 * PredictionPage.tsx — coquille de la page Prédiction.
 *
 * Ce fichier faisait 2367 lignes ; il a été découpé le 2026-08-10 en 10 fichiers
 * (`./prediction/`) sans toucher une ligne de code — seuls les imports et les
 * `export` ont été ajoutés. Il ne reste ici que l'aiguillage par type de sujet.
 *
 *   predictionShared.tsx   jauge, barres de raison, forme récente, H2H,
 *                          PredictionLayout, BetRec, NotFound, RevealModeCtx
 *   gameMarkets.tsx        types de marché, construction des groupes, contexte LLM
 *   PredictionSheet.tsx    fiche de marché, BetOption, MarketGroup, alignements
 *   TeamPrediction · GamePrediction · PlayerPrediction ·
 *   NGamesPrediction · PlayerPropPrediction
 *
 * `PredictionPage` reste le seul export public : `routes.tsx` est inchangé.
 */

import { useParams, useNavigate } from "react-router";
import { BottomNav } from "../components/BottomNav";
import { useSport } from "../context/SportContext";
import "../components/rink-theme.css";
import { useI18n } from "../i18n";
import { FramedLabel } from "../components/brand/FramedLabel";
import { GamePrediction } from "./prediction/GamePrediction";
import { PlayerPrediction } from "./prediction/PlayerPrediction";
import { TeamPrediction } from "./prediction/TeamPrediction";
import { NotFound, RevealModeCtx } from "./prediction/predictionShared";


export function PredictionPage() {
  const { type, id } = useParams<{ type: string; id: string }>();
  const navigate = useNavigate();
  const { theme } = useSport();
  const { t } = useI18n();
  const accent = theme.accent;

  const renderContent = () => {
    if (!type || !id) return <NotFound />;
    switch (type) {
      case "game":    return <GamePrediction gameId={id} />;
      case "team":    return <TeamPrediction teamId={id} />;
      case "player":  return <PlayerPrediction playerId={id} />;
      default:        return <NotFound />;
    }
  };

  return (
    <RevealModeCtx.Provider value="rules">
      <div className="flex flex-col min-h-screen pb-24 max-w-[430px] md:max-w-5xl mx-auto w-full" style={{ background: "#0A0E0C" }}>
        {/* Header */}
        <div className="sticky top-0 z-40"
          style={{ background: "rgba(10,14,12,0.92)", backdropFilter: "blur(16px)", paddingTop: "env(safe-area-inset-top, 0px)" }}>
          <div className="rink-boards" aria-hidden />
          <div className="px-4 pt-3 pb-3 flex items-center gap-3">
            <button onClick={() => navigate(-1)} className="text-[#3a5060] text-lg">←</button>
            <h1 className="text-white text-base font-bold flex-1 uppercase" style={{ fontFamily: "'Oswald', 'Arial Narrow', sans-serif" }}>{t("pred.title")}</h1>
            {/* Le raccourci vers les graphiques vaut pour les trois sujets :
                /stats/chart/game/:id existe déjà (GameCharts), seul le bouton
                manquait sur un match. */}
            {(type === "team" || type === "player" || type === "game") && id && (
              <FramedLabel
                text={t("pred.chart")}
                onClick={() => navigate(`/stats/chart/${type}/${id}`)}
              />
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {renderContent()}
        </div>

        <BottomNav />
      </div>
    </RevealModeCtx.Provider>
  );
}
