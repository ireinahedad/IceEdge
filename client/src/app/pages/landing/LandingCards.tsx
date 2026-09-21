/**
 * LandingCards.tsx
 *
 * Extrait de HockeyLanding.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { weekdayShort } from "../../data/gameDay";
import { useNavigate } from "react-router";
import { IceedgeLogo } from "../../components/brand/IceedgeLogo";
import { useSport } from "../../context/SportContext";
import { useI18n } from "../../i18n";
import { openBet } from "../../services/bookmakers";
import { features } from "../../platform";
import { useBookmaker } from "../../context/BookmakerContext";
import { useOddsFormat } from "../../context/OddsFormatContext";
import { DisplayGame, calcEdge } from "./landingTypes";


// ─── Brand header (logo always returns home) ───────────────────────────────────

/**
 * En-tête de marque : le mot-clé cliquable qui ramène à l'accueil.
 *
 * Ce composant a porté un sélecteur de sport, d'où son nom ; le sous-libellé est
 * tombé le 2026-08-21 et le tennis est sorti du produit le 2026-08-24. Le nom est
 * conservé pour ne pas toucher au seul appelant sans raison.
 */
export function SportSelector() {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate("/")}
      className="w-full flex items-center justify-center gap-3 select-none"
      aria-label="Accueil ArakIce"
    >
      {/* ARAKICE logo mark — always returns to the home page */}
      <IceedgeLogo size={44} wordmark={false} />
      <span
        className="uppercase font-bold text-white leading-none"
        style={{
          fontFamily: "'Oswald', 'Arial Narrow', sans-serif",
          fontSize: 27,
          letterSpacing: "0.2em",
        }}
      >
        ARAKICE
      </span>
    </button>
  );
}

// ─── Odds pill ─────────────────────────────────────────────────────────────────

function OddsPill({ decimal, onBet }: { decimal: number; onBet: () => void }) {
  const { bookmaker } = useBookmaker();
  // ⚠️ Le SEUL endroit de l'app qui suit le réglage de format, et c'est normal :
  // `game.bet365Home/Away` sont de vrais prix de bookmaker. Tout le reste de
  // l'app affiche des probabilités du MODÈLE, qui restent en % — voir
  // `services/oddsFormat.ts`. Si un jour un autre écran relaie de vraies cotes
  // (page d'affiche, comparateur), c'est ici qu'il faut venir chercher le patron.
  const { odds } = useOddsFormat();

  // APPLE_PLAN §4 — Guideline 5.3. The price is information the prediction
  // pages lean on, so it stays; what goes is the tap that opens a sportsbook
  // and the book's name next to it. Same pill, no handler.
  if (!features.bookmakerLinks) {
    return (
      <span className="flex items-center gap-1 bg-green-500/10 border border-green-500/20 rounded-full px-2 py-0.5">
        <span className="text-[11px] font-bold text-green-400 tabular-nums">{odds(decimal)}</span>
      </span>
    );
  }

  return (
    <button
      onClick={(e) => { e.stopPropagation(); onBet(); }}
      className="flex items-center gap-1 bg-green-500/10 border border-green-500/20 rounded-full px-2 py-0.5 active:bg-green-500/20 transition-colors"
    >
      <span className="text-[11px] text-[#bfc8cc]">{bookmaker.label}</span>
      <span className="text-[11px] font-bold text-green-400 tabular-nums">{odds(decimal)}</span>
    </button>
  );
}

// ─── Edge badge ────────────────────────────────────────────────────────────────

function EdgeBadge({ edge }: { edge: number }) {
  const { t } = useI18n();
  if (edge < 8) return null;
  return (
    <span className="text-[11px] px-2 py-0.5 rounded-full bg-green-500/10 border border-green-500/25 text-green-400 font-medium flex-shrink-0">
      {t("home.edge", { edge })}
    </span>
  );
}

// ─── Étiquette de jour d'un match ─────────────────────────────────────────────

/**
 * « Auj. », « Demain », sinon « mar. 22 sept. ».
 *
 * Lue sur `startTimeUTC` — l'INSTANT de la mise au jeu, ramené au fuseau de la
 * personne — et non sur `gameDate`, qui est le jour NHL : un match du mardi
 * 19 h ET porte déjà la date du mercredi en UTC. `gameDate` ne sert que de
 * repli, et il est découpé à la main plutôt que passé à `new Date()`, qui
 * lirait « 2026-09-22 » comme minuit UTC et pourrait reculer d'un jour.
 */
/** La journée LNH d'un match (`YYYY-MM-DD`) : `gameDate`, sinon l'instant UTC. */
export function gameIsoDay(game: DisplayGame): string | undefined {
  return game.gameDate?.slice(0, 10) || game.startTimeUTC?.slice(0, 10) || undefined;
}

function gameDayLabel(game: DisplayGame, lang: string): string | null {
  const locale = lang === "fr" ? "fr-CA" : "en-US";
  let d: Date | null = null;
  if (game.startTimeUTC) {
    const parsed = new Date(game.startTimeUTC);
    if (!Number.isNaN(parsed.getTime())) d = parsed;
  }
  if (!d && game.gameDate) {
    const [y, m, day] = game.gameDate.slice(0, 10).split("-").map(Number);
    if (y && m && day) d = new Date(y, m - 1, day);
  }
  if (!d) return null;

  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(d) - startOfDay(new Date())) / 86_400_000);
  if (days === 0) return lang === "fr" ? "Auj." : "Today";
  if (days === 1) return lang === "fr" ? "Demain" : "Tmrw";
  return d.toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric" });
}

// ─── Probabilités et edge d'une carte de match ────────────────────────────────

/**
 * Ce que les deux cartes de l'accueil affichent d'un match : les deux
 * probabilités du modèle et l'écart avec le prix du book.
 *
 * ── Ce bloc portait aussi l'AJOUT RAPIDE, retiré le 2026-09-20 ──────────────
 *
 * Un « + » sur la ligne de match (et son jumeau « Ajouter » sur la carte en
 * direct) inscrivait d'un geste le moneyline de l'équipe à DOMICILE, puis
 * passait au ✓ vert. Deux problèmes : rien à l'écran ne disait quelle
 * sélection venait d'être posée — on croyait ouvrir le match, on repartait
 * avec un pari — et le ✓ ne se défaisait pas depuis l'accueil, il fallait
 * aller le retirer dans le pari. « Plus de paris » reste le chemin, et il
 * montre ce qu'on choisit.
 */
function useGameEdge(game: DisplayGame) {
  const homePct = game.team1.winPct;
  const awayPct = game.team2.winPct;
  // Pas de probabilité modèle → pas d'edge à afficher.
  const edge = game.bet365Home != null && homePct != null ? calcEdge(homePct, game.bet365Home) : 0;
  return { homePct, awayPct, edge };
}

// ─── Hockey live game card ─────────────────────────────────────────────────────

export function LiveGameCard({ game, onOpenSheet }: { game: DisplayGame; onOpenSheet: () => void }) {
  const { theme } = useSport();
  const accent = theme.accent;
  const { t } = useI18n();
  const navigate = useNavigate();
  const { homePct, awayPct, edge } = useGameEdge(game);

  return (
    <div
      onClick={() => navigate(`/stats/prediction/game/${game.id}`)}
      className="min-w-[280px] icy-card rounded-2xl p-4 flex-shrink-0 cursor-pointer active:scale-[0.99] transition-transform"
    >

      {/* Header: live badge + edge + buttons */}
      <div className="flex items-center justify-between mb-3 gap-2">
        <span className="text-[11px] text-red-400 font-medium uppercase tracking-wide flex items-center gap-1 flex-shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse inline-block" />{game.period}
        </span>
        <div className="flex items-center gap-1.5 min-w-0">
          <EdgeBadge edge={edge} />
          <button
            onClick={(e) => { e.stopPropagation(); onOpenSheet(); }}
            className="text-[11px] text-[#bfc8cc] border border-white/20 px-2 py-0.5 rounded-full flex-shrink-0 active:bg-white/5"
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
          {game.overUnder && <span className="text-[#bfc8cc] text-[11px]">O/U {game.overUnder}</span>}
        </div>
        <div className="flex flex-col items-center gap-1">
          <img src={game.team2.logo} alt={game.team2.abbr} className="w-8 h-8 object-contain" />
          <span className="text-white text-xs font-bold">{game.team2.abbr}</span>
        </div>
      </div>

      {/* Model probability bar */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] font-bold w-7 flex-shrink-0" style={{ color: accent }}>{homePct != null ? `${homePct}%` : "—"}</span>
        <div className="flex-1 bg-[#0A0E0C] rounded-full h-2 overflow-hidden flex">
          <div className="h-full rounded-l-full transition-all duration-500" style={{ width: `${homePct ?? 0}%`, backgroundColor: accent }} />
          <div className="h-full bg-[#1B2419] flex-1" />
        </div>
        <span className="text-[#bfc8cc] text-[11px] font-bold w-7 text-right flex-shrink-0">{awayPct != null ? `${awayPct}%` : "—"}</span>
      </div>

      {/* bet365 odds row — only shown when API has real odds */}
      {game.bet365Home && game.bet365Away ? (
        <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/5">
          <OddsPill decimal={game.bet365Home} onBet={() => openBet("hockey")} />
          <span className="text-[11px] text-[#bfc8cc]">Moneyline</span>
          <OddsPill decimal={game.bet365Away} onBet={() => openBet("hockey")} />
          {/* Moneyline is a universal betting term, kept as-is */}
        </div>
      ) : features.bookmakerLinks ? (
        /* No API key — show a subtle link to bet365 instead.
           Nothing to show on iOS: no odds and no link out (Guideline 5.3). */
        <div className="flex items-center justify-end mt-1">
          <button
            onClick={(e) => { e.stopPropagation(); openBet("hockey"); }}
            className="text-[11px] text-green-400 border border-green-500/20 bg-green-500/8 px-2 py-1 rounded-full"
          >
            {t("home.betOn")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ─── Hockey upcoming game row ──────────────────────────────────────────────────

export function UpcomingGameRow({ game, onOpenSheet }: { game: DisplayGame; onOpenSheet: () => void }) {
  const { theme } = useSport();
  const accent = theme.accent;
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const { homePct, awayPct, edge } = useGameEdge(game);
  // Le jour de semaine, toujours : le titre de la journée est au-dessus, mais
  // une carte doit se lire seule (capture d'écran, défilement rapide).
  const day = weekdayShort(gameIsoDay(game), lang) || gameDayLabel(game, lang);

  return (
    <div
      onClick={() => navigate(`/stats/prediction/game/${game.id}`)}
      className="icy-card rounded-2xl p-3.5 cursor-pointer active:scale-[0.99] transition-transform"
    >
      <div className="flex items-center gap-3">

        {/* Colonne date + heure.
            La date manquait : la section de l'accueil peut porter les matchs
            de demain ou d'après-demain, et « 19:00 » seul ne dit pas lequel. */}
        <div className="flex flex-col items-center min-w-[52px] flex-shrink-0">
          {day && <span className="text-[#bfc8cc] text-[11px] whitespace-nowrap">{day}</span>}
          <span className="text-xs font-medium" style={{ color: accent }}>{game.time}</span>
          <span className="text-[#bfc8cc] text-[11px]">ET</span>
        </div>

        {/* Teams column */}
        <div className="flex-1 min-w-0">
          {/* Team 1 */}
          <div className="flex items-center gap-1.5 mb-1.5">
            <img src={game.team1.logo} alt={game.team1.abbr} className="w-5 h-5 object-contain flex-shrink-0" />
            <span className="text-white text-xs font-medium flex-1 truncate">{game.team1.abbr}</span>
            <span className="text-[11px] font-bold tabular-nums" style={{ color: accent }}>{homePct != null ? `${homePct}%` : "—"}</span>
            {game.bet365Home && (
              <OddsPill decimal={game.bet365Home} onBet={() => openBet("hockey")} />
            )}
          </div>
          {/* Team 2 */}
          <div className="flex items-center gap-1.5">
            <img src={game.team2.logo} alt={game.team2.abbr} className="w-5 h-5 object-contain flex-shrink-0" />
            <span className="text-white text-xs font-medium flex-1 truncate">{game.team2.abbr}</span>
            <span className="text-[#bfc8cc] text-[11px] font-bold tabular-nums">{awayPct != null ? `${awayPct}%` : "—"}</span>
            {game.bet365Away && (
              <OddsPill decimal={game.bet365Away} onBet={() => openBet("hockey")} />
            )}
          </div>
        </div>

        {/* Actions column */}
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          {edge >= 8 && <EdgeBadge edge={edge} />}
          {/* O/U info */}
          {game.overUnder && (
            <div className="text-right">
              <span className="text-[11px] text-[#bfc8cc]">O/U {game.overUnder}</span>
              {game.totalPct != null && <span className="text-[11px] text-[#90C9F0] ml-1">{game.totalPct}%</span>}
            </div>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onOpenSheet(); }}
            className="text-[11px] text-[#bfc8cc] underline underline-offset-2"
          >
            {t("home.moreBets")}
          </button>
        </div>
      </div>
    </div>
  );
}
