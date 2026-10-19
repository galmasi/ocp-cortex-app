import * as React from 'react';

interface ErrorBoundaryProps {
  title: string;
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches errors thrown by a stage during load or render and displays
 * the error message and stack directly on the page, so failures are
 * diagnosable without the browser devtools console.
 */
class StageErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Also surface in the devtools console with full component stack.
    // eslint-disable-next-line no-console
    console.error('[cortex]', this.props.title, error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <pre
          data-testid="cortex-stage-error"
          style={{
            whiteSpace: 'pre-wrap',
            color: 'red',
            fontSize: '12px',
            margin: 0,
          }}
        >
          {`${this.props.title} FAILED\n\n`}
          {String(this.state.error.message)}
          {'\n\n'}
          {this.state.error.stack}
        </pre>
      );
    }
    return this.props.children;
  }
}

export default StageErrorBoundary;
