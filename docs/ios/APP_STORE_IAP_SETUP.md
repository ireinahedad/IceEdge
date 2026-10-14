# Abonnement Pro sur iOS — mise en place (APPLE_PLAN Phase 5)

**Créé :** 2026-10-11. Le code est fait (StoreKit 2 direct, sans RevenueCat). Ce qui reste
se fait à la main, dans cet ordre. Sans les étapes 2 et 3, l'écran /pro sur iPhone affiche
« Les abonnements ne sont pas encore disponibles sur l'App Store » (StoreKit répond, mais sans produit — ce n'est pas le réseau ; le message « Vérifiez votre connexion » est réservé aux vraies erreurs, avec le détail d'Apple dessous) et la review échoue.

## Ce que fait le code

| Où | Quoi |
|---|---|
| `client/ios/App/App/StoreKitPlugin.swift` | achat (avec `appAccountToken` = user_id), restauration, transactions en attente, feuille « Gérer l'abonnement » |
| `client/src/app/services/appleIap.ts` | envoie chaque transaction signée au serveur, puis la « finit » chez Apple |
| `client/src/app/components/AppleProSection.tsx` | écran d'achat iOS : prix de la boutique, essai, Restaurer, mentions légales |
| `server/src/services/appleJws.ts` | vérifie la signature Apple (chaîne x5c jusqu'à Apple Root CA - G3 épinglée) |
| `server/src/services/appleIap.service.ts` | `POST /api/subscription/apple/verify` + notifications App Store V2 |
| `server/src/db/migrations/045_apple_iap.sql` | colonnes `source`, `apple_*` ; table `apple_notifications` |

Un abonné web est Pro sur iPhone et inversement. Sur iOS : pas d'essai web sans carte, pas de
code promo, pas de Stripe (Guideline 3.1.1).

## 1. Contrats, banque, fiscalité, Small Business Program — faits

## 2. Groupe d'abonnement et produits

App Store Connect → ton app → **Monetization → Subscriptions** → créer le groupe
**`ArakIce Pro`**, puis deux abonnements dans ce groupe (même groupe = on passe de l'un à
l'autre sans double facturation) :

| Reference Name | Product ID (exactement) | Durée | Prix (Canada) |
|---|---|---|---|
| Pro mensuel | `com.arakice.arakice.pro.monthly` | 1 mois | 5,99 $ CAD |
| Pro annuel | `com.arakice.arakice.pro.yearly` | 1 an | 59,99 $ CAD |

Les Product IDs sont écrits dans le code (`APPLE_PRODUCT_IDS` côté client,
`DEFAULT_APPLE_PRODUCT_IDS` côté serveur). Un ID différent ici = produit introuvable.
Un ID ne peut jamais être réutilisé, même après suppression : vérifier avant d'enregistrer.

Pour chaque produit :
- **Price** : choisir le Canada comme pays de référence → 5,99 $ / 59,99 $, laisser Apple
  calculer les autres pays ;
- **Localizations** : français (Canada) et anglais (Canada ou États-Unis). Nom affiché :
  « ArakIce Pro — mensuel » / « ArakIce Pro — annuel » ; description : « Best Bets, value
  bets, alertes et analyses IA » ;
- **Review Information** : une capture et une note
  (« Unlocks Pro features: daily best bets, value bets, alerts, AI analysis. »).
  Taille acceptée : **640 × 920 px, JPEG ou PNG sans transparence** (les captures
  iPhone brutes et les carrés sont refusés : « dimensions incorrectes »).

  > ⚠️ **À REFAIRE avant la soumission.** La capture envoyée le 2026-10-11
  > (`docs/ios/iap-review-screenshot-TEMP-640x920.jpg`) est PROVISOIRE : c'est l'accueil
  > du site web, pas l'écran d'achat. Une fois le build TestFlight installé, capturer
  > l'écran /pro de l'app (prix Apple, « 7 jours gratuits, puis… », Restaurer), la
  > ramener en 640 × 920, et la remplacer sur **les deux** produits.

Groupe → **Subscription Group Localizations** : nom du groupe « ArakIce Pro » en FR et EN.

## 3. Essai gratuit de 7 jours

Pour CHAQUE produit → **Subscription Prices → Introductory Offers → +** :
- tous les pays, début immédiat, sans date de fin ;
- type **Free**, durée **1 week**.

Apple n'offre l'essai qu'une fois par groupe et par identifiant Apple ; l'app lit
`isEligibleForIntroOffer` et n'annonce l'essai qu'à qui y a droit.

## 4. Notifications serveur (renouvellements, annulations, remboursements)

App Store Connect → ton app → **App Information → App Store Server Notifications** :
- **Production Server URL** : `https://api.arakice.com/api/subscription/apple/notifications`
- **Sandbox Server URL** : la même
- **Version** : **Version 2**

Puis bouton **Request a Test Notification** (ou attendre le premier achat Sandbox) : Railway
doit journaliser `[apple-iap] notification sans transaction à appliquer` avec `type: TEST`.

## 5. Serveur (Railway)

- Lancer la migration **045** sur Neon (`npm run db:migrate:all`), AVANT de déployer le
  serveur : `getStatus` lit la colonne `source`.
- Variables (toutes facultatives, les défauts conviennent) : `APPLE_BUNDLE_ID`
  (`com.arakice.arakice`), `APPLE_PRODUCT_IDS`, `APPLE_IAP_ALLOW_SANDBOX` (laisser `true` :
  TestFlight ET la review d'Apple achètent en Sandbox).
- Aucune clé à fournir : la vérification n'appelle pas Apple, elle contrôle la signature.

## 6. App ID et build

- Rien à ajouter dans les entitlements : In-App Purchase est actif par défaut sur l'App ID
  (developer.apple.com → Identifiers → `com.arakice.arakice` → la case est cochée).
- Lancer le workflow iOS : `StoreKitPlugin.swift` est déjà dans le projet Xcode.

## 7. Tester sur l'iPhone (TestFlight = Sandbox)

1. App Store Connect → **Users and Access → Sandbox → Test Accounts** → créer un compte
   Sandbox (adresse courriel qui n'est PAS un identifiant Apple existant).
2. Sur l'iPhone : **Réglages → App Store → Compte Sandbox** → se connecter avec ce compte.
3. Installer le build TestFlight, se connecter à ArakIce avec un compte **gratuit**.
4. Vérifier, dans l'ordre :
   - /pro affiche 5,99 $ et 59,99 $, et « 7 jours gratuits, puis… » ;
   - acheter le mensuel → écran « Bienvenue dans ArakIce Pro », Pro actif partout ;
   - Railway : `[apple-iap] notification appliquée` (type `SUBSCRIBED`) ;
   - en Sandbox un mois dure **5 minutes** : attendre, l'abonnement se renouvelle seul
     (`DID_RENEW`), jusqu'à 12 fois ;
   - Réglages → Abonnements → annuler → /pro affiche « Votre accès Pro se termine le… »,
     puis Pro s'arrête à l'échéance (`EXPIRED`) ;
   - supprimer l'app, la réinstaller, se connecter, **Restaurer les achats** → Pro revient ;
   - se connecter avec un AUTRE compte ArakIce sur le même iPhone et toucher Restaurer →
     message « déjà lié à un autre compte » (attendu) ;
   - un compte Pro payé par Stripe sur le web est Pro sur l'iPhone, sans bouton d'achat.

## 8. Compte démo pour la review

Le compte `review@arakice.com` doit être **gratuit** : le reviewer doit pouvoir voir et tester
l'achat (en Sandbox, il ne paie rien). Le dire dans les notes (fait dans `APP_REVIEW_NOTES.md`).

## Limites connues

- Quelqu'un qui paie à la fois par Stripe ET par Apple : si l'abonnement qui donne le Pro en
  cours expire, le Pro s'arrête jusqu'au prochain événement de l'autre (au pire un cycle de
  facturation). L'app empêche ce cas : l'écran d'achat iOS ne s'affiche pas à un compte déjà Pro.
- Pas de vérification OCSP en ligne des certificats Apple (la librairie officielle la rend
  aussi optionnelle).
- Pas d'offres promotionnelles ni de codes d'offre Apple (possibles plus tard, sans changer
  le serveur).
