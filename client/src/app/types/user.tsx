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

/**
 * Edge minimum par défaut d'une alerte value bet, en % entiers.
 *
 * Doit rester égal à `DEFAULT_MIN_EDGE_PCT` côté serveur
 * (`profile.service.ts`) et au DEFAULT de la colonne posé par la migration 035.
 * 2 % est le plancher que le scan applique déjà (`MIN_EDGE`) : en dessous,
 * aucune alerte n'est émise de toute façon.
 */
export const DEFAULT_MIN_EDGE_PCT = 2;


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
  /** Minimum edge (whole %) required before a value-bet alert is sent — Pro only */
  valueBetMinEvPct?: number;
  tier: "rookie" | "analyst" | "sharp" | "legend";
  performanceScore: number;
  /**
   * Une clé OpenAI est-elle enregistrée sur ce compte ? Le serveur ne renvoie
   * PAS la clé — il ne dit que son existence (voir `getProfileById`). Elle reste
   * écrivable via `updateProfile`, d'où l'asymétrie assumée entre ce type et le
   * type de mise à jour dans `userService`.
   */
  hasOpenaiKey?: boolean;
  /**
   * Pondération des règles rattachée au compte : famille de pari →
   * { idFacteur → poids 0-100 }. Miroir de `FamilyStore` côté
   * `ruleWeightsService` ; le type plat d'avant ne décrivait pas ce qui est
   * réellement stocké en base (`user_profiles.rule_weights`, migration 017).
   */
  ruleWeights?: Record<string, Record<string, number>> | null;
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

// ── Modération du chat — PRE_IOS_PLAN.md R4 ──────────────────────────────────

/**
 * Motifs de signalement. ⚠️ Cette liste existe à TROIS endroits : ici, dans
 * `REPORT_REASONS` (server/src/services/chat.service.ts) et dans le CHECK de la
 * migration 032. En ajouter un demande de toucher aux trois.
 */
export const REPORT_REASONS = ["spam", "harassment", "hate", "sexual", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** Une personne que l'utilisateur courant a bloquée. */
export interface BlockedUser {
  id: string;
  username: string;
  displayName: string;
  avatar: string;
  avatarUrl: string | null;
  createdAt: string;
}

/**
 * Une entrée de la file de modération — un MESSAGE, pas un signalement :
 * le serveur regroupe, donc trois personnes qui signalent le même message
 * posent une seule question à l'admin.
 */
export interface ModerationQueueItem {
  reportId: number;
  messageId: string;
  reportCount: number;
  reasons: ReportReason[];
  notes: string[];
  firstReportedAt: string;
  lastReportedAt: string;
  roomId: string;
  roomName: string | null;
  text: string;
  sentAt: string;
  authorId: string | null;
  authorUsername: string | null;
  hiddenAt: string | null;
  hiddenReason: string | null;
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
