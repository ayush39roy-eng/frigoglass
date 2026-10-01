import * as React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, RouterProvider, createMemoryRouter } from 'react-router-dom';
import { render, type RenderOptions, type RenderResult } from '@testing-library/react';

import { routeObjects } from '@/app/routes';
import { ThemeProvider } from '@/components/theme/theme-provider';
import type { ThemePreference } from '@/components/theme/theme-context';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { MeResponse } from '@/lib/api/session';
import { createQueryClient } from '@/lib/query-client';

import { seedSession } from './session';

export interface SessionRenderOptions {
  /**
   * Session to seed before rendering (ADR 0010). Defaults to a full-permission
   * Super Admin so pre-P9 tests see every control; pass a partial `MeResponse`
   * to narrow it, or `null` to leave the store idle (exercises `<SessionGate>`).
   */
  session?: Partial<MeResponse> | null;
}

/** Render a plain component tree with the providers most components assume. */
export function renderWithProviders(
  ui: React.ReactElement,
  options?: RenderOptions & { theme?: ThemePreference } & SessionRenderOptions,
): RenderResult {
  seedSession(options?.session === undefined ? {} : options.session);
  const client = createQueryClient();
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <ThemeProvider defaultPreference={options?.theme ?? 'light'}>
        <QueryClientProvider client={client}>
          {/* Row click-throughs (Dashboard / Matrix / Gantt → /projects/:id, P9) are
              real <Link>s, which need a router context even in component tests. */}
          <MemoryRouter>
            <TooltipProvider>{children}</TooltipProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </ThemeProvider>
    );
  }
  // Strip our own options before handing the rest to Testing Library.
  const { theme: _theme, session: _session, ...rtlOptions } = options ?? {};
  return render(ui, { wrapper: Wrapper, ...rtlOptions });
}

/** Render the real app router (shell + routes) starting at `initialPath`. */
export function renderApp(initialPath = '/', options?: SessionRenderOptions): RenderResult {
  seedSession(options?.session === undefined ? {} : options.session);
  const client = createQueryClient();
  const router = createMemoryRouter(routeObjects, { initialEntries: [initialPath] });
  return render(
    <ThemeProvider defaultPreference="light">
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}
