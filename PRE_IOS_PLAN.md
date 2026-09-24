# PRE_IOS_PLAN.md — Web-side work to do before touching Capacitor

> **✅ COMPLETED — kept as a design record (2026-09-24).** R7, R2, R3, R3bis and R4 are
> shipped. About twenty source files cite this document for the reasoning behind the auth
> and moderation code, which is why it stays. The only open items (prove the support
> mailbox, then `git tag pre-ios-freeze`) are tracked in **`STATUS.md` §3.1**. Do not add
> new work here.

**Companion to `APPLE_PLAN.md`.** Everything here ships to **arakice.com first**, makes the
web app better on its own merits, and removes the four things that would otherwise blow up
during the iOS port.

**Nothing in this document installs a native dependency.** No Capacitor, no Xcode, no Apple
account needed. You can do all of it today, in a browser, with your normal dev loop and your
normal Vercel deploy. That is the whole point: debug it where you can actually debug it.

| Ref | Work | Effort | Web benefit |
|-----|------|--------|-------------|
| **R7** ✅ | Fail loudly on missing/invalid env URLs | 0.5 day | Fixes a real production bug: a missing Vercel env var currently makes the app silently call `localhost` |
| **R2** ✅ | Platform flag layer (prepares "no Google login on iOS") | 0.5 day | Zero visible change on web; one honest seam instead of `if (iOS)` scattered later |
| **R3** ✅ | Token transport abstraction | 1 day | Shipped, plus R3bis (the refresh stampede) in both halves |
| **R4** ✅ | Chat moderation: report, block, filter | 3–5 days | Shipped 2026-09-04. 🔴 One piece left: the published support address still bounces (R4.0) |

**Total: 5–7 working days.** Do them in this order — each one is independently shippable.


---

## ⚠️ Impact on the live web app — read before deploying

Honest per-item answer, not a blanket "it's fine".

| Ref | Changes web behaviour? | Regression risk |
|-----|------------------------|-----------------|
| **R7** | **Yes — deliberately.** A missing/invalid env var goes from *silent fallback* to *hard failure*. | **Medium** — the only item that can take the site down, and only if prod env is already wrong |
| **R2** | No. Every flag is `true` when `VITE_TARGET` is unset, which is the web build. | **Low** — a typo turning one flag off is the only failure mode |
| **R3** | No. The server change is opt-in behind `X-Client: native`; without that header the cookie path runs unchanged. | **Highest of the four** — it is the auth layer, and the client refactor touches every call site |
| **R4** | Additive, with one exception: the profanity filter will start rejecting messages that used to post. | **Low** — new tables, new endpoints, new UI |

### The one real hazard: R7 and your Vercel env

`client/.env.production` is **gitignored** (`client/.gitignore:4`), so Vercel does not build
from it — it builds from the variables set in the **Vercel dashboard**, which this plan
cannot inspect.

Your local `.env.production` does have all four URLs, all `https://`. That is a good sign,
not a guarantee that Vercel's copy matches.

**Ship R7 in two stages:**

1. **Stage 1 — warn only.** `console.error` + a Sentry message instead of `throw`. Deploy.
   Watch Sentry for 24h. If a variable is missing in the Vercel environment, you find out
   from a log, not from a white screen for every visitor.
2. **Stage 2 — throw.** Only once stage 1 has been quiet for a day.

`VITE_SENTRY_DSN` is absent from your production env — keep it **optional** in `env.ts`
(the sketch already does). Do not let this plan turn a missing analytics DSN into an outage.

### Guarding R3

The auth layer is where a small mistake logs everyone out. Before deploying:

- The vitest case from **R3.3** must pass: `X-Client: native` → token in body, no
  `Set-Cookie`; no header → `Set-Cookie`, no token in body.
- Manually, on the preview deploy: register, log in, hard-refresh, wait past the 15-minute
  access-token expiry, confirm a silent refresh, log out, log back in, "remember me" across
  a browser restart, and the Google login path.
- Deploy R3 alone, on a day you can watch it. Not stacked with R4.

### Guarding R4

- The profanity filter is the only part that changes existing behaviour. Run it over your
  **existing** `chat_messages` rows first and look at what it would have blocked — hockey
  talk trips naive word lists constantly ("shoot", team nicknames, French slang).
  Tune the override list before it is live, not after your users complain.
- Everything else is additive: new tables, new endpoints, new buttons.

### What cannot break

- No change to prediction maths, ML, NHL data ingestion, odds, slips, leaderboard, SEO
  shells, `vercel.json`, CSP, or the Stripe flow.
- `platform.ts` is forbidden from reaching business logic (rule in R2), so the web and iOS
  builds cannot diverge in what they compute — only in what they show.
- No native dependency is installed, so `npm run build` and the Vercel pipeline are the
  same command producing the same kind of output as today.

**Bottom line:** R2 and R4 are safe. R3 is safe if you test the auth loop before shipping.
R7 is the one that needs the two-stage rollout, because its whole purpose is to fail loudly.

---

## Order and why

1. **R7 first.** It is half a day and it will immediately tell you if your production env is
   already wrong. Cheap, and it de-risks everything after it.
2. **R2 second.** It is the seam every later change plugs into. Do it before R3 and R4 so
   those land on the right side of it.
3. **R3 third.** Auth touches everything; do it while the app is still web-only and you can
   watch the network tab.
4. **R4 last.** It is the biggest and the most self-contained, and it is the one you can
   ship to web users as an actual announcement.

Ship each one to production separately. Four small deploys, not one scary one.

---

## R7 — Stop falling back to `localhost` (0.5 day)

### The bug you have right now

```ts
// client/src/app/hooks/useChatSocket.ts:18
const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3001';
// client/src/app/services/authService.ts:225
const serverBase = import.meta.env.VITE_PROFILE_API_URL?.replace(...) || 'http://localhost:3001';
```

Four variables do this: `VITE_NHL_API_URL`, `VITE_PREDICTION_API_URL`,
`VITE_PROFILE_API_URL`, `VITE_SOCKET_URL`. If any one is missing from a Vercel deploy, the
built app quietly tries to reach the user's own machine. In a browser you get console errors
and an empty page. On iOS, ATS blocks cleartext HTTP entirely and you get a blank screen with
no clue why. **This is a web bug first and an iOS bug second.**

### Work items

- [x] **R7.1** Create `client/src/app/env.ts` — one module, validated once, at import time:

```ts
// client/src/app/env.ts
function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`[env] ${name} is not set. Check .env / Vercel env vars.`);
  if (import.meta.env.PROD && !value.startsWith('https://')) {
    throw new Error(`[env] ${name} must be https:// in production, got: ${value}`);
  }
  return value.replace(/\/$/, '');
}

export const env = {
  nhlApiUrl:        required('VITE_NHL_API_URL',        import.meta.env.VITE_NHL_API_URL),
  predictionApiUrl: required('VITE_PREDICTION_API_URL', import.meta.env.VITE_PREDICTION_API_URL),
  profileApiUrl:    required('VITE_PROFILE_API_URL',    import.meta.env.VITE_PROFILE_API_URL),
  socketUrl:        required('VITE_SOCKET_URL',         import.meta.env.VITE_SOCKET_URL),
  sentryDsn:        import.meta.env.VITE_SENTRY_DSN as string | undefined, // optional
} as const;
```

In dev, `import.meta.env.PROD` is false, so `http://localhost:3001` in your `.env` still
works. Only production is strict.

- [x] **R7.2** Replace every direct `import.meta.env.VITE_*_URL` read with `env.*`:
      `services/nhlApiService.ts:17`, `services/predictionApiService.ts:33`,
      `services/oddsApiService.ts:7`, `services/injuriesAdminService.ts:8`,
      `services/authService.ts:225`, `hooks/useChatSocket.ts:18`, and anywhere else
      `grep -rn "import.meta.env.VITE_" client/src` finds.
- [x] **R7.3** Add a `check:env` npm script that runs the same validation against a built
      `dist/` and wire it into `.github/workflows/ci.yml`, so a bad env fails **CI**, not
      a user's phone.
- [x] **R7.4** Update `client/.env.example` with all five variables and a one-line comment
      each. Verify `client/.env.production` actually has them.
- [x] **R7.5** Render the thrown error as a readable screen instead of a white page —
      wrap the root render in a try/catch that shows "Configuration error" plus the message.

**Done when:** deleting `VITE_SOCKET_URL` from `.env.production` makes the build or the boot
fail with a message naming that variable — instead of silently pointing at localhost.

### ✅ Shipped 2026-09-03 — commit `2cc2ce4`

Stage 1 (`warn`) deployed alone. The four production variables were confirmed present in the
Vercel dashboard, `api.arakice.com/health` answered 200, and Sentry recorded no `[env]` event.
`VITE_SENTRY_DSN` was added at the same time, so the warn stage had a real reporting channel.
Stage 2 (`throw`) followed in a second deploy.

Three deliberate departures from the sketch above:

1. **The throw moved out of import time.** A module that throws while being evaluated cannot
   be caught by the module importing it, so `env.ts` throwing at import would have produced
   exactly the white page R7.5 exists to remove. `env.ts` collects problems into
   `envProblems`; `main.tsx` calls `assertEnv()` inside a `try/catch` and renders the
   configuration screen. One constant, `ENFORCEMENT`, still switches warn ↔ throw.
2. **The full variable check runs in Vercel's build command, not in GitHub Actions.**
   `npm run check:env && npm run build`, set in Build & Development Settings. GitHub Actions
   deploys nothing; duplicating the four URLs into repo variables would have created a second
   source of truth that can drift from Vercel in silence. A failed Vercel build leaves the
   previous deployment live — the safest failure mode available. CI keeps `check:env:dist`,
   which needs no variables and catches a re-added localhost fallback.
3. **The bundle scan matches `localhost:<port>`, with the port.** react-router ships
   `new URL("http://localhost")` as a parsing base, so matching a bare `http://localhost`
   flags every build.

Also fixed in passing: `i18n/index.tsx` told production visitors to check that the backend was
running on `localhost:3001` when the stats failed to load. Reworded, EN + FR.

Still true and worth knowing: `client/.env.production` is gitignored **and was never committed**
(`git ls-files` returns nothing for it). It configures local production builds and `check:env`.
It has never configured the deployed site, and it never will.

---

## R2 — The platform seam (0.5 day)

You decided: **no Google Sign-In in the iOS app.** That kills the Sign in with Apple
requirement (Guideline 4.8) and the WebView OAuth problem (R1) in one move.

The iOS side of that is later. What you build **now** is the switch it hangs off — and
deliberately **without Capacitor**, so this stays a pure web change.

- [x] **R2.1** Create `client/src/app/platform.ts`:

```ts
// client/src/app/platform.ts
// Build-time target. 'web' unless the iOS build sets VITE_TARGET=ios.
// Deliberately NOT importing @capacitor/core yet — this stays dependency-free
// until Phase 3 of APPLE_PLAN.md. A literal comparison also lets Rollup
// dead-code-eliminate the disabled branches from the iOS bundle.
const TARGET = (import.meta.env.VITE_TARGET ?? 'web') as 'web' | 'ios';

export const isWeb = TARGET === 'web';
export const isIOS = TARGET === 'ios';

/** The single place where web and iOS are allowed to differ. */
export const features = {
  googleLogin:    isWeb,  // R2 — Guideline 4.8: no third-party login on iOS
  bookmakerLinks: isWeb,  // APPLE_PLAN §4 — Guideline 5.3
  stripeCheckout: isWeb,  // APPLE_PLAN §7 — Guideline 3.1.1
  byokOpenAI:     isWeb,  // APPLE_PLAN R8 — 3.1.1 grey zone
  webPush:        isWeb,  // R6 — iOS uses APNs
  serviceWorker:  isWeb,  // R6 — no SW in WKWebView
  devRoutes:      isWeb,  // R17 — hide /dev/ml on iOS
} as const;
```

- [x] **R2.2** Wire the Google button: `pages/LoginPage.tsx:153` and its markup behind
      `{features.googleLogin && ...}`. **On web nothing changes** — `VITE_TARGET` is unset,
      so `isWeb` is true and every flag is on.
- [x] **R2.3** Same guard on `pages/AuthCallback.tsx`'s route registration in `routes.tsx`
      (dead route on iOS).
- [x] **R2.4** Add `VITE_TARGET=web` to `client/.env.example` with a comment explaining that
      `ios` is set only by the iOS build script.
- [x] **R2.5** Wire the remaining flags at their call sites now, while the map is fresh —
      `services/bookmakers.ts`, `pages/ProPage.tsx:64`, `pages/profile/SettingsTab.tsx:368`,
      `main.tsx:21` (service worker), `services/pushService.ts`, `routes.tsx:106`.
      They all evaluate to the current behaviour on web. This is the moment to do it:
      later, each one is a separate archaeology session.

**Rule that keeps this honest:** `platform.ts` may only be imported by UI components,
services and route config. **Never** by prediction maths, API parsing, or anything in
`types/`. The day a feature flag reaches your model layer, web and iOS have genuinely
forked and you have lost the benefit of one codebase.

**Done when:** `npm run build` output is byte-identical in behaviour to today, and
`VITE_TARGET=ios npm run build` produces a bundle with no Google login path left in it.

### ✅ Shipped 2026-09-03 — R2.1 through R2.5

`client/src/app/platform.ts` created; the flags wired at all eight call sites. Nothing on
web changes: `VITE_TARGET` is unset there, so every flag is `true` and every branch is the
one that already ran.

| Flag | Where it landed | What the iOS build loses |
|------|-----------------|--------------------------|
| `googleLogin` | `LoginPage.tsx` (button + its "or" divider), `routes.tsx` (`/auth/callback` spread) | the Google button, the divider above the form, and the callback route's chunk |
| `bookmakerLinks` | `services/bookmakers.ts` (`openUrl` guard), `landing/LandingCards.tsx` (`OddsPill` + the no-odds "bet on" fallback), `bet/betParts.tsx` ("Place bet"), `profile/SettingsTab.tsx` (book selector) | every link out to a sportsbook — **the odds themselves stay**, as a static pill without the book's name |
| `stripeCheckout` | `ProPage.tsx` (`handleUpgrade` guard, price card, both upgrade CTAs) | the price and the two Stripe buttons. The free trial, the promo code and cancel stay — APPLE_PLAN §7 decides what replaces them |
| `byokOpenAI` | `profile/SettingsTab.tsx` | the whole AI Settings card |
| `webPush` | `profile/SettingsTab.tsx` | the whole Notifications card (its only content is the Web Push toggle and its EV threshold) |
| `serviceWorker` | `main.tsx` | the `/sw.js` registration |
| `devRoutes` | `routes.tsx` | `/dev/ml` and the DevMLDashboard chunk |

Four things worth knowing, because they depart from the sketch above:

1. **The done-when marker in the original sketch was wrong.** `accounts.google` never
   appears in the client bundle — the consent screen is the *server's* redirect. The client
   only ever builds `${profileServerUrl}/api/auth/google` in `authService.getGoogleLoginUrl()`.
   The real check is therefore:
   `VITE_TARGET=ios npm run build && grep -c "api/auth/google" client/dist/assets/*.js` → 0,
   and no `AuthCallback` chunk in `dist/assets`.
2. **`platform.ts` reads `import.meta.env` directly, and that is deliberate.** R7 made
   `env.ts` the single reader, and `.env.example` says so. `VITE_TARGET` is the one
   documented exception, noted in both files: it is not configuration to validate but the
   build target itself, and routing it through an object property in `env.ts` would kill the
   constant folding that makes the disabled branches *disappear* rather than ship behind a
   runtime `if`. There is no fallback to get wrong — anything that is not the literal `ios`
   is the web build.
3. **The two dead routes are removed by array spread, not by rendering `null`.** A route
   object that still mentions `<AuthCallback />` keeps the `lazy(() => import(...))` call
   alive, and Rollup emits the chunk. `...(features.googleLogin ? [{...}] : [])` folds to
   `[]`, the reference dies, and the chunk is never produced.
4. **`openUrl()` in `bookmakers.ts` got a guard of its own.** The UI hides every entry point,
   but Guideline 5.3 is not the place to rely on remembering. A call site added six months
   from now cannot re-open a sportsbook inside the app.

Verified statically only — `ts.createSourceFile` parse diagnostics plus relative-import
resolution over the nine touched files, clean. **The two builds have not been run** (they
cannot run in this sandbox: `node_modules` is installed for Windows). Before shipping:
`npm run check:env && npm run build` for the web bundle, then the `VITE_TARGET=ios` grep
above.

---
## R3 — Token transport abstraction (1 day)

### Good news from the audit

Your server is **already half-ready**. `server/src/routes/auth.routes.ts:147`:

```ts
const raw = req.cookies?.[REFRESH_COOKIE] || req.body?.refresh_token;
```

`/auth/refresh` and `/auth/logout` already accept a refresh token in the body as a legacy
fallback, and `RefreshBody` already exists in `types/user.type.ts:96`. The only thing missing
is the **outbound** half: `publicTokens()` strips `refresh_token` from every response, so a
non-cookie client can never obtain one.

So this is not a rewrite. It is one server flag plus one client abstraction.

### Why the cookie cannot work on iOS

`setRefreshCookie` uses `sameSite: 'none'` + `secure` in production (correct for Vercel front
+ Railway API). From a `capacitor://localhost` origin that is a cross-site cookie, and
WKWebView's tracking prevention drops it. Access tokens last 900s, so the user is silently
logged out every 15 minutes with no way to recover. Cookies stay the web mechanism; native
needs the token in hand.

### Work items — server

- [x] **R3.1** Add an opt-in native mode to `/auth/register`, `/verify-email`, `/login`,
      `/refresh` and the Google callback: when the request carries `X-Client: native`,
      return the **full** token object (including `refresh_token` and
      `refresh_expires_in`) instead of `publicTokens(...)`, and skip `setRefreshCookie`.
      Keep the cookie path as the default so **web behaviour is untouched**.
- [x] **R3.2** Keep rotation exactly as it is — `AuthService.refreshTokens()` already revokes
      the old token, and `refresh_tokens` / migration `021_refresh_token_hash.sql` already
      store hashes. Native gets the same guarantees, no new attack surface.
- [x] **R3.3** Add a test in the existing vitest suite: a request with `X-Client: native`
      receives `refresh_token` in the body and **no** `Set-Cookie`; a request without it
      receives a `Set-Cookie` and **no** `refresh_token`. That single test is what stops a
      future refactor from leaking refresh tokens to browsers.

### Work items — client

- [x] **R3.4** Create `client/src/app/services/tokenStore.ts` — one interface, two impls:

```ts
// Web: access token in localStorage, refresh token lives in the httpOnly cookie.
// Native (later): both in @capacitor/preferences, Keychain-backed.
export interface TokenStore {
  getAccess():  Promise<string | null>;
  setTokens(access: string, refresh?: string): Promise<void>;
  getRefresh(): Promise<string | null>;   // web: always null — the cookie has it
  clear():      Promise<void>;
}
```

- [x] **R3.5** Rewrite `tryRefresh()` in `services/authService.ts:63` to go through the store:
      web keeps `credentials: 'include'` and sends no body; native (later) sends
      `X-Client: native` and `{ refresh_token }`. **Same function, one branch.**
- [x] **R3.6** Make the whole store async now, even though the web impl is synchronous
      underneath. Capacitor Preferences is promise-based; doing this later means touching
      every call site twice.
- [x] **R3.7** Delete the `LEGACY_REFRESH_KEY` cruft (`authService.ts:16,22,27`) — it has
      done its migration job and it is now just a footgun.
- [x] **R3.8** Fix a real web bug while you are in here: a failed refresh calls `clearTokens()`
      but nothing redirects to `/login`, so the UI sits there rendering 401s. Have the store's
      `clear()` emit an event the auth context listens for.

**Done when:** on web, log in → wait past the 15-minute access-token expiry → the next
request silently refreshes and succeeds, exactly as today; and the vitest case for
`X-Client: native` passes.

### ⏳ Implemented 2026-09-03 — written, not yet verified

Code is in. **Nothing has been run**: the sandbox cannot execute vitest for this repo
(`node_modules/rollup` resolves to the Windows binary), so verification is entirely on the
Windows side. Until the checklist at the bottom is green, R3 is not shipped.

**Server** — `routes/auth.routes.ts`. Two new helpers, `isNativeClient()` and `sendTokens()`;
`/register` (bypass branch), `/verify-email`, `/login` and `/refresh` now call `sendTokens()`
instead of `setRefreshCookie()` + `publicTokens()`. Without `X-Client: native` the code path
is byte-for-byte what ran before, plus a `Vary: X-Client` header.

**Client** — new `services/tokenStore.ts`; `authService.ts`, `context/AuthContext.tsx`,
`hooks/useChatSocket.ts`, `services/injuriesAdminService.ts` and `services/ruleWeightsService.ts`
now read the session through it.

Five departures from the sketch above, each deliberate:

1. **`X-Client: native` is refused from a browser origin.** This is the one thing the sketch
   missed, and it matters: `X-Client` is a *request header*, so an XSS on arakice.com could
   have set it, asked `/auth/refresh` for native mode and read the refresh token straight out
   of the JSON body — the httpOnly cookie exists precisely so that JS can never do that.
   `isNativeClient()` therefore also requires the request **not** to carry an `http(s)` Origin.
   Browsers send `Origin` on every POST, including same-origin ones; a Capacitor shell sends
   `capacitor://localhost` or none. Matching on the *scheme* rather than on the CORS allow-list
   is deliberate — Phase 3 must add the Capacitor origin to `CORS_ORIGIN`, and an allow-list
   check would then silently demote native back to the cookie path.
2. **No native branch on the Google callback**, though R3.1 listed one. It is a browser
   redirect, not a fetch, so there is no request header to opt in with — and R2 removed Google
   Sign-In from the iOS build entirely (Guideline 4.8), so nothing native ever reaches it.
3. **`tryRefresh()` branches on the store, not on the platform.** `getRefresh()` returns null
   on web forever, so the browser takes the cookie path with no platform check anywhere in the
   auth layer. One branch, and the flag that drives it is a fact about the session rather than
   a build constant.
4. **R3.7 left one line of the legacy key.** Deleting `LEGACY_REFRESH_KEY` outright would have
   stranded a real refresh token in the localStorage of anyone who last signed in before the
   cookie migration. `tokenStore.ts` sweeps the key once on load and no logic reads it. Safe to
   delete for good in 2027.
5. **R3.8 needed no navigation code.** `clear()` emits, `AuthContext` drops the user, and the
   existing `Protected` guard already redirects to `/login?returnTo=…` — so a failed refresh
   signs you out in place and only bounces you if you were on a page that needs an account.
   Nobody gets thrown off `/stats`.

Also worth knowing: `ensureFamilyWeightsHydrated()` now assigns its `hydrating` memo **before**
the first `await`. The sign-in check became async, and testing it before memoising would have
let two concurrent callers both fetch the profile.

**Verification checklist:**

- [x] `cd server && npm test` — **161/161 green**, `auth.routes.test.ts` 6/6 including the XSS
      guard (native header *from* a browser origin → cookie, no token in the body).
- [x] `cd server && npm run typecheck` and `npm run build` — both exit 0.
- [x] `cd client && npm run check:env && npm run build` — both pass. **`npm run typecheck` was
      not on this list and it should have been** (see below).
- [x] The full loop from "Guarding R3" above — run **on production**, not on a preview
      (see "What actually happened" below): login sets the cookie with no token in the body,
      `Vary: X-Client` present, silent refresh + replay, clean sign-out on a dead refresh,
      logout, Google login, `Max-Age` 30 days with "remember me", and the chat socket
      reaching 101.
- [x] Deployed and watched. **Not alone, though** — R2 and R3 shipped in the same deploy.

### ✅ R3 shipped 2026-09-03 — production, commit `551aca0`

Server and client are both live; `Vary: X-Client` on `/auth/login` is the one-glance proof
that the R3 server is the one running, and the bundle hash is the proof for the client.

**What actually happened, versus what this section told you to do:**

- **No preview stage.** The commit went straight to production on both halves. It passed, but
  the sequencing the plan asked for did not happen — worth knowing before trusting the next
  "deploy to a preview first" instruction in this document.
- **R2 and R3 rode the same deploy.** The "four separate deploys" in the definition of done is
  now three: R7, then R2+R3 together. If auth had broken, R2 would have been rolled back with
  it for no reason.
- **A preview would have been a bad test anyway**, and this is the part worth keeping:
  `api.arakice.com` and `arakice.com` share a registrable domain, so `ice_refresh` is a
  *same-site* cookie in production. On `ice-edge-*.vercel.app` it becomes a **third-party**
  cookie — Safari blocks it outright, Chrome blocks it in private windows. The refresh loop
  would have failed for a reason with nothing to do with R3. Test auth on the real domain, or
  in a Chrome window with third-party cookies allowed.

**Two checklist items in this document were wrong, and both cost time:**

1. **"hard-refresh … confirm the silent refresh" conflates two paths.** `AuthContext`
   rehydrates from the localStorage access token and decodes the JWT *without checking its
   expiry* — it never calls `/auth/refresh` on load. F5 proves nothing about refreshing.
   The refresh only fires on the first 401 from `authedFetch`.
2. **The 15-minute wait is unnecessary.** Edit `ice_access` in localStorage and change one
   character in the **third** segment (the signature). The payload still decodes, so the app
   believes it is signed in; the server rejects the signature; the 401 path runs. Same
   scenario, ten seconds. Use this in every future auth item.

Running that shortcut is what surfaced **R3bis** below — three concurrent `/auth/refresh`
where there should be one.

#### Ran 2026-09-03 in the cloud sandbox — and how

The Windows `node_modules` is what blocks vitest and tsc in the Linux bridge VM. The cloud
container has network, so a **fresh Linux install of the same lockfile** runs both for real:
tar `server/{src,package.json,tsconfig.json,vitest.config.ts}` (and the client equivalent) into
the container, `npm ci`, run. The resolved versions were checked against `package-lock.json`
(vitest 2.1.9, typescript 5.9.3, express 4.22.2 — identical), so the run is representative.
`client/vitest.setup.ts` must be recreated: it is not under `src/`.

#### Two defects this actually caught

1. **`client && npm run typecheck` failed** — `AuthContext.tsx:70` read `result.tokens
   .refresh_token`, but `AuthResult.tokens` in `authService.ts` declared only
   `{ access_token, expires_in }`. The client build is `vite build` (esbuild strips types
   without checking them), so **no build would ever have caught this** — R3 would have shipped
   with a type that lies about the native response shape. Fixed: the two native-only fields are
   now declared optional. **Add `npm run typecheck` to the client checklist for every item.**
2. **R2's `AuthCallback` chunk was still emitted in the iOS build.** Removing the route by array
   spread is *not* sufficient, contrary to the note in the R2 section: `lazy()` runs at module
   scope, so Rollup keeps the `import()` alive. The binding itself now folds to `null` on iOS.
   Verified both ways: `VITE_TARGET=ios` → no `AuthCallback-*.js` and 0 `api/auth/google`;
   web → chunk present and 1 `api/auth/google`. R2's "done when" passed *before* this fix too
   (the chunk carried no Google URL), so this is tidiness, not a 4.8 risk.

---

## R3bis — The refresh stampede (found 2026-09-03, NOT part of R3)

Observed on production while running the R3 loop: breaking the access token and loading
`/profile` produced **one 401 and three `POST /auth/refresh`, all three returning 200**.
This is not an R3 regression — it reproduces on the pre-R3 build. It is two independent
defects that compound, and the order in which they are fixed matters enormously.

**Client — `tryRefresh()` has no in-flight coalescing.** `/users/me` and `/subscription/me`
are in flight together; each takes a 401, each calls `tryRefresh()` on its own. N concurrent
401s produce N refreshes.

**Server — `refreshTokens()` rotation is not atomic** (`auth.service.ts:485`):

```
SELECT * FROM refresh_tokens WHERE token=$1 AND revoked=FALSE AND expires_at>NOW()
UPDATE refresh_tokens SET revoked=TRUE WHERE id=$1
```

Three concurrent callers all read `revoked=FALSE` before any UPDATE commits, so **all three
succeed and one refresh token becomes three**, each valid 7–30 days. The last `Set-Cookie`
wins; the other two sit in the table, orphaned but live. Nobody is logged out today, but
every silent refresh leaves two extra long-lived credentials behind.

### ⚠️ Do not fix the server first

Make the rotation atomic without coalescing the client, and two of the three calls start
returning 401 → `tryRefresh` hits its `catch` → `tokenStore.clear()` → **the user is signed
out on every silent refresh**. A cosmetic defect becomes an auth outage. R3.8 makes this
*more* visible, not less: a failed refresh now drops the user immediately instead of leaving
the old UI rendering 401s.

- [x] **R3bis.1 — client first. ✅ Shipped and verified in production 2026-09-03.**
      Observed on arakice.com after the deploy: three 401s (`stats`, `me`, `me`) followed by
      **one** `/auth/refresh` and three successful replays. Before: three refreshes.
      `authService.ts`:
      `tryRefresh()` is now a gate over `doRefresh()`, holding a module-level
      `inFlightRefresh: Promise<boolean> | null` cleared in `.finally()`. Three concurrent
      401s produce one refresh.

      Proven, not asserted: a throwaway vitest suite run in the cloud sandbox against the
      real module asserts 1 refresh for 3 concurrent callers, and `clear()` called once
      rather than per-caller on a failed refresh. Reverting the gate makes it fail with
      **"expected 3 to be 1"** — the exact number seen in production. The suite was not
      committed: `client/` has no test runner at all (no vitest in its devDependencies, no
      `test` script), and adding one is its own decision. See the note below.

      **How it was accepted:** the shortcut from the R3 section — break the signature of
      `ice_access`, F5, load `/profile`. The 401s stay plural (each call takes its own before
      the refresh lands); it is the `refresh` count that must drop to one.
- [x] **R3bis.2 ✅ 2026-09-04 — atomic rotation with a grace window.** Migration `033`
      (`rotated_at`), then one statement:
      `UPDATE … SET revoked = TRUE, rotated_at = NOW() WHERE token = $1 AND revoked = FALSE
      RETURNING *`. Among N concurrent callers exactly one gets a row back.

      **The grace window is what makes atomicity safe**, and it is three mechanisms, not one:

      1. **The winner's promise is registered before it is awaited.** This is the piece that
         actually carries the concurrent case, and the first design got it wrong: a loser
         arriving *while* the winner is still issuing found nothing cached, and saw a session
         with **zero** live tokens — the old one revoked, the new one not yet inserted. Storing
         the in-flight promise lets the loser await it and receive the winner's pair,
         byte-for-byte. It is the server-side twin of R3bis.1's client gate. **A test caught
         this, not a review.**
      2. **A database fallback** for the process that restarted or the second Railway instance:
         if `rotated_at` is within 10 s, issue a *fresh* pair rather than a 401. ⚠️ That does
         create a second live token — but only inside 10 s of a legitimate rotation, where the
         old bug allowed unlimited siblings at any time. Deliberate trade: nobody is ever
         signed out.
      3. **`sessionStillAlive()`** — without it the grace window would reopen a closed session:
         after `logoutAll`, a tab replaying its old token 5 s later would get a new pair, and
         "log out of all devices" would not. Note the ordering: the loser **awaits the pair
         first, then** checks liveness. The reverse fails in exactly the concurrent case.

      A logout revokes **without** setting `rotated_at`, which is precisely what keeps a
      logged-out token out of the window. Nine vitest cases in `authRefresh.test.ts`, plus the
      real thing against a throwaway PostgreSQL: two genuinely concurrent calls return the same
      pair and create one token.

---

## ▶ RESUME HERE — state as of 2026-09-04

**Everything in this plan is written, tested and deployed.** R7, R2, R3, R3bis (both halves)
and R4 are in production. Migration `033` is applied to Neon. R4 was walked on the live site
on 2026-09-04: the filter refuses a slur and lets `assist` through, a blocked person's live
message never renders, and the admin queue reports → hides correctly.

### The only thing left before the tag

🔴 **Prove the support address delivers.** `support.arakice@gmail.com` is in the code as of
2026-09-04 and is served on Support, Privacy and Terms whether or not the environment variables
are set. What has *not* been done is the only test that matters: **send a real mail to it and
confirm it arrives, and that you can open the mailbox.** The address this replaced failed
exactly that test — published for months, readable by nobody. See R4.0, which also records the
separate developer-contact address for App Store Connect.

Then `git tag pre-ios-freeze` and open `APPLE_PLAN.md` at Phase 0.

### Still open on purpose, and not blocking the tag

- **R4.4's two unwalked cases**: unblock restoring visibility, and auto-hide at three distinct
  reporters (needs a third account). Both are covered by tests.
- **`client/` has no test runner.** Its only guard is `npm run typecheck`, which is why the
  socket block filter (see R4, decision 7) has nothing watching it.
- **Nothing applies migrations automatically** — no `railway.json`, no Procfile, no step at
  start-up. `cd server && npm run db:migrate:all`, by hand, against Neon, **before** deploying
  code that depends on a new column.

### Facts about this environment that will save you an hour

- **Neither shell can reach Neon or arakice.com** (egress). Anything touching the live database
  or site is run by you, in your own terminal. The Vercel connector *can* fetch arakice.com and
  returns the served headers.
- **`npm test` / `tsc` / `npm run build` cannot run on your machine through the bridge** —
  `node_modules` is installed for Windows. They DO run in the cloud container: tar the sources
  across, `npm ci`, run. Compare `md5sum` on both sides before believing a result.
- **A migration can be executed for real** against a throwaway PostgreSQL 16 in the cloud
  container before it ever touches Neon. That is how 032 and 033 were validated.
- **`git diff --stat` on the mount times out.** Verify an edit by re-reading the file.
- **`remote.origin.fetch` is empty** in this clone, so there are no remote-tracking branches and
  `git status` never says ahead/behind. Do not read that as "never pushed".
- **⚠️ Removing a route from the table does NOT remove its chunk.** `lazy()` runs at module
  level, so Rollup keeps the `import()` alive. Only `const X = flag ? lazy(...) : null` makes it
  disappear. This trap has caught three things: `AuthCallback`, `DevMLDashboard`, and it would
  have caught `ModerationQueuePage`.
- **⚠️ The hard-refresh does not test the refresh**, and the 15-minute wait is unnecessary:
  change one character of the **third segment** of `ice_access` in localStorage (the signature).
  The payload still decodes, the app believes it is signed in, the server rejects, and the 401
  path runs. Ten seconds instead of fifteen minutes. Reuse it for any auth item.

### Decisions already taken — do not relitigate without a reason

- Reports cascade away with the message; the block routes carry no `requireOwnerOrAdmin`; the
  block list is one-way; a hidden message is hidden for its author too. All of R4's decisions
  are listed in that section.
- R3bis.2's grace window is three mechanisms, not one — read its item before touching the
  rotation.

---

## R4 — Chat moderation ✅ shipped and verified in production 2026-09-04

Guideline 1.2 asks four things of user-generated content. Three are done and were
walked on the live site; the fourth is the one still open.

| Apple requires | Status |
|----------------|--------|
| A filter for objectionable material | ✅ verified — a slur is refused with a visible reason; `great assist by Suzuki` posts |
| A way to report content | ✅ verified — report → admin queue → hide, end to end |
| A way to block abusive users | ✅ verified — including a live socket message that never renders |
| Published contact info | ✅ `support.arakice@gmail.com` is in the code and served — **one thing left, see R4.0** |

Unblock was walked too (2026-09-04). The one case never seen on screen is **auto-hide at
three distinct reporters** — it needs a third account. It is covered by tests and was proven
against a real PostgreSQL.

### R4.0 — the support address ✅ set 2026-09-04

**There are two different addresses, for two different jobs. Do not merge them.**

| Purpose | Address | Where it lives |
|---------|---------|----------------|
| Published support + abuse reports (Guideline 1.2) | `support.arakice@gmail.com` | **In the code** — Support, Privacy, Terms and outgoing mail |
| Developer contact — how Apple reaches you | `ireinahedad24@gmail.com` | **App Store Connect only**, never in the app |

The second one is a store-listing field entered at `APPLE_PLAN.md` Phase 0. Putting it in the
app would publish a personal mailbox to every visitor, which is not what a contact address on a
public site is for.

`support.arakice@gmail.com` is now the fallback in `client/src/app/env.ts` and
`server/src/services/email.service.ts`, so the published contact works whether or not the
environment variables are set. `VITE_SUPPORT_EMAIL` (Vercel) and `SUPPORT_EMAIL` (Railway) stay
available to change it later without a deploy — two variables and not one because the client is
a static bundle built by Vercel while the API runs on Railway; a single source would mean a
network call to render a `mailto:` link.

- ⚠️ **It is one word-order away from the dead mailbox.** The abandoned account was
  `arakice.support@gmail.com`; the live one is `support.arakice@gmail.com`. Side by side they
  read as a typo of each other. Both files carry a warning; do not "correct" one back.
- ⚠️ **It is a Gmail, not an address on the domain.** That is fine for Apple as long as it is
  monitored, but it means there is still no `@arakice.com` mail route, so a future
  `support@arakice.com` on a business card or an invoice would bounce.
  **Route created 2026-09-16:** the Cloudflare account holding the zone is recovered, and
  Email Routing now forwards `support@arakice.com` → `ireinahedad24@gmail.com`
  (`STATUS.md` §3.9). The published address is still `support.arakice@gmail.com`;
  switching to the domain address is a separate decision, and either one still has to be
  proven with a real mail.
- 🔴 **The one thing still owed: prove it delivers.** Send a real mail and confirm it arrives —
  and confirm you can sign in to that mailbox. This whole item exists because the previous
  address was one nobody could open.

### What shipped

**Database** — migration `032_chat_moderation.sql` (`chat_reports`, `user_blocks`,
`chat_messages.hidden_at` / `hidden_reason`), applied to Neon. **Server** — profanity filter
on insert, report endpoint, auto-hide, block/unblock, filtered reads, admin queue.
**Client** — the `⋯` menu on a message, report sheet, block confirmation, blocked-users
section in Settings, community guidelines as Terms §7, `/dev/moderation`, and a shared account
card. **Tests** — 26 cases in `chatModeration.test.ts`.

### Decisions that outlive this section — do not relitigate without a reason

1. **Reports cascade away with the message** (`ON DELETE CASCADE`). The queue empties itself
   when you act, but a repeat offender whose messages were all deleted looks clean and nothing
   records what was moderated. Reversing it means a migration making `message_id` nullable
   `ON DELETE SET NULL`, plus `reported_user_id` and a snapshot of the text.
2. **The allowed values live in three places** — the `CHECK` constraints in migration 032,
   `REPORT_REASONS` / `REVIEW_DECISIONS` in `chat.service.ts`, and `REPORT_REASONS` in
   `client/src/app/types/user.tsx`. Adding a reason means touching all three.
3. **Reporting is nested** (`POST /rooms/:roomId/messages/:messageId/report`), not the flat
   path this plan first sketched. The roomId authorises the read *before* anything touches the
   message. On a flat path any account could confirm a private-room message exists by guessing
   an id; `msg_<timestamp>_<6 hex>` is not a secret.
4. **⚠️ The block routes deliberately carry no `requireOwnerOrAdmin`.** `:userId` is the
   *target*, not the owner — the middleware would mean "you may only block yourself". The
   blocker is always `req.user.sub`. Someone will want to "fix" this apparent omission.
5. **`GET /users/me/blocks` returns only people the caller blocked**, never the reverse. The
   hiding is symmetric; the list is not. "So-and-so blocked you" converts straight into
   harassment.
6. **A hidden message disappears for everyone, its author included.** Hiding it from others
   only is a shadow-ban: the author believes they are being read and never corrects anything.
7. **⚠️ The socket is not filtered server-side.** `io.to(roomId)` emits to the whole room, so a
   blocked person's message still crosses the network to the blocker's browser. **The only
   thing that stops it rendering is `visibleMessages` in `RoomChat`**, and `client/` has no
   test runner, so nothing guards it. Delete that line and blocking silently stops working in
   real time while history still looks correct.
8. **Auto-hide at three distinct reporters**, brigadable by three colluding accounts. That is
   the accepted price of hiding without a human; the escape hatch is `dismissed` in the admin
   queue, which clears an `auto` hide and never an `admin` one.
9. **The admin queue groups by message, not by report**, and one decision closes every open
   report on that message. **It has to actually be read** — Apple asks about the response
   process, and an unread queue promises moderation that never comes.
10. **The `⋯` is a button, not a long-press** (long-press fights text selection and iOS's own
    context menu, and has no keyboard equivalent), and **it must stay visible without
    hovering**. Its first styling was ~12 % opacity, which is invisible on a phone.
11. **`components/UserIdentity.tsx` is how an account is drawn, everywhere**, and
    `UserSheet.tsx` is its card — the second route to blocking, which works even when the
    person deleted every message. The sheet makes **no network call**: `/users/:id/summary` is
    Pro-gated for other people, so loading it would show a 402 on the screen whose job is to
    offer "block".
12. **Bottom sheets clear the floating nav** with `pb-[calc(6rem+env(safe-area-inset-bottom,0px))]`.
    `BottomNav` is `fixed bottom-3` and eats about 72 px; `pb-10` put the last button
    underneath. Nothing type-checks a layout — this was found by using the app.

### Traps in the filter, found by tests

- **`fold()` collapses repeats, so `ass` becomes `as`** — one of the commonest words in
  English, and « as » in French. The list carries `asshole` and **never `ass`**. Any term
  whose folded form drops under four letters must be folded mentally before it is added.
- **English suffixes are not enough**: `va te faire enculer` passed, because the folded term is
  `encule` and `r` / `z` / `ent` were missing.
- Mild profanity (`damn`, `hell`, `merde`) is absent on purpose. Known limit: `fvck` is not
  caught — vowel substitution needs a distance algorithm, not one more list entry.
- The dry run (`npm run moderation:dry-run`) covered six messages, which is far too small to
  have tested false positives. Re-run it once the chat has real traffic.

### Fixed in passing — the history window

`getMessages()` used to end with `ORDER BY sent_at ASC LIMIT 100`, returning the **oldest**
hundred messages: an active room showed its opening history forever. It now takes the newest
hundred inside a subquery and re-sorts them ascending. The `id DESC` tie-break is not
decoration — `sent_at` can be identical to the millisecond, and without it the hundredth row
varied between calls.

### What the tests do and do not prove

`chatModeration.test.ts` and `authRefresh.test.ts` reuse the fake-pool pattern from
`jobLock.test.ts`: an in-memory stand-in that reproduces the *semantics* of the statements that
matter and **throws on any statement it does not recognise**, so rewriting the SQL surfaces
there. ⚠️ **A fake pool checks no syntax, no types and no Postgres behaviour** — the throwaway
PostgreSQL 16 recipe is the other half, and both migrations and every service path went through
it. ⚠️ **The client has no test runner at all**; its only guard is `npm run typecheck`.

## What this buys you on the web

Not scaffolding for iOS. Real improvements you would want anyway:

- **R7** turns a silent production misconfiguration into a loud one. You have four variables
  that currently fail by pointing at localhost.
- **R3** removes dead legacy-token code and fixes the "stuck rendering 401s" state after a
  failed refresh.
- **R4** gives your community product moderation it does not have today. Any public chat
  without report-and-block eventually gets an incident; you are shipping ahead of yours.
- **R4.0** fixes a support address nobody can read — which is a live problem right now,
  independent of Apple.

---

## Explicitly NOT in this plan

**Friendship / following (asked for 2026-09-04, deliberately deferred).** Adding a friend
button to the player page is a whole feature, not a button: a table, endpoints, four states
(none / request sent / request received / friends), and a friends list somewhere. **Decision:
after `pre-ios-freeze`, as its own plan.** R4 is an App Store blocker and friendship is not;
stacking it into the same deploy is how you get the change that breaks everything right before
review. **Also decided: being someone's friend grants no extra rights** — a social link and a
list, nothing more. That keeps it away from the Pro wall on slips and away from the Privacy
page, which currently states slips are visible "to Pro members". Blocking from the player page
shipped instead, since that one belongs to R4.

Do not start these until `APPLE_PLAN.md` Phase 3:

- Installing Capacitor or anything `@capacitor/*`
- Creating `client/ios/`
- StoreKit / IAP work
- APNs push (the web-push guard in R2.5 is preparation, not the implementation)
- Native OAuth via `ASWebAuthenticationSession` — **cancelled** by your R2 decision, since
  the iOS build will not offer Google login at all
- Sign in with Apple — **not needed**, same reason

---

## Definition of done for this plan

- [~] Four separate deploys to production, each verified on arakice.com — **it was three**:
      R7 (`2cc2ce4`), R2+R3 together (`551aca0`), then R4 + R3bis.2 together (2026-09-04).
      The plan asked for one item per deploy and a preview first; neither happened. It went
      fine twice, which is not the same as it being the right way.
- [x] A missing env var fails the Vercel build instead of shipping (see R7 note 2)
- [x] `VITE_TARGET=ios npm run build` builds and contains no Google-OAuth code (verified
      2026-09-03: 0 occurrences of `api/auth/google`, and no `AuthCallback` chunk)
- [x] Web login, refresh and logout behave exactly as before — verified on arakice.com
      2026-09-03. ⚠️ One known deviation, pre-existing and not caused by R3: a single 401
      fires three `/auth/refresh` calls. See **R3bis**, and read its ordering warning before
      touching either half.
- [x] Report + block + unblock work end-to-end for a real second account — walked on
      arakice.com 2026-09-04: the filter refuses a slur and passes `assist`, a blocked person's
      live message never renders, unblock restores them, and the admin queue reports → hides.
      ⚠️ Auto-hide at three distinct reporters was never seen on screen (it needs a third
      account); it is covered by tests and was proven against a real PostgreSQL.
- [x] **The dead Gmail is out of the code** (2026-09-04). ⚠️ The check as first written can
      never pass: this document quotes the address twice, in the R4.0 section and in this very
      line. Run it against the source only —
      `grep -rn "arakice.support@gmail" client/src server/src` — which returns nothing today.
      Verified absent from the built bundle too.
- [x] The published support address is a real one — `support.arakice@gmail.com`, in the code
      2026-09-04, so it works with or without the environment variables.
- [ ] 🔴 **Prove it delivers.** Send a real mail to `support.arakice@gmail.com` and confirm it
      arrives *and* that you can open the mailbox. The previous address failed this exact test
      — it was published for months and nobody could read it. **The last item of this plan.**
- [ ] `git tag pre-ios-freeze` — then open `APPLE_PLAN.md` at Phase 0
