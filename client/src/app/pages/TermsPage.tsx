import { useNavigate } from "react-router";
import { IceedgeLogo } from "../components/brand/IceedgeLogo";
import { useI18n } from "../i18n";

const CONTENT = {
  en: {
    updated: "Last updated: July 2026",
    sections: [
      { h: "1. Acceptance of terms", b: "By creating an account or using ArakIce, you agree to these Terms of Service. If you do not agree, please do not use the app." },
      { h: "2. What ArakIce is", b: "ArakIce provides statistical and machine-learning based NHL predictions for informational and entertainment purposes only. We are not a bookmaker and do not accept bets or process wagers." },
      { h: "3. No betting advice", b: "Predictions and probabilities shown in the app are estimates, not guarantees. ArakIce does not guarantee the accuracy of any prediction and is not responsible for any losses resulting from decisions made using the app." },
      { h: "4. Eligibility", b: "You must be 18 or older (or the legal age in your jurisdiction) to create an account. Some jurisdictions may restrict access to sports-betting-adjacent content — you are responsible for complying with local law." },
      { h: "5. Account & subscriptions", b: "You are responsible for keeping your login credentials secure. ArakIce Pro subscriptions renew automatically until cancelled from your account settings." },
      { h: "6. Acceptable use", b: "You agree not to misuse the service: no scraping, reverse engineering, abusive automation, or harassment of other users in chat rooms/leagues." },
      { h: "7. Changes", b: "We may update these terms from time to time. Continued use of the app after changes means you accept the updated terms." },
      { h: "8. Contact", b: "Questions about these terms can be sent to arakice.support@gmail.com." },
    ],
  },
  fr: {
    updated: "Dernière mise à jour : juillet 2026",
    sections: [
      { h: "1. Acceptation des conditions", b: "En créant un compte ou en utilisant ArakIce, tu acceptes ces conditions d'utilisation. Si tu n'es pas d'accord, merci de ne pas utiliser l'application." },
      { h: "2. Ce qu'est ArakIce", b: "ArakIce fournit des prédictions de la LNH basées sur des statistiques et un modèle d'apprentissage automatique, à titre informatif et de divertissement uniquement. Nous ne sommes pas un bookmaker et n'acceptons ni ne traitons aucun pari." },
      { h: "3. Aucun conseil de pari", b: "Les prédictions et probabilités affichées sont des estimations, pas des garanties. ArakIce ne garantit l'exactitude d'aucune prédiction et n'est pas responsable des pertes résultant de décisions prises à partir de l'application." },
      { h: "4. Admissibilité", b: "Tu dois avoir 18 ans ou plus (ou l'âge légal dans ta juridiction) pour créer un compte. Certaines juridictions peuvent restreindre l'accès à du contenu lié aux paris sportifs — tu es responsable du respect des lois locales." },
      { h: "5. Compte et abonnements", b: "Tu es responsable de la sécurité de tes identifiants de connexion. Les abonnements ArakIce Pro se renouvellent automatiquement jusqu'à annulation depuis les paramètres de ton compte." },
      { h: "6. Utilisation acceptable", b: "Tu t'engages à ne pas détourner le service : pas d'extraction automatisée (scraping), d'ingénierie inverse, d'automatisation abusive, ni de harcèlement d'autres utilisateurs dans les salons de chat/ligues." },
      { h: "7. Modifications", b: "Nous pouvons mettre à jour ces conditions de temps à autre. Continuer à utiliser l'application après des modifications signifie que tu acceptes les nouvelles conditions." },
      { h: "8. Contact", b: "Pour toute question sur ces conditions, écris-nous à arakice.support@gmail.com." },
    ],
  },
};

export function TermsPage() {
  const navigate = useNavigate();
  const { t, lang } = useI18n();
  const c = CONTENT[lang];

  return (
    <div className="flex flex-col min-h-screen text-white max-w-[430px] mx-auto px-5 pt-14 pb-16" style={{ background: "#0A0E0C" }}>
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate(-1)} className="text-[#bfc8cc] text-lg">←</button>
        <button onClick={() => navigate("/")} aria-label="Accueil ArakIce"><IceedgeLogo size={28} wordmark={false} /></button>
        <h1 className="text-white text-base font-bold flex-1">{t("legal.terms")}</h1>
      </div>
      <p className="text-[#8a9ea6] text-xs mb-6">{c.updated}</p>
      <div className="flex flex-col gap-5">
        {c.sections.map((s, i) => (
          <div key={i}>
            <p className="text-white text-sm font-semibold mb-1.5">{s.h}</p>
            <p className="text-[#bfc8cc] text-xs leading-relaxed">{s.b}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
