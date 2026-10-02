import { RouterProvider } from "react-router";
import { Toaster } from "sonner";
import { router } from "./routes";
import { BetProvider } from "./context/BetContext";
import { AuthProvider } from "./context/AuthContext";
import { SubscriptionProvider } from "./context/SubscriptionContext";
import { SportProvider, useSport } from "./context/SportContext";
import { BookmakerProvider } from "./context/BookmakerContext";
import { OddsFormatProvider } from "./context/OddsFormatContext";
import { BlockProvider } from "./context/BlockContext";
import { LanguageProvider } from "./i18n";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { BetHandoffHost } from "./components/BetHandoffSheet";

function AppShell() {
  const { theme } = useSport();
  return (
    <div
      className="relative w-screen h-screen overflow-hidden"
      style={{ backgroundColor: theme.bg }}
    >
      {/* Simple static gradient overlay */}
      <div
        className="absolute inset-0 z-0 pointer-events-none"
        style={{
          background: `radial-gradient(ellipse 900px 600px at 50% -80px, ${theme.gradientGlow} 0%, transparent 65%)`,
        }}
      />
      {/* Content */}
      <div className="relative z-10 w-full h-full overflow-y-auto">
        <ErrorBoundary>
          <RouterProvider router={router} />
        </ErrorBoundary>
      </div>

      {/* « À chercher chez ton livre » : la fiche qui précède l'ouverture du
          livre (voir components/BetHandoffSheet.tsx). Ici, sous tous les
          providers, parce qu'elle lit le livre choisi ET le format de cote. */}
      <BetHandoffHost />

      {/* Global toast notifications — success/error feedback across the app */}
      <Toaster
        theme="dark"
        richColors
        position="top-center"
        toastOptions={{
          style: {
            background: "#131A12",
            border: "1px solid #283323",
            color: "white",
          },
        }}
      />
    </div>
  );
}

export default function App() {
  // Filet extérieur : une erreur dans un provider (auth, abonnement…) casse
  // tout ce qui est en dessous, y compris la boundary d'AppShell.
  return (
    <ErrorBoundary>
      <LanguageProvider>
        <AuthProvider>
          <SubscriptionProvider>
            <BetProvider>
              <SportProvider>
                <BookmakerProvider>
                  {/* Format d'écriture des COTES DE BOOKMAKER (cote décimale,
                      cote américaine, probabilité implicite). Réglage de LECTURE
                      seulement : il ne touche aucun calcul, et il ne touche PAS
                      les probabilités du modèle, qui restent en % partout. Sous
                      BookmakerProvider parce que les deux répondent à la même
                      question — comment ce lecteur-là lit un prix.
                      Voir context/OddsFormatContext.tsx. */}
                  <OddsFormatProvider>
                    {/* R4.3d — la liste de blocage est partagée entre le chat et
                        les Paramètres. Elle ne charge rien au montage : voir
                        BlockContext, `ensureLoaded`. Sous AuthProvider, dont elle
                        lit l'utilisateur courant. */}
                    <BlockProvider>
                      <AppShell />
                    </BlockProvider>
                  </OddsFormatProvider>
                </BookmakerProvider>
              </SportProvider>
            </BetProvider>
          </SubscriptionProvider>
        </AuthProvider>
      </LanguageProvider>
    </ErrorBoundary>
  );
}