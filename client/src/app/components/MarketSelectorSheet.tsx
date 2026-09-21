import { useState, useMemo, useEffect } from "react";
import { MARKET_DEFINITIONS, CATEGORY_LABELS, CATEGORY_ICONS } from "../data/betMarkets";
import { predictionApiService, isPredictionUnavailable } from "../services/predictionApiService";
import { useBet } from "../context/BetContext";
import { useNHLData } from "../hooks/useNHLData";
// `useUpcomingGames` est le hook des pages prédiction : UN appel /games/range sur
// 14 jours, filtré sur l'équipe, matchs terminés exclus. Il remplace un filtre
// sur `useNHLData().games`, qui ne porte que la soirée du jour et aurait donc
// déclaré « aucun match » pour toute équipe qui ne joue pas ce soir.
import { useUpcomingGames, type UpcomingGame } from "../pages/prediction/predictionShared";
import { useI18n } from "../i18n";
import type { BetLeg, BetMarketType } from "../types/bet";
import type { MarketDefinition } from "../data/betMarkets";

type Category = MarketDefinition["category"];
const ALL_CATEGORIES: Category[] = ["match", "period", "team", "player", "special"];

interface Subject {
  id: string;
  type: "team" | "player" | "game";
  name: string;
  logo: string;
  subtitle: string;
}

interface Props {
  onClose: () => void;
  /** If provided, start directly on market selection for this subject */
  preselectedSubject?: Subject;
}

export function MarketSelectorSheet({ onClose, preselectedSubject }: Props) {
  const { t } = useI18n();
  const { addLeg, hasLeg } = useBet();
  const { teams, players, games, getTeamById, getGameById } = useNHLData();

  // Step 1: choose subject; Step 2: choose market; Step 3: configure (line/selection)
  const [step, setStep] = useState<"subject" | "market" | "configure">(
    preselectedSubject ? "market" : "subject"
  );
  const [selectedSubject, setSelectedSubject] = useState<Subject | null>(
    preselectedSubject || null
  );
  const [selectedMarket, setSelectedMarket] = useState<MarketDefinition | null>(null);
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [selectedSelection, setSelectedSelection] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<Category>("match");
  // Quel match ce pari d'équipe vise. Un sujet « équipe » n'en portait AUCUN :
  // la jambe partait avec `gameId: undefined`, donc le règlement automatique
  // (qui cherche le boxscore par gameId) ne pouvait jamais la clore, et la
  // probabilité était calculée sans adversaire.
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Message affiché quand le modèle ne rend pas de probabilité : on refuse
  // d'inscrire une jambe au coupon plutôt que d'en inventer une.
  const [addError, setAddError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);

  // ── Build searchable subject list ──────────────────────────────────────────
  const allSubjects: Subject[] = useMemo(() => [
    ...teams.map((t) => ({
      id: t.id,
      type: "team" as const,
      name: t.name,
      logo: t.logo,
      subtitle: `${t.record} · ${t.conf}ern`,
    })),
    ...players.map((p) => {
      const team = getTeamById(p.teamId);
      return {
        id: p.id,
        type: "player" as const,
        name: p.name,
        logo: team?.logo ?? "",
        subtitle: `${team?.abbr ?? ""} · #${p.number} · ${p.position}`,
      };
    }),
    ...games.map((g) => {
      const t1 = getTeamById(g.team1Id);
      const t2 = getTeamById(g.team2Id);
      return {
        id: g.id,
        type: "game" as const,
        name: t1 && t2 ? `${t1.abbr} vs ${t2.abbr}` : g.id,
        logo: "",
        subtitle: `${g.date} · ${g.time}`,
      };
    }),
  ], [teams, players, games, getTeamById]);

  // ── Matchs à venir du sujet quand c'est une équipe ────────────────────────
  // `null` = en cours de chargement (le hook n'est appelé que pour une équipe).
  const upcoming = useUpcomingGames(
    selectedSubject?.type === "team" ? selectedSubject.id : undefined
  );
  const gamesLoading = selectedSubject?.type === "team" && upcoming === null;
  const subjectGames = useMemo<UpcomingGame[]>(() => upcoming ?? [], [upcoming]);

  // Prochain match par défaut ; le choix survit au changement de marché, pas au
  // changement d'équipe.
  useEffect(() => {
    if (selectedSubject?.type !== "team") { setSelectedGameId(null); return; }
    setSelectedGameId((prev) =>
      prev && subjectGames.some((g) => g.id === prev) ? prev : subjectGames[0]?.id ?? null
    );
  }, [selectedSubject, subjectGames]);

  const selectedGame = useMemo(
    () => subjectGames.find((g) => g.id === selectedGameId) ?? null,
    [subjectGames, selectedGameId]
  );

  /** « vs BOS » / « @ BOS » — même formulation que le sélecteur des pages prédiction. */
  function matchupLabel(g: UpcomingGame): string {
    return `${g.isHome ? "vs" : "@"} ${g.opponentAbbr}`;
  }

  const filteredSubjects = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return allSubjects.filter(
      (s) => !q || s.name.toLowerCase().includes(q) || s.subtitle.toLowerCase().includes(q)
    );
  }, [allSubjects, searchQuery]);

  // ── Available markets for selected subject ─────────────────────────────────
  const availableMarkets = useMemo(() => {
    if (!selectedSubject) return MARKET_DEFINITIONS;
    if (selectedSubject.type === "game") return MARKET_DEFINITIONS;
    if (selectedSubject.type === "team")
      return MARKET_DEFINITIONS.filter(
        (m) => m.category === "team" || m.category === "match" || m.category === "period" || m.category === "special"
      );
    if (selectedSubject.type === "player")
      return MARKET_DEFINITIONS.filter((m) => m.category === "player");
    return MARKET_DEFINITIONS;
  }, [selectedSubject]);

  const marketsByCategory = useMemo(() => {
    return availableMarkets.filter((m) => m.category === activeCategory);
  }, [availableMarkets, activeCategory]);

  const categoriesForSubject: Category[] = useMemo(() => {
    if (!selectedSubject) return ALL_CATEGORIES;
    if (selectedSubject.type === "player") return ["player"];
    return ["match", "period", "team", "special"];
  }, [selectedSubject]);

  // ── Build selection options for a game subject ─────────────────────────────
  function getSelectionOptions(market: MarketDefinition): { label: string; value: string }[] {
    if (market.selectionOptions) return market.selectionOptions;
    if (!selectedSubject) return [];

    if (selectedSubject.type === "game") {
      const game = getGameById(selectedSubject.id);
      if (!game) return [];
      const t1 = getTeamById(game.team1Id);
      const t2 = getTeamById(game.team2Id);
      if (!t1 || !t2) return [];
      return [
        { label: `${t1.name} (${t1.abbr})`, value: t1.id },
        { label: `${t2.name} (${t2.abbr})`, value: t2.id },
        ...(market.type === "regulation_result"
          ? [{ label: t("mkt.draw60"), value: "draw" }]
          : []),
      ];
    }
    if (selectedSubject.type === "team") {
      return [
        { label: selectedSubject.name, value: selectedSubject.id },
      ];
    }
    return [];
  }

  // ── Resolve which game a player is playing in (needed for auto-settlement:
  //    player-prop legs have no natural "game" subject, so without this the
  //    leg is saved with no gameId and settlement can never look up the
  //    boxscore for it — it would stay pending forever). ──────────────────────
  function getPlayerGameId(playerId: string): string | undefined {
    const player = players.find((p) => p.id === playerId);
    if (!player) return undefined;
    const game = games.find((g) => g.team1Id === player.teamId || g.team2Id === player.teamId);
    return game?.id;
  }

  // ── Add leg to slip ────────────────────────────────────────────────────────
  async function handleAdd() {
    if (!selectedSubject || !selectedMarket) return;
    setAdding(true);

    const selectionValue = selectedSelection || "yes";
    const lineValue = selectedLine ?? selectedMarket.lineOptions?.[0];
    const playerGameId =
      selectedSubject.type === "player" ? getPlayerGameId(selectedSubject.id) : undefined;
    // Équipe : l'affiche choisie donne l'adversaire et le côté, envoyés
    // explicitement (le chemin « page stats » de resolveSubjects) en plus du
    // gameId. Deux raisons de ne pas s'en remettre au seul gameId : le serveur
    // n'y déduit l'équipe sujet que si la sélection EST une abréviation
    // d'équipe — un « over » y ancrerait le calcul sur le côté domicile du
    // match, pas sur l'équipe choisie — et sa lecture du match est dans un
    // try/catch qui retombe silencieusement sur le corps de la requête.
    const teamIsHome = selectedGame ? selectedGame.isHome : undefined;
    const teamOpponentId = selectedGame ? selectedGame.opponentAbbr.toLowerCase() : undefined;

    // Build a unique and deterministic ID
    // Le match fait partie de l'identité d'un pari d'équipe : sans lui, la même
    // équipe sur le même marché pour DEUX affiches donnait le même id, donc
    // `hasLeg` refermait la feuille sans rien ajouter à la deuxième.
    const legId = `${selectedSubject.id}_${selectedMarket.type}_${selectionValue}_${lineValue ?? ""}`
      + (selectedSubject.type === "team" && selectedGameId ? `_${selectedGameId}` : "");

    if (hasLeg(legId)) {
      setAdding(false);
      onClose();
      return;
    }

    // La probabilité vient du service de prédiction. Sans elle, on n'ajoute
    // rien : une jambe porte sa probabilité jusqu'au règlement du coupon, donc
    // un chiffre inventé ici survivrait bien après la panne qui l'a produit.
    let response;
    try {
      response = await predictionApiService.getSinglePrediction({
        marketType: selectedMarket.type as BetMarketType,
        gameId:
          selectedSubject.type === "game"
            ? selectedSubject.id
            : selectedSubject.type === "team"
            ? selectedGameId ?? undefined
            : undefined,
        teamId: selectedSubject.type === "team" ? selectedSubject.id : undefined,
        opponentId: teamOpponentId,
        isHome: teamIsHome,
        playerId: selectedSubject.type === "player" ? selectedSubject.id : undefined,
        line: lineValue,
        selection: selectionValue,
      });
    } catch (e) {
      if (!isPredictionUnavailable(e)) throw e;
      console.warn("[MarketSelectorSheet] prédiction indisponible :", e.reason);
      setAddError(t("pred.unavailableLeg"));
      setAdding(false);
      return;
    }

    const selectionLabel = buildSelectionLabel(
      selectedMarket,
      selectedSubject,
      selectionValue,
      lineValue
    );

    // Pari joueur : le coupon porte l'ÉQUIPE du joueur comme sujet, et ce qui
    // a été parié — nom du joueur compris — comme sélection (même règle que
    // PredictionSheet). « Over 2.5 Shots » seul ne dirait pas de qui il s'agit.
    const isPlayer = selectedSubject.type === "player";
    const playerTeamAbbr = isPlayer
      ? (getTeamById(players.find((p) => p.id === selectedSubject.id)?.teamId ?? "")?.abbr ?? "")
      : "";
    const withName = (txt: string) =>
      isPlayer && !txt.startsWith(selectedSubject.name) ? `${selectedSubject.name} · ${txt}` : txt;

    const leg = {
      id: legId,
      marketType: selectedMarket.type as BetMarketType,
      marketLabel: selectedMarket.label,
      subjectType: selectedSubject.type,
      subjectId: selectedSubject.id,
      subjectName: isPlayer ? playerTeamAbbr : selectedSubject.name,
      subjectLogo: selectedSubject.logo,
      selection: withName(selectionLabel.full),
      selectionShort: selectionLabel.short,
      probability: response.probability,
      line: lineValue,
      gameInfo: selectedGame
        ? `${matchupLabel(selectedGame)} · ${selectedGame.date}${selectedGame.startTime ? ` · ${selectedGame.startTime}` : ""}`
        : selectedSubject.subtitle,
      addedAt: new Date().toISOString(),
      // Machine-readable fields for automatic settlement
      gameId:
        selectedSubject.type === "game"
          ? selectedSubject.id
          : selectedSubject.type === "player"
          ? playerGameId
          : selectedGameId ?? undefined,
      selectionValue: selectionValue != null ? String(selectionValue) : undefined,
    } as BetLeg;

    addLeg(leg);
    setAdded(true);
    setAdding(false);
    setTimeout(onClose, 600);
  }

  function buildSelectionLabel(
    market: MarketDefinition,
    subject: Subject,
    selection: string,
    line?: number
  ) {
    const lineStr = line ? ` ${line}` : "";
    const selStr = selection === "over" ? "Over" : selection === "under" ? "Under" : selection;

    if (market.requiresLine && market.requiresSelection) {
      return {
        full: `${selStr}${lineStr} ${market.lineUnit} — ${market.label}`,
        short: `${selStr[0]}${lineStr} ${market.shortLabel}`,
      };
    }
    if (market.requiresSelection) {
      const teamData = getTeamById(selection);
      return {
        full: teamData ? `${teamData.name} — ${market.label}` : `${selStr} — ${market.label}`,
        short: teamData ? `${teamData.abbr} ${market.shortLabel}` : `${selStr} ${market.shortLabel}`,
      };
    }
    return {
      full: `${subject.name} — ${market.label}`,
      short: `${subject.name.split(" ").pop()} ${market.shortLabel}`,
    };
  }

  const canAdd =
    selectedMarket &&
    (!selectedMarket.requiresLine || selectedLine !== null || (selectedMarket.lineOptions?.length ?? 0) > 0) &&
    (!selectedMarket.requiresSelection || selectedSelection !== null) &&
    // Un pari d'équipe sans match ne serait jamais réglé : on ne l'ajoute pas.
    (selectedSubject?.type !== "team" || !!selectedGameId);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center p-4" onClick={onClose}>
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        className="relative bg-[#0A0E0C] rounded-3xl border border-white/20 max-h-[85vh] flex flex-col max-w-[430px] w-full mx-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/20 rounded-t-3xl">
          <div className="flex items-center gap-2">
            {step !== "subject" && !preselectedSubject && (
              <button
                onClick={() => { setStep("subject"); setSelectedMarket(null); setSelectedLine(null); setSelectedSelection(null); }}
                className="tap-44 text-[#86d1ea] text-lg mr-1"
              >←</button>
            )}
            {step === "market" && !preselectedSubject && (
              <button
                onClick={() => { setStep("subject"); setSelectedSubject(null); }}
                className="tap-44 text-[#86d1ea] text-lg mr-1"
              >←</button>
            )}
            <p className="text-white font-bold">
              {step === "subject" && t("mkt.addPrediction")}
              {step === "market" && (selectedSubject?.name || t("mkt.selectMarket"))}
              {step === "configure" && (selectedMarket?.label || t("mkt.configure"))}
            </p>
          </div>
          <button
            onClick={onClose}
            className="tap-44 w-8 h-8 rounded-full bg-[#1B2419] flex items-center justify-center text-[#bfc8cc]"
          >✕</button>
        </div>

        {/* ── Step 1: Subject search ─────────────────────────────────────── */}
        {step === "subject" && (
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="px-4 pt-3 pb-2">
              <div className="bg-[#131A12] border border-white/20 rounded-2xl flex items-center gap-2 px-3 py-2.5">
                <span className="text-[#bfc8cc]">🔍</span>
                <input
                  className="flex-1 bg-transparent text-white text-sm outline-none placeholder:text-[#bfc8cc]"
                  placeholder={t("mkt.search")}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                {searchQuery && (
                  <button onClick={() => setSearchQuery("")} className="tap-44 text-[#bfc8cc] text-xs">✕</button>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-4 pb-6">
              {/* Group by type */}
              {["game", "team", "player"].map((type) => {
                const items = filteredSubjects.filter((s) => s.type === type);
                if (items.length === 0) return null;
                const label = type === "game" ? t("mkt.games") : type === "team" ? t("mkt.teams") : t("mkt.players");
                return (
                  <div key={type} className="mb-4">
                    <p className="text-[#bfc8cc] text-[11px] uppercase tracking-wider mb-2">{label}</p>
                    <div className="flex flex-col gap-1">
                      {items.slice(0, 8).map((subject) => (
                        <button
                          key={subject.id}
                          onClick={() => {
                            setSelectedSubject(subject);
                            setActiveCategory(type === "player" ? "player" : "match");
                            setStep("market");
                          }}
                          className="flex items-center gap-3 bg-[#131A12] border border-white/20 rounded-xl px-3 py-2.5 text-left active:bg-[#1B2419]"
                        >
                          {subject.logo ? <img src={subject.logo} alt="" className="w-6 h-6 object-contain flex-shrink-0" /> : <span className="text-xl flex-shrink-0">🏒</span>}
                          <div className="flex-1 min-w-0">
                            <p className="text-white text-xs font-medium truncate">{subject.name}</p>
                            <p className="text-[#bfc8cc] text-[11px]">{subject.subtitle}</p>
                          </div>
                          <span className="text-[#86d1ea] text-xs">→</span>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Step 2: Market selection ───────────────────────────────────── */}
        {step === "market" && selectedSubject && (
          <div className="flex flex-col flex-1 overflow-hidden">
            {/* Subject pill */}
            <div className="px-4 pt-2 pb-2">
              <div className="flex items-center gap-2 bg-[#86d1ea]/10 border border-[#86d1ea]/30 rounded-xl px-3 py-2">
                {selectedSubject.logo ? <img src={selectedSubject.logo} alt="" className="w-6 h-6 object-contain" /> : <span>🏒</span>}
                <div>
                  <p className="text-white text-xs font-medium">{selectedSubject.name}</p>
                  <p className="text-[#bfc8cc] text-[11px]">{selectedSubject.subtitle}</p>
                </div>
              </div>
            </div>

            {/* Quel match — un pari d'équipe en exige un */}
            {selectedSubject.type === "team" && (
              <GamePickerRow
                games={subjectGames} loading={gamesLoading} selectedId={selectedGameId}
                onSelect={setSelectedGameId} label={t("mkt.gameFor")}
                empty={t("mkt.noUpcomingGame")} matchupLabel={matchupLabel}
              />
            )}

            {/* Category tabs */}
            <div className="flex gap-1.5 px-4 pb-2 overflow-x-auto scrollbar-hide">
              {categoriesForSubject.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  className={`flex-shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-full text-[11px] font-medium transition-all ${
                    activeCategory === cat
                      ? "bg-[#86d1ea] text-[#0A0E0C]"
                      : "bg-[#131A12] text-[#bfc8cc] border border-white/20"
                  }`}
                >
                  <span>{CATEGORY_ICONS[cat]}</span>
                  <span>{CATEGORY_LABELS[cat]}</span>
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto px-4 pb-6">
              <div className="flex flex-col gap-2">
                {marketsByCategory.map((market) => (
                  <button
                    key={market.type}
                    onClick={() => {
                      setSelectedMarket(market);
                      setSelectedLine(market.lineOptions?.[Math.floor(market.lineOptions.length / 2)] ?? null);
                      // Sujet « équipe » : l'équipe EST la sélection, elle est
                      // déjà choisie par le bouton + qui a ouvert cette feuille.
                      // La redemander pour un « First Team to Score » n'ajoutait
                      // qu'un clic sur un bouton unique.
                      setSelectedSelection(
                        market.requiresSelection && !market.selectionOptions
                          ? selectedSubject.type === "team"
                            ? selectedSubject.id
                            : null
                          : market.selectionOptions?.[0]?.value ?? null
                      );
                      if (market.requiresLine || market.requiresSelection) {
                        setStep("configure");
                      } else {
                        setSelectedMarket(market);
                        setStep("configure");
                      }
                    }}
                    className="bg-[#131A12] border border-white/20 rounded-2xl px-4 py-3 text-left flex items-center gap-3 active:bg-[#1B2419]"
                  >
                    <span className="text-xl">{CATEGORY_ICONS[market.category]}</span>
                    <div className="flex-1">
                      <p className="text-white text-xs font-medium">{market.label}</p>
                      <p className="text-[#bfc8cc] text-[11px]">{market.description}</p>
                    </div>
                    <span className="text-[#86d1ea] text-xs">→</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── Step 3: Configure & Add ────────────────────────────────────── */}
        {step === "configure" && selectedMarket && selectedSubject && (
          <div className="flex-1 overflow-y-auto px-4 pb-6">
            {/* Back to market */}
            <button
              onClick={() => { setStep("market"); setSelectedMarket(null); }}
              className="flex items-center gap-1 text-[#86d1ea] text-xs mb-4 mt-2"
            >
              {t("mkt.backToMarkets")}
            </button>

            {/* Rappel du match visé, modifiable sans repasser par les marchés */}
            {selectedSubject.type === "team" && (
              <div className="-mx-4 mb-2">
                <GamePickerRow
                  games={subjectGames} loading={gamesLoading} selectedId={selectedGameId}
                  onSelect={setSelectedGameId} label={t("mkt.gameFor")}
                  empty={t("mkt.noUpcomingGame")} matchupLabel={matchupLabel}
                />
              </div>
            )}

            {/* Market info */}
            <div className="bg-[#131A12] border border-white/20 rounded-2xl p-4 mb-4">
              <p className="text-white font-bold text-sm mb-1">{selectedMarket.label}</p>
              <p className="text-[#bfc8cc] text-xs">{selectedMarket.description}</p>
            </div>

            {/* Line picker */}
            {selectedMarket.requiresLine && selectedMarket.lineOptions && (
              <div className="mb-4">
                <p className="text-[#bfc8cc] text-xs uppercase tracking-wider mb-2">
                  {t("mkt.line", { unit: selectedMarket.lineUnit ?? "" })}
                </p>
                <div className="flex flex-wrap gap-2">
                  {selectedMarket.lineOptions.map((line) => (
                    <button
                      key={line}
                      onClick={() => setSelectedLine(line)}
                      className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                        selectedLine === line
                          ? "bg-[#86d1ea] text-[#0A0E0C]"
                          : "bg-[#131A12] border border-white/20 text-[#bfc8cc]"
                      }`}
                    >
                      {line}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Selection picker — masqué quand la seule option EST l'équipe du
                sujet : elle est déjà sélectionnée, le bloc ne proposait rien. */}
            {(selectedMarket.requiresSelection || selectedMarket.selectionOptions) &&
             !(selectedSubject.type === "team" && !selectedMarket.selectionOptions) && (
              <div className="mb-6">
                <p className="text-[#bfc8cc] text-xs uppercase tracking-wider mb-2">{t("mkt.selection")}</p>
                <div className="flex flex-col gap-2">
                  {(selectedMarket.selectionOptions || getSelectionOptions(selectedMarket)).map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => setSelectedSelection(opt.value)}
                      className={`px-4 py-3 rounded-xl text-sm text-left transition-all ${
                        selectedSelection === opt.value
                          ? "bg-[#86d1ea] text-[#0A0E0C] font-medium"
                          : "bg-[#131A12] border border-white/20 text-white"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                  {/* Team selections for moneyline etc. */}
                  {!selectedMarket.selectionOptions && selectedSubject.type === "game" && (
                    <TeamSelectionsForGame gameId={selectedSubject.id} selected={selectedSelection} onSelect={setSelectedSelection} getTeamById={getTeamById} getGameById={getGameById} />
                  )}
                </div>
              </div>
            )}

            {addError && (
              <p className="mb-2 text-center text-[11px] font-semibold text-amber-300">{addError}</p>
            )}
            <button
              onClick={handleAdd}
              disabled={!canAdd || adding || added}
              className={`w-full py-3.5 rounded-2xl text-sm font-bold transition-all ${
                added
                  ? "bg-green-500 text-white"
                  : canAdd
                  ? "bg-[#86d1ea] text-[#0A0E0C]"
                  : "bg-[#1B2419] text-[#bfc8cc] cursor-not-allowed"
              }`}
            >
              {added ? t("mkt.addedSlip") : adding ? t("mkt.adding") : t("mkt.addToSlip")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Ligne des matchs à venir d'une équipe, en haut de la feuille. Le premier est
 * présélectionné : dans le cas courant (une équipe n'a qu'un match à venir), il
 * n'y a donc rien à faire, et le pari sait quand même sur quoi il porte.
 */
function GamePickerRow({ games, loading, selectedId, onSelect, label, empty, matchupLabel }: {
  games: UpcomingGame[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  label: string;
  empty: string;
  matchupLabel: (g: UpcomingGame) => string;
}) {
  return (
    <div className="px-4 pb-2">
      <p className="text-[#bfc8cc] text-[11px] uppercase tracking-wider mb-1.5">{label}</p>
      {loading ? (
        <div className="h-10 bg-[#131A12] rounded-xl animate-pulse" />
      ) : games.length === 0 ? (
        <p className="text-amber-300 text-[11px] leading-snug">{empty}</p>
      ) : (
        <div className="flex gap-1.5 overflow-x-auto scrollbar-hide">
          {games.map((g) => {
            const on = g.id === selectedId;
            return (
              <button
                key={g.id}
                onClick={() => onSelect(g.id)}
                className={`flex-shrink-0 px-3 py-1.5 rounded-xl text-left transition-all ${
                  on ? "bg-[#86d1ea] text-[#0A0E0C]" : "bg-[#131A12] border border-white/20 text-white"
                }`}
              >
                <span className="block text-[11px] font-bold leading-tight">{matchupLabel(g)}</span>
                <span className={`block text-[11px] leading-tight ${on ? "text-[#0A0E0C]/70" : "text-[#bfc8cc]"}`}>
                  {g.date}{g.startTime ? ` · ${g.startTime}` : ""}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TeamSelectionsForGame({ gameId, selected, onSelect, getTeamById, getGameById }: {
  gameId: string;
  selected: string | null;
  onSelect: (v: string) => void;
  getTeamById: (id: string) => { id: string; name: string; logo: string } | undefined;
  getGameById: (id: string) => { team1Id: string; team2Id: string } | undefined;
}) {
  const game = getGameById(gameId);
  if (!game) return null;
  const t1 = getTeamById(game.team1Id);
  const t2 = getTeamById(game.team2Id);
  if (!t1 || !t2) return null;
  return (
    <>
      {[t1, t2].map((t) => (
        <button
          key={t.id}
          // `onSelect` ne prend qu'un argument (c'est un setState) : les deux
          // autres étaient ignorés en silence.
          onClick={() => onSelect(t.id)}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-left transition-colors active:bg-white/5"
          style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
        >
          {t.logo ? <img src={t.logo} alt={t.name} className="w-7 h-7 object-contain" /> : <span className="text-xl">🏒</span>}
          <span className="text-white text-sm font-medium">{t.name}</span>
        </button>
      ))}
    </>
  );
}
