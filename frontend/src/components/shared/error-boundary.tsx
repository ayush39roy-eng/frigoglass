import * as React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Rendered instead of the children when a render error is caught. */
  fallback: React.ReactNode | ((error: Error) => React.ReactNode);
  /** Optional side-effect hook (telemetry). Never logs PII (CLAUDE.md). */
  onError?: (error: Error, info: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Minimal render-error boundary. React has no hook equivalent, so this stays a class.
 * Used for the Lottie boundary and as a last-resort wrapper around lazy route chunks.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  override render(): React.ReactNode {
    const { error } = this.state;
    if (error) {
      return typeof this.props.fallback === 'function'
        ? this.props.fallback(error)
        : this.props.fallback;
    }
    return this.props.children;
  }
}
