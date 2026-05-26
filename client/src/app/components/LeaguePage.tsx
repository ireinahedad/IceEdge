import { useState, useEffect, useRef } from "react";
import { BottomNav } from "./BottomNav";
import { TIER_CONFIG } from "./profile/ProfileComponents";
import { profileApiService } from "./../services/userService";
import type { LeaderboardEntry, UserProfile } from "../types/user";

// ─── Chat types ───────────────────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  tier: UserProfile["tier"];
  text: string;
  sentAt: string; // ISO
  reactions?: { emoji: string; count: number; reacted: boolean }[];
  replyTo?: { username: string; text: string };
  tag?: "pick" | "analysis" | "hot";
}

type ChatChannel = "general" | "picks" | "analysis" | "live";

// ─── Mock chat data ───────────────────────────────────────────────────────────

const MOCK_MESSAGES: Record<ChatChannel, ChatMessage[]> = {
  general: [
    { id: "m1", userId: "u9", username: "hockey_oracle", displayName: "The Oracle", avatar: "🔮", tier: "legend", text: "Good slate tonight. BOS at home is an obvious lean but the line is juicy.", sentAt: "2026-04-27T18:42:00Z", reactions: [{ emoji: "🔥", count: 8, reacted: false }, { emoji: "✅", count: 3, reacted: false }] },
    { id: "m2", userId: "u3", username: "icepick_pro", displayName: "IcePick Pro", avatar: "🏆", tier: "legend", text: "VGK home ice is real. Their 5v5 numbers at T-Mobile this season are elite.", sentAt: "2026-04-27T18:45:00Z", reactions: [{ emoji: "💯", count: 5, reacted: false }] },
    { id: "m3", userId: "u1", username: "jdupont", displayName: "Jean Dupont", avatar: "🏒", tier: "sharp", text: "Anyone on the MTL moneyline? Model says 46% but they've been sneaky good on the road.", sentAt: "2026-04-27T18:48:00Z", reactions: [{ emoji: "👀", count: 4, reacted: false }, { emoji: "🤔", count: 2, reacted: false }] },
    { id: "m4", userId: "u7", username: "slapshot_stats", displayName: "Slapshot", avatar: "🎯", tier: "sharp", text: "Pastrnak shots over is always worth looking at when BOS plays NYR. He feasts on them.", sentAt: "2026-04-27T18:51:00Z", replyTo: { username: "jdupont", text: "Anyone on the MTL moneyline?" }, reactions: [{ emoji: "🎯", count: 6, reacted: true }] },
    { id: "m5", userId: "u12", username: "puckwizard", displayName: "Puck Wizard", avatar: "🧙", tier: "sharp", text: "COL vs FLA total is interesting. Both teams top 10 in GA/game. Leaning under 6.", sentAt: "2026-04-27T18:55:00Z", tag: "pick", reactions: [{ emoji: "📊", count: 3, reacted: false }] },
    { id: "m6", userId: "u5", username: "faceoff_king", displayName: "Faceoff King", avatar: "👑", tier: "analyst", text: "McDavid has 5 points in his last 3 against VGK. Anytime goal + assist prop is the move.", sentAt: "2026-04-27T19:01:00Z", tag: "analysis", reactions: [{ emoji: "🔥", count: 11, reacted: false }, { emoji: "💰", count: 4, reacted: false }] },
    { id: "m7", userId: "u18", username: "overtime_ox", displayName: "OT Ox", avatar: "🐂", tier: "analyst", text: "Anyone else think TOR/MTL goes to OT? Both goalies are hot right now.", sentAt: "2026-04-27T19:04:00Z", reactions: [{ emoji: "🤝", count: 2, reacted: false }] },
  ],
  picks: [
    { id: "p1", userId: "u9", username: "hockey_oracle", displayName: "The Oracle", avatar: "🔮", tier: "legend", text: "🎯 LOCK: BOS ML (-140) — Home, rested, and NYR missing two D-men. Easy money.", sentAt: "2026-04-27T17:30:00Z", tag: "pick", reactions: [{ emoji: "🔒", count: 14, reacted: false }, { emoji: "✅", count: 9, reacted: true }] },
    { id: "p2", userId: "u3", username: "icepick_pro", displayName: "IcePick Pro", avatar: "🏆", tier: "legend", text: "VGK -1.5 (+115). Golden Knights are 18-6 ATS as home favorites this season.", sentAt: "2026-04-27T17:45:00Z", tag: "pick", reactions: [{ emoji: "💰", count: 7, reacted: false }] },
    { id: "p3", userId: "u7", username: "slapshot_stats", displayName: "Slapshot", avatar: "🎯", tier: "sharp", text: "3-leg parlay: BOS ML + Pastrnak O 2.5 shots + COL/FLA under 6. Payout is 🔥", sentAt: "2026-04-27T18:10:00Z", tag: "pick", reactions: [{ emoji: "🎰", count: 5, reacted: false }, { emoji: "👀", count: 3, reacted: false }] },
    { id: "p4", userId: "u1", username: "jdupont", displayName: "Jean Dupont", avatar: "🏒", tier: "sharp", text: "McDavid anytime goal. He's due. 55% model, I say closer to 62% given matchup.", sentAt: "2026-04-27T18:20:00Z", tag: "pick", reactions: [{ emoji: "🔥", count: 4, reacted: true }] },
  ],
  analysis: [
    { id: "a1", userId: "u5", username: "faceoff_king", displayName: "Faceoff King", avatar: "👑", tier: "analyst", text: "Deep dive on BOS vs NYR: Boston is 12-3 in their last 15 home games. NYR's PK is 28th in the league this month. BOS PP has clicked at 31% in April. Strong lean to BOS covering.", sentAt: "2026-04-27T16:00:00Z", tag: "analysis", reactions: [{ emoji: "📊", count: 12, reacted: false }, { emoji: "🧠", count: 8, reacted: true }] },
    { id: "a2", userId: "u9", username: "hockey_oracle", displayName: "The Oracle", avatar: "🔮", tier: "legend", text: "VGK goalie situation: Hill has .928 sv% at home vs .901 on the road this season. Factor that into any total or ML bet tonight.", sentAt: "2026-04-27T16:30:00Z", tag: "analysis", reactions: [{ emoji: "🧊", count: 6, reacted: false }] },
    { id: "a3", userId: "u12", username: "puckwizard", displayName: "Puck Wizard", avatar: "🧙", tier: "sharp", text: "COL/FLA has gone under in 6 of the last 8 meetings. Both coaches are defensive-minded in elimination spots. Under 6 has serious value at -108.", sentAt: "2026-04-27T17:00:00Z", tag: "analysis", reactions: [{ emoji: "📉", count: 9, reacted: false }, { emoji: "✅", count: 5, reacted: false }] },
  ],
  live: [
    { id: "l1", userId: "u9", username: "hockey_oracle", displayName: "The Oracle", avatar: "🔮", tier: "legend", text: "BOS 3-2 in the 3rd. My ML is alive. Nerve-wracking but NYR can't buy a PP goal.", sentAt: "2026-04-27T21:10:00Z", tag: "hot", reactions: [{ emoji: "😅", count: 6, reacted: false }, { emoji: "🙏", count: 4, reacted: false }] },
    { id: "l2", userId: "u3", username: "icepick_pro", displayName: "IcePick Pro", avatar: "🏆", tier: "legend", text: "VGK/EDM just went to 2-2 in the 2nd. OT is looking possible. Game to OT was +280 at puck drop 👀", sentAt: "2026-04-27T21:14:00Z", tag: "hot", reactions: [{ emoji: "🔥", count: 9, reacted: true }] },
    { id: "l3", userId: "u1", username: "jdupont", displayName: "Jean Dupont", avatar: "🏒", tier: "sharp", text: "GOAL! McDavid scores on the PP! Anytime goal cash 💰", sentAt: "2026-04-27T21:18:00Z", tag: "hot", reactions: [{ emoji: "🎉", count: 14, reacted: false }, { emoji: "💰", count: 8, reacted: true }] },
    { id: "l4", userId: "u7", username: "slapshot_stats", displayName: "Slapshot", avatar: "🎯", tier: "sharp", text: "TOR/MTL tied 1-1 through 40. Both goalies standing on their heads. OT incoming?", sentAt: "2026-04-27T21:22:00Z", reactions: [{ emoji: "🧊", count: 3, reacted: false }] },
  ],
};

// ─── Leaderboard tab ──────────────────────────────────────────────────────────

type LeaderboardFilter = "score" | "hitrate" | "volume";

function FullLeaderboard({ entries }: { entries: LeaderboardEntry[] }) {
  const [filter, setFilter] = useState<LeaderboardFilter>("score");
  const [tierFilter, setTierFilter] = useState<UserProfile["tier"] | "all">("all");

  const sorted = [...entries]
    .filter((e) => tierFilter === "all" || e.tier === tierFilter)
    .sort((a, b) => {
      if (filter === "score") return b.performanceScore - a.performanceScore;
      if (filter === "hitrate") return b.hitRate - a.hitRate;
      return b.totalBets - a.totalBets;
    })
    .map((e, i) => ({ ...e, displayRank: i + 1 }));

  const filters: { key: LeaderboardFilter; label: string }[] = [
    { key: "score", label: "Score" },
    { key: "hitrate", label: "Hit Rate" },
    { key: "volume", label: "Volume" },
  ];

  const tierFilters: { key: UserProfile["tier"] | "all"; label: string }[] = [
    { key: "all", label: "All" },
    { key: "legend", label: "👑 Legend" },
    { key: "sharp", label: "🎯 Sharp" },
    { key: "analyst", label: "📊 Analyst" },
    { key: "rookie", label: "🏒 Rookie" },
  ];

  // Top 3 podium
  const podium = sorted.slice(0, 3);
  const rest = sorted.slice(3);

  return (
    <div className="flex flex-col gap-3">
      {/* Sort filters */}
      <div className="flex gap-1">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`flex-1 py-1.5 rounded-xl text-[10px] font-medium border transition-all ${
              filter === f.key
                ? "bg-[#86d1ea] text-[#0f1416] border-[#86d1ea] font-bold"
                : "text-[#bfc8cc] border-[#1e2d32] bg-[#141c1f]"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Tier pills */}
      <div className="flex gap-1.5 overflow-x-auto pb-0.5 scrollbar-hide">
        {tierFilters.map((t) => (
          <button
            key={t.key}
            onClick={() => setTierFilter(t.key)}
            className={`flex-shrink-0 px-2.5 py-1 rounded-full text-[9px] border transition-all ${
              tierFilter === t.key
                ? "bg-[#1e2d32] text-white border-[#86d1ea]"
                : "text-[#bfc8cc] border-[#1e2d32]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Podium — only show when sorted by score and no tier filter */}
      {filter === "score" && tierFilter === "all" && podium.length >= 3 && (
        <div className="bg-[#141c1f] border border-[#1e2d32] rounded-2xl p-4">
          <p className="text-[#bfc8cc] text-[10px] uppercase tracking-widest text-center mb-4">This Season's Podium</p>
          <div className="flex items-end justify-center gap-3">
            {/* 2nd */}
            <div className="flex flex-col items-center gap-1.5 mb-0">
              <span className="text-2xl">{podium[1].avatar}</span>
              <div className="text-center">
                <p className="text-white text-[10px] font-bold">{podium[1].displayName}</p>
                <p className="text-[#86d1ea] text-[10px]">{podium[1].performanceScore}</p>
              </div>
              <div className="w-16 bg-[#1e2d32] rounded-t-lg flex items-center justify-center" style={{ height: 40 }}>
                <span className="text-lg">🥈</span>
              </div>
            </div>
            {/* 1st */}
            <div className="flex flex-col items-center gap-1.5">
              <span className="text-3xl">{podium[0].avatar}</span>
              <div className="text-center">
                <p className="text-white text-xs font-bold">{podium[0].displayName}</p>
                <p className="text-yellow-400 text-[10px] font-bold">{podium[0].performanceScore}</p>
              </div>
              <div className="w-16 bg-[#1e2d32] rounded-t-lg flex items-center justify-center" style={{ height: 56 }}>
                <span className="text-xl">🥇</span>
              </div>
            </div>
            {/* 3rd */}
            <div className="flex flex-col items-center gap-1.5">
              <span className="text-2xl">{podium[2].avatar}</span>
              <div className="text-center">
                <p className="text-white text-[10px] font-bold">{podium[2].displayName}</p>
                <p className="text-amber-600 text-[10px]">{podium[2].performanceScore}</p>
              </div>
              <div className="w-16 bg-[#1e2d32] rounded-t-lg flex items-center justify-center" style={{ height: 30 }}>
                <span className="text-lg">🥉</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Full list */}
      <div className="bg-[#141c1f] border border-[#1e2d32] rounded-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center px-4 py-2 border-b border-[#1e2d32]">
          <span className="text-[#bfc8cc] text-[9px] uppercase tracking-wider w-8">#</span>
          <span className="text-[#bfc8cc] text-[9px] uppercase tracking-wider flex-1">Player</span>
          <span className="text-[#bfc8cc] text-[9px] uppercase tracking-wider w-12 text-right">
            {filter === "score" ? "Score" : filter === "hitrate" ? "HR%" : "Bets"}
          </span>
        </div>

        {sorted.map((entry) => {
          const tc = TIER_CONFIG[entry.tier];
          const rankIcon = entry.displayRank === 1 ? "🥇" : entry.displayRank === 2 ? "🥈" : entry.displayRank === 3 ? "🥉" : null;
          const mainValue =
            filter === "score" ? entry.performanceScore :
            filter === "hitrate" ? `${entry.hitRate}%` :
            entry.totalBets;

          return (
            <div
              key={entry.userId}
              className={`flex items-center gap-3 px-4 py-3 border-b border-[#0f1416] last:border-0 ${
                entry.isCurrentUser ? "bg-[#86d1ea]/5" : ""
              }`}
            >
              {/* Rank */}
              <div className="w-8 flex-shrink-0">
                {rankIcon
                  ? <span className="text-sm">{rankIcon}</span>
                  : <span className="text-[#bfc8cc] text-[10px] font-bold">{entry.displayRank}</span>
                }
              </div>

              {/* Avatar */}
              <span className="text-lg flex-shrink-0">{entry.avatar}</span>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className={`text-xs font-medium truncate ${entry.isCurrentUser ? "text-[#86d1ea]" : "text-white"}`}>
                    {entry.displayName}
                  </span>
                  {entry.isCurrentUser && (
                    <span className="text-[8px] text-[#86d1ea] border border-[#86d1ea]/40 rounded-full px-1 flex-shrink-0">you</span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className={`text-[8px] px-1.5 py-0.5 rounded-full border ${tc.bg}`} style={{ color: tc.color }}>
                    {tc.icon} {tc.label}
                  </span>
                  <span className="text-[#bfc8cc] text-[9px]">{entry.totalBets} bets</span>
                </div>
              </div>

              {/* Value */}
              <div className="w-12 text-right flex-shrink-0">
                <span className={`text-xs font-bold ${entry.isCurrentUser ? "text-[#86d1ea]" : "text-white"}`}>
                  {mainValue}
                </span>
                {filter === "score" && (
                  <p className="text-[#bfc8cc] text-[9px]">{entry.hitRate}% HR</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Chat message bubble ──────────────────────────────────────────────────────

const TAG_STYLE = {
  pick:     "bg-green-500/15 text-green-400 border-green-500/30",
  analysis: "bg-[#86d1ea]/15 text-[#86d1ea] border-[#86d1ea]/30",
  hot:      "bg-red-500/15 text-red-400 border-red-500/30",
} as const;

const TAG_LABEL = { pick: "🎯 Pick", analysis: "📊 Analysis", hot: "🔴 Live" } as const;

function MessageBubble({
  msg,
  isOwn,
  onReact,
}: {
  msg: ChatMessage;
  isOwn: boolean;
  onReact: (msgId: string, emoji: string) => void;
}) {
  const tc = TIER_CONFIG[msg.tier];
  const time = new Date(msg.sentAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  return (
    <div className={`flex gap-2 ${isOwn ? "flex-row-reverse" : ""}`}>
      {/* Avatar */}
      <div className="flex-shrink-0 flex flex-col items-center gap-0.5">
        <div className="w-7 h-7 rounded-full bg-[#1e2d32] flex items-center justify-center text-sm">
          {msg.avatar}
        </div>
      </div>

      {/* Bubble */}
      <div className={`max-w-[78%] flex flex-col gap-1 ${isOwn ? "items-end" : "items-start"}`}>
        {/* Name + tier + time */}
        <div className={`flex items-center gap-1.5 ${isOwn ? "flex-row-reverse" : ""}`}>
          <span className="text-white text-[10px] font-bold">{msg.displayName}</span>
          <span className={`text-[8px] px-1 py-0.5 rounded-full border ${tc.bg}`} style={{ color: tc.color }}>
            {tc.icon}
          </span>
          {msg.tag && (
            <span className={`text-[8px] px-1.5 py-0.5 rounded-full border ${TAG_STYLE[msg.tag]}`}>
              {TAG_LABEL[msg.tag]}
            </span>
          )}
          <span className="text-[#bfc8cc] text-[8px]">{time}</span>
        </div>

        {/* Reply preview */}
        {msg.replyTo && (
          <div className="bg-[#1e2d32] rounded-lg px-2 py-1 border-l-2 border-[#86d1ea]">
            <p className="text-[#86d1ea] text-[9px] font-medium">@{msg.replyTo.username}</p>
            <p className="text-[#bfc8cc] text-[9px] truncate">{msg.replyTo.text}</p>
          </div>
        )}

        {/* Text */}
        <div className={`rounded-2xl px-3 py-2 ${
          isOwn
            ? "bg-[#86d1ea] text-[#0f1416]"
            : "bg-[#141c1f] border border-[#1e2d32] text-white"
        }`}>
          <p className="text-xs leading-relaxed">{msg.text}</p>
        </div>

        {/* Reactions */}
        {msg.reactions && msg.reactions.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            {msg.reactions.map((r) => (
              <button
                key={r.emoji}
                onClick={() => onReact(msg.id, r.emoji)}
                className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded-full border text-[9px] transition-all ${
                  r.reacted
                    ? "bg-[#86d1ea]/20 border-[#86d1ea]/50 text-[#86d1ea]"
                    : "bg-[#1e2d32] border-[#1e2d32] text-[#bfc8cc]"
                }`}
              >
                <span>{r.emoji}</span>
                <span>{r.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Chat tab ─────────────────────────────────────────────────────────────────

const CHANNEL_CONFIG: Record<ChatChannel, { label: string; icon: string; desc: string }> = {
  general:  { label: "General",  icon: "💬", desc: "General hockey talk" },
  picks:    { label: "Picks",    icon: "🎯", desc: "Share your picks" },
  analysis: { label: "Analysis", icon: "📊", desc: "Deep dives & stats" },
  live:     { label: "Live",     icon: "🔴", desc: "In-game reactions" },
};

function ChatTab() {
  const [channel, setChannel] = useState<ChatChannel>("general");
  const [messages, setMessages] = useState<Record<ChatChannel, ChatMessage[]>>(MOCK_MESSAGES);
  const [input, setInput] = useState("");
  const [tag, setTag] = useState<"pick" | "analysis" | undefined>(undefined);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const currentMessages = messages[channel];
  const CURRENT_USER_ID = "u1";

  // Scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [channel, currentMessages.length]);

  function sendMessage() {
    const text = input.trim();
    if (!text) return;

    const newMsg: ChatMessage = {
      id: `m${Date.now()}`,
      userId: CURRENT_USER_ID,
      username: "jdupont",
      displayName: "Jean Dupont",
      avatar: "🏒",
      tier: "sharp",
      text,
      sentAt: new Date().toISOString(),
      reactions: [],
      tag,
      replyTo: replyTo ? { username: replyTo.username, text: replyTo.text } : undefined,
    };

    setMessages((prev) => ({
      ...prev,
      [channel]: [...prev[channel], newMsg],
    }));
    setInput("");
    setTag(undefined);
    setReplyTo(null);
  }

  function handleReact(msgId: string, emoji: string) {
    setMessages((prev) => ({
      ...prev,
      [channel]: prev[channel].map((m) => {
        if (m.id !== msgId) return m;
        const reactions = (m.reactions ?? []).map((r) =>
          r.emoji === emoji
            ? { ...r, count: r.reacted ? r.count - 1 : r.count + 1, reacted: !r.reacted }
            : r
        );
        return { ...m, reactions };
      }),
    }));
  }

  const channels = Object.entries(CHANNEL_CONFIG) as [ChatChannel, typeof CHANNEL_CONFIG[ChatChannel]][];

  return (
    <div className="flex flex-col gap-0" style={{ height: "calc(100vh - 200px)" }}>
      {/* Channel selector */}
      <div className="flex gap-1.5 overflow-x-auto pb-2 scrollbar-hide flex-shrink-0">
        {channels.map(([key, cfg]) => (
          <button
            key={key}
            onClick={() => setChannel(key)}
            className={`flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-[10px] font-medium transition-all ${
              channel === key
                ? "bg-[#86d1ea] text-[#0f1416] border-[#86d1ea] font-bold"
                : "bg-[#141c1f] text-[#bfc8cc] border-[#1e2d32]"
            }`}
          >
            <span>{cfg.icon}</span>
            <span>{cfg.label}</span>
            {key === "live" && (
              <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            )}
          </button>
        ))}
      </div>

      {/* Channel description */}
      <p className="text-[#bfc8cc] text-[9px] mb-2 flex-shrink-0">
        {CHANNEL_CONFIG[channel].icon} {CHANNEL_CONFIG[channel].desc}
      </p>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto flex flex-col gap-3 py-2 min-h-0">
        {currentMessages.map((msg) => (
          <MessageBubble
            key={msg.id}
            msg={msg}
            isOwn={msg.userId === CURRENT_USER_ID}
            onReact={handleReact}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Reply preview */}
      {replyTo && (
        <div className="flex items-center gap-2 bg-[#1e2d32] rounded-xl px-3 py-2 mb-2 flex-shrink-0">
          <div className="flex-1 min-w-0">
            <p className="text-[#86d1ea] text-[9px] font-medium">Replying to @{replyTo.username}</p>
            <p className="text-[#bfc8cc] text-[9px] truncate">{replyTo.text}</p>
          </div>
          <button onClick={() => setReplyTo(null)} className="text-[#bfc8cc] text-xs flex-shrink-0">✕</button>
        </div>
      )}

      {/* Tag selector + input */}
      <div className="flex-shrink-0 mt-1">
        {/* Tag pills */}
        <div className="flex gap-1.5 mb-2">
          {(["pick", "analysis"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTag(tag === t ? undefined : t)}
              className={`px-2 py-1 rounded-full text-[9px] border transition-all ${
                tag === t
                  ? TAG_STYLE[t]
                  : "text-[#bfc8cc] border-[#1e2d32]"
              }`}
            >
              {TAG_LABEL[t]}
            </button>
          ))}
          <span className="text-[#bfc8cc] text-[9px] self-center ml-1">
            {tag ? `Tagged as ${TAG_LABEL[tag]}` : "Optional tag"}
          </span>
        </div>

        {/* Input row */}
        <div className="flex items-center gap-2 bg-[#141c1f] border border-[#1e2d32] rounded-2xl px-3 py-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage()}
            placeholder={`Message #${channel}…`}
            className="flex-1 bg-transparent text-white text-xs outline-none placeholder-[#bfc8cc]"
          />
          <button
            onClick={sendMessage}
            disabled={!input.trim()}
            className={`w-7 h-7 rounded-xl flex items-center justify-center text-sm transition-all flex-shrink-0 ${
              input.trim()
                ? "bg-[#86d1ea] text-[#0f1416]"
                : "bg-[#1e2d32] text-[#bfc8cc]"
            }`}
          >
            ↑
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

type Tab = "leaderboard" | "chat";

export function LeaguePage() {
  const [tab, setTab] = useState<Tab>("leaderboard");
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    profileApiService.getLeaderboard().then((data) => {
      setLeaderboard(data);
      setLoading(false);
    });
  }, []);

  const tabs: { key: Tab; label: string; icon: string }[] = [
    { key: "leaderboard", label: "Rankings", icon: "🏆" },
    { key: "chat",        label: "Community", icon: "💬" },
  ];

  return (
    <div className="flex flex-col min-h-screen bg-[#0f1416] text-white max-w-[430px] mx-auto">
      {/* Header */}
      <header className="px-4 pt-12 pb-3 bg-[#0f1416] sticky top-0 z-40 border-b border-[#1e2d32]">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-white text-xl font-bold">League</h1>
            <p className="text-[#bfc8cc] text-xs">Rankings & community</p>
          </div>
          {tab === "chat" && (
            <div className="flex items-center gap-1.5 bg-green-500/10 border border-green-500/30 rounded-full px-2.5 py-1">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              <span className="text-green-400 text-[9px] font-medium">24 online</span>
            </div>
          )}
        </div>

        {/* Tab switcher */}
        <div className="flex gap-1 bg-[#141c1f] rounded-xl p-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[10px] font-medium transition-all ${
                tab === t.key
                  ? "bg-[#86d1ea] text-[#0f1416] font-bold"
                  : "text-[#bfc8cc]"
              }`}
            >
              <span>{t.icon}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </header>

      <div className={`flex-1 px-4 pb-28 pt-4 ${tab === "chat" ? "overflow-hidden flex flex-col" : "overflow-y-auto"}`}>
        {tab === "leaderboard" && (
          loading ? (
            <div className="flex flex-col gap-3">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-14 bg-[#141c1f] rounded-2xl animate-pulse" />
              ))}
            </div>
          ) : (
            <FullLeaderboard entries={leaderboard} />
          )
        )}
        {tab === "chat" && <ChatTab />}
      </div>

      <BottomNav />
    </div>
  );
}