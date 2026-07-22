import React from "react";

interface Props { children: React.ReactNode; }
interface State { hasError: boolean; message?: string; }

/**
 * Catches render/runtime errors in the tree below it and shows a friendly
 * fallback instead of a blank white screen. Wrap the app (or a route) with it.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error?.message };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Surfaced in the console for debugging; hook a reporter here if desired.
    console.error("[ErrorBoundary]", error, info?.componentStack);
  }

  handleReload = () => {
    this.setState({ hasError: false, message: undefined });
    window.location.assign("/");
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        className="flex flex-col items-center justify-center min-h-screen text-center px-8"
        style={{ background: "#0A0E0C", color: "#F3F7F0" }}
      >
        <div className="text-4xl mb-4">🧊</div>
        <h1 className="text-lg font-bold mb-2">Oups, quelque chose a planté</h1>
        <p className="text-sm mb-6" style={{ color: "#92A08A", maxWidth: 320 }}>
          Une erreur inattendue est survenue. Recharge l'application pour continuer.
        </p>
        <button
          onClick={this.handleReload}
          className="px-6 py-3 rounded-xl text-sm font-bold active:scale-[0.98] transition-all"
          style={{ background: "#86d1ea", color: "#0A0E0C" }}
        >
          Recharger
        </button>
      </div>
    );
  }
}
