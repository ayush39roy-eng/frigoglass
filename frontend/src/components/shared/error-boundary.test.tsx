import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ErrorBoundary } from './error-boundary';

function Bomb(): never {
  throw new Error('boom');
}

describe('ErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary fallback={<p>fallback</p>}>
        <p>fine</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('fine')).toBeInTheDocument();
  });

  it('renders the fallback (never crashes the surface) when a child throws', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary fallback={<p>Something failed, but the page is still usable.</p>}>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something failed, but the page is still usable.')).toBeInTheDocument();
    spy.mockRestore();
  });

  it('supports a function fallback that receives the error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary fallback={(error) => <p>{error.message}</p>}>
        <Bomb />
      </ErrorBoundary>,
    );
    expect(screen.getByText('boom')).toBeInTheDocument();
    spy.mockRestore();
  });
});
