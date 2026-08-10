/**
 * Profile / User API Service
 *
 * Configure via environment variable:
 *   VITE_PROFILE_API_URL=https://your-server.com/api
 *
 * Falls back to mock data when not configured.
 *
 * Expected endpoints:
 *   GET  /api/users/me                  → UserProfile
 *   GET  /api/users/me/bets             → BetRecord[]
 *   GET  /api/users/me/stats            → UserBettingStats
 *   GET  /api/leaderboard               → LeaderboardEntry[]
 *   PATCH /api/users/me                 → UserProfile (update)
 */

import type { BetMarketType } from "./../types/bet";


export type BadgeId =
  | "sharp_shooter" | "parlay_king" | "streak_master"
  | "ice_analyst"   | "underdog_hunter" | "consistency"
  | "early_adopter" | "mvp";

export interface UserBadge {
  id: BadgeId;
  label: string;
  description: string;
  icon: string;
  earnedAt: string;
  tier: "bronze" | "silver" | "gold" | "platinum";
}

// ─── User ─────────────────────────────────────────────────────────────────────

export interface UserProfile {
  id: string;
  username: string;
  displayName: string;
  avatar: string;
  avatarUrl?: string | null;
  joinedAt: string;
  favoriteTeam?: string;
  bio?: string;
  isPublic: boolean;
  /** Let other players see my bet slips */
  showSlips?: boolean;
  /** Receive value-bet (+EV) notifications — Pro only */
  notifyValueBets?: boolean;
  /** Minimum +EV edge (whole %) required before a value-bet alert is sent — Pro only */
  valueBetMinEvPct?: number;
  tier: "rookie" | "analyst" | "sharp" | "legend";
  performanceScore: number;
  openaiApiKey?: string | null;
  ruleWeights?: Record<string, number> | null;
  badges: UserBadge[];
}

// ─── Stats ────────────────────────────────────────────────────────────────────

export interface UserBettingStats {
  totalBets: number;
  wins: number;
  losses: number;
  pending: number;
  hitRate: number;
  avgProbability: number;
  calibrationScore: number;
  currentStreak: number;
  longestWinStreak: number;
  parlayRecord: { wins: number; losses: number };
  bestMarketType: BetMarketType;
  bestMarketHitRate: number;
  monthlyStats: { month: string; bets: number; hitRate: number }[];
  marketBreakdown: { marketType: BetMarketType; label: string; bets: number; hitRate: number }[];
}

// ─── Bet history ──────────────────────────────────────────────────────────────

export interface BetRecord {
  id: string;
  placedAt: string;
  marketType: BetMarketType;
  marketLabel: string;
  selection: string;
  selectionShort: string;
  subjectName: string;
  subjectLogo: string;
  probability: number;
  isParlay: boolean;
  parlayLegs?: number;
  outcome: "win" | "loss" | "pending";
  gameInfo?: string;
}

// ─── Leaderboard ──────────────────────────────────────────────────────────────

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  avatarUrl?: string | null;
  tier: UserProfile["tier"];
  performanceScore: number;
  hitRate: number;
  totalBets: number;
  isCurrentUser?: boolean;
}

// ─── Coupons d'un autre joueur (page joueur, réservée aux abonnés Pro) ───────

/** Issue d'une jambe, écrite par le règlement automatique. */
export type LegResult = "win" | "loss" | "unknown";

export interface PublicSlipLeg {
  marketType: string;
  subjectId?: string;
  subjectName: string;
  subjectLogo?: string;
  selection?: string;
  line?: number;
  probability: number;
  oddsLabel?: string;
  gameId?: string;
  /**
   * Absent sur les coupons réglés AVANT la persistance des résultats par jambe :
   * ces jambes s'affichent « non évaluées », jamais perdantes.
   */
  result?: LegResult;
}

export interface PublicSlip {
  id: string;
  placedAt: string;
  sport: string;
  /** `null` quand le coupon est verrouillé — le serveur ne les envoie pas. */
  legs: PublicSlipLeg[] | null;
  legCount: number;
  isParlay: boolean;
  combinedProbability: number | null;
  outcome: "win" | "loss" | "pending";
  resolvedAt: string | null;
  xpAwarded: number;
  /** Mise au jeu du premier match. `null` = horaire inconnu. */
  locksAt: string | null;
  /** Sélections masquées : le match n'a pas commencé. */
  locked?: boolean;
}

export interface PlayerFormStats {
  windowDays: number;
  minSample: number;
  settled: number;
  wins: number;
  /** `null` sous le plancher d'échantillon — ne pas afficher de pourcentage. */
  hitRate: number | null;
}

export interface PlayerSummary {
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  avatarUrl: string | null;
  tier: UserProfile["tier"];
  /** Forme récente, mise en avant. */
  form: PlayerFormStats;
  /** Cumul sur tout ce qui est visible. `since` = date de coupure. */
  overall: {
    since: string | null;
    settled: number;
    wins: number;
    hitRate: number | null;
  };
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  avatarUrl?: string | null;
  tier: UserProfile["tier"];
  text: string;
  sentAt: string;
  reactions?: { emoji: string; count: number; reacted: boolean }[];
  replyTo?: { username: string; text: string };
  tag?: "pick" | "analysis" | "hot";
}

export interface ChatRoom {
  id: string;
  name: string;
  icon: string;
  description: string;
  /** Accent color chosen by the creator (#RRGGBB), or null for the default */
  color?: string | null;
  isLive?: boolean;
  /** Pinned by the current user (per-user, not global) */
  isPinned?: boolean;
  /** Private rooms are only visible/joinable via their join code */
  isPrivate?: boolean;
  /** Join code — only returned to members */
  joinCode?: string | null;
  /** Whether the current user is a member */
  isMember?: boolean;
  /** Current user's role in the room */
  role?: "admin" | "member" | null;
  memberCount: number;
  lastMessage?: string | null;
  lastMessageAt?: string | null;
  unread?: number;
  messages?: ChatMessage[];
}

export interface ChatRoomMember {
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
  avatarUrl?: string | null;
  role: "admin" | "member";
  joinedAt: string;
}
