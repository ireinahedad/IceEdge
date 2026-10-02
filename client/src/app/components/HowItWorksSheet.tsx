import { useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { useAuth } from "../context/AuthContext";
import { apiGetSubscription } from "../services/subscriptionService";

import { X } from "lucide-react";
/**
 * « Comment ça marche » : le guide de la page Stats (bouton « ? »).
 *
 * Réécrit le 2026-09-29 à la demande du user : phrases courtes, pas de tirets,
 * pas d'émojis, une idée par ligne ; puis détaillé (règles utilisées, saisons
 * du ML, fonctionnement et coût du LLM).
 *
 * ⚠️ Faits à garder vrais si on retouche :
 *   - Règles : `server/src/services/nhlPredictions.ts` (`computeGameMarkets`) :
 *     force = 70 % fiche de saison + 30 % 10 derniers matchs, Log5, glace,
 *     fatigue (repos, matchs consécutifs, voyage, fuseaux, altitude), cotes,
 *     blessures et alignement ; totaux et joueurs par Poisson.
 *   - ML : `ml/models/training_report.json` (modèle du vainqueur). ⚠️ Les
 *     saisons et le nombre de matchs sont RECOPIÉS ici : à mettre à jour après
 *     un réentraînement (`python train.py`). Les hyperparamètres ne sont PAS
 *     affichés (décision du user, 2026-09-29).
 *   - LLM : le plafond Pro n'est JAMAIS écrit en dur ; il vient du serveur
 *     (`llmMonthlyQuota` de `GET /subscription/me`), comme sur /pro.
 *   - Couleurs des % : bleu → mauve → rouge, écrans de prédiction seulement.
 */

interface Section {
  title: string;
  color: string;
  /** `null` = ligne masquée (ex. plafond Pro inconnu). */
  lines: (string | null)[];
}

export function HowItWorksSheet({ onClose }: { onClose: () => void }) {
  const { lang } = useI18n();
  const { user } = useAuth();
  const fr = lang === "fr";

  // Plafond IA Pro, tel que le serveur le calcule. Absent (hors connexion,
  // erreur) : la ligne Pro n'est pas affichée du tout (décision du user,
  // 2026-09-29) plutôt que d'inventer un chiffre.
  const [quota, setQuota] = useState<number | null>(null);
  useEffect(() => {
    if (!user) return;
    let alive = true;
    apiGetSubscription()
      .then((s) => { if (alive && s.llmMonthlyQuota) setQuota(s.llmMonthlyQuota); })
      .catch(() => { /* phrase sans chiffre */ });
    return () => { alive = false; };
  }, [user]);

  const intro = fr
    ? "Chaque pari affiche sa chance de passer selon le modèle ML, en %. C'est ce chiffre qui est enregistré dans ton coupon."
    : "Every bet shows its chance of hitting according to the ML model, in %. That number is the one saved in your slip.";

  const proLine = !quota ? null : fr
    ? `Avec Pro : jusqu'à ${quota} requêtes par mois, incluses.`
    : `With Pro: up to ${quota} requests a month, included.`;

  const sections: Section[] = [
    {
      color: "#a78bfa",
      title: "ML",
      lines: fr
        ? [
            "Un modèle XGBoost entraîné sur les anciennes saisons, de 2008-2009 à 2025-2026 : environ 21 500 matchs.",
            "Les matchs les plus anciens servent à l'entraîner et à le régler ; les 20 % les plus récents servent seulement à le tester.",
            "Il regarde entre autres l'Elo, les chances de marquer créées et accordées, les gardiens, les joueurs clés absents, le repos et les cotes.",
            "Ses probabilités sont recalibrées : un 60 % passe environ 6 fois sur 10.",
          ]
        : [
            "An XGBoost model trained on past seasons, from 2008-09 to 2025-26: about 21,500 games.",
            "The oldest games train and tune it; the most recent 20% are only used to test it.",
            "It looks at Elo, scoring chances created and allowed, goalies, missing key players, rest and odds, among others.",
            "Its probabilities are recalibrated: a 60% hits about 6 times out of 10.",
          ],
    },
    {
      color: "#86d1ea",
      title: fr ? "Règles (dans le détail d'un pari)" : "Rules (inside a bet's detail)",
      lines: fr
        ? [
            "Vainqueur : la force des deux équipes (70 % fiche de la saison, 30 % 10 derniers matchs), comparée avec la formule Log5.",
            "Ajustée par l'avantage de la glace et la fatigue : jours de repos, matchs consécutifs, voyage, fuseaux horaires, altitude.",
            "Les cotes du marché, les blessures et l'alignement s'ajoutent quand on les a.",
            "Totaux et paris joueurs : on estime la moyenne attendue de buts, tirs ou points, puis la loi de Poisson donne la chance de dépasser la ligne.",
            "Tu peux changer le poids de chaque facteur.",
          ]
        : [
            "Winner: both teams' strength (70% season record, 30% last 10 games), compared with the Log5 formula.",
            "Adjusted for home ice and fatigue: rest days, back-to-backs, travel, time zones, altitude.",
            "Market odds, injuries and lineups are added when we have them.",
            "Totals and player bets: we estimate the expected goals, shots or points, then a Poisson distribution gives the chance of clearing the line.",
            "You can change the weight of each factor.",
          ],
    },
    {
      color: "#c084fc",
      title: "LLM",
      lines: fr
        ? [
            "Il lit les données du pari et ajoute ce que les chiffres ne voient pas : forme, fatigue, voyage, style de jeu, motivation.",
            "Il liste ce qu'il faut vérifier avant de parier : blessures, gardien partant, alignement.",
            "Il finit par un verdict et un niveau de confiance. Tu peux ensuite lui poser d'autres questions sur le pari.",
            proLine,
            "Sans Pro : il utilise ta propre clé OpenAI (Réglages), à tes frais. Chaque question compte pour une requête.",
          ]
        : [
            "It reads the bet's data and adds what the numbers miss: form, fatigue, travel, playing style, motivation.",
            "It lists what to check before betting: injuries, starting goalie, lineup.",
            "It ends with a verdict and a confidence level. You can then ask it more questions about the bet.",
            proLine,
            "Without Pro: it uses your own OpenAI key (Settings), at your cost. Each question counts as one request.",
          ],
    },
  ];

  const tips = fr
    ? [
        "Bleu : probable. Mauve : serré. Rouge : peu probable.",
        "Touche un pari pour voir le détail et l'ajouter au coupon.",
        "Plusieurs paris ? Le coupon calcule la chance que tout passe.",
        "Deux paris contraires sont permis. Le total tombe alors à 0 %.",
        "Meilleurs paris, sur l'accueil : les matchs des 48 prochaines heures.",
      ]
    : [
        "Blue: likely. Purple: close. Red: unlikely.",
        "Tap a bet to see the detail and add it to your slip.",
        "Several bets? The slip works out the chance they all hit.",
        "Opposite bets are allowed. The total then drops to 0%.",
        "Best Bets, on the home screen: games in the next 48 hours.",
      ];

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col justify-end"
      style={{ background: "rgba(0,0,0,0.75)" }}
      onClick={onClose}
    >
      <div
        className="relative bg-[#0A0E0C] rounded-t-3xl border-t border-white/20 max-h-[90vh] flex flex-col max-w-[430px] md:max-w-2xl w-full mx-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1 flex-shrink-0">
          <div className="w-10 h-1 rounded-full bg-[#1B2419]" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-1 pb-3 border-b border-white/10 flex-shrink-0">
          <h2 className="text-white font-bold text-lg" style={{ fontFamily: "'Merriweather', Georgia, serif" }}>
            {fr ? "Comment ça marche" : "How it works"}
          </h2>
          <button
            onClick={onClose}
            aria-label={fr ? "Fermer" : "Close"}
            className="tap-44 w-8 h-8 rounded-full bg-[#1B2419] flex items-center justify-center text-[#bfc8cc] flex-shrink-0"
          >
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto px-5 py-4 pb-nav-safe flex flex-col gap-4">
          <p className="text-[#bfc8cc] text-[13px] leading-relaxed">{intro}</p>

          <div className="flex flex-col gap-2">
            {sections.map((s) => (
              <div
                key={s.title}
                className="bg-[#131A12] border border-white/10 rounded-2xl px-4 py-3"
                style={{ borderLeft: `3px solid ${s.color}` }}
              >
                <p className="text-sm font-bold mb-1" style={{ color: s.color }}>{s.title}</p>
                <ul className="flex flex-col gap-1">
                  {s.lines.filter((line): line is string => line !== null).map((line) => (
                    <li key={line} className="text-[#bfc8cc] text-[12.5px] leading-relaxed">{line}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <ul className="bg-[#131A12] border border-white/10 rounded-2xl px-4 py-3 flex flex-col gap-1.5">
            {tips.map((tip) => (
              <li key={tip} className="text-[#bfc8cc] text-[12.5px] leading-relaxed">{tip}</li>
            ))}
          </ul>

          <p className="text-[#5a6a72] text-[11px] leading-relaxed text-center pt-1 pb-2">
            {fr
              ? "Ce sont des estimations, pas des garanties. Joue de façon responsable."
              : "These are estimates, not guarantees. Bet responsibly."}
          </p>
        </div>
      </div>
    </div>
  );
}
