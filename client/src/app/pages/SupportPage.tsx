import { LegalPage } from "../components/LegalPage";
import { useI18n } from "../i18n";
import { env } from "../env";

const CONTENT = {
  en: {
    intro: "Need help? Reach out and we'll get back to you as soon as possible.",
    faqTitle: "Frequently asked questions",
    faq: [
      { q: "How are predictions calculated?", a: "ArakIce combines statistical rules (recent form, head-to-head, home ice/court advantage) with a machine-learning model trained on historical results. Both are shown side by side so you can compare." },
      { q: "Is ArakIce a bookmaker?", a: "No. ArakIce does not accept bets. We link out to third-party bookmakers (e.g. bet365) where legally available." },
      { q: "How do I cancel my Pro subscription?", a: "Go to Profile → Settings → Subscription, then tap \"Cancel subscription\". Your access stays active until the end of the current billing period." },
      { q: "How do I delete my account?", a: "Contact us at the email below and we'll process the deletion, including all associated data." },
    ],
  },
  fr: {
    intro: "Besoin d'aide ? Écris-nous et nous te répondrons dans les meilleurs délais.",
    faqTitle: "Questions fréquentes",
    faq: [
      { q: "Comment les prédictions sont-elles calculées ?", a: "ArakIce combine des règles statistiques (forme récente, confrontations directes, avantage de la glace/du court) avec un modèle d'apprentissage automatique entraîné sur des résultats historiques. Les deux sont affichés côte à côte pour comparaison." },
      { q: "ArakIce est-il un bookmaker ?", a: "Non. ArakIce n'accepte aucun pari. Nous redirigeons vers des bookmakers tiers (ex. bet365) là où c'est légalement disponible." },
      { q: "Comment annuler mon abonnement Pro ?", a: "Va dans Profil → Paramètres → Abonnement, puis touche « Annuler l'abonnement ». Ton accès reste actif jusqu'à la fin de la période de facturation en cours." },
      { q: "Comment supprimer mon compte ?", a: "Contacte-nous à l'adresse ci-dessous et nous traiterons la suppression, incluant toutes les données associées." },
    ],
  },
};

export function SupportPage() {
  const { t, lang } = useI18n();
  const c = CONTENT[lang];

  return (
    <LegalPage title={t("legal.support")}>
      <p className="text-[#bfc8cc] text-sm mb-4">{c.intro}</p>
      {/* R4.0 — une seule source pour l'adresse : env.supportEmail. */}
      <a href={`mailto:${env.supportEmail}`} className="text-sm font-bold mb-8 inline-block" style={{ color: "#86d1ea" }}>
        {env.supportEmail}
      </a>

      <p className="text-white text-sm font-semibold mb-3">{c.faqTitle}</p>
      <div className="flex flex-col gap-4">
        {c.faq.map((f, i) => (
          <div key={i} className="bg-[#131A12] border border-white/10 rounded-xl p-3.5">
            <p className="text-white text-xs font-semibold mb-1.5">{f.q}</p>
            <p className="text-[#bfc8cc] text-xs leading-relaxed">{f.a}</p>
          </div>
        ))}
      </div>
    </LegalPage>
  );
}
