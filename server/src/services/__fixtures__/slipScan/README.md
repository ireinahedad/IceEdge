# Fixtures « Scanner un ticket » (SCAN_TICKET_PLAN § 7, S0)

Objectif : **40-60 vraies captures**, bet365 et DraftKings (~moitié chacun),
**anglais et français (~moitié chacun, D5)**, thème sombre et clair, simples,
parlays, SGP / « Same Game Parlay » / « Pari personnalisé », props.

```
images/<nom>.png|jpg        la capture brute            → NON versionnée (.gitignore)
expected/<nom>.json         la vérité attendue          → versionnée (format : fixture.ts, SlipScanExpected)
ocr/tesseract/<nom>.json    sortie Tesseract figée       → versionnée (format : ocrTypes.ts, OcrResult)
ocr/vision/<nom>.json       sortie Apple Vision figée    → versionnée
```

## Nom

`<bookmaker>-<langue>-<thème>-<nnn>` : `bet365-fr-dark-001`, `draftkings-en-light-007`.

## Ajouter une capture

1. Déposer la capture **telle quelle** (pas recadrée, pas recompressée — idéalement
   le PNG de l'iPhone) dans `images/`.
2. Copier `expected/bet365-fr-dark-001.json`, le renommer, le remplir :
   - un **groupe** = ce qui porte UNE cote : une jambe simple (`single`), ou un SGP /
     « Pari personnalisé » (`sgp`) dont la cote couvre plusieurs jambes ;
   - `ticketText` = les lignes de la jambe **exactement comme affichées** (sert à noter l'OCR) ;
   - `intent` = ce que la jambe doit devenir (abréviations NHL, nom NHL.com du joueur) ;
   - `state` = `unsupported_market` / `unsupported_line` pour un marché ou une ligne
     qu'ICEEDGE ne couvre pas (§ 3.6) ;
   - `personal` = les textes à ne **jamais** garder (mise, gains, solde, n° de pari, heure du pari).
3. `cd client && npm run ocr:bench` → écrit `ocr/tesseract/<nom>.json` et note la lecture.
4. Vision (iOS) : dans un build TestFlight lancé avec la case `ocr_lab`, Réglages →
   **Labo OCR** → choisir les captures → « Partager le JSON » ; ranger chaque entrée
   `{ nom: lecture }` dans `ocr/vision/<nom>.json`. Sur un Mac :
   `swift client/scripts/ocr-bench/vision-ocr.swift` (voir `client/scripts/ocr-bench/README.md`).
5. `cd server && npx vitest run slipScanFixtures` vérifie la forme.

## Vie privée

Les captures restent hors de git. Les sorties OCR contiennent encore la mise et les
gains (c'est ce que le nettoyage de S2 doit apprendre à jeter) : n'y mettre que tes
propres tickets.
