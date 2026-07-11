import { createBrowserRouter } from "react-router";
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

export const router = createBrowserRouter([
  { path: "/",                                       Component: HockeyLanding        },
  { path: "/stats",                                  Component: StatsPage            },
  { path: "/stats/prediction/:type/:id",             Component: PredictionPage       },
  { path: "/stats/prediction/tennis-player/:id",     Component: TennisPlayerPage     },
  { path: "/bet",                                    Component: BetBuilderPage       },
  { path: "/league",                                 Component: LeaguePage           },
  { path: "/profile",                                Component: ProfilePage          },
  { path: "/login",                                  Component: LoginPage            },
  { path: "/pro",                                    Component: ProPage              },
  { path: "/auth/callback",                          Component: AuthCallback         },
  { path: "/nhl-predictions",                        Component: NHLPredictionsPage   },
  { path: "/predictions/tennis",                     Component: TennisPredictionsPage},
  { path: "/share/:id",                              Component: SharePage            },
  { path: "/dev/ml",                                 Component: DevMLDashboard       },
]);
