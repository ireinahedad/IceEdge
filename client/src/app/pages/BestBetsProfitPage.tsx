/**
 * BestBetsProfitPage — « combien j'aurais gagné en misant X $ sur chaque best bet ».
 * Route : /dev/profit   (admin uniquement, comme /dev/ml et /dev/moderation)
 *
 * Lit `best_bet_log` (migration 042) via GET /api/dev/best-bets-profit. Le
 * serveur règle au passage les paris dont le match est fini, avec la même
 * logique que les coupons.
 *
 * QUI COMPTE COMME « BEST BET DU JOUR »
 *   La liste de l'accueil bouge au fil de la journée. Un pari compte pour le
 *   top N s'il y a atteint un rang ≤ N AU MOINS UNE FOIS avant son match
 *   (`bestRank`). Le jour est celui du match (heure de l'Est).
 *
 * COTES
 *   Seuls les paris de match (moneyline, puck line) ont un vrai prix de livre ;
 *   les props joueur n'en ont presque jamais. Par défaut ils sont EXCLUS du
 *   calcul — leur appliquer une cote fixe est possible, mais c'est une
 *   hypothèse, et la page le dit.
 *
 * Tout le calcul est local : changer la mise ou le top N ne refait pas d'appel.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine } from "recharts";
import { RefreshCw, ChevronDown, ChevronRight } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { profileApiService, type BestBetLogRow, type BestBetsProfitResponse } from "../services/userService";

// ─── Réglages ────────────────────────────────────────────────────────────────

const TOP_CHOICES = [3, 5, 10, 15, 30] as const;
const PERIODS = [
  { key: "7",   label: "7 j",   days: 7 },
  { key: "30",  label: "30 j",  days: 30 },
  { key: "90",  label: "90 j",  days: 90 },
  { key: "all", label: "Tout",  days: null },
] as const;
type PeriodKey = (typeof PERIODS)[number]["key"];
type PriceMode = "first" | "last";
type UnpricedMode = "exclude" | "fixed";

const GREEN = "#4ade80";
const RED   = "#f87171";
const ICE   = "#86d1ea";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Jour NHL (heure de l'Est), décalé de `n` jours. */
function etDay(n = 0): string {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function americanToDecimal(am: number): number | null {
  if (!Number.isFinite(am) || Math.abs(am) < 100) return null;
  return am > 0 ? 1 + am / 100 : 1 + 100 / Math.abs(am);
}

function decimalToAmerican(dec: number): string {
  if (dec >= 2) return `+${Math.round((dec - 1) * 100)}`;
  return `${Math.round(-100 / (dec - 1))}`;
}

const money = (v: number) =>
  `${v < 0 ? "−" : v > 0 ? "+" : ""}${Math.abs(v).toLocaleString("fr-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
const plain = (v: number) =>
  `${v.toLocaleString("fr-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;

function dayLabel(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString("fr-CA", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

interface Priced {
  row:    BestBetLogRow;
  price:  number | null;   // cote décimale utilisée ; null = exclu
  assumed: boolean;        // cote fixe appliquée faute de prix réel
  pnl:    number | null;   // null = pas compté (en attente ou exclu)
}

interface DayTotals {
  date: string;
  bets: Priced[];
  staked: number; pnl: number;
  wins: number; losses: number; voids: number; pending: number; excluded: number;
}

// ─── Page ────────────────────────────────────────────────────────────────────

export function BestBetsProfitPage() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();

  const [stake, setStake]           = useState("20");
  const [top, setTop]               = useState<number>(10);
  const [period, setPeriod]         = useState<PeriodKey>("30");
  const [priceMode, setPriceMode]   = useState<PriceMode>("first");
  const [unpriced, setUnpriced]     = useState<UnpricedMode>("exclude");
  const [fixedAm, setFixedAm]       = useState("-110");
  const [data, setData]             = useState<BestBetsProfitResponse | null>(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const [open, setOpen]             = useState<Record<string, boolean>>({});

  // Le serveur refuse déjà tout non-admin (403) ; ce renvoi est de la courtoisie.
  useEffect(() => {
    if (!authLoading && user && user.role !== "admin") navigate("/", { replace: true });
  }, [authLoading, user, navigate]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const days = PERIODS.find((p) => p.key === period)?.days ?? null;
    const from = days == null ? "2020-01-01" : etDay(-(days - 1));
    try {
      setData(await profileApiService.getBestBetsProfit(from, etDay(1)));
    } catch (e: any) {
      setError(e?.message ?? "Impossible de charger le journal des best bets");
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { void load(); }, [load]);

  const stakeNum = Math.max(0, Number(stake.replace(",", ".")) || 0);
  const fixedDec = americanToDecimal(Number(fixedAm));

  const { days, total, chart } = useMemo(() => {
    const rows = (data?.rows ?? []).filter((r) => r.bestRank <= top);
    const byDay = new Map<string, DayTotals>();

    for (const row of rows) {
      const real = priceMode === "first" ? (row.firstPrice ?? row.lastPrice) : (row.lastPrice ?? row.firstPrice);
      const assumed = real == null && unpriced === "fixed" && fixedDec != null;
      const price = real ?? (assumed ? fixedDec : null);

      let pnl: number | null = null;
      if (row.outcome !== "pending" && price != null) {
        pnl = row.outcome === "win" ? stakeNum * (price - 1) : row.outcome === "loss" ? -stakeNum : 0;
      }

      let d = byDay.get(row.gameDate);
      if (!d) {
        d = { date: row.gameDate, bets: [], staked: 0, pnl: 0, wins: 0, losses: 0, voids: 0, pending: 0, excluded: 0 };
        byDay.set(row.gameDate, d);
      }
      d.bets.push({ row, price, assumed, pnl });
      if (row.outcome === "pending") d.pending++;
      else if (price == null) d.excluded++;
      else {
        if (row.outcome === "win") d.wins++;
        if (row.outcome === "loss") d.losses++;
        if (row.outcome === "void") d.voids++;
        if (row.outcome !== "void") d.staked += stakeNum;
        d.pnl += pnl ?? 0;
      }
    }

    const days = [...byDay.values()].sort((a, b) => b.date.localeCompare(a.date));
    for (const d of days) d.bets.sort((a, b) => a.row.bestRank - b.row.bestRank);

    const total = days.reduce(
      (acc, d) => ({
        staked: acc.staked + d.staked, pnl: acc.pnl + d.pnl,
        wins: acc.wins + d.wins, losses: acc.losses + d.losses, voids: acc.voids + d.voids,
        pending: acc.pending + d.pending, excluded: acc.excluded + d.excluded,
        assumed: acc.assumed + d.bets.filter((b) => b.assumed && b.pnl != null).length,
      }),
      { staked: 0, pnl: 0, wins: 0, losses: 0, voids: 0, pending: 0, excluded: 0, assumed: 0 },
    );

    let run = 0;
    const chart = [...days]
      .reverse()
      .filter((d) => d.wins + d.losses + d.voids > 0)
      .map((d) => { run += d.pnl; return { date: d.date, label: dayLabel(d.date), pnl: +run.toFixed(2) }; });

    return { days, total, chart };
  }, [data, top, priceMode, unpriced, fixedDec, stakeNum]);

  const roi = total.staked > 0 ? (100 * total.pnl) / total.staked : null;
  const decided = total.wins + total.losses;

  return (
    <div className="flex flex-col min-h-screen text-white max-w-[900px] mx-auto px-4 sm:px-5 pt-14 pb-16" style={{ background: "#0A0E0C" }}>
      {/* En-tête */}
      <div className="flex items-center gap-3 mb-1">
        <button onClick={() => navigate(-1)} className="tap-44 text-[#bfc8cc] text-lg" aria-label="Retour">←</button>
        <h1 className="text-white text-base font-bold flex-1">Profit des Best Bets</h1>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="tap-44 text-[#bfc8cc] disabled:opacity-40"
          aria-label="Recharger"
        >
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      <p className="text-white/40 text-[10px] mb-5 leading-relaxed">
        Si tu avais misé la même somme sur chaque pari entré dans le top {top} de l'accueil, avant son match.
        Admin uniquement.
      </p>

      {/* Réglages */}
      <div className="icy-card rounded-2xl p-4 flex flex-col gap-4 mb-4">
        <div className="flex flex-wrap gap-4 items-end">
          <label className="flex flex-col gap-1">
            <span className="text-white/50 text-[10px] uppercase tracking-wide">Mise par pari</span>
            <span className="flex items-center gap-1.5 bg-white/5 border border-white/10 rounded-lg px-3 py-2">
              <input
                inputMode="decimal"
                value={stake}
                onChange={(e) => setStake(e.target.value)}
                className="bg-transparent w-16 text-white text-sm font-bold outline-none"
              />
              <span className="text-white/50 text-sm">$</span>
            </span>
          </label>

          <Segmented
            label="Top"
            value={String(top)}
            options={TOP_CHOICES.map((n) => ({ key: String(n), label: String(n) }))}
            onChange={(k) => setTop(Number(k))}
          />
          <Segmented
            label="Période"
            value={period}
            options={PERIODS.map((p) => ({ key: p.key, label: p.label }))}
            onChange={(k) => setPeriod(k as PeriodKey)}
          />
        </div>

        <div className="flex flex-wrap gap-4 items-end">
          <Segmented
            label="Cote utilisée"
            value={priceMode}
            options={[{ key: "first", label: "1re apparition" }, { key: "last", label: "Avant le match" }]}
            onChange={(k) => setPriceMode(k as PriceMode)}
          />
          <Segmented
            label="Paris sans cote"
            value={unpriced}
            options={[{ key: "exclude", label: "Exclure" }, { key: "fixed", label: "Cote fixe" }]}
            onChange={(k) => setUnpriced(k as UnpricedMode)}
          />
          {unpriced === "fixed" && (
            <label className="flex flex-col gap-1">
              <span className="text-white/50 text-[10px] uppercase tracking-wide">Cote (américaine)</span>
              <input
                inputMode="numeric"
                value={fixedAm}
                onChange={(e) => setFixedAm(e.target.value)}
                className={`bg-white/5 border rounded-lg px-3 py-2 w-24 text-white text-sm font-bold outline-none ${fixedDec == null ? "border-red-500/60" : "border-white/10"}`}
              />
            </label>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 text-red-300 text-xs p-3 mb-4">{error}</div>
      )}
      {data?.settle.error && (
        <div className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 text-yellow-200 text-[11px] p-3 mb-4">
          Règlement interrompu ({data.settle.error}) — certains paris restent « en attente ».
        </div>
      )}

      {/* Résumé */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Stat
          label="Profit net"
          value={money(total.pnl)}
          color={total.pnl > 0 ? GREEN : total.pnl < 0 ? RED : undefined}
          big
        />
        <Stat label="Total misé" value={plain(total.staked)} />
        <Stat
          label="ROI"
          value={roi == null ? "—" : `${roi >= 0 ? "+" : ""}${roi.toFixed(1)} %`}
          color={roi == null ? undefined : roi >= 0 ? GREEN : RED}
        />
        <Stat
          label="Bilan"
          value={`${total.wins}-${total.losses}${total.voids ? `-${total.voids}` : ""}`}
          sub={decided ? `${((100 * total.wins) / decided).toFixed(0)} % réussis` : undefined}
        />
      </div>

      <div className="text-white/45 text-[10px] mb-4 leading-relaxed flex flex-wrap gap-x-4 gap-y-1">
        {total.pending > 0 && <span>{total.pending} en attente de résultat</span>}
        {total.excluded > 0 && <span>{total.excluded} réglés mais exclus (pas de cote du livre)</span>}
        {total.assumed > 0 && (
          <span className="text-yellow-200/80">{total.assumed} comptés avec la cote fixe {fixedAm} (hypothèse)</span>
        )}
        {data && data.settle.settled > 0 && <span>{data.settle.settled} réglés à l'instant</span>}
      </div>

      {/* Courbe cumulée */}
      {chart.length >= 2 && (
        <div className="icy-card rounded-2xl p-3 pr-1 mb-4">
          <div className="text-white/50 text-[10px] uppercase tracking-wide px-1 mb-2">Profit cumulé</div>
          <div style={{ width: "100%", height: 180 }}>
            <ResponsiveContainer>
              <LineChart data={chart} margin={{ top: 6, right: 12, bottom: 0, left: -12 }}>
                <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
                <XAxis dataKey="label" tick={{ fill: "rgba(255,255,255,0.45)", fontSize: 10 }} tickLine={false} axisLine={false} minTickGap={16} />
                <YAxis tick={{ fill: "rgba(255,255,255,0.45)", fontSize: 10 }} tickLine={false} axisLine={false} width={48} />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.25)" />
                <Tooltip
                  contentStyle={{ background: "#121815", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 10, fontSize: 11 }}
                  labelStyle={{ color: "rgba(255,255,255,0.6)" }}
                  formatter={(v: number) => [money(v), "Cumul"]}
                />
                <Line type="monotone" dataKey="pnl" stroke={ICE} strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Par jour */}
      {loading && !data ? (
        <div className="text-white/40 text-xs text-center py-10">Chargement…</div>
      ) : days.length === 0 ? (
        <div className="icy-card rounded-2xl p-6 text-center text-white/50 text-xs leading-relaxed">
          Aucun best bet journalisé sur cette période.
          <br />
          Le journal démarre au déploiement de cette page : les jours précédents ne peuvent pas être reconstitués.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {days.map((d) => {
            const isOpen = open[d.date] ?? false;
            const settledCount = d.wins + d.losses + d.voids;
            return (
              <div key={d.date} className="icy-card rounded-2xl overflow-hidden">
                <button
                  onClick={() => setOpen((o) => ({ ...o, [d.date]: !isOpen }))}
                  className="w-full flex items-center gap-3 p-3.5 text-left"
                >
                  {isOpen ? <ChevronDown size={14} className="text-white/40" /> : <ChevronRight size={14} className="text-white/40" />}
                  <span className="flex-1 min-w-0">
                    <span className="block text-white text-xs font-bold capitalize">{dayLabel(d.date)}</span>
                    <span className="block text-white/45 text-[10px] mt-0.5">
                      {d.bets.length} pari{d.bets.length > 1 ? "s" : ""}
                      {settledCount > 0 && ` · ${d.wins}-${d.losses}${d.voids ? `-${d.voids}` : ""}`}
                      {d.pending > 0 && ` · ${d.pending} en attente`}
                      {d.excluded > 0 && ` · ${d.excluded} sans cote`}
                    </span>
                  </span>
                  <span className="text-right">
                    <span
                      className="block text-sm font-bold tabular-nums"
                      style={{ color: settledCount === 0 ? "rgba(255,255,255,0.35)" : d.pnl > 0 ? GREEN : d.pnl < 0 ? RED : undefined }}
                    >
                      {settledCount === 0 ? "—" : money(d.pnl)}
                    </span>
                    {d.staked > 0 && <span className="block text-white/35 text-[9px] tabular-nums">sur {plain(d.staked)}</span>}
                  </span>
                </button>

                {isOpen && (
                  <div className="border-t border-white/5">
                    {d.bets.map((b) => <BetRow key={b.row.id} b={b} />)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Morceaux ────────────────────────────────────────────────────────────────

const OUTCOME_STYLE: Record<BestBetLogRow["outcome"], { label: string; cls: string }> = {
  win:     { label: "Gagné",      cls: "bg-green-500/15 text-green-400 border-green-500/30" },
  loss:    { label: "Perdu",      cls: "bg-red-500/15 text-red-400 border-red-500/30" },
  void:    { label: "Annulé",     cls: "bg-white/5 text-white/60 border-white/10" },
  pending: { label: "En attente", cls: "bg-white/5 text-white/45 border-white/10" },
};

function BetRow({ b }: { b: Priced }) {
  const { row, price, assumed, pnl } = b;
  const o = OUTCOME_STYLE[row.outcome];
  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5 border-b border-white/5 last:border-b-0">
      <span className="text-white/35 text-[10px] font-mono w-6 text-right flex-shrink-0">#{row.bestRank}</span>
      <span className="flex-1 min-w-0">
        <span className="block text-white text-[11px] font-semibold truncate">{row.label}</span>
        <span className="block text-white/40 text-[10px] truncate">
          {row.marketLabel}
          {row.homeTeam && row.awayTeam && ` · ${row.awayTeam} @ ${row.homeTeam}`}
          {` · ${Math.round(row.firstScore)} %`}
          {price != null && ` · ${price.toFixed(2)} (${decimalToAmerican(price)})${assumed ? " supposée" : ""}`}
          {price == null && " · pas de cote"}
        </span>
      </span>
      <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full border flex-shrink-0 ${o.cls}`}>{o.label}</span>
      <span
        className="text-[11px] font-bold tabular-nums w-16 text-right flex-shrink-0"
        style={{ color: pnl == null ? "rgba(255,255,255,0.3)" : pnl > 0 ? GREEN : pnl < 0 ? RED : undefined }}
      >
        {pnl == null ? "—" : money(pnl)}
      </span>
    </div>
  );
}

function Stat({ label, value, sub, color, big }: { label: string; value: string; sub?: string; color?: string; big?: boolean }) {
  return (
    <div className="icy-card rounded-2xl p-3.5">
      <div className="text-white/50 text-[10px] uppercase tracking-wide">{label}</div>
      <div className={`${big ? "text-lg" : "text-base"} font-bold tabular-nums mt-1`} style={color ? { color } : undefined}>
        {value}
      </div>
      {sub && <div className="text-white/40 text-[10px] mt-0.5">{sub}</div>}
    </div>
  );
}

function Segmented({
  label, value, options, onChange,
}: {
  label: string;
  value: string;
  options: { key: string; label: string }[];
  onChange: (key: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-white/50 text-[10px] uppercase tracking-wide">{label}</span>
      <div className="flex bg-white/5 border border-white/10 rounded-lg p-0.5">
        {options.map((o) => (
          <button
            key={o.key}
            onClick={() => onChange(o.key)}
            className={`px-2.5 py-1.5 rounded-md text-[11px] font-semibold transition-colors ${
              value === o.key ? "bg-[#86d1ea]/20 text-[#86d1ea]" : "text-white/55"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
