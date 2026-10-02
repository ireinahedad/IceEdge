/**
 * EvSection.tsx
 *
 * Extrait de HockeyLanding.tsx le 2026-08-10.
 *
 * ── 2026-10-02 : la section ne CALCULE plus rien ───────────────────────────
 *
 * La liste était calculée ici, côté client : `% modèle − round(100 / cote)`,
 * sans retirer la marge du livre, seuil 5 points, matchs en direct compris.
 * L'alerte push en calculait une autre. Décision du user : les deux partagent
 * le même critère — celui de `server/src/services/valueBets.service.ts`, lu
 * par `GET /api/predict/value-bets` (Pro). Gardiens confirmés, match pas
 * commencé, marge retirée, vainqueur 2–6 %, puck line −1.5 ≥ 4 % : tout se
 * décide là-bas. Ici on affiche.
 *
 * La « cote minimale » (« rentable au-dessus de… ») est le seuil de
 * rentabilité selon le modèle, 1 / p. Elle sert à vérifier la value chez son
 * propre livre (Bet365, Stake), que The Odds API ne cote pas. Écrite dans le
 * format de cote choisi, comme la cote implicite des jambes (décision du
 * 2026-09-25) ; le % du modèle, lui, reste un %.
 */

import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Zap, Settings, Lightbulb } from "lucide-react";
import { ErrorState } from "../../components/ErrorState";
import { useMinOddsText } from "../../components/BetHandoffSheet";
import { useBookmaker } from "../../context/BookmakerContext";
import { useOddsFormat } from "../../context/OddsFormatContext";
import { features } from "../../platform";
import { nhlLogoUrl } from "../../data/teamEmoji";
import { useI18n } from "../../i18n";
import { predictionApiService, type ApiValueBet } from "../../services/predictionApiService";

/** Ce qu'une ligne affiche — un value bet du serveur, ou un exemple flouté. */
export type EvRowItem = Pick<ApiValueBet,
  "id" | "market" | "team" | "opponent" | "line" | "modelProb" | "marketProb" | "price" | "bookTitle" | "minOdds">;

// Exemples montrés FLOUTÉS aux non-abonnés (`ProUpsell`) : la forme d'une
// ligne, pas une vraie value. Leurs écarts restent dans les bandes du critère
// réel (2–6 % au vainqueur, ≥ 4 % à la puck line) — un exemple à +11 pts
// promettait ce que le critère rejette comme du bruit.
export const EV_SAMPLE: EvRowItem[] = [
  { id: "ev-s1", market: "moneyline", team: "TOR", opponent: "MTL", line: null,
    modelProb: 0.55, marketProb: 0.52, price: 1.85, bookTitle: "BetRivers", minOdds: 1 / 0.55 },
  { id: "ev-s2", market: "puck_line", team: "EDM", opponent: "CGY", line: -1.5,
    modelProb: 0.42, marketProb: 0.37, price: 2.55, bookTitle: "BetRivers", minOdds: 1 / 0.42 },
];

/** « −1.5 » avec un vrai signe moins, comme le reste de l'app. */
function lineLabel(line: number | null): string {
  if (line == null) return "";
  return line < 0 ? `−${Math.abs(line)}` : `+${line}`;
}

/**
 * Une ligne de value bet, lisible sans connaître le jargon (2026-09-27) :
 * « +3 pts » en vert = l'écart, dessous les deux chances qui le font — celle du
 * modèle contre celle du livre, marge retirée. L'écart affiché est la
 * différence des deux pourcentages ARRONDIS, pour que la ligne se relise juste.
 */
export function EvRow({ item, onOpen }: { item: EvRowItem; onOpen?: () => void }) {
  const { t } = useI18n();
  const { odds } = useOddsFormat();
  const minOddsText = useMinOddsText();
  const model = Math.round(item.modelProb * 100);
  const book = Math.round(item.marketProb * 100);
  const label = evLabel(item, t);
  // Toucher la ligne = « à chercher chez ton livre » (2026-10-02). Sans
  // `onOpen` (exemples floutés, iOS), la ligne n'est qu'un affichage.
  const Tag = onOpen ? "button" : "div";
  return (
    <Tag
      {...(onOpen ? { type: "button" as const, onClick: onOpen } : {})}
      className="w-full text-left flex items-center gap-2.5 icy-card rounded-xl px-2.5 py-2 active:scale-[0.99] transition-transform">
      <img src={nhlLogoUrl(item.team)} alt="" className="w-5 h-5 object-contain flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-white text-[11px] font-medium truncate">{label}</div>
        <div className="text-[#8a9ea6] text-[11px] truncate">
          {t("home.evPrice", { book: item.bookTitle, price: odds(item.price) })}
        </div>
        {/* Sa propre ligne : c'est elle qu'on lit chez SON livre, elle ne doit
            jamais être coupée par l'ellipse à 390 px. */}
        <div className="text-[#bfc8cc] text-[11px] truncate">
          {minOddsText(item.minOdds)}
        </div>
      </div>
      <div className="text-right flex-shrink-0">
        <div className="text-green-400 text-[11px] font-bold tabular-nums">{t("home.evEdge", { edge: model - book })}</div>
        <div className="text-[#bfc8cc] text-[11px] tabular-nums">
          {t("home.evVs", { model, book })}
        </div>
      </div>
    </Tag>
  );
}

/** « MTL −1.5 vs TOR » ou « TOR gagne vs MTL ». */
function evLabel(item: EvRowItem, t: ReturnType<typeof useI18n>["t"]): string {
  return item.market === "puck_line"
    ? `${item.team} ${lineLabel(item.line)} vs ${item.opponent}`
    : t("home.evWinner", { team: item.team, opp: item.opponent });
}

/** Nombre de lignes affichées : les plus gros écarts d'abord (tri du serveur). */
const MAX_ROWS = 6;

/** Section Value bets — rendue pour les abonnés Pro seulement (`HockeyLanding`). */
export function EvSection({ accent }: { accent: string }) {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const { openBetFor } = useBookmaker();
  const [items, setItems] = useState<ApiValueBet[] | null>(null);

  /** Le ticket de la fiche « à chercher chez ton livre ». */
  const openFor = (b: ApiValueBet) => {
    const start = b.startTimeUTC ? new Date(b.startTimeUTC) : null;
    openBetFor({
      match: b.isHome ? `${b.opponent} @ ${b.team}` : `${b.team} @ ${b.opponent}`,
      when: start && !Number.isNaN(start.getTime())
        ? start.toLocaleTimeString(lang === "fr" ? "fr-CA" : "en-US", { hour: "numeric", minute: "2-digit" })
        : null,
      market: t(b.market === "puck_line" ? "handoff.mktPuck" : "handoff.mktWinner"),
      selection: b.market === "puck_line" ? `${b.team} ${lineLabel(b.line)}` : t("home.evWinnerShort", { team: b.team }),
      minOdds: b.minOdds,
      shownPrice: b.price,
      shownBook: b.bookTitle,
    });
  };
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setItems(null);
    predictionApiService.getValueBets()
      .then((r) => { if (!cancelled) setItems(r.bets.slice(0, MAX_ROWS)); })
      .catch((e) => { if (!cancelled) setError(e ?? new Error("value bets failed")); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  return (
    <section className="px-4">
      <div className="flex items-center gap-2 mb-3">
        <Zap size={13} style={{ color: accent }} />
        <span className="text-white text-sm font-medium">{t("home.evTitle")}</span>
        {/* « Réglages des alertes » ouvrait /profile, c'est-à-dire l'onglet
            Aperçu : il fallait ensuite trouver Paramètres, puis faire défiler
            jusqu'aux notifications. Le lien porte maintenant l'onglet ET la
            section (`ProfilePage` lit `focus=notifications`). */}
        <button
          onClick={() => navigate("/profile?tab=settings&focus=notifications")}
          aria-label={t("home.evSettings")}
          title={t("home.evSettings")}
          className="ml-auto flex items-center gap-1 text-white/50 hover:text-white transition-colors"
        >
          <Settings size={13} />
          <span className="text-[11px]">{t("home.evSettings")}</span>
        </button>
      </div>

      {/* Ce qu'est un value bet, pour quelqu'un qui n'a jamais parié
          (2026-09-27). Toujours visible : c'est la clé de lecture des lignes. */}
      <div className="flex gap-2 rounded-xl px-3 py-2.5 mb-3"
        style={{ background: "rgba(74,222,128,0.06)", border: "1px solid rgba(74,222,128,0.18)" }}>
        <Lightbulb size={14} className="flex-shrink-0 mt-0.5 text-green-400" />
        <div className="text-[11px] leading-relaxed text-[#bfc8cc]">
          <p className="font-bold text-white">{t("home.evWhatTitle")}</p>
          <p>{t("home.evWhat")}</p>
          <p>{t("home.evWhat2")}</p>
          <p>{t("home.evWhat3")}</p>
          <p>{t("home.evWhat4")}</p>
          <p className="mt-1"><span className="font-bold text-white">{t("home.evExampleLabel")}</span>: {t("home.evExample")}</p>
        </div>
      </div>

      {error ? (
        <ErrorState compact error={error} onRetry={() => setReloadKey((k) => k + 1)} />
      ) : items == null ? (
        <div className="flex flex-col gap-1.5">{[1, 2, 3].map((i) => <div key={i} className="h-11 icy-tile rounded-xl animate-pulse" />)}</div>
      ) : items.length === 0 ? (
        <div className="py-6 text-center text-[#bfc8cc] text-xs">{t("home.evEmpty")}</div>
      ) : (
        <div className="flex flex-col gap-1.5">{items.map((i) => (
          <EvRow key={i.id} item={i} onOpen={features.bookmakerLinks ? () => openFor(i) : undefined} />
        ))}</div>
      )}
    </section>
  );
}
