# Banc d'essai du hook de chat

Ce dossier teste **le vrai `client/src/app/hooks/useChatSocket.ts`** — pas une
copie — en remplaçant ses quatre bords par des doublures et en le rendant dans
Chromium.

Il existe parce que **`client/` n'a aucun runner de tests** et que la logique de
reprise du socket (resynchronisation, refresh du handshake, fusion
d'historique) est trop subtile pour tenir sur une relecture. Décision du
2026-09-05 : le banc est versé au dépôt sans ajouter de runner ; la question
d'un vrai `vitest` côté client reste ouverte, à trancher après le gel iOS.

⚠️ **Rien ne le lance tout seul.** Il ne tourne pas en CI et il ne cassera pas
quand le hook changera — c'est à relancer à la main après toute modification de
`useChatSocket.ts`.

## Le lancer

Il tourne **dans le conteneur cloud**, pas sur le poste Windows : il lui faut un
`node_modules` installé pour Linux et le Chromium de Playwright.

1. Monter une copie de `client/` avec ses dépendances (la recette du tarball est
   dans `PRE_IOS_PLAN.md`), par exemple dans `/tmp/cli`, puis `npm ci`.
2. `npm i playwright` dans un dossier quelconque, par exemple `/tmp/mesure`.
   **Ne PAS lancer `playwright install`** : le binaire est déjà dans le
   conteneur, à `/opt/pw-browsers/chromium`.
3. Depuis ce dossier :

   ```sh
   CLIENT=/tmp/cli node build.mjs
   PW=/tmp/mesure node run.mjs
   ```

Variables : `CLIENT` (copie de client/ avec node_modules), `PW` (dossier où
playwright est installé), `CHROME` (binaire, par défaut
`/opt/pw-browsers/chromium`).

## Les deux pièges de construction

- L'option `alias` d'esbuild **refuse les chemins relatifs** : c'est pour ça que
  `build.mjs` passe par un plugin `onResolve`.
- Sans `jsx: 'automatic'`, la page meurt sur « React is not defined ».

## Ce qui est couvert — 19 assertions

Première connexion sans resynchro · reconnexion qui resynchronise · retour au
premier plan qui resynchronise et relance une socket morte · onglet caché qui ne
déclenche rien · erreur réseau sans refresh · jeton expiré avec exactement un
refresh · second refus sans refresh de plus et bandeau levé · `connect` réussi
qui réarme et efface · `room_error` remonté · fusion qui garde le message
optimiste, dédoublonne et trie · changement de salon qui remet le compteur à
zéro.

## Ce qui n'est PAS couvert

Le vrai socket.io, le vrai serveur, le vrai `RoomChat` (l'effet d'historique et
le bandeau ne sont testés par personne), et le comportement réel d'iOS au réveil.
