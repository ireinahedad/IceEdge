import { useNavigate } from "react-router";
import { useBet } from "../../context/BetContext";
import { useI18n } from "../../i18n";
import { openBet365, bet365TennisUrl } from "../../services/affiliateService";
import { OddsPill, EdgeBadge } from "./GameCards";
import { calcEdge, type TennisMatch } from "./types";

// ─── Tennis live card ─────────────────────────────────────────────────────────

export function TennisLiveCard({ match, accent }: { match: TennisMatch; accent: string }) {
  const navigate = useNavigate();
  const { addLeg, hasLeg } = useBet();
  const { t } = useI18n();
  const legId = `tennis-${match.id}-p1`;
  const isAdded = hasLeg(legId);

  const edge = match.player1.bet365Odds ? calcEdge(match.player1.winPct, match.player1.bet365Odds) : 0;

  function quickAdd(e: React.MouseEvent) {
    e.stopPropagation();
    if (isAdded) return;
    addLeg({
      id: legId,
      marketType: "moneyline",
      marketLabel: "Match Winner",
      subjectType: "player",
      subjectId: match.id,
      subjectName: match.player1.name,
      subjectLogo: match.player1.country,
      selection: `${match.player1.name} to win`,
      selectionShort: `${match.player1.name.split(" ").pop()} W`,
      probability: match.player1.winPct,
      gameInfo: `${match.player1.name} vs ${match.player2.name} · ${match.tournament}`,
      addedAt: new Date().toISOString(),
    });
  }

  return (
    <div
      className="min-w-[280px] icy-card rounded-2xl p-4 flex-shrink-0 cursor-pointer active:scale-[0.98] transition-transform"
      onClick={() => navigate(`/predictions/tennis?id=${match.id}`)}
    >

      {/* Header */}
      <div className="flex items-center justify-between mb-3 gap-2">
        <span className="text-[10px] text-red-400 font-medium uppercase tracking-wide flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse inline-block" />{match.liveSet}
        </span>
        <div className="flex items-center gap-1.5">
          <EdgeBadge edge={edge} />
          <span className="text-[10px] px-2 py-0.5 rounded-full border" style={{ color: accent, borderColor: `${accent}4d`, backgroundColor: `${accent}1a` }}>
            {match.surfaceIcon} {match.surface}
          </span>
        </div>
      </div>

      {/* Players + sets */}
      <div className="flex flex-col gap-2 mb-3">
        {[match.player1, match.player2].map((p, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="text-base w-6 flex-shrink-0">{p.country}</span>
            <span className="text-white text-xs flex-1 font-medium">{p.name}</span>
            {p.serving && <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: accent }} />}
            <div className="flex gap-1">
              {(p.sets ?? []).map((s, j) => (
                <span key={j} className="text-xs font-bold w-5 text-center rounded tabular-nums"
                  style={{ color: j === (p.sets!.length - 1) ? accent : "#bfc8cc" }}>{s}</span>
              ))}
            </div>
            {p.bet365Odds && (
              <OddsPill decimal={p.bet365Odds} onBet={() => openBet365(bet365TennisUrl())} />
            )}
          </div>
        ))}
      </div>

      {/* Probability bar */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] font-bold w-7" style={{ color: accent }}>{match.player1.winPct}%</span>
        <div className="flex-1 bg-[#0A0E0C] rounded-full h-2 overflow-hidden flex">
          <div className="h-full rounded-l-full" style={{ width: `${match.player1.winPct}%`, backgroundColor: accent }} />
          <div className="h-full bg-[#1B2419] flex-1" />
        </div>
        <span className="text-[#bfc8cc] text-[10px] font-bold w-7 text-right">{match.player2.winPct}%</span>
      </div>

      {/* Quick add — stops propagation so card click doesn't also fire */}
      <button
        onClick={(e) => { e.stopPropagation(); quickAdd(e); }}
        className={`w-full mt-1 py-1.5 rounded-xl text-xs font-bold transition-colors ${
          isAdded
            ? "bg-green-500/15 border border-green-500/30 text-green-400"
            : "bg-[#90C9F0]/10 border border-[#90C9F0]/25 text-[#90C9F0] active:bg-[#90C9F0]/20"
        }`}
      >
        {isAdded ? t("home.addedSlip") : t("home.addToSlip", { name: match.player1.name.split(" ").pop() ?? "" })}
      </button>
    </div>
  );
}

// ─── Tennis upcoming row ──────────────────────────────────────────────────────

export function TennisMatchRow({ match, accent }: { match: TennisMatch; accent: string }) {
  const navigate = useNavigate();
  const { addLeg, hasLeg } = useBet();
  const legId = `tennis-${match.id}-p1`;
  const isAdded = hasLeg(legId);

  const edge = match.player1.bet365Odds ? calcEdge(match.player1.winPct, match.player1.bet365Odds) : 0;

  function quickAdd(e: React.MouseEvent) {
    e.stopPropagation();
    if (isAdded) return;
    addLeg({
      id: legId,
      marketType: "moneyline",
      marketLabel: "Match Winner",
      subjectType: "player",
      subjectId: match.id,
      subjectName: match.player1.name,
      subjectLogo: match.player1.country,
      selection: `${match.player1.name} to win`,
      selectionShort: `${match.player1.name.split(" ").pop()} W`,
      probability: match.player1.winPct,
      gameInfo: `${match.player1.name} vs ${match.player2.name} · ${match.tournament}`,
      addedAt: new Date().toISOString(),
    });
  }

  return (
    <div
      className="icy-card rounded-2xl p-3.5 cursor-pointer active:scale-[0.98] transition-transform"
      onClick={() => navigate(`/predictions/tennis?id=${match.id}`)}
    >
      <div className="flex items-center gap-3">

        {/* Time */}
        <div className="flex flex-col items-center min-w-[38px] flex-shrink-0">
          <span className="text-xs font-medium" style={{ color: accent }}>{match.time}</span>
          <span className="text-[#bfc8cc] text-[9px]">ET</span>
        </div>

        {/* Players */}
        <div className="flex-1 min-w-0">
          {[match.player1, match.player2].map((p, i) => (
            <div key={i} className={`flex items-center gap-1.5 ${i === 0 ? "mb-1.5" : ""}`}>
              <span className="text-base flex-shrink-0">{p.country}</span>
              <span className="text-white text-xs font-medium flex-1 truncate">{p.name}</span>
              <span className="text-[10px] font-bold tabular-nums" style={{ color: i === 0 ? accent : "#bfc8cc" }}>{p.winPct}%</span>
              {p.bet365Odds && (
                <OddsPill decimal={p.bet365Odds} onBet={() => openBet365(bet365TennisUrl())} />
              )}
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          <div className="flex items-center gap-1.5">
            {edge >= 8 && <EdgeBadge edge={edge} />}
            <button
              onClick={(e) => { e.stopPropagation(); quickAdd(e); }}
              className={`w-8 h-8 rounded-xl border flex items-center justify-center text-sm font-bold transition-colors ${
                isAdded
                  ? "bg-green-500/15 border-green-500/30 text-green-400"
                  : "bg-[#90C9F0]/10 border-[#90C9F0]/30 text-[#90C9F0] active:bg-[#90C9F0]/20"
              }`}
            >
              {isAdded ? "✓" : "+"}
            </button>
          </div>
          <span className="text-[9px] px-1.5 py-0.5 rounded-full" style={{ color: accent, backgroundColor: `${accent}1a` }}>
            {match.surfaceIcon} {match.surface}
          </span>
        </div>
      </div>
    </div>
  );
}
