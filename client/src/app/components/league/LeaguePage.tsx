// pages/LeaguePage.tsx

import { useEffect, useState } from "react";
import { BottomNav } from "../../components/BottomNav";
import { LeagueHeader } from "./LeagueHeader";
import { FullLeaderboard } from "./FullLeaderBoard";
import { ChatTab } from "../league/chat/ChatTab";
import { profileApiService } from "../../services/userService";
import type { LeaderboardEntry, ChatRoom } from "../../types/user";

type Tab = "leaderboard" | "chat";

export function LeaguePage() {
  const [tab, setTab] = useState<Tab>("leaderboard");
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [rooms, setRooms] = useState<ChatRoom[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      profileApiService.getLeaderboard(),
      profileApiService.getChatRooms(),
    ]).then(([lb, rm]) => {
      setLeaderboard(lb);
      setRooms(rm);
      setLoading(false);
    });
  }, []);

  const totalUnread = rooms.reduce((acc, r) => acc + (r.unread ?? 0), 0);

  return (
    <div className="flex flex-col min-h-screen bg-transparent text-white max-w-[430px] md:max-w-5xl mx-auto w-full">
      <LeagueHeader tab={tab} setTab={setTab} totalUnread={totalUnread} />

      <div
        className={`flex-1 px-4 pb-28 pt-4 ${
          tab === "chat" ? "overflow-hidden flex flex-col" : "overflow-y-auto"
        }`}
      >
        {tab === "leaderboard" &&
          (loading ? (
            <div className="flex flex-col gap-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-14 bg-white/5 rounded-2xl animate-pulse" />
              ))}
            </div>
          ) : (
            <FullLeaderboard entries={leaderboard} />
          ))}

        {tab === "chat" && <ChatTab />}
      </div>

      <BottomNav />
    </div>
  );
}