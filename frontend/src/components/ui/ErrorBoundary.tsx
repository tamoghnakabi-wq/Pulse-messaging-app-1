import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './Button';

interface Props {
  children: ReactNode;
  label?: string;
}

interface State {
  hasError: boolean;
  message: string;
}

/** Prevents a single render error from blanking the whole app. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error?.message || 'Something went wrong' };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (import.meta.env.DEV) {
      console.error('[ErrorBoundary]', this.props.label || 'app', error, info);
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full min-h-[12rem] w-full flex-col items-center justify-center gap-3 bg-[var(--color-surface)] p-6 text-center animate-fade-up">
          <div className="empty-icon mb-1">
            <span className="text-xl" aria-hidden>
              ⚠️
            </span>
          </div>
          <p className="text-base font-semibold tracking-[-0.02em]">Something went wrong</p>
          <p className="max-w-sm text-sm leading-relaxed text-[var(--color-ink-secondary)]">
            {this.props.label ? `${this.props.label}: ` : ''}
            {this.state.message}
          </p>
          <Button
            className="mt-1"
            onClick={() => {
              this.setState({ hasError: false, message: '' });
            }}
          >
            Try again
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
