import type { CapacitorConfig } from "@capacitor/cli";

/**
 * APPLE_PLAN Phase 3 — the iOS shell. One codebase (§4b): this only wraps
 * dist-ios/, produced by `npm run build:ios`. Vercel never reads this file.
 *
 * ⚠️ No `server.url`. An app that loads arakice.com remotely is the textbook
 * Guideline 4.2 rejection — the assets are bundled (3.1).
 */
const config: CapacitorConfig = {
  appId: "com.arakice.arakice",
  appName: "ArakIce",
  webDir: "dist-ios",
  ios: {
    // Safe areas are handled in CSS with env(safe-area-inset-*) (R13,
    // viewport-fit=cover in index.html). "always" would inset twice.
    contentInset: "never",
    backgroundColor: "#0A0E0C",
    // Every request goes to api.arakice.com over https; nothing to allow-list.
    limitsNavigationsToAppBoundDomains: false,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 500,
      backgroundColor: "#0A0E0C",
      showSpinner: false,
    },
    StatusBar: {
      // DARK = light text, for the app's dark background.
      style: "DARK",
      overlaysWebView: true,
    },
    PushNotifications: {
      // APPLE_PLAN 4.1 — show the banner (and play the sound) even when the
      // app is open; by default iOS swallows foreground notifications.
      presentationOptions: ["sound", "alert"],
    },
    Keyboard: {
      // The WebView shrinks above the keyboard, so the h-dvh AppShell and the
      // chat input row stay visible (R14/R15). Check on a real iPhone.
      resize: "native",
      resizeOnFullScreen: true,
    },
  },
};

export default config;
