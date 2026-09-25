import React from "react";
import { ErrorScreen, reportError } from "./ErrorScreen";

interface Props { children: React.ReactNode; }
interface State { error: unknown; hasError: boolean; eventId?: string; }

/**
 * Catches render/runtime errors in the tree below it and shows ErrorScreen
 * instead of a blank white screen. Errors are reported to Sentry here: once
 * React has caught an error, Sentry's global handler never sees it.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, hasError: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info?.componentStack);
    const eventId = reportError(error, info?.componentStack ?? undefined);
    if (eventId) this.setState({ eventId });
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return <ErrorScreen error={this.state.error} eventId={this.state.eventId} />;
  }
}
