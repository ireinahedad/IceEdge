/**
 * PlayerPropGrid.tsx — les paris joueur d'un match ou d'un club, en grille.
 *
 * ── Ce qu'elle remplace ─────────────────────────────────────────────────────
 *
 * Le tableau de statistiques qui fermait ces pages (`GamePlayersTable`) montrait
 * la ligne de saison de chaque joueur — des nombres à lire, sur lesquels on ne
 * pouvait rien miser. Pour parier sur les buts de quelqu'un, il fallait toucher
 * sa ligne, choisir « ses prédictions », atterrir sur sa page, y trouver le bon
 * groupe : cinq gestes et deux écrans pour un pari, répétés pour chaque joueur
 * qu'on voulait comparer. La comparaison, elle, était perdue en route.
 *
 * Ici, une ligne par joueur, une colonne par seuil, et chaque case EST le pari.
 * On lit la grille de haut en bas pour comparer, on touche pour miser.
 *
 * ── Les cinq premiers, puis tout le monde ───────────────────────────────────
 *
 * Une formation fait une vingtaine de patineurs. Les déployer d'emblée pousse
 * les marchés suivants hors de l'écran et noie les cinq joueurs sur lesquels
 * portent la plupart des paris. La grille s'ouvre donc sur le top 5 du
 * classement de la statistique concernée et se déplie SUR PLACE — pas de
 * navigation, pas de fiche : la page ne bouge pas sous les doigts.
 */

import { useEffect, useMemo, useState } from "react";
import { nhlApiService, type BoxscoreLine, type GameBoxscoreResponse } from "../../services/nhlApiService";
import { useI18n } from "../../i18n";
import { nhlLogoUrl } from "../../data/teamEmoji";
import { BetOption } from "./PredictionSheet";
import type { BetOpt, MLProps } from "./gameMarkets";

/** Les statistiques qu'on peut miser en grille. */
export type PropMetric = "goals" | "assists" | "points" | "shots" | "hits" | "blocks" | "saves";

interface MetricSpec {
  /** Champ de la ligne d'effectif qui porte le total de saison. */
  field: "goals" | "assists" | "points" | "shots" | "hits" | "blockedShots" | "saves";
  /** Seuils proposés en colonnes. « 1+ » veut dire ligne 0,5. */
  thresholds: number[];
  /** Marché envoyé au moteur de probabilité. */
  propType: string;
  /** Marché canonique pour le règlement automatique du coupon. */
  settleMarket: string;
  /** Clé i18n du titre de la section. */
  titleKey: string;
  /**
   * `true` = grille de GARDIENS. Les deux populations s'excluent : un gardien
   * n'a ni but ni passe, un patineur n'a pas d'arrêt. Une seule grille mélangée
   * n'aurait qu'une moitié de lignes remplies, quel que soit le tri.
   */
  goalies?: boolean;
  /**
   * Les seuils sont-ils EXPRIMÉS EN VALEUR ABSOLUE ou relativement à la moyenne
   * du joueur ?
   *
   * « 1+ but » est absolu : le seuil a le même sens pour tout le monde. « 26+
   * arrêts » ne l'est pas — un partant en voit trente, un auxiliaire vingt, et
   * des colonnes fixes donneraient une grille de 3 % ou de 92 % selon l'équipe.
   * Les arrêts se calent donc sur la moyenne du gardien, ±3.
   */
  relative?: boolean;
  /**
   * Champ de la FEUILLE DE MATCH qui correspond à cette statistique.
   *
   * Pendant une partie, la grille affiche ce que le joueur a déjà accumulé CE
   * SOIR, et grise les seuils qu'il a franchis. Le nom diffère parfois de celui
   * du total de saison (`blockedShots` des deux côtés, mais `saves` contre
   * `shotsAgainst - goalsAgainst`), d'où cette seconde clé.
   */
  liveField: keyof BoxscoreLine;
  /**
   * Colonne SUPPLÉMENTAIRE en tête de grille, propre à une page de match.
   *
   * Un seul cas aujourd'hui : le premier buteur. Ce n'est pas un seuil
   * cumulatif comme « 2+ buts » — c'est une course entre tous les joueurs des
   * deux formations, et elle n'a de sens que rapportée à UN match précis. Elle
   * n'apparaît donc que lorsqu'un `gameId` est connu.
   */
  leading?: {
    titleKey: string;
    settleMarket: string;
    /** Du taux de buts par match à P(ouvre le score). */
    pct: (lambda: number) => number;
  };
}

/**
 * ⚠️ Les seuils s'arrêtent où la statistique cesse d'être crédible.
 *
 * Trois buts dans un match, c'est un tour du chapeau : rare, mais un vrai
 * marché. Quatre, c'est une probabilité qu'un modèle de Poisson calé sur une
 * moyenne de saison n'estime plus honnêtement — on ne propose pas une colonne
 * pour faire nombre. Les passes montent plus haut (elles sont plus fréquentes),
 * les tirs bloqués aussi (un défenseur en bloque deux ou trois par match).
 */
const SPECS: Record<PropMetric, MetricSpec> = {
  goals: {
    field: "goals", thresholds: [1, 2, 3], liveField: "goals",
    propType: "goals", settleMarket: "anytime_goal", titleKey: "prop.goals",
    leading: {
      titleKey: "prop.firstGoal",
      settleMarket: "first_goal_scorer",
      /**
       * P(ouvre le score) ≈ P(marque au moins une fois) ÷ 6.
       *
       * Le diviseur vient du fait qu'un match NHL compte ~6 buts : parmi tous
       * les buteurs de la soirée, un seul est le premier. C'est grossier — ça
       * ignore le temps de jeu, les unités spéciales et la force de
       * l'adversaire — mais c'est EXACTEMENT la formule que `PlayerPrediction`
       * applique déjà à sa tuile « First Goal Scorer ». Deux estimations
       * différentes du même pari selon l'écran où on le regarde serait bien
       * pire qu'une estimation approximative des deux côtés.
       *
       * Plancher à 3 % comme partout : en dessous, on afficherait une précision
       * qu'une moyenne de saison ne porte pas.
       */
      pct: (lambda) => Math.max(3, Math.round(poissonAtLeast(lambda, 1) / 6)),
    },
  },
  assists: {
    field: "assists", thresholds: [1, 2], liveField: "assists",
    propType: "assists", settleMarket: "assists_ou", titleKey: "prop.assists",
  },
  // Points = buts + passes. Plus fréquent que chacun pris à part, donc un
  // seuil de plus : le match à trois points existe pour un premier trio.
  points: {
    field: "points", thresholds: [1, 2, 3], liveField: "points",
    propType: "points", settleMarket: "points_ou", titleKey: "prop.points",
  },
  // Tirs au but : le prop joueur le plus liquide chez les livres. Un attaquant
  // de premier trio en met trois ou quatre, d'où des seuils qui montent plus
  // haut que pour les buts.
  shots: {
    field: "shots", thresholds: [1, 2, 3, 4], liveField: "shots",
    propType: "shots", settleMarket: "shots_ou", titleKey: "prop.shots",
  },
  hits: {
    field: "hits", thresholds: [1, 2, 3], liveField: "hits",
    propType: "hits", settleMarket: "hits_ou", titleKey: "prop.hits",
  },
  blocks: {
    field: "blockedShots", thresholds: [1, 2, 3], liveField: "blockedShots",
    propType: "blocks", settleMarket: "blocked_shots_ou", titleKey: "prop.blocks",
  },
  // Arrêts — seuls marchés de gardien de cette grille, et seuls seuils
  // relatifs : voir `relative` ci-dessus. Les trois colonnes encadrent la
  // moyenne du gardien pour que la grille dise quelque chose dans les deux sens.
  saves: {
    field: "saves", thresholds: [-3, 0, 3], goalies: true, relative: true, liveField: "saves",
    propType: "saves", settleMarket: "goalie_saves_ou", titleKey: "prop.saves",
  },
};

/**
 * P(X ≥ k) pour une cadence λ par match, loi de Poisson.
 *
 * Le même modèle que celui déjà employé par `PlayerPrediction` pour « buteur à
 * tout moment » — délibérément : deux estimations différentes du même pari
 * selon l'écran où on le regarde, c'est la chose à ne pas faire.
 *
 * Bornée à [3, 92] comme ailleurs dans l'app : au-delà, on afficherait une
 * précision qu'une moyenne de saison ne porte pas.
 */
function poissonAtLeast(lambda: number, k: number): number {
  const lam = Math.max(0.001, lambda);
  let term = Math.exp(-lam);
  let cdf = term;                       // P(X = 0)
  for (let i = 1; i < k; i++) {
    term *= lam / i;
    cdf += term;                        // P(X ≤ k-1)
  }
  return Math.min(92, Math.max(3, Math.round((1 - cdf) * 100)));
}

type RosterRow = {
  id: string; name: string; position?: string; number?: number;
  gamesPlayed?: number; statsSeason?: string;
  goals?: number; assists?: number; points?: number; shots?: number;
  hits?: number; blockedShots?: number;
  /** Gardiens seulement — les arrêts se déduisent de ces deux-là. */
  shotsAgainst?: number; goalsAgainst?: number;
};

/**
 * Le total de saison d'un joueur pour une statistique.
 *
 * Les arrêts sont le seul champ CALCULÉ : l'API ne les donne pas, ce sont les
 * tirs reçus moins les buts encaissés.
 */
function seasonTotal(p: RosterRow, field: MetricSpec["field"]): number | undefined {
  if (field === "saves") {
    const sa = p.shotsAgainst, ga = p.goalsAgainst;
    return sa == null || ga == null ? undefined : Math.max(0, sa - ga);
  }
  const v = p[field];
  return typeof v === "number" ? v : undefined;
}

/** « 20252026 » → « 2025-26 », pour dater une grille d'un coup d'œil. */
function seasonLabel(id: string | undefined): string {
  if (!id || id.length !== 8) return "";
  return `${id.slice(0, 4)}-${id.slice(6, 8)}`;
}

/** Une ligne de la grille, prête à rendre. */
interface GridRow {
  id: string;
  name: string;
  position: string;
  /** Total de saison, affiché en tête de ligne pour situer le joueur. */
  total: number;
  /** Une option de pari par seuil. */
  opts: BetOpt[];
  /**
   * Les seuils de CETTE ligne, écrits (« 26+ »).
   *
   * Ils vivent sur la ligne et non sur la grille parce que les arrêts se calent
   * sur la moyenne de chaque gardien : deux lignes d'une même grille n'ont
   * alors pas les mêmes colonnes, et un en-tête unique mentirait sur l'une des
   * deux. Les statistiques à seuils absolus rendent simplement le même tableau
   * sur toutes les lignes.
   */
  headers: string[];
  /**
   * Le seuil numérique de chaque colonne, aligné sur `opts` — `null` pour une
   * colonne qui n'en est pas une (le premier buteur). Sert à savoir quelles
   * cases le joueur a déjà franchies ce soir.
   */
  thresholds: (number | null)[];
  /** Total DANS CE MATCH. `undefined` hors match en cours. */
  liveCount?: number;
}

export function PlayerPropGrid({ metric, sides, gameId, accent }: {
  metric: PropMetric;
  /** Un club sur une page d'équipe, deux sur une page de match. */
  sides: { key: string; abbr: string; name: string }[];
  gameId?: string;
  accent: string;
}) {
  const { t, lang } = useI18n();
  const spec = SPECS[metric];

  const [sideKey, setSideKey] = useState(sides[0]?.key ?? "");
  const [rosters, setRosters] = useState<Record<string, RosterRow[]>>({});
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [box, setBox] = useState<GameBoxscoreResponse | null>(null);

  const side = sides.find(s => s.key === sideKey) ?? sides[0];
  const abbr = side?.abbr ?? "";

  useEffect(() => {
    if (!abbr || rosters[abbr]) return;
    let alive = true;
    setLoading(true);
    nhlApiService.getTeamRoster(abbr.toUpperCase())
      .then((r: any[]) => { if (alive) setRosters(prev => ({ ...prev, [abbr]: r as RosterRow[] })); })
      .catch(() => { if (alive) setRosters(prev => ({ ...prev, [abbr]: [] })); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [abbr]);

  // Changer de club referme le dépliage : on regarde une autre formation, pas
  // la suite de la précédente.
  useEffect(() => { setExpanded(false); }, [abbr]);

  /**
   * La feuille de match, tant qu'il y a un match.
   *
   * Elle est REDEMANDÉE toutes les 30 secondes une fois le match en cours, et
   * plus du tout dès qu'il est terminé — c'est le même rythme que le cache du
   * serveur, donc l'intervalle ne coûte rien de plus en amont : il ne fait que
   * récupérer ce que le serveur a déjà rafraîchi.
   *
   * L'intervalle est armé à partir de l'état REÇU, jamais deviné. Sans match en
   * cours, il n'existe pas : une page de prédiction ouverte un mardi après-midi
   * ne doit pas battre en arrière-plan.
   */
  useEffect(() => {
    if (!gameId) { setBox(null); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const r = await nhlApiService.getGameBoxscore(gameId);
        if (!alive) return;
        setBox(r);
        // Seul un match EN COURS mérite un rappel. Terminé, il ne bougera
        // plus ; à venir, sa feuille est vide et le premier but arrivera avec
        // le prochain chargement de page.
        if (r.state === "live") timer = setTimeout(tick, 30_000);
      } catch {
        // Feuille indisponible : la grille reste en mode « saison », qui est
        // son mode normal. Pas de réessai en boucle sur une erreur.
        if (alive) setBox(null);
      }
    };
    tick();

    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [gameId]);

  /** `true` seulement quand le serveur dit que le match est en cours. */
  const isLive = box?.state === "live";

  const rows: GridRow[] = useMemo(() => {
    const roster = rosters[abbr] ?? [];
    return roster
      // Les deux populations s'excluent : un gardien n'a ni but ni passe, un
      // patineur n'a pas d'arrêt. Mélanger les deux dans une grille ne
      // remplirait jamais qu'une moitié des lignes, quel que soit le tri.
      .filter(p => ((p.position ?? "F") === "G") === !!spec.goalies)
      .map((p) => {
        const gp = Math.max(1, p.gamesPlayed ?? 0);
        const total = seasonTotal(p, spec.field) ?? 0;
        const lambda = total / gp;

        // Seuils : absolus pour les statistiques comparables d'un joueur à
        // l'autre, relatifs à la moyenne du joueur pour les arrêts — « 26+ »
        // ne veut pas dire la même chose pour un partant et un auxiliaire.
        // Plancher à 1 : une colonne « 0+ arrêt » est toujours vraie.
        const seuils = spec.relative
          ? spec.thresholds.map(d => Math.max(1, Math.round(lambda) + d))
          : spec.thresholds;

        // Ce que le joueur a DÉJÀ accumulé ce soir. `undefined` hors match en
        // cours — et `undefined` n'est pas 0 : « pas de match » et « rien
        // marqué » ne s'affichent pas pareil.
        const liveLine: BoxscoreLine | undefined = isLive ? box?.players?.[p.id] : undefined;
        const liveCount = liveLine ? Number(liveLine[spec.liveField] ?? 0) : undefined;

        const opts: BetOpt[] = seuils.map((k, i) => {
          const line = k - 0.5;
          const mlProps: MLProps = {
            type: "player", subjectId: p.id, propType: spec.propType, line,
            settleMarket: spec.settleMarket,
            // « anytime_goal » se règle sur `buts > ligne`, donc la ligne porte
            // déjà le seuil ; la sélection reste « oui ». Les marchés en
            // over/under attendent « over ».
            settleSelection: spec.settleMarket === "anytime_goal" ? "yes" : "over",
            gameId,
          };
          return {
            // `i` et non `k` : deux seuils relatifs peuvent se rejoindre après
            // arrondi et plancher (un gardien à 1,4 arrêt de moyenne donne
            // 1, 1, 4), et deux options de même identifiant partageraient leur
            // clé React comme leur jambe de coupon.
            id: `${metric}-${p.id}-${i}`,
            label: `${p.name} · ${k}+ ${t(spec.titleKey)}`,
            rulePct: poissonAtLeast(lambda, k),
            ruleNote: t("prop.note", {
              name: p.name, k: String(k), metric: t(spec.titleKey).toLowerCase(),
              rate: lambda.toFixed(2), total: String(total), gp: String(gp),
            }),
            mlProps,
          };
        });
        // ── Colonne de tête : le premier buteur ──────────────────────────
        //
        // Conditionnée à `gameId`, et pas seulement au nombre de clubs
        // affichés : « qui ouvre le score » est une course entre les joueurs
        // des DEUX formations d'une affiche précise, pas une propriété du
        // joueur. La page d'un match en a toujours un ; celle d'une équipe en a
        // un dès qu'un match est choisi dans son sélecteur, et la colonne y
        // apparaît alors à juste titre — c'est le même pari, sur le même match,
        // et il portera le même identifiant de règlement. Sans match choisi,
        // elle disparaît plutôt que de coter une question sans objet.
        const lead = spec.leading && gameId
          ? {
              id: `${metric}-${p.id}-first`,
              label: `${p.name} · ${t(spec.leading.titleKey)}`,
              rulePct: spec.leading.pct(lambda),
              ruleNote: t("prop.firstNote", {
                name: p.name, rate: lambda.toFixed(2),
                any: String(poissonAtLeast(lambda, 1)),
              }),
              mlProps: {
                type: "player", subjectId: p.id, propType: spec.propType, line: 0.5,
                settleMarket: spec.leading.settleMarket, settleSelection: "yes", gameId,
              } as MLProps,
            } as BetOpt
          : null;

        return {
          id: p.id, name: p.name, position: p.position ?? "F", total,
          opts: lead ? [lead, ...opts] : opts,
          // Le « 1er » n'est pas un seuil : il ne se compare pas au compteur en
          // direct comme « 2+ » le fait, d'où le `null` qui le distingue.
          headers: [...(lead ? [t("prop.firstShort")] : []), ...seuils.map(k => `${k}+`)],
          thresholds: [...(lead ? [null] : []), ...seuils],
          liveCount,
        };
      })
      .sort((a, b) => b.total - a.total);
    // `lang` et non `t` : le contexte i18n recrée `t` à chaque rendu du
    // fournisseur. Le mettre en dépendance recalculerait toute la grille — et
    // donc chaque objet `mlProps` — à chaque rendu de la page, ce qui est
    // exactement le motif que l'audit du 2026-09-16 a dû défaire sur les tuiles
    // de marché (31 appels de prédiction par bascule, 429 dès le premier
    // aller-retour). `lang` est la seule chose dont dépendent les libellés.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rosters, abbr, metric, gameId, lang, spec, isLive, box]);

  // Tirs bloqués non câblés pour cette équipe (amont muet, ou saison à zéro
  // match) : la grille entière vaudrait « 3 % » sur chaque case, ce qui n'est
  // pas une prédiction mais un plancher. On le dit plutôt que de l'afficher.
  const hasData = rows.some(r => r.total > 0);
  const shown = expanded ? rows : rows.slice(0, 5);
  const season = seasonLabel((rosters[abbr] ?? [])[0]?.statsSeason);

  // En-têtes de colonnes : ceux de la première ligne affichée. Pour une
  // statistique à seuils absolus, toutes les lignes ont les mêmes. Pour les
  // arrêts — seuils calés sur la moyenne de chaque gardien — ils diffèrent
  // d'une ligne à l'autre, donc chaque ligne réaffiche les siens en tête de
  // ses cases plutôt que de se fier à un en-tête qui mentirait.
  const perRowHeaders = !!spec.relative;
  const headers = shown[0]?.headers ?? spec.thresholds.map(k => `${k}+`);

  return (
    <div className="bg-[#131A12] border border-white/20 rounded-2xl overflow-hidden">
      <div className="px-4 pt-3 pb-2 flex items-center gap-2">
        <span className="text-white text-sm font-medium">{t(spec.titleKey)}</span>
        {/* La SAISON de ces chiffres. En avant-saison ce n'est pas l'année en
            cours mais la dernière complète : « 32 buts » sans date, sur une
            page qui parle du match de ce soir, se lit « 32 buts cette saison ».
            Le serveur dit laquelle (`statsSeason`) ; on la montre toujours,
            plutôt que seulement quand elle surprend — une date qui n'apparaît
            que parfois se remarque moins qu'une date qui est toujours là. */}
        {season && (
          <span className="text-[#5c6f63] text-[10px] tabular-nums px-1.5 py-0.5 rounded border border-white/10">
            {season}
          </span>
        )}
        {isLive && (
          <span className="flex items-center gap-1 text-[11px] font-semibold text-red-400">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
            {t("prop.live")}
          </span>
        )}
        <span className="text-[#8a9ea6] text-[11px] ml-auto">
          {expanded ? t("prop.allPlayers") : t("prop.top5")}
        </span>
      </div>

      {/* Sélecteur de club — seulement sur une page de match */}
      {sides.length > 1 && (
        <div className="px-4 pb-3">
          <div className="flex gap-1.5 bg-[#0A0E0C] rounded-xl p-1">
            {sides.map(o => (
              <button
                key={o.key}
                onClick={() => setSideKey(o.key)}
                className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-semibold transition-all"
                style={sideKey === o.key ? { background: accent, color: "#0A0E0C" } : { color: "#8a9ea6" }}
              >
                <img src={nhlLogoUrl(o.abbr)} alt={o.abbr} className="w-4 h-4 object-contain" />
                {o.abbr}
              </button>
            ))}
          </div>
        </div>
      )}

      {loading && rows.length === 0 ? (
        <div className="px-4 pb-4 flex flex-col gap-2">
          {[1, 2, 3, 4, 5].map(i => <div key={i} className="h-10 bg-[#0A0E0C] rounded-lg animate-pulse" />)}
        </div>
      ) : rows.length === 0 ? (
        <p className="text-[#8a9ea6] text-xs text-center py-6">{t("players.none", { abbr })}</p>
      ) : !hasData ? (
        <p className="text-[#8a9ea6] text-xs text-center py-6 px-4">{t("prop.noStat")}</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="text-[#8a9ea6]">
                  <th className="text-left font-semibold px-3 py-2 sticky left-0 z-10" style={{ background: "#131A12" }}>
                    {t("chart.player")}
                  </th>
                  {/* Colonne « ce soir » — uniquement pendant le match. Elle
                      est posée entre le nom et les paris, parce qu'elle change
                      la lecture de toutes les cases qui suivent : « 2+ buts »
                      ne veut pas dire la même chose selon qu'il en a déjà un. */}
                  {isLive && (
                    <th className="font-semibold px-2 py-2 text-center whitespace-nowrap text-red-400">
                      {t("prop.tonight")}
                    </th>
                  )}
                  {headers.map((h, i) => (
                    <th key={i} className="font-semibold px-1.5 py-2 text-center whitespace-nowrap">
                      {perRowHeaders ? "" : h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} className="border-t border-white/[0.06]">
                    <td className="px-3 py-1.5 sticky left-0 z-10 whitespace-nowrap" style={{ background: "#131A12" }}>
                      <span className="text-white font-medium">{r.name}</span>
                      <span className="text-[#5c6f63] ml-1.5">{r.position}</span>
                      {/* Le total de saison situe le joueur : sans lui, deux
                          cases à 18 % se ressemblent alors que l'une repose sur
                          40 matchs et l'autre sur 3. */}
                      <span className="text-[#5c6f63] ml-1.5 tabular-nums">({r.total})</span>
                    </td>
                    {isLive && (
                      <td className="px-2 py-1.5 text-center tabular-nums font-bold"
                          style={{ color: (r.liveCount ?? 0) > 0 ? "#f87171" : "#5c6f63" }}>
                        {r.liveCount ?? "—"}
                      </td>
                    )}
                    {r.opts.map((o, i) => {
                      // Seuil déjà franchi ce soir : la case porte une coche.
                      //
                      // ⚠️ Elle ne dit PAS que le pari est gagné — le règlement
                      // est un autre circuit, et une jambe reste « en attente »
                      // jusqu'à la fin du match. Elle dit un FAIT : le joueur a
                      // atteint ce nombre. C'est la différence entre informer
                      // et promettre, et sur une app de paris elle compte.
                      const seuil = r.thresholds[i];
                      const reached = seuil != null && r.liveCount != null && r.liveCount >= seuil;
                      return (
                        <td key={o.id} className="px-1 py-1.5 align-middle relative" style={{ minWidth: 56 }}>
                          {perRowHeaders && (
                            <div className="text-[#5c6f63] text-[9px] text-center leading-none mb-0.5 tabular-nums">
                              {r.headers[i]}
                            </div>
                          )}
                          {reached && (
                            <div className="text-[#f87171] text-[9px] text-center leading-none mb-0.5 font-bold"
                                 title={t("prop.reached")}>
                              ✓
                            </div>
                          )}
                          <BetOption opt={o} accent={accent} compact />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {rows.length > 5 && (
            <button
              onClick={() => setExpanded(v => !v)}
              className="w-full py-2.5 text-[11px] font-semibold border-t border-white/[0.06] transition-colors"
              style={{ color: accent }}
            >
              {expanded
                ? t("prop.showLess")
                : t("prop.showMore", { n: String(rows.length - 5) })}
            </button>
          )}
        </>
      )}
    </div>
  );
}
