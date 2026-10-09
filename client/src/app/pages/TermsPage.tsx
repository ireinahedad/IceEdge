import { LegalDocument } from "../components/LegalPage";
import { useI18n } from "../i18n";
import { env } from "../env";

const CONTENT = {
  en: {
    updated: "Last updated: October 9, 2026",
    sections: [
      { h: "1. Acceptance of terms", b: "By creating an account or using ArakIce, you agree to these Terms of Service. If you do not agree, please do not use the app." },
      { h: "2. What ArakIce is", b: "ArakIce provides statistical and machine-learning based NHL predictions for informational and entertainment purposes only. We are not a bookmaker and do not accept bets or process wagers. ArakIce is not affiliated with, endorsed by or sponsored by the National Hockey League (NHL) or any of its teams; NHL and team names are trademarks of their respective owners and are used only to identify the games discussed." },
      { h: "3. No betting advice", b: "Predictions and probabilities shown in the app are estimates, not guarantees. ArakIce does not guarantee the accuracy of any prediction and is not responsible for any losses resulting from decisions made using the app." },
      { h: "4. Eligibility", b: "You must be 18 or older (or the legal age in your jurisdiction) to create an account. Some jurisdictions may restrict access to sports-betting-adjacent content — you are responsible for complying with local law." },
      { h: "5. Account & subscriptions", b: "You are responsible for keeping your login credentials secure. ArakIce Pro subscriptions renew automatically until cancelled from your account settings. You can delete your account at any time in Settings → Security; deletion is immediate and permanent, and cancels an active subscription at once. See the Privacy Policy for what is erased." },
      { h: "6. Acceptable use", b: "You agree not to misuse the service: no scraping, reverse engineering, abusive automation, or harassment of other users in chat rooms/leagues." },
      { h: "7. Community guidelines for chat", b: "Chat rooms are shared spaces. Do not post harassment or threats, hate speech or slurs targeting anyone, sexual content, spam or scams, or anyone's private information. A profanity filter rejects some messages outright — a rejected message is never posted, and you are told why so you can rephrase. Every message carries a Report button and a Block option. Reporting sends the message to a moderation queue we read; a message reported by several different people is hidden automatically while it waits. Blocking someone hides their messages from you and yours from them, both ways, and you can undo it at any time in Settings → Blocked users. Repeated violations can cost you access to chat or to your account." },
      { h: "8. Other players' slips", b: "Pro members can view other players' bet slips and win rates. This is user-generated content, shown as a matter of record: ArakIce does not verify, endorse, rank or recommend any player, and no member is acting on our behalf or as an adviser. Win rates are computed only from settled slips within the stated period, and past results never guarantee future results. Following another player's picks is your decision alone, and section 3 applies to it in full." },
      { h: "9. Your own slips", b: "Slips you place after this feature went live are visible to Pro members once the first game starts; picks stay hidden until then. You can hide all of your slips at any time in Settings → Privacy, without affecting your leaderboard rank. See the Privacy Policy for details. Placing a slip is not an offer of advice to anyone and creates no obligation toward other members." },
      { h: "10. Changes", b: "We may update these terms from time to time. Continued use of the app after changes means you accept the updated terms." },
      { h: "11. Contact", b: `Questions about these terms can be sent to ${env.supportEmail}.` },
    ],
  },
  fr: {
    updated: "Dernière mise à jour : 9 octobre 2026",
    sections: [
      { h: "1. Acceptation des conditions", b: "En créant un compte ou en utilisant ArakIce, vous acceptez ces conditions d'utilisation. Si vous n'êtes pas d'accord, merci de ne pas utiliser l'application." },
      { h: "2. Ce qu'est ArakIce", b: "ArakIce fournit des prédictions de la LNH basées sur des statistiques et un modèle d'apprentissage automatique, à titre informatif et de divertissement uniquement. Nous ne sommes pas un bookmaker et n'acceptons ni ne traitons aucun pari. ArakIce n'est ni affiliée à la Ligue nationale de hockey (LNH) ou à l'une de ses équipes, ni approuvée ou commanditée par elles ; LNH et les noms d'équipes sont des marques de leurs propriétaires respectifs, utilisées seulement pour désigner les matchs dont il est question." },
      { h: "3. Aucun conseil de pari", b: "Les prédictions et probabilités affichées sont des estimations, pas des garanties. ArakIce ne garantit l'exactitude d'aucune prédiction et n'est pas responsable des pertes résultant de décisions prises à partir de l'application." },
      { h: "4. Admissibilité", b: "Vous devez avoir 18 ans ou plus (ou l'âge légal dans votre juridiction) pour créer un compte. Certaines juridictions peuvent restreindre l'accès à du contenu lié aux paris sportifs — vous êtes responsable du respect des lois locales." },
      { h: "5. Compte et abonnements", b: "Vous êtes responsable de la sécurité de vos identifiants de connexion. Les abonnements ArakIce Pro se renouvellent automatiquement jusqu'à annulation depuis les paramètres de votre compte. Vous pouvez supprimer votre compte à tout moment dans Paramètres → Sécurité ; la suppression est immédiate et définitive, et annule sur-le-champ un abonnement actif. Voir la politique de confidentialité pour ce qui est effacé." },
      { h: "6. Utilisation acceptable", b: "Vous vous engagez à ne pas détourner le service : pas d'extraction automatisée (scraping), d'ingénierie inverse, d'automatisation abusive, ni de harcèlement d'autres utilisateurs dans les salons de chat/ligues." },
      { h: "7. Règles de la communauté (chat)", b: "Les salons sont des espaces partagés. On n'y publie pas de harcèlement ni de menaces, pas de discours haineux ni d'insultes visant qui que ce soit, pas de contenu sexuel, pas de pourriel ni d'arnaque, et pas d'informations privées sur autrui. Un filtre refuse certains messages à l'envoi : un message refusé n'est jamais publié, et on vous dit pourquoi pour que vous puissiez le reformuler. Chaque message porte un bouton Signaler et une option Bloquer. Signaler envoie le message dans une file de modération que nous lisons ; un message signalé par plusieurs personnes différentes est masqué automatiquement en attendant. Bloquer quelqu'un cache ses messages pour vous et les vôtres pour lui, dans les deux sens, et se défait à tout moment dans Paramètres → Utilisateurs bloqués. Des manquements répétés peuvent vous coûter l'accès au chat ou à votre compte." },
      { h: "8. Paris des autres joueurs", b: "Les membres Pro peuvent consulter les paris et les taux de réussite d'autres joueurs. Il s'agit de contenu produit par les utilisateurs, présenté à titre de constat : ArakIce ne vérifie, n'endosse, ne classe ni ne recommande aucun joueur, et aucun membre n'agit pour notre compte ni à titre de conseiller. Les taux de réussite sont calculés uniquement sur les paris réglés de la période indiquée, et les résultats passés ne garantissent jamais les résultats futurs. Suivre les sélections d'un autre joueur relève de votre seule décision, et la section 3 s'y applique intégralement." },
      { h: "9. Vos propres paris", b: "Les paris que vous déposez après la mise en service de cette fonction sont visibles aux membres Pro dès le début du premier match ; les sélections restent cachées jusque-là. Vous pouvez masquer tous vos paris à tout moment dans Paramètres → Confidentialité, sans que votre rang au classement en soit affecté. Voir la politique de confidentialité pour le détail. Déposer un pari ne constitue un conseil pour personne et ne crée aucune obligation envers les autres membres." },
      { h: "10. Modifications", b: "Nous pouvons mettre à jour ces conditions de temps à autre. Continuer à utiliser l'application après des modifications signifie que vous acceptez les nouvelles conditions." },
      { h: "11. Contact", b: `Pour toute question sur ces conditions, écrivez-nous à ${env.supportEmail}.` },
    ],
  },
};

export function TermsPage() {
  const { t, lang } = useI18n();
  return <LegalDocument title={t("legal.terms")} content={CONTENT[lang]} />;
}
