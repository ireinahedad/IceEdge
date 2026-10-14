/**
 * platform.ts — PRE_IOS_PLAN.md R2. The one seam between the web build and the
 * iOS build.
 *
 * The target is decided at BUILD time, not at runtime: `VITE_TARGET=ios npm run
 * build` produces the iOS bundle, everything else produces the web bundle. Vite
 * replaces `import.meta.env.VITE_TARGET` with a string literal, so `isWeb` and
 * `isIOS` fold to constants and Rollup deletes the disabled branches from the
 * bundle instead of shipping dead UI behind a runtime `if`.
 *
 * Deliberately NOT importing @capacitor/core: this file stays dependency-free
 * until Phase 3 of APPLE_PLAN.md, so R2 is a pure web change.
 *
 * ── The rule that keeps this honest ─────────────────────────────────────────
 * platform.ts may only be imported by UI components, services and route config.
 * NEVER by prediction maths, API parsing, or anything in `types/`. The day a
 * feature flag reaches the model layer, web and iOS have genuinely forked and
 * the benefit of one codebase is gone.
 *
 * ── Why this reads import.meta.env directly ─────────────────────────────────
 * env.ts (R7) is the single validated entry point for every VITE_* *URL*, and
 * the rule in .env.example points there. This is the one deliberate exception:
 * VITE_TARGET is not configuration to validate, it is the build target itself,
 * and routing it through an object property in env.ts would defeat the constant
 * folding that makes the disabled branches disappear. There is no fallback to
 * get wrong here — anything that is not the literal 'ios' is the web build.
 */

/** Build-time target. 'web' unless the iOS build script sets VITE_TARGET=ios. */
const TARGET: 'web' | 'ios' = import.meta.env.VITE_TARGET === 'ios' ? 'ios' : 'web';

const isWeb = TARGET === 'web';

/**
 * R10 (2026-10-09) — bookmaker buttons (« Place on … », odds tap-through, sportsbook
 * picker) are OFF on the web too until there is an affiliate deal. Turn them back on
 * with VITE_BOOKMAKER_LINKS=true (Vercel env + redeploy). Never on iOS, whatever the
 * variable says (APPLE_PLAN §4).
 */
export const bookmakerLinksOn = isWeb && import.meta.env.VITE_BOOKMAKER_LINKS === 'true';
export const isIOS = TARGET === 'ios';

/** The single place where web and iOS are allowed to differ. */
export const features = {
  /** R2 — Guideline 4.8: no third-party login on iOS, so no Sign in with Apple requirement. */
  googleLogin:    isWeb,
  /** APPLE_PLAN §4 — Guideline 5.3: no links out to a sportsbook. Odds stay, the links go. */
  bookmakerLinks: bookmakerLinksOn,
  /** APPLE_PLAN §7 — Guideline 3.1.1: payment on iOS must go through IAP, not Stripe. */
  stripeCheckout: isWeb,
  /**
   * Guideline 3.1.1 — does this build have ANY path to Pro at all?
   *
   * Distinct from `stripeCheckout`, which only says *how* one pays. Since
   * APPLE_PLAN Phase 5 (2026-10-11) both builds have a path: Stripe on the web,
   * In-App Purchase on iOS (`appleIap`). Every « Passer à Pro » button, the
   * /pro route and the ProLock call to action key off this flag.
   */
  proUpgrade:     true,
  /** APPLE_PLAN Phase 5 — Guideline 3.1.1: Pro on iOS is bought with StoreKit 2. */
  appleIap:       isIOS,
  /**
   * 3.1.1 — on iOS, paid content may only be unlocked through In-App Purchase.
   * The web's card-free 7-day trial and the promo-code field would both unlock
   * Pro outside the App Store; on iOS the trial is Apple's introductory offer
   * instead (configured on the product in App Store Connect).
   */
  serverTrial:    isWeb,
  promoCodes:     isWeb,
  /** APPLE_PLAN R8 — 3.1.1 grey zone: bring-your-own OpenAI key. */
  byokOpenAI:     isWeb,
  /** R6 — iOS uses APNs, not the Web Push API. */
  webPush:        isWeb,
  /** APPLE_PLAN 4.1 — native notifications (APNs) on iOS. */
  nativePush:     !isWeb,
  /** R6 — no service worker in WKWebView. */
  serviceWorker:  isWeb,
  /** R9 / APPLE_PLAN §4 — links to the static SEO pages, which the iOS bundle does not ship. */
  seoLinks:       isWeb,
  /** R17 — hide /dev/ml on iOS. */
  devRoutes:      isWeb,
  /**
   * « Bet builder IA » (SlipCommandSheet) — masqué partout tant qu'il n'est pas
   * prêt (décision du user, 2026-10-05). Le remettre = passer à `true` : le
   * lanceur, la carte des Réglages et les tiroirs reviennent d'un coup.
   */
  aiBetBuilder:   false,
  /**
   * SCAN_TICKET_PLAN S1 — « Labo OCR » (/dev/ocr), admin uniquement. Toujours sur
   * le web ; sur iOS seulement dans un build de TEST (VITE_OCR_LAB=true, case
   * « ocr_lab » du workflow TestFlight) pour mesurer Apple Vision sur l'iPhone.
   * Un build iOS qui l'a ne doit pas partir en review (écran caché, 2.3.1).
   * Deuxième lecture directe de import.meta.env ici, pour la même raison que
   * VITE_TARGET : la constante doit se replier pour que le chunk disparaisse.
   */
  ocrLab:         isWeb || import.meta.env.VITE_OCR_LAB === 'true',
} as const;
