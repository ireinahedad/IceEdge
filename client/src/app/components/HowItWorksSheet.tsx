import { useI18n } from "../i18n";

/**
 * "How it works" guide — explains the three prediction sources (Rules, ML, LLM)
 * and how to use the app. Bilingual (FR/EN) via the app language.
 */

interface Section {
  icon: string;
  title: string;
  color: string;
  body: string;
}

export function HowItWorksSheet({ onClose }: { onClose: () => void }) {
  const { lang } = useI18n();
  const fr = lang === "fr";

  const intro = fr
    ? "ArakIce estime la probabilité de chaque pari à partir de trois moteurs complémentaires. La même probabilité est affichée dans les stats et enregistrée dans ton coupon — elle vient toujours de la même source, donc les chiffres concordent partout."
    : "ArakIce estimates the probability of each bet from three complementary engines. The same probability is shown in the stats and stored in your coupon — it always comes from the same source, so the numbers match everywhere.";

  const sections: Section[] = [
    {
      icon: "📐",
      color: "#86d1ea",
      title: fr ? "Règles (statistiques)" : "Rules (statistics)",
      body: fr
        ? "Le moteur de base. Il calcule une probabilité avec des formules mathématiques appliquées aux vraies stats de la saison : Log5 (force relative des équipes) pour les vainqueurs, et distribution de Poisson (rythme de buts/tirs/points par match) pour les totaux et les props de joueurs. Rapide, transparent et déterministe : le même contexte donne toujours le même chiffre. C'est la source qui couvre tous les marchés."
        : "The base engine. It computes a probability with math formulas applied to real season stats: Log5 (relative team strength) for winners, and a Poisson distribution (goals/shots/points-per-game rate) for totals and player props. Fast, transparent and deterministic: the same context always gives the same number. It's the source that covers every market.",
    },
    {
      icon: "🤖",
      color: "#a78bfa",
      title: fr ? "ML (modèle entraîné)" : "ML (trained model)",
      body: fr
        ? "Un modèle d'apprentissage automatique (type Random Forest) entraîné côté serveur sur des caractéristiques du match (forme, différentiel de buts, avantage de la glace, etc.). Il renvoie sa propre probabilité et l'importance de chaque facteur, ce qui permet de voir POURQUOI il penche d'un côté. Utile pour confirmer ou nuancer la règle : quand ML et règles s'accordent, la confiance est plus forte."
        : "A machine-learning model (Random Forest style) trained server-side on game features (form, goal differential, home-ice advantage, etc.). It returns its own probability and each factor's importance, so you can see WHY it leans one way. Useful to confirm or temper the rule: when ML and rules agree, confidence is higher.",
    },
    {
      icon: "✨",
      color: "#c084fc",
      title: fr ? "LLM (Ask LLM)" : "LLM (Ask LLM)",
      body: fr
        ? "Une analyse en langage naturel qui apporte le contexte que les chiffres ne captent pas : matchup de style, motivation, fatigue, et surtout ce qu'il faut VÉRIFIER avant de parier (blessures, gardien partant confirmé, changements d'alignement de dernière minute). Ce n'est pas une probabilité, mais un avis à recouper. En Pro, il passe par GitHub Models ; en gratuit, tu utilises ta propre clé OpenAI."
        : "A natural-language analysis that adds the context numbers miss: style matchup, motivation, fatigue, and above all what to VERIFY before betting (injuries, confirmed starting goalie, last-minute lineup changes). It's not a probability but a second opinion to cross-check. On Pro it runs via GitHub Models; on Free you use your own OpenAI key.",
    },
  ];

  const reading = fr
    ? [
        "Le % est la probabilité estimée que le pari passe. La couleur va du vert (fort) au rouge (peu probable).",
        "La jauge de confiance résume la solidité de l'estimation.",
        "Touche un pari pour ouvrir le détail : règle + note explicative, carte ML avec ses facteurs, et le bouton Ask LLM.",
      ]
    : [
        "The % is the estimated probability the bet hits. Colour runs from green (strong) to red (unlikely).",
        "The confidence gauge sums up how solid the estimate is.",
        "Tap a bet to open the detail: rule + explanation note, ML card with its factors, and the Ask LLM button.",
      ];

  const actions = fr
    ? [
        "Explore par équipe, par match ou par joueur avec les onglets en haut.",
        "Ajoute un pari au coupon avec le bouton « + » : la probabilité affichée est celle qui est enregistrée.",
        "Empile plusieurs paris : le coupon calcule la probabilité combinée du parlay.",
        "Partage ton coupon en image.",
      ]
    : [
        "Explore by team, game or player with the tabs at the top.",
        "Add a bet to the coupon with the “+” button: the shown probability is the one stored.",
        "Stack several bets: the coupon computes the parlay's combined probability.",
        "Share your coupon as an image.",
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
          <div>
            <h2 className="text-white font-bold text-lg" style={{ fontFamily: "'Merriweather', Georgia, serif" }}>
              {fr ? "Comment ça marche" : "How it works"}
            </h2>
            <p className="text-[#8a9ea6] text-xs mt-0.5">
              {fr ? "Le guide des prédictions ArakIce" : "The ArakIce prediction guide"}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full bg-[#1B2419] flex items-center justify-center text-[#bfc8cc] flex-shrink-0"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto px-5 py-4 flex flex-col gap-4">
          <p className="text-[#bfc8cc] text-[13px] leading-relaxed">{intro}</p>

          <div>
            <p className="text-[#4a6070] text-[10px] font-semibold uppercase tracking-wider mb-2">
              {fr ? "Les 3 sources de prédiction" : "The 3 prediction sources"}
            </p>
            <div className="flex flex-col gap-2.5">
              {sections.map((s) => (
                <div
                  key={s.title}
                  className="bg-[#131A12] border border-white/10 rounded-2xl p-4"
                  style={{ borderLeft: `3px solid ${s.color}` }}
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className="text-lg">{s.icon}</span>
                    <span className="text-white text-sm font-bold" style={{ color: s.color }}>
                      {s.title}
                    </span>
                  </div>
                  <p className="text-[#bfc8cc] text-[12.5px] leading-relaxed">{s.body}</p>
                </div>
              ))}
            </div>
          </div>

          <div>
            <p className="text-[#4a6070] text-[10px] font-semibold uppercase tracking-wider mb-2">
              {fr ? "Lire une prédiction" : "Reading a prediction"}
            </p>
            <div className="bg-[#131A12] border border-white/10 rounded-2xl p-4 flex flex-col gap-2">
              {reading.map((r, i) => (
                <div key={i} className="flex gap-2.5">
                  <span className="text-[#86d1ea] text-xs mt-0.5 flex-shrink-0">→</span>
                  <span className="text-[#bfc8cc] text-[12.5px] leading-relaxed">{r}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <p className="text-[#4a6070] text-[10px] font-semibold uppercase tracking-wider mb-2">
              {fr ? "Ce que tu peux faire" : "What you can do"}
            </p>
            <div className="bg-[#131A12] border border-white/10 rounded-2xl p-4 flex flex-col gap-2">
              {actions.map((a, i) => (
                <div key={i} className="flex gap-2.5">
                  <span className="text-green-400 text-xs mt-0.5 flex-shrink-0">✓</span>
                  <span className="text-[#bfc8cc] text-[12.5px] leading-relaxed">{a}</span>
                </div>
              ))}
            </div>
          </div>

          <p className="text-[#5a6a72] text-[11px] leading-relaxed text-center pt-1 pb-2">
            {fr
              ? "Les probabilités sont des estimations d'aide à la décision, pas des garanties. Parie de façon responsable."
              : "Probabilities are decision-support estimates, not guarantees. Bet responsibly."}
          </p>
        </div>
      </div>
    </div>
  );
}
