// pages/LeaguePage.tsx

import { useEffect, useState } from "react";
import { BottomNav } from "../../components/BottomNav";
import { LeagueHeader } from "./LeagueHeader";
import { FullLeaderboard } from "./FullLeaderBoard";
import { PlayerSearchBar, usePlayerSearch } from "./PlayerSearchBar";
import { ChatTab } from "./chat/ChatTab";
import { profileApiService } from "../../services/userService";
import { ErrorState } from "../../components/ErrorState";
import type { LeaderboardEntry, ChatRoom } from "../../types/user";
import "./league-theme.css";

type Tab = "leaderboard" | "chat";

export function LeaguePage() {
  const [tab, setTab] = useState<Tab>("chat");
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [loading, setLoading] = useState(true);
  /**
   * L'échec du CLASSEMENT seulement.
   *
   * Les deux appels avaient un `.catch(() => [])` : un classement injoignable
   * s'affichait comme un classement vide, sans un mot. Celui des salons garde
   * son repli — l'onglet Chat a sa propre gestion et le badge de non-lus ne
   * doit pas empêcher le classement de s'afficher.
   */
  const [lbError, setLbError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // La recherche de joueur appartient à la PAGE, pas à un onglet : la barre
  // l'affiche, le classement s'en sert comme filtre. Un seul appel réseau pour
  // les deux (voir PlayerSearchBar).
  const playerSearch = usePlayerSearch();

  useEffect(() => {
    setLoading(true);
    setLbError(null);
    Promise.all([
      profileApiService.getLeaderboard().then(
        (lb) => ({ ok: true as const, lb }),
        (err: unknown) => ({ ok: false as const, err }),
      ),
      profileApiService.getChatRooms().catch(() => [] as ChatRoom[]),
    ]).then(([lbRes, rm]) => {
      if (lbRes.ok) setLeaderboard(lbRes.lb);
      else setLbError(lbRes.err ?? new Error("leaderboard load failed"));
      setRooms(rm);
      setLoading(false);
    });
  }, [reloadKey]);

  const totalUnread = rooms.reduce((acc, r) => acc + (r.unread ?? 0), 0);

  return (
    /* La page est jouée depuis le centre de l'aréna, mais les gradins ont été
       retirés (2026-09-03) : il ne reste que la pénombre du bol en fond, et
       tout le reste est du mobilier de stade. Pas de glace ici — la page
       League n'est pas un match, c'est la foule autour du match. */
    <div className="arena-stage flex flex-col min-h-screen text-white max-w-[430px] md:max-w-5xl mx-auto w-full">
      <LeagueHeader tab={tab} setTab={setTab} totalUnread={totalUnread} />

      {/* Chercher quelqu'un est une action de PAGE : la barre est posée sous
          les onglets, au-dessus des deux panneaux, donc au-dessus de la
          recherche de salon. Sur Classement elle n'ouvre pas de liste — le
          tableau affiche déjà les résultats fusionnés à son classement. */}
      <div className="relative z-30 px-4 pt-3 flex-shrink-0">
        <PlayerSearchBar search={playerSearch} showResults={tab === "chat"} />
      </div>

      {/* Single pane driven by the tab bar (Chat is the default), on all sizes. */}
      <div className="relative z-10 flex-1 flex flex-col px-4 pb-[calc(7rem+env(safe-area-inset-bottom,0px))] pt-4 overflow-hidden min-h-0">
        {/* Chat */}
        <div
          className={`${tab === "chat" ? "flex" : "hidden"} flex-col flex-1 min-h-0 overflow-hidden`}
        >
          <ChatTab />
        </div>

        {/* Classement — c'est lui-même le tableau indicateur, donc cette
            enveloppe ne défile pas : c'est la dalle, à l'intérieur du caisson,
            qui défile. `overflow-hidden` ici est ce qui permet au cadre du
            tableau de tenir toute la hauteur de la page. */}
        <div
          className={`${tab === "leaderboard" ? "flex" : "hidden"} flex-col flex-1 min-h-0 overflow-hidden`}
        >
          {loading ? (
            <div className="flex flex-col gap-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-14 bg-white/5 rounded-2xl animate-pulse" />
              ))}
            </div>
          ) : lbError ? (
            <ErrorState error={lbError} onRetry={() => setReloadKey((k) => k + 1)} />
          ) : (
            <FullLeaderboard
              entries={leaderboard}
              search={playerSearch.query}
              remoteResults={playerSearch.results}
            />
          )}
        </div>
      </div>

      <BottomNav />
    </div>
  );
}