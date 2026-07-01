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
  tier: "rookie" | "analyst" | "sharp" | "legend";
  performanceScore: number;
  openaiApiKey?: string | null;
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
  tier: UserProfile["tier"];
  performanceScore: number;
  hitRate: number;
  totalBets: number;
  isCurrentUser?: boolean;
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  avatar: string;
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
  isLive?: boolean;
  isPinned?: boolean;
  memberCount: number;
  lastMessage?: string;
  lastMessag