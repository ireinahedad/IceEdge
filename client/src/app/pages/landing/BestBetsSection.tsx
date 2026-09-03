/**
 * BestBetsSection.tsx
 *
 * Extrait de HockeyLanding.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { useState, useEffect, useMemo } from "react";
import { ChevronRight, Star } from "lucide-react";
import { predictionApiService } from "../../services/predictionApiService";
import type { BetLeg } from "../../types/bet";
import { useBet } from "../../context/BetContext";
import { ProLock } from "../../components/ProLock";
import { useI18n } from "../../i18n";
import { nhlLogoUrl } from "../../data/teamEmoji";
import { DisplayGame } from "./landingTypes";
import { env } from "../../env";


// ─── Best Bets ─────────────────────────────────────────────────────────────────

const BB_BASE = env.predictionApiUrl;

interface BestBet {
  id: string;
  label: string;
  context: string;
  logo: string;
  rulePct: number;
  mlPct: number | null;
  mlLoading: boolean;
  leg: BetLeg;
  gameId?: string;
  teamId?: string;
}

type SortSource = "rules" | "ml";
type RiskTier   = "safe" | "moderate" | "risky" | "high";
type SortOrder  = "safest" | "riskiest";

const RISK_TIERS: { tier: RiskTier; key: string; color: string }[] = [
  { tier: "safe",     key: "risk.safe",     color: "#86d1ea" },
  { tier: "moderate", key: "risk.moderate", color: "#90C9F0" },
  { tier: "risky",    key: "risk.risky",    color: "#facc15" },
  { tier: "high",     key: "risk.high",     color: "#f87171" },
];

function riskLabel(pct: number): { tier: RiskTier; key: string; color: string } {
  if (pct >= 70) return RISK_TIERS[0];
  if (pct >= 55) return RISK_TIERS[1];
  if (pct >= 40) return RISK_TIERS[2];
  return RISK_TIERS[3];
}

/** Cote **équitable** déduite de la probabilité du modèle — sans marge, et sans
 * rapport avec un prix de bookmaker. Affichée pour donner un ordre de grandeur du
 * gain sur les marchés que bet365 ne couvre pas tous. Le `≈` seul ne suffisait pas
 * à le dire : la pastille porte désormais une infobulle explicite. */
function impliedOdds(pct: number): number | null {
  if (pct <= 0 || pct >= 100) return null;
  return Math.round((100 / pct) * 100) / 100;
}

function BestBetRow({ bet, sortSource }: { bet: BestBet; sortSource: SortSource }) {
  const { addLeg, removeLeg, hasLeg } = useBet();
  const { t } = useI18n();
  const inSlip = hasLeg(bet.id);
  const displayPct = sortSource === "ml" ? (bet.mlPct ?? bet.rulePct) : bet.rulePct;
  const risk = riskLabel(displayPct);
  const odds = impliedOdds(displayPct);
  const isML = sortSource === "ml" && bet.mlPct != null;

  return (
    <div className="flex items-center gap-2.5 icy-card rounded-xl px-2.5 py-1.5">
      {bet.logo?.startsWith("http")
        ? <img src={bet.logo} alt="" className="w-5 h-5 object-contain flex-shrink-0" />
        : <span className="text-base flex-shrink-0">{bet.logo}</span>}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Full bet title always visible — no truncation, wraps if long */}
          <span className="text-white text-[11px] font-medium">{bet.label}</span>
          <span className="text-[8px] px-1 py-px rounded-full flex-shrink-0 font-medium"
            style={{ color: risk.color, backgroundColor: `${risk.color}18`, border: `1px solid ${risk.color}44` }}>
            {t(risk.key)}
          </span>
          <span className="text-[#8a9ea6] text-[9px] truncate">· {bet.context}</span>
        </div>
        <div className="flex items-center gap-2 mt-1">
          <div className="flex-1 bg-[#0A0E0C] rounded-full h-1 overflow-hidden">
            <div className="h-full rounded-full transition-all duration-500"
              style={{ width: `${displayPct}%`, backgroundColor: isML ? "#a78bfa" : risk.color }} />
          </div>
          <span className="text-[10px] font-bold flex-shrink-0 tabular-nums"
            style={{ color: isML ? "#a78bfa" : risk.color }}>
            {sortSource === "ml" && bet.mlLoading ? "…" : `${displayPct}%`}
          </span>
          {odds != null && (
            <span
              title={t("home.oddsFairHint")}
              className="text-[9px] font-semibold flex-shrink-0 tabular-nums text-[#bfc8cc] bg-white/5 px-1.5 py-px rounded-full cursor-help">
              {t("home.oddsApprox", { odds: odds.toFixed(2) })}
            </span>
          )}
        </div>
      </div>

      <button
        onClick={() => inSlip ? removeLeg(bet.id) : addLeg({ ...bet.leg, probability: displayPct })}
        className={`w-7 h-7 rounded-lg border flex items-center justify-center text-sm flex-shrink-0 transition-colors ${
          inSlip
            ? "bg-green-500/15 border-green-500/30 text-green-400"
            : "bg-[#90C9F0]/10 border-[#90C9F0]/30 text-[#90C9F0] active:bg-[#90C9F0]/20"
        }`}
      >
        {inSlip ? "✓" : "+"}
      </button>
    </div>
  );
}

export function BestBetsSection({
  games,
  accent,
  isLoading,
  locked = false,
}: {
  games: DisplayGame[];
  accent: string;
  isLoading: boolean;
  locked?: boolean;
}) {
  const { t, lang } = useI18n();
  const [sortSource, setSortSource] = useState<SortSource>("ml");
  const [sortOrder,  setSortOrder]  = useState<SortOrder>("safest");
  // Risk-tier filters are combinable (multi-select) instead of an exclusive
  // toggle, so users can view e.g. "risky" and "high" payout picks together,
  // or leave everything selected to see safe and risky bets side by side.
  const [riskFilter, setRiskFilter] = useState<Set<RiskTier>>(new Set(["safe", "moderate", "risky", "high"]));
  const toggleRisk = (tier: RiskTier) => setRiskFilter(prev => {
    const next = new Set(prev);
    if (next.has(tier)) next.delete(tier); else next.add(tier);
    return next;
  });
  const [bets, setBets]             = useState<BestBet[]>([]);
  const [mlFetched,  setMlFetched]  = useState(false);
  const [collapsed,  setCollapsed]  = useState<boolean>(() => {
    try { return localStorage.getItem("iceedge_bestbets_collapsed") === "1"; }
    catch { return false; }
  });
  const toggleCollapsed = () => setCollapsed(c => {
    const next = !c;
    try { localStorage.setItem("iceedge_bestbets_collapsed", next ? "1" : "0"); }
    catch { /* ignore */ }
    return next;
  });

  // Construit la liste : l'endpoint best-bets du serveur (tous marchés, règles +
  // ML, déjà trié). Le repli « hors-saison » sur des matchs de tennis est parti
  // avec le tennis, le 2026-08-24 : hors saison, la section est simplement vide.
  useEffect(() => {
    if (locked) return;             // don't fetch Pro-only data for free users
    let cancelled = false;

    // Hockey → backend best-bets endpoint (all markets, rules + ML, pre-sorted)
    (async () => {
      try {
        // Fetch a larger pool (both rule + ML scores) so the Rules/ML toggle
        // re-ranks honestly client-side; the list itself still shows the top 15.
        const { bets: apiBets } = await predictionApiService.getBestBets({ limit: 30, source: "ml" });
        if (cancelled) return;
        const mapped: BestBet[] = apiBets.map((b) => {
          const logo = b.teamAbbr ? nhlLogoUrl(b.teamAbbr) : b.subjectLogo;
          return {
            id: b.id, label: b.label, context: b.context, logo,
            rulePct: b.rulePct, mlPct: b.mlPct, mlLoading: false,
            gameId: b.gameId ?? undefined, teamId: b.teamId ?? undefined,
            leg: {
              id: b.id, marketType: b.marketType, marketLabel: b.marketLabel,
              subjectType: b.subjectType, subjectId: b.subjectId, subjectName: b.subjectName,
              subjectLogo: logo, selection: b.selection, selectionShort: b.selectionShort,
              probability: b.score, line: b.line ?? undefined,
              gameInfo: b.context, addedAt: new Date().toISOString(),
              // Machine-readable fields for automatic settlement.
              gameId: b.gameId ?? undefined,
              selectionValue: b.selectionValue,
            },
          };
        });
        setBets(mapped);
        setMlFetched(true); // scores already include ML — skip the lazy per-bet fetch
      } catch {
        if (!cancelled) { setBets([]); setMlFetched(true); }
      }
    })();

    return () => { cancelled = true; };
  }, [games, lang, locked]);

  // Lazy ML fetch when ML tab selected
  useEffect(() => {
    if (locked || sortSource !== "ml" || mlFetched || bets.length === 0 || !BB_BASE) return;
    setMlFetched(true);
    setBets(prev => prev.map(b => ({ ...b, mlLoading: true })));

    bets.slice(0, 20).forEach(async (bet) => {
      try {
        const body: Record<string, unknown> = { type: "game", subjectId: bet.teamId ?? bet.gameId ?? bet.id };
        if (bet.teamId) body.opponentId = bet.gameId;
        const res = await fetch(`${BB_BASE}/predict/ml`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (res.ok) {
          const data = await res.json() as { probability?: number };
          setBets(prev => prev.map(b => b.id === bet.id ? { ...b, mlPct: Math.round(data.probability ?? bet.rulePct), mlLoading: false } : b));
        } else {
          setBets(prev => prev.map(b => b.id === bet.id ? { ...b, mlLoading: false } : b));
        }
      } catch {
        setBets(prev => prev.map(b => b.id === bet.id ? { ...b, mlLoading: false } : b));
      }
    });
  }, [sortSource, mlFetched, bets]);

  const sorted = useMemo(() => {
    const src = (b: BestBet) => sortSource === "ml" ? (b.mlPct ?? b.rulePct) : b.rulePct;
    // Empty selection = no filter applied (show every risk tier), so users
    // can never accidentally hide the whole list by deselecting every chip.
    const filtered = riskFilter.size === 0
      ? bets
      : bets.filter(b => riskFilter.has(riskLabel(src(b)).tier));
    return [...filtered]
      .sort((a, b) => sortOrder === "safest" ? src(b) - src(a) : src(a) - src(b))
      .slice(0, 15);
  }, [bets, sortSource, sortOrder, riskFilter]);

  // Pro-only: free users see the section title but the picks are locked/blurred.
  if (locked) {
    return (
      <section className="px-4 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <Star size={13} style={{ color: accent }} />
          <span className="text-white text-sm font-medium">{t("home.bestBets")}</span>
        </div>
        <ProLock locked title={t("home.bestBets")} description={t("home.bestBetsLockDesc")}>
          <div className="flex flex-col gap-1.5">
            {["TOR ML", "Over 5.5", "McDavid 2+ pts", "BOS ML", "Under 6.5"].map((label, i) => (
              <div key={i} className="flex items-center gap-2.5 icy-card rounded-xl px-2.5 py-2">
                <span className="text-base flex-shrink-0">🏒</span>
                <div className="flex-1 min-w-0">
                  <div className="text-white text-[11px] font-medium">{label}</div>
                  <div className="h-1 mt-1 rounded-full" style={{ width: `${70 - i * 6}%`, background: accent, opacity: 0.6 }} />
                </div>
                <span className="text-[10px] font-bold" style={{ color: accent }}>{72 - i * 5}%</span>
              </div>
            ))}
          </div>
        </ProLock>
      </section>
    );
  }

  return (
    <section className="px-4 mb-6">
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={toggleCollapsed}
          className="flex items-center gap-2 select-none"
          aria-expanded={!collapsed}
          title={collapsed ? t("home.show") : t("home.hide")}
        >
          <ChevronRight
            size={14}
            className="text-[#8a9ea6] transition-transform"
            style={{ transform: collapsed ? "rotate(0deg)" : "rotate(90deg)" }}
          />
          <Star size={13} style={{ color: accent }} />
          <span className="text-white text-sm font-medium">{t("home.bestBets")}</span>
          {!isLoading && <span className="text-[10px] text-[#bfc8cc] icy-tile px-1.5 py-0.5 rounded-full">{t("home.top", { n: sorted.length })}</span>}
        </button>
        {!collapsed && (
        <div className="flex items-center gap-1.5">
          {/* Source toggle — which score (rules vs ML) drives display + filtering */}
          <div className="flex icy-tile rounded-full p-0.5 gap-0.5">
            {(["rules", "ml"] as SortSource[]).map((s) => (
              <button key={s} onClick={() => setSortSource(s)}
                className={`px-2.5 py-0.5 rounded-full text-[10px] font-medium transition-all ${sortSource === s ? "text-[#072E49] font-bold" : "text-[#8a9ea6]"}`}
                style={sortSource === s ? { backgroundColor: s === "ml" ? "#a78bfa" : "#86d1ea" } : {}}>
                {s === "ml" ? "ML" : t("home.rules")}
              </button>
            ))}
          </div>
          {/* Sort order — only reorders the (already-filtered) list, never hides anything */}
          <button onClick={() => setSortOrder(o => o === "safest" ? "riskiest" : "safest")}
            className="px-2.5 py-1 rounded-full icy-tile text-[10px] text-[#8a9ea6] hover:text-white transition-all whitespace-nowrap">
            {sortOrder === "safest" ? t("home.safe") : t("home.risky")}
          </button>
        </div>
        )}
      </div>

      {/* Risk-tier filters — combinable checkboxes, not exclusive tabs, so
          safe and risky (higher-payout) bets can be viewed together. */}
      {!collapsed && (
        <div className="flex items-center gap-1.5 mb-3 flex-wrap">
          {RISK_TIERS.map(({ tier, key, color }) => {
            const active = riskFilter.size === 0 || riskFilter.has(tier);
            return (
              <button
                key={tier}
                onClick={() => toggleRisk(tier)}
                className="px-2 py-1 rounded-full text-[9px] font-semibold transition-all border"
                style={active
                  ? { color, backgroundColor: `${color}1a`, borderColor: `${color}55` }
                  : { color: "#5a6660", backgroundColor: "transparent", borderColor: "rgba(255,255,255,0.08)" }}
              >
                {t(key)}
              </button>
            );
          })}
        </div>
      )}

      {!collapsed && (isLoading ? (
        <div className="flex flex-col gap-1.5">
          {[1,2,3,4,5].map(i => <div key={i} className="h-12 icy-tile rounded-xl animate-pulse" />)}
        </div>
      ) : sorted.length === 0 ? (
        <div className="py-8 text-center text-[#bfc8cc] text-xs">{t("home.noBets")}</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {sorted.map(bet => <BestBetRow key={bet.id} bet={bet} sortSource={sortSource} />)}
        </div>
      ))}
    </section>
  );
}
