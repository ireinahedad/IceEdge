import { useNavigate } from "react-router";
import { IceedgeLogo } from "../components/brand/IceedgeLogo";
import { useI18n } from "../i18n";
import { env } from "../env";

const CONTENT = {
  en: {
    updated: "Last updated: August 2026",
    sections: [
      { h: "1. Data we collect", b: "Account info (email, username, optional display name/photo), authentication data (via email/password or Google OAuth), your predictions/slips, chat messages in leagues you join, and basic usage data to keep the app running smoothly." },
      { h: "2. How we use your data", b: "To operate your account, calculate your slip history and stats, run the ML prediction models, enable real-time chat, and — if you opt in — send notifications about value-bet opportunities." },
      { h: "3. What we don't do", b: "We do not sell your personal data to third parties. We do not share your chat messages outside the app except as required by law. Your bet slips are never shared outside ArakIce either — but inside the app they are visible to Pro members, as described in section 4." },
      { h: "4. Slips visible to Pro members", b: "Pro members can open your player page and see your bet slips, leg by leg, along with your recent win rate. Three limits apply. (a) Only slips placed after this feature went live are ever shown — everything you placed before that date stays private permanently. (b) A slip's picks stay hidden until the first game starts; before puck drop, others only see that a slip exists. (c) You can turn this off at any time: Settings → Privacy → \"Hide my slips from other players\". Hiding removes all of your slips at once and does not affect your leaderboard rank. We never expose stake amounts — we do not collect them." },
      { h: "5. Third-party services", b: "We use Google OAuth for optional sign-in, and external sports data providers (NHL Stats API, odds data) to power predictions — these do not receive your personal account data." },
      { h: "6. Data retention & deletion", b: "You can request deletion of your account and associated data at any time by contacting support. Refresh tokens and session data are automatically purged on logout or expiry." },
      { h: "7. Security", b: "Passwords are hashed, refresh tokens are stored in httpOnly cookies, and API keys you provide (e.g. for AI features) are stored securely and used only for your own requests." },
      { h: "8. Your rights", b: "Depending on your jurisdiction, you may have the right to access, correct, or delete your personal data. Contact us to exercise these rights." },
      { h: "9. Contact", b: `Privacy questions can be sent to ${env.supportEmail}.` },
    ],
  },
  fr: {
    updated: "Dernière mise à jour : août 2026",
    sections: [
      { h: "1. Données que nous collectons", b: "Infos de compte (courriel, nom d'utilisateur, nom affiché/photo facultatifs), données d'authentification (courriel/mot de passe ou Google OAuth), tes prédictions/coupons, messages de chat dans les ligues que tu rejoins, et des données d'usage de base pour faire fonctionner l'application." },
      { h: "2. Comment nous utilisons tes données", b: "Pour gérer ton compte, calculer ton historique de coupons et tes statistiques, exécuter les modèles de prédiction ML, permettre le chat en temps réel et, si tu l'acceptes, t'envoyer des notifications sur les opportunités de value bets." },
      { h: "3. Ce que nous ne faisons pas", b: "Nous ne vendons pas tes données personnelles à des tiers. Nous ne partageons pas tes messages de chat en dehors de l'application, sauf obligation légale. Tes coupons ne sortent jamais d'ArakIce non plus — mais à l'intérieur de l'application, ils sont visibles aux membres Pro, comme décrit à la section 4." },
      { h: "4. Coupons visibles aux membres Pro", b: "Les membres Pro peuvent ouvrir ta page joueur et consulter tes coupons, pari par pari, avec ton taux de réussite récent. Trois limites s'appliquent. (a) Seuls les coupons déposés APRÈS la mise en service de cette fonction sont montrés — tout ce que tu as saisi avant cette date reste privé de façon permanente. (b) Les sélections d'un coupon restent cachées jusqu'au début du premier match : avant la mise au jeu, les autres voient seulement qu'un coupon existe. (c) Tu peux désactiver cela à tout moment : Paramètres → Confidentialité → « Masquer mes coupons aux autres joueurs ». Le masquage retire tous tes coupons d'un coup et n'affecte pas ton rang au classement. Aucun montant misé n'est jamais exposé — nous n'en collectons pas." },
      { h: "5. Services tiers", b: "Nous utilisons Google OAuth pour la connexion facultative, et des fournisseurs de données sportives externes (API stats LNH, cotes) pour alimenter les prédictions — ils ne reçoivent pas tes données personnelles de compte." },
      { h: "6. Conservation et suppression des données", b: "Tu peux demander la suppression de ton compte et des données associées à tout moment en contactant le support. Les jetons de rafraîchissement et données de session sont automatiquement purgés à la déconnexion ou à l'expiration." },
      { h: "7. Sécurité", b: "Les mots de passe sont hachés, les jetons de rafraîchissement sont stockés dans des cookies httpOnly, et les clés API que tu fournis (ex. pour les fonctions IA) sont stockées en sécurité et utilisées uniquement pour tes propres requêtes." },
      { h: "8. Tes droits", b: "Selon ta juridiction, tu peux avoir le droit d'accéder à, de corriger ou de supprimer tes données personnelles. Contacte-nous pour exercer ces droits." },
      { h: "9. Contact", b: `Pour toute question sur la confidentialité, écris-nous à ${env.supportEmail}.` },
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
        <button onClick={() => navigate(-1)} className="tap-44 text-[#bfc8cc] text-lg">←</button>
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
