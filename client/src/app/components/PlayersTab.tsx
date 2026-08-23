import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { UITeam } from "../hooks/useNHLData";
import { nhlApiService } from "../services/nhlApiService";
import { nhlLogoUrl, teamColors } from "../data/teamEmoji";
import { useI18n } from "../i18n";

export function PlayersTab({ teams, accent }: { teams: UITeam[]; accent: string }) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
  const [teamPlayers, setTeamPlayers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const selectedTeam = teams.find(t => t.id === selectedTeamId);

  useEffect(() => {
    if (!selectedTeamId) { setTeamPlayers([]); return; }
    setLoading(true);
    setTeamPlayers([]);
    nhlApiService.getTeamRoster(selectedTeamId.toUpperCase())
      .then((roster: any[]) => setTeamPlayers(roster))
      .catch(() => setTeamPlayers([]))
      .finally(() => setLoading(false));
  }, [selectedTeamId]);

  return (
    <div className="flex flex-col gap-4">
      {/* Team picker */}
      <div className="flex flex-col gap-2">
        <p className="text-[#8a9ea6] text-xs uppercase tracking-wider font-medium">{t("players.selectTeam")}</p>
        {/* Picking a team is the first half of picking a player, so these carry
            the club's colours the same way the team cards do — with a scrim, so
            the white abbreviation survives the light clubs. Selection is an
            accent ring plus full opacity; the unselected ones step back to 78%
            rather than losing their colour, which is what identifies them. */}
        <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2">
          {teams.map(team => {
            const selected = team.id === selectedTeamId;
            const { primary, secondary } = teamColors(team.abbr);
            return (
              <button
                key={team.id}
                onClick={() => setSelectedTeamId(selected ? null : team.id)}
                aria-pressed={selected}
                className="flex flex-col items-center justify-center gap-1 py-2.5 rounded-xl border text-[11px] font-bold transition-all active:scale-95"
                style={{
                  background:
                    `linear-gradient(180deg, rgba(0,0,0,0.34) 0%, rgba(0,0,0,0.58) 100%),` +
                    `linear-gradient(140deg, ${primary}, ${secondary})`,
                  color: "#fff",
                  borderColor: selected ? accent : "rgba(255,255,255,0.18)",
                  boxShadow: selected ? `0 0 0 2px ${accent}, 0 6px 14px rgba(0,0,0,0.4)` : "none",
                  opacity: selected ? 1 : 0.78,
                }}
              >
                <img src={team.logo} alt={team.abbr} className="w-6 h-6 object-contain" />
                <span>{team.abbr}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Players list */}
      {selectedTeam && (
        <div className="flex flex-col gap-2">
          <p className="text-[#8a9ea6] text-xs uppercase tracking-wider font-medium">
            {selectedTeam.name} · {loading ? t("players.loading") : t("players.count", { n: teamPlayers.length })}
          </p>
          {loading ? (
            [1,2,3,4,5].map(i => <div key={i} className="h-16 bg-[#131A12] rounded-2xl animate-pulse" />)
          ) : teamPlayers.length === 0 ? (
            <p className="text-[#8a9ea6] text-sm text-center py-8">{t("players.none", { abbr: selectedTeam.abbr })}</p>
          ) : (
            teamPlayers.map((p: any) => {
              const id = String(p.id);
              const name = p.name ?? p.fullName ?? `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim();
              const logo = nhlLogoUrl(selectedTeam.abbr);
              const number = p.number ?? p.jerseyNumber ?? p.sweaterNumber ?? 0;
              return (
                <button
                  key={id}
                  onClick={() => navigate(`/stats/prediction/player/${id}`)}
                  className="w-full bg-[#131A12]/70 border border-white/20 rounded-2xl p-4 flex items-center gap-3 active:scale-[0.98] transition-transform text-left"
                >
                  <img src={logo} alt={selectedTeam.abbr} className="w-11 h-11 object-contain flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm font-medium truncate">{name}</p>
                    <p className="text-[#8a9ea6] text-xs">{selectedTeam.abbr} · #{number} · {p.position ?? '—'}</p>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-[#8a9ea6] text-[10px]">G: <span className="text-white">{p.goals ?? 0}</span></span>
                      <span className="text-[#8a9ea6] text-[10px]">A: <span className="text-white">{p.assists ?? 0}</span></span>
                      <span className="text-[10px] font-bold" style={{ color: accent }}>PTS: {p.points ?? 0}</span>
                    </div>
                  </div>
                  <span className="text-[#8a9ea6] text-base flex-shrink-0">›</span>
                </button>
              );
            })
          )}
        </div>
      )}

      {!selectedTeam && !loading && (
        <p className="text-[#4a6070] text-sm text-center py-12">{t("players.pickHint")}</p>
      )}
    </div>
  );
}
