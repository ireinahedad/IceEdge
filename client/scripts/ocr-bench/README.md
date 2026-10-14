# Banc OCR (SCAN_TICKET_PLAN § 7, S1)

Mesure les deux moteurs sur les fixtures `server/src/services/__fixtures__/slipScan/`.

| Moteur | Où il tourne en vrai | Comment le banc le lance |
|---|---|---|
| Tesseract.js (web) | navigateur, `services/ocr/tesseractOcr.ts` | `npm run ocr:bench` (Node, même `ocrCore.ts`) |
| Apple Vision (iOS) | `ios/App/App/VisionOcrPlugin.swift` | `swift client/scripts/ocr-bench/vision-ocr.swift` sur un Mac, depuis la racine |

```
cd client
npm run ocr:bench                     # Tesseract → ocr/tesseract/*.json + note de tous les moteurs
npm run ocr:bench -- --dump           # affiche aussi les lignes lues
npm run ocr:bench -- --psm 3          # autre segmentation (défaut 11 = SPARSE_TEXT)
npm run ocr:bench -- --raw            # sans prétraitement : ce qu'apporte ocrCore.preprocessRgba
npm run ocr:bench -- --score-only     # note les JSON existants (ex. après vision-ocr.swift)
```

Note : `lignes` = lignes de jambe retrouvées, `cotes` = cotes lues **à l'identique**,
`perso lus` = textes personnels présents dans la lecture (S2 doit les jeter).

Node ≥ 22.18 requis (il importe `ocrCore.ts` directement).
