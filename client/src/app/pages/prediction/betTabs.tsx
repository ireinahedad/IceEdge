/**
 * betTabs.tsx — onglets de la page Prédiction (2026-10-14, demande du user) :
 * les paris étaient tous empilés sur une seule page, et il fallait descendre
 * très bas pour atteindre les grilles joueur.
 *
 *   « Joueurs »        grilles de paris joueur (buts, passes, points…)
 *   « Équipes / Match » groupes de marchés du match ou du club
 *
 * ⚠️ Les DEUX panneaux restent montés ; l'onglet inactif est seulement caché
 * (classe `hidden`). Le « Top 90% + », placé au-dessus des onglets, lit un registre
 * que chaque producteur remplit à son montage et vide à son démontage
 * (`topBetsRegistry.tsx`) : démonter un onglet ferait disparaître ses paris
 * du Top, et rechargerait ses grilles à chaque changement d'onglet.
 *
 * L'onglet choisi est gardé en mémoire (`localStorage`, comme l'état plié des
 * sections), une clé par type de page. Stockage indisponible → « Joueurs ».
 */
import { useState, type ReactNode } from "react";
import { useI18n } from "../../i18n";

export type BetTab = "players" | "markets";

const KEY = "iceedge_predTab:";

function readTab(scope: string): BetTab {
  try {
    const v = localStorage.getItem(KEY + scope);
    return v === "markets" ? "markets" : "players";
  } catch {
    return "players";
  }
}

export function BetTabs({ scope, accent, players, markets }: {
  /** Type de page (« game », « team ») : chacun garde son onglet. */
  scope: string;
  accent: string;
  players: ReactNode;
  markets: ReactNode;
}) {
  const { t } = useI18n();
  const [tab, setTab] = useState<BetTab>(() => readTab(scope));
  const pick = (next: BetTab) => {
    setTab(next);
    try { localStorage.setItem(KEY + scope, next); } catch { /* stockage indisponible */ }
  };

  const tabs: { id: BetTab; label: string }[] = [
    { id: "players", label: t("pred.tabPlayers") },
    { id: "markets", label: t("pred.tabMarkets") },
  ];

  return (
    <>
      <div
        role="tablist"
        className="grid grid-cols-2 gap-1 p-1 rounded-2xl border border-white/10"
        style={{ background: "#0A0E0C" }}
      >
        {tabs.map(x => {
          const active = tab === x.id;
          return (
            <button
              key={x.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => pick(x.id)}
              className="py-2.5 rounded-xl text-xs font-bold uppercase tracking-wider transition-colors"
              style={active
                ? { background: accent + "22", color: accent, boxShadow: `inset 0 0 0 1px ${accent}55` }
                : { color: "#8a9ea6" }}
            >
              {x.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" className={tab === "players" ? "flex flex-col gap-3" : "hidden"}>{players}</div>
      <div role="tabpanel" className={tab === "markets" ? "flex flex-col gap-3" : "hidden"}>{markets}</div>
    </>
  );
}
