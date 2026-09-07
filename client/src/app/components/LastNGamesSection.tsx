import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { UITeam } from "../hooks/useNHLData";
import { nhlApiService } from "../services/nhlApiService";
import { useI18n } from "../i18n";

const LAST_N_OPTIONS = [5, 10, 20, 30];

export function LastNGamesSection({ teams, accent }: { teams: UITeam[]; accent: string }) {
  const navigate = useNavigate();
  const { t } = useI18n();
  const [selectedTeam, setSelectedTeam] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [search, setSearch] = useState("");
  const [nGamesStats, setNGamesStats] = useState<Record<number, { wins: number | null; losses: number | null }>>({});
  const [loadingStats, setLoadingStats] = useState(false);

  const selectedTeamData = selectedTeam ? teams.find((t) => t.id === selectedTeam) ?? null : null;
  const filteredTeams = teams.filter((t) =>
    !search || t.name.toLowerCase().includes(search.toLowerCase()) || t.abbr.toLowerCase().includes(search.toLowerCase())
  );

  useEffect(() => {
    if (!selectedTeam || !selectedTeamData) return;
    setLoadingStats(true);
    setNGamesStats({});
    Promise.all(
      LAST_N_OPTIONS.map(async (n) => {
        try {
          const stats = await nhlApiService.getTeamLastNGamesStats(selectedTeam, n);
          // Un bilan W/L est un fait, pas une estimation : sans réponse de
          // l'API on rend `null` et la carte affiche « — ». Auparavant on le
          // déduisait du % de victoires de la saison, ce qui inventait un
          // palmarès sur les N derniers matchs.
          if (stats?.wins == null || stats?.losses == null) return { n, wins: null, losses: null };
          return { n, wins: stats.wins, losses: stats.losses };
        } catch {
          return { n, wins: null, losses: null };
        }
      })
    ).then((results) => {
      const map: Record<number, { wins: number | null; losses: number | null }> = {};
      results.forEach(({ n, wins, losses }) => { map[n] = { wins, losses }; });
      setNGamesStats(map);
      setLoadingStats(false);
    });
  }, [selectedTeam]);

  return (
    <div className="flex flex-col gap-4">
      {/* Team selector */}
      <div>
        <p className="text-[#bfc8cc] text-xs mb-2 uppercase tracking-wider">{t("lastn.selectTeam")}</p>
        <button
          onClick={() => setShowPicker(!showPicker)}
          className="w-full bg-[#131A12]/70 backdrop-blur-md border border-white/20 rounded-2xl px-4 py-3 flex items-center justify-between"
        >
          <div className="flex items-center gap-2">
            {selectedTeamData ? (
              <>
                <img src={selectedTeamData.logo} alt={selectedTeamData.name} className="w-6 h-6 object-contain" />
                <span className="text-white text-sm">{selectedTeamData.name}</span>
              </>
            ) : (
              <span className="text-[#bfc8cc] text-sm">{t("lastn.chooseTeam")}</span>
            )}
          </div>
          <span style={{ color: accent }}>{showPicker ? "▲" : "▼"}</span>
        </button>

        {showPicker && (
          <div className="mt-1 bg-[#131A12] border border-white/20 rounded-2xl overflow-hidden">
            <div className="px-3 py-2 border-b border-white/20">
              <input
                className="w-full bg-transparent text-white text-xs outline-none placeholder:text-[#bfc8cc]"
                placeholder={t("lastn.searchTeam")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {filteredTeams.map((team, i) => (
              <button
                key={team.id}
                onClick={() => { setSelectedTeam(team.id); setShowPicker(false); setSearch(""); }}
                className={`w-full flex items-center gap-3 px-4 py-2.5 hover:bg-[#1B2419] transition-colors ${i < filteredTeams.length - 1 ? "border-b border-[#1B2419]" : ""}`}
              >
                <img src={team.logo} alt={team.name} className="w-6 h-6 object-contain" />
                <span className="text-white text-sm flex-1 text-left">{team.name}</span>
                <span className="text-[#bfc8cc] text-xs">{team.record}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Game span cards */}
      {selectedTeamData && (
        <div>
          <p className="text-[#bfc8cc] text-xs mb-2 uppercase tracking-wider">{t("lastn.selectSpan")}</p>
          <div className="grid grid-cols-2 gap-2">
            {LAST_N_OPTIONS.map((n) => {
              const stats = nGamesStats[n];
              const wins = stats?.wins ?? null;
              const losses = stats?.losses ?? null;
              const pct = wins == null ? null : Math.round((wins / n) * 100);
              return (
                <button
                  key={n}
                  onClick={() => navigate(`/stats/prediction/ngames/${selectedTeam}?n=${n}`)}
                  className="w-full bg-[#131A12]/70 backdrop-blur-md border border-white/20 rounded-2xl p-4 flex flex-col items-center gap-1 active:scale-[0.98] transition-transform"
                >
                  <span className="text-white text-2xl font-bold">{n}</span>
                  <span className="text-[#bfc8cc] text-xs">{t("lastn.lastGames", { n })}</span>
                  <div className="flex items-center gap-1 mt-1 flex-wrap justify-center">
                    {Array.from({ length: Math.min(n, 10) }).map((_, i) => (
                      <div
                        key={i}
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ backgroundColor: pct != null && i < Math.round(10 * (pct / 100)) ? accent : "#1e2d32" }}
                      />
                    ))}
                  </div>
                  <span className="text-[11px] mt-0.5" style={{ color: accent }}>
                    {loadingStats
                      ? t("lastn.loading")
                      : wins == null || losses == null || pct == null
                      ? t("lastn.noData")
                      : `${wins}W – ${losses}L · ${pct}%`}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {!selectedTeamData && (
        <div className="flex flex-col items-center justify-center py-12 gap-3">
          <span className="text-5xl">🏒</span>
          <p className="text-[#bfc8cc] text-sm text-center">{t("lastn.explore")}</p>
        </div>
      )}
    </div>
  );
}
