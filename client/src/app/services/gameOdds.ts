/**
 * gameOdds.ts — le PRIX d'un marché, quand un livre en propose un.
 *
 * ── Ce que ce module fait, et la frontière qu'il ne franchit pas ────────────
 *
 * Il ne produit aucun chiffre. Il va chercher, chez le livre que
 * l'utilisateur a réglé dans les Réglages, la cote réellement offerte sur un
 * marché — et ne rend rien du tout quand ce livre ne cote pas ce marché.
 *
 * ⚠️ Il ne convertit JAMAIS une probabilité du modèle en cote. C'est la règle
 * posée en tête de `services/oddsFormat.ts`, et elle tient ici pour la même
 * raison : une cote est un ENGAGEMENT DE PAIEMENT, notre pourcentage est une
 * mesure de confiance. Les afficher dans la même colonne les rendrait
 * indistinguables, et détruirait précisément la comparaison qui fait l'intérêt
 * du produit — notre estimation FACE au prix du marché. Une tuile sans prix
 * reste donc une tuile avec son seul pourcentage.
 *
 * ── Couverture réelle ───────────────────────────────────────────────────────
 *
 * The Odds API ne sert que trois marchés sur le hockey : `h2h` (vainqueur),
 * `totals` (total de buts) et `spreads` (handicap / puck line). Il n'existe
 * chez ce fournisseur AUCUN prix pour les résultats par période, les écarts de
 * victoire, le premier buteur ni le moindre pari joueur. La très grande
 * majorité des tuiles de l'app resteront donc sans cote, et c'est la réalité du
 * flux, pas un trou d'implémentation : ne pas « compléter » ce vide.
 */

import { fetchBet365Odds, fetchGameExtras, ODDS_SPORT_KEYS, type OddsEvent } from "./oddsApiService";
import type { BookmakerId } from "./bookmakers";
import type { MLProps } from "../pages/prediction/gameMarkets";

/** Les seuls marchés que le proxy accepte (liste blanche dans `odds.routes.ts`). */
const MARKETS = ["h2h", "totals", "spreads"];

/**
 * Prix d'un livre pour un match, aplati en une table consultable.
 *
 * La clé est `<marché>|<sélection>` en minuscules, où la sélection est soit un
 * nom d'équipe normalisé, soit `over` / `under` accompagné de la ligne :
 *   `h2h|edmonton oilers`, `totals|over|5.5`, `spreads|edmonton oilers|-1.5`
 */
export type OddsTable = Map<string, number>;

/** Ce qu'une page sait d'un match, côté cotes. */
export interface GameOdds {
  /** `null` tant que la requête court ; une table (possiblement vide) ensuite. */
  table: OddsTable | null;
  /** Le livre qui a réellement fourni ces prix, pour l'étiqueter à l'écran. */
  bookTitle: string | null;
}

/** Deux écritures du même club ne doivent pas rater la correspondance. */
function norm(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

/**
 * Retrouve l'événement du flux qui correspond à CE match.
 *
 * ⚠️ Les deux côtés doivent tomber juste. Le survol précédent
 * (`HockeyLanding`) appariait sur « domicile OU extérieur », et sur un
 * `includes` d'abréviation : « tor » se retrouve dans « toronto », mais « nyr »
 * n'est dans aucun mot de « New York Rangers », et un OU sur deux affiches du
 * même soir peut coller le prix du mauvais match. On compare les noms complets,
 * des deux côtés, et on refuse le reste.
 */
export function findOddsEvent(events: OddsEvent[], homeName: string, awayName: string): OddsEvent | null {
  const h = norm(homeName);
  const a = norm(awayName);
  if (!h || !a) return null;
  return (
    events.find((e) => {
      const eh = norm(e.homeTeam ?? "");
      const ea = norm(e.awayTeam ?? "");
      // Les deux sens : un flux peut inverser domicile/extérieur sur un match
      // neutre (Stadium Series, matchs en Europe).
      return (eh === h && ea === a) || (eh === a && ea === h);
    }) ?? null
  );
}

/**
 * Aplatit les marchés d'UN livre en table de prix.
 *
 * `preferred` est le livre réglé par l'utilisateur. S'il n'est pas dans la
 * réponse, on ne substitue rien en silence : le nom du livre réellement
 * employé est rendu avec la table, pour que l'écran puisse l'afficher. Un prix
 * étiqueté du mauvais livre enverrait l'utilisateur parier sur une cote qui
 * n'existe pas chez le sien.
 */
function tableFor(event: OddsEvent, preferred: BookmakerId): { table: OddsTable; title: string } | null {
  const book =
    event.bookmakers.find((b) => b.key === preferred) ?? event.bookmakers[0];
  if (!book) return null;

  const table: OddsTable = new Map();
  addMarkets(table, book.markets ?? []);
  return { table, title: book.title ?? book.key };
}

/**
 * Verse les marchés d'un livre dans la table.
 *
 * `point` porte la ligne (`totals` 5.5, `spreads` -1.5). `description` porte
 * l'équipe sur les totaux d'équipe (`team_totals` : « Over 3.5 » de QUI ?) : elle
 * entre dans la clé, sinon les deux équipes s'écraseraient l'une l'autre. Ni
 * l'un ni l'autre n'est déclaré par le type public d'`OddsOutcome`.
 */
function addMarkets(table: OddsTable, markets: OddsEvent["bookmakers"][number]["markets"]): void {
  for (const market of markets) {
    for (const o of market.outcomes ?? []) {
      const { point, description } = o as { point?: number; description?: string };
      const sel = norm(o.name ?? "");
      const who = description ? `${norm(description)}|` : "";
      const key = point == null ? `${market.key}|${who}${sel}` : `${market.key}|${who}${sel}|${point}`;
      if (Number.isFinite(o.price) && o.price > 1) table.set(key, o.price);
    }
  }
}

/* ─── Cache mémoire ──────────────────────────────────────────────────────────
 * Le proxy sert déjà la même réponse à tout le monde pendant 5 minutes, et le
 * navigateur la garde 60 s. Ce cache-ci évite simplement que les trois ou
 * quatre sections d'une même page partent chacune chercher la liste complète.
 */
let cache: { at: number; events: OddsEvent[] } | null = null;
let inflight: Promise<OddsEvent[]> | null = null;
const TTL = 60_000;

export async function fetchHockeyOdds(): Promise<OddsEvent[]> {
  if (cache && Date.now() - cache.at < TTL) return cache.events;
  if (inflight) return inflight;
  inflight = fetchBet365Odds(ODDS_SPORT_KEYS.hockey, MARKETS)
    .then((events) => {
      cache = { at: Date.now(), events };
      return events;
    })
    .catch(() => [] as OddsEvent[])
    .finally(() => { inflight = null; });
  return inflight;
}

/**
 * Les prix d'un match précis, chez le livre réglé.
 *
 * Deux sources fusionnées : le flux de la ligue (vainqueur, handicap, total —
 * un appel pour tous les matchs) et, quand les abréviations sont connues, les
 * marchés SUPPLÉMENTAIRES du match (résultat en 60 min, par période, totaux
 * alternatifs… — `GET /api/odds/extras`, facturés au match côté serveur). Les
 * deux requêtes partent en parallèle ; l'échec de l'une n'enlève rien à
 * l'autre.
 */
export async function loadGameOdds(
  homeName: string,
  awayName: string,
  preferred: BookmakerId,
  abbrs?: { home: string; away: string },
): Promise<GameOdds> {
  const [events, extras] = await Promise.all([
    fetchHockeyOdds(),
    abbrs ? fetchGameExtras(abbrs.home, abbrs.away) : Promise.resolve([]),
  ]);
  const ev = findOddsEvent(events, homeName, awayName);
  const built = ev ? tableFor(ev, preferred) : null;
  const table: OddsTable = built?.table ?? new Map();
  // Même livre que le flux principal quand il est là ; sinon le premier.
  const extraBook = extras.find((b) => b.key === ev?.bookmakers.find((x) => x.title === built?.title)?.key)
    ?? extras[0];
  if (extraBook) addMarkets(table, extraBook.markets ?? []);
  return { table, bookTitle: built?.title ?? extraBook?.title ?? null };
}

/* ─── Du pari au prix ────────────────────────────────────────────────────────
 *
 * La traduction est délibérément ÉTROITE : elle ne couvre que les marchés dont
 * la correspondance avec le flux est certaine. Tout le reste rend `undefined`,
 * et la tuile reste sans cote.
 *
 * Le nom d'équipe est indispensable : le flux nomme ses issues « Edmonton
 * Oilers », jamais « EDM ». Les pages passent donc la table de correspondance
 * abréviation → nom complet du match en cours.
 */
export function priceForBet(
  table: OddsTable | null,
  mlProps: MLProps | undefined,
  nameByAbbr: Record<string, string>,
  /** Identifiant de la TUILE (`gameMarkets.tsx`) — voir le cas `moneyline`. */
  optId?: string,
): number | undefined {
  if (!table || !mlProps) return undefined;
  const { propType, line, subjectId, selection } = mlProps;
  const teamName = norm(nameByAbbr[(subjectId ?? "").toUpperCase()] ?? "");
  if (!propType) return undefined;

  // ── Tuiles dont le marché ML ne dit pas la question posée ────────────────
  //
  // « MTL in Reg » envoie `moneyline` (c'est la victoire toutes issues que le
  // modèle sait estimer, mise à l'échelle par `pctScale`), mais la tuile
  // demande la victoire en 60 MINUTES. Le prix `h2h` à deux issues, prolongation
  // comprise, n'est pas celui de ce pari : il s'affichait à tort jusqu'au
  // 2026-09-27. Son prix est l'issue d'équipe du 3 issues `h2h_3_way`.
  if (optId === "ml-home" || optId === "ml-away") {
    return teamName ? table.get(`h2h_3_way|${teamName}`) : undefined;
  }
  // « Va en prolongation » = le « nul » du 3 issues en 60 min. SEULEMENT pour
  // ces deux tuiles : « MTL in OT/SO » envoie aussi `game_to_ot` + « yes »,
  // mais demande QUI gagne la prolongation — un marché que le flux ne cote pas.
  if (optId === "ot-yes" || optId === "p3-draw") {
    return table.get("h2h_3_way|draw");
  }

  switch (propType) {
    // Vainqueur du match, temps réglementaire compris — le `h2h` du flux est un
    // marché à deux issues (prolongation incluse), donc il ne cote QUE le pari
    // « gagne, toutes issues confondues ». Les tuiles à 4 options introduites
    // pour les prolongations ne sont pas ce marché-là et n'en reçoivent pas le
    // prix : ce serait coter une autre question.
    case "moneyline":
      return teamName ? table.get(`h2h|${teamName}`) : undefined;

    // Ligne principale d'abord, puis les lignes alternatives (`ou + 1`).
    case "total_goals_over":
      return line == null ? undefined
        : table.get(`totals|over|${line}`) ?? table.get(`alternate_totals|over|${line}`);
    case "total_goals_under":
      return line == null ? undefined
        : table.get(`totals|under|${line}`) ?? table.get(`alternate_totals|under|${line}`);

    // Vainqueur d'UNE période : le règlement compte les buts de CETTE période
    // (`periodGoalCounts`, settlement.service.ts), c'est le 3 issues de la
    // période chez le livre — et non « mène après N périodes ».
    case "period1_winner":
    case "period2_winner":
    case "period3_winner": {
      const n = propType.charAt(6);
      return teamName ? table.get(`h2h_3_way_p${n}|${teamName}`) : undefined;
    }

    case "period1_total_goals":
    case "period2_total_goals":
    case "period3_total_goals": {
      const n = propType.charAt(6);
      if (line == null || (selection !== "over" && selection !== "under")) return undefined;
      return table.get(`totals_p${n}|${selection}|${line}`);
    }

    case "both_teams_score":
      return selection === "yes" || selection === "no" ? table.get(`btts|${selection}`) : undefined;

    // Puck line. `line` est le handicap du sujet (−1.5 par défaut, comme au
    // règlement). `selection === "no"` est le « +x » de l'ADVERSAIRE du sujet —
    // le flux le cote sous le nom de cet adversaire, à la ligne opposée.
    case "puck_line": {
      const l = line ?? -1.5;
      if (selection === "no") {
        const oppName = norm(nameByAbbr[(mlProps.opponentId ?? "").toUpperCase()] ?? "");
        return oppName ? table.get(`spreads|${oppName}|${-l}`) : undefined;
      }
      if (!teamName) return undefined;
      return table.get(`spreads|${teamName}|${l}`);
    }

    default:
      return undefined;
  }
}
