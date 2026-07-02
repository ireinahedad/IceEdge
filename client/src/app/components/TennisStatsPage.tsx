import { Search, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import {
  tennisApiService,
  TennisApiMatch,
  TennisRankingEntry,
  TennisTournamentInfo,
} from "../services/tennisApiService";
import { useBet } from "../context/BetContext";
import type { BetLeg } from "../types/bet";
import { useI18n } from "../i18n";

// ─── Types & constants ────────────────────────────────────────────────────────

interface TennisSurface {
  name: string; icon: string; topPlayer: string; avgWinPct: number; desc: string;
}

const TENNIS_FILTER_TAB_KEYS = ["tennis.byPlayer", "tennis.byMatch", "tennis.bySurface", "tennis.byTournament"];

const TENNIS_SURFACES: TennisSurface[] = [
  { name: "Clay",  icon: "🟫", topPlayer: "I. Swiatek",  avgWinPct: 72, desc: "Slower bounces, long rallies" },
  { name: "Hard",  icon: "🟦", topPlayer: "J. Sinner",   avgWinPct: 68, desc: "All-round game, power favoured" },
  { name: "Grass", icon: "🟩", topPlayer: "N. Djokovic", avgWinPct: 65, desc: "Fast & low — serve-volley era" },
];

const FALLBACK_ATP: TennisRankingEntry[] = [
  { pos: 1, points: 11245, player: { id: "djokovic", name: "N. Djokovic",  country: "🇷🇸", countryCode: "SRB" } },
  { pos: 2, points: 9870,  player: { id: "sinner",   name: "J. Sinner",    country: "🇮🇹", countryCode: "ITA" } },
  { pos: 3, points: 9680,  player: { id: "alcaraz",  name: "C. Alcaraz",   country: "🇪🇸", countryCode: "ESP" } },
  { pos: 4, points: 7210,  player: { id: "medvedev", name: "D. Medvedev",  country: "🇷🇺", countryCode: "RUS" } },
  { pos: 5, points: 6920,  player: { id: "zverev",   name: "A. Zverev",    country: "🇩🇪", countryCode: "GER" } },
  { pos: 6, points: 5840,  player: { id: "rune",     name: "H. Rune",      country: "🇩🇰", countryCode: "DEN" } },
  { pos: 7, points: 5120,  player: { id: "fritz",    name: "T. Fritz",     country: "🇺🇸", countryCode: "USA" } },
  { pos: 8, points: 4830,  player: { id: "ruud",     name: "C. Ruud",      country: "🇳🇴", countryCode: "NOR" } },
];

const FALLBACK_WTA: TennisRankingEntry[] = [
  { pos: 1, points: 12230, player: { id: "swiatek",   name: "I. Swiatek",   country: "🇵🇱", countryCode: "POL" } },
  { pos: 2, points: 9450,  player: { id: "sabalenka", name: "A. Sabalenka", country: "🇧🇾", countryCode: "BLR" } },
  { pos: 3, points: 7820,  player: { id: "gauff",     name: "C. Gauff",     country: "🇺🇸", countryCode: "USA" } },
  { pos: 4, points: 6340,  player: { id: "rybakina",  name: "E. Rybakina",  country: "🇰🇿", countryCode: "KAZ" } },
  { pos: 5, points: 5870,  player: { id: "zheng",     name: "Q. Zheng",     country: "🇨🇳", countryCode: "CHN" } },
  { pos: 6, points: 5210,  player: { id: "paolini",   name: "J. Paolini",   country: "🇮🇹", countryCode: "ITA" } },
  { pos: 7, points: 4930,  player: { id: "navarro",   name: "E. Navarro",   country: "🇺🇸", countryCode: "USA" } },
  { pos: 8, points: 4560,  player: { id: "badosa",    name: "P. Badosa",    country: "🇪🇸", countryCode: "ESP" } },
];

const FALLBACK_TOURNAMENTS: TennisTournamentInfo[] = [
  { id: "rg",        name: "Roland Garros",  surface: "Clay",  surfaceIcon: "🟫", location: "Paris, France",   prize: "$51.9M", startDate: "2025-05-25", endDate: "2025-06-08" },
  { id: "wimbledon", name: "Wimbledon",       surface: "Grass", surfaceIcon: "🟩", location: "London, UK",      prize: "$50.0M", startDate: "2025-06-30", endDate: "2025-07-13" },
  { id: "uso",       name: "US Open",         surface: "Hard",  surfaceIcon: "🟦", location: "New York, USA",   prize: "$65.0M", startDate: "2025-08-25", endDate: "2025-09-07" },
  { id: "ao",        name: "Australian Open", surface: "Hard",  surfaceIcon: "🟦", location: "Melbourne, AUS",  prize: "$54.2M", startDate: "2026-01-12", endDate: "2026-01-26" },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Estimate win % from ranking position (rank 1 ≈ 82%, drops ~2% per rank) */
function rankToWinPct(pos: number): number {
  return Math.max(35, Math.min(85, 84 - (pos - 1) * 2));
}

/** Format ISO datetime to HH:MM */
function fmtMatchTime(iso?: string): string {
  if (!iso) return "TBD";
  try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  catch { return "TBD"; }
}

/** Format ISO date range for tournaments */
function fmtDateRange(start?: string, end?: string): string {
  if (!start) return "";
  const fmt = (s: string) => {
    try { return new Date(s).toLocaleDateString([], { month: "short", day: "numeric" }); }
    catch { return s; }
  };
  return end ? fmt(start) + " – " + fmt(end) : fmt(start);
}

/** Compute head-to-head win probabilities from ranking points */
function calcTennisProbs(
  p1name: string,
  p2name: string,
  rankings: (TennisRankingEntry & { tour: "ATP" | "WTA" })[],
) {
  const lastName = (n: string) => n.split(/[.\s]/).pop()?.toLowerCase() ?? "";
  const r1 = rankings.find((r) => r.player.name.toLowerCase().includes(lastName(p1name)));
  const r2 = rankings.find((r) => r.player.name.toLowerCase().includes(lastName(p2name)));

  let p1Win = 55;
  if (r1 && r2) {
    const total = r1.points + r2.points || 1;
    p1Win = Math.round(Math.max(20, Math.min(80, (r1.points / total) * 100)));
  }
  const p2Win = 100 - p1Win;
  const balance = 1 - Math.abs(p1Win - 50) / 50;
  const overSets = Math.round(35 + balance * 35);
  const p1FirstSet = Math.round(50 + (p1Win - 50) * 0.70);

  return {
    p1Win, p2Win,
    overSets, underSets: 100 - overSets,
    p1FirstSet, p2FirstSet: 100 - p1FirstSet,
  };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TennisRankingCard({ entry, tour, accent, onPress }: { entry: TennisRankingEntry; tour: "ATP" | "WTA"; accent: string; onPress?: () => void }) {
  return (
    <div onClick={onPress} className="w-full bg-[#131A12]/70 backdrop-blur-md border border-white/20 rounded-2xl p-4 flex items-center gap-3 cursor-pointer active:opacity-70">
      <div className="w-11 h-11 rounded-xl bg-[#1B2419] flex flex-col items-center justify-center flex-shrink-0">
        <span className="text-[9px] text-[#bfc8cc] uppercase tracking-wider">{tour}</span>
        <span className="text-white text-lg font-bold leading-none">#{entry.pos}</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-base">{entry.player.country}</span>
          <p className="text-white text-sm font-medium truncate">{entry.player.name}</p>
        </div>
        <p className="text-[#bfc8cc] text-xs">{entry.points.toLocaleString()} pts</p>
      </div>
      <span className="text-[#bfc8cc] text-base flex-shrink-0">›</span>
    </div>
  );
}

function TennisTournamentCard({ t, accent }: { t: TennisTournamentInfo; accent: string }) {
  const dateRange = fmtDateRange(t.startDate, t.endDate);
  return (
    <div className="w-full bg-[#131A12]/70 backdrop-blur-md border border-white/20 rounded-2xl p-4">
      <div className="flex items-start gap-3">
        <div className="w-11 h-11 rounded-xl bg-[#1B2419] flex items-center justify-center text-2xl flex-shrink-0">🏆</div>
        <div className="flex-1 min-w-0">
          <p className="text-white text-sm font-medium">{t.name}</p>
          {(t.location || dateRange) && (
            <p className="text-[#bfc8cc] text-xs mt-0.5">{[t.location, dateRange].filter(Boolean).join(" · ")}</p>
          )}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span className="text-[10px] px-2 py-0.5 rounded-full" style={{ color: accent, backgroundColor: `${accent}1a` }}>{t.surfaceIcon} {t.surface}</span>
            {t.prize && <span className="text-[#bfc8cc] text-[10px]">Prize: {t.prize}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function TennisSurfaceCard({ s, accent }: { s: TennisSurface; accent: string }) {
  const { t } = useI18n();
  return (
    <div className="w-full bg-[#131A12]/70 backdrop-blur-md border border-white/20 rounded-2xl p-4">
      <div className="flex items-center gap-3 mb-3">
        <span className="text-3xl">{s.icon}</span>
        <div className="flex-1">
          <p className="text-white text-sm font-medium">{t("tennis.surfaceCourt", { name: s.name })}</p>
          <p className="text-[#bfc8cc] text-xs">{s.desc}</p>
        </div>
        <div className="px-2.5 py-1 rounded-full text-xs font-bold" style={{ backgroundColor: `${accent}20`, color: accent }}>{s.avgWinPct}%</div>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-[#bfc8cc] text-xs">{t("tennis.topPerformer")}</span>
        <span className="text-white text-xs font-medium">{s.topPlayer}</span>
      </div>
      <div className="w-full bg-[#0A0E0C] rounded-full h-1.5 mt-2">
        <div className="h-1.5 rounded-full" style={{ width: `${s.avgWinPct}%`, backgroundColor: accent }} />
      </div>
    </div>
  );
}

function TennisBetMatchCard({
  m, accent, allRankings,
}: {
  m: TennisApiMatch;
  accent: string;
  allRankings: (TennisRankingEntry & { tour: "ATP" | "WTA" })[];
}) {
  const { addLeg, hasLeg } = useBet();
  const { t } = useI18n();
  const timeLabel = m.isLive ? (m.liveSet ?? t("home.live")) : fmtMatchTime(m.scheduledIso);
  const probs = calcTennisProbs(m.player1.name, m.player2.name, allRankings);
  const shortName = (n: string) => n.split(/[.\s]/).filter(Boolean).pop() ?? n;

  interface MarketBtn {
    legId: string;
    name: string;
    flag: string;
    prob: number;
    leg: Omit<BetLeg, "addedAt">;
  }

  const markets: { title: string; desc: string; btns: [MarketBtn, MarketBtn] }[] = [
    {
      title: "Match Winner",
      desc: "Who wins the match",
      btns: [
        {
          legId: `tennis-${m.id}-mw-p1`,
          name: shortName(m.player1.name),
          flag: m.player1.country,
          prob: probs.p1Win,
          leg: { id: `tennis-${m.id}-mw-p1`, marketType: "tennis_match_winner", marketLabel: "Match Winner", subjectType: "game", subjectId: m.id, subjectName: m.player1.name, subjectLogo: m.player1.country, selection: `${m.player1.name} to win`, selectionShort: `${shortName(m.player1.name)} ML`, probability: probs.p1Win, gameInfo: `${m.player1.name} vs ${m.player2.name}` },
        },
        {
          legId: `tennis-${m.id}-mw-p2`,
          name: shortName(m.player2.name),
          flag: m.player2.country,
          prob: probs.p2Win,
          leg: { id: `tennis-${m.id}-mw-p2`, marketType: "tennis_match_winner", marketLabel: "Match Winner", subjectType: "game", subjectId: m.id, subjectName: m.player2.name, subjectLogo: m.player2.country, selection: `${m.player2.name} to win`, selectionShort: `${shortName(m.player2.name)} ML`, probability: probs.p2Win, gameInfo: `${m.player1.name} vs ${m.player2.name}` },
        },
      ],
    },
    {
      title: "Total Sets",
      desc: "Will the match go to a deciding set?",
      btns: [
        {
          legId: `tennis-${m.id}-ts-over`,
          name: "Over 2.5",
          flag: "🎾",
          prob: probs.overSets,
          leg: { id: `tennis-${m.id}-ts-over`, marketType: "tennis_total_sets", marketLabel: "Total Sets", subjectType: "game", subjectId: m.id, subjectName: "Over 2.5 Sets", subjectLogo: "🎾", selection: "Over 2.5 sets", selectionShort: "O 2.5 Sets", probability: probs.overSets, line: 2.5, gameInfo: `${m.player1.name} vs ${m.player2.name}` },
        },
        {
          legId: `tennis-${m.id}-ts-under`,
          name: "Under 2.5",
          flag: "🎾",
          prob: probs.underSets,
          leg: { id: `tennis-${m.id}-ts-under`, marketType: "tennis_total_sets", marketLabel: "Total Sets", subjectType: "game", subjectId: m.id, subjectName: "Under 2.5 Sets", subjectLogo: "🎾", selection: "Under 2.5 sets", selectionShort: "U 2.5 Sets", probability: probs.underSets, line: 2.5, gameInfo: `${m.player1.name} vs ${m.player2.name}` },
        },
      ],
    },
    {
      title: "First Set Winner",
      desc: "Who wins the opening set",
      btns: [
        {
          legId: `tennis-${m.id}-fs-p1`,
          name: shortName(m.player1.name),
          flag: m.player1.country,
          prob: probs.p1FirstSet,
          leg: { id: `tennis-${m.id}-fs-p1`, marketType: "tennis_first_set", marketLabel: "First Set Winner", subjectType: "game", subjectId: m.id, subjectName: m.player1.name, subjectLogo: m.player1.country, selection: `${m.player1.name} wins 1st set`, selectionShort: `${shortName(m.player1.name)} 1st Set`, probability: probs.p1FirstSet, gameInfo: `${m.player1.name} vs ${m.player2.name}` },
        },
        {
          legId: `tennis-${m.id}-fs-p2`,
          name: shortName(m.player2.name),
          flag: m.player2.country,
          prob: probs.p2FirstSet,
          leg: { id: `tennis-${m.id}-fs-p2`, marketType: "tennis_first_set", marketLabel: "First Set Winner", subjectType: "game", subjectId: m.id, subjectName: m.player2.name, subjectLogo: m.player2.country, selection: `${m.player2.name} wins 1st set`, selectionShort: `${shortName(m.player2.name)} 1st Set`, probability: probs.p2FirstSet, gameInfo: `${m.player1.name} vs ${m.player2.name}` },
        },
      ],
    },
  ];

  return (
    <div className="w-full bg-[#131A12]/70 backdrop-blur-md border border-white/20 rounded-2xl overflow-hidden">
      <div className="px-4 pt-3 pb-2.5 flex items-center justify-between border-b border-white/[0.06]">
        <div className="flex items-center gap-2 min-w-0">
          {m.isLive
            ? <span className="text-[10px] text-red-400 font-medium uppercase tracking-wide flex items-center gap-1 flex-shrink-0">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse inline-block" />{timeLabel}
              </span>
            : <span className="text-[11px] font-semibold flex-shrink-0" style={{ color: accent }}>{timeLabel}</span>}
          <span className="text-[#4a5a62] text-[10px]">·</span>
          <span className="text-[#8a9ea6] text-[10px] truncate">{m.tournament}</span>
        </div>
        <span className="text-[10px] px-2 py-0.5 rounded-full flex-shrink-0 ml-2" style={{ color: accent, backgroundColor: `${accent}1a` }}>{m.surfaceIcon} {m.surface}</span>
      </div>

      <div className="px-4 py-3 flex items-center gap-3">
        <div className="flex-1 flex items-center gap-2">
          <span className="text-2xl">{m.player1.country}</span>
          <div>
            <p className="text-white text-sm font-semibold leading-tight">{m.player1.name}</p>
            {m.player1.sets
              ? <p className="text-[11px] font-bold mt-0.5" style={{ color: accent }}>{m.player1.sets.join("-")} sets</p>
              : <p className="text-[11px] font-bold mt-0.5" style={{ color: accent }}>{probs.p1Win}% win</p>}
          </div>
        </div>
        <div className="flex flex-col items-center gap-0.5">
          <span className="text-[#8a9ea6] text-xs font-medium">vs</span>
        </div>
        <div className="flex-1 flex items-center gap-2 justify-end">
          <div className="text-right">
            <p className="text-white text-sm font-semibold leading-tight">{m.player2.name}</p>
            {m.player2.sets
              ? <p className="text-[11px] font-bold mt-0.5 text-right" style={{ color: accent }}>{m.player2.sets.join("-")} sets</p>
              : <p className="text-[11px] font-bold mt-0.5 text-right" style={{ color: accent }}>{probs.p2Win}% win</p>}
          </div>
          <span className="text-2xl">{m.player2.country}</span>
        </div>
      </div>

      <div className="px-4 pb-3 flex items-center gap-2">
        <span className="text-[10px] font-bold w-8 flex-shrink-0" style={{ color: accent }}>{probs.p1Win}%</span>
        <div className="flex-1 bg-[#0A0E0C] rounded-full h-1.5 overflow-hidden flex">
          <div className="h-full rounded-l-full transition-all" style={{ width: `${probs.p1Win}%`, backgroundColor: accent }} />
        </div>
        <span className="text-[#8a9ea6] text-[10px] font-bold w-8 text-right flex-shrink-0">{probs.p2Win}%</span>
      </div>

      <div className="border-t border-white/[0.06]">
        {markets.map((mkt, mi) => (
          <div key={mkt.title} className={`px-4 py-3 ${mi > 0 ? "border-t border-white/[0.04]" : ""}`}>
            <div className="flex items-baseline gap-2 mb-2">
              <p className="text-white text-xs font-semibold">{mkt.title}</p>
              <p className="text-[#8a9ea6] text-[10px]">{mkt.desc}</p>
            </div>
            <div className="flex gap-2">
              {mkt.btns.map((btn) => {
                const added = hasLeg(btn.legId);
                return (
                  <button
                    key={btn.legId}
                    onClick={() => addLeg({ ...btn.leg, addedAt: new Date().toISOString() })}
                    className="flex-1 flex flex-col items-center justify-center py-2.5 px-2 rounded-xl border transition-all active:scale-95"
                    style={added
                      ? { backgroundColor: `${accent}20`, borderColor: `${accent}60` }
                      : { backgroundColor: "#0d1519", borderColor: "#ffffff12" }}
                  >
                    <span className="text-base mb-0.5">{btn.flag}</span>
                    <span className="text-white text-[11px] font-semibold">{btn.name}</span>
                    <span className="text-[12px] font-bold mt-0.5" style={{ color: accent }}>{btn.prob}%</span>
                    {added && <span className="text-[9px] mt-0.5" style={{ color: accent }}>{t("tennis.added")}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function TennisStatsContent({ accent }: { accent: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [activeFilter, setActiveFilter] = useState(0);
  const [search, setSearch] = useState("");
  const [tourFilter, setTourFilter] = useState<"ALL" | "ATP" | "WTA">("ALL");

  const [atpRankings,  setAtpRankings]  = useState<TennisRankingEntry[]>([]);
  const [wtaRankings,  setWtaRankings]  = useState<TennisRankingEntry[]>([]);
  const [rankLoading,  setRankLoading]  = useState(false);
  const [rankError,    setRankError]    = useState<string | null>(null);

  const [liveMatches,  setLiveMatches]  = useState<TennisApiMatch[]>([]);
  const [fixtures,     setFixtures]     = useState<TennisApiMatch[]>([]);
  const [matchLoading, setMatchLoading] = useState(false);
  const [matchError,   setMatchError]   = useState<string | null>(null);

  const [tournaments,  setTournaments]  = useState<TennisTournamentInfo[]>([]);
  const [tourLoading,  setTourLoading]  = useState(false);

  useEffect(() => {
    if (activeFilter !== 0) return;
    if (atpRankings.length > 0) return;
    setRankLoading(true);
    setRankError(null);
    Promise.all([
      tennisApiService.getRankings("ATP"),
      tennisApiService.getRankings("WTA"),
    ]).then(([atp, wta]) => {
      setAtpRankings(atp.length > 0 ? atp : FALLBACK_ATP);
      setWtaRankings(wta.length > 0 ? wta : FALLBACK_WTA);
      setRankLoading(false);
    }).catch(() => {
      setAtpRankings(FALLBACK_ATP);
      setWtaRankings(FALLBACK_WTA);
      setRankLoading(false);
    });
  }, [activeFilter]);

  useEffect(() => {
    if (activeFilter !== 1) return;
    if (liveMatches.length > 0 || fixtures.length > 0) return;
    setMatchLoading(true);
    setMatchError(null);

    async function fetchTennisWithFallback(): Promise<TennisApiMatch[]> {
      const today = new Date();
      try {
        const fix = await tennisApiService.getFixtures(today);
        if (fix.length > 0) return fix;
      } catch { /* fall through */ }
      try {
        const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
        const fix = await tennisApiService.getFixtures(tomorrow);
        if (fix.length > 0) return fix;
      } catch { /* fall through */ }
      try {
        const weekFixes = await Promise.all(
          [2,3,4,5,6,7].map(n => {
            const d = new Date(today); d.setDate(today.getDate() + n);
            return tennisApiService.getFixtures(d).catch(() => [] as TennisApiMatch[]);
          })
        );
        return weekFixes.flat();
      } catch { return []; }
    }

    Promise.all([
      tennisApiService.getLiveMatches().catch(() => [] as TennisApiMatch[]),
      fetchTennisWithFallback(),
    ]).then(([live, fix]) => {
      setLiveMatches(live);
      setFixtures(fix);
      setMatchLoading(false);
    }).catch((err) => {
      setMatchError(err.message ?? t("tennis.loadFail"));
      setMatchLoading(false);
    });
  }, [activeFilter]);

  useEffect(() => {
    if (activeFilter !== 3) return;
    if (tournaments.length > 0) return;
    setTourLoading(true);
    tennisApiService.getTournaments().then((data) => {
      setTournaments(data.length > 0 ? data : FALLBACK_TOURNAMENTS);
      setTourLoading(false);
    }).catch(() => {
      setTournaments(FALLBACK_TOURNAMENTS);
      setTourLoading(false);
    });
  }, [activeFilter]);

  const allRankings: (TennisRankingEntry & { tour: "ATP" | "WTA" })[] = [
    ...atpRankings.map((e) => ({ ...e, tour: "ATP" as const })),
    ...wtaRankings.map((e) => ({ ...e, tour: "WTA" as const })),
  ];

  const filteredRankings = allRankings.filter((p) => {
    if (tourFilter !== "ALL" && p.tour !== tourFilter) return false;
    if (search) return p.player.name.toLowerCase().includes(search.toLowerCase());
    return true;
  });

  const allMatches = [...liveMatches, ...fixtures];
  const filteredMatches = allMatches.filter((m) =>
    !search ||
    m.player1.name.toLowerCase().includes(search.toLowerCase()) ||
    m.player2.name.toLowerCase().includes(search.toLowerCase()) ||
    m.tournament.toLowerCase().includes(search.toLowerCase())
  );

  function LoadingDot() {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3">
        <div className="w-10 h-10 rounded-full bg-[#131A12] border border-white/20 flex items-center justify-center">
          <div className="w-4 h-4 rounded-full bg-[#86d1ea]/20 border border-[#86d1ea]/40 animate-pulse" />
        </div>
        <p className="text-[#bfc8cc] text-sm">{t("tennis.loading")}</p>
      </div>
    );
  }

  function ErrorCard({ msg, onRetry }: { msg: string; onRetry: () => void }) {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <p className="text-red-400 text-sm text-center">{msg}</p>
        <button onClick={onRetry} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full"
          style={{ backgroundColor: `${accent}20`, color: accent }}>
          <RefreshCw size={12} /> {t("tennis.retry")}
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="bg-[#131A12] border border-white/20 rounded-2xl flex items-center gap-2 px-3 py-2.5 mb-3">
        <Search size={14} className="text-[#8a9ea6] flex-shrink-0" />
        <input className="flex-1 bg-transparent text-white text-sm outline-none placeholder:text-[#bfc8cc]"
          placeholder={t("tennis.searchPlaceholder")} value={search} onChange={(e) => setSearch(e.target.value)} />
        {search && <button onClick={() => setSearch("")} className="text-[#bfc8cc] text-xs">×</button>}
      </div>
      <div className="flex gap-1.5 overflow-x-auto scrollbar-hide pb-0.5 mb-3">
        {TENNIS_FILTER_TAB_KEYS.map((tabKey, i) => (
          <button key={tabKey} onClick={() => setActiveFilter(i)} className="flex-shrink-0 px-4 py-2 rounded-full text-xs font-medium transition-all"
            style={activeFilter === i ? { backgroundColor: accent, color: "#0f1416", fontWeight: 700 } : { backgroundColor: "#1B2419", color: "#bfc8cc" }}>
            {t(tabKey)}
          </button>
        ))}
      </div>

      {/* ── By Player ── */}
      {activeFilter === 0 && (
        <div className="flex flex-col gap-3">
          <div className="flex gap-2 items-center">
            {(["ALL", "ATP", "WTA"] as const).map((t) => (
              <button key={t} onClick={() => setTourFilter(t)} className="px-4 py-1.5 rounded-full text-xs font-medium transition-all border"
                style={tourFilter === t ? { backgroundColor: `${accent}20`, color: accent, borderColor: `${accent}50` } : { backgroundColor: "transparent", color: "#bfc8cc", borderColor: "#ffffff15" }}>
                {t}
              </button>
            ))}
            {!rankLoading && <span className="ml-auto text-[#bfc8cc] text-xs">{t("tennis.players", { n: filteredRankings.length })}</span>}
          </div>
          {rankLoading && <LoadingDot />}
          {rankError && (
            <ErrorCard msg={rankError} onRetry={() => {
              setAtpRankings([]); setWtaRankings([]); setRankError(null);
              setActiveFilter(-1); setTimeout(() => setActiveFilter(0), 0);
            }} />
          )}
          {!rankLoading && !rankError && filteredRankings.map((e) => (
            <TennisRankingCard key={`${e.tour}-${e.pos}`} entry={e} tour={e.tour} accent={accent}
              onPress={() => navigate(`/stats/prediction/tennis-player/${e.player.id}`, { state: { player: e } })} />
          ))}
        </div>
      )}

      {/* ── By Match ── */}
      {activeFilter === 1 && (
        <div className="flex flex-col gap-2">
          {matchLoading && <LoadingDot />}
          {matchError && (
            <ErrorCard msg={matchError} onRetry={() => {
              setLiveMatches([]); setFixtures([]); setMatchError(null);
              setActiveFilter(-1); setTimeout(() => setActiveFilter(1), 0);
            }} />
          )}
          {!matchLoading && !matchError && (
            <>
              {liveMatches.length > 0 && (
                <div className="mb-1">
                  <span className="text-[10px] text-red-400 font-medium uppercase tracking-wide flex items-center gap-1 mb-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse inline-block" />
                    {t("tennis.liveNowCount", { n: liveMatches.length })}
                  </span>
                  {liveMatches
                    .filter((m) => !search || m.player1.name.toLowerCase().includes(search.toLowerCase()) || m.player2.name.toLowerCase().includes(search.toLowerCase()))
                    .map((m) => <TennisBetMatchCard key={m.id} m={m} accent={accent} allRankings={allRankings} />)}
                </div>
              )}
              {fixtures.length > 0 && (
                <div>
                  <span className="text-[10px] text-[#bfc8cc] font-medium uppercase tracking-wide block mb-2">{t("tennis.upcomingToday")}</span>
                  {filteredMatches.filter((m) => !m.isLive).map((m) => <TennisBetMatchCard key={m.id} m={m} accent={accent} allRankings={allRankings} />)}
                </div>
              )}
              {allMatches.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-10">
                  <p className="text-white text-sm font-medium">{t("tennis.noMatches")}</p>
                  <p className="text-[#bfc8cc] text-xs text-center">{t("tennis.checkBack")}</p>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── By Surface ── */}
      {activeFilter === 2 && (
        <div className="flex flex-col gap-3">
          <p className="text-[#bfc8cc] text-xs">{t("tennis.surfaceAccuracy")}</p>
          {TENNIS_SURFACES.map((s) => <TennisSurfaceCard key={s.name} s={s} accent={accent} />)}
        </div>
      )}

      {/* ── By Tournament ── */}
      {activeFilter === 3 && (
        <div className="flex flex-col gap-3">
          {tourLoading && <LoadingDot />}
          {!tourLoading && tournaments.length === 0 && (
            <p className="text-[#bfc8cc] text-xs text-center py-4">{t("tennis.noTournData")}</p>
          )}
          {!tourLoading && tournaments.map((t) => <TennisTournamentCard key={t.id} t={t} accent={accent} />)}
        </div>
      )}
    </>
  );
}
