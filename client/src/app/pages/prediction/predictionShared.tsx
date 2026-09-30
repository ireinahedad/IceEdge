/**
 * predictionShared.tsx
 *
 * Extrait de PredictionPage.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { useNavigate, useSearchParams } from "react-router";
import { useCallback, useEffect, useMemo, useRef, useState, createContext } from "react";
import { nhlApiService } from "../../services/nhlApiService";
import { nhlLogoUrl } from "../../data/teamEmoji";
import { useI18n } from "../../i18n";
import { FramedLabel } from "../../components/brand/FramedLabel";
import { useBookmaker } from "../../context/BookmakerContext";
import { loadGameOdds, type OddsTable } from "../../services/gameOdds";
import type { NHLGame } from "../../types/bet";
import type { MktGroup } from "./gameMarkets";
import { ErrorState } from "../../components/ErrorState";

/**
 * Prediction source shown by every BetOption on the page. Predictions are
 * always visible; a segmented toggle at the top switches which number is shown:
 *   "rules" → the rule-based % (default).
 *   "ml"    → the ML model's %.
 */
export type RevealMode = "rules" | "ml";
export const RevealModeCtx = createContext<RevealMode>("rules");

/**
 * `true` pendant un match EN COURS. Les chiffres des règles partent alors du
 * score et du temps restant ; le ML, lui, reste un modèle d'avant-match — la
 * fiche d'un pari masque donc sa section ML plutôt que de montrer un chiffre
 * qui ignore le score.
 */
export const GameLiveCtx = createContext<boolean>(false);

/* ─── Cotes du livre, partagées par toutes les tuiles d'une page ─────────────
 *
 * Une page de prédiction rend jusqu'à une cinquantaine de tuiles. Chacune
 * interrogeant le flux pour son compte, c'est cinquante requêtes pour UNE
 * réponse — le flux est servi par match, pas par marché. La page charge donc
 * la table une fois et la passe par contexte, exactement comme `RevealModeCtx`
 * passe la source du pourcentage.
 *
 * Valeur par défaut = pas de cotes. Les écrans qui ne fournissent pas ce
 * contexte (page joueur : le fournisseur ne cote aucun pari joueur) affichent
 * leurs tuiles telles qu'aujourd'hui, sans rien de cassé.
 */
export interface BetOddsValue {
  /** `null` = pas encore chargé ou indisponible ; une table (même vide) sinon. */
  table: OddsTable | null;
  /** Le livre qui a fourni ces prix — affiché pour que l'utilisateur sache où parier. */
  bookTitle: string | null;
  /** Abréviation → nom complet : le flux nomme ses issues « Edmonton Oilers ». */
  nameByAbbr: Record<string, string>;
}
export const BetOddsCtx = createContext<BetOddsValue>({ table: null, bookTitle: null, nameByAbbr: {} });

/**
 * Charge les cotes d'un match chez le livre réglé par l'utilisateur.
 *
 * Rend la valeur neutre tant que les noms d'équipe manquent (la page charge
 * encore) : la table est alors `null`, et les tuiles n'affichent aucun prix
 * plutôt qu'un prix faux.
 */
export function useGameOdds(
  home: { abbr: string; name: string } | undefined,
  away: { abbr: string; name: string } | undefined,
): BetOddsValue {
  const { bookmakerId } = useBookmaker();
  const [state, setState] = useState<{ table: OddsTable | null; bookTitle: string | null }>(
    { table: null, bookTitle: null },
  );

  const homeName = home?.name ?? "";
  const awayName = away?.name ?? "";
  const homeAbbr = home?.abbr ?? "";
  const awayAbbr = away?.abbr ?? "";

  useEffect(() => {
    if (!homeName || !awayName) { setState({ table: null, bookTitle: null }); return; }
    let alive = true;
    loadGameOdds(homeName, awayName, bookmakerId,
      homeAbbr && awayAbbr ? { home: homeAbbr, away: awayAbbr } : undefined)
      .then((r) => { if (alive) setState({ table: r.table, bookTitle: r.bookTitle }); })
      // Un flux de cotes en panne ne doit pas retirer les prédictions de
      // l'écran : on retombe sur « pas de prix », l'état normal de la plupart
      // des marchés de toute façon.
      .catch(() => { if (alive) setState({ table: null, bookTitle: null }); });
    return () => { alive = false; };
  }, [homeName, awayName, homeAbbr, awayAbbr, bookmakerId]);

  const nameByAbbr = useMemo(() => {
    const m: Record<string, string> = {};
    if (home?.abbr) m[home.abbr.toUpperCase()] = home.name;
    if (away?.abbr) m[away.abbr.toUpperCase()] = away.name;
    return m;
  }, [home?.abbr, home?.name, away?.abbr, away?.name]);

  return { table: state.table, bookTitle: state.bookTitle, nameByAbbr };
}

/** Head-to-head — the two teams' most recent meetings this season, with scores. */
interface H2HMeeting { date: string; homeAbbr: string; awayAbbr: string; homeScore: number; awayScore: number; }

export function HeadToHead({ home, away }: {
  home: { abbr: string; logo: string };
  away: { abbr: string; logo: string };
}) {
  const { t, lang } = useI18n();
  const locale = lang === "fr" ? "fr-CA" : "en-US";
  const [meetings, setMeetings] = useState<H2HMeeting[] | null>(null);

  useEffect(() => {
    let alive = true;
    setMeetings(null);
    (async () => {
      try {
        const isoRe = /^\d{4}-\d{2}-\d{2}$/;
        const anchor = await nhlApiService.getScheduleAnchor().catch(() => null);
        const end = anchor?.today && isoRe.test(anchor.today)
          ? anchor.today
          : new Date().toISOString().slice(0, 10);
        const start = anchor?.seasonStart && isoRe.test(anchor.seasonStart)
          ? anchor.seasonStart
          : `${Number(end.slice(0, 4)) - 1}-09-01`;

        const games = await nhlApiService.getGamesRange(start, end);
        const A = home.abbr.toUpperCase();
        const B = away.abbr.toUpperCase();
        const found = games
          .filter((g) => g.status === "final")
          .filter((g) => {
            const h = g.homeTeam.abbreviation.toUpperCase();
            const a = g.awayTeam.abbreviation.toUpperCase();
            return (h === A && a === B) || (h === B && a === A);
          })
          .map((g) => ({
            date: g.gameDate,
            homeAbbr: g.homeTeam.abbreviation.toUpperCase(),
            awayAbbr: g.awayTeam.abbreviation.toUpperCase(),
            homeScore: g.homeTeam.score ?? 0,
            awayScore: g.awayTeam.score ?? 0,
          }))
          .sort((x, y) => y.date.localeCompare(x.date))
          .slice(0, 5);
        if (alive) setMeetings(found);
      } catch {
        if (alive) setMeetings([]);
      }
    })();
    return () => { alive = false; };
  }, [home.abbr, away.abbr]);

  return (
    <div className="bg-[#131A12] border border-white/20 rounded-2xl p-4">
      <p className="text-white text-sm font-medium mb-3">{t("pred.h2hTitle")}</p>
      {meetings === null ? (
        <div className="flex flex-col gap-2">
          {[1, 2, 3].map((i) => <div key={i} className="h-9 bg-[#0A0E0C] rounded-lg animate-pulse" />)}
        </div>
      ) : meetings.length === 0 ? (
        <p className="text-[#8a9ea6] text-xs">{t("pred.h2hNone")}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {meetings.map((m, i) => {
            const homeWon = m.homeScore > m.awayScore;
            return (
              <div key={i} className="flex items-center gap-3 text-xs bg-[#0A0E0C] rounded-lg px-3 py-2">
                <span className="text-[#8a9ea6] w-14 flex-shrink-0 tabular-nums">
                  {new Date(`${m.date}T00:00:00`).toLocaleDateString(locale, { day: "numeric", month: "short" })}
                </span>
                <div className="flex-1 flex items-center justify-center gap-2">
                  <span className={`font-bold tabular-nums ${!homeWon ? "text-white" : "text-[#8a9ea6]"}`}>{m.awayAbbr}</span>
                  <span className="text-white font-black tabular-nums">{m.awayScore}</span>
                  <span className="text-[#4a6070]">–</span>
                  <span className="text-white font-black tabular-nums">{m.homeScore}</span>
                  <span className={`font-bold tabular-nums ${homeWon ? "text-white" : "text-[#8a9ea6]"}`}>{m.homeAbbr}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─── Game picker (player & team prediction pages) ──────────────────────────
 * A bet placed from a player or team page needs a gameId to be auto-settled,
 * and "which game?" is only obvious once it's on screen. Both pages therefore
 * open on the subject's NEXT game and let the user switch with a dropdown.
 * The choice lives in the `?game=` search param, so a link from a game page
 * (or a shared URL) opens on the right match instead of the default one.
 */

/** One selectable game, described from the point of view of one team. */
export interface UpcomingGame {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  /** Display string from the API, e.g. "7:00 PM ET". */
  startTime: string;
  homeAbbr: string;
  awayAbbr: string;
  /** The other team — i.e. the opponent of the team this list was built for. */
  opponentAbbr: string;
  isHome: boolean;
  status: NHLGame["status"];
}

/** How far ahead the dropdown looks. One range call covers every team. */
export const UPCOMING_DAYS = 14;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const shiftIso = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export function toUpcoming(g: NHLGame, teamAbbr: string): UpcomingGame {
  const homeAbbr = (g.homeTeam.abbreviation ?? "").toUpperCase();
  const awayAbbr = (g.awayTeam.abbreviation ?? "").toUpperCase();
  const isHome = homeAbbr === teamAbbr.toUpperCase();
  return {
    id: String(g.id),
    date: g.gameDate,
    startTime: g.startTime,
    homeAbbr,
    awayAbbr,
    opponentAbbr: isHome ? awayAbbr : homeAbbr,
    isHome,
    status: g.status,
  };
}

/**
 * Le jour LNH (`/schedule/anchor`) et les matchs non terminés des
 * {@link UPCOMING_DAYS} jours suivants — UN appel `/games/range` pour toutes
 * les équipes. Partagé par `useUpcomingGames` et le Bet builder IA.
 */
export async function fetchUpcomingWindow(): Promise<{ today: string; games: NHLGame[] }> {
  const anchor = await nhlApiService.getScheduleAnchor().catch(() => null);
  const today = anchor?.today && ISO_DATE.test(anchor.today)
    ? anchor.today
    : new Date().toISOString().slice(0, 10);
  const all = await nhlApiService.getGamesRange(today, shiftIso(today, UPCOMING_DAYS));
  return { today, games: all.filter(g => g.status !== "final") };
}

/**
 * A team's games over the next {@link UPCOMING_DAYS} days, soonest first.
 * `null` while loading, `[]` when the team has no game in that window.
 *
 * `pinnedId` (the `?game=` value) is fetched on its own and merged in when it
 * falls outside the window — without that, a link to a game further out would
 * silently switch the page over to a different match.
 */
export function useUpcomingGames(teamAbbr: string | undefined, pinnedId?: string): UpcomingGame[] | null {
  const [scheduled, setScheduled] = useState<UpcomingGame[] | null>(null);
  const [pinned, setPinned] = useState<UpcomingGame | null>(null);

  // Schedule window — refetched only when the team changes, never when the
  // user picks a different game in the dropdown.
  useEffect(() => {
    if (!teamAbbr) { setScheduled(null); return; }
    let alive = true;
    setScheduled(null);
    (async () => {
      const abbr = teamAbbr.toUpperCase();
      try {
        const { games } = await fetchUpcomingWindow();
        const list = games
          .filter(g => [g.homeTeam.abbreviation, g.awayTeam.abbreviation]
            .some(a => (a ?? "").toUpperCase() === abbr))
          .map(g => toUpcoming(g, abbr));
        if (alive) setScheduled(list);
      } catch {
        // Schedule unavailable — the page still works, just without a game.
        if (alive) setScheduled([]);
      }
    })();
    return () => { alive = false; };
  }, [teamAbbr]);

  // A `?game=` id outside the window (older, or further ahead) is fetched once.
  useEffect(() => {
    if (!teamAbbr || !pinnedId || !scheduled || scheduled.some(g => g.id === pinnedId)) {
      setPinned(null);
      return;
    }
    let alive = true;
    nhlApiService.getGame(pinnedId)
      .then(g => { if (alive) setPinned(toUpcoming(g, teamAbbr)); })
      .catch(() => { if (alive) setPinned(null); }); // unknown id → fall back to the next game
    return () => { alive = false; };
  }, [teamAbbr, pinnedId, scheduled]);

  return useMemo(() => {
    if (scheduled === null) return null;
    const all = pinned ? [...scheduled, pinned] : scheduled;
    // One game per team per day, so the date alone orders them.
    return [...all].sort((a, b) => a.date.localeCompare(b.date));
  }, [scheduled, pinned]);
}

/**
 * The game the page is bound to: `?game=` when it points at a listed game,
 * otherwise the next one. `select` rewrites the param in place (replace) —
 * switching games is not a new page.
 */
export function useSelectedGame(games: UpcomingGame[] | null) {
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get("game") ?? undefined;

  const selected = useMemo(() => {
    if (!games || games.length === 0) return null;
    return games.find(g => g.id === fromUrl) ?? games[0];
  }, [games, fromUrl]);

  const select = useCallback((id: string) => {
    const next = new URLSearchParams(params);
    next.set("game", id);
    setParams(next, { replace: true });
  }, [params, setParams]);

  return { selected, select };
}

/** Header card: which game these bets are for, with a dropdown to switch. */
export function GameSelector({ games, selected, onSelect, accent }: {
  games: UpcomingGame[] | null;
  selected: UpcomingGame | null;
  onSelect: (gameId: string) => void;
  accent: string;
}) {
  const navigate = useNavigate();
  const { t, lang } = useI18n();
  const locale = lang === "fr" ? "fr-CA" : "en-US";

  const optionLabel = (g: UpcomingGame) => {
    const day = ISO_DATE.test(g.date)
      ? new Date(`${g.date}T00:00:00`).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short" })
      : g.date;
    return `${g.isHome ? "vs" : "@"} ${g.opponentAbbr} · ${day}${g.startTime ? ` · ${g.startTime}` : ""}`;
  };

  if (games === null) {
    return <div className="h-16 bg-[#131A12] rounded-2xl animate-pulse" />;
  }

  return (
    <div className="bg-[#131A12] border border-white/20 rounded-2xl px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-[#8a9ea6] text-[11px] uppercase tracking-wider font-semibold">{t("pred.forGame")}</span>
        {selected && (
          <button
            onClick={() => navigate(`/stats/prediction/game/${selected.id}`)}
            className="ml-auto text-[11px] font-semibold px-2 py-0.5 rounded-md border transition-colors"
            style={{ color: accent, borderColor: accent + "55", background: accent + "14" }}
          >
            {t("pred.viewGame")}
          </button>
        )}
      </div>

      {games.length === 0 || !selected ? (
        <p className="text-[#8a9ea6] text-xs">{t("pred.noUpcoming")}</p>
      ) : (
        <div className="flex items-center gap-2">
          <img src={nhlLogoUrl(selected.opponentAbbr)} alt={selected.opponentAbbr} className="w-7 h-7 object-contain flex-shrink-0" />
          <select
            value={selected.id}
            onChange={e => onSelect(e.target.value)}
            aria-label={t("pred.chooseGame")}
            className="flex-1 min-w-0 rounded-xl border border-white/15 px-2.5 py-2 text-xs font-semibold text-white outline-none"
            style={{ background: "#0A0E0C" }}
          >
            {games.map(g => (
              <option key={g.id} value={g.id}>{optionLabel(g)}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

/* --- Loading skeleton --- */
export function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {[1,2,3,4].map(i => <div key={i} className="h-20 bg-[#131A12] rounded-2xl animate-pulse" />)}
    </div>
  );
}

/* ─── Entrée « Statistiques » ─────────────────────── */

/**
 * Le raccourci vers les graphiques du sujet, en bannière pleine largeur.
 *
 * Il vivait dans l'en-tête de `PredictionPage`, en pastille de 30 px collée à
 * droite du titre : la cible était petite, et surtout elle était HORS du regard
 * de quelqu'un qui fait défiler les paris. Il est posé ici, juste au-dessus de
 * la barre des marchés — donc au-dessus de TOUS les paris de la page, quel que
 * soit le sujet (match, équipe, joueur), les trois écrans rendant cette barre.
 *
 * Le libellé est `stats.statistics` et non `pred.chart` : la page Stats appelle
 * déjà cette même destination « Statistiques », et deux noms pour une seule
 * porte, c'est une porte de plus à chercher.
 *
 * La destination est inchangée : `/stats/chart/:type/:id`.
 */
export function StatsBanner({ type, id }: { type: "team" | "player" | "game"; id: string }) {
  const navigate = useNavigate();
  const { t } = useI18n();
  if (!id) return null;
  return (
    <FramedLabel
      className="framed-label--banner"
      text={t("stats.statistics")}
      onClick={() => navigate(`/stats/chart/${type}/${id}`)}
    />
  );
}

/* ─── Main PredictionPage ──────────────────────────── */

export function NotFound() {
  const navigate = useNavigate();
  const { t } = useI18n();
  return (
    <div className="flex flex-col items-center justify-center py-24 px-6 text-center">
      <p className="text-4xl mb-4">🏒</p>
      <p className="text-white font-bold text-lg mb-2">{t("pred.notFound")}</p>
      <p className="text-[#8a9ea6] text-sm mb-6">{t("pred.notExist")}</p>
      <button onClick={() => navigate(-1)} className="px-6 py-2 rounded-xl bg-[#86d1ea]/10 border border-[#86d1ea]/30 text-[#86d1ea] text-sm">{t("pred.goBack")}</button>
    </div>
  );
}

/* ─── Marchés du serveur — seule source des pourcentages « règles » ─────────
 *
 * Les pages match, équipe et joueur affichaient jusqu'au 2026-09-24 des tuiles
 * construites dans le navigateur, avec des pourcentages écrits en dur (54 % sur
 * l'over, 22 % de prolongation, 52 % sur les tirs…) tant que le serveur n'avait
 * pas répondu — et POUR TOUJOURS s'il ne répondait pas (`.catch(() => {})`).
 * Désormais : pas de réponse = squelette, échec = écran d'erreur avec
 * « Réessayer ». Jamais un chiffre local.
 *
 * `key` identifie ce qui est chargé (id du match, de l'équipe, du joueur) : le
 * changer relance la requête. `load` n'est pas une dépendance — il est recréé à
 * chaque rendu par l'appelant, et c'est `key` qui dit si la question a changé.
 */
export function useServerGroups(
  load: () => Promise<MktGroup[]>,
  key: string | undefined,
  /**
   * Rafraîchissement périodique (match en cours). Les rappels remplacent les
   * marchés SEULEMENT en cas de succès, sans repasser par le squelette ni par
   * l'erreur : la page ne clignote pas, et un échec passager garde les chiffres
   * affichés. `undefined` = pas de rappel (arrêt au coup de sifflet final).
   */
  pollMs?: number,
): { groups: MktGroup[] | null; failed: boolean; retry: () => void; refresh: () => void } {
  const [groups, setGroups] = useState<MktGroup[] | null>(null);
  // Dernier `load` reçu, pour `refresh` (l'appelant le recrée à chaque rendu).
  const loadRef = useRef(load);
  loadRef.current = load;
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!key) return;
    let alive = true;
    setGroups(null);
    setFailed(false);
    load()
      .then((g) => { if (alive) setGroups(Array.isArray(g) ? g : []); })
      .catch((e: unknown) => {
        console.warn("[prediction] marchés du serveur indisponibles :", e);
        if (alive) setFailed(true);
      });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);
  useEffect(() => {
    if (!key || !pollMs) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      load()
        .then((g) => { if (alive && Array.isArray(g)) { setGroups(g); setFailed(false); } })
        .catch(() => { /* on garde les derniers chiffres ; prochain essai au tick suivant */ })
        .finally(() => { if (alive) timer = setTimeout(tick, pollMs); });
    };
    timer = setTimeout(tick, pollMs);
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, pollMs]);
  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  /** Rechargement silencieux (ex. dernier état au coup de sifflet final). */
  const refresh = useCallback(() => {
    loadRef.current()
      .then((g) => { if (Array.isArray(g)) { setGroups(g); setFailed(false); } })
      .catch(() => { /* on garde les chiffres affichés */ });
  }, []);
  return { groups, failed, retry, refresh };
}

/** À la place des marchés tant qu'ils ne sont pas là : squelette, ou erreur + « Réessayer ». */
export function ServerGroupsPending({ failed, onRetry }: { failed: boolean; onRetry: () => void }) {
  const { t } = useI18n();
  if (failed) {
    return <ErrorState onRetry={onRetry} title={t("pred.rulesUnavailable")} hint={t("pred.unavailableHint")} compact />;
  }
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      {[1, 2, 3].map((i) => <div key={i} className="h-20 bg-[#131A12] rounded-2xl animate-pulse" />)}
    </div>
  );
}
