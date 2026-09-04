import { createBrowserRouter, Navigate, Outlet, useLocation } from "react-router";
import { lazy, Suspense, type ReactNode } from "react";
import { useAuth } from "./context/AuthContext";
import { AuthGateProvider } from "./context/AuthGateContext";
import { features } from "./platform";

// LoginPage stays eager — it's the entry point for unauthenticated visitors, so
// lazy-loading it would just add a round-trip before first paint.
import { LoginPage } from "./pages/LoginPage";

// M1 — every other page is code-split via React.lazy so its JS (and any heavy
// libs it pulls in — recharts, on ChartPage) only downloads when the route is
// visited. Pages use named exports, hence the `.then` re-map to `default`.
const HockeyLanding         = lazy(() => import("./pages/HockeyLanding").then(m => ({ default: m.HockeyLanding })));
const LeaguePage            = lazy(() => import("./pages/league/LeaguePage").then(m => ({ default: m.LeaguePage })));
const ProfilePage           = lazy(() => import("./pages/profile/ProfilePage").then(m => ({ default: m.ProfilePage })));
const StatsPage             = lazy(() => import("./pages/StatsPage").then(m => ({ default: m.StatsPage })));
const SchedulePage          = lazy(() => import("./pages/SchedulePage").then(m => ({ default: m.SchedulePage })));
const PredictionPage        = lazy(() => import("./pages/PredictionPage").then(m => ({ default: m.PredictionPage })));
const ChartPage             = lazy(() => import("./pages/ChartPage").then(m => ({ default: m.ChartPage })));
const BetBuilderPage        = lazy(() => import("./pages/BetBuilderPage").then(m => ({ default: m.BetBuilderPage })));
// R2.3 — the lazy() binding itself is conditional, not just the route entry.
// Dropping the route from the array is NOT enough: lazy() runs at module scope,
// so Rollup keeps the import() alive and still emits the AuthCallback chunk.
// Folding the binding to null on iOS is what actually deletes it (verified:
// VITE_TARGET=ios build emits no AuthCallback-*.js; the web build still does).
const AuthCallback          = features.googleLogin ? lazy(() => import("./pages/AuthCallback").then(m => ({ default: m.AuthCallback }))) : null;
const NHLPredictionsPage    = lazy(() => import("./pages/NHLPredictionsPage").then(m => ({ default: m.NHLPredictionsPage })));
const SharePage             = lazy(() => import("./pages/SharePage").then(m => ({ default: m.SharePage })));
// Les deux écrans de développement, sous la MÊME liaison conditionnelle que
// AuthCallback ci-dessus. `lazy()` s'exécute au niveau du module : retirer une
// route du tableau plus bas ne suffit pas, l'`import()` reste vivant et Rollup
// émet le chunk quand même. Seul le repli sur `null` le fait disparaître.
//
// DevMLDashboard portait un `lazy()` nu jusqu'au 2026-09-04 : sa route n'était
// pas enregistrée dans le build iOS, mais son chunk y partait quand même.
const DevMLDashboard        = features.devRoutes
  ? lazy(() => import("./pages/DevMLDashboard").then(m => ({ default: m.DevMLDashboard })))
  : null;
// R4.2h-UI — la file de modération.
const ModerationQueuePage   = features.devRoutes
  ? lazy(() => import("./pages/ModerationQueuePage").then(m => ({ default: m.ModerationQueuePage })))
  : null;
const ProPage               = lazy(() => import("./pages/ProPage").then(m => ({ default: m.ProPage })));
const ProSuccessPage        = lazy(() => import("./pages/ProSuccessPage").then(m => ({ default: m.ProSuccessPage })));
const TermsPage             = lazy(() => import("./pages/TermsPage").then(m => ({ default: m.TermsPage })));
const PrivacyPage           = lazy(() => import("./pages/PrivacyPage").then(m => ({ default: m.PrivacyPage })));
const SupportPage           = lazy(() => import("./pages/SupportPage").then(m => ({ default: m.SupportPage })));
const PlayerBetsPage        = lazy(() => import("./pages/PlayerBetsPage").then(m => ({ default: m.PlayerBetsPage })));
const NotFoundPage          = lazy(() => import("./pages/NotFoundPage").then(m => ({ default: m.NotFoundPage })));

/** Minimal fallback shown while a lazy route chunk loads. Matches the app's
 *  dark base colour so there's no white flash on mobile. */
function PageFallback() {
  return <div style={{ minHeight: "100vh", backgroundColor: "#0A0E0C" }} aria-busy="true" />;
}

/** Wrap a route element in the shared Suspense boundary. */
function withSuspense(node: ReactNode) {
  return <Suspense fallback={<PageFallback />}>{node}</Suspense>;
}

/**
 * Route guard for account-only pages (profile, Pro, dev tools).
 * The rest of the app — stats, schedule, predictions, the bet builder and the
 * public chat — is browsable while signed out. Guests are sent to /login only
 * for pages that inherently need an account; the nav bar stays visible so they
 * can go back.
 */
function Protected({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return null; // wait for session rehydration before deciding
  if (!user) {
    const returnTo = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?returnTo=${returnTo}`} replace />;
  }
  return <>{children}</>;
}

/**
 * Root layout — mounts the AuthGate popup once for every route (it lives inside
 * the router so it can navigate to /login) and renders the matched page via
 * <Outlet />.
 */
function RootLayout() {
  return (
    <AuthGateProvider>
      <Outlet />
    </AuthGateProvider>
  );
}

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      // Public — accessible without an account
      { path: "/login",                              Component: LoginPage                                    },
      // R2.3 — dead route on iOS: no Google login means nothing ever lands here.
      // The spread leaves the array untouched on web and lets Rollup drop the
      // AuthCallback chunk entirely from the iOS bundle.
      ...(AuthCallback
        ? [{ path: "/auth/callback",                  element: withSuspense(<AuthCallback />)                 }]
        : []),
      { path: "/terms",                              element: withSuspense(<TermsPage />)                    },
      { path: "/privacy",                            element: withSuspense(<PrivacyPage />)                  },
      { path: "/support",                            element: withSuspense(<SupportPage />)                  },

      // Public browsing — everything the basic plan offers, no account needed.
      // Write actions inside these pages (e.g. chat) are gated by AuthGate.
      { path: "/",                                   element: withSuspense(<HockeyLanding />)                },
      { path: "/stats",                              element: withSuspense(<StatsPage />)                    },
      { path: "/schedule",                           element: withSuspense(<SchedulePage />)                 },
      { path: "/stats/prediction/:type/:id",         element: withSuspense(<PredictionPage />)               },
      { path: "/stats/chart/:type/:id?",             element: withSuspense(<ChartPage />)                    },
      { path: "/bet",                                element: withSuspense(<BetBuilderPage />)               },
      { path: "/league",                             element: withSuspense(<LeaguePage />)                   },
      { path: "/nhl-predictions",                    element: withSuspense(<NHLPredictionsPage />)           },
      { path: "/share/:id",                          element: withSuspense(<SharePage />)                    },

      // Protected — require a signed-in account
      // La page joueur exige un compte : le serveur doit savoir QUI regarde pour
      // trancher entre « c'est moi » et « il faut être Pro ». Le mur Pro lui-même
      // est appliqué côté serveur (402), pas ici.
      { path: "/player/:userId",                     element: withSuspense(<Protected><PlayerBetsPage /></Protected>) },
      { path: "/profile",                            element: withSuspense(<Protected><ProfilePage /></Protected>)    },
      { path: "/pro",                                element: withSuspense(<Protected><ProPage /></Protected>)        },
      { path: "/pro/success",                        element: withSuspense(<Protected><ProSuccessPage /></Protected>) },
      // R17 — the ML dashboard is a developer tool, not a shippable screen.
      ...(features.devRoutes && DevMLDashboard && ModerationQueuePage
        ? [
            { path: "/dev/ml",                        element: withSuspense(<Protected><DevMLDashboard /></Protected>) },
            { path: "/dev/moderation",                element: withSuspense(<Protected><ModerationQueuePage /></Protected>) },
          ]
        : []),

      // Catch-all — any unmatched URL lands on a friendly 404 instead of the
      // raw React Router error screen (e.g. broken/shared links).
      { path: "*",                                   element: withSuspense(<NotFoundPage />)                 },
    ],
  },
]);
