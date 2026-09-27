/**
 * LandingCards.tsx
 *
 * Extrait de HockeyLanding.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { weekdayShort } from "../../data/gameDay";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { IceedgeLogo } from "../../components/brand/IceedgeLogo";
import { useSport } from "../../context/SportContext";
import { useI18n } from "../../i18n";
import { openBet } from "../../services/bookmakers";
import { features } from "../../platform";
import { BookPricePill } from "../../components/BookPricePill";
import { fetchGameMlBundle, type GameMlBundle } from "../../components/MLPredictionCard";
import { mlBundleKey } from "../prediction/gameMarkets";
import { DisplayGame, calcEdge } from "./landingTypes";


// ─── Brand header (logo always returns home) ───────────────────────────────────

/**
 * En-tête de marque : le mot-clé cliquable qui ramène à l'accueil.
 *
 * Ce composant a porté un sélecteur de sport, d'où son nom ; le sous-libellé est
 * tombé le 2026-08-21 et le tennis est sorti du produit le 2026-08-24. Le nom est
 * conservé pour ne pas toucher au seul appelant sans raison.
 */
export function SportSelector({ compact = false }: { compact?: boolean }) {
  const navigate = useNavigate();
  // `compact` (2026-09-27) : l'en-tête se réduit quand on fait défiler
  // l'accueil. La hauteur du bouton suit (44 → 28 px), et le contenu est mis à
  // l'échelle plutôt que redessiné à une autre taille : la transition reste
  // fluide et le logo ne recharge pas une autre variante d'image.
  return (
    <button
      onClick={() => navigate("/")}
      className="w-full flex items-center justify-center select-none"
      style={{ height: compact ? 28 : 44, transition: "height 0.25s ease" }}
      aria-label="Accueil ArakIce"
    >
      <span
        className="flex items-center gap-3"
        style={{
          transform: `scale(${compact ? 0.64 : 1})`,
          transformOrigin: "center",
          transition: "transform 0.25s ease",
        }}
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
      </span>
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
/**
 * ⏸️ Probabilités du modèle MASQUÉES sur les cartes de match de l'accueil
 * (2026-09-24), jusqu'au début de la saison régulière NHL 2026-27.
 *
 * En pré-saison le modèle sort des chiffres serrés (53 % – 47 %) sur des
 * alignements qui ne sont pas ceux de la saison : affichés à côté de chaque
 * match, ils intriguent plus qu'ils n'aident. Masqué : le pourcentage des deux
 * équipes, la barre de la carte en direct, le % du O/U et le badge d'edge (il
 * se calcule sur ce même chiffre). Le reste de l'app (page du match, meilleurs
 * paris) n'est pas touché.
 *
 * ▶ Au début de la saison : repasser à `true`, rien d'autre à faire.
 *   Suivi dans `STATUS.md` § 3.2.
 *
 * ⚠️ Le tableau Handicap / Vainqueur des matchs à venir (2026-09-27) affiche
 * le % du modèle ML À LA DEMANDE de l'utilisatrice : il ne lit PAS ce drapeau.
 * Celui-ci ne masque plus que la barre de la carte en direct et le badge
 * d'edge.
 */
const SHOW_MODEL_PCT_ON_HOME = false;

function useGameEdge(game: DisplayGame) {
  if (!SHOW_MODEL_PCT_ON_HOME) return { homePct: null, awayPct: null, edge: 0, showPct: false };
  const homePct = game.team1.winPct;
  const awayPct = game.team2.winPct;
  // Pas de probabilité modèle → pas d'edge à afficher.
  const edge = game.bookHome != null && homePct != null ? calcEdge(homePct, game.bookHome) : 0;
  return { homePct, awayPct, edge, showPct: true };
}

// ─── Hockey live game card ─────────────────────────────────────────────────────

export function LiveGameCard({ game, onOpenSheet }: { game: DisplayGame; onOpenSheet: () => void }) {
  const { theme } = useSport();
  const accent = theme.accent;
  const { t } = useI18n();
  const navigate = useNavigate();
  const { homePct, awayPct, edge, showPct } = useGameEdge(game);

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
      {showPct && <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] font-bold w-7 flex-shrink-0" style={{ color: accent }}>{homePct != null ? `${homePct}%` : "—"}</span>
        <div className="flex-1 bg-[#0A0E0C] rounded-full h-2 overflow-hidden flex">
          <div className="h-full rounded-l-full transition-all duration-500" style={{ width: `${homePct ?? 0}%`, backgroundColor: accent }} />
          <div className="h-full bg-[#1B2419] flex-1" />
        </div>
        <span className="text-[#bfc8cc] text-[11px] font-bold w-7 text-right flex-shrink-0">{awayPct != null ? `${awayPct}%` : "—"}</span>
      </div>}

      {/* Ligne des vrais prix — seulement quand le livre en propose */}
      {game.bookHome && game.bookAway ? (
        <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/5">
          <BookPricePill price={game.bookHome} />
          <span className="text-[11px] text-[#bfc8cc]">Moneyline</span>
          <BookPricePill price={game.bookAway} />
          {/* Moneyline is a universal betting term, kept as-is */}
        </div>
      ) : features.bookmakerLinks ? (
        /* Pas de prix — un simple lien vers le livre réglé.
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

/**
 * Chiffres du MODÈLE ML d'un match pour le tableau de la ligne : vainqueur et
 * handicap ±1.5, lus dans le paquet ML du match (`GET /predict/game/:id/bundle`
 * — une requête par match, gardée 10 min côté serveur et 5 min côté client,
 * et la même que rouvre la page du match).
 *
 * Chaque paire totalise 100 % PAR CONSTRUCTION : on lit un seul côté et on
 * prend le complément (pas de push sur une demi-ligne, pas de nul au
 * moneyline). `undefined` = en cours, `null` = modèle indisponible.
 */
interface HomeMl {
  homeWin: number | null;
  /** P(domicile −1.5) et P(visiteur −1.5). */
  homeMinus: number | null;
  awayMinus: number | null;
}
function useHomeMl(gameId: string): HomeMl | null | undefined {
  const [bundle, setBundle] = useState<GameMlBundle | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setBundle(undefined);
    fetchGameMlBundle(gameId).then((b) => { if (alive) setBundle(b); });
    return () => { alive = false; };
  }, [gameId]);
  if (bundle === undefined) return undefined;
  if (bundle === null) return null;
  const p = (k: string) => {
    const v = bundle.byKey[k]?.probability;
    return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
  };
  return {
    homeWin: p(mlBundleKey("moneyline", null, null, true)),
    homeMinus: p(mlBundleKey("puck_line", -1.5, null, true)),
    awayMinus: p(mlBundleKey("puck_line", -1.5, null, false)),
  };
}

/** Un % du modèle ML (violet, comme partout où l'app montre le ML). */
function MlPct({ value, loading }: { value: number | null; loading: boolean }) {
  return (
    <span className="text-[11px] font-bold tabular-nums w-[30px] text-right flex-shrink-0" style={{ color: "#c4b5fd" }}>
      {loading ? "…" : value != null ? `${value}%` : "—"}
    </span>
  );
}

export function UpcomingGameRow({ game, onOpenSheet }: { game: DisplayGame; onOpenSheet: () => void }) {
  const { theme } = useSport();
  const accent = theme.accent;
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const { edge } = useGameEdge(game);
  const ml = useHomeMl(game.id);
  const mlLoading = ml === undefined;
  // Le jour de semaine, toujours : le titre de la journée est au-dessus, mais
  // une carte doit se lire seule (capture d'écran, défilement rapide).
  const day = weekdayShort(gameIsoDay(game), lang) || gameDayLabel(game, lang);

  // ── Qui porte le −1.5 ? ──────────────────────────────────────────────────
  // D'abord le livre (c'est la ligne réellement proposée, et sa cote doit
  // aller avec), puis le modèle ML, puis la cote du vainqueur, puis domicile.
  const spread = game.bookSpread;
  const homeFav =
    spread?.home ? spread.home.point < 0
    : spread?.away ? spread.away.point > 0
    : ml?.homeWin != null ? ml.homeWin >= 50
    : game.bookHome && game.bookAway ? game.bookHome <= game.bookAway
    : true;

  // Vainqueur : le visiteur est le complément exact du domicile.
  const winHome = ml?.homeWin ?? null;
  const winAway = winHome == null ? null : 100 - winHome;
  // Handicap : le favori à −1.5, l'autre à +1.5 = complément du −1.5 adverse.
  const favMinus = homeFav ? ml?.homeMinus ?? null : ml?.awayMinus ?? null;
  const plHome = homeFav ? favMinus : favMinus == null ? null : 100 - favMinus;
  const plAway = homeFav ? (favMinus == null ? null : 100 - favMinus) : favMinus;
  const lineHome = homeFav ? -1.5 : 1.5;
  const lineAway = -lineHome;
  // La cote du livre n'accompagne que SA ligne.
  const priceHome = spread?.home && spread.home.point === lineHome ? spread.home.price : undefined;
  const priceAway = spread?.away && spread.away.point === lineAway ? spread.away.price : undefined;

  const teamRow = (
    side: { logo: string; abbr: string },
    line: number, pl: number | null, plPrice: number | undefined,
    win: number | null, winPrice: number | undefined,
  ) => (
    <>
      <div className="flex items-center gap-1.5 min-w-0">
        <img src={side.logo} alt={side.abbr} className="w-5 h-5 object-contain flex-shrink-0" />
        <span className="text-white text-xs font-medium truncate">{side.abbr}</span>
      </div>
      {/* Handicap */}
      <div className="flex items-center gap-1">
        <span className="text-[#bfc8cc] text-[11px] font-semibold tabular-nums w-[26px] flex-shrink-0">
          {line > 0 ? "+1.5" : "−1.5"}
        </span>
        <MlPct value={pl} loading={mlLoading} />
        {plPrice != null && <BookPricePill price={plPrice} />}
      </div>
      {/* Vainqueur */}
      <div className="flex items-center gap-1">
        <MlPct value={win} loading={mlLoading} />
        {winPrice != null && <BookPricePill price={winPrice} />}
      </div>
    </>
  );

  return (
    <div
      onClick={() => navigate(`/stats/prediction/game/${game.id}`)}
      className="icy-card rounded-2xl p-3.5 cursor-pointer active:scale-[0.99] transition-transform"
    >
      <div className="flex items-center gap-3">

        {/* Colonne date + heure.
            La date manquait : la section de l'accueil peut porter les matchs
            de demain ou d'après-demain, et « 19:00 » seul ne dit pas lequel. */}
        <div className="flex flex-col items-center min-w-[44px] flex-shrink-0">
          {day && <span className="text-[#bfc8cc] text-[11px] whitespace-nowrap">{day}</span>}
          <span className="text-xs font-medium" style={{ color: accent }}>{game.time}</span>
          <span className="text-[#bfc8cc] text-[11px]">ET</span>
        </div>

        {/* Équipes + tableau Handicap / Vainqueur (2026-09-27).
            Remplace les pastilles à côté des équipes et le O/U : deux colonnes
            collées aux équipes, sans bordure de tableau. Chaque case = le % du
            modèle ML (violet) + la cote du livre quand il la propose (vert). */}
        <div
          className="grid items-center gap-x-2.5 gap-y-1.5 flex-shrink-0"
          style={{ gridTemplateColumns: "auto auto auto" }}
        >
          <span />
          <span className="text-[#8a9ea6] text-[11px] font-semibold">{t("home.colSpread")}</span>
          <span className="text-[#8a9ea6] text-[11px] font-semibold">{t("home.colWinner")}</span>
          {teamRow(game.team1, lineHome, plHome, priceHome, winHome, game.bookHome)}
          {teamRow(game.team2, lineAway, plAway, priceAway, winAway, game.bookAway)}
        </div>

        {/* Actions column */}
        <div className="flex flex-col items-end gap-1.5 flex-1 min-w-0">
          {edge >= 8 && <EdgeBadge edge={edge} />}
          <button
            onClick={(e) => { e.stopPropagation(); onOpenSheet(); }}
            className="text-[11px] text-[#bfc8cc] underline underline-offset-2 text-right leading-tight"
          >
            {t("home.moreBets")}
          </button>
        </div>
      </div>
    </div>
  );
}
