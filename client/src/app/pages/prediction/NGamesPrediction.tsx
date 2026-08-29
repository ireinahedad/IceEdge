/**
 * NGamesPrediction.tsx
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
import type { CalcFactor } from "../../services/predictionApiService";
import { NGamesView, NotFound, PredictionLayout } from "./predictionShared";


function NGamesPrediction({ teamId, n }: { teamId: string; n: number }) {
  const { theme } = useSport();
  const { t } = useI18n();
  const accent = theme.accent;
  const [view, setView] = useState<NGamesView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);

    async function load() {
      try {
        const [teams, stats] = await Promise.all([
          nhlApiService.getAllTeams(),
          nhlApiService.getTeamLastNGamesStats(teamId, n),
        ]);

        if (!alive) return;

        // Match team by abbreviation (teamId is lowercase abbr from useNHLData)
        const teamInfo = teams.find(
          (t) => t.abbreviation?.toLowerCase() === teamId.toLowerCase()
        );
        const abbr = teamInfo?.abbreviation ?? teamId.toUpperCase();
        const totalGames = stats.wins + stats.losses + (stats.otLosses ?? 0);
        const winRateN = totalGames > 0
          ? Math.round((stats.wins / totalGames) * 100)
          : Math.round((stats.wins / n) * 100);

        setView({
          teamName:        teamInfo?.name ?? abbr,
          teamAbbr:        abbr,
          logo:            nhlLogoUrl(abbr),
          wins:            stats.wins,
          losses:          stats.losses,
          otLosses:        stats.otLosses ?? 0,
          goalsFor:        stats.goalsFor,
          goalsAgainst:    stats.goalsAgainst,
          goalsForPerGame: stats.goalsForPerGame  ?? +(stats.goalsFor  / n).toFixed(2),
          goalsAgainstPerGame: stats.goalsAgainstPerGame ?? +(stats.goalsAgainst / n).toFixed(2),
          ppPct:           stats.powerPlayPct   ?? 0,
          pkPct:           stats.penaltyKillPct ?? 0,
          streak:          stats.streak  ?? "",
          last10:          stats.last10  ?? "",
          winRateN,
        });
      } catch (err) {
        console.error("NGamesPrediction fetch error", err);
        // Graceful fallback — estimate from n
        if (alive) {
          setView({
            teamName: teamId.toUpperCase(), teamAbbr: teamId.toUpperCase(),
            logo: nhlLogoUrl(teamId.toUpperCase()),
            wins: Math.round(n * 0.55), losses: Math.round(n * 0.35),
            otLosses: Math.round(n * 0.10),
            goalsFor: +(n * 3.1).toFixed(1), goalsAgainst: +(n * 2.8).toFixed(1),
            goalsForPerGame: 3.1, goalsAgainstPerGame: 2.8,
            ppPct: 21, pkPct: 80, streak: "?", last10: "?",
            winRateN: 55,
          });
        }
      } finally {
        if (alive) setLoading(false);
      }
    }

    load();
    return () => { alive = false; };
  }, [teamId, n]);

  if (loading) return (
    <div className="flex flex-col gap-3">
      {[1, 2, 3, 4].map((i) => (
        <div key={i} className="h-20 bg-[#131A12] rounded-2xl animate-pulse" />
      ))}
    </div>
  );

  if (!view) return <NotFound />;

  const leagueAvgGF  = 3.0;
  const leagueAvgGA  = 3.0;
  const leagueAvgPP  = 20;
  const leagueAvgPK  = 80;

  const calcFactors: CalcFactor[] = [
    {
      icon: "🏆",
      label: `Last ${n} record: ${view.wins}W – ${view.losses}L – ${view.otLosses}OT`,
      delta: Math.round(((view.winRateN - 50) / 100) * 20),
    },
    {
      icon: "🥅",
      label: `Goals for/game: ${view.goalsForPerGame.toFixed(2)} vs league avg ${leagueAvgGF}`,
      delta: Math.round((view.goalsForPerGame - leagueAvgGF) * 6),
    },
    {
      icon: "🔒",
      label: `Goals against/game: ${view.goalsAgainstPerGame.toFixed(2)} vs league avg ${leagueAvgGA}`,
      delta: Math.round((leagueAvgGA - view.goalsAgainstPerGame) * 6),
    },
    {
      icon: "⚡",
      label: `Power play: ${view.ppPct.toFixed(1)}% (league avg ${leagueAvgPP}%)`,
      delta: Math.round((view.ppPct - leagueAvgPP) / 2),
    },
    {
      icon: "🛡️",
      label: `Penalty kill: ${view.pkPct.toFixed(1)}% (league avg ${leagueAvgPK}%)`,
      delta: Math.round((view.pkPct - leagueAvgPK) / 4),
    },
    ...(view.streak ? [{
      icon: "🔥",
      label: `Current streak: ${view.streak}`,
      delta: view.streak.startsWith("W5") || view.streak.startsWith("W6") || view.streak.startsWith("W7") ? 6
           : view.streak.startsWith("W3") || view.streak.startsWith("W4") ? 4
           : view.streak.startsWith("W") ? 2
           : view.streak.startsWith("L3") || view.streak.startsWith("L4") ? -4
           : view.streak.startsWith("L") ? -2
           : 0,
    }] : []),
  ].filter((f) => f.delta !== 0);

  const finalPct = Math.min(82, Math.max(18, view.winRateN));
  const wl = `${view.wins}W – ${view.losses}L${view.otLosses > 0 ? ` – ${view.otLosses}OT` : ""}`;

  return (
    <PredictionLayout
      title={`${view.teamName} — ${t("pred.lastN", { n })}`}
      subtitle={t("pred.formOverLast", { n, wl })}
      logo={view.logo}
      winPct={finalPct}
      winLabel={t("pred.winRateL", { n })}
      calcFactors={calcFactors}
      basePct={50}
      accent={accent}
      betRec={finalPct >= 60 ? "Moneyline" : "Over/Under"}
      betNote={`Over the last ${n} games, ${view.teamName} has gone ${wl} with ${view.goalsForPerGame.toFixed(1)} goals/game. ${finalPct >= 55 ? "Strong form makes them a solid moneyline pick." : "Inconsistent results suggest value in the totals market."}`}
      extraStats={[
        { label: `L${n} W`,  value: `${view.wins}`    },
        { label: `L${n} L`,  value: `${view.losses}`  },
        { label: "GF/G", value: view.goalsForPerGame.toFixed(1)      },
        { label: "GA/G", value: view.goalsAgainstPerGame.toFixed(1)  },
      ]}
    />
  );
}
