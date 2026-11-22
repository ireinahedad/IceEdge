# PostHog — the ArakIce conversion funnel

Added 2026-11-22. Goal: a real, measured visitor → paying-subscriber funnel,
with conversion rates per acquisition channel.

## How the data flows

| Layer | What goes to PostHog | Identity |
|---|---|---|
| Browser (`client/src/app/posthog.ts`) | `$pageview` / `$pageleave` (SPA history) + every `trackEvent(...)` already in the app | anonymous id → `identify(accountId)` at sign-in, `reset()` at log-out |
| Server (`server/src/services/growth.service.ts`) | `signup`, `trial_started`, `checkout_started`, `subscription_started`, `subscription_canceled` (Stripe webhook = ground truth) | `distinct_id = accountId` |

Because the browser calls `identify(accountId)`, the anonymous pageviews from
before sign-up and the server events land on **one person**, so the funnel
runs from first visit to payment.

Super-properties on every browser event: `source`, `campaign`,
`first_source`, `first_campaign`, `first_landing`, `plan` (anonymous/free/pro).
Use `first_source` to break the funnel down by the channel that brought each subscriber.

Consent: the same rules as Clarity (`analytics.ts`). In the EEA/UK/CH, PostHog is
never loaded unless the visitor clicks Accept, and a later refusal opts out and resets.
No autocapture, no session recording (Clarity does that), no email ever sent.

## Setup (one time)

1. Create a PostHog Cloud **US** project → copy the project key `phc_…`.
2. Vercel (project `ice-edge`) → `VITE_POSTHOG_KEY=phc_…` → redeploy.
3. Railway (backend) → `POSTHOG_KEY=phc_…` (same key) → redeploy.
4. Check: open arakice.com, then PostHog → Activity should show `$pageview` within a minute.
   The `/ingest/*` rewrite in `client/vercel.json` proxies to `us.i.posthog.com`.

## Insights to build in PostHog

**1. Main funnel** (Funnel, conversion window 14 days, ordered):
1. `$pageview` — first visit
2. `$pageview` where path = `/login`, *or* `landing_enter_click`
3. `signup`
4. `pro_page_view`
5. `pro_trial_click` or `pro_checkout_click`
6. `trial_started` or `checkout_started`
7. `subscription_started`

Breakdown: `first_source`. That chart is the portfolio piece: drop-off per step, per channel.

**2. Paywall effectiveness:** `trial_ended_paywall_view` → `trial_ended_paywall_click` → `subscription_started`.

**3. Retention:** Retention insight, start event `signup`, return event `$pageview`, weekly.

**4. /pro page:** `pro_page_view` → `pro_yearly_select` / `pro_faq_open` / `pro_sticky_cta_click` → `pro_checkout_click`.

## Caveat on volume

At ~20 visitors/day, step rates are noisy: report counts alongside percentages,
and compare before/after over 2–4 weeks rather than running A/B tests
(see `experiments.ts`, 2026-11-20).
