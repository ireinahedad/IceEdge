import { useContext, useEffect, useState } from "react";
import { predictionApiService } from "../../services/predictionApiService";
import { requestFromMLProps } from "../../services/predictionRequest";
import { useI18n } from "../../i18n";
import { RevealAllCtx } from "./common";
import { PredictionSheet } from "./PredictionSheet";

/* ─── Bet types & market groups ─────────────── */
export interface MLProps { type: "game" | "player" | "team"; subjectId: string; opponentId?: string; propType?: string; line?: number; isHome?: boolean; selection?: string; }
export interface BetOpt { id: string; label: string; rulePct: number; ruleNote: string; mlProps?: MLProps; }
export interface MktGroup { id: string; title: string; cols: 2 | 3; options: BetOpt[]; }

export function buildGameGroups(home: string, away: string, hp: number, ou: number): MktGroup[] {
  const ap = 100 - hp;
  const gml  = (propType: string, line?: number): MLProps => ({ type: "game", subjectId: home, opponentId: away, propType, line, isHome: true });
  const gmla = (propType: string, line?: number): MLProps => ({ type: "game", subjectId: away, opponentId: home, propType, line, isHome: false });
  return [
    {
      id: "match", title: "Match Betting", cols: 3,
      options: [
        { id: "ml-home",  label: `${home} to Win`,   rulePct: hp,   mlProps: gml("moneyline"),
          ruleNote: `Win probability based on season stats: ${hp}%. Home ice advantage is included in the calculation.` },
        { id: "ml-ot",    label: "OT / Shootout",     rulePct: 22,   mlProps: gml("game_to_ot"),
          ruleNote: `~22-24% of NHL games go to OT or shootout, regardless of team strength.` },
        { id: "ml-away",  label: `${away} to Win`,   rulePct: ap,   mlProps: gmla("moneyline"),
          ruleNote: `Inverse of home probability: ${ap}%. Visitors carry a slight systemic disadvantage.` },
      ],
    },
    {
      id: "puckline", title: "Puck Line", cols: 2,
      options: [
        { id: "pl-home", label: `${home} -1.5`, rulePct: Math.max(10, hp - 18), mlProps: gml("puck_line"),
          ruleNote: `Winning by 2+ is ~18% harder than a straight win. Calculated from historical goal-differential data.` },
        { id: "pl-away", label: `${away} +1.5`, rulePct: Math.min(90, ap + 18), mlProps: gml("alt_puck_line"),
          ruleNote: `Covering +1.5 means winning OR losing by exactly 1. Probability boosted ~18% vs moneyline.` },
      ],
    },
    {
      id: "totals", title: "Total Goals", cols: 2,
      options: [
        { id: "ou-over",     label: `Over ${ou}`,     rulePct: 54, mlProps: gml("total_goals_over", ou),
          ruleNote: `Based on combined offensive averages. The ${ou} line aligns with the NHL average of ~6.0 goals/game.` },
        { id: "ou-under",    label: `Under ${ou}`,    rulePct: 46, mlProps: gml("total_goals_under", ou),
          ruleNote: `Strong defense and tight games favor the under. Slightly less likely when both teams score well.` },
        { id: "ou-over-alt", label: `Over ${ou + 1}`, rulePct: 38, mlProps: gml("total_goals_over", ou + 1),
          ruleNote: `Higher alternate line — requires a more open, high-scoring game to hit.` },
        { id: "ou-under-alt",label: `Under ${ou + 1}`,rulePct: 62, mlProps: gml("total_goals_under", ou + 1),
          ruleNote: `Easier to hit — any defensive performance from either team keeps this alive.` },
      ],
    },
    {
      id: "btts", title: "Both Teams to Score", cols: 2,
      options: [
        { id: "btts-yes", label: "Yes", rulePct: Math.min(88, Math.round(hp * 0.42 + ap * 0.40 + 20)), mlProps: gml("both_teams_score"),
          ruleNote: `Both offenses producing at least one goal. Very common in NHL (~75-80% of games).` },
        { id: "btts-no",  label: "No",  rulePct: Math.max(12, 100 - Math.min(88, Math.round(hp * 0.42 + ap * 0.40 + 20))), mlProps: gml("both_teams_score"),
          ruleNote: `Requires one team to be shut out — only ~15-25% of NHL games end this way.` },
      ],
    },
    {
      id: "dc", title: "Double Chance", cols: 2,
      options: [
        { id: "dc-home", label: `${home} or OT`, rulePct: Math.min(90, hp + 15), mlProps: gml("double_chance"),
          ruleNote: `Covers home win + OT/SO result. Two outcomes bundled into one bet.` },
        { id: "dc-away", label: `${away} or OT`, rulePct: Math.min(85, ap + 15), mlProps: gmla("double_chance"),
          ruleNote: `Covers away win + OT/SO. Less likely when home team is a heavy favorite.` },
      ],
    },
    {
      id: "p1", title: "1st Period Result", cols: 3,
      options: [
        { id: "p1-home", label: `${home} leads`, rulePct: Math.round(hp * 0.42 + 10), mlProps: gml("period1_winner"),
          ruleNote: `Home teams lead after P1 in ~${Math.round(hp * 0.42 + 10)}% of cases. Linked to early offensive momentum.` },
        { id: "p1-draw", label: "Tied",           rulePct: 30,
          ruleNote: `Tied after P1 in ~25-35% of NHL games. Common in balanced matchups.` },
        { id: "p1-away", label: `${away} leads`, rulePct: Math.round(ap * 0.38 + 8), mlProps: gmla("period1_winner"),
          ruleNote: `Visitors lead after P1 in ~${Math.round(ap * 0.38 + 8)}% of cases — harder without home crowd.` },
      ],
    },
    {
      id: "p1goals", title: "1st Period Goals", cols: 2,
      options: [
        { id: "p1-over", label: "Over 1.5",  rulePct: 37, mlProps: gml("period1_total_goals", 1.5),
          ruleNote: `~37% of NHL games see 2+ goals in the first period.` },
        { id: "p1-under",label: "Under 1.5", rulePct: 63,
          ruleNote: `First periods often start cautiously — under 1.5 hits ~63% of the time.` },
      ],
    },
    {
      id: "p2", title: "2nd Period Result", cols: 3,
      options: [
        { id: "p2-home", label: `${home} leads`, rulePct: Math.round(hp * 0.44 + 8), mlProps: gml("period2_winner"),
          ruleNote: `More predictive than P1 since more play has unfolded.` },
        { id: "p2-draw", label: "Tied",           rulePct: 28,
          ruleNote: `Tied after P2 in ~25-32% of games.` },
        { id: "p2-away", label: `${away} leads`, rulePct: Math.round(ap * 0.40 + 7), mlProps: gmla("period2_winner"),
          ruleNote: `Away team holding a lead after two periods.` },
      ],
    },
    {
      id: "p3", title: "3rd Period Result", cols: 3,
      options: [
        { id: "p3-home", label: `${home} leads`, rulePct: Math.round(hp * 0.48 + 6), mlProps: gml("period3_winner"),
          ruleNote: `Leading after P3 strongly correlates with the final result.` },
        { id: "p3-draw", label: "Tied → OT",      rulePct: 20, mlProps: gml("game_to_ot"),
          ruleNote: `Tied after regulation forces OT/SO — happens in ~20-22% of games.` },
        { id: "p3-away", label: `${away} leads`, rulePct: Math.round(ap * 0.44 + 5), mlProps: gmla("period3_winner"),
          ruleNote: `Away team ahead heading into OT or winning in regulation.` },
      ],
    },
    {
      id: "ot", title: "Extra Time", cols: 2,
      options: [
        { id: "ot-yes", label: "Goes to OT",      rulePct: 22, mlProps: gml("game_to_ot"),
          ruleNote: `~22-24% of NHL games go to overtime, independent of the teams involved.` },
        { id: "ot-no",  label: "Decided in Reg",  rulePct: 78, mlProps: gml("regulation_result"),
          ruleNote: `Most games (78%) are decided inside regulation time.` },
      ],
    },
    {
      id: "margin", title: "Winning Margin", cols: 3,
      options: [
        { id: "wm-h1", label: `${home} by 1`,  rulePct: Math.round(hp * 0.18), mlProps: gml("winning_margin"),
          ruleNote: `One-goal wins are the most common margin in NHL hockey.` },
        { id: "wm-h2", label: `${home} by 2`,  rulePct: Math.round(hp * 0.13), mlProps: gml("winning_margin"),
          ruleNote: `Two-goal wins: comfortable but not a blowout.` },
        { id: "wm-h3", label: `${home} by 3+`, rulePct: Math.round(hp * 0.09), mlProps: gml("winning_margin"),
          ruleNote: `Blowout win — less common but more likely for dominant home teams.` },
        { id: "wm-a1", label: `${away} by 1`,  rulePct: Math.round(ap * 0.16), mlProps: gmla("winning_margin"),
          ruleNote: `Narrow away win — common when teams are evenly matched.` },
        { id: "wm-a2", label: `${away} by 2`,  rulePct: Math.round(ap * 0.11), mlProps: gmla("winning_margin"),
          ruleNote: `Away win by two goals.` },
        { id: "wm-a3", label: `${away} by 3+`, rulePct: Math.round(ap * 0.07), mlProps: gmla("winning_margin"),
          ruleNote: `Away blowout — rare but possible when visitors are heavily favored.` },
      ],
    },
    {
      id: "firstlast", title: "Goal Scorer", cols: 2,
      options: [
        { id: "first-home", label: `${home} scores first`, rulePct: Math.round(hp * 0.56 + 5), mlProps: gml("first_team_score"),
          ruleNote: `Correlated with win probability. Favorites open the scoring more often.` },
        { id: "first-away", label: `${away} scores first`, rulePct: Math.round(ap * 0.52 + 4), mlProps: gmla("first_team_score"),
          ruleNote: `Away team drawing first blood.` },
        { id: "last-home",  label: `${home} scores last`,  rulePct: Math.round(hp * 0.54 + 4), mlProps: gml("last_team_score"),
          ruleNote: `Final goal lightly correlates with overall team performance.` },
        { id: "last-away",  label: `${away} scores last`,  rulePct: Math.round(ap * 0.50 + 3), mlProps: gmla("last_team_score"),
          ruleNote: `Away team scoring the last goal of the game.` },
      ],
    },
  ];
}

/* ─── BetOption ─────────────────────────────── */
export function BetOption({ opt, accent }: { opt: BetOpt; accent: string }) {
  const { t } = useI18n();
  const revealAll = useContext(RevealAllCtx);
  const [revealed, setRevealed] = useState(false);
  const [sheet, setSheet] = useState(false);
  const isRevealed = revealAll || revealed;

  // Single source of truth: the server prediction (same value the coupon stores).
  // rulePct is only a placeholder shown until the server responds.
  const [serverPct, setServerPct] = useState<number | null>(null);
  useEffect(() => {
    if (!isRevealed || !opt.mlProps || serverPct !== null) return;
    let alive = true;
    predictionApiService
      .getSinglePrediction(requestFromMLProps(opt.mlProps))
      .then(r => { if (alive) setServerPct(r.probability); })
      .catch(() => { /* keep placeholder */ });
    return () => { alive = false; };
  }, [isRevealed, opt.mlProps, serverPct]);

  const shownPct = serverPct ?? opt.rulePct;
  const pctColor = shownPct >= 65 ? "#4ade80" : shownPct >= 50 ? accent : shownPct >= 38 ? "#facc15" : "#f87171";

  return (
    <>
      <button
        onClick={() => setRevealed(v => !v)}
        className="flex flex-col items-center justify-between p-3 rounded-xl border transition-all active:scale-[0.97] w-full"
        style={{
          minHeight: 64,
          background: isRevealed ? "#131A12" : "#0d1519",
          borderColor: isRevealed ? pctColor + "55" : "rgba(255,255,255,0.08)",
        }}
      >
        <span className="text-white text-[11px] font-medium text-center leading-tight">{opt.label}</span>
        {isRevealed ? (
          <button
            onClick={e => { e.stopPropagation(); setSheet(true); }}
            className="mt-2 px-3 py-0.5 rounded-full text-xs font-bold active:scale-95 transition-transform"
            style={{ background: pctColor + "22", color: pctColor, border: `1px solid ${pctColor}55` }}
          >
            {serverPct === null && opt.mlProps ? "…" : `${shownPct}%`}
          </button>
        ) : (
          <span className="mt-2 text-[#3a5060] text-[9px] font-medium">{t("pred.tap")}</span>
        )}
      </button>
      {sheet && (
        <PredictionSheet
          label={opt.label} rulePct={opt.rulePct} serverPct={serverPct ?? undefined} ruleNote={opt.ruleNote}
          accent={accent} mlProps={opt.mlProps} onClose={() => setSheet(false)}
        />
      )}
    </>
  );
}

/* ─── MarketGroup ───────────────────────────── */
export function MarketGroup({ group, accent }: { group: MktGroup; accent: string }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="bg-[#0A0E0C] border border-white/[0.07] rounded-2xl overflow-hidden">
      <button
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between px-4 py-3"
        style={{ borderBottom: open ? "1px solid rgba(255,255,255,0.06)" : "none" }}
      >
        <span className="text-[#c0cdd4] text-xs font-semibold uppercase tracking-wider">{group.title}</span>
        <span className="text-[#3a5060] text-xs">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div
          className="p-3 grid gap-2"
          style={{ gridTemplateColumns: `repeat(${group.cols}, 1fr)` }}
        >
          {group.options.map(opt => (
            <BetOption key={opt.id} opt={opt} accent={accent} />
          ))}
        </div>
      )}
    </div>
  );
}
