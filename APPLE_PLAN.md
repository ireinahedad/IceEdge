# APPLE_PLAN.md — Shipping IceEdge / Arakice to the Apple App Store

**Owner:** Ireina · **Created:** 2026-09-03 · **Status:** started — gate closed, web frozen at `pre-ios-freeze` (2026-10-07) · Phase 0 in progress

> **Status 2026-09-24.** The web-side risks of §-1 are handled: R2 (no Google on iOS), R3
> (server native token path), R4 (moderation), R5/B3 (no Stripe and no Pro on iOS v1), R6
> (SW/web push flagged off), R7 (env), R13 (safe areas), R17 (dev routes). Still open for
> Phase 3: native `tokenStore`, R9 (`build:ios` without SEO pages), R10 (site framing),
> R11/R12 (share on device), R14/R15 (`100dvh` + keyboard), R16 (CSP meta), B4 (in-app
> account deletion — server route exists, no UI). Live checklist: **`STATUS.md` §3.4**.
**Target:** iOS app live on the App Store (iPhone first, iPad later)

---

## ⛔ Gate — finish the web app first

**Nothing in this plan starts until you say the web app is done.**

Wrapping a moving target is how this turns miserable: every web change after Phase 3 has to
be re-tested inside a WebView, re-built on cloud CI, and pushed through TestFlight again.
Finish what you want to finish on arakice.com, then freeze.

**Freeze checklist — tick all four before Phase 0:**

- [x] **G1** Feature work on the web app is done. `STATUS.md` has nothing left that
      would change screens, routes, or the data shape the client consumes.
- [x] **G2** `npm run typecheck` and the CI in `.github/workflows/ci.yml` are green.
- [x] **G3** The production API is stable — no endpoint renames planned.
- [x] **G4** Tag the freeze point: `git tag pre-ios-freeze && git push --tags`.
      Everything after this is either an iOS change or a deliberate exception.

After the freeze, web changes still happen — but they ship as **shared** changes tested on
both, not as "just a quick web tweak". Budget for that.

---

## §-1. Pre-flight audit — what will actually break (2026-09-03)

I read the real code, not the plan. **17 risks**, ordered by what hurts most. Every one
names the file. Nothing here is hypothetical — each was confirmed by grep in `client/` or
`server/`.

**None of these break the web app.** Everything below is either "breaks on iOS" or "Apple
rejects it". The web keeps working exactly as it does today.

### 🔴 Critical — will break or get rejected

**R1 · Google OAuth does not work inside a WebView**
`client/src/app/pages/LoginPage.tsx:153` does `window.location.href = getGoogleLoginUrl()`.
Two failures at once: (a) Google **blocks OAuth in embedded WebViews**
(`disallowed_useragent`), so the flow dies; (b) even if it worked, the redirect navigates
the WKWebView to `arakice.com` and your native app is now just… the website, with no way back.
→ **Fix:** open the OAuth URL in `ASWebAuthenticationSession` (`@capacitor/browser`), have
the server redirect to a **custom scheme** (`com.arakice.iceedge://auth/callback`), catch it
with `@capacitor/app`'s `appUrlOpen` listener. Server change required: a second, native
redirect URI. *Effort: 1–2 days.*

**R2 · Sign in with Apple is now mandatory — the plan said otherwise**
Because you offer Google login, Guideline **4.8** requires an equivalent privacy-preserving
login option. Sign in with Apple must be offered **at least as prominently**. This is a hard
rejection, not a warning. Needs: the capability on the App ID, a Services ID, a `.p8` key,
server-side Apple token verification, and handling Apple's **private relay email** plus the
fact that Apple returns the user's name **only on first authorization** — miss it and you
never get it again.
→ Alternative that avoids all of it: **drop Google login from the iOS build** and keep
email/password there. Cheap, ugly, legal. Decide before Phase 3. *Effort: 3–4 days, or 1 hour
for the drop.*

**R3 · The refresh-token cookie will be blocked → users logged out every 15 minutes**
`server/src/routes/auth.routes.ts:27` sets the refresh cookie `SameSite=None; Secure`, and
`authService.ts` refreshes with `credentials: 'include'`. From a `capacitor://localhost`
origin that is a **cross-site cookie**, and WKWebView's tracking prevention drops it. The
access token lives 15 minutes; after that, silent logout, forever.
→ **Fix:** on native, return the refresh token in the **response body** and store it in
`@capacitor/preferences` (Keychain-backed). Keep the cookie path for web, unchanged.
*Effort: 1 day. Do not skip — this is the bug that makes the app feel broken.*

**R4 · Chat has zero moderation → Guideline 1.2 (blocker B5)**
`server/src/routes/chat.routes.ts` has rooms, messages, reactions, kick and delete — and
**no report endpoint, no user block, no profanity filter**. Grep for `report|block|mute|
moderat|profanity` across `pages/league/chat/` returns nothing. Apple requires all four for
UGC apps, and reviewers test it by trying to report a message.
→ **Fix:** report button on every message → `POST /chat/messages/:id/report`; block-user
(hide their messages client-side + server-side filter); a profanity filter on
`POST /rooms/:roomId/messages`; a moderation inbox you actually read; published contact
email. *Effort: 3–5 days. This is the biggest thing the original plan missed.*

**R5 · Stripe navigates the WebView away**
`ProPage.tsx:64` — `window.location.href = result.url`. On iOS that leaves the app inside
Stripe Checkout with no back affordance, **and** it is a straight 3.1.1 violation.
→ **Fix:** `features.stripeCheckout` false on native; render the StoreKit paywall instead.
Never fall back to opening Stripe in `@capacitor/browser` "just for iOS" — that is exactly
the pattern Apple rejects.

### 🟠 High — silent failure or serious review risk

**R6 · Web Push is dead on iOS, and the service worker is registered unconditionally**
`client/src/main.tsx:21` calls `navigator.serviceWorker.register("/sw.js")` on every boot;
`pushService.ts` uses VAPID (`server/src/routes/push.routes.ts`). None of it functions in a
WKWebView, and a stale SW will happily serve you last week's JS.
→ **Fix:** guard both behind `!isNative`; implement APNs via `@capacitor/push-notifications`
with a `device_tokens` table. Note this is also your strongest **4.2** argument, so it is not
optional work.

**R7 · Four env vars fall back to `http://localhost` — ATS will kill them silently**
`VITE_NHL_API_URL`, `VITE_PREDICTION_API_URL`, `VITE_PROFILE_API_URL` (fallback
`http://localhost:3001`), `VITE_SOCKET_URL` (same). iOS App Transport Security blocks
cleartext HTTP outright. If a CI build ships without one of these, the app installs, opens,
and shows an empty screen with no error.
→ **Fix:** a build-time assertion that every `VITE_*_URL` is set and starts with `https://`
in the iOS build. Fail the CI job, not the user's phone.

**R8 · Users paste their own OpenAI key (BYOK) — 3.1.1 grey zone**
`server/src/routes/llm.routes.ts:151` reads `user_profiles.openai_api_key`;
`SettingsTab.tsx:368` links users to `platform.openai.com/api-keys`. Free users unlock the
LLM feature with their own key. Guideline 3.1.1 forbids "unlocking content or functionality"
via "license keys" and similar. Reviewers are inconsistent here; some BYOK apps ship, some
get rejected. It also drags in AI-content moderation and age-rating questions.
→ **Recommendation:** hide the BYOK field on iOS (`features.byokOpenAI = isWeb`) and give
free iOS users a small server-side quota instead. Cleaner paywall, one less argument to have.

**R9 · Your betting-flavoured SEO pages ship inside the iOS binary**
`npm run build` runs `route-shells.mjs`, and `client/public/*.html` is copied wholesale, so
`dist/` contains 14 HTML files including **`best-nhl-betting-software.html`** and
`best-nhl-picks-today.html`. All of that would be bundled into the app.
→ **Fix:** a separate `build:ios` script that skips `route-shells.mjs` and excludes
`public/*.html` marketing pages. Smaller binary, and nothing in the bundle contradicts your
review notes.

**R10 · arakice.com is your marketing URL — and reviewers open it**
The site carries bookmaker links and pages literally titled "best NHL betting software".
Removing the links from the *app* while the *listed website* is a betting funnel is a
contradiction a reviewer can find in one click.
→ **Decide:** either soften the public site's betting framing before submission, or accept
this as your single biggest 5.3 exposure. This is a judgement call, not a code change.

### 🟡 Medium — polish, bugs, small review risks

| # | Risk | File | Fix |
|---|------|------|-----|
| R11 | `navigator.share({files})` is unreliable in WKWebView | `services/shareImage.ts:31` | use `@capacitor/share` on native |
| R12 | `html-to-image` `toPng` is flaky in WKWebView (foreignObject + web fonts render blank) | `services/shareImage.ts:7` | test early on a real device; fallback to a server-rendered card |
| R13 | `BottomNav` is `fixed bottom-3` → sits under the home indicator | `components/BottomNav.tsx:31` | `env(safe-area-inset-bottom)` |
| R14 | `minHeight: 100vh` on the route fallback jumps with the iOS URL bar / keyboard | `app/routes.tsx:36` | `100dvh` + safe-area |
| R15 | Full-screen `fixed inset-0` sheets vs the iOS keyboard | `ConfirmDialog`, `HowItWorksSheet`, `MarketSelectorSheet`, `AuthGateContext` | keyboard-avoidance pass on a real device |
| R16 | No CSP at all in the native app — yours is a Vercel **header**, not a meta tag | `client/vercel.json` | add a `<meta http-equiv="Content-Security-Policy">` for the native build |
| R17 | `/dev/ml` is only `<Protected>` client-side; any logged-in user can navigate there and get 403s | `app/routes.tsx:106` | hide the route on native / for non-admins — a reviewer poking at it looks bad |

### ✅ Verified safe / no action

- **Server-side dev routes are properly gated** — `dev.routes.ts:29` requires
  `authenticate` + `requireRole('admin')`. Good.
- **CORS is centralised** in `server/src/cors.ts` and shared with `socket.ts`, so adding
  `capacitor://localhost` is a **one-line change in one file** that fixes HTTP *and*
  WebSocket together. Whoever wrote that comment saved you a day.
- **Chat rate limits** already exist (`msg` 10/10s, `create` 5/5min) — reviewers like that.
- **`createBrowserRouter`** works under Capacitor's local server; verify deep-refresh on the
  first build, but low risk.
- **No `document.cookie`, no Web Workers, no blob downloads, no `<a download>`** anywhere —
  four whole categories of WebView pain you happen not to have.
- **Sentry** (`main.tsx:8`) works in the WebView for JS errors. Native crashes go
  unreported — acceptable for v1, add `@sentry/capacitor` later.
- `ogl` sits in the **root** `package.json` and is imported nowhere in `client/src`. Dead
  dependency, harmless.

### What this does to the timeline

The audit adds **R1–R4 and R6** as real engineering, none of which was budgeted:

| Work | Added effort |
|------|--------------|
| Native OAuth + Sign in with Apple (or dropping Google on iOS) | 1–4 days |
| Native refresh-token path | 1 day |
| Chat moderation (report / block / filter) | 3–5 days |
| APNs push | 2–3 days |
| iOS build script + env assertions | 0.5 day |

**Revised estimate: 8–12 weeks part-time**, up from 6–10. The §12 table still holds; weeks
9–10 stop being buffer and start being work.

### Decisions taken after this audit (2026-09-03)

- **R2 → no Google Sign-In in the iOS build.** Email/password only on iOS. This cancels
  both the native-OAuth work (R1) and the Sign in with Apple requirement (R2) — roughly a
  week of work removed, at the cost of one login option on iOS only. The web keeps Google.
- **R3, R4, R7 → done as web work first**, before any native dependency exists.
  That plan is finished and deleted — read it with **`git show 0916b52:PRE_IOS_PLAN.md`** (5–7 days, four separate deploys).

### Order I would actually do it in

1. **R2 decision first** — Sign in with Apple, or no Google on iOS? Everything in the auth
   layer depends on that answer, and it is the cheapest decision to make and the most
   expensive to change late.
2. **R4 chat moderation** — pure web work, ships to the web app too, makes it better there.
   Do it before Capacitor exists so it is tested in a browser where you can debug.
3. **R3 + R7** — auth and env plumbing, still testable on web.
4. Then Phase 3 (Capacitor), with the ugly parts already solved.

Points 1–3 are all **web-side work you can do today**, before installing a single native
dependency. That is the answer to "what should I finish before starting the Apple plan".

---

## 0. Read this first — the honest situation

You do not have an iOS app today. You have a React + Vite web app (`client/`) and a
Node/TypeScript API (`server/`) with Stripe subscriptions. Getting on the App Store is
**not a deployment step, it is a small product**. Realistic effort: **6–10 weeks part-time**,
not a weekend.

There are **five things** standing between you and approval. Everything in this
plan exists to kill one of them.

| # | Blocker | Why it blocks you | Where it lives today |
|---|---------|-------------------|----------------------|
| B1 | **Bookmaker affiliate links** (Stake, bet365) | Apple treats apps that funnel users to real-money gambling as gambling apps. Those must be submitted by the **licensed operator**, be **free**, and be **geo-restricted** to licensed jurisdictions. You are none of those. | `client/src/app/services/bookmakers.ts` (Stake affiliate code `VITE_STAKE_AFFILIATE_CODE`), bet365 odds + "Bet" pills in `client/src/app/pages/landing/LandingCards.tsx` |
| B2 | **It's a website in a box** | Guideline 4.2 — "should include features, content, and UI that elevate it beyond a repackaged website". A pure WebView wrap of arakice.com gets rejected. | Whole `client/` |
| B3 | **Stripe for digital subscriptions** | Guideline 3.1.1 — unlocking Pro inside the app must use In-App Purchase. Outside the US storefront you also may not link out to your Stripe checkout. | `server/src/routes/subscription.routes.ts`, `client/src/app/pages/ProPage.tsx` |
| B5 | **Chat has no moderation** | Guideline 1.2 — an app with user-generated content must have a content filter, a report mechanism, a way to **block** abusive users, and published contact info. Your chat has none: room owners can kick and delete, but there is no user-level report or block anywhere. | `client/src/app/pages/league/chat/*`, `server/src/routes/chat.routes.ts` |
| B4 | **No in-app account deletion** | Guideline 5.1.1(v) — an app with account creation must let users delete the account **in the app**. Yours says "email us" (`SupportPage.tsx`). Very common instant rejection. | `client/src/app/pages/SupportPage.tsx`, no `DELETE` route on the server |

**Decisions already made (2026-09-03):**

- Build path: **Capacitor wrap** of the existing React app (not a React Native rewrite).
- Mac: **none** — all iOS builds run on **cloud macOS CI**.
- Payments: **Apple IAP on iOS, Stripe stays on web**, one shared entitlement.
- Betting: **no real money in the app**; you want an outbound "place this bet" link.
  → See §4, this is the one decision that is not fully yours to make.

---

## 1. Cost and calendar

| Item | Cost | Notes |
|------|------|-------|
| Apple Developer Program | **$99 USD/year** | Individual enrollment: legal name + Apple Account with 2FA. Organization needs a D-U-N-S number, a work email on your domain, and a live website — **individual is faster, start there.** |
| Cloud macOS CI | ~$0–30/month | GitHub Actions macOS runners bill at a 10× minute multiplier; Codemagic and Xcode Cloud have free tiers. Verify current limits before committing. |
| RevenueCat (optional, recommended) | free under a monthly revenue threshold | Verify the current threshold at signup. |
| Apple's cut on IAP | 15% (Small Business Program, <$1M/yr) or 30% | You must **apply** for the 15% Small Business Program — it is not automatic. |

**Enrollment is the long pole nobody plans for.** Apple ID verification can take days.
Do §2 in week 1 even if no code is written.

---

## 2. Phase 0 — Accounts and identity (week 1, do this first)

- [x] **0.1** Pick the Apple Account you will use *forever*. Not `arakice.support@gmail.com`
      — you already lost control of that one and it cost you the Cloudflare account
      (recovered 2026-09-16, now on `ireinahedad24@gmail.com` — still not a reason to reuse it).
      Use an address on a domain **you** control, with recovery you can actually reach.
- [x] **0.2** Turn on two-factor auth on it. Save the recovery key somewhere real.
- [x] **0.3** Enroll in the Apple Developer Program ($99/yr), **Individual**.
      https://developer.apple.com/programs/enroll/
- [ ] **0.4** Once approved, apply for the **App Store Small Business Program** (15% instead of 30%).
- [ ] **0.5** In App Store Connect: create the app record.
      - Bundle ID: `com.arakice.iceedge` (register it in Certificates, Identifiers & Profiles first)
      - SKU: `arakice-ios-01`
      - Primary language: English (add French later — you already have `i18n/`)
- [ ] **0.6** Create an **App Store Connect API key** (Users and Access → Integrations).
      Download the `.p8` **once** — it is unrecoverable. This is what lets CI upload builds
      without a Mac in front of you.
- [ ] **0.7** Decide the public app name. `IceEdge` and `Arakice` are both free-ish; check
      https://developer.apple.com/app-store/ for conflicts. Name is locked-ish after launch.

**Exit criteria:** you can log into App Store Connect, see an empty app record, and hold an
API key `.p8` + Issuer ID + Key ID in your password manager.

---

## 3. Phase 1 — Legal / compliance gate (week 1–2, in parallel)

This phase produces **documents**, not code, and it is what most solo devs skip and then
get rejected for.

- [ ] **1.1 Privacy policy** — you have `PrivacyPage.tsx`; it must be reachable at a **public
      URL** (App Store Connect requires one) and must describe: account data, Stripe/Apple
      purchase data, Sentry crash data, chat messages, analytics.
- [ ] **1.2 Terms of use (EULA)** — required for auto-renewable subscriptions. Either use
      Apple's standard EULA or link your own from `TermsPage.tsx`.
- [ ] **1.3 Subscription disclosure text** — for auto-renewable subs, the **purchase screen
      inside the app** must show: title, length, price per period, what you get, and links
      to Privacy + Terms. Missing this = rejection, every time.
- [ ] **1.4 Age rating questionnaire** — expect **the highest tier** because of gambling
      references. Answer honestly; lying gets the app pulled later.
- [ ] **1.5 Export compliance** — you use HTTPS only → standard exemption, but you must
      answer the question in App Store Connect.
- [ ] **1.6 Privacy nutrition labels** + `PrivacyInfo.xcprivacy` privacy manifest for the
      app and any third-party SDK (Sentry, RevenueCat) that requires one.

---
## 4. Phase 2 — The gambling decision (B1) — week 2, DO NOT SKIP

You asked: *"could I have a link for when a user wants to place the bet on the other app,
but never real money on my app?"*

**Straight answer: on the web, yes. On iOS, that link is the single most likely reason
your app gets rejected.** Here is why, and what to do.

### The rule

Apple's App Store Review Guidelines §5.3 (Gaming, Gambling, and Lotteries) require apps
that offer or facilitate real-money gambling to be submitted by the **licensed entity**,
to hold licensing **in every territory where the app is available**, to be **geo-restricted**
to those territories, and to be **free**. Reviewers apply this to apps that act as a funnel
— odds + a "Bet" button + an affiliate code is a funnel, even though no money moves inside
your app. **Stake specifically** is a crypto casino/sportsbook; an affiliate link to it is
about the worst possible version of this.

Read it yourself before you argue with me:
https://developer.apple.com/app-store/review/guidelines/#gaming-gambling-and-lotteries

### The three options

| Option | What it means | Verdict |
|--------|---------------|---------|
| **A — Strip bookmaker links from iOS only** | Feature-flag the whole bookmaker layer off in the native build. iOS shows predictions, edges, stats, bet-slip *tracking*. The web keeps affiliate links and revenue. | ✅ **Recommended for v1.** Approval odds go from "coin flip at best" to "good". Costs you affiliate revenue on iOS traffic only. |
| **B — Keep the links, ship them, see what happens** | Submit with bet365/Stake outbound links. | ❌ Expect Guideline 5.3 rejection. Repeated rejections on gambling grounds can put the account under scrutiny. Do not open your Apple account this way. |
| **C — Go legit** | Become a licensed affiliate/operator, geo-restrict, make the app free, submit as the licensed entity. | 💸 Months and lawyers. Not now. |

### Work items for Option A

- [ ] **2.1** Add a build-time flag `VITE_PLATFORM=ios` (Capacitor build only) and a
      runtime helper `isNativeIOS()` (`Capacitor.getPlatform() === 'ios'`).
- [ ] **2.2** In `client/src/app/services/bookmakers.ts`: when native iOS, return no
      bookmaker, no affiliate URL. Never ship `VITE_STAKE_AFFILIATE_CODE` into the iOS bundle
      — check the built `dist/` with `grep -r "stake" dist/` before every release.
- [ ] **2.3** In `LandingCards.tsx` / `OddsPill` / `BetContext`: on iOS render the odds as
      **read-only reference data with no tap-through**, or hide odds entirely (safer for v1).
- [ ] **2.4** Rewrite the iOS-facing copy: this is an **analytics and prediction** app.
      Remove "place your bet" / "Bet now" style verbs from the iOS build, the App Store
      title, subtitle, keywords, description, and screenshots. Metadata is reviewed too.
- [ ] **2.5** Add a visible in-app disclaimer: informational/entertainment only, no wagering,
      no real money, plus a responsible-gambling helpline link.
- [ ] **2.6** Age rating: answer the gambling/contests questions honestly → expect 18+.

**Exit criteria:** `grep -rin "stake\|bet365\|place.*bet" client/dist/` on an iOS build
returns nothing actionable.

---

## 4b. One codebase, two targets — decided 2026-09-03

**Decision: keep a single `client/`. Do NOT fork a second folder for the iOS app.**

A second folder is a fork, and a fork drifts. Every bug fix, every NHL API change, every
i18n string would have to be done twice, and within two months the two versions would
disagree about something subtle and you would not know which one is right. Capacitor was
built precisely so this is unnecessary.

### Why the web app is safe

The web deploy does not change at all:

- Vercel builds `client/` → `npm run build` → `dist/`. Unchanged.
- `client/vercel.json` (CSP, rewrites, cache headers). Unchanged.
- `client/ios/` is a **native shell that Vercel never looks at**. It contains an Xcode
  project whose only job is to load the same `dist/` you already ship.
- One `npm run build` feeds both. Same components, same routes, same API client.

The web app keeps its bookmaker links, its Stripe checkout, its service worker and its Web
Push. **Nothing is removed from the web.** Only the iOS build turns those off.

### How the split actually works

One small module decides everything, at runtime:

```ts
// client/src/app/platform.ts
import { Capacitor } from '@capacitor/core';

export const isNative   = Capacitor.isNativePlatform();
export const isIOS      = Capacitor.getPlatform() === 'ios';
export const isWeb      = !isNative;

/** Feature switches — the single place where web and iOS diverge. */
export const features = {
  bookmakerLinks: isWeb,   // §4 — off on iOS (App Store guideline 5.3)
  stripeCheckout: isWeb,   // §7 — iOS uses StoreKit IAP instead
  webPush:        isWeb,   // §5/3.7 — iOS uses APNs
  serviceWorker:  isWeb,   // §5/3.7 — no SW inside WKWebView
  nativeShare:    isNative,
  haptics:        isNative,
};
```

Then, everywhere that differs:

```ts
if (features.bookmakerLinks) { /* OddsPill with tap-through */ }
else                         { /* read-only stat, or nothing */ }
```

That is the entire pattern. Roughly **6–8 call sites**, all already identified:

| File | What changes on iOS |
|------|---------------------|
| `src/app/services/bookmakers.ts` | returns no bookmaker / no affiliate URL |
| `src/app/pages/landing/LandingCards.tsx` | `OddsPill` becomes non-tappable or hidden |
| `src/app/context/BetContext.tsx` | `openBet()` no-ops |
| `src/app/pages/ProPage.tsx` | StoreKit paywall instead of Stripe checkout |
| `src/app/services/pushService.ts` | APNs instead of Web Push + service worker |
| `src/app/pages/SharePage.tsx` | native share sheet |
| `src/app/services/authService.ts` | refresh token in Preferences, not a cookie |

### Guardrails

- **Dead-code elimination:** wrap the iOS-off branches so Rollup can drop them from the
  native bundle when the flag is a build-time constant. Belt and braces: after every iOS
  build, run `grep -ri "stake\|affiliate" client/dist/` — it must come back empty.
- **Never** introduce `platform.ts` checks inside shared business logic (prediction math,
  API parsing). Only at the UI / integration edges. If a check creeps into a model, the two
  targets have started to diverge for real.
- `client/ios/` **is committed** to git (CI needs it); `client/ios/App/Pods/`,
  `client/ios/App/build/` and `DerivedData/` are ignored.
- One `git tag pre-ios-freeze` before any of this, per the Gate above.

**Rejected alternative:** a `mobile/` folder with a copied React app. Faster on day one,
unmaintainable by month two. Not doing it.

---

## 5. Phase 3 — Capacitor shell (week 2–3)

```bash
cd client
npm i @capacitor/core @capacitor/cli
npx cap init "IceEdge" com.arakice.iceedge --web-dir=dist
npm i @capacitor/ios @capacitor/app @capacitor/browser @capacitor/haptics \
      @capacitor/status-bar @capacitor/splash-screen @capacitor/preferences \
      @capacitor/push-notifications @capacitor/share
npm run build && npx cap add ios && npx cap sync ios
```

- [ ] **3.1** `capacitor.config.ts`: `appId: 'com.arakice.iceedge'`, `webDir: 'dist'`,
      `ios: { contentInset: 'always' }`. **No `server.url`** — a config that just loads
      arakice.com remotely is the textbook 4.2 rejection. Bundle the assets.
- [ ] **3.2** Commit `client/ios/` to git (CI needs it). Add
      `client/ios/App/Pods`, `client/ios/App/build`, `DerivedData` to `.gitignore`.
- [ ] **3.3** API base URL must be an absolute `https://` production URL. No `localhost`,
      no relative-to-origin assumptions — the WebView origin is `capacitor://localhost`.
      Audit `client/src/app/services/` for every fetch.
- [ ] **3.4** **CORS**: add `capacitor://localhost` and `ionic://localhost` to the allow-list
      in `server/src/cors.ts` (it is shared by HTTP and Socket.io via `socket.ts`, so fixing
      it there fixes both).
- [ ] **3.5** **Auth** (`client/src/app/services/authService.ts`): access token in
      `localStorage` + `Bearer` header is fine in a WebView. The **refresh token cookie**
      (`credentials: 'include'`) is the fragile part — third-party cookies from a
      `capacitor://localhost` origin are unreliable on iOS. Plan a native path that returns
      the refresh token in the response body and stores it in `@capacitor/preferences`
      (Keychain-backed) instead of a cookie. Test session persistence across an app restart
      and a 15-minute token expiry before you call this done.
      **Correction (audit 2026-09-03):** an earlier draft of this plan said Sign in with
      Apple was not required. **That was wrong** — you already ship Google OAuth
      (`getGoogleLoginUrl()`, `LoginPage.tsx`, `AuthCallback.tsx`), so Guideline 4.8 applies.
      See risks **R1** and **R2** in §-1.
- [ ] **3.6** **Socket.io** must connect over `wss://` to the production host.
- [ ] **3.7** **Kill the service worker / Web Push** in the native build.
      `client/src/app/services/pushService.ts` registers `/sw.js` and uses the Web Push API —
      that does not work inside a WKWebView on iOS, and a stale SW will serve you old assets.
      Guard the whole thing behind `!isNative` and route native notifications through APNs
      instead (see 4.1).
- [ ] **3.8** iOS UI pass: safe-area insets (`env(safe-area-inset-*)`) so content clears the
      notch and home indicator; no `:hover`-only affordances; ≥44pt tap targets;
      `-webkit-overflow-scrolling`; keyboard-avoidance on the login and chat inputs;
      disable text selection / long-press callout where it feels wrong;
      status bar style set via `@capacitor/status-bar`.
- [ ] **3.9** External links (privacy policy, helpline) open via `@capacitor/browser`
      (SFSafariViewController), never by navigating the app WebView away.
- [ ] **3.10** Splash screen + app icon (see §8).

**Exit criteria:** CI produces an `.ipa` that launches, logs in, loads predictions, and
survives airplane-mode toggling without a white screen.

---

## 6. Phase 4 — Earn the right to exist (B2 / Guideline 4.2) — week 3–4

A wrapped website gets rejected. You need things a website **cannot** do. Pick **at least
three**; they are also the reason someone keeps the app installed.

- [ ] **4.1 Push notifications (APNs)** — "Your Best Bets are ready", game-start alerts.
      You already have the server-side notion of push in `pushService.ts`, but that is **Web
      Push and does not work on iOS native**. You need: an **APNs auth key** (`.p8`) from the
      developer portal, the Push Notifications capability on the App ID,
      `@capacitor/push-notifications` on the client, a `device_tokens` table, and an APNs
      sender on the server (reuse the existing notification triggers).
      *This is the strongest 4.2 argument you have — do it first.*
- [ ] **4.2 Home screen widget** — today's top edge / next game. WidgetKit, written in Swift.
      Highest effort, highest "this is a real app" signal. Optional for v1.
- [ ] **4.3 Native share sheet** — your `SharePage.tsx` + `html-to-image` already generates
      share cards; pipe them through `@capacitor/share`.
- [ ] **4.4 Offline mode** — cache the last-fetched predictions in `@capacitor/preferences`
      and render them with a "last updated" stamp when offline.
- [ ] **4.5 Haptics** on key interactions; **Face ID / biometric unlock** for the profile tab.
- [ ] **4.6 Universal Links** — `arakice.com/share/...` opens the app if installed
      (needs an `apple-app-site-association` file served from your domain).
- [ ] **4.7** Write the 4.2 defence into the review notes now, while it is fresh (see §11).

---
## 7. Phase 5 — Payments: Apple IAP on iOS, Stripe on web (B3) — week 4–6

This is the biggest engineering chunk. The goal: **one entitlement, two payment rails.**
A user who subscribes on the web is Pro in the app, and vice versa — that is explicitly
allowed (Guideline 3.1.3(b), multiplatform services) **as long as the same subscription is
also purchasable via IAP inside the app**.

### Recommended architecture

Use **RevenueCat** (`@revenuecat/purchases-capacitor`) rather than raw StoreKit. It handles
receipt validation, App Store Server Notifications, renewals, refunds, grace periods and
sandbox testing — all of which are painful to get right alone, and all of which silently
break subscriptions when wrong.

```
Web  → Stripe Checkout ─┐
                        ├→ your server: subscriptions table (plan, status, source, ends_at)
iOS  → StoreKit/RevCat ─┘        ↑ webhooks from both
                                 ↓
                       GET /subscription/me  → { plan: 'pro' | 'free' }
```

### Work items

- [ ] **5.1** App Store Connect → create the subscription group + auto-renewable products,
      e.g. `pro_monthly`, `pro_yearly`. Set price tiers, localizations, review screenshot.
      Products must be in "Ready to Submit" or review will fail with "IAP not found".
- [ ] **5.2** Fill in the paid-apps agreement + **banking and tax forms**. Apple will not
      let IAP go live without them. This takes real-world days.
- [ ] **5.3** Migrate the DB: add `source` (`stripe` | `apple`), `apple_original_transaction_id`,
      `platform_product_id` to the subscriptions table
      (`server/src/db/migrations/0XX_iap.sql`, alongside `011_subscriptions.sql`).
- [ ] **5.4** New server endpoints: `POST /subscription/apple/webhook` (RevenueCat webhook or
      App Store Server Notifications V2) and `POST /subscription/link` to attach a purchase
      to the logged-in user. Verify signatures. Make them idempotent.
- [ ] **5.5** `GET /subscription/me` becomes the **single source of truth** for the client,
      returning the union of both rails. Never gate the UI on the payment provider.
- [ ] **5.6** `ProPage.tsx`: on native iOS render the **StoreKit paywall** (price from the
      store, not hardcoded), and hide the Stripe checkout button entirely.
      Outside the US storefront you may not even *link* to your web checkout — no
      "subscribe on our website" text, no pricing comparison. Assume the strict rule.
- [ ] **5.7** Implement **Restore Purchases** — a visible button. Required, and reviewers
      look for it.
- [ ] **5.8** Purchase screen must display: subscription length, price, what Pro unlocks,
      auto-renew disclosure, and links to Terms + Privacy (see 1.3).
- [ ] **5.9** Check `server/src/services/llmQuota.service.ts` and every `plan === 'pro'`
      gate still works when the entitlement arrives from Apple.
- [ ] **5.10** Sandbox-test: subscribe, renew (sandbox renewals are accelerated), cancel,
      restore on a second device, and expiry. Use a Sandbox Apple Account, not your real one.

**Exit criteria:** a TestFlight build where a sandbox user can buy Pro, close the app,
reinstall, tap Restore, and still be Pro — and where a web-Stripe Pro account is Pro on iOS.

---

## 8. Phase 6 — Account deletion + privacy (B4) — week 5 (small, high value)

- [ ] **6.1** `DELETE /account` on the server: hard-delete or anonymise the user, their
      slips, chat messages, and profile. Cancel any live Stripe subscription.
- [ ] **6.2** Settings → "Delete my account", two-step confirm, works **entirely in the app**.
      No "email us" (fix `SupportPage.tsx` copy too).
- [ ] **6.3** Explain in-app what deletion removes and what is retained for legal reasons.
- [ ] **6.4** If the account has an active **Apple** subscription, tell the user deletion
      does not cancel it and deep-link to `itms-apps://apps.apple.com/account/subscriptions`.

---

## 9. Phase 7 — Building without a Mac (week 3 onward, set up early)

You are on Windows. You never need to touch a Mac, but every build must run on one.

**Option 1 — GitHub Actions (recommended, you already have `.github/`)**

You already have `.github/workflows/ci.yml`; add a sibling:

```yaml
# .github/workflows/ios-release.yml
runs-on: macos-15          # must provide Xcode 26 — verify the image's Xcode version
```

- [ ] **7.1** Since **28 April 2026**, App Store Connect only accepts builds made with
      **Xcode 26+ / iOS 26 SDK**. Pin the runner image and run
      `xcodebuild -version` in CI to prove it. https://developer.apple.com/news/upcoming-requirements/
- [ ] **7.2** Signing: use **fastlane match** (certs in a private repo) or
      `apple-actions/import-codesign-certs`. Store as GitHub secrets:
      `APP_STORE_CONNECT_KEY_ID`, `ISSUER_ID`, the base64 `.p8`, `MATCH_PASSWORD`.
      **Never commit a `.p8` or `.p12`.**
- [ ] **7.3** Pipeline: `npm ci` → `npm run build` → `npx cap sync ios` →
      `pod install` → `xcodebuild -archive` → `-exportArchive` →
      `xcrun altool`/`fastlane pilot` upload to TestFlight.
- [ ] **7.4** Auto-increment the build number from the run number. Apple rejects duplicates.
- [ ] **7.5** Budget the minutes — macOS runners bill at ~10× on GitHub Actions.
      Alternatives: **Codemagic** (Capacitor-friendly, generous free tier) or **Xcode Cloud**
      (Apple-native, included hours with the developer program). Verify current limits.
- [ ] **7.6** You cannot run the iOS Simulator on Windows. Your only device testing is
      **TestFlight on a real iPhone** — yours or a tester's. Plan for that (§10).

---

## 10. Phase 8 — Store assets and metadata (week 6)

- [ ] **8.1** **App icon** 1024×1024, no alpha, no rounded corners, no transparency.
      You have `client/public/arakice-icon-512.png` — regenerate at 1024 from source.
      Generate the full iOS icon set (`@capacitor/assets` does this).
- [ ] **8.2** **Screenshots** — required: 6.9" iPhone (1320×2868). Strongly advised: 6.5".
      5–8 shots. Must show the **actual iOS app**, not a browser or a mockup frame.
      No gambling call-to-action visible. Use TestFlight on a real device to capture.
- [ ] **8.3** **App preview video** (optional, 15–30s) — meaningfully lifts conversion.
- [ ] **8.4** Name (30 chars), subtitle (30), promo text (170), description (4000),
      keywords (100, comma-separated, no spaces). Write these as **analytics/predictions**,
      never as betting. Keywords like "betting", "sportsbook", "odds" invite 5.3 scrutiny.
- [ ] **8.5** Support URL + marketing URL (arakice.com), privacy policy URL. All must be live.
- [ ] **8.6** Category: **Sports** (primary). Secondary: Utilities or Reference.
- [ ] **8.7** French localization of the store listing — you already have `i18n/`, it is
      nearly free, and Canada is a real market for you.

---

## 11. Phase 9 — TestFlight, submission, and the rejection playbook (week 7–8)

- [ ] **9.1** Internal TestFlight (up to 100 testers, no review) — you + 2–3 friends.
      Run the full `QA_TEST_PLAN.md` on a real iPhone.
- [ ] **9.2** External TestFlight (needs a light Beta App Review) — 10–20 testers, one week.
      This is where you find the WebView bugs a desktop browser never shows you.
- [ ] **9.3** Fill **App Review Information**: a working **demo account** (email + password,
      Pro already enabled) — reviewers will not sign up, and a paywalled app with no demo
      account is an automatic "Guideline 2.1 — Information Needed".
- [ ] **9.4** Write the **review notes**. Pre-empt every blocker:
      > IceEdge is a hockey **analytics and prediction** app. It does not accept wagers,
      > hold funds, process gambling transactions, or link to any gambling operator.
      > All statistics, model predictions and bet-slip tracking are informational.
      > Subscriptions are sold exclusively via In-App Purchase on iOS.
      > Native features: push notifications, offline caching, share sheet, haptics,
      > biometric unlock, universal links.
      > Demo account: `review@arakice.com` / `<password>` (Pro enabled).
- [ ] **9.5** Submit. First review is typically 24–48h; **assume you will be rejected once.**
      That is normal, not failure.
- [ ] **9.6** **Rejection playbook** — reply in Resolution Center, do not resubmit blindly:
      - *5.3 Gambling* → point to the removed links, offer to remove odds display entirely.
      - *4.2 Minimum functionality* → list the native features with screenshots.
      - *3.1.1 IAP* → prove Stripe is unreachable on iOS.
      - *2.1 Information needed* → they usually just want a working demo account or a video.
      - *5.1.1(v)* → screenshot the in-app deletion flow.
- [ ] **9.7** Release: choose **manual release** so you control launch day.
- [ ] **9.8** Post-launch: watch Sentry + App Store Connect crash reports for week 1;
      have a hotfix build path ready (expedited review exists for real breakage).

---

## 12. Timeline at a glance

| Week | Focus |
|------|-------|
| 1 | Apple enrollment, app record, API key, legal docs |
| 2 | Gambling decision + iOS feature flags, Capacitor init |
| 3 | Capacitor shell working, CI pipeline green, first TestFlight build |
| 4 | Native features (push, share, offline) |
| 5 | Account deletion, privacy manifest, IAP products created |
| 6 | IAP implementation + sandbox testing, store assets |
| 7 | TestFlight external round, bug fixes |
| 8 | Submit → expect one rejection → resubmit |
| 9–10 | Buffer. You will use it. |

---

## 13. Definition of done

- App live on the App Store, 18+ rated, Sports category
- A user can: install → sign up → see predictions → subscribe via IAP → restore purchases
  → delete their account, all without leaving the app
- A web Stripe subscriber is Pro on iOS with no extra payment
- No bookmaker or affiliate link anywhere in the iOS binary or metadata
- `main` pushes build and ship to TestFlight automatically

---

## 14. Open questions to resolve before Phase 3

1. ~~Is `arakice.com` back under your control?~~ **Yes — 2026-09-16.** The original
   Cloudflare account (zone, registration and production R2) was recovered and is managed
   from `ireinahedad24@gmail.com`. The domain is usable for the privacy policy URL, universal
   links; `support@arakice.com` forwards to that Gmail since the same day.
   Follow-ups: `STATUS.md` §3.9.
2. Individual or company enrollment? Individual = your legal name is public on the listing.
3. Does anyone you know have an iPhone for TestFlight? You need at least one real device.
4. Are you willing to launch iOS without affiliate revenue? (§4 Option A assumes yes.)
5. Android/Play Store — same Capacitor project, later, and Google's gambling rules differ.

---

## 15. Sources

- [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Guideline 5.3 — Gaming, Gambling, and Lotteries](https://developer.apple.com/app-store/review/guidelines/#gaming-gambling-and-lotteries)
- [Apple Developer Program enrollment](https://developer.apple.com/support/enrollment/)
- [Upcoming SDK minimum requirements (Xcode 26, 28 Apr 2026)](https://developer.apple.com/news/upcoming-requirements/)
- [StoreKit external purchase entitlements](https://developer.apple.com/documentation/storekit/external_purchase)
