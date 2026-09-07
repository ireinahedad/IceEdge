# Banc jetable — `client/src/app/services/http.ts`

⚠️ **RIEN ne lance ce banc.** `client/` n'a aucun runner de test et n'en aura
pas avant le gel (décision reportée, cf. `iceedge-banc-essai-client`). Ce
dossier n'est pas dans le dépôt à des fins de CI : il est là pour que la
prochaine personne puisse rejouer la preuve en trois commandes au lieu de la
réécrire.

## Rejouer

Depuis un `client/` avec un `node_modules` **Linux** (le `node_modules` du
poste est installé pour Windows — cf. la recette du conteneur cloud) :

```
npx esbuild src/app/services/http.ts --bundle --format=esm --platform=neutral \
    --outfile=/tmp/bench/http.mjs
cp .claude-tmp/banc-http/run.mjs /tmp/bench/
node /tmp/bench/run.mjs
```

Pas de Playwright ici, contrairement aux bancs du chat et du coupon :
`http.ts` ne touche ni au DOM ni au stockage. Node 22 suffit — il a
`AbortController` et un `fetch` global qu'on remplace par une doublure qui
honore le signal qu'on lui passe.

## Ce que les 16 assertions prouvent

- le défaut est bien 15 000 ms ;
- une requête qui ne répond jamais est abandonnée **au** délai (mesuré), avec
  une `RequestTimeoutError` qui porte le budget ;
- `timeoutMs` ne fuit pas dans le `RequestInit` passé à `fetch` ;
- une requête rapide passe, et le minuteur est **désarmé** — rien ne vient
  abandonner la réponse après coup ;
- l'abandon de l'appelant reste un `AbortError` et **pas** un délai dépassé
  (sinon quitter une page ferait clignoter un message d'erreur) ;
- un signal déjà abandonné rejette tout de suite ;
- `timeoutMs: 0` désarme le délai et relaie le signal de l'appelant tel quel ;
- une vraie erreur réseau remonte **inchangée**, pas déguisée en délai ;
- l'écouteur d'abandon posé sur le signal de l'appelant est retiré (pas de fuite).

## Ce qu'il ne prouve PAS

Le délai couvre l'attente des **en-têtes**, pas la lecture du corps : le
minuteur est désarmé dès que `fetch` rend la main. C'est écrit dans l'en-tête
de `http.ts` et c'est assumé — les corps servis ici sont du JSON court, lu
immédiatement.
