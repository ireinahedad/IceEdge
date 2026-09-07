// components/league/leaderboard/FullLeaderboard.tsx

import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { FrozenName } from "../../components/brand/FrozenName";
import { ProLock } from "../../components/ProLock";
import { profileApiService } from "../../services/userService";
import { useSubscription } from "../../context/SubscriptionContext";
import { useAuth } from "../../context/AuthContext";
import { useI18n } from "../../i18n";
import type { LeaderboardEntry, PublicSlip } from "../../types/user";

// Initials fallback shown when a user has no photo avatar (no emoji avatars).
function initials(name: string): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ─── User profile modal ───────────────────────────────────────────────────────

// Le type local a été remplacé par `PublicSlip` (types/user) : depuis que les
// coupons non commencés reviennent avec `legs: null`, un type qui promet un
// tableau ici mentirait au compilateur exactement là où la nuance compte.

function UserProfileModal({ entry, onClose }: {
  entry: LeaderboardEntry;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { isPro } = useSubscription();
  const { user } = useAuth();
  const isSelf = user?.id === entry.userId;
  const canViewBets = isPro || isSelf;   // viewing others' bets is Pro-only
  const medal = entry.rank === 1 ? "🥇" : entry.rank === 2 ? "🥈" : entry.rank === 3 ? "🥉" : null;
  const [slips, setSlips] = useState<PublicSlip[] | "private" | "loading">("loading");

  useEffect(() => {
    if (!canViewBets) return;            // don't fetch — Pro lock is shown instead
    setSlips("loading");
    profileApiService.getPlayerSlips(entry.userId, 6)
      .then((s) => setSlips(s))
      .catch(() => setSlips("private"));
  }, [entry.userId, canViewBets]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-[430px] max-h-[80vh] overflow-y-auto icy-card rounded-t-3xl p-6 pb-10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mb-5" />

        <div className="flex items-center gap-4 mb-5">
          <div className="w-16 h-16 rounded-2xl icy-tile flex items-center justify-center text-xl font-bold text-white/80 overflow-hidden">
            {entry.avatarUrl
              ? <img src={entry.avatarUrl} alt="" className="w-full h-full object-cover" />
              : initials(entry.displayName)}
          </div>
          <div className="flex-1 min-w-0">
            <FrozenName name={entry.displayName} score={entry.performanceScore} size={15} />
            <p className="text-white/50 text-xs mt-2">@{entry.username}</p>
          </div>
          {medal && (
            <div className="text-center flex-shrink-0">
              <p className="text-2xl">{medal}</p>
              <p className="text-white/40 text-[11px]">Rank #{entry.rank}</p>
            </div>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2 mb-4">
          <div className="icy-tile rounded-xl p-3 text-center">
            <p className="text-[#90C9F0] text-base font-bold">{entry.performanceScore}</p>
            <p className="text-white/50 text-[11px] uppercase tracking-wider">{t("league.score")}</p>
          </div>
          <div className="icy-tile rounded-xl p-3 text-center">
            <p className="text-base font-bold" style={{ color: "#86d1ea" }}>{entry.hitRate}%</p>
            <p className="text-white/50 text-[11px] uppercase tracking-wider">{t("league.hitRate")}</p>
          </div>
          <div className="icy-tile rounded-xl p-3 text-center">
            <p className="text-white text-base font-bold">{entry.totalBets}</p>
            <p className="text-white/50 text-[11px] uppercase tracking-wider">{t("league.bets")}</p>
          </div>
        </div>

        {/* Recent slips — viewing another player's bets is a Pro feature */}
        <div className="mb-4">
          <p className="text-white/40 text-[11px] uppercase tracking-widest mb-2">{t("league.recentSlips")}</p>
          {!canViewBets ? (
            <ProLock locked title={t("league.othersProTitle")} description={t("league.othersProDesc")}>
              <div className="flex flex-col gap-2">
                {[1, 2].map((i) => (
                  <div key={i} className="flex items-center gap-2.5 icy-tile rounded-xl px-3 py-2.5">
                    <span className="w-2 h-2 rounded-full bg-white/30" />
                    <div className="flex-1">
                      <div className="h-2.5 w-24 bg-white/20 rounded mb-1.5" />
                      <div className="h-2 w-16 bg-white/10 rounded" />
                    </div>
                    <span className="text-[11px] font-bold text-white/30">••</span>
                  </div>
                ))}
              </div>
            </ProLock>
          ) : (<>
          {slips === "loading" && (
            <div className="flex flex-col gap-2">
              {[1, 2].map((i) => <div key={i} className="h-12 bg-white/5 rounded-xl animate-pulse" />)}
            </div>
          )}
          {slips === "private" && (
            <div className="icy-tile rounded-xl px-3 py-3 text-center">
              <p className="text-white/50 text-[11px]">{t("league.slipsPrivate")}</p>
            </div>
          )}
          {Array.isArray(slips) && slips.length === 0 && (
            <p className="text-white/40 text-[11px] text-center py-3">{t("league.noSlips")}</p>
          )}
          {Array.isArray(slips) && slips.length > 0 && (
            <div className="flex flex-col gap-2">
              {slips.slice(0, 6).map((s) => {
                const color = s.outcome === "win" ? "#4ade80" : s.outcome === "loss" ? "#f87171" : "#8a9ea6";
                const label = s.outcome === "win" ? t("slip.won") : s.outcome === "loss" ? t("slip.lost") : t("slip.pending");
                const first = s.legs?.[0];
                // Coupon pas encore commencé : le serveur n'envoie pas les
                // sélections. On annonce le cadenas plutôt qu'un « Slip » muet.
                const title = s.locked
                  ? `🔒 ${s.isParlay ? t("player.parlayLegs", { n: String(s.legCount) }) : t("player.single")}`
                  : (first?.selection ?? first?.subjectName ?? "Slip");
                return (
                  <div key={s.id} className="flex items-center gap-2.5 icy-tile rounded-xl px-3 py-2.5">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-[11px] font-medium truncate">
                        {title}{s.legCount > 1 ? ` +${s.legCount - 1} legs` : ""}
                      </p>
                      <p className="text-white/40 text-[11px]">
                        {new Date(s.placedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                        {s.isParlay ? " · parlay" : ""}
                        {s.combinedProbability != null ? ` · ${s.combinedProbability}%` : ""}
                      </p>
                    </div>
                    <span className="text-[11px] font-bold flex-shrink-0" style={{ color }}>{label}</span>
                  </div>
                );
              })}
            </div>
          )}
          </>)}
        </div>

        {/* La modale est un aperçu ; l'historique complet, jambe par jambe, vit
            sur la page joueur. Un seul rendu de coupon détaillé dans l'app. */}
        <button
          onClick={() => { onClose(); navigate(`/player/${entry.userId}`); }}
          className="w-full py-3 rounded-2xl text-sm font-bold mb-2 active:scale-[0.99] transition-transform"
          style={{ background: "#86d1ea", color: "#0A0E0C" }}
        >
          {t("player.viewAll")}
        </button>

        <button
          onClick={onClose}
          className="w-full py-3 rounded-2xl border border-white/10 text-white/60 text-sm"
        >
          {t("common.close")}
        </button>
      </div>
    </div>
  );
}

// ─── Full leaderboard ─────────────────────────────────────────────────────────

type LeaderboardFilter = "score" | "hitrate" | "volume";

export function FullLeaderboard({ entries, search = "", remoteResults = [] }: {
  entries: LeaderboardEntry[];
  /** La requête tapée dans la barre de la page (`PlayerSearchBar`). Le tableau
   *  ne possède plus de champ à lui : il y en avait un ici, il n'était
   *  atteignable qu'une fois sur cet onglet. */
  search?: string;
  /** Les joueurs trouvés côté serveur pour cette requête — y compris hors du
   *  top 50 affiché. Fournis par `usePlayerSearch`, seul appelant de
   *  /users/search. */
  remoteResults?: LeaderboardEntry[];
}) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<LeaderboardFilter>("score");
  const [selectedUser, setSelectedUser] = useState<LeaderboardEntry | null>(null);

  const q = search.trim().toLowerCase();
  const localFiltered = entries.filter(
    (e) => !q || e.displayName.toLowerCase().includes(q) || e.username.toLowerCase().includes(q),
  );
  const merged = q
    ? [...localFiltered, ...remoteResults.filter((r) => !localFiltered.some((l) => l.userId === r.userId))]
    : entries;

  const sorted = [...merged]
    .sort((a, b) => {
      if (filter === "score") return b.performanceScore - a.performanceScore;
      if (filter === "hitrate") return b.hitRate - a.hitRate;
      return b.totalBets - a.totalBets;
    })
    .map((e, i) => ({ ...e, displayRank: i + 1 }));

  const podium = sorted.slice(0, 3);

  // Medal tier by rank: 1–3 gold, 4–10 silver, 11–50 bronze
  const medalFor = (rank: number): string | null =>
    rank <= 3 ? "🥇" : rank <= 10 ? "🥈" : rank <= 50 ? "🥉" : null;

  // Show the top 50 — but keep every match visible while searching
  const visibleRows = q ? sorted : sorted.slice(0, 50);

  const filterButtons: { key: LeaderboardFilter; label: string }[] = [
    { key: "score", label: t("league.score") },
    { key: "hitrate", label: t("league.hitRate") },
    { key: "volume", label: t("league.volume") },
  ];

  // Un joueur du podium, affiché comme un score de match : le rang en gros
  // chiffre d'ampoules, la photo, le nom, puis la valeur. `size` distingue le
  // 1er des deux autres — c'est le seul écart entre les trois colonnes.
  function PodiumSlot({ entry, place }: { entry: LeaderboardEntry; place: 1 | 2 | 3 }) {
    const first = place === 1;
    const medal = place === 1 ? "🥇" : place === 2 ? "🥈" : "🥉";
    return (
      <button
        onClick={() => setSelectedUser(entry)}
        className={`flex flex-col items-center gap-1 px-1 ${first ? "pb-1" : "pb-3"} active:scale-95 transition-transform min-w-0`}
      >
        <span className={first ? "text-base leading-none" : "text-xs leading-none"}>{medal}</span>
        {entry.avatarUrl
          ? <img src={entry.avatarUrl} alt="" className={`${first ? "w-12 h-12" : "w-9 h-9"} rounded-full object-cover border border-[#86d1ea]/35`} />
          : <span className={`${first ? "w-12 h-12 text-sm" : "w-9 h-9 text-[11px]"} rounded-full bg-white/8 border border-[#86d1ea]/25 flex items-center justify-center font-bold text-white/80`}>{initials(entry.displayName)}</span>}
        <span className="max-w-full truncate">
          <FrozenName name={entry.displayName} score={entry.performanceScore} size={first ? 12 : 10} />
        </span>
        <span className={`scoreboard-digit ${first ? "text-2xl" : "text-lg"} leading-none mt-1`}>
          {entry.performanceScore}
        </span>
      </button>
    );
  }

  return (
    <>
      {/* Le classement N'EST PAS une liste posée sur la page : c'est le tableau
          indicateur de l'aréna, au format du stade. Même caisson et même dalle
          que le commutateur d'onglets de l'en-tête, en grand. Le cadre tient la
          hauteur de la page ; c'est la dalle, à l'intérieur, qui défile. */}
      <div className="arena-scoreboard arena-scoreboard--full w-full">
        <div className="arena-scoreboard-screen">

          {/* Bandeau de commande — fixe en haut de la dalle */}
          <div className="flex-shrink-0 px-3 pt-3 pb-2.5 flex flex-col gap-2 border-b border-[#86d1ea]/15">
            <div className="flex gap-1">
              {filterButtons.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={`scoreboard-tab scoreboard-tab--sm${filter === f.key ? " is-active" : ""}`}
                  aria-pressed={filter === f.key}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Podium — les trois premiers en gros, comme les scores d'un match.
              Il ne s'affiche qu'au tri par score et hors recherche : sur un
              autre tri, « le podium » ne voudrait plus rien dire. */}
          {filter === "score" && !q && podium.length >= 3 && (
            <div className="scoreboard-podium flex-shrink-0 px-3 pt-3 pb-2">
              <p className="scoreboard-label text-[11px] text-center mb-2">{t("league.podium")}</p>
              <div className="grid grid-cols-3 items-end gap-1">
                <PodiumSlot entry={podium[1]} place={2} />
                <PodiumSlot entry={podium[0]} place={1} />
                <PodiumSlot entry={podium[2]} place={3} />
              </div>
              <p className="scoreboard-label text-[11px] text-center mt-1">{t("league.podiumTap")}</p>
            </div>
          )}

          {/* En-têtes de colonnes */}
          <div className="flex-shrink-0 flex items-center px-3 py-1.5 border-b border-[#86d1ea]/15 bg-black/30">
            <span className="scoreboard-label text-[11px] w-8">#</span>
            <span className="scoreboard-label text-[11px] flex-1">{t("league.player")}</span>
            <span className="scoreboard-label text-[11px] w-16 text-right">
              {filter === "score" ? t("league.score") : filter === "hitrate" ? "HR%" : "Bets"}
            </span>
          </div>

          {/* La liste, seule partie qui défile */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            {visibleRows.map((entry) => {
              const medal = medalFor(entry.displayRank);
              const showCrown = entry.displayRank === 1 || entry.isCurrentUser;
              const mainValue =
                filter === "score" ? entry.performanceScore :
                filter === "hitrate" ? `${entry.hitRate}%` :
                entry.totalBets;

              return (
                <button
                  key={entry.userId}
                  onClick={() => setSelectedUser(entry)}
                  className={`scoreboard-row w-full flex items-center gap-2.5 px-3 py-2.5 text-left ${
                    entry.isCurrentUser ? "scoreboard-row--me" : ""
                  }`}
                >
                  <div className="w-8 flex-shrink-0 flex flex-col items-center justify-center leading-none">
                    {medal && <span className="text-[11px]">{medal}</span>}
                    <span className="scoreboard-digit scoreboard-digit--cool text-[11px] mt-0.5">{entry.displayRank}</span>
                  </div>

                  {entry.avatarUrl
                    ? <img src={entry.avatarUrl} alt="" className="w-7 h-7 rounded-full object-cover border border-[#86d1ea]/25 flex-shrink-0" />
                    : <span className="w-7 h-7 rounded-full bg-white/8 border border-[#86d1ea]/20 flex items-center justify-center text-[11px] font-bold text-white/80 flex-shrink-0">{initials(entry.displayName)}</span>}

                  <div className="flex-1 min-w-0 py-1">
                    <div className="flex items-center gap-1.5">
                      {showCrown && <span className="text-sm flex-shrink-0">👑</span>}
                      <FrozenName name={entry.displayName} score={entry.performanceScore} size={12} />
                      {entry.isCurrentUser && (
                        <span className="text-[11px] text-[#ffd257] border border-[#ffd257]/40 rounded-full px-1 flex-shrink-0">
                          {t("league.you")}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="w-16 text-right flex-shrink-0">
                    <span className="scoreboard-digit text-sm">{mainValue}</span>
                    {filter === "score" && (
                      <p className="scoreboard-label text-[11px] mt-0.5">{entry.hitRate}% HR</p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {selectedUser && (
        <UserProfileModal entry={selectedUser} onClose={() => setSelectedUser(null)} />
      )}
    </>
  );
}