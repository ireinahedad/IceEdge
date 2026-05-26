import { createBrowserRouter } from "react-router";
import { HockeyLanding }  from "./components/HockeyLanding";
import { LeaguePage }     from "./components/league/LeaguePage";
import { ProfilePage }    from "./components/profile/ProfilePage";
import { StatsPage }      from "./components/StatsPage";
import { PredictionPage } from "./components/PredictionPage";
import { BetBuilderPage } from "./components/BetBuilderPage";
import { LoginPage }      from "./components/LoginPage";
import { AuthCallback }   from "./components/AuthCallback";

export const router = createBrowserRouter([
  { path: "/",                          Component: HockeyLanding  },
  { path: "/stats",                     Component: StatsPage      },
  { path: "/stats/prediction/:type/:id", Component: PredictionPage },
  { path: "/bet",                       Component: BetBuilderPage },
  { path: "/league",                    Component: LeaguePage     },
  { path: "/profile",                   Component: ProfilePage    },
  { path: "/login",                     Component: LoginPage      },
  { path: "/auth/callback",             Component: AuthCallback   },
]);
