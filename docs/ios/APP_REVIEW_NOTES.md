# App Store Connect — notes pour l'équipe de review (APPLE_PLAN 4.7 / 9.4)

**Créé :** 2026-10-11 · Concerne le **build iOS v1** (Pro par achat intégré uniquement, pas de
liens bookmakers, pas de Google Sign-In). À coller dans App Store Connect → version → **App Review Information → Notes**
(limite 4000 caractères ; le bloc ci-dessous en fait environ 3500).

Avant de coller :
- ⚠️ remplacer la capture de review **provisoire** des deux abonnements par une capture de
  l'écran d'achat de l'app, en 640 × 920 (voir `APP_STORE_IAP_SETUP.md` §2) ;
- remplacer `<PASSWORD>` par le mot de passe du compte démo ;
- le compte démo doit avoir **2 ou 3 paris en attente sur des matchs du soir** au moment de la
  soumission : c'est ce qui remplit le widget et déclenche la notification « pari réglé » ;
- le compte démo est **gratuit** : le reviewer doit pouvoir tester l'achat (en Sandbox, il ne paie rien) ;
- les deux abonnements doivent être « Ready to Submit » et **joints à cette version**
  (section « In-App Purchases and Subscriptions » de la page de version), sinon rejet 2.1 ;
- si une fonction ci-dessous est retirée du build, la retirer aussi d'ici.

---

```text
ArakIce is a hockey analytics and prediction app. It does not accept wagers, hold or transfer money, process any gambling transaction, or link to any sportsbook or gambling operator. Probabilities, model predictions and the pick tracker are informational and for entertainment; no real money is used anywhere in the app. The app is rated 18+.

IN-APP PURCHASE (Guideline 3.1.1)
ArakIce Pro is an auto-renewable subscription sold only through In-App Purchase in the iOS app: com.arakice.arakice.pro.monthly and com.arakice.arakice.pro.yearly, with a 7-day free trial for new subscribers. To test: sign in with the demo account (a free account), open Profile > Settings > "Get ArakIce Pro" or any locked Pro section, and subscribe with your Sandbox account. "Restore purchases" is on the same screen. There is no other way to unlock Pro in the iOS app: no web checkout, no link to one, and no promo codes. Members who already subscribed on our website keep their access when they sign in, as allowed by 3.1.3(b).

DEMO ACCOUNT
Email: review@arakice.com
Password: <PASSWORD>
This is a free account, so you can test the subscription. It already has a few pending picks on tonight's games, so the widget and notifications have something to show.

WHY THIS IS NOT A WRAPPED WEBSITE (Guideline 4.2)
The app is built on native iOS features that a website cannot provide:

1. Push notifications (APNs). When a game ends, the user is notified that their pick was settled (won or lost), in the language they use in the app. Tapping the notification opens the pick directly. Users turn this on or off in Profile > Settings > "My bet results". To test: sign in with the demo account, allow notifications, and a notification arrives when tonight's games finish.

2. Home Screen widget (WidgetKit, SwiftUI, small / medium / large). It shows the user's pending picks with their current win probability, refreshed through the day. To test: sign in once in the app, then long-press the Home Screen > Edit > Add Widget > ArakIce.

3. Universal Links. Links to arakice.com (a team's stats page, a player's picks, the schedule) open the matching screen in the app instead of Safari. To test: open https://arakice.com/schedule from Notes or Messages.

4. Native share sheet. A pick can be exported as an image card and shared with the iOS share sheet (Messages, Photos, Instagram, etc.). To test: Slip tab > My Slips > Share on any pick.

The session is stored in the iOS Keychain, and the app is written for iPhone screen sizes and safe areas rather than reusing desktop layouts.

USER-GENERATED CONTENT (Guideline 1.2)
Community members can chat and see each other's picks. Every message has a menu with "Report" and "Block user"; blocking takes effect immediately. Users can also be blocked from their profile card. Chat messages go through an automatic filter, and reports are reviewed by the developer.

ACCOUNT DELETION (Guideline 5.1.1(v))
Profile > Settings > "Delete my account". Deletion is immediate and removes the account, profile, picks, messages and registered devices. If the account has an App Store subscription, the deletion screen tells the user to cancel it in iPhone Settings first, since we cannot cancel it on their behalf.

SIGN-IN
Email and password only. There is no third-party or social login in the iOS app.

ArakIce is independent and is not affiliated with or endorsed by the National Hockey League or any team.
