import { useNavigate } from "react-router";
import { IceedgeLogo } from "../components/brand/IceedgeLogo";
import { useI18n } from "../i18n";

const CONTENT = {
  en: {
    updated: "Last updated: July 2026",
    sections: [
      { h: "1. Data we collect", b: "Account info (email, username, optional display name/photo), authentication data (via email/password or Google OAuth), your predictions/slips, chat messages in leagues you join, and basic usage data to keep the app running smoothly." },
      { h: "2. How we use your data", b: "To operate your account, calculate your slip history and stats, run the ML prediction models, enable real-time chat, and — if you opt in — send notifications about value-bet opportunities." },
      { h: "3. What we don't do", b: "We do not sell your personal data to third parties. We do not share your chat messages or slip history outside the app except as required by law." },
      { h: "4. Third-party services", b: "We use Google OAuth for optional sign-in, and external sports data providers (NHL Stats API, tennis data, odds data) to power predictions — these do not receive your personal account data." },
      { h: "5. Data retention & deletion", b: "You can request deletion of your account and associated data at any time by contacting support. Refresh tokens and session data are automatically purged on logout or expiry." },
      { h: "6. Security", b: "Passwords are hashed, refresh tokens are stored in httpOnly cookies, and API keys you provide (e.g. for AI features) are stored securely and used only for your own requests." },
      { h: "7. Your rights", b: "Depending on your jurisdiction, you may have the right to access, correct, or delete your personal data. Contact us to exercise these rights." },
      { h: "8. Contact", b: "Privacy questions can be sent to arakice.support@gmail.com." },
    ],
  },
  fr: {
    updated: "Dernière mise à jour : juillet 2026",
    sections: [
      { h: "1. Données que nous collectons", b: "Infos de compte (courriel, nom d'utilisateur, nom affiché/photo facultatifs), données d'authentification (courriel/mot de passe ou Google OAuth), tes prédictions/coupons, messages de chat dans les ligues que tu rejoins, et des données d'usage de base pour faire fonctionner l'application." },
      { h: "2. Comment nous utilisons tes données", b: "Pour gérer ton compte, calculer ton historique de coupons et tes statistiques, exécuter les modèles de prédiction ML, permettre le chat en temps réel et, si tu l'acceptes, t'envoyer des notifications sur les opportunités de value bets." },
      { h: "3. Ce que nous ne faisons pas", b: "Nous ne vendons pas tes données personnelles à des tiers. Nous ne partageons pas tes messages de chat ni ton historique de coupons en dehors de l'application, sauf obligation légale." },
      { h: "4. Services tiers", b: "Nous utilisons Google OAuth pour la connexion facultative, et des fournisseurs de données sportives externes (API stats LNH, données tennis, cotes) pour alimenter les prédictions — ils ne reçoivent pas tes données personnelles de compte." },
      { h: "5. Conservation et suppression des données", b: "Tu peux demander la suppression de ton compte et des données associées à tout moment en contactant le support. Les jetons de rafraîchissement et données de session sont automatiquement purgés à la déconnexion ou à l'expiration." },
      { h: "6. Sécurité", b: "Les mots de passe sont hachés, les jetons de rafraîchissement sont stockés dans des cookies httpOnly, et les clés API que tu fournis (ex. pour les fonctions IA) sont stockées en sécurité et utilisées uniquement pour tes propres requêtes." },
      { h: "7. Tes droits", b: "Selon ta juridiction, tu peux avoir le droit d'accéder à, de corriger ou de supprimer tes données personnelles. Contacte-nous pour exercer ces droits." },
      { h: "8. Contact", b: "Pour toute question sur la confidentialité, écris-nous à arakice.support@gmail.com." },
    ],
  },
};

export function PrivacyPage() {
  const navigate = useNavigate();
  const { t, lang } = useI18n();
  const c = CONTENT[lang];

  return (
    <div className="flex flex-col min-h-screen text-white max-w-[430px] mx-auto px-5 pt-14 pb-16" style={{ background: "#0A0E0C" }}>
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate(-1)} className="text-[#bfc8cc] text-lg">←</button>
        <button onClick={() => navigate("/")} aria-label="Accueil ArakIce"><IceedgeLogo size={28} wordmark={false} /></button>
        <h1 className="text-white text-base font-bold flex-1">{t("legal.privacy")}</h1>
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
