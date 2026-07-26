// pages/LeaguePage.tsx

import { useEffect, useState } from "react";
import { BottomNav } from "../../components/BottomNav";
import { LeagueHeader } from "./LeagueHeader";
import { FullLeaderboard } from "./FullLeaderBoard";
import { ChatTab } from "./chat/ChatTab";
import { profileApiService } from "../../services/userService";
import type { LeaderboardEntry, ChatRoom } from "../../types/user";
import "./league-theme.css";

type Tab = "leaderboard" | "chat";

export function LeaguePage() {
  const [tab, setTab] = useState<Tab>("chat");
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      profileApiService.getLeaderboard().catch(() => [] as LeaderboardEntry[]),
      profileApiService.getChatRooms().catch(() => [] as ChatRoom[]),
    ]).then(([lb, rm]) => {
      setLeaderboard(lb);
      setRooms(rm);
      setLoading(false);
    });
  }, []);

  const totalUnread = rooms.reduce((acc, r) => acc + (r.unread ?? 0), 0);

  return (
    <div className="flex flex-col min-h-screen bg-transparent text-white max-w-[430px] mx-auto w-full">
      <LeagueHeader tab={tab} setTab={setTab} totalUnread={totalUnread} />

      {/* Single pane driven by the tab bar (Chat is the default), on all sizes. */}
      <div className="flex-1 flex flex-col px-4 pb-28 pt-4 overflow-hidden min-h-0">
        {/* Chat */}
        <div
          className={`${tab === "chat" ? "flex" : "hidden"} flex-col flex-1 min-h-0 overflow-hidden`}
        >
          <ChatTab />
        </div>

        {/* Podium */}
        <div
          className={`${tab === "leaderboard" ? "flex" : "hidden"} flex-col flex-1 min-h-0 overflow-y-auto`}
        >
          {loading ? (
            <div className="flex flex-col gap-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-14 bg-white/5 rounded-2xl animate-pulse" />
              ))}
            </div>
          ) : (
            <FullLeaderboard entries={leaderboard} />
          )}
        </div>
      </div>

      <BottomNav />
    </div>
  );
}