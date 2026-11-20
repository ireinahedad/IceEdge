import { createBrowserRouter, isRouteErrorResponse, Navigate, Outlet, useLocation, useNavigate, useRouteError } from "react-router";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { ErrorScreen, reportError } from "./components/ErrorScreen";
import { useAuth } from "./context/AuthContext";
import { AuthGateProvider } from "./context/AuthGateContext";
import { TrialStatusNotice } from "./components/TrialStatusNotice";
import { trackEvent } from "./analytics";
import { features } from "./platform";
import { primeGet, gamePredictionsPath, primeMatchContext } from "./services/nhlApiService";
import { fetchGameMlBundle } from "./services/mlApi";

/**
 * PERF_PLAN.md P2.7 (2026-10-24) — page d'un match : ses trois appels de base
 * (en-tête, marchés, paquet ML) partent dès la NAVIGATION, en parallèle du
 * téléchargement des chunks de la page (`PredictionPage`, `GamePrediction`…),
 * au lieu d'attendre qu'ils soient chargés et montés (~1 s mesuré en prod).
 * Le loader ne fait qu'amorcer et rend tout de suite : la navigation n'attend
 * rien. Les composants reprennent ces requêtes (`primeGet`, cache de
 * `fetchGameMlBundle`) — aucune requête de plus, sauf pour un match en direct,
 * dont la page lit `/predict/game/:id/live` à la place des marchés (un appel
 * en cache serveur perdu, une fois).
 */
function primeMatchPage({ params }: { params: { type?: string; id?: string } }): null {
  const id = params.id ?? "";
  if (params.type === "game" && /^\d{6,12}$/.test(id)) {
    primeGet(`/games/${id}`);
    primeGet(gamePredictionsPath(id));
    void fetchGameMlBundle(id);
    // Le reste de la page (effectifs, face-à-face, gardiens…), en une requête
    // et sans attendre l'en-tête — PERF_PLAN.md P2.8.
    primeMatchContext(id);
  }
  return null;
}

// LoginPage stays eager — it's the entry point for unauthenticated visitors, so
// lazy-loading it would just add a round-trip before first paint.
import { LoginPage } from "./pages/LoginPage";
// HockeyLanding aussi, pour la même raison : c'est `/`, la page d'entrée de presque
// tous les visiteurs, et son paragraphe d'introduction est l'élément LCP. En lazy, ses
// chunks ne partaient qu'après l'exécution du bundle principal. QA P4, mesuré le
// 2026-10-13 (Lighthouse mobile simulé, build local servi en gzip, 3 passes) :
// LCP 3,67 → 2,86 s, FCP 2,50 → 2,19 s, score 0,84 → 0,93 ; bundle principal
// +43 ko gzip, /schedule et /stats/chart inchangés au bruit près. Le
// `modulepreload` des chunks de l'accueil a été essayé et écarté : LCP inchangé,
// FCP +0,4 s (les préchargements disputent la bande passante au bundle principal).
import { HockeyLanding } from "./pages/HockeyLanding";

// M1 — every other page is code-split via React.lazy so its JS (and any heavy
// libs it pulls in — recharts, on ChartPage) only downloads when the route is
// visited. Pages use named exports, hence the `.then` re-map to `default`.
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
// La page d'accueil des visiteurs non connectés — en lazy : les connectés ne la
// téléchargent jamais.
const IntroLanding          = lazy(() => import("./pages/IntroLanding").then(m => ({ default: m.IntroLanding })));
const NHLPredictionsPage    = lazy(() => import("./pages/NHLPredictionsPage").then(m => ({ default: m.NHLPredictionsPage })));
const MoreParlaysPage       = lazy(() => import("./pages/MoreParlaysPage").then(m => ({ default: m.MoreParlaysPage })));
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
// Le sommaire des outils internes : la seule URL /dev/* à retenir. Même
// liaison conditionnelle que ses deux voisines, pour la même raison.
const DevIndexPage          = features.devRoutes
  ? lazy(() => import("./pages/DevIndexPage").then(m => ({ default: m.DevIndexPage })))
  : null;
// La saisie d'avant-match (ex-carte des Réglages), même liaison conditionnelle.
// Profit des Best Bets (2026-10-09) — même liaison conditionnelle que ci-dessus.
const BestBetsProfitPage    = features.devRoutes
  ? lazy(() => import("./pages/BestBetsProfitPage").then(m => ({ default: m.BestBetsProfitPage })))
  : null;
const ManualEntryPage       = features.devRoutes
  ? lazy(() => import("./pages/ManualEntryPage").then(m => ({ default: m.ManualEntryPage })))
  : null;
// SCAN_TICKET_PLAN S1 — Labo OCR. Sa propre condition (features.ocrLab) : il
// existe aussi dans un build iOS de TEST, contrairement aux autres écrans /dev.
const OcrLabPage            = features.ocrLab
  ? lazy(() => import("./pages/OcrLabPage").then(m => ({ default: m.OcrLabPage })))
  : null;
// Guideline 3.1.1 — le build iOS v1 n'a aucun chemin vers Pro. MÊME liaison
// conditionnelle que AuthCallback : retirer les deux routes plus bas ne
// suffirait pas, `lazy()` s'exécute au niveau du module et les deux chunks
// partiraient quand même dans le bundle iOS.
const ProPage               = features.proUpgrade
  ? lazy(() => import("./pages/ProPage").then(m => ({ default: m.ProPage })))
  : null;
const ProSuccessPage        = features.proUpgrade
  ? lazy(() => import("./pages/ProSuccessPage").then(m => ({ default: m.ProSuccessPage })))
  : null;
const TermsPage             = lazy(() => import("./pages/TermsPage").then(m => ({ default: m.TermsPage })));
const PrivacyPage           = lazy(() => import("./pages/PrivacyPage").then(m => ({ default: m.PrivacyPage })));
const SupportPage           = lazy(() => import("./pages/SupportPage").then(m => ({ default: m.SupportPage })));
const PlayerBetsPage        = lazy(() => import("./pages/PlayerBetsPage").then(m => ({ default: m.PlayerBetsPage })));
const NotFoundPage          = lazy(() => import("./pages/NotFoundPage").then(m => ({ default: m.NotFoundPage })));

/** Minimal fallback shown while a lazy route chunk loads. Matches the app's
 *  dark base colour so there's no white flash on mobile. */
function PageFallback() {
  return <div style={{ minHeight: "100dvh", backgroundColor: "#0A0E0C" }} aria-busy="true" />;
}

/** Wrap a route element in the shared Suspense boundary. */
function withSuspense(node: ReactNode) {
  return <Suspense fallback={<PageFallback />}>{node}</Suspense>;
}

/**
 * Garde des pages réservées aux comptes. Depuis le 2026-11-20 (demande du
 * user), TOUT le contenu d'ArakIce en fait partie : stats, calendrier,
 * prédictions, bet builder, ligue… Restent publics : `/` (la patinoire pour
 * les visiteurs), /login, /pro (l'offre), les pages légales et la 404.
 * Un visiteur est renvoyé vers /login avec `returnTo`, et y revient après.
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
 * `/` — page d'accueil des visiteurs (IntroLanding).
 *
 * Non connecté → toujours la patinoire ; « Voir ArakIce » mène à /login
 * (2026-11-20, demande du user : plus de contenu sans compte). Connecté →
 * les matchs de ce soir. Pendant la réhydratation de la session (quelques ms,
 * lecture du jeton local), on ne montre ni l'une ni l'autre pour éviter un
 * éclair.
 */
function HomeRoute() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  if (loading) return <PageFallback />;
  if (!user) {
    // `landing_enter_click` : mesure du mur de connexion du 2026-11-20 (combien
    // de visiteurs de la patinoire vont jusqu'à /login).
    return withSuspense(<IntroLanding onEnter={() => { trackEvent("landing_enter_click"); navigate("/login"); }} />);
  }
  return withSuspense(<HockeyLanding />);
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
      {/* Fin d'essai Pro : bandeau J-2 et fiche « essai terminé » (2026-11-20). */}
      <TrialStatusNotice />
    </AuthGateProvider>
  );
}

/**
 * Écran d'erreur de route — remplace la page « Unexpected Application Error »
 * de react-router. Cas typique : un chunk d'un ancien build introuvable après
 * un déploiement ; le filet `vite:preloadError` de main.tsx recharge déjà une
 * fois, ceci couvre ce qui passe au travers (et toute autre erreur de rendu).
 * Le dessin et le rapport Sentry vivent dans ErrorScreen, partagé avec
 * l'ErrorBoundary d'App.tsx.
 */
function RouteError() {
  const error = useRouteError();
  const [eventId, setEventId] = useState<string>();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  useEffect(() => {
    if (notFound) return;
    console.error("[route] error:", error);
    setEventId(reportError(error));
  }, [error, notFound]);
  if (notFound) return withSuspense(<NotFoundPage />);
  return <ErrorScreen error={error} eventId={eventId} />;
}

export const router = createBrowserRouter([
  {
    element: <RootLayout />,
    errorElement: <RouteError />,
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

      // Contenu de l'app — réservé aux comptes connectés (2026-11-20, demande du
      // user). Avant, tout le plan de base se consultait sans compte. `/` reste
      // public mais n'affiche que la patinoire (IntroLanding) aux visiteurs.
      { path: "/",                                   element: <HomeRoute />                                  },
      { path: "/stats",                              element: withSuspense(<Protected><StatsPage /></Protected>) },
      { path: "/schedule",                           element: withSuspense(<Protected><SchedulePage /></Protected>) },
      { path: "/stats/prediction/:type/:id",         element: withSuspense(<Protected><PredictionPage /></Protected>), loader: primeMatchPage,
        // Pas de nouvel amorçage quand seuls les paramètres d'URL changent (onglet,
        // marché ouvert) : la page ne relit rien, l'appel serait perdu.
        shouldRevalidate: ({ currentParams, nextParams }) => currentParams.id !== nextParams.id || currentParams.type !== nextParams.type },
      // La section Statistiques, sur trois routes qui mènent toutes à ChartPage :
      //   /stats/chart                     son accueil — les trois entrées
      //   /stats/chart/:type/:id?          les vues ligue et les fiches
      //   /stats/chart/:type/:id/:section  l'espace d'un club (ses matchs, ses joueurs)
      // La troisième a un segment de plus que la deuxième : elles ne peuvent
      // pas se disputer une URL. Son premier segment reste `:type` et non le
      // littéral « team » : ChartPage aiguille sur `type`, et un littéral ne
      // remplit pas ce paramètre — la page retomberait sur son accueil.
      { path: "/stats/chart",                        element: withSuspense(<Protected><ChartPage /></Protected>) },
      { path: "/stats/chart/:type/:id?",             element: withSuspense(<Protected><ChartPage /></Protected>) },
      { path: "/stats/chart/:type/:id/:section",     element: withSuspense(<Protected><ChartPage /></Protected>) },
      { path: "/bet",                                element: withSuspense(<Protected><BetBuilderPage /></Protected>) },
      { path: "/league",                             element: withSuspense(<Protected><LeaguePage /></Protected>) },
      { path: "/nhl-predictions",                    element: withSuspense(<Protected><NHLPredictionsPage /></Protected>) },
      { path: "/parlays",                            element: withSuspense(<Protected><MoreParlaysPage /></Protected>) },
      // `/share/:id` a été supprimée le 2026-09-06 : la page n'affichait qu'un
      // « les coupons partagés arrivent bientôt », rien dans l'app n'y renvoyait
      // (le partage passe par une image, ce qui reste le bon choix), et Apple
      // rejette le contenu « coming soon » (Guideline 2.1 / 4.2). Une URL
      // partagée qui existait encore tombe désormais sur NotFoundPage, qui est
      // faite pour ça. La rétablir demande d'IMPLÉMENTER la page, pas de
      // remettre la ligne.

      // Protected — require a signed-in account
      // La page joueur exige un compte : le serveur doit savoir QUI regarde pour
      // trancher entre « c'est moi » et « il faut être Pro ». Le mur Pro lui-même
      // est appliqué côté serveur (402), pas ici.
      { path: "/player/:userId",                     element: withSuspense(<Protected><PlayerBetsPage /></Protected>) },
      { path: "/profile",                            element: withSuspense(<Protected><ProfilePage /></Protected>)    },
      ...(features.proUpgrade && ProPage && ProSuccessPage
        ? [
            // Ouverte aux visiteurs non connectés (2026-11-18, demande du user) :
            // ils voient l'offre ; la connexion n'est demandée qu'au clic sur
            // un bouton (essai, abonnement, code promo — voir ProPage).
            { path: "/pro",                           element: withSuspense(<ProPage />)                         },
            { path: "/pro/success",                   element: withSuspense(<Protected><ProSuccessPage /></Protected>) },
          ]
        : []),
      // R17 — the ML dashboard is a developer tool, not a shippable screen.
      ...(features.devRoutes && DevMLDashboard && ModerationQueuePage && DevIndexPage && ManualEntryPage && BestBetsProfitPage
        ? [
            { path: "/dev",                           element: withSuspense(<Protected><DevIndexPage /></Protected>) },
            { path: "/dev/ml",                        element: withSuspense(<Protected><DevMLDashboard /></Protected>) },
            { path: "/dev/moderation",                element: withSuspense(<Protected><ModerationQueuePage /></Protected>) },
            { path: "/dev/saisie",                    element: withSuspense(<Protected><ManualEntryPage /></Protected>) },
            { path: "/dev/profit",                    element: withSuspense(<Protected><BestBetsProfitPage /></Protected>) },
          ]
        : []),

      ...(features.ocrLab && OcrLabPage
        ? [{ path: "/dev/ocr",                       element: withSuspense(<Protected><OcrLabPage /></Protected>) }]
        : []),

      // Catch-all — any unmatched URL lands on a friendly 404 instead of the
      // raw React Router error screen (e.g. broken/shared links).
      { path: "*",                                   element: withSuspense(<NotFoundPage />)                 },
    ],
  },
]);
