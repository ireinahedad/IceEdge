import { RouterProvider } from "react-router";
import { router } from "./routes";
import { BetProvider } from "./context/BetContext";
import { AuthProvider } from "./context/AuthContext";

import Iridescence from "./../app/components/ui/Balatro";

export default function App() {
  return (
    <AuthProvider>
      <BetProvider>
        <div className="relative w-screen h-screen overflow-hidden bg-[#0f1416]">

          {/* Background */}
          <div className="absolute inset-0 z-0">
            <Iridescence
              color={[0, 0.5, 0]}
              mouseReact={true}
              amplitude={0.1}
              speed={1}
            />
          </div>

          {/* Content */}
          <div className="relative z-10 w-full h-full overflow-y-auto">
            <RouterProvider router={router} />
          </div>

        </div>
      </BetProvider>
    </AuthProvider>
  );
}
