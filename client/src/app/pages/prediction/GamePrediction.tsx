/**
 * GamePrediction.tsx
 *
 * Extrait de PredictionPage.tsx le 2026-08-10.
 * Découpage mécanique : le corps du code est identique à l'original,
 * seuls les imports et les mots-clés `export` ont été ajoutés.
 */

import { useNavigate } from "react-router";
import { useEffect, useMemo, useState } from "react";
import { nhlApiService } from "../../services/nhlApiService";
import { predictionApiService, isPredictionUnavailable } from "../../services/predictionApiService";
import { useSport } from "../../context/SportContext";
import { useI18n } from "../../i18n";
import { nhlLogoUrl } from "../../data/teamEmoji";
import { MarketGroup, PredictionsRevealBar } from "./PredictionSheet";
import { PlayerPropGrid } from "./PlayerPropGrid";
import { TopBetsSection } from "./topBets";
import { BetTabs } from "./betTabs";
import { LiveGameView, MLProps, MktGroup } from "./gameMarkets";
import { fetchGameMlBundle, type GameMlBundle } from "../../components/MLPredictionCard";
import { BetOddsCtx, GameLiveCtx, HeadToHead, NotFound, RevealMode, RevealModeCtx, ServerGroupsPending, StatsBanner, useGameOdds, useServerGroups } from "./predictionShared";

/**
 * Rythme des rappels pendant un match : celui de la feuille de match côté
 * serveur. En fin de match, le paquet ML annonce un rythme plus rapide (10 s,
 * `live.refreshMs`) : un chiffre en retard y coûte cher (`ml/EXPLICATION_ML.md` §10.2).
 */
const LIVE_POLL_MS = 30_000;
/** Paquet ML en direct non rafraîchi depuis ce délai : ses chiffres s'affichent pâles. */
const ML_STALE_MS = 90_000;


export function GamePrediction({ gameId }: { gameId: string }) {
  const { theme } = useSport();
  const { t } = useI18n();
  const navigate = useNavigate();
  const accent = theme.accent;
  // Carries the game along, so the team page opens on THIS match rather than
  // defaulting to the club's next one.
  const openTeam = (abbr: string) => navigate(`/stats/prediction/team/${abbr.toLowerCase()}?game=${gameId}`);
  const [gameView, setGameView] = useState<LiveGameView | null>(null);
  // Rythme annoncé par le serveur pour CE match (`refreshMs` de l'en-tête :
  // 30 s, 10 s en fin de match — `server/src/services/nhl/liveRefresh.ts`).
  const [headerRefreshMs, setHeaderRefreshMs] = useState<number | undefined>(undefined);
  // Match EN COURS selon le statut reçu. (`!!gameView.period` servait avant de
  // test, mais `period` est aussi renseignée pour un match terminé.)
  const isLive = gameView?.status === "live";
  // Marchés du moteur de règles, calculés par le serveur — les SEULS pourcentages
  // « règles » de la page. `null` = pas encore là (ou échec, voir `apiFailed`).
  // Pendant un match, redemandés toutes les 30 s : ils partent du score actuel
  // et du temps restant (voir `computeGameMarkets`, serveur).
  // En direct, une réponse de repli du serveur (vieux score) est refusée, et
  // passé 90 s sans rafraîchissement (`staleSince`) les chiffres affichés
  // perdent leur drapeau `live` : ils restent à l'écran, mais pâles.
  const { groups: apiGroups, failed: apiFailed, retry: retryApi, staleSince } =
    useServerGroups(() => nhlApiService.getGamePredictions(gameId, isLive), gameId,
                    isLive ? (headerRefreshMs ?? LIVE_POLL_MS) : undefined);
  const [loading, setLoading] = useState(true);
  // 2026-10-01 : ML partout ; les règles ne se voient que dans la fiche d'un pari.
  const revealMode: RevealMode = "ml";

  // Prédictions ML de TOUTES les tuiles du match, en une requête — chargées à
  // la première bascule en mode ML seulement. `undefined` = pas encore là,
  // `null` = indisponible. Voir `fetchGameMlBundle`.
  //
  // Pendant un match, le serveur les recalcule à partir du score et du temps
  // restant (`gameMlBundle.ts`) : on les redemande au rythme des règles. Un
  // échec garde les derniers chiffres ; au-delà de 90 s sans succès, ils ne
  // sont plus « en direct » (`mlStale`) et s'affichent pâles.
  const [mlBundle, setMlBundle] = useState<GameMlBundle | null | undefined>(undefined);
  const [mlStale, setMlStale] = useState(false);
  // Le plus rapide des deux rythmes annoncés (paquet ML, en-tête du match).
  const pollMs = Math.min(
    mlBundle?.live && !mlBundle.live.final && mlBundle.live.refreshMs ? mlBundle.live.refreshMs : LIVE_POLL_MS,
    headerRefreshMs ?? LIVE_POLL_MS,
  );
  useEffect(() => {
    if (revealMode !== "ml") return;
    let alive = true;
    let lastOk = Date.now();
    const load = () => fetchGameMlBundle(gameId).then(b => {
      if (!alive) return;
      if (b) { lastOk = Date.now(); setMlBundle(b); setMlStale(false); }
      else if (!isLive) setMlBundle(null);
      else if (Date.now() - lastOk >= ML_STALE_MS) setMlStale(true);
    });
    load();
    const timer = isLive ? setInterval(load, pollMs) : undefined;
    return () => { alive = false; if (timer) clearInterval(timer); };
  }, [revealMode, gameId, isLive, pollMs]);

  // En-tête (score, période, horloge) rafraîchi au même rythme que les marchés
  // tant que le match est en cours. Au coup de sifflet final, plus aucun rappel
  // (voir juste après pour le dernier état).
  useEffect(() => {
    if (!isLive) return;
    let alive = true;
    const timer = setInterval(async () => {
      try {
        const g = await nhlApiService.getGame(gameId);
        if (!alive) return;
        setHeaderRefreshMs(g.status === "live" ? g.refreshMs : undefined);
        setGameView(v => v && {
          ...v,
          status: g.status,
          period: g.period ? g.period + "P • " + g.clock : undefined,
          home: { ...v.home, score: g.homeTeam.score },
          away: { ...v.away, score: g.awayTeam.score },
        });
      } catch { /* en-tête inchangé ; nouvel essai au prochain tick */ }
    }, pollMs);
    return () => { alive = false; clearInterval(timer); };
  }, [isLive, gameId, pollMs]);

  // Match TERMINÉ : la page prédiction n'a plus d'objet — tous les paris sont
  // décidés. On la remplace par la page Statistiques du match (score final,
  // feuille de match, stats d'équipe et de joueurs). `replace` : la flèche
  // retour de la page Statistiques ramène là d'où l'on venait, pas ici (qui
  // redirigerait aussitôt). Vaut pour un match déjà fini à l'ouverture comme
  // pour un match qui se termine sous nos yeux — le rappel de l'en-tête
  // ci-dessus fait passer `status` à "final".
  const isFinal = gameView?.status === "final";
  useEffect(() => {
    if (isFinal) navigate(`/stats/chart/game/${gameId}`, { replace: true });
  }, [isFinal, gameId, navigate]);

  useEffect(() => {
    async function load() {
      setLoading(true);
      // Branche « données statiques » supprimée le 2026-08-29 : `hockeyData`
      // n'expose plus que des tableaux vides depuis le passage au backend, donc
      // `getGameById` rendait toujours `undefined`. Le code était mort et
      // portait deux erreurs de type que rien ne pouvait déclencher.
      try {
        // La probabilité du modèle peut manquer ; dans ce cas elle vaut `null`
        // et la page masque les marchés qui en dérivent. Aucun nombre de repli.
        const [nhlGame, homePct] = await Promise.all([
          nhlApiService.getGame(gameId),
          predictionApiService
            .getSinglePrediction({ marketType: "moneyline", gameId, teamId: "" })
            .then(r => r.probability as number | null)
            .catch((e: unknown) => {
              if (!isPredictionUnavailable(e)) throw e;
              console.warn("[GamePrediction] prédiction indisponible :", e.reason);
              return null;
            }),
        ]);
        setHeaderRefreshMs(nhlGame.status === "live" ? nhlGame.refreshMs : undefined);
        setGameView({
          id: gameId,
          home: {
            abbr: nhlGame.homeTeam.abbreviation, name: nhlGame.homeTeam.name,
            logo: nhlLogoUrl(nhlGame.homeTeam.abbreviation),
            score: nhlGame.homeTeam.score, winPct: homePct,
          },
          away: {
            abbr: nhlGame.awayTeam.abbreviation, name: nhlGame.awayTeam.name,
            logo: nhlLogoUrl(nhlGame.awayTeam.abbreviation),
            score: nhlGame.awayTeam.score, winPct: homePct == null ? null : 100 - homePct,
          },
          period: nhlGame.period ? nhlGame.period + "P • " + nhlGame.clock : undefined,
          time: nhlGame.startTime,
          overUnder: 5.5,
          status: nhlGame.status,
        });
      } catch (e) {
        console.error("GamePrediction fetch error", e);
      }
      setLoading(false);
    }
    load();
  }, [gameId]);

  // ⚠️ Mémoïsé : `groups` porte les `mlProps` de chaque tuile. Recalculé à
  // chaque rendu, il donnait à chaque tuile un nouvel objet, et tout re-rendu de
  // la page relançait les prédictions de toutes les tuiles (audit du
  // 2026-09-16). Placé AVANT les retours anticipés : c'est un hook.
  const groups: MktGroup[] = useMemo(() => {
    if (!gameView) return [];
    // ── Marché ML de chaque tuile : celui que le SERVEUR annonce ─────────────
    //
    // Le serveur annonce le marché de chaque tuile (`option.ml`) — avant-match
    // et en direct, imposé par `nhlPredictions.test.ts`. L'ancien repli par
    // identifiant sur un constructeur local (`buildGameGroups`, dont les
    // `rulePct` étaient des constantes) a été retiré le 2026-10-05 : il
    // n'apportait plus aucune tuile.
    const mergedGroups = apiGroups
      ? apiGroups.map(g => ({
          ...g,
          options: g.options.map(o => ({ ...o, mlProps: (o as { ml?: MLProps }).ml })),
        }))
      : [];
    // Stamp the game id onto every option's mlProps — without it, a bet placed
    // from this page can never be looked up for automatic settlement.
    //
    // Chiffre ML : celui du PAQUET du match, jamais un appel par tuile
    // (`mlExternal`). Tuile absente du paquet — repli client avant la réponse
    // du serveur, ou marché que le modèle ne price pas — → « — ».
    //
    // Chiffres plus rafraîchis depuis 90 s (règles : `staleSince`, ML :
    // `mlStale`) : ils perdent leur drapeau `live` et s'affichent pâles.
    const mlPresetFor = (id: string) => {
      if (mlBundle === undefined) return undefined;
      if (mlBundle === null) return null;
      const r = mlBundle.byId[id] ?? null;
      return r && mlStale && r.live ? { ...r, live: false } : r;
    };
    const stamped = mergedGroups.map(g => ({
      ...g,
      options: g.options.map(o => ({
        ...o,
        ...(o.mlProps ? { mlProps: { ...o.mlProps, gameId } } : {}),
        ...(staleSince != null ? { live: false } : {}),
        mlExternal: true,
        mlPreset: mlPresetFor(o.id),
      })),
    }));
    // Moneyline (ajouté le 2026-09-27) : les deux équipes totalisent 100 %,
    // en règles comme en ML. Le serveur recale déjà les règles ; le chiffre ML
    // du visiteur est le complément de celui du domicile — deux arrondis
    // indépendants pourraient sinon afficher 49 % + 52 %.
    return stamped.map(g => {
      if (g.id !== "moneyline") return g;
      const h = g.options.find(o => o.id === "mw-home");
      if (!h) return g;
      return {
        ...g,
        options: g.options.map(o => o.id !== "mw-away" ? o : {
          ...o,
          rulePct: 100 - h.rulePct,
          mlPreset: h.mlPreset && o.mlPreset
            ? { ...o.mlPreset, probability: 100 - h.mlPreset.probability }
            : o.mlPreset,
        }),
      };
    });
  }, [gameView, apiGroups, gameId, mlBundle, mlStale, staleSince]);

  // Cotes du livre réglé, chargées une fois pour toute la page et distribuées
  // par contexte : le flux est servi PAR MATCH, donc une requête par tuile
  // serait cinquante appels pour une seule réponse.
  //
  // ⚠️ Avant les retours anticipés : c'est un hook.
  const odds = useGameOdds(
    gameView ? { abbr: gameView.home.abbr, name: gameView.home.name } : undefined,
    gameView ? { abbr: gameView.away.abbr, name: gameView.away.name } : undefined,
  );

  // Match terminé : squelette le temps de la redirection (voir plus haut), au
  // lieu d'afficher une image des marchés pendant une fraction de seconde.
  if (loading || isFinal) return (
    <div className="flex flex-col gap-3">
      {[1,2,3,4].map(i => <div key={i} className="h-16 bg-[#131A12] rounded-2xl animate-pulse" />)}
    </div>
  );
  if (!gameView) return <NotFound />;

  const { home, away } = gameView;
  const finalPct = home.winPct == null ? null : Math.min(85, Math.max(15, home.winPct));

  return (
    <div className="flex flex-col gap-3">
      {/* Partie en cours : ce que veulent dire le blanc et le pâle. */}
      {isLive && (
        <div className="rounded-2xl border border-white/20 bg-white/[0.04] px-3 py-2 flex items-start gap-2">
          <span className="mt-1 w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse flex-shrink-0" />
          <p className="text-[#c0cdd4] text-[11px] leading-relaxed">{t("pred.liveNote")}</p>
        </div>
      )}
      {finalPct == null && (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          <p className="text-amber-300 text-[11px] font-semibold">{t("pred.unavailable")}</p>
          <p className="text-amber-200/70 text-[11px] mt-0.5">{t("pred.unavailableHint")}</p>
        </div>
      )}
      {/* ── Match header ── */}
      <div className="bg-[#131A12] border border-white/20 rounded-2xl p-4">
        {isLive && (
          <div className="flex items-center justify-center gap-1.5 mb-3">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            <span className="text-red-400 text-[11px] font-semibold uppercase tracking-widest">{gameView.period}</span>
          </div>
        )}
        <div className="flex items-center justify-between">
          <button
            onClick={() => openTeam(home.abbr)}
            className="flex flex-col items-center gap-1.5 flex-1 active:scale-95 transition-transform"
            title={home.name}
          >
            <img src={home.logo} alt={home.name} className="w-12 h-12 object-contain" />
            <span className="text-white text-sm font-bold underline decoration-white/20 underline-offset-4">{home.name}</span>
            {home.score !== undefined && <span className="text-white text-3xl font-black">{home.score}</span>}
          </button>
          <div className="flex flex-col items-center gap-1 px-2">
            {!isLive && <span className="text-[#8a9ea6] text-xs">
              {gameView.status === "final" ? t("chart.gm.final") : gameView.time ?? t("pred.today")}
            </span>}
            <span className="text-[#8a9ea6] font-bold text-base">VS</span>
            <span className="text-[#4a6070] text-[11px]">O/U {gameView.overUnder}</span>
          </div>
          <button
            onClick={() => openTeam(away.abbr)}
            className="flex flex-col items-center gap-1.5 flex-1 active:scale-95 transition-transform"
            title={away.name}
          >
            <img src={away.logo} alt={away.name} className="w-12 h-12 object-contain" />
            <span className="text-white text-sm font-bold underline decoration-white/20 underline-offset-4">{away.name}</span>
            {away.score !== undefined && <span className="text-white text-3xl font-black">{away.score}</span>}
          </button>
        </div>
      </div>

      {/* Head-to-head — the teams' recent meetings, shown above the markets */}
      <HeadToHead
        home={{ abbr: home.abbr, logo: home.logo }}
        away={{ abbr: away.abbr, logo: away.logo }}
      />

      {/* ── Market groups ── */}
      <StatsBanner type="game" id={gameId} />
      <PredictionsRevealBar />
      <GameLiveCtx.Provider value={isLive}>
      <BetOddsCtx.Provider value={odds}>
        <RevealModeCtx.Provider value={revealMode}>
          {/* Les paris de la page à 90 % ML ou plus (2026-10-13). */}
          <TopBetsSection accent={accent} />
          {/* Paris en deux onglets (2026-10-14) : joueurs d'abord, puis
              équipes / match. Le Top 90% + reste au-dessus : il couvre les deux. */}
          <BetTabs
            scope="game"
            accent={accent}
            players={<>
              {/* ── Paris joueur, en grille ────────────────────────────────────
                  Ils remplacent le tableau de statistiques qui fermait la page.
                  Celui-ci ne montrait que des nombres à lire : pour miser sur les
                  buts d'un joueur il fallait toucher sa ligne, ouvrir sa page,
                  y retrouver le bon groupe — et la comparaison entre joueurs, qui
                  est la raison de regarder un effectif, se perdait en chemin.
                  Ici chaque case est le pari. */}
              <PlayerPropGrid
                metric="goals"
                sides={[{ key: "home", abbr: home.abbr, name: home.name }, { key: "away", abbr: away.abbr, name: away.name }]}
                gameId={gameId}
                accent={accent}
              />
              {/* Passes — de retour sur la page d'un match, colonnes 1+ → 4+. */}
              <PlayerPropGrid
                metric="assists"
                sides={[{ key: "home", abbr: home.abbr, name: home.name }, { key: "away", abbr: away.abbr, name: away.name }]}
                gameId={gameId}
                accent={accent}
              />
              <PlayerPropGrid
                metric="points"
                sides={[{ key: "home", abbr: home.abbr, name: home.name }, { key: "away", abbr: away.abbr, name: away.name }]}
                gameId={gameId}
                accent={accent}
              />
              <PlayerPropGrid
                metric="shots"
                sides={[{ key: "home", abbr: home.abbr, name: home.name }, { key: "away", abbr: away.abbr, name: away.name }]}
                gameId={gameId}
                accent={accent}
              />
              <PlayerPropGrid
                metric="blocks"
                sides={[{ key: "home", abbr: home.abbr, name: home.name }, { key: "away", abbr: away.abbr, name: away.name }]}
                gameId={gameId}
                accent={accent}
              />
              <PlayerPropGrid
                metric="hits"
                sides={[{ key: "home", abbr: home.abbr, name: home.name }, { key: "away", abbr: away.abbr, name: away.name }]}
                gameId={gameId}
                accent={accent}
              />
              {/* Arrêts — SEULEMENT le gardien qui joue ce match (feuille de
                  match, sinon partant saisi, sinon le plus utilisé), avec trois
                  colonnes calées sur sa moyenne. */}
              <PlayerPropGrid
                metric="saves"
                sides={[{ key: "home", abbr: home.abbr, name: home.name }, { key: "away", abbr: away.abbr, name: away.name }]}
                gameId={gameId}
                accent={accent}
              />
            </>}
            markets={<>
              {apiGroups == null
                ? <ServerGroupsPending failed={apiFailed} onRetry={retryApi} />
                : groups.map(g => <MarketGroup key={g.id} group={g} accent={accent} />)}
            </>}
          />
        </RevealModeCtx.Provider>
      </BetOddsCtx.Provider>
      </GameLiveCtx.Provider>

      {/* Les lignes de saison complètes vivent sur la page Statistiques, qui
          est faite pour ça — pas un tableau de plus en bas des paris. */}
      <button
        onClick={() => navigate(`/stats/chart/game/${gameId}`)}
        className="w-full py-3 rounded-2xl text-xs font-semibold border transition-transform active:scale-[0.98]"
        style={{ background: accent + "14", color: accent, borderColor: accent + "44" }}
      >
        {t("pred.viewRoster")}
      </button>
    </div>
  );
}
