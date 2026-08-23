/**
 * PlayerPropPrediction.tsx
 *
 * Extrait de PredictionPage.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { useEffect, useState } from "react";
import { nhlApiService } from "../../services/nhlApiService";
import { useSport } from "../../context/SportContext";
import { useI18n } from "../../i18n";
import { nhlLogoUrl } from "../../data/teamEmoji";
import { factorsApiService } from "../../services/predictionApiService";
import type { CalcFactor } from "../../services/predictionApiService";
import { LoadingSkeleton, NotFound, PredictionLayout, generateForm } from "./predictionShared";


/* ─── Player Prop Prediction ──────────────────────────── */
function PlayerPropPrediction({ propId }: { propId: string }) {
  const { theme } = useSport();
  const { t } = useI18n();
  const accent = theme.accent;
  // propId format: "<playerId>-<propType>"  e.g. "8478402-goals"
  const dashIdx = propId.lastIndexOf("-");
  const playerId = dashIdx > 0 ? propId.slice(0, dashIdx) : propId;
  const propType = dashIdx > 0 ? propId.slice(dashIdx + 1) : "points";

  const [result, setResult] = useState<{ name: string; team: string; logo: string; season: string; probability: number; oddsLabel: string; factors: CalcFactor[]; betNote: string; extraStats: { label: string; value: string }[] } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [info, stats] = await Promise.all([
          nhlApiService.getPlayer(playerId),
          nhlApiService.getPlayerStats(playerId),
        ]);
        const name = info.name ?? info.fullName ?? `${info.firstName ?? ""} ${info.lastName ?? ""}`.trim();
        const logo = nhlLogoUrl(info.teamAbbr ?? "");
        const season = stats.season ?? "2025-26";

        // Calculate prop line from real stats pace
        const gp = stats.gamesPlayed;
        const pace82 = (n: number) => gp > 0 ? Math.round((n / gp) * 82) : n;
        const currentVal = propType === "goals" ? stats.goals : propType === "assists" ? stats.assists : stats.points;
        const pacedVal   = pace82(currentVal);
        // Prop line = 90% of pace (makes it slightly challenging)
        const line = Math.max(currentVal + 1, Math.round(pacedVal * 0.92));

        const propResponse = await factorsApiService.getPlayerProp({
          playerId,
          playerName: name,
          propType: propType as "goals" | "points" | "assists",
          line,
          season,
          currentGoals:   stats.goals,
          currentPoints:  stats.points,
          currentAssists: stats.assists,
          gamesPlayed:    gp,
        });

        setResult({
          name, logo, season,
          team: info.teamAbbr ?? "",
          probability: propResponse.probability,
          oddsLabel:   propResponse.oddsLabel,
          factors:     propResponse.factors,
          betNote:     propResponse.betNote,
          extraStats: [
            { label: "Line",  value: String(line)                    },
            { label: t("pred.odds"),  value: propResponse.oddsLabel  },
            { label: propType.charAt(0).toUpperCase() + propType.slice(1), value: String(currentVal) },
            { label: "GP",    value: String(gp)                      },
          ],
        });
      } catch (e) {
        console.error("PlayerPropPrediction load error", e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [propId]);

  if (loading) return <LoadingSkeleton />;
  if (!result) return <NotFound />;

  return (
    <PredictionLayout
      title={result.name}
      subtitle={`${result.team} · ${result.season} · ${propType.charAt(0).toUpperCase() + propType.slice(1)} Prop`}
      logo={result.logo}
      winPct={result.probability}
      winLabel="Hit Probability"
      calcFactors={result.factors}
      basePct={50}
      accent={accent}
      recentForm={generateForm(8, result.probability / 100)}
      betRec={`${propType.charAt(0).toUpperCase() + propType.slice(1)} Over Line`}
      betNote={result.betNote}
      extraStats={result.extraStats}
    />
  );
}
