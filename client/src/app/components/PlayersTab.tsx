import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { UITeam } from "../hooks/useNHLData";
import { nhlApiService } from "../services/nhlApiService";
import { teamEmoji } from "../data/teamEmoji";

export function PlayersTab({ teams, accent }: { teams: UITeam[]; accent: string }) {
  const navigate = useNavigate();
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
        <p className="text-[#8a9ea6] text-xs uppercase tracking-wider font-medium">Select a team</p>
        <div className="flex gap-2 flex-wrap">
          {teams.map(team => (
            <button
              key={team.id}
              onClick={() => setSelectedTeamId(team.id === selectedTeamId ? null : team.id)}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-medium transition-all"
              style={team.id === selectedTeamId
                ? { backgroundColor: accent, color: "#0a1014", borderColor: accent }
                : { backgroundColor: "#111a1f", color: "#bfc8cc", borderColor: "rgba(255,255,255,0.1)" }}
            >
              <span>{team.logo}</span>
              <span>{team.abbr}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Players list */}
      {selectedTeam && (
        <div className="flex flex-col gap-2">
          <p className="text-[#8a9ea6] text-xs uppercase tracking-wider font-medium">
            {selectedTeam.name} · {loading ? "loading…" : `${teamPlayers.length} players`}
          </p>
          {loading ? (
            [1,2,3,4,5].map(i => <div key={i} className="h-16 bg-[#111a1f] rounded-2xl animate-pulse" />)
          ) : teamPlayers.length === 0 ? (
            <p className="text-[#8a9ea6] text-sm text-center py-8">No players found for {selectedTeam.abbr}</p>
          ) : (
            teamPlayers.map((p: any) => {
              const id = String(p.id);
              const name = p.name ?? p.fullName ?? `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim();
              const logo = teamEmoji(selectedTeam.abbr);
              const number = p.number ?? p.jerseyNumber ?? p.sweaterNumber ?? 0;
              return (
                <button
                  key={id}
                  onClick={() => navigate(`/stats/prediction/player/${id}`)}
                  className="w-full bg-[#111a1f]/70 border border-white/20 rounded-2xl p-4 flex items-center gap-3 active:scale-[0.98] transition-transform text-left"
                >
                  <div className="w-11 h-11 rounded-xl bg-[#1a2a2f] flex items-center justify-center text-2xl flex-shrink-0">
                    {logo}
                  </div>
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
        <p className="text-[#4a6070] text-sm text-center py-12">← Pick a team to see its players</p>
      )}
    </div>
  );
}
