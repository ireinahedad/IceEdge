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
import { ChevronLeft, ChevronRight } from "lucide-react";
import { IceedgeLogo } from "../../components/brand/IceedgeLogo";
import { useSport } from "../../context/SportContext";
import { useBet } from "../../context/BetContext";
import type { BetLeg } from "../../types/bet";
import { useI18n } from "../../i18n";
import { toast } from "../../toast";
import { BookPricePill, FairOddsPill } from "../../components/BookPricePill";
import { fetchGameMlBundle, type GameMlBundle } from "../../components/MLPredictionCard";
import { mlBundleKey } from "../prediction/gameMarkets";
import { DisplayGame } from "./landingTypes";
import { formatRecord, useTeamRecords } from "../charts/teamSpace";


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
            fontFamily: "'Oswald', 'Oswald Fallback', 'Arial Narrow', sans-serif",
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

// ─── Probabilités d'une carte de match ────────────────────────────────────────

/**
 * Ce que les deux cartes de l'accueil affichent d'un match : les deux
 * probabilités du modèle.
 *
 * ── Le badge d'edge, retiré le 2026-10-02 ───────────────────────────────────
 *
 * Il calculait un TROISIÈME edge, à lui : marge du livre non retirée, seuil
 * 8 points, côté domicile seulement, visible par tous et jusque sur les cartes
 * EN DIRECT (proba d'avant-match contre cote en direct). Décision du user : la
 * section Value bets (Pro, critère serveur `valueBets.service.ts`) est le seul
 * endroit de l'accueil qui parle d'edge.
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
 * équipes, la barre de la carte en direct et le % du O/U. Le reste de l'app
 * (page du match, meilleurs paris) n'est pas touché.
 *
 * ✔ Repassé à `true` le 2026-09-30 : la saison régulière 2026-27 a commencé
 *   le 29 septembre (heure de l'Est). Pour la prochaine pré-saison, remettre
 *   `false` vers la mi-septembre et le rallumer au premier match de saison.
 *
 * ⚠️ Le tableau Handicap / Vainqueur des matchs à venir (2026-09-27) et sa
 * barre du vainqueur (2026-09-29) affichent le % du modèle ML À LA DEMANDE de
 * l'utilisatrice : ils ne lisent PAS ce drapeau.
 * Celui-ci ne masque plus que la barre de la carte en direct.
 */
const SHOW_MODEL_PCT_ON_HOME = true;

/** « 54% », « … » tant que le paquet ML n'est pas arrivé, « — » s'il est indisponible. */
function pctLabel(pct: number | null | undefined): string {
  return pct != null ? `${pct}%` : pct === undefined ? "…" : "—";
}

function useGamePct(game: DisplayGame) {
  if (!SHOW_MODEL_PCT_ON_HOME) return { homePct: null, awayPct: null, showPct: false };
  return { homePct: game.team1.winPct, awayPct: game.team2.winPct, showPct: true };
}

// ─── Hockey live game card ─────────────────────────────────────────────────────

/**
 * Carte d'un match en direct.
 *
 * 2026-09-30 (demande du user) : plus de bouton « Plus », plus de « Parier » ;
 * sous le score, la fiche V-D-DP de la saison en cours de chaque équipe au
 * lieu du O/U ; et en bas deux boutons, Statistiques (page du match dans les
 * graphiques) et Prédiction (page de prédiction du match).
 */
export function LiveGameCard({ game }: { game: DisplayGame }) {
  const { theme } = useSport();
  const accent = theme.accent;
  const { t } = useI18n();
  const navigate = useNavigate();
  const { homePct, awayPct, showPct } = useGamePct(game);
  const records = useTeamRecords();
  const go = (e: React.MouseEvent, to: string) => { e.stopPropagation(); navigate(to); };

  return (
    <div
      data-live-card
      onClick={() => navigate(`/stats/prediction/game/${game.id}`)}
      className="w-[280px] icy-card rounded-2xl p-4 flex-shrink-0 cursor-pointer active:scale-[0.99] transition-transform"
    >

      {/* Header: live badge */}
      <div className="flex items-center justify-between mb-3 gap-2">
        <span className="text-[11px] text-red-400 font-medium uppercase tracking-wide flex items-center gap-1 flex-shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse inline-block" />{game.period}
        </span>
      </div>

      {/* Teams + score */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex flex-col items-center gap-1">
          <img src={game.team1.logo} alt={game.team1.abbr} className="w-8 h-8 object-contain" />
          <span className="text-white text-xs font-bold">{game.team1.abbr}</span>
          <span className="text-[#8a9ea6] text-[11px] tabular-nums" title={t("chart.recordLegend")}>{formatRecord(records, game.team1.abbr)}</span>
        </div>
        <div className="flex items-center gap-2.5">
          <span className="text-white text-3xl font-bold tabular-nums">{game.team1.score}</span>
          <span className="text-[#bfc8cc] text-lg">–</span>
          <span className="text-white text-3xl font-bold tabular-nums">{game.team2.score}</span>
        </div>
        <div className="flex flex-col items-center gap-1">
          <img src={game.team2.logo} alt={game.team2.abbr} className="w-8 h-8 object-contain" />
          <span className="text-white text-xs font-bold">{game.team2.abbr}</span>
          <span className="text-[#8a9ea6] text-[11px] tabular-nums" title={t("chart.recordLegend")}>{formatRecord(records, game.team2.abbr)}</span>
        </div>
      </div>

      {/* Model probability bar */}
      {showPct && <div className="flex items-center gap-2 mb-2">
        <span className="text-[11px] font-bold w-7 flex-shrink-0" style={{ color: accent }}>{pctLabel(homePct)}</span>
        <div className="flex-1 bg-[#0A0E0C] rounded-full h-1 overflow-hidden flex">
          <div className="h-full rounded-l-full transition-all duration-500" style={{ width: `${homePct ?? 0}%`, backgroundColor: accent }} />
          <div className="h-full bg-[#1B2419] flex-1" />
        </div>
        <span className="text-[#bfc8cc] text-[11px] font-bold w-7 text-right flex-shrink-0">{pctLabel(awayPct)}</span>
      </div>}

      {/* Ligne des vrais prix — seulement quand le livre en propose */}
      {game.bookHome && game.bookAway ? (
        <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/5">
          {/* Match EN DIRECT : pas de cote minimale, notre % est d'avant-match. */}
          <BookPricePill price={game.bookHome} ticket={{
            match: `${game.team2.abbr} @ ${game.team1.abbr}`, when: game.period ?? null,
            market: t("handoff.mktWinner"), selection: t("home.evWinnerShort", { team: game.team1.abbr }),
          }} />
          <span className="text-[11px] text-[#bfc8cc]">Moneyline</span>
          <BookPricePill price={game.bookAway} ticket={{
            match: `${game.team2.abbr} @ ${game.team1.abbr}`, when: game.period ?? null,
            market: t("handoff.mktWinner"), selection: t("home.evWinnerShort", { team: game.team2.abbr }),
          }} />
          {/* Moneyline is a universal betting term, kept as-is */}
        </div>
      ) : showPct && homePct != null && awayPct != null ? (
        /* Pas de prix du livre : la cote juste du modèle, en gris (2026-10-02). */
        <div className="flex items-center justify-between mt-2 pt-2 border-t border-white/5">
          <FairOddsPill pct={homePct} title={t("home.oddsFairHint")} />
          <span className="text-[11px] text-[#bfc8cc]">Moneyline</span>
          <FairOddsPill pct={awayPct} title={t("home.oddsFairHint")} />
        </div>
      ) : null}

      {/* Statistiques · Prédiction du match (remplacent « Parier », 2026-09-30). */}
      <div className="grid grid-cols-2 gap-2 mt-2">
        <button
          onClick={(e) => go(e, `/stats/chart/game/${game.id}`)}
          className="tap-44 text-[11px] font-semibold rounded-full px-3 py-1.5 border active:scale-95 transition-transform"
          style={{ color: accent, borderColor: `${accent}4d`, background: `${accent}1a` }}
        >
          {t("home.teamStats")}
        </button>
        <button
          onClick={(e) => go(e, `/stats/prediction/game/${game.id}`)}
          className="tap-44 text-[11px] font-semibold rounded-full px-3 py-1.5 border active:scale-95 transition-transform"
          style={{ color: "#c4b5fd", borderColor: "#c4b5fd4d", background: "#c4b5fd1a" }}
        >
          {t("home.teamPrediction")}
        </button>
      </div>
    </div>
  );
}

/**
 * La rangée « En direct » (2026-09-30) : un vrai conteneur défilant, au doigt
 * et avec les mêmes flèches que le bandeau des équipes (`.jersey-arrow`). Elle
 * remplace le défilement automatique en boucle, qui dupliquait les cartes —
 * avec deux matchs en direct on voyait quatre cartes. Chaque flèche avance
 * d'une carte ; l'aimantation (`scroll-snap`) garde une carte bien cadrée.
 */
export function LiveGamesRow({ games }: { games: DisplayGame[] }) {
  const { t } = useI18n();
  const viewport = useRef<HTMLDivElement>(null);
  const go = (dir: -1 | 1) => {
    const el = viewport.current;
    if (!el) return;
    const card = el.querySelector<HTMLElement>("[data-live-card]");
    el.scrollBy({ left: dir * ((card?.offsetWidth ?? 280) + 12), behavior: "smooth" });
  };
  return (
    <div className="live-carousel -mx-4">
      <div ref={viewport} className="live-viewport">
        <div className="live-track">
          {games.map((g) => <LiveGameCard key={g.id} game={g} />)}
        </div>
      </div>
      {games.length > 1 && (
        <>
          <button type="button" className="jersey-arrow jersey-arrow--prev" aria-label={t("home.livePrev")} onClick={() => go(-1)}>
            <span className="jersey-arrow-dot"><ChevronLeft size={16} /></span>
          </button>
          <button type="button" className="jersey-arrow jersey-arrow--next" aria-label={t("home.liveNext")} onClick={() => go(1)}>
            <span className="jersey-arrow-dot"><ChevronRight size={16} /></span>
          </button>
        </>
      )}
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

/** Le bleu pâle de l'app (accent), le même que les onglets et les liens. */
const ML_BAR_BLUE = "#86d1ea";

/**
 * Le vainqueur prédit, en un trait. Une ligne fine, sans chiffre : seule la
 * part de la FAVORITE est peinte en bleu pâle, et elle part de son côté —
 * à gauche pour le visiteur (l'équipe du haut), à droite pour le domicile.
 * Décisions du user (2026-09-29) : pas les couleurs des clubs, pas de % aux
 * bouts — les chiffres sont déjà dans le tableau.
 *
 * Deux formes :
 *   - trait fin (défaut), glissé sous l'heure dans le calendrier ;
 *   - `band` (2026-09-30) : bandeau pleine largeur en haut de la carte d'un
 *     match de l'accueil, posé DERRIÈRE la rangée d'en-tête du tableau
 *     (« Handicap · Vainqueur ») — la carte ne grandit pas. Sans arrondi : la
 *     carte, en `overflow-hidden`, lui donne ses coins. Son fond non rempli
 *     est un gris clair et non sombre, pour que les libellés foncés posés
 *     dessus se lisent aussi bien sur le gris que sur le bleu.
 *
 * `awayPct` est une probabilité du modèle ML (0–100). Sans elle (modèle
 * indisponible), rien — jamais de 50/50 de repli.
 */
export function MoneylineBar({ awayPct, loading, awayAbbr, homeAbbr, band = false, className = "" }: {
  awayPct: number | null;
  loading: boolean;
  awayAbbr: string;
  homeAbbr: string;
  band?: boolean;
  className?: string;
}) {
  // Sans probabilité : rien — jamais de 50/50 de repli. Le bandeau garde
  // pourtant son fond, sur lequel sont écrits les libellés de l'en-tête.
  if (!loading && awayPct == null) return band ? <div className="absolute inset-x-0 top-0 h-5 bg-white/40" aria-hidden /> : null;
  const away = awayPct ?? 50;
  const awayFav = away > 50;
  const fav = awayFav ? away : 100 - away;
  return (
    <div
      className={`${band ? "absolute inset-x-0 top-0 h-5 bg-white/40" : "relative h-[3px] rounded-full bg-white/10"} overflow-hidden${loading ? " animate-pulse" : ""} ${className}`}
      role={loading ? undefined : "img"}
      aria-label={loading ? undefined : `ML : ${awayAbbr} ${away}% – ${homeAbbr} ${100 - away}%`}
      title={loading ? undefined : `${awayAbbr} ${away}% · ${homeAbbr} ${100 - away}%`}
    >
      {!loading && (
        <div
          className={`absolute inset-y-0 transition-[width] duration-500${band ? "" : " rounded-full"}`}
          style={{ width: `${fav}%`, background: ML_BAR_BLUE, [awayFav ? "left" : "right"]: 0 }}
        />
      )}
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

/**
 * Une case sélectionnable, en bascule : toucher une case libre l'ajoute au
 * coupon (entourée de vert), toucher une case prise la retire (le vert
 * disparaît). Demande du user du 2026-09-29 ; remplace le double toucher du
 * 2026-09-28, qui obligeait à deux touchers rapprochés pour retirer.
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
  const matches = legs.filter((l) => legMatchesPick(l, game.id, pick));
  const selected = matches.length > 0;

  const tap = () => {
    // Case prise → on la libère, où que la jambe ait été posée.
    if (selected) { matches.forEach((l) => removeLeg(l.id)); return; }
    // Match commencé : on le dit au lieu d'ignorer le toucher en silence
    // (demande du user, 2026-09-30).
    if (gameStarted(game)) { toast.info(t("slip.liveBlocked")); return; }
    if (probability == null) return;
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

export function UpcomingGameRow({ game, onOpenSheet, showOdds = true }: {
  game: DisplayGame; onOpenSheet: () => void;
  /** `false` : pas de cote (match à plus de 2 jours, décision du user 2026-10-02). */
  showOdds?: boolean;
}) {
  const { theme } = useSport();
  const accent = theme.accent;
  const { t, lang } = useI18n();
  const navigate = useNavigate();
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
          {/* Petit « H » : l'équipe à domicile (2026-09-29). */}
          {isHome && <span className="text-[#8a9ea6] text-[10px] font-bold leading-none flex-shrink-0" title={t("home.homeTeam")}>H</span>}
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
          {showOdds && (plPrice != null
            ? <BookPricePill price={plPrice} link={false} />
            : <FairOddsPill pct={pl} title={t("home.oddsFairHint")} reserve />)}
        </PickCell>
        {/* Vainqueur */}
        <PickCell
          game={game} pick={winPick} probability={win} team={side}
          label={t("bb.teamWin", { abbr: side.abbr })}
          short={`${side.abbr} ML`}
        >
          <MlPct value={win} loading={mlLoading} />
          {showOdds && (winPrice != null
            ? <BookPricePill price={winPrice} link={false} />
            : <FairOddsPill pct={win} title={t("home.oddsFairHint")} reserve />)}
        </PickCell>
      </>
    );
  };

  return (
    <div
      onClick={() => navigate(`/stats/prediction/game/${game.id}`)}
      className="relative icy-card rounded-2xl overflow-hidden cursor-pointer active:scale-[0.99] transition-transform"
    >
      {/* Le vainqueur prédit : bandeau pleine largeur derrière la rangée
          d'en-tête du tableau (demande du user, 2026-09-30), visiteur à
          gauche, domicile à droite — le même ordre que le tableau. */}
      <MoneylineBar band awayPct={winAway} loading={mlLoading} awayAbbr={game.team2.abbr} homeAbbr={game.team1.abbr} />
      <div className="relative flex items-stretch gap-3 px-3.5 pb-3.5">

        {/* Colonne date + heure.
            La date manquait : la section de l'accueil peut porter les matchs
            de demain ou d'après-demain, et « 19:00 » seul ne dit pas lequel. */}
        <div className="flex flex-col items-center justify-center min-w-[44px] flex-shrink-0 pt-6">
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
          {/* Rangée d'en-tête = la hauteur du bandeau (h-5, abaissé le 2026-10-01), libellés foncés
              pour se lire sur le bleu pâle comme sur le gris. */}
          <span className="h-5" />
          <span className="h-5 flex items-center text-[#0b1f2a] text-[10px] font-bold">{t("home.colSpread")}</span>
          <span className="h-5 flex items-center text-[#0b1f2a] text-[10px] font-bold">{t("home.colWinner")}</span>
          {/* Visiteur TOUJOURS en haut, domicile en bas avec son « H »
              (demande du user, 2026-09-29) — l'ordre de toute l'app. */}
          {teamRow(game.team2, game.team1, false, lineAway, plAway, priceAway, winAway, game.bookAway)}
          {teamRow(game.team1, game.team2, true, lineHome, plHome, priceHome, winHome, game.bookHome)}
        </div>
        </div>

        {/* Actions column.
            « Plus de paris » MASQUÉ sous 768 px (décision du user, 2026-09-28) :
            sur un téléphone, ses 60 px écrasaient la colonne des équipes et
            les abréviations (MTL, TOR) tombaient à 0 px de large. Toucher la
            carte ouvre la page du match, qui porte tous les marchés. */}
        <div className="hidden md:flex flex-col items-end justify-center gap-1.5 flex-shrink-0 max-w-[60px] pt-6">
          <button
            onClick={(e) => { e.stopPropagation(); onOpenSheet(); }}
            className="hidden md:block text-[11px] text-[#bfc8cc] underline underline-offset-2 text-right leading-tight"
          >
            {t("home.moreBets")}
          </button>
        </div>
      </div>

    </div>
  );
}
