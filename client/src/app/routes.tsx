import { createBrowserRouter, Navigate, useLocation } from "react-router";
import type { ReactNode } from "react";
import { useAuth } from "./context/AuthContext";
import { HockeyLanding }         from "./pages/HockeyLanding";
import { LeaguePage }            from "./pages/league/LeaguePage";
import { ProfilePage }           from "./pages/profile/ProfilePage";
import { StatsPage }             from "./pages/StatsPage";
import { PredictionPage }        from "./pages/PredictionPage";
import { BetBuilderPage }        from "./pages/BetBuilderPage";
import { LoginPage }             from "./pages/LoginPage";
import { AuthCallback }          from "./pages/AuthCallback";
import { NHLPredictionsPage }    from "./pages/NHLPredictionsPage";
import { TennisPredictionsPage } from "./pages/TennisPredictionsPage";
import { SharePage }             from "./pages/SharePage";
import { DevMLDashboard }        from "./pages/DevMLDashboard";
import { TennisPlayerPage }      from "./pages/TennisPlayerPage";
import { ProPage }               from "./pages/ProPage";
import { ProSuccessPage }        from "./pages/ProSuccessPage";

/**
 * Route guard: nothing in the app is visible without an account.
 * Unauthenticated users are redirected to /login (which shows the app
 * presentation and keeps the navigation bar visible).
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

export const router = createBrowserRouter([
  // Public
  { path: "/login",                                  Component: LoginPage            },
  { path: "/auth/callback",                          Component: AuthCallback         },

  // Protected — require a signed-in account
  { path: "/",                                   element: <Protected><HockeyLanding /></Protected>        },
  { path: "/stats",                              element: <Protected><StatsPage /></Protected>            },
  { path: "/stats/prediction/:type/:id",         element: <Protected><PredictionPage /></Protected>       },
  { path: "/stats/prediction/tennis-player/:id", element: <Protected><TennisPlayerPage /></Protected>     },
  { path: "/bet",                                element: <Protected><BetBuilderPage /></Protected>       },
  { path: "/league",                             element: <Protected><LeaguePage /></Protected>           },
  { path: "/profile",                            element: <Protected><ProfilePage /></Protected>          },
  { path: "/pro",                                element: <Protected><ProPage /></Protected>              },
  { path: "/pro/success",                        element: <Protected><ProSuccessPage /></Protected>       },
  { path: "/nhl-predictions",                    element: <Protected><NHLPredictionsPage /></Protected>   },
  { path: "/predictions/tennis",                 element: <Protected><TennisPredictionsPage /></Protected>},
  { path: "/share/:id",                          element: <Protected><SharePage /></Protected>            },
  { path: "/dev/ml",                             element: <Protected><DevMLDashboard /></Protected>       },
]);
