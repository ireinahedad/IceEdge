import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Star } from "lucide-react";
import { predictionApiService } from "../../services/predictionApiService";
import { nhlLogoUrl } from "../../data/teamEmoji";
import type { BetLeg } from "../../types/bet";
import { useBet } from "../../context/BetContext";
import { ProLock } from "../../components/ProLock";
import { useI18n } from "../../i18n";
import type { DisplayGame, TennisMatch } from "./types";

// ─── Best Bets ─────────────────────────────────────────────────────────────────

const BB_BASE = import.meta.env.VITE_PREDICTION_API_URL || "";

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
type SortDir    = "safe"  | "risky";

function riskLabel(pct: number): { key: string; color: string } {
  if (pct >= 70) return { key: "risk.safe",     color: "#22ff00" };
  if (pct >= 55) return { key: "risk.moderate", color: "#90C9F0" };
  if (pct >= 40) return { key: "risk.risky",    color: "#facc15" };
  return              { key: "risk.high",      color: "#f87171" };
}

function BestBetRow({ bet, sortSource }: { bet: BestBet; sortSource: SortSource }) {
  const { addLeg, removeLeg, hasLeg } = useBet();
  const { t } = useI18n();
  const inSlip = hasLeg(bet.id);
  const displayPct = sortSource === "ml" ? (bet.mlPct ?? bet.rulePct) : bet.rulePct;
  const risk = riskLabel(displayPct);
  const isML = sortSource === "ml" && bet.mlPct != null;

  return (
    <div className="flex items-center gap-2.5 icy-card rounded-xl px-2.5 py-1.5">
      {bet.logo?.startsWith("http")
        ? <img src={bet.logo} alt="" className="w-5 h-5 object-contain flex-shrink-0" />
        : <span className="text-base flex-shrink-0">{bet.logo}</span>}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-white text-[11px] font-medium truncate">{bet.label}</span>
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
          {isML && <span className="text-[8px] text-[#a78bfa] flex-shrink-0 font-medium">ML</span>}
          {sortSource === "ml" && !bet.mlLoading && bet.mlPct == null &&
            <span className="text-[8px] text-[#bfc8cc] flex-shrink-0">{t("home.rules")}</span>}
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
  tennisLive,
  tennisUpcoming,
  sport,
  accent,
  isLoading,
  locked = false,
}: {
  games: DisplayGame[];
  tennisLive: TennisMatch[];
  tennisUpcoming: TennisMatch[];
  sport: "hockey" | "tennis";
  accent: string;
  isLoading: boolean;
  locked?: boolean;
}) {
  const { t, lang } = useI18n();
  const [sortSource, setSortSource] = useState<SortSource>("ml");
  const [sortDir,    setSortDir]    = useState<SortDir>("safe");
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

  // When hockey has no games (e.g. off-season), fall back to tennis matches
  const usingTennisFallback = sport === "hockey" && games.length === 0 && (tennisLive.length > 0 || tennisUpcoming.length > 0);

  // Build the bets list.
  //  · Hockey → fetch the pre-ranked, all-markets best bets from the backend
  //    (team + player props, scored by rules + ML, sorted by prediction score).
  //  · Tennis / hockey off-season fallback → build from match data client-side.
  useEffect(() => {
    if (locked) return;             // don't fetch Pro-only data for free users
    let cancelled = false;

    // Tennis (or hockey off-season fallback showing tennis)
    if (sport === "tennis" || usingTennisFallback) {
      const raw: BestBet[] = [];
      for (const m of [...tennisLive, ...tennisUpcoming]) {
        const ctx = `${m.tournament} · ${m.isLive ? t("home.live") : m.time}`;
        raw.push({
          id: `bb-tennis-${m.id}-p1`, label: t("bb.playerWin", { name: m.player1.name }), context: ctx,
          logo: m.player1.country, rulePct: m.player1.winPct, mlPct: null, mlLoading: false,
          leg: { id: `bb-tennis-${m.id}-p1`, marketType: "tennis_match_winner", marketLabel: "Match Winner",
            subjectType: "player", subjectId: m.id, subjectName: m.player1.name,
            subjectLogo: m.player1.country, selection: `${m.player1.name} to win`,
            selectionShort: `${m.player1.name.split(" ").pop()} W`,
            probability: m.player1.winPct, gameInfo: ctx, addedAt: new Date().toISOString() },
        });
        raw.push({
          id: `bb-tennis-${m.id}-p2`, label: t("bb.playerWin", { name: m.player2.name }), context: ctx,
          logo: m.player2.country, rulePct: m.player2.winPct, mlPct: null, mlLoading: false,
          leg: { id: `bb-tennis-${m.id}-p2`, marketType: "tennis_match_winner", marketLabel: "Match Winner",
            subjectType: "player", subjectId: m.id, subjectName: m.player2.name,
            subjectLogo: m.player2.country, selection: `${m.player2.name} to win`,
            selectionShort: `${m.player2.name.split(" ").pop()} W`,
            probability: m.player2.winPct, gameInfo: ctx, addedAt: new Date().toISOString() },
        });
      }
      setBets(raw);
      setMlFetched(false); // tennis still uses the lazy per-bet ML fetch
      return;
    }

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
  }, [games, tennisLive, tennisUpcoming, sport, lang, usingTennisFallback, locked]);

  // Lazy ML fetch when ML tab selected
  useEffect(() => {
    if (locked || sortSource !== "ml" || mlFetched || bets.length === 0 || !BB_BASE) return;
    setMlFetched(true);
    setBets(prev => prev.map(b => ({ ...b, mlLoading: true })));

    bets.slice(0, 20).forEach(async (bet) => {
      try {
        const body: Record<string, unknown> = { type: sport === "hockey" ? "game" : "tennis", subjectId: bet.teamId ?? bet.gameId ?? bet.id };
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
  }, [sortSource, mlFetched, bets, sport]);

  const sorted = useMemo(() => {
    const src = (b: BestBet) => sortSource === "ml" ? (b.mlPct ?? b.rulePct) : b.rulePct;
    return [...bets].sort((a, b) => sortDir === "safe" ? src(b) - src(a) : src(a) - src(b)).slice(0, 15);
  }, [bets, sortSource, sortDir]);

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
          {usingTennisFallback && <span className="text-[10px] text-[#facc15] bg-[#facc15]/10 border border-[#facc15]/20 px-1.5 py-0.5 rounded-full">{t("home.tennisOffseason")}</span>}
        </button>
        {!collapsed && (
        <div className="flex items-center gap-1.5">
          {/* Source toggle */}
          <div className="flex icy-tile rounded-full p-0.5 gap-0.5">
            {(["rules", "ml"] as SortSource[]).map((s) => (
              <button key={s} onClick={() => setSortSource(s)}
                className={`px-2.5 py-0.5 rounded-full text-[10px] font-medium transition-all ${sortSource === s ? "text-[#072E49] font-bold" : "text-[#8a9ea6]"}`}
                style={sortSource === s ? { backgroundColor: s === "ml" ? "#a78bfa" : "#22ff00" } : {}}>
                {s === "ml" ? "ML" : t("home.rules")}
              </button>
            ))}
          </div>
          {/* Direction toggle */}
          <button onClick={() => setSortDir(d => d === "safe" ? "risky" : "safe")}
            className="px-2.5 py-1 rounded-full icy-tile text-[10px] text-[#8a9ea6] hover:text-white transition-all">
            {sortDir === "safe" ? t("home.safe") : t("home.risky")}
          </button>
        </div>
        )}
      </div>

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
