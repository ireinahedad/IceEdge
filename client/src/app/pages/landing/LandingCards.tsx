/**
 * LandingCards.tsx
 *
 * Extrait de HockeyLanding.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { weekdayShort } from "../../data/gameDay";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { IceedgeLogo } from "../../components/brand/IceedgeLogo";
import { useSport } from "../../context/SportContext";
import { useBet } from "../../context/BetContext";
import type { BetLeg } from "../../types/bet";
import { useI18n } from "../../i18n";
import { openBet } from "../../services/bookmakers";
import { features } from "../../platform";
import { BookPricePill } from "../../components/BookPricePill";
import { fetchGameMlBundle, type GameMlBundle } from "../../components/MLPredictionCard";
import { mlBundleKey } from "../prediction/gameMarkets";
import { teamAccent } from "../../data/teamEmoji";
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
 *
 * ▶ Revenu le 2026-09-28 sous une autre forme, à la demande du user : chaque
 *   case du tableau Handicap / Vainqueur est une sélection précise (toucher =
 *   ajout, case entourée de vert ; double toucher = retrait). Les deux reproches
 *   ci-dessus y trouvent leur réponse : on voit QUELLE case est prise, et elle
 *   se défait sur place. Voir `PickCell` plus bas.
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
 * ⚠️ Le tableau Handicap / Vainqueur des matchs à venir (2026-09-27) et sa
 * barre moneyline (2026-09-29) affichent le % du modèle ML À LA DEMANDE de
 * l'utilisatrice : ils ne lisent PAS ce drapeau.
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
 *
 * `enabled` (2026-09-29) : le calendrier ne le lève qu'à l'approche du
 * viewport. Une semaine y compte ~50 matchs, et `predictLimiter` plafonne la
 * route à 60 requêtes/min par compte en prod — tout demander d'un coup
 * ferait tomber les derniers en 429.
 */
interface HomeMl {
  homeWin: number | null;
  /** P(domicile −1.5) et P(visiteur −1.5). */
  homeMinus: number | null;
  awayMinus: number | null;
}
export function useGameMl(gameId: string, enabled = true): HomeMl | null | undefined {
  const [bundle, setBundle] = useState<GameMlBundle | null | undefined>(undefined);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setBundle(undefined);
    fetchGameMlBundle(gameId).then((b) => { if (alive) setBundle(b); });
    return () => { alive = false; };
  }, [gameId, enabled]);
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

// ─── Barre moneyline du modèle (2026-09-29) ──────────────────────────────────

/** Un bout de la barre : l'équipe, sa probabilité ML, la cote du livre s'il en a une. */
export interface MlBarSide { abbr: string; pct: number | null; price?: number }

/**
 * La prédiction moneyline en un coup d'œil : une barre partagée entre les deux
 * équipes, chacune à sa couleur de club, la favorite pleine et l'autre
 * estompée. Les chiffres, eux, restent en blanc / gris : plusieurs clubs
 * (TOR, NYR, EDM) ont une couleur trop sombre pour un texte de 11 px sur fond
 * de nuit — mesuré à l'écran le 2026-09-29. Sert à l'accueil (sous le tableau) et au calendrier (avec la cote
 * du livre à chaque bout).
 *
 * Les pourcentages sont des probabilités du modèle : toujours en %, jamais au
 * format de cote. Seule la cote du livre (`price`, via `BookPricePill`) suit
 * le réglage de format — la règle « prix vs estimation ».
 *
 * Pastilles en `link={false}` : la barre vit dans une carte qui ouvre la page
 * du match ; un bouton vers le livre caché dans la barre surprendrait.
 *
 * Sans probabilité (modèle indisponible) la barre disparaît : jamais de 50/50
 * de repli.
 */
export function MoneylineBar({ left, right, loading, className = "" }: {
  left: MlBarSide;
  right: MlBarSide;
  loading: boolean;
  className?: string;
}) {
  if (!loading && (left.pct == null || right.pct == null)) return null;
  const lc = teamAccent(left.abbr);
  const rc = teamAccent(right.abbr);
  const lp = left.pct ?? 50;
  const leftFav = lp >= 50;
  const pctCls = "text-[11px] font-bold tabular-nums w-[30px] flex-shrink-0";
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {left.price != null && <BookPricePill price={left.price} link={false} />}
      <span className={pctCls} style={{ color: loading || leftFav ? "#fff" : "#8a9ea6" }}>{loading ? "…" : `${left.pct}%`}</span>
      <div
        className={`flex-1 min-w-[40px] h-2 rounded-full overflow-hidden flex bg-white/10${loading ? " animate-pulse" : ""}`}
        role={loading ? undefined : "img"}
        aria-label={loading ? undefined : `Moneyline ML : ${left.abbr} ${left.pct}% – ${right.abbr} ${right.pct}%`}
      >
        {!loading && (
          <>
            <div className="h-full transition-[width] duration-500" style={{ width: `${lp}%`, background: lc, opacity: leftFav ? 1 : 0.6 }} />
            <div className="h-full w-[2px] flex-shrink-0 bg-[#0A0E0C]" aria-hidden />
            <div className="h-full flex-1" style={{ background: rc, opacity: leftFav ? 0.6 : 1 }} />
          </>
        )}
      </div>
      <span className={`${pctCls} text-right`} style={{ color: loading || !leftFav ? "#fff" : "#8a9ea6" }}>{loading ? "…" : `${right.pct}%`}</span>
      {right.price != null && <BookPricePill price={right.price} link={false} />}
    </div>
  );
}

// ─── Sélection au toucher du tableau Handicap / Vainqueur (2026-09-28) ───────

/**
 * Une case du tableau = UNE sélection, écrite sous la forme EXACTE que pose la
 * page du match (`nhlPredictions.ts`, fonctions `gm` / `gma`) — c'est ce qui
 * permet au règlement (`settlement.service.ts`) et au calcul du coupon
 * (`parlay.ts`) de la reconnaître sans rien leur apprendre :
 *
 *   vainqueur T  → moneyline, sélection T
 *   T −1.5       → puck_line, sujet T, sélection T, ligne −1.5
 *   U +1.5       → puck_line, sujet = l'adversaire T, sélection « no », ligne −1.5
 *                  (le complément exact du −1.5 adverse : pas d'égalité possible
 *                  sur une demi-ligne — même déclaration que la tuile « +x »)
 *
 * Toutes les équipes sont en minuscules, comme `DisplayGame.team*.id`.
 */
interface HomePick {
  marketType: "moneyline" | "puck_line";
  /** Équipe sur laquelle porte la jambe CÔTÉ RÈGLEMENT. */
  subject: string;
  opponent: string;
  subjectIsHome: boolean;
  /** « no » pour un +1.5, sinon l'équipe elle-même. */
  selectionValue: string;
  line?: number;
}

/**
 * La jambe du coupon correspond-elle à cette case, d'où qu'elle vienne ?
 *
 * Comparaison sur le SENS du pari, pas sur l'identifiant : une case prise
 * depuis la page du match, les meilleurs paris ou le sélecteur de marché
 * s'allume aussi en vert ici, et le double toucher la retire. Sans ça, on
 * pouvait poser deux fois le même pari sans le voir.
 *
 * Le sélecteur de marché écrit l'équipe dans `subjectId` et « yes » en
 * sélection, parfois sans ligne (−1.5 par défaut, comme le règlement).
 */
function legMatchesPick(leg: BetLeg, gameId: string, p: HomePick): boolean {
  if (leg.gameId !== gameId || leg.marketType !== p.marketType) return false;
  const sel = String(leg.selectionValue ?? "").trim().toLowerCase();
  const subj = String(leg.subjectId ?? "").trim().toLowerCase();
  const teamPicked = sel === p.subject || ((sel === "" || sel === "yes") && subj === p.subject);
  if (p.marketType === "moneyline") return teamPicked;
  if ((leg.line ?? -1.5) !== -1.5) return false;
  if (p.selectionValue === "no") return sel === "no" && subj === p.subject;
  return teamPicked;
}

/** Heure de mise au jeu prévue atteinte — la même règle que le serveur. */
function gameStarted(game: DisplayGame): boolean {
  const ms = game.startTimeUTC ? new Date(game.startTimeUTC).getTime() : NaN;
  return Number.isFinite(ms) && ms <= Date.now();
}

/** Deux touchers plus rapprochés que ça = un double toucher. */
const DOUBLE_TAP_MS = 350;

/**
 * Une case sélectionnable : toucher = ajoute au coupon (entourée de vert),
 * double toucher = retire.
 *
 * ⚠️ Le double toucher est détecté À LA MAIN, pas par `onDoubleClick` : iOS
 * (WKWebView) ne livre pas `dblclick` de façon fiable au toucher, et le premier
 * `click` d'un double part de toute façon. D'où la règle : le 1er toucher
 * ajoute (sans effet si déjà pris), le 2e rapproché retire. Un double toucher
 * sur une case vide la laisse donc vide — neutre, pas surprenant.
 *
 * Sans probabilité du modèle (en cours ou indisponible), la case ne pose rien :
 * une jambe garde sa probabilité jusqu'au règlement, un chiffre inventé ici
 * lui survivrait. Elle peut encore RETIRER une jambe posée ailleurs.
 *
 * TOUTE la case ajoute, cote comprise : la pastille y est posée en
 * `link={false}` (décision du user, 2026-09-28) — sinon la moitié de la case
 * Vainqueur ouvrait le livre au lieu d'ajouter le pari.
 *
 * Pas de pari en direct (décision du user, 2026-09-28) : la mise au jeu prévue
 * passée, la case ne pose plus rien, même si la ligne n'a pas encore glissé
 * dans la section « En direct ». Le serveur refuse de toute façon au
 * verrouillage (`GAME_STARTED`) ; ici on évite juste de laisser poser un pari
 * qu'il refusera.
 */
function PickCell({ game, pick, probability, team, label, short, children }: {
  game: DisplayGame;
  pick: HomePick;
  probability: number | null;
  /** L'équipe AFFICHÉE dans la case (celle du +1.5 n'est pas le sujet). */
  team: { abbr: string; logo: string };
  label: string;
  short: string;
  children: ReactNode;
}) {
  const { t, lang } = useI18n();
  const { legs, addLeg, removeLeg } = useBet();
  const lastTap = useRef(0);
  const matches = legs.filter((l) => legMatchesPick(l, game.id, pick));
  const selected = matches.length > 0;

  const tap = () => {
    const now = Date.now();
    const isDouble = now - lastTap.current < DOUBLE_TAP_MS;
    // Remis à zéro après un double : un triple toucher ne retire pas deux fois.
    lastTap.current = isDouble ? 0 : now;
    if (isDouble) { matches.forEach((l) => removeLeg(l.id)); return; }
    if (selected || probability == null || gameStarted(game)) return;
    const day = weekdayShort(gameIsoDay(game), lang) || gameDayLabel(game, lang);
    const leg: BetLeg = {
      id: `home-${game.id}-${pick.marketType}-${pick.subject}${pick.selectionValue === "no" ? "-no" : ""}`,
      marketType: pick.marketType,
      marketLabel: pick.marketType === "moneyline" ? "Moneyline" : "Puck Line",
      // « game » comme la page du match : le sujet est une équipe DU match.
      subjectType: "game",
      subjectId: pick.subject,
      subjectName: team.abbr,
      subjectLogo: team.logo,
      selection: label,
      selectionShort: short,
      probability,
      line: pick.line,
      gameInfo: [`${game.team1.abbr} vs ${game.team2.abbr}`, day, game.time ? `${game.time} ET` : null]
        .filter(Boolean).join(" · "),
      addedAt: new Date().toISOString(),
      gameId: game.id,
      selectionValue: pick.selectionValue,
      opponentId: pick.opponent,
      isHome: pick.subjectIsHome,
    };
    addLeg(leg);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      aria-label={`${label} — ${t("home.pickHint")}`}
      title={t("home.pickHint")}
      onClick={(e) => { e.stopPropagation(); tap(); }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault(); e.stopPropagation(); tap();
      }}
      className="flex items-center gap-1.5 rounded-lg px-1.5 py-1 -mx-1.5 -my-1 cursor-pointer select-none transition-colors"
      style={{
        // Bordure toujours présente (transparente) : la case ne bouge pas
        // d'un pixel quand elle s'allume.
        border: `1.5px solid ${selected ? "#4ade80" : "transparent"}`,
        background: selected ? "rgba(74,222,128,0.10)" : undefined,
        touchAction: "manipulation",
      }}
    >
      {children}
    </div>
  );
}

export function UpcomingGameRow({ game, onOpenSheet }: { game: DisplayGame; onOpenSheet: () => void }) {
  const { theme } = useSport();
  const accent = theme.accent;
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const { edge } = useGameEdge(game);
  const ml = useGameMl(game.id);
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

  // Chaque case est sélectionnable (`PickCell`) : voir `HomePick` pour la
  // forme exacte de la jambe posée.
  const teamRow = (
    side: { id: string; logo: string; abbr: string },
    other: { id: string },
    isHome: boolean,
    line: number, pl: number | null, plPrice: number | undefined,
    win: number | null, winPrice: number | undefined,
  ) => {
    const plPick: HomePick = line < 0
      ? { marketType: "puck_line", subject: side.id, opponent: other.id, subjectIsHome: isHome, selectionValue: side.id, line: -1.5 }
      : { marketType: "puck_line", subject: other.id, opponent: side.id, subjectIsHome: !isHome, selectionValue: "no", line: -1.5 };
    const winPick: HomePick =
      { marketType: "moneyline", subject: side.id, opponent: other.id, subjectIsHome: isHome, selectionValue: side.id };
    return (
      <>
        <div className="flex items-center gap-1.5 min-w-0">
          <img src={side.logo} alt={side.abbr} className="w-5 h-5 object-contain flex-shrink-0" />
          <span className="text-white text-xs font-medium truncate">{side.abbr}</span>
        </div>
        {/* Handicap */}
        <PickCell
          game={game} pick={plPick} probability={pl} team={side}
          label={line < 0 ? t("bb.puckLine", { abbr: side.abbr }) : t("home.plPlus", { abbr: side.abbr })}
          short={`${side.abbr} ${line < 0 ? "-1.5" : "+1.5"}`}
        >
          <span className="text-[#bfc8cc] text-[11px] font-semibold tabular-nums w-[26px] flex-shrink-0">
            {line > 0 ? "+1.5" : "−1.5"}
          </span>
          <MlPct value={pl} loading={mlLoading} />
          {plPrice != null && <BookPricePill price={plPrice} link={false} />}
        </PickCell>
        {/* Vainqueur */}
        <PickCell
          game={game} pick={winPick} probability={win} team={side}
          label={t("bb.teamWin", { abbr: side.abbr })}
          short={`${side.abbr} ML`}
        >
          <MlPct value={win} loading={mlLoading} />
          {winPrice != null && <BookPricePill price={winPrice} link={false} />}
        </PickCell>
      </>
    );
  };

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
        {/* Collé à DROITE, juste avant « Plus de paris » (demande du user,
            2026-09-28 — il était centré). Sur mobile, où « Plus de paris » est
            masqué, il va donc jusqu'au bord de la carte. */}
        <div className="flex-1 min-w-0 flex justify-end">
        <div
          className="grid items-center gap-x-4 gap-y-2"
          style={{ gridTemplateColumns: "auto auto auto" }}
        >
          <span />
          <span className="text-[#8a9ea6] text-[11px] font-semibold">{t("home.colSpread")}</span>
          <span className="text-[#8a9ea6] text-[11px] font-semibold">{t("home.colWinner")}</span>
          {teamRow(game.team1, game.team2, true, lineHome, plHome, priceHome, winHome, game.bookHome)}
          {teamRow(game.team2, game.team1, false, lineAway, plAway, priceAway, winAway, game.bookAway)}
        </div>
        </div>

        {/* Actions column.
            « Plus de paris » MASQUÉ sous 768 px (décision du user, 2026-09-28) :
            sur un téléphone, ses 60 px écrasaient la colonne des équipes et
            les abréviations (MTL, TOR) tombaient à 0 px de large. Toucher la
            carte ouvre la page du match, qui porte tous les marchés. La colonne
            reste là si elle a un badge d'edge à montrer. */}
        <div className={`${edge >= 8 ? "flex" : "hidden md:flex"} flex-col items-end gap-1.5 flex-shrink-0 max-w-[60px]`}>
          {edge >= 8 && <EdgeBadge edge={edge} />}
          <button
            onClick={(e) => { e.stopPropagation(); onOpenSheet(); }}
            className="hidden md:block text-[11px] text-[#bfc8cc] underline underline-offset-2 text-right leading-tight"
          >
            {t("home.moreBets")}
          </button>
        </div>
      </div>

      {/* Barre moneyline (2026-09-29) : la prédiction ML en un coup d'œil,
          domicile à gauche comme il est en haut du tableau. Les cotes sont
          déjà dans le tableau : pas de pastilles ici. */}
      <MoneylineBar
        className="mt-3"
        left={{ abbr: game.team1.abbr, pct: winHome }}
        right={{ abbr: game.team2.abbr, pct: winAway }}
        loading={mlLoading}
      />
    </div>
  );
}
