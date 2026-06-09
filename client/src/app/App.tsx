import { RouterProvider } from "react-router";
import { router } from "./routes";
import { BetProvider } from "./context/BetContext";
import { AuthProvider } from "./context/AuthContext";
import { SportProvider, useSport } from "./context/SportContext";

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
        <RouterProvider router={router} />
      </div>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BetProvider>
        <SportProvider>
          <AppShell />
        </SportProvider>
      </BetProvider>
    </AuthProvider>
  );
}
