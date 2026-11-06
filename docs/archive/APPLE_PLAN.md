# APPLE_PLAN.md — Shipping IceEdge / Arakice to the Apple App Store

**Owner:** Ireina · **Created:** 2026-09-03 · **Target:** iOS app live on the App Store (iPhone first, iPad later)

> **⏸ ON HOLD since 2026-10-14** — web first. Apple will not review « Simulated Gambling » from an
> Individual account; the two ways to resume are in `STATUS.md` §3.4.
>
> **What remains only.** Live checklist: **`STATUS.md` §3.4**. Done and removed on 2026-10-14:
> the freeze gate, the pre-flight audit (R1–R10, R13, R14, R16, R17), Phases 0, 3, 6 and 7, the
> code of Phases 2, 4 and 5. Code comments that cite a removed section (« APPLE_PLAN §4 », « R8 »,
> « 2.2 », « Phase 7 », « 6.4 »…) → **`git show 1b03631:APPLE_PLAN.md`**.

---

## §-1. Open risks from the pre-flight audit

| # | Risk | File | Fix |
|------|------|------|-----|
| R11 | `navigator.share({files})` is unreliable in WKWebView | `services/shareImage.ts:31` | use `@capacitor/share` on native |
| R12 | `html-to-image` `toPng` is flaky in WKWebView (foreignObject + web fonts render blank) | `services/shareImage.ts:7` | test early on a real device; fallback to a server-rendered card |
| R15 | Full-screen `fixed inset-0` sheets vs the iOS keyboard | `ConfirmDialog`, `HowItWorksSheet`, `MarketSelectorSheet`, `AuthGateContext` | keyboard-avoidance pass on a real device |
| R18 | NHL team logos and player photos shown without a licence (5.2.1) — *added 2026-10-09* | everywhere logos/photos render | decide before Phase 8: keep, or team-colour badges on iOS (`docs/ios/APP_STORE_COMPLIANCE.md` §9) |

R11/R12 are tested with 4.3 (share sheet on the iPhone), R15 with the next device pass.

---

## 0. Decisions already made

- Build path: **Capacitor wrap** of the existing React app (not a React Native rewrite), one
  `client/` for both targets (§4b).
- Mac: **none** — all iOS builds run on **cloud macOS CI** (`ios-release.yml`, `docs/ios/CI_SETUP.md`).
- Bundle ID **`com.arakice.arakice`** — an App Store record's bundle ID can never change.
- Login on iOS: **email/password only** (no Google, so no Sign in with Apple — Guideline 4.8).
- Payments: **Apple IAP on iOS (StoreKit 2 direct, no RevenueCat), Stripe stays on web**, one
  shared entitlement.
- Betting: **no real money and no bookmaker link in the app** (§4); none on the web either until
  there is an affiliate deal (R10).

---

## 3. Phase 1 — Legal / compliance gate

Every answer is prepared in **`docs/ios/APP_STORE_COMPLIANCE.md`**; left: type them into App Store Connect.

- [ ] **1.4 Age rating questionnaire** — expect **the highest tier** because of gambling
      references. Answer honestly; lying gets the app pulled later.
- [ ] **1.5 Export compliance** — you use HTTPS only → standard exemption, but you must
      answer the question in App Store Connect.
- [ ] **1.6 Privacy nutrition labels** + `PrivacyInfo.xcprivacy` privacy manifest for the
      app (manifest already in the target) and any third-party SDK that requires one.

---
## 4. Phase 2 — Gambling (B1)

### The rule

Apple's App Store Review Guidelines §5.3 (Gaming, Gambling, and Lotteries) require apps
that offer or facilitate real-money gambling to be submitted by the **licensed entity**,
to hold licensing **in every territory where the app is available**, to be **geo-restricted**
to those territories, and to be **free**. Reviewers apply this to apps that act as a funnel
— odds + a "Bet" button + an affiliate code is a funnel, even though no money moves inside
your app. Hence: no bookmaker layer in the iOS build (`npm run build:ios` fails if one survives).
https://developer.apple.com/app-store/review/guidelines/#gaming-gambling-and-lotteries

- [ ] **2.4** Store metadata (with Phase 8): title, subtitle, keywords, description and
      screenshots written as an **analytics and prediction** app — no "place your bet" / "Bet now"
      verbs. Metadata is reviewed too. (In-app copy: done.)

---

## 4b. One codebase, two targets — decided 2026-09-03

**Decision: keep a single `client/`. Do NOT fork a second folder for the iOS app.**

A second folder is a fork, and a fork drifts. Every bug fix, every NHL API change, every
i18n string would have to be done twice, and within two months the two versions would
disagree about something subtle and you would not know which one is right. Capacitor was
built precisely so this is unnecessary.

Everything that differs between web and iOS goes through the feature switches of
`client/src/app/platform.ts` (`features.bookmakerLinks`, `stripeCheckout`, `webPush`, …).

### Guardrails

- **Dead-code elimination:** wrap the iOS-off branches so Rollup can drop them from the
  native bundle when the flag is a build-time constant. Belt and braces: after every iOS
  build, run `grep -ri "stake\|affiliate" client/dist/` — it must come back empty.
- **Never** introduce `platform.ts` checks inside shared business logic (prediction math,
  API parsing). Only at the UI / integration edges. If a check creeps into a model, the two
  targets have started to diverge for real.
- `client/ios/` **is committed** to git (CI needs it); `client/ios/App/Pods/`,
  `client/ios/App/build/` and `DerivedData/` are ignored.

**Rejected alternative:** a `mobile/` folder with a copied React app. Faster on day one,
unmaintainable by month two. Not doing it.

---

## 6. Phase 4 — Earn the right to exist (B2 / Guideline 4.2)

A wrapped website gets rejected. Code is done for 4.1, 4.2, 4.3 and 4.6; what is left is set-up
and testing on the iPhone (detail: `STATUS.md` §3.4). The 4.2 defence for the reviewer is written
in `docs/ios/APP_REVIEW_NOTES.md`.

- [ ] **4.1 Push notifications (APNs)** — left: APNs key + Push capability + regenerated profile,
      Railway vars `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_KEY_P8`, migration 043 on Neon, test.
- [ ] **4.2 Home screen widget** (the user's pending bets with their live probability, refreshed
      every 15–30 min) — left: App Group `group.arakice.arakice.com` + widget App ID + profile,
      secrets, migration 044, test.
- [ ] **4.3 Native share sheet** (slip card PNG via `@capacitor/share`) — left: test on the iPhone.
- [ ] **4.4 Offline mode** — cache the last-fetched predictions in `@capacitor/preferences`
      and render them with a "last updated" stamp when offline.
- [ ] **4.5 Haptics** on key interactions; **Face ID / biometric unlock** for the profile tab.
- [ ] **4.6 Universal Links** — left: Associated Domains on the App ID + profile, deploy the web
      (`apple-app-site-association`), test.

---
## 7. Phase 5 — Payments: Apple IAP on iOS, Stripe on web (B3)

Code done 2026-10-11 (StoreKit 2 direct, `StoreKitPlugin.swift` + `appleJws.ts`). One entitlement,
two rails: a web subscriber is Pro on iOS and vice versa (3.1.3(b)). Manual steps left, in order:
**`docs/ios/APP_STORE_IAP_SETUP.md`**.

- [ ] **5.1** *(APP_STORE_IAP_SETUP §2–3)* Subscription group + `pro.monthly` / `pro.yearly`
      products, prices, localizations, review screenshot, 7-day intro offer. Products must be in
      "Ready to Submit" or review will fail with "IAP not found".
- [ ] **5.10** *(APP_STORE_IAP_SETUP §7)* Sandbox-test: subscribe, renew, cancel, restore after
      reinstall, expiry — with a Sandbox Apple Account, not your real one.

**Exit criteria:** a TestFlight build where a sandbox user can buy Pro, close the app,
reinstall, tap Restore, and still be Pro — and where a web-Stripe Pro account is Pro on iOS.

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
      Run the QA of `STATUS.md` §3.7 on a real iPhone.
- [ ] **9.2** External TestFlight (needs a light Beta App Review) — 10–20 testers, one week.
      This is where you find the WebView bugs a desktop browser never shows you.
- [ ] **9.3** Fill **App Review Information**: a working **demo account** (email + password) —
      reviewers will not sign up, and an app with no demo account is an automatic
      "Guideline 2.1 — Information Needed".
      Use the account and text of `docs/ios/APP_REVIEW_NOTES.md` — it must be a **free** account so
      the reviewer can test the purchase (`APP_STORE_IAP_SETUP.md` §8).
- [ ] **9.4** Paste the **review notes**: final text in `docs/ios/APP_REVIEW_NOTES.md`.
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

## 12. What is left, in order

| Step | Focus |
|------|-------|
| 1 | Phase 4 set-up and tests on the iPhone (push, widget, share sheet, universal links) |
| 2 | Phase 5 manual IAP steps + Sandbox test |
| 3 | Store assets + metadata, R18 decision, age rating / privacy labels typed in (Phases 1, 8) |
| 4 | External TestFlight round, fixes (9.1–9.2) |
| 5 | Submit → expect one rejection → resubmit (9.3–9.7) |
| later | iPad, Android |

---

## 13. Definition of done

- App live on the App Store, 18+ rated, Sports category
- A user can: install → sign up → see predictions → subscribe via IAP → restore purchases
  → delete their account, all without leaving the app
- A web Stripe subscriber is Pro on iOS with no extra payment
- No bookmaker or affiliate link anywhere in the iOS binary or metadata
- `main` pushes build and ship to TestFlight automatically

---

## 14. Open question

- Android/Play Store — same Capacitor project, later, and Google's gambling rules differ.

---

## 15. Sources

- [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Guideline 5.3 — Gaming, Gambling, and Lotteries](https://developer.apple.com/app-store/review/guidelines/#gaming-gambling-and-lotteries)
- [Apple Developer Program enrollment](https://developer.apple.com/support/enrollment/)
- [Upcoming SDK minimum requirements (Xcode 26, 28 Apr 2026)](https://developer.apple.com/news/upcoming-requirements/)
- [StoreKit external purchase entitlements](https://developer.apple.com/documentation/storekit/external_purchase)
