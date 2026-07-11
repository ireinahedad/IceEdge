import { useNavigate } from "react-router";
import type { BetLeg } from "../../types/bet";
import { useSport } from "../../context/SportContext";
import { useBet } from "../../context/BetContext";
import { useI18n } from "../../i18n";
import { openBet365, bet365HockeyUrl } from "../../services/affiliateService";
import { calcEdge, type DisplayGame } from "./types";

// ─── Odds pill ─────────────────────────────────────────────────────────────────

export function OddsPill({ decimal, onBet }: { decimal: number; onBet: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onBet(); }}
      className="flex items-center gap-1 bg-green-500/10 border border-green-500/20 rounded-full px-2 py-0.5 active:bg-green-500/20 transition-colors"
    >
      <span className="text-[9px] text-[#bfc8cc]">bet365</span>
      <span className="text-[10px] font-bold text-green-400">{decimal.toFixed(2)}</span>
    </button>
  );
}

// ─── Edge badge ────────────────────────────────────────────────────────────────

export function EdgeBadge({ edge }: { edge: number }) {
  const { t } = useI18n();
  if (edge < 8) return null;
  return (
    <span className="text-[9px] px-2 py-0.5 rounded-full bg-green-500/10 border border-green-500/25 text-green-400 font-medium flex-shrink-0">
      {t("home.edge", { edge })}
    </span>
  );
}

// ─── Hockey live game card ─────────────────────────────────────────────────────

export function LiveGameCard({ game, onOpenSheet }: { game: DisplayGame; onOpenSheet: () => void }) {
  const { theme } = useSport();
  const accent = theme.accent;
  const { addLeg, hasLeg } = useBet();
  const { t } = useI18n();
  const navigate = useNavigate();

  const legId = `${game.id}-moneyline-${game.team1.id}`;
  const isAdded = hasLeg(legId);

  const edge = game.bet365Home ? calcEdge(game.team1.winPct, game.bet365Home) : 0;

  function quickAdd(e: React.MouseEvent) {
    e.stopPropagation();
    if (isAdded) return;
    const leg: BetLeg = {
      id: legId,
      marketType: "moneyline",
      marketLabel: "Moneyline",
      subjectType: "game",
      subjectId: game.id,
      subjectName: `${game.team1.abbr} vs ${game.team2.abbr}`,
      subjectLogo: game.team1.logo,
      selection: `${game.team1.name} to win`,
      selectionShort: `${game.team1.abbr} ML`,
      probability: game.team1.winPct,
      gameInfo: `${game.team1.abbr} vs ${game.team2.abbr} · Live`,
      addedAt: new Date().toISOString(),
    };
    addLeg(leg);
  }

  return (
    <div
      onClick={() => navigate(`/stats/prediction/game/${game.id}`)}
      className="min-w-[280px] icy-card rounded-2xl p-4 flex-shrink-0 cursor-pointer active:scale-[0.99] transition-transform"
    >

      {/* Header: live badge + edge + buttons */}
      <div className="flex items-center justify-between mb-3 gap-2">
        <span className="text-[10px] text-red-400 font-medium uppercase tracking-wide flex items-center gap-1 flex-shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse inline-block" />{game.period}
        </span>
        <div className="flex items-center gap-1.5 min-w-0">
          <EdgeBadge edge={edge} />
          <button
            onClick={quickAdd}
            className={`text-[10px] px-2.5 py-0.5 rounded-full border font-medium flex-shrink-0 transition-colors ${
              isAdded
                ? "bg-green-500/15 border-green-500/30 text-green-400"
                : "bg-[#90C9F0]/10 border-[#90C9F0]/30 text-[#90C9F0] active:bg-[#90C9F0]/20"
            }`}
          >
            {isAdded ? t("home.added") : t("home.add")}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onOpenSheet(); }}
            className="text-[10px] text-[#bfc8cc] border border-white/20 px-2 py-0.5 rounded-full flex-shrink-0 active:bg-white/5"
          >
            {t("home.more")}
          </button>
        </div>
      </div>

      {/* Teams + score */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex flex-col items-center gap-1">
          <img src={game.team1.logo} alt={game.team1.abbr} className="w-8 h-8 object-contain" />
          <span className="text-white text-xs font-bold">{game.team1.abbr}</span>
        </div>
        <div className="flex flex-col items-center gap-0.5">
          <div className="flex items-center gap-2.5">
            <span className="text-white text-3xl font-bold tabular-nums">{game.team1.score}</span>
            <span className="text-[#bfc8cc] text-lg">–</span>
            <span className="text-white text-3xl font-bold tabular-nums">{game.team2.score}</span>
          </div>
          {game.overUnder && <span className="text-[#bfc8cc] text-[9px]">O/U {game.overUnder}</span>}
        </div>
        <div className="flex flex-col items-center gap-1">
          <img src={game.team2.logo} alt={game.team2.abbr} className="w-8 h-8 object-contain" />
          <span className="text-white text-xs font-bold">{game.team2.abbr}</span>
        </div>
      </div>

      {/* Model probability bar */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[10px] font-bold w-7 flex-shrink-0" style={{ color: accent }}>{game.team1.winPct}%</span>
        <div className="flex-1 bg-[#0A0E0C] rounded-full h-2 overflow-hidden flex">
          <div className="h-full rounded-l-full transition-all duration-500" style={{ width: `${game.team1.winPct}%`, backgroundColor: accent }} />
          <div className="h-full bg-[#1B2419] flex-1" />
        </div>
        <span className="text-[#bfc8cc] text-[10px] font-bold w-7 text-right flex-shrink-0">{game.team2.winPct}%</span>
      </div>

      {/* bet365 odds row — only shown when API has real odds */}
      {game.bet365Home && game.bet365Away ? (
        <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/5">
          <OddsPill decimal={game.bet365Home} onBet={() => openBet365(bet365HockeyUrl())} />
          <span className="text-[9px] text-[#bfc8cc]">Moneyline</span>
          <OddsPill decimal={game.bet365Away} onBet={() => openBet365(bet365HockeyUrl())} />
          {/* Moneyline is a universal betting term, kept as-is */}
        </div>
      ) : (
        /* No API key — show a subtle link to bet365 instead */
        <div className="flex items-center justify-end mt-1">
          <button
            onClick={(e) => { e.stopPropagation(); openBet365(bet365HockeyUrl()); }}
            className="text-[9px] text-green-400 border border-green-500/20 bg-green-500/8 px-2 py-1 rounded-full"
          >
            {t("home.betOn")}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Hockey upcoming game row ──────────────────────────────────────────────────

export function UpcomingGameRow({ game, onOpenSheet }: { game: DisplayGame; onOpenSheet: () => void }) {
  const { theme } = useSport();
  const accent = theme.accent;
  const { addLeg, hasLeg } = useBet();
  const { t } = useI18n();
  const navigate = useNavigate();

  const legId = `${game.id}-moneyline-${game.team1.id}`;
  const isAdded = hasLeg(legId);

  const edge = game.bet365Home ? calcEdge(game.team1.winPct, game.bet365Home) : 0;

  function quickAdd(e: React.MouseEvent) {
    e.stopPropagation();
    if (isAdded) return;
    const leg: BetLeg = {
      id: legId,
      marketType: "moneyline",
      marketLabel: "Moneyline",
      subjectType: "game",
      subjectId: game.id,
      subjectName: `${game.team1.abbr} vs ${game.team2.abbr}`,
      subjectLogo: game.team1.logo,
      selection: `${game.team1.name} to win`,
      selectionShort: `${game.team1.abbr} ML`,
      probability: game.team1.winPct,
      gameInfo: `${game.team1.abbr} vs ${game.team2.abbr} · ${game.time}`,
      addedAt: new Date().toISOString(),
    };
    addLeg(leg);
  }

  return (
    <div
      onClick={() => navigate(`/stats/prediction/game/${game.id}`)}
      className="icy-card rounded-2xl p-3.5 cursor-pointer active:scale-[0.99] transition-transform"
    >
      <div className="flex items-center gap-3">

        {/* Time column */}
        <div className="flex flex-col items-center min-w-[38px] flex-shrink-0">
          <span className="text-xs font-medium" style={{ color: accent }}>{game.time}</span>
          <span className="text-[#bfc8cc] text-[9px]">ET</span>
        </div>

        {/* Teams column */}
        <div className="flex-1 min-w-0">
          {/* Team 1 */}
          <div className="flex items-center gap-1.5 mb-1.5">
            <img src={game.team1.logo} alt={game.team1.abbr} className="w-5 h-5 object-contain flex-shrink-0" />
            <span className="text-white text-xs font-medium flex-1 truncate">{game.team1.abbr}</span>
            <span className="text-[10px] font-bold tabular-nums" style={{ color: accent }}>{game.team1.winPct}%</span>
            {game.bet365Home && (
              <OddsPill decimal={game.bet365Home} onBet={() => openBet365(bet365HockeyUrl())} />
            )}
          </div>
          {/* Team 2 */}
          <div className="flex items-center gap-1.5">
            <img src={game.team2.logo} alt={game.team2.abbr} className="w-5 h-5 object-contain flex-shrink-0" />
            <span className="text-white text-xs font-medium flex-1 truncate">{game.team2.abbr}</span>
            <span className="text-[#bfc8cc] text-[10px] font-bold tabular-nums">{game.team2.winPct}%</span>
            {game.bet365Away && (
              <OddsPill decimal={game.bet365Away} onBet={() => openBet365(bet365HockeyUrl())} />
            )}
          </div>
        </div>

        {/* Actions column */}
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          <div className="flex items-center gap-1.5">
            {edge >= 8 && <EdgeBadge edge={edge} />}
            <button
              onClick={quickAdd}
              className={`w-8 h-8 rounded-xl border flex items-center justify-center text-sm font-bold transition-colors ${
                isAdded
                  ? "bg-green-500/15 border-green-500/30 text-green-400"
                  : "bg-[#90C9F0]/10 border-[#90C9F0]/30 text-[#90C9F0] active:bg-[#90C9F0]/20"
              }`}
              title={isAdded ? t("home.addedSlip") : t("home.addToSlip", { name: game.team1.abbr })}
            >
              {isAdded ? "✓" : "+"}
            </button>
          </div>
          {/* O/U info */}
          {game.overUnder && (
            <div className="text-right">
              <span className="text-[9px] text-[#bfc8cc]">O/U {game.overUnder}</span>
              {game.totalPct && <span className="text-[9px] text-[#90C9F0] ml-1">{game.totalPct}%</span>}
            </div>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onOpenSheet(); }}
            className="text-[9px] text-[#bfc8cc] underline underline-offset-2"
          >
            {t("home.moreBets")}
          </button>
        </div>
      </div>
    </div>
  );
}
