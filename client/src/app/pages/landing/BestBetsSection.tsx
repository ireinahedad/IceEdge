/**
 * BestBetsSection.tsx
 *
 * Extrait de HockeyLanding.tsx le 2026-08-10.
 * Refonte UX le 2026-09-25 : un seul sélecteur exclusif de palier, lignes
 * « pari / contexte — % de chance / cote », libellés traduits côté client.
 */

import { useState, useEffect, useMemo } from "react";
import { ChevronRight, Star } from "lucide-react";
import { predictionApiService, type ApiBestBet } from "../../services/predictionApiService";
import type { BetLeg } from "../../types/bet";
import { useBet } from "../../context/BetContext";
import { ProLock } from "../../components/ProLock";
import { useI18n } from "../../i18n";
import { nhlLogoUrl } from "../../data/teamEmoji";
import { BookPricePill } from "../../components/BookPricePill";


// ─── Best Bets ─────────────────────────────────────────────────────────────────

type TFn = (key: string, params?: Record<string, string | number>) => string;

interface BestBet {
  id: string;
  label: string;
  context: string;
  logo: string;
  rulePct: number;
  mlPct: number | null;
  leg: BetLeg;
  gameId?: string;
  /** Vrai prix Betano Ontario, quand le livre cote ce pari (voir serveur). */
  bookPrice: number | null;
}

type SortSource = "rules" | "ml";
type RiskTier   = "safe" | "balanced" | "longshot";
type TierFilter = RiskTier | "all";

// Trois paliers aux couleurs franchement distinctes : la couleur du % sur chaque
// ligne est la même que celle de l'onglet du sélecteur, qui sert donc de légende.
const RISK_TIERS: { tier: RiskTier; key: string; color: string }[] = [
  { tier: "safe",     key: "tier.safe",     color: "#86d1ea" },
  { tier: "balanced", key: "tier.balanced", color: "#facc15" },
  { tier: "longshot", key: "tier.longshot", color: "#f87171" },
];

/**
 * Le % affiché selon la source choisie.
 *
 * ⚠️ PAS de repli sur les règles quand l'IA n'a pas de score. C'était
 * `mlPct ?? rulePct` : dès que le service ML ne répondait pas (disjoncteur
 * ouvert, délai de 5 s, ou pari hors des 30 premiers enrichis par le serveur),
 * la ligne affichait le chiffre des RÈGLES sous l'étiquette « IA » — et les
 * deux onglets montraient exactement les mêmes nombres. Un pari sans score IA
 * n'apparaît donc tout simplement pas dans l'onglet IA.
 */
function pctFor(b: BestBet, source: SortSource): number | null {
  return source === "ml" ? b.mlPct : b.rulePct;
}

/** Au plus N paris par match : sans ça, un seul match (ML + puck line + over de
 *  la même équipe) pouvait occuper la moitié de la liste. */
const MAX_PER_GAME = 2;

function riskLabel(pct: number): { tier: RiskTier; key: string; color: string } {
  if (pct >= 70) return RISK_TIERS[0];
  if (pct >= 55) return RISK_TIERS[1];
  return RISK_TIERS[2];
}

/** Cote **équitable** déduite de la probabilité du modèle — sans marge, et sans
 * rapport avec un prix de bookmaker. Affichée SEULEMENT quand le livre ne cote
 * pas ce pari (presque tous les marchés joueurs) ; sinon c'est le vrai prix qui
 * s'affiche. L'infobulle le précise. */
function impliedOdds(pct: number): number | null {
  if (pct <= 0 || pct >= 100) return null;
  return Math.round((100 / pct) * 100) / 100;
}

/**
 * Libellé lisible et traduit, reconstruit depuis les champs structurés du
 * serveur (marketType, selectionValue, line). Le `label` serveur est en anglais
 * en dur (« BOS to win ») : on ne s'en sert plus qu'en repli, pour un marché
 * inconnu. Les lignes « .5 » sont dites en entier (« au moins 3 tirs ») —
 * plus parlant que « plus de 2.5 tirs ».
 */
function betLabel(b: ApiBestBet, t: TFn): string {
  const abbr = b.teamAbbr ?? b.selectionValue.toUpperCase();
  const name = b.subjectName;
  const atLeast = (line: number | null, dflt: number) => Math.ceil(line ?? dflt);
  switch (b.marketType) {
    case "moneyline":   return t("bb.teamWin",    { abbr });
    case "puck_line":   return t("bb.puckLine",   { abbr });
    case "total_goals": return t(b.selectionValue === "under" ? "bb.under" : "bb.over", { line: b.line ?? 5.5 });
    case "anytime_goal":return t("bb.anytimeGoal",{ name });
    case "shots_ou":    return t("bb.shotsAtLeast",  { name, n: atLeast(b.line, 2.5) });
    case "points_ou":   return t("bb.pointsAtLeast", { name, n: atLeast(b.line, 0.5) });
    case "pp_point":    return t("bb.ppPoint",    { name });
    default:            return b.label;
  }
}

function marketName(b: ApiBestBet, t: TFn): string {
  const key = `market.${b.marketType}`;
  const out = t(key);
  return out === key ? b.marketLabel : out;   // clé absente → libellé serveur
}

function BestBetRow({ bet, sortSource }: { bet: BestBet; sortSource: SortSource }) {
  const { addLeg, removeLeg, hasLeg } = useBet();
  const { t } = useI18n();
  const inSlip = hasLeg(bet.id);
  // `sorted` n'envoie ici que des paris qui ONT un score pour cette source.
  const displayPct = pctFor(bet, sortSource) ?? bet.rulePct;
  // L'autre source, en petit : c'est ce qui rend l'écart règles / IA visible
  // ligne par ligne au lieu de devoir basculer d'onglet pour comparer.
  const otherPct = sortSource === "ml" ? bet.rulePct : bet.mlPct;
  const risk = riskLabel(displayPct);
  const odds = impliedOdds(displayPct);

  // Gauche : le pari en gros, le contexte dessous. Droite : le chiffre clé avec
  // son libellé en toutes lettres — rien ne dépend d'une infobulle (mobile).
  return (
    <div className="flex items-center gap-2.5 icy-card rounded-xl px-3 py-2">
      {bet.logo?.startsWith("http")
        ? <img src={bet.logo} alt="" className="w-6 h-6 object-contain flex-shrink-0" />
        : <span className="text-lg flex-shrink-0">{bet.logo}</span>}

      <div className="flex-1 min-w-0">
        <div className="text-white text-[13px] font-semibold leading-tight">{bet.label}</div>
        <div className="text-[#8a9ea6] text-[11px] truncate mt-0.5">
          {bet.context} · {bet.leg.marketLabel}
        </div>
      </div>

      <div className="flex flex-col items-end flex-shrink-0 leading-tight">
        <div className="tabular-nums" style={{ color: risk.color }}>
          <span className="text-[15px] font-bold">{displayPct} %</span>
          <span className="text-[10px] font-medium ml-1">{t("home.chance")}</span>
        </div>
        {bet.bookPrice != null ? (
          <span className="mt-0.5"><BookPricePill price={bet.bookPrice} /></span>
        ) : odds != null && (
          <span title={t("home.oddsFairHint")} className="text-[11px] text-[#bfc8cc] tabular-nums">
            {t("home.odds", { odds: odds.toFixed(2) })}
          </span>
        )}
        {otherPct != null && (
          <span className="text-[10px] text-[#8a9ea6] tabular-nums">
            {t(sortSource === "ml" ? "home.vsRules" : "home.vsAi", { pct: otherPct })}
          </span>
        )}
      </div>

      <button
        onClick={() => inSlip ? removeLeg(bet.id) : addLeg({ ...bet.leg, probability: displayPct })}
        className={`tap-44 w-7 h-7 rounded-lg border flex items-center justify-center text-sm flex-shrink-0 transition-colors ${
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

/** Lignes factices de l'aperçu flouté (utilisateurs gratuits) — même gabarit
 *  que les vraies lignes, pour montrer ce qu'on obtient en passant Pro. */
const lockedPreview = (t: TFn): { label: string; context: string; pct: number }[] => [
  { label: t("bb.teamWin",       { abbr: "TOR" }),              context: "TOR vs BOS · 19:00", pct: 74 },
  { label: t("bb.over",          { line: 5.5 }),                context: "EDM vs CGY · 21:00", pct: 66 },
  { label: t("bb.pointsAtLeast", { name: "Connor McDavid", n: 1 }), context: "EDM vs CGY · 21:00", pct: 61 },
  { label: t("bb.puckLine",      { abbr: "BOS" }),              context: "BOS vs MTL · 19:30", pct: 52 },
  { label: t("bb.under",         { line: 6.5 }),                context: "NYR vs NJD · 19:00", pct: 47 },
];

export function BestBetsSection({
  accent,
  isLoading,
  locked = false,
}: {
  accent: string;
  isLoading: boolean;
  locked?: boolean;
}) {
  const { t, lang } = useI18n();
  const [sortSource, setSortSource] = useState<SortSource>("ml");
  // Un seul sélecteur exclusif (Tous / Sûrs / Équilibrés / Grosses cotes).
  // Il remplace l'ancien trio bouton de tri + 4 pastilles multi-sélection, où
  // cliquer « Sûr » masquait les paris sûrs au lieu de n'afficher qu'eux.
  const [tierFilter, setTierFilter] = useState<TierFilter>("all");
  const [bets, setBets]             = useState<BestBet[]>([]);
  // `meta.mlAvailable` du serveur : faux quand AUCUN pari n'a reçu de score IA
  // (service ML en panne ou désactivé). Sert à dire pourquoi l'onglet IA est vide.
  const [mlAvailable, setMlAvailable] = useState(true);
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
  // Les scores ML arrivent avec la réponse : l'ancien chargement ML paresseux,
  // ligne par ligne, ne se déclenchait plus et a été retiré le 2026-09-25.
  useEffect(() => {
    if (locked) return;             // don't fetch Pro-only data for free users
    let cancelled = false;

    (async () => {
      try {
        // Fetch a larger pool (both rule + ML scores) so the Rules/AI toggle
        // re-ranks honestly client-side; the list itself still shows the top 15.
        const { bets: apiBets, meta } = await predictionApiService.getBestBets({ limit: 30, source: "ml" });
        if (cancelled) return;
        setMlAvailable(meta?.mlAvailable !== false && apiBets.some((b) => b.mlPct != null));
        const mapped: BestBet[] = apiBets.map((b) => {
          const logo   = b.teamAbbr ? nhlLogoUrl(b.teamAbbr) : b.subjectLogo;
          const label  = betLabel(b, t);
          const market = marketName(b, t);
          return {
            id: b.id, label, context: b.context, logo,
            rulePct: b.rulePct, mlPct: b.mlPct,
            gameId: b.gameId ?? undefined,
            bookPrice: b.bookPrice ?? null,
            leg: {
              // `selection` / `marketLabel` sont purement affichés (coupon,
              // partage) : le règlement automatique lit `selectionValue`.
              id: b.id, marketType: b.marketType, marketLabel: market,
              subjectType: b.subjectType, subjectId: b.subjectId, subjectName: b.subjectName,
              subjectLogo: logo, selection: label, selectionShort: b.selectionShort,
              probability: b.score, line: b.line ?? undefined,
              gameInfo: b.context, addedAt: new Date().toISOString(),
              // Machine-readable fields for automatic settlement.
              gameId: b.gameId ?? undefined,
              selectionValue: b.selectionValue,
            },
          };
        });
        setBets(mapped);
      } catch {
        if (!cancelled) setBets([]);
      }
    })();

    return () => { cancelled = true; };
  // ⚠️ Plus de `games` ici (ni en prop). L'effet ne le lisait pas, mais
  // l'accueil passait `[...liveGames, ...upcomingGames]` — un tableau neuf à
  // chaque rendu — donc chaque rendu de l'accueil (feuille ouverte/fermée,
  // cotes arrivées, abonnement rechargé) refaisait `GET /predict/best-bets` et
  // écrasait la liste. Mesuré le 2026-09-16 : 2 appels par ouverture de
  // « More bets ». best-bets est calculé côté serveur, indépendamment d'eux.
  // `t` suit `lang` : `lang` suffit à retraduire les libellés.
  }, [lang, locked]);

  const sorted = useMemo(() => {
    const src = (b: BestBet) => pctFor(b, sortSource) ?? 0;
    const scored   = bets.filter((b) => pctFor(b, sortSource) != null);
    const filtered = tierFilter === "all"
      ? scored
      : scored.filter(b => riskLabel(src(b)).tier === tierFilter);
    const perGame = new Map<string, number>();
    const out: BestBet[] = [];
    for (const b of [...filtered].sort((a, b) => src(b) - src(a))) {
      if (b.gameId) {
        const n = perGame.get(b.gameId) ?? 0;
        if (n >= MAX_PER_GAME) continue;
        perGame.set(b.gameId, n + 1);
      }
      out.push(b);
      if (out.length === 15) break;
    }
    return out;
  }, [bets, sortSource, tierFilter]);

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
            {lockedPreview(t).map(({ label, context, pct }, i) => {
              const risk = riskLabel(pct);
              return (
                <div key={i} className="flex items-center gap-2.5 icy-card rounded-xl px-3 py-2">
                  <span className="text-lg flex-shrink-0">🏒</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-white text-[13px] font-semibold leading-tight">{label}</div>
                    <div className="text-[#8a9ea6] text-[11px] truncate mt-0.5">{context}</div>
                  </div>
                  <div className="flex flex-col items-end flex-shrink-0 leading-tight">
                    <div className="tabular-nums" style={{ color: risk.color }}>
                      <span className="text-[15px] font-bold">{pct} %</span>
                      <span className="text-[10px] font-medium ml-1">{t("home.chance")}</span>
                    </div>
                    <span className="text-[11px] text-[#bfc8cc] tabular-nums">
                      {t("home.odds", { odds: (100 / pct).toFixed(2) })}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </ProLock>
      </section>
    );
  }

  const activeTier = RISK_TIERS.find(r => r.tier === tierFilter);

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
          {!isLoading && <span className="text-[11px] text-[#bfc8cc] icy-tile px-1.5 py-0.5 rounded-full">{t("home.top", { n: sorted.length })}</span>}
        </button>
        {!collapsed && (
        <div className="flex items-center gap-1.5">
          {/* Source toggle — which score (rules vs AI) drives display + filtering */}
          <div className="flex icy-tile rounded-full p-0.5 gap-0.5">
            {(["rules", "ml"] as SortSource[]).map((s) => (
              <button key={s} onClick={() => setSortSource(s)}
                className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium transition-all ${sortSource === s ? "text-[#072E49] font-bold" : "text-[#8a9ea6]"}`}
                style={sortSource === s ? { backgroundColor: s === "ml" ? "#a78bfa" : "#86d1ea" } : {}}>
                {s === "ml" ? t("home.ai") : t("home.rules")}
              </button>
            ))}
          </div>
        </div>
        )}
      </div>

      {!collapsed && (
        <>
          <p className="text-[#8a9ea6] text-[11px] mb-2">
            {t(sortSource === "ml" ? "home.bbExplainMl" : "home.bbExplainRules")}
          </p>
          {/* Sélecteur exclusif : un onglet actif à la fois. Ses couleurs sont
              celles des % sur les lignes — il sert aussi de légende. */}
          <div role="tablist" className="flex icy-tile rounded-full p-0.5 gap-0.5 mb-3">
            {([{ tier: "all" as const, key: "tier.all", color: "#ffffff" }, ...RISK_TIERS]).map(({ tier, key, color }) => {
              const active = tierFilter === tier;
              return (
                <button
                  key={tier}
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTierFilter(tier)}
                  className="flex-1 px-2 py-1 rounded-full text-[11px] font-semibold transition-all whitespace-nowrap"
                  style={active
                    ? { color, backgroundColor: `${color}22` }
                    : { color: tier === "all" ? "#8a9ea6" : `${color}99` }}
                >
                  {t(key)}
                </button>
              );
            })}
          </div>
        </>
      )}

      {!collapsed && (isLoading ? (
        <div className="flex flex-col gap-1.5">
          {[1,2,3,4,5].map(i => <div key={i} className="h-12 icy-tile rounded-xl animate-pulse" />)}
        </div>
      ) : sorted.length === 0 ? (
        // Onglet vide alors que la liste ne l'est pas : le dire, plutôt que
        // « aucun pari dans les 48 h », qui serait faux.
        <div className="py-8 text-center text-[#bfc8cc] text-xs">
          {sortSource === "ml" && bets.length > 0 && !mlAvailable ? (
            <>
              <p>{t("home.aiUnavailable")}</p>
              <button
                onClick={() => setSortSource("rules")}
                className="tap-44 mt-2 px-3 py-1.5 rounded-full text-[11px] font-bold"
                style={{ background: "#86d1ea", color: "#072E49" }}
              >
                {t("home.showRules")}
              </button>
            </>
          ) : activeTier && bets.length > 0
            ? t("home.noBetsTier", { tier: t(activeTier.key) })
            : t("home.noBets")}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {sorted.map(bet => <BestBetRow key={bet.id} bet={bet} sortSource={sortSource} />)}
        </div>
      ))}
    </section>
  );
}
